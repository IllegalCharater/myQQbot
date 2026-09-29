#!/usr/bin/env python3
"""PicImageSearch 常驻 worker：stdin 收 JSON Lines 请求，stdout 回 JSON Lines 响应。

由 Node 侧 `src/media/image-source/pic-image-search-client.ts` 拉起（spawn 一次，用到底）。
解释器由 `python.path`（或 `QQ_AGENT_PYTHON`）统一指定 —— **与 `jmcomic_download.py`
共用同一个解释器**，依赖清单也共用 `python-tools/requirements.txt`。
它只做两件事：**调用引擎** 与 **把各引擎的结果归一化**。不做重试、不做配额、不判断
minSimilarity —— 那些是 Node 侧服务层的事，在这里重复一份只会让两边口径漂移。

═══════════════════════════════════════════════════════════════════════════════
协议（与 Node 客户端的唯一契约）
═══════════════════════════════════════════════════════════════════════════════

请求（stdin，一行一个 JSON）:

    {"id":"uuid","engine":"trace.moe","imageBase64":"…","mime":"image/jpeg",
     "timeoutMs":15000,"maxResults":5,
     "engineOptions":{"apiKey":"…"}}          # engineOptions 可选，引擎私有

    另有三条**附加**控制消息（不属于上面的搜索形状，靠 "op" 区分）:

    {"op":"cancel","target":"<搜索请求的 id>"}
    {"op":"probe","engine":"saucenao","timeoutMs":15000,"engineOptions":{…}}
    {"op":"shutdown"}

响应（stdout，一行一个 JSON）:

    成功  {"id":"uuid","ok":true, "statusCode":200,"results":[…],"error":null}
    失败  {"id":"uuid","ok":false,"statusCode":429,"results":[],  "error":"RATE_LIMIT"}

    附加字段（可选，Node 可忽略）:
        "reason"  错误的子分类。当前唯一取值 "QUOTA_EXHAUSTED"（SauceNAO 配额耗尽）。
                  存在的理由：统一错误码**只有 5 个**，而配额耗尽是在这一侧从响应体里认出来的，
                  跨边界却只能报 RATE_LIMIT。用「5 码 + 可选 reason」既守住了协议词表的规模，
                  又让 Node 能还原出它既有的 QUOTA_EXHAUSTED 码 —— **不必靠匹配 detail 字符串**，
                  那种做法会在文案一改的时候静默失效。
        "detail"  人类可读的一行，进 Node 的日志与 failures[]。**必须已 scrub，绝不含 apiKey。**

    事件行（**没有 id**，Node 靠这一点与响应区分）:

        {"event":"ready","protocol":1,"python":"3.11.0","version":"4.2.0","engines":[…]}
        {"event":"fatal","error":"PROVIDER_UNAVAILABLE","detail":"…"}   # 随后 exit 2

═══════════════════════════════════════════════════════════════════════════════
硬约束
═══════════════════════════════════════════════════════════════════════════════

1. **stdout 只有 JSON。** 任何一行非 JSON 都是协议炸弹 —— 库里的某个 print()、某个
   warning、某个引擎实现的调试输出都会污染它。本模块所有日志走 log()（stderr），
   并且只通过 _write_line() 往 stdout 写；warnings 也在启动时改道 stderr。
2. **URL 永不进本进程。** 只有 Node 侧 safe-fetch 校验并限量后的图片字节。SSRF 防线只
   在 Node 一个地方，不在两个进程里各写一份。
3. **apiKey 只走 stdin，绝不进 argv**（argv 在进程列表里可见，会被同机其它进程读到）。
4. **一个请求的异常绝不允许冒泡到主循环** —— 一次未捕获异常就是整个 worker 死亡，
   在途请求全部丢失。
5. **超时以 Node 侧为准**，这里的 timeoutMs 只是兜底（Node 的计时器不会因本进程繁忙而迟到）。

═══════════════════════════════════════════════════════════════════════════════
⚑未验证 的地方（本文件是在**没有装 PicImageSearch 的机器上**写的）
═══════════════════════════════════════════════════════════════════════════════

以下几处必须靠 `--self-check` 在目标解释器上实测确认后才能钉死：

  a. 结果访问器：3.x 用过 `.raw`（原始 JSON dict），4.x 用 `.results`（解析后的对象列表）。
     本文件两个都试、**只接受 list**，因此两种形态都能活。
  b. 各项属性的**真实名字**（similarity / title / from 还是 from_ / image 还是 thumbnail …）。
     全部走 _pick() 的候选名数组，取不到就退化成 None 而不是抛异常 —— 一次改名应该表现成
     「某个字段空了」（用户看得见、能报告），而不是「整个搜图功能挂了」。
  c. 引擎类名：Baidu / Bing / GoogleLens / Google / Yandex / TinEye 在不同版本下改过名。
     走 ENGINE_CLASS_CANDIDATES 候选表。
  d. 入参名与能否直接喂 bytes：见 _input_param 与 _call_search 的说明。**这一条最危险**。

先跑 `<python.path 那个解释器> python-tools/pic_image_search_worker.py --self-check`，
把输出贴回来，再把上面几张表钉死。
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import inspect
import json
import os
import shutil
import signal
import sys
import tempfile
import threading
import traceback
import warnings
from typing import Any, Callable

# ── 常量 ────────────────────────────────────────────────────────────────────

PROTOCOL_VERSION = 1

#: stdin 单行上限。Node 侧对应 24 MiB（默认 8 MiB 图片 → base64 约 10.7 MiB，留 2× 余量）。
#: 超限说明协议已经错位，继续读只是浪费内存。
MAX_LINE_BYTES = 32 * 1024 * 1024

#: maxResults 的硬上限。Node 侧配置钳制在 1..10，这里再兜一层，
#: 防止畸形请求让某个引擎拉回几百条结果。
MAX_RESULTS_CAP = 20

#: 统一错误码。**只有这 5 个**能出现在 response.error 里（见模块头 "reason" 的说明）。
E_RATE_LIMIT = "RATE_LIMIT"
E_TIMEOUT = "TIMEOUT"
E_HTTP_ERROR = "HTTP_ERROR"
E_INVALID_RESPONSE = "INVALID_RESPONSE"
E_PROVIDER_UNAVAILABLE = "PROVIDER_UNAVAILABLE"
ERROR_CODES = frozenset(
    {E_RATE_LIMIT, E_TIMEOUT, E_HTTP_ERROR, E_INVALID_RESPONSE, E_PROVIDER_UNAVAILABLE}
)

#: 引擎名 → 候选类名。**顺序即优先级**：先找到哪个用哪个。
ENGINE_CLASS_CANDIDATES: dict[str, tuple[str, ...]] = {
    "saucenao": ("SauceNAO",),
    "trace.moe": ("TraceMoe",),
    # anime_trace 与 trace.moe 是同一个引擎的两个名字（AnimeTrace 是它的中文叫法）。
    # 候选里带上 AnimeTrace 只是为了兼容把两者分开实现的版本。
    "anime_trace": ("TraceMoe", "AnimeTrace"),
    "baidu": ("Baidu",),
    "bing": ("Bing",),
    "google_lens": ("GoogleLens", "Google"),
    "yandex": ("Yandex",),
    "tineye": ("TinEye", "Tineye"),
}

#: 结果归一化的「家族」。同一家族里的引擎字段含义相同，可以共用一张提取表。
#: 其余引擎归入 "web"（通用网页搜图：title / url / 缩略图，普遍没有相似度）。
ENGINE_FAMILY: dict[str, str] = {
    "saucenao": "saucenao",
    "trace.moe": "trace_moe",
    "anime_trace": "trace_moe",
}

#: 环境变量名（engineOptions.apiKey 优先级更高）。
ENV_SAUCENAO_KEY = "SAUCENAO_API_KEY"

#: 输入模式：
#:   "bytes" —— 把图片字节直接交给库（不落盘）
#:   "file"  —— 写临时文件再传路径
#:   "auto"  —— 先 bytes；只在**首次**遇到 TypeError 时降级为 file，并按引擎记住
INPUT_MODE = (os.environ.get("IMAGE_SOURCE_INPUT_MODE") or "auto").strip().lower() or "auto"


# ── 输出：stdout 只许走这里 ──────────────────────────────────────────────────

_STDOUT = sys.stdout.buffer
_WRITE_LOCK = threading.Lock()


def _force_utf8_streams() -> None:
    """把 stderr 钉成 UTF-8。

    **这不是洁癖，是 Windows 上一条真实的乱码路径**：stderr 被重定向成管道时（Node 就是这么
    拉起的），Python 会用**系统区域编码**（简中 Windows 上是 cp936/GBK）而不是 UTF-8，于是
    日志里的中文在 Node 那侧按 UTF-8 解出来是乱码，`⚠` 之类的字符更是直接变成 `\\u26a0` ——
    而失败原因恰恰是排查时唯一要看的东西。stdout 不受影响：_write_line 走的是 `.buffer`，
    全程原始字节，不经过任何编码器。
    """
    for stream in (sys.stderr, sys.stdout):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is None:
            continue
        with contextlib.suppress(Exception):
            reconfigure(encoding="utf-8", errors="backslashreplace")


def log(message: str) -> None:
    """所有日志走 stderr。绝不 print 到 stdout。"""
    try:
        sys.stderr.write(f"[pic-image-search] {message}\n")
        sys.stderr.flush()
    except Exception:  # stderr 也可能被关掉，日志失败不该影响主流程
        pass


def _write_line(payload: dict[str, Any]) -> None:
    """写一行 JSON 到 stdout 并立刻 flush。

    只在**事件循环线程**里调用（响应与事件都在那里），单写者因而不会交错。
    用 sys.stdout.buffer（bytes）而不是 sys.stdout（text）：Windows 的文本模式会把
    \\n 翻成 \\r\\n，Node 侧虽然会剥掉 \\r，但二进制写出更干净、也少一次编码转换。
    """
    line = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    data = line.encode("utf-8") + b"\n"
    with _WRITE_LOCK:
        _STDOUT.write(data)
        _STDOUT.flush()


def _respond(
    req_id: Any,
    ok: bool,
    *,
    status_code: int = 0,
    results: list[dict[str, Any]] | None = None,
    error: str | None = None,
    reason: str | None = None,
    detail: str | None = None,
    **extra: Any,
) -> None:
    """按协议拼一条响应。字段顺序与协议文档一致，便于人工比对。"""
    payload: dict[str, Any] = {
        "id": req_id,
        "ok": bool(ok),
        "statusCode": int(status_code or 0),
        "results": list(results) if results else [],
        "error": error,
    }
    if reason:
        payload["reason"] = reason
    if detail:
        payload["detail"] = detail
    payload.update(extra)
    _write_line(payload)


# ── 错误 ────────────────────────────────────────────────────────────────────


class ProviderFailure(Exception):
    """一次引擎调用失败。code 必须是 5 码之一。"""

    def __init__(
        self,
        code: str,
        detail: str = "",
        *,
        status_code: int = 0,
        reason: str | None = None,
    ) -> None:
        assert code in ERROR_CODES, f"未登记的错误码：{code}"
        super().__init__(detail or code)
        self.code = code
        self.detail = detail or code
        self.status_code = int(status_code or 0)
        self.reason = reason


def _scrub(text: str) -> str:
    """把 detail 里可能出现的密钥抹掉。

    detail 会进 Node 的 console.warn 与工具的 failures[]，再经由模型转述到群里 ——
    密钥从这儿漏出去一次就收不回来。
    """
    key = os.environ.get(ENV_SAUCENAO_KEY, "")
    if key and len(key) >= 8:
        text = text.replace(key, "***")
    return text


def _classify(exc: BaseException, engine: str) -> ProviderFailure:
    """把任意异常映射成 5 码之一。

    顺序有讲究：先看我们自己抛的（已是最终形态），再看超时，再看 HTTP 状态，
    最后才落到按类名的启发式。**未知异常映射到 HTTP_ERROR**（"请求这条路上出了事"，
    而不是 INVALID_RESPONSE —— 后者会让排查方向错误地指向响应体），并把类名与消息
    一起塞进 detail。类名是排查时唯一能定位到库内部的信息，不能丢。
    """
    if isinstance(exc, ProviderFailure):
        return exc

    name = type(exc).__name__
    message = str(exc).strip()

    if isinstance(exc, (asyncio.TimeoutError, TimeoutError)) or "Timeout" in name:
        return ProviderFailure(E_TIMEOUT, f"{engine} 调用超时（{name}）")

    status = getattr(exc, "status", None)
    if isinstance(status, int) and status > 0:
        if status == 429:
            return ProviderFailure(E_RATE_LIMIT, f"{engine} 被限流（HTTP 429）", status_code=429)
        return ProviderFailure(
            E_HTTP_ERROR, f"{engine} 返回 HTTP {status}（{name}）", status_code=status
        )

    lowered = name.lower()
    if "timeout" in lowered or "timenout" in lowered:
        return ProviderFailure(E_TIMEOUT, f"{engine} 调用超时（{name}）")
    # 连不上 / DNS 失败 / 连接被重置：远端这次不可用。这**不是** HTTP_ERROR ——
    # 没有 HTTP 响应可谈，而 PROVIDER_UNAVAILABLE 让 Node 那边有依据去重启或降级。
    if any(
        token in lowered
        for token in (
            "clientconnector",
            "clienterror",
            "connection",
            "connect",
            "network",
            "dns",
            "ssl",
            "serverdisconnected",
        )
    ):
        return ProviderFailure(E_PROVIDER_UNAVAILABLE, f"{engine} 连接失败（{name}: {message}）")
    # 解析/结构类：KeyError / IndexError / JSONDecodeError / AttributeError 都落这里。
    if isinstance(exc, (KeyError, IndexError, AttributeError, ValueError, TypeError)):
        return ProviderFailure(E_INVALID_RESPONSE, f"{engine} 响应结构不符预期（{name}: {message}）")
    if any(token in lowered for token in ("api", "server", "response", "parse", "cookie", "param")):
        return ProviderFailure(E_INVALID_RESPONSE, f"{engine} 返回异常（{name}: {message}）")

    return ProviderFailure(E_HTTP_ERROR, f"{engine} 调用失败（{name}: {message}）")


# ── 字段提取：候选名 + 兜底 ──────────────────────────────────────────────────
#
# 这一整段是「⚑未验证」的集中地。原则见模块头 b 条：取不到就退化成 None，绝不抛异常。


def _pick(obj: Any, *names: str) -> Any:
    """按候选名依次取值，同时支持对象属性与 dict 键。取不到返回 None。"""
    if obj is None:
        return None
    for name in names:
        value = obj.get(name) if isinstance(obj, dict) else getattr(obj, name, None)
        if value is not None:
            return value
    return None


def _as_text(value: Any) -> str:
    """把任意值收成 trimmed 字符串。列表按 ', ' 连接（SauceNAO 的 characters 是数组）。"""
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, (list, tuple)):
        return ", ".join(part for part in (_as_text(v) for v in value) if part)
    return str(value).strip()


def _first_text(*values: Any) -> str:
    """候选链里第一个非空的文本。等价于 Node 侧原来的 first(...) 助手。"""
    for value in values:
        text = _as_text(value)
        if text:
            return text
    return ""


def _as_float(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _as_int(value: Any) -> int | None:
    number = _as_float(value)
    return None if number is None else int(number)


def _items(response: Any) -> list[Any]:
    """从响应对象里取出结果条目列表。

    ⚑未验证 的关键点之一：3.x 的 `.raw` 是**原始 JSON dict**，4.x 的 `.results` 才是
    解析后的对象列表。这里两个都试、**只接受 list/tuple** —— 于是 `.raw` 是 dict 时会被
    自然跳过，不会把整个响应体当成一条结果。
    """
    if response is None:
        return []
    if isinstance(response, (list, tuple)):
        return list(response)
    for attr in ("results", "raw", "items", "data"):
        value = getattr(response, attr, None)
        if isinstance(value, (list, tuple)):
            return list(value)
        if isinstance(value, dict):
            inner = value.get("results")
            if isinstance(inner, (list, tuple)):
                return list(inner)
    return []


def _drop_empty(item: dict[str, Any]) -> dict[str, Any]:
    """空值统一成「键不存在」，不写空串。

    这条很要紧：ImageSourceResult 里那些 `?:` 可选字段在 Node 侧表示「没有」，
    而 result-formatter 的 .filter(Boolean) 依赖「没有」与「空串」的区别。
    """
    return {k: v for k, v in item.items() if v is not None and v != ""}


def _normalize_saucenao(raw_item: Any) -> dict[str, Any]:
    """SauceNAO → 归一化条目。⚑未验证：属性名全部走候选链。"""
    similarity = _as_float(_pick(raw_item, "similarity", "similarity_score"))
    # 原协议里 similarity 是 "87.5" 这种百分数字符串；库的 item 可能已经归一化。
    # 两种量纲都认：> 1 视为百分数。**跨边界的值恒为 0..1**。
    if similarity is not None and similarity > 1:
        similarity = similarity / 100.0

    index_name = _as_text(_pick(raw_item, "index_name", "index", "indexName"))
    # 原实现剥掉 "Index #5: " 前缀 —— 那是 SauceNAO 的索引编号，对模型没有意义。
    if index_name.startswith("Index #"):
        head, _, tail = index_name.partition(": ")
        if tail and head.startswith("Index #"):
            index_name = tail.strip()

    urls = _pick(raw_item, "ext_urls", "urls", "url")
    url = _first_text(*urls) if isinstance(urls, (list, tuple)) else _as_text(urls)

    return _drop_empty(
        {
            "similarity": similarity,
            "title": _first_text(
                _pick(raw_item, "title", "jp_name", "eng_name"),
                _pick(raw_item, "material"),
                _pick(raw_item, "source"),
            ),
            "author": _first_text(
                _pick(raw_item, "author", "author_name", "member_name", "creator")
            ),
            "source": _first_text(index_name, _pick(raw_item, "source")),
            "indexName": index_name,
            "characters": _first_text(_pick(raw_item, "characters", "character")),
            "url": url,
            "previewUrl": _first_text(_pick(raw_item, "thumbnail", "preview", "image")),
        }
    )


def _tracemoe_title(raw_item: Any) -> tuple[str, str]:
    """trace.moe 的标题与 AniList id。

    库把 AniList 详情放在 origin / anilist 里（可能是 dict 也可能是对象），标题再嵌一层
    chinese/native/romaji/english。**这一段在各引擎里形状差异最大**，候选链也最长。
    """
    origin = _pick(raw_item, "origin", "anilist", "anilist_info")
    anilist_id = _first_text(
        _pick(raw_item, "anilist_id", "anilistId"),
        _pick(origin, "id"),
    )
    title_node = _pick(origin, "title")
    title = _first_text(
        _pick(title_node, "chinese", "zh"),
        _pick(title_node, "native", "jp"),
        _pick(title_node, "romaji", "en", "english"),
        # origin 本身就是个字符串标题的实现也存在
        origin if not isinstance(origin, (dict,)) and not hasattr(origin, "__dict__") else None,
        _pick(raw_item, "title", "name", "filename"),
    )
    if not title and anilist_id:
        title = f"AniList {anilist_id}"
    return title, anilist_id


def _normalize_trace_moe(raw_item: Any) -> dict[str, Any]:
    """trace.moe / anime_trace → 归一化条目。"""
    title, anilist_id = _tracemoe_title(raw_item)
    episode = _pick(raw_item, "episode", "ep", "part")
    # "from" 是 Python 关键字，但 getattr 取它没问题；有些版本写成 from_ 或 time。
    seconds = _as_float(_pick(raw_item, "from", "from_", "time", "at", "start"))
    url = _first_text(_pick(raw_item, "url", "anilist_url"))
    if not url and anilist_id:
        url = f"https://anilist.co/anime/{anilist_id}"
    return _drop_empty(
        {
            "similarity": _as_float(_pick(raw_item, "similarity")),
            "title": title,
            "episode": None if episode is None else _as_text(episode),
            # 原实现取不到时间时写 0（不是省略）——formatter 会把它格式化成 00:00。
            # 保持这个口径，别让「没有时间」与「第 0 秒」在展示上分叉。
            "time": 0.0 if seconds is None else seconds,
            "url": url,
            "previewUrl": _first_text(_pick(raw_item, "image", "preview", "thumbnail", "cover")),
        }
    )


def _normalize_web(raw_item: Any) -> dict[str, Any]:
    """通用网页搜图引擎（baidu / bing / google_lens / yandex / tineye）。

    这些引擎普遍**不给相似度**，因此 similarity 留空 —— Node 侧的
    `similarity >= minSimilarity` 过滤会把它们全部滤掉。这是**刻意的**：
    宁可返回空结果，也不要为了「有结果」而给一个编出来的置信度。
    真要启用这些引擎，需要的是另一套判定策略（另行设计），不是在这里补一个数字。
    """
    urls = _pick(raw_item, "url", "link", "ext_urls", "origin_url")
    url = _first_text(*urls) if isinstance(urls, (list, tuple)) else _as_text(urls)
    return _drop_empty(
        {
            "similarity": _as_float(_pick(raw_item, "similarity", "score")),
            "title": _first_text(
                _pick(raw_item, "title", "name", "text", "snippet", "description")
            ),
            "author": _first_text(_pick(raw_item, "author", "site", "domain")),
            "source": _first_text(_pick(raw_item, "source", "site", "domain", "index_name")),
            "url": url,
            "previewUrl": _first_text(_pick(raw_item, "thumbnail", "image", "preview", "cover")),
        }
    )


_NORMALIZERS: dict[str, Callable[[Any], dict[str, Any]]] = {
    "saucenao": _normalize_saucenao,
    "trace_moe": _normalize_trace_moe,
    "web": _normalize_web,
}


# ── 库适配：签名过滤，避免版本差异直接炸掉 ───────────────────────────────────


def _import_library() -> Any:
    try:
        import PicImageSearch  # noqa: F401
    except ImportError as exc:
        raise ProviderFailure(
            E_PROVIDER_UNAVAILABLE,
            "PicImageSearch 未安装。请执行 `pip install PicImageSearch`，"
            "或用环境变量 QQ_AGENT_PYTHON / 设置页「Python 工具」里的 python.path "
            "指定一个已安装该库的解释器；依赖清单是 python-tools/requirements.txt"
            f"（当前解释器：{sys.executable}）。原始错误：{exc}",
        ) from exc
    return PicImageSearch


def _signature_params(func: Any) -> dict[str, inspect.Parameter] | None:
    try:
        return dict(inspect.signature(func).parameters)
    except (TypeError, ValueError):
        return None


def _has_var_keyword(params: dict[str, inspect.Parameter] | None) -> bool:
    if not params:
        return False
    return any(p.kind is inspect.Parameter.VAR_KEYWORD for p in params.values())


def _filtered_call(func: Any, **kwargs: Any) -> Any:
    """只把目标签名接受的 kwargs 传进去，其余丢掉。

    签名里有 **kwargs 时一律全传 —— 版本之间最常见的差异就在这里，与其硬编码每个版本的
    参数表，不如让库自己忽略它不认识的东西。签名取不到时也全传（宁可报错也别静默少传）。
    """
    params = _signature_params(func)
    if params is None or _has_var_keyword(params):
        return func(**kwargs)
    return func(**{k: v for k, v in kwargs.items() if k in params})


async def _filtered_call_async(func: Any, **kwargs: Any) -> Any:
    """_filtered_call 的 await 版本。"""
    return await _filtered_call(func, **kwargs)


def _first_accepted(func: Any, candidates: tuple[str, ...], *, default: str) -> str:
    """在候选名里挑一个目标签名真的接受的参数名。

    这一个助手解决的是：某个版本的构造函数把 `api_key` 写成 `key`，过滤之后我们就会
    「成功构造出一个没带密钥的引擎」—— 然后每次查询都失败，而错误信息完全指不到真正的原因。
    """
    params = _signature_params(func)
    if params is None or _has_var_keyword(params):
        return default
    for name in candidates:
        if name in params:
            return name
    return default


def _resolve_engine_class(module: Any, engine: str) -> Any:
    for name in ENGINE_CLASS_CANDIDATES.get(engine, ()):
        cls = getattr(module, name, None)
        if cls is not None:
            return cls
    tried = ", ".join(ENGINE_CLASS_CANDIDATES.get(engine, ())) or "无候选"
    raise ProviderFailure(
        E_PROVIDER_UNAVAILABLE,
        f"当前 PicImageSearch 版本里没有 {engine} 引擎（试过：{tried}）。"
        f"用 `--self-check` 看这个版本到底提供了哪些引擎",
    )


# ── worker 本体 ─────────────────────────────────────────────────────────────


class Worker:
    def __init__(self) -> None:
        self._module: Any = None
        self._network: Any = None
        self._stack: contextlib.AsyncExitStack | None = None
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._engines: dict[str, Any] = {}
        self._stop_event: asyncio.Event | None = None
        #: 已确认「不接 bytes」的引擎。一旦降级就记住，避免每次请求都白试一遍。
        self._file_only: set[str] = set()
        #: 每个引擎挑好的入参名（缓存，避免每次请求都做一次 signature）。
        self._input_params: dict[str, str] = {}
        self._tempdir: str | None = None

    # ---- 生命周期 ----------------------------------------------------------

    async def setup(self) -> None:
        self._stop_event = asyncio.Event()

        module = _import_library()
        self._module = module

        self._stack = contextlib.AsyncExitStack()
        self._network = await self._enter_network()

        engines = self._available_engines(module)
        _write_line(
            {
                "event": "ready",
                "protocol": PROTOCOL_VERSION,
                "python": sys.version.split()[0],
                "version": str(getattr(module, "__version__", "unknown")),
                "engines": engines,
            }
        )
        log(f"已就绪：PicImageSearch {getattr(module, '__version__', 'unknown')} / 引擎 {engines}")

    async def _enter_network(self) -> Any:
        """构造并进入 Network 客户端。

        ⚑未验证：不同版本对 Network 是异步上下文管理器还是同步上下文管理器并不一致，
        所以两条路都留着 —— 进错模式会直接抛 TypeError，白瞎一次启动。
        """
        network_cls = getattr(self._module, "Network", None)
        if network_cls is None:
            raise ProviderFailure(E_PROVIDER_UNAVAILABLE, "PicImageSearch 里没有 Network 类")
        assert self._stack is not None
        try:
            network = _filtered_call(network_cls, timeout=30, proxy=None)
        except Exception as exc:  # noqa: BLE001 —— 参数表差异 → 退回零参构造
            log(f"Network 构造失败，改用无参构造：{type(exc).__name__}: {exc}")
            network = network_cls()
        if hasattr(network, "__aenter__"):
            return await self._stack.enter_async_context(network)
        return self._stack.enter_context(network)

    def _available_engines(self, module: Any) -> list[str]:
        return [
            engine
            for engine, candidates in ENGINE_CLASS_CANDIDATES.items()
            if any(getattr(module, name, None) is not None for name in candidates)
        ]

    async def shutdown(self) -> None:
        for task in list(self._tasks.values()):
            task.cancel()
        if self._stack is not None:
            # Network 客户端在这里被关闭（连接池随之释放）。
            with contextlib.suppress(Exception):
                await self._stack.aclose()
            self._stack = None
        if self._tempdir:
            with contextlib.suppress(Exception):
                shutil.rmtree(self._tempdir, ignore_errors=True)
            self._tempdir = None

    # ---- 引擎对象 ----------------------------------------------------------

    async def _engine(self, name: str, options: dict[str, Any]) -> Any:
        """惰性实例化并缓存引擎对象（按「引擎 + 选项指纹」缓存）。

        指纹里必须带上 apiKey：用户在设置页换了 Key 之后，这个进程否则会一直用旧的，
        表现为「改了配置却不生效」。
        """
        fingerprint = json.dumps(options, sort_keys=True, ensure_ascii=False)
        cache_key = f"{name}\x00{fingerprint}"
        cached = self._engines.get(cache_key)
        if cached is not None:
            return cached

        cls = _resolve_engine_class(self._module, name)
        kwargs: dict[str, Any] = {"client": self._network}
        if name == "saucenao":
            api_key = _first_text(options.get("apiKey"), os.environ.get(ENV_SAUCENAO_KEY))
            if not api_key:
                # 与 Node 侧的 NOT_CONFIGURED 同义：**Key 为空就不发请求**（一次请求一次配额）。
                raise ProviderFailure(
                    E_PROVIDER_UNAVAILABLE,
                    "SauceNAO 未配置 API Key（engineOptions.apiKey 与 "
                    f"{ENV_SAUCENAO_KEY} 都没有）",
                )
            kwargs[_first_accepted(cls, ("api_key", "key", "apikey"), default="api_key")] = api_key

        try:
            engine = _filtered_call(cls, **kwargs)
        except ProviderFailure:
            raise
        except Exception as exc:  # noqa: BLE001
            raise _classify(exc, name) from exc

        self._engines[cache_key] = engine
        return engine

    # ---- 搜图 --------------------------------------------------------------

    def _input_param(self, engine_obj: Any, engine: str) -> str:
        """挑出这个引擎的 search() 用哪个参数名收图片。

        ⚑未验证 的一处：绝大多数版本叫 `file`，但也有叫 `image` / `image_path` 的。
        挑错名字的后果不是崩，而是**过滤之后一个参数都没传**，引擎拿着空输入去请求 ——
        白烧一次配额还拿到一个看不懂的错误。所以宁可在这里显式报错。
        """
        cached = self._input_params.get(engine)
        if cached:
            return cached
        params = _signature_params(engine_obj.search)
        if params is None or _has_var_keyword(params):
            chosen = "file"
        else:
            chosen = next(
                (name for name in ("file", "image", "image_path", "img", "path") if name in params),
                "",
            )
        if not chosen:
            raise ProviderFailure(
                E_PROVIDER_UNAVAILABLE,
                f"认不出 {engine} 的 search() 用哪个参数收图片"
                f"（候选：file/image/image_path/img/path；实际参数：{', '.join(params or {})}）。"
                f"用 `--self-check` 看真实签名",
            )
        self._input_params[engine] = chosen
        return chosen

    def _write_temp_image(self, data: bytes, mime: str) -> str:
        if self._tempdir is None:
            self._tempdir = tempfile.mkdtemp(prefix="qqagent-pis-")
        suffix = {
            "image/png": ".png",
            "image/jpeg": ".jpg",
            "image/gif": ".gif",
            "image/webp": ".webp",
        }.get(mime, ".img")
        fd, path = tempfile.mkstemp(dir=self._tempdir, suffix=suffix)
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
        return path

    async def _call_search(self, engine_obj: Any, engine: str, data: bytes, mime: str) -> Any:
        """调用引擎的 search()。

        ⚑未验证 且**风险最高**的一处：图片该以字节传、还是以文件路径传。

        为什么不做「失败就换个方式再试一次」：**每次重试都是一次真实的配额消耗**
        （SauceNAO 免费额度尤其紧）。所以降级只允许发生一次、只在 TypeError 上发生、
        只对同一个引擎发生一次，并留下一条显眼的告警。

        TypeError 是「签名/类型不接受字节」最可能的形态。若某个版本把它用在更内部的位置，
        这一次会白费一次配额 —— 这个风险被显式接受，且它只可能发生一次。
        想彻底避开就设 IMAGE_SOURCE_INPUT_MODE=file，全程走临时文件。
        """
        param = self._input_param(engine_obj, engine)
        mode = INPUT_MODE if INPUT_MODE in ("auto", "bytes", "file") else "auto"
        if engine in self._file_only:
            mode = "file"
        attempts = {"file": ["file"], "bytes": ["bytes"]}.get(mode, ["bytes", "file"])

        last_error: BaseException | None = None
        for attempt in attempts:
            try:
                if attempt == "bytes":
                    return await _filtered_call_async(engine_obj.search, **{param: data})
                path = self._write_temp_image(data, mime)
                try:
                    return await _filtered_call_async(engine_obj.search, **{param: path})
                finally:
                    with contextlib.suppress(OSError):
                        os.remove(path)
            except TypeError as exc:
                last_error = exc
                if attempt == "bytes" and len(attempts) > 1:
                    self._file_only.add(engine)
                    log(
                        f"⚠ {engine} 不接受 bytes 入参（TypeError），已降级为临时文件模式并记住。"
                        f"想彻底避开这条路径请设 IMAGE_SOURCE_INPUT_MODE=file。原始错误：{exc}"
                    )
                    continue
                raise
            except Exception as exc:  # noqa: BLE001
                # 非 TypeError：**不重试**（见上面的配额说明），直接交给分类器。
                last_error = exc
                raise

        if last_error is not None:
            raise last_error
        raise ProviderFailure(E_PROVIDER_UNAVAILABLE, f"{engine} 没有任何可用的调用方式")

    async def search(self, request: dict[str, Any]) -> None:
        req_id = request.get("id")
        engine = _first_text(request.get("engine")).lower()
        try:
            self._validate_search(request, engine)
            data = base64.b64decode(_first_text(request.get("imageBase64")), validate=False)
            if not data:
                raise ProviderFailure(E_INVALID_RESPONSE, "imageBase64 解码后为空")

            mime = _first_text(request.get("mime")) or "image/jpeg"
            timeout_ms = _as_int(request.get("timeoutMs")) or 20000
            max_results = min(_as_int(request.get("maxResults")) or 3, MAX_RESULTS_CAP)
            raw_options = request.get("engineOptions")
            options = raw_options if isinstance(raw_options, dict) else {}

            engine_obj = await self._engine(engine, options)
            response = await asyncio.wait_for(
                self._call_search(engine_obj, engine, data, mime),
                timeout=max(1.0, timeout_ms / 1000),
            )
            self._check_engine_status(engine, response)

            normalize = _NORMALIZERS[ENGINE_FAMILY.get(engine, "web")]
            results = [
                normalized
                for normalized in (normalize(item) for item in _items(response)[:max_results])
                if normalized.get("title") or normalized.get("url")
            ]
            status_code = _as_int(getattr(response, "status_code", None)) or 200
            _respond(req_id, True, status_code=status_code, results=results)
        except asyncio.CancelledError:
            # 被 cancel 的目标**不回响应行**。Node 那边早已本地 settle 并删掉了那张表项，
            # 回一行只会让它去处理一个它已经不认识的 id。取消结果由 cancel 命令自己回答。
            log(f"请求 {req_id}（{engine}）已被取消")
            raise
        except BaseException as exc:  # noqa: BLE001 —— 见模块头第 4 条：绝不冒泡
            failure = _classify(exc, engine or "unknown")
            detail = _scrub(failure.detail)
            log(f"请求 {req_id}（{engine}）失败：{failure.code} {detail}")
            if not isinstance(exc, ProviderFailure):
                log(traceback.format_exc())
            _respond(
                req_id,
                False,
                status_code=failure.status_code,
                error=failure.code,
                reason=failure.reason,
                detail=detail,
            )

    def _validate_search(self, request: dict[str, Any], engine: str) -> None:
        if not request.get("id"):
            raise ProviderFailure(E_INVALID_RESPONSE, "请求缺少 id")
        if not engine:
            raise ProviderFailure(E_INVALID_RESPONSE, "请求缺少 engine")
        if engine not in ENGINE_CLASS_CANDIDATES:
            raise ProviderFailure(
                E_PROVIDER_UNAVAILABLE,
                f"未知引擎 {engine}（支持：{', '.join(sorted(ENGINE_CLASS_CANDIDATES))}）",
            )
        if not request.get("imageBase64"):
            raise ProviderFailure(E_INVALID_RESPONSE, "请求缺少 imageBase64")

    def _check_engine_status(self, engine: str, response: Any) -> None:
        """SauceNAO 的 header.status：负数表示这次查询被拒。

        原 Node 实现里 `-3/-4 → QUOTA_EXHAUSTED`、其余负数 → API_ERROR。现在后者归入
        INVALID_RESPONSE（带 detail），前者用 reason 表达 —— 见模块头对 reason 的说明。
        """
        if engine != "saucenao":
            return
        raw = getattr(response, "raw", None)
        header = raw.get("header") if isinstance(raw, dict) else None
        if not isinstance(header, dict):
            return
        status = _as_int(header.get("status"))
        if status is None or status >= 0:
            return
        if status in (-3, -4):
            raise ProviderFailure(
                E_RATE_LIMIT,
                f"SauceNAO 配额已耗尽（header.status={status}）",
                status_code=429,
                reason="QUOTA_EXHAUSTED",
            )
        raise ProviderFailure(
            E_INVALID_RESPONSE, f"SauceNAO 拒绝了这次查询（header.status={status}）"
        )

    # ---- 探测（对应 Node 的 Provider.test） --------------------------------

    async def probe(self, request: dict[str, Any]) -> None:
        """判断某个引擎在当前配置下可不可用。

        **刻意不烧配额**：只做「库里有这个引擎 + 参数能构造出对象」。真发一次请求去验证
        连通性会消耗 SauceNAO 的免费额度，而设置页的「测试连接」是个可以随便点的按钮。

        代价如实写在这里：这个探测**证明不了网络可达**。它回答的是「配置对不对」，
        不是「远端活着吗」。Node 侧那三个状态（可用 / 失败 / 未配置）因此要重新措辞。
        """
        req_id = request.get("id")
        engine = _first_text(request.get("engine")).lower()
        try:
            if engine not in ENGINE_CLASS_CANDIDATES:
                raise ProviderFailure(E_PROVIDER_UNAVAILABLE, f"未知引擎 {engine}")
            raw_options = request.get("engineOptions")
            options = raw_options if isinstance(raw_options, dict) else {}
            await self._engine(engine, options)
            _respond(req_id, True, status_code=200)
        except asyncio.CancelledError:
            raise
        except BaseException as exc:  # noqa: BLE001
            failure = _classify(exc, engine or "unknown")
            detail = _scrub(failure.detail)
            log(f"探测 {engine} 失败：{failure.code} {detail}")
            _respond(
                req_id,
                False,
                status_code=failure.status_code,
                error=failure.code,
                reason=failure.reason,
                detail=detail,
            )

    # ---- 分发 --------------------------------------------------------------

    async def dispatch(self, request: Any) -> bool:
        """处理一条请求。返回 False 表示主循环该停了。"""
        if not isinstance(request, dict):
            log(f"忽略非法请求（不是 JSON 对象）：{str(request)[:200]}")
            return True

        op = _first_text(request.get("op")).lower()
        if op == "cancel":
            self._cancel(request)
            return True
        if op == "shutdown":
            _respond(request.get("id"), True, status_code=200)
            return False
        if op == "probe":
            await self.probe(request)
            return True
        if op:
            log(f"忽略未知 op：{op}")
            return True

        # 无 op 即搜索。按协议搜索请求必须带 id —— 没有 id 就回不了响应，
        # 与其静默丢弃，不如记一条日志（这是 Node 侧的协议 bug）。
        req_id = _first_text(request.get("id"))
        if not req_id:
            log("忽略没有 id 的搜索请求")
            return True
        if req_id in self._tasks:
            log(f"忽略重复的请求 id：{req_id}")
            return True
        task = asyncio.ensure_future(self.search(request))
        self._tasks[req_id] = task
        task.add_done_callback(lambda _done, key=req_id: self._tasks.pop(key, None))
        return True

    def _cancel(self, request: dict[str, Any]) -> None:
        target = _first_text(request.get("target"))
        task = self._tasks.get(target)
        cancelled = False
        if task is not None and not task.done():
            task.cancel()
            cancelled = True
        # cancelled=false 是**正常结果**（任务已经跑完了），不是错误。
        _respond(request.get("id"), True, status_code=200, cancelled=cancelled)


# ── stdin 读取线程 ───────────────────────────────────────────────────────────
#
# 为什么用线程而不是 loop.connect_read_pipe：Windows 的 Proactor 事件循环对管道支持有限，
# 而 Node 侧永远是以管道（pipe）拉起这个进程的。一个阻塞 readline 的守护线程在 Windows 与
# POSIX 上行为一致，是这里能选的最稳的形态。线程只做「读 + 投递」，不碰任何状态。

_EOF = object()


def _stdin_reader(loop: asyncio.AbstractEventLoop, queue: asyncio.Queue[Any]) -> None:
    stream = sys.stdin.buffer
    while True:
        try:
            line = stream.readline()
        except Exception as exc:  # noqa: BLE001
            log(f"stdin 读取失败：{type(exc).__name__}: {exc}")
            break
        if not line:
            # **EOF = 关闭信号**。这是最可靠的一条退出路径：父进程无论怎么死
            # （崩溃、被 kill、Ctrl+C），管道都会关闭，我们一定能收到。
            # Windows 下它还是唯一可靠的那条 —— TerminateProcess 不走信号处理器。
            break
        if len(line) > MAX_LINE_BYTES:
            log(f"忽略超长行（{len(line)} 字节 > {MAX_LINE_BYTES}）")
            continue
        loop.call_soon_threadsafe(queue.put_nowait, line)
    loop.call_soon_threadsafe(queue.put_nowait, _EOF)


async def _amain() -> int:
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue[Any] = asyncio.Queue()
    threading.Thread(target=_stdin_reader, args=(loop, queue), daemon=True).start()

    worker = Worker()
    try:
        await worker.setup()
    except ProviderFailure as exc:
        detail = _scrub(exc.detail)
        log(f"启动失败：{exc.code} {detail}")
        _write_line({"event": "fatal", "error": exc.code, "detail": detail})
        return 2
    except BaseException as exc:  # noqa: BLE001
        failure = _classify(exc, "startup")
        log(f"启动失败：{failure.code} {failure.detail}")
        log(traceback.format_exc())
        _write_line({"event": "fatal", "error": failure.code, "detail": _scrub(failure.detail)})
        return 2

    # 信号处理器只做一件事：往队列里塞一个 EOF 哨兵，把主循环从 await queue.get() 里叫醒。
    # 这样做是为了**让主循环只有一个等待点** —— 同时 await「队列」和「停止事件」两个 future
    # 时，取消排队中的 get() 有一个已知的丢消息窗口，不该为了省一个哨兵去踩它。
    def request_stop() -> None:
        loop.call_soon_threadsafe(queue.put_nowait, _EOF)

    _install_signal_handlers(loop, request_stop)

    try:
        while True:
            item = await queue.get()
            if item is _EOF:
                log("收到退出信号，开始收尾")
                break
            try:
                request = json.loads(item.decode("utf-8", errors="replace").strip())
            except (json.JSONDecodeError, UnicodeDecodeError) as exc:
                # 非法行**不崩**：某个库偷偷 print 了一行不该杀掉整个 worker。
                log(f"忽略非法 JSON 行：{exc}｜{item[:200]!r}")
                continue
            if not await worker.dispatch(request):
                break
    finally:
        await worker.shutdown()
    return 0


def _install_signal_handlers(
    loop: asyncio.AbstractEventLoop, request_stop: Callable[[], None]
) -> None:
    """注册 SIGTERM / SIGINT。

    已知边界（与仓库 AGENTS.md 里那条同源）：**Windows 下 SIGTERM 事实上送不到** ——
    Node 的 child.kill() 走 TerminateProcess，不经过信号处理器。所以这条路径是 POSIX 的
    优雅退出；Windows 上真正的优雅退出靠 stdin 的 shutdown 消息，以及管道关闭后的 EOF 兜底。
    """
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(sig, request_stop)
            continue
        except (NotImplementedError, AttributeError, RuntimeError):
            pass
        try:
            signal.signal(sig, lambda *_args: loop.call_soon_threadsafe(request_stop))
        except (ValueError, OSError, AttributeError) as exc:
            log(f"无法注册信号处理器 {sig}：{exc}")


# ── 自检：在目标解释器上把真实属性 dump 出来 ─────────────────────────────────
#
# 存在的唯一理由：本文件的字段映射是在**没有装库的机器上**写的，所有属性名都是候选链。
# 在目标解释器上跑一次这个模式，就能把「候选链里哪一个是对的」从猜测变成事实。


def self_check() -> int:
    try:
        module = _import_library()
    except ProviderFailure as exc:
        print(f"✗ {exc.detail}", file=sys.stderr)
        return 2

    print(f"PicImageSearch {getattr(module, '__version__', 'unknown')}", file=sys.stderr)
    print(f"解释器 {sys.executable} / Python {sys.version.split()[0]}", file=sys.stderr)

    resolved: dict[str, Any] = {}
    print("\n引擎类是否可解析：", file=sys.stderr)
    for engine, candidates in ENGINE_CLASS_CANDIDATES.items():
        hit = next((name for name in candidates if getattr(module, name, None) is not None), None)
        print(f"  {'✓' if hit else '✗'} {engine:<12} → {hit or '（无候选命中）'}", file=sys.stderr)
        if hit:
            resolved[engine] = getattr(module, hit)

    if resolved:
        print("\n可解析类的 search() 签名：", file=sys.stderr)
        for engine, cls in resolved.items():
            try:
                signature = inspect.signature(cls.search)
            except (TypeError, ValueError) as exc:
                signature = f"<取不到：{exc}>"
            print(f"  {engine:<12} {cls.__name__}.search{signature}", file=sys.stderr)

    network_cls = getattr(module, "Network", None)
    if network_cls is not None:
        try:
            print(f"\nNetwork.__init__{inspect.signature(network_cls)}", file=sys.stderr)
        except (TypeError, ValueError) as exc:
            print(f"\nNetwork.__init__ <取不到：{exc}>", file=sys.stderr)

    names = sorted(n for n in dir(module) if not n.startswith("_"))
    print(f"\n模块导出的名字（{len(names)} 个）：\n  {', '.join(names)}", file=sys.stderr)
    print(
        "\n下一步：把上面这段贴回来，据此钉死 ENGINE_CLASS_CANDIDATES、"
        "各 _normalize_* 里的候选名，以及每个引擎收图片的参数名。",
        file=sys.stderr,
    )
    return 0


def main() -> int:
    _force_utf8_streams()

    # 库里的 print()/warnings 是协议炸弹：把 warnings 改道 stderr。
    warnings.simplefilter("always")
    warnings.showwarning = lambda message, *_args: log(f"warning: {message}")

    if "--self-check" in sys.argv[1:]:
        return self_check()

    try:
        return asyncio.run(_amain())
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    sys.exit(main())
