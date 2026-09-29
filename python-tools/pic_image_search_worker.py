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
⚑ 与真实库的对账状态（2026-09-29 实测，a–d 四条已全部收口；e 是那次顺带挖出的两个活 bug，
f 是后续实测的 SauceNAO 掩码参数）
═══════════════════════════════════════════════════════════════════════════════

本文件最初是在**没有装 PicImageSearch 的机器上**写的，版本相关的事实全是候选链。2026-09-29
在目标解释器上跑了**三次**

    <python.path 那个解释器> python-tools/pic_image_search_worker.py --self-check

（实测环境：Python 3.10.12 / PicImageSearch 3.12.11）三次各钉下一件事：① 第一次先要"每个
引擎的返回类型"，由此发现**响应类在类上一个字段都不声明**（属性是在 `__init__` 里 `self.x = …`
赋的），以及 `google_lens` 是唯一有两个形态的引擎；② 第二次拿到引擎名与 22 个导出名；
③ 第三次拿到**真实字段名**，a / b 两条随之收口，并当场挖出 e 条那两个活 bug。四条对账如下：

  a. 结果访问器（`.raw` / `.results`）—— **已实测确认**。两个响应类里**都没有 `results`**：
     `SauceNAOResponse{…, raw, …}`、`TraceMoeResponse{frameCount, error, origin, url, raw}`，
     条目列表就在 **`.raw`**（基类 `BaseSearchResponse{origin, url, raw}` 也是同一个约定）。
     `_items()` 因此把 `raw` 排到候选第一位，`results` 只留给别的版本。**仍然只接受
     list/tuple**：`raw` 在别的引擎上是原始 dict，这条防线不能拆。
  b. 结果条目的字段名 —— **已实测确认**，`_normalize_*` 的候选链已按实测名对齐（实测名在前，
     取不到的旧猜测留在后面当别的版本的兜底，不删）：
       SauceNAOItem : similarity, thumbnail, index_id, index_name, hidden, title, url,
                      ext_urls, author, author_url, source, origin
       TraceMoeItem : anime_info, idMal, title_native, title_english, title_romaji,
                      title_chinese, anilist, synonyms, isAdult, type, format, start_date,
                      end_date, cover_image, filename, episode, From, To, similarity,
                      video, image, origin, url, thumbnail, title
     另注意两条"看着有、其实不会生效"的：`TraceMoeItem.idMal` 是 **MyAnimeList** 的 id（拿它拼
     `anilist.co/anime/{id}` 是错的链接，所以刻意不用）；`SauceNAOItem` **没有 `characters`**
     —— 库不解析它，那个键恒为空。
  c. 引擎类名 —— **已实测确认**。红过一次的是 `baidu`：库里导出的名字是 **`BaiDu`**（大写的
     D），不是 `Baidu`，于是那个引擎**永远解析不到**。`ENGINE_CLASS_CANDIDATES` 已改。
     实测到的名字（括号里是库里同时存在、但**不该**用的同名近亲）：
     `SauceNAO` / `TraceMoe`（另有 `AnimeTrace`，同一个远端服务）/ `BaiDu` / `Bing` /
     `GoogleLens`（另有 `Google`，那是按关键词搜、不收图）/ `Yandex` / `Tineye`。
     这份结论钉在 `tests/t-image-source.mjs` 第 ⑨ 段的 `MEASURED_CLASS_NAMES` 里。注意
     同段那条键集合比对**管不着**这件事：把 `BaiDu` 改回 `Baidu` 实测全绿。
  d. 入参名与能否直接喂 bytes —— **已实测确认，是好消息**。每个引擎的 search() 都是
     `search(self, url=None, file: Union[str, bytes, pathlib.Path, NoneType] = None, **kwargs)`：
     **参数名恒为 `file`，且可以直接喂 bytes**。所以默认的 `INPUT_MODE=auto` 先走 bytes 是对的，
     `_call_search` 里那个临时文件降级是**纯保险**（正常永远不该触发），也就不必设
     `IMAGE_SOURCE_INPUT_MODE=file`。
  e. **a / b 那次实测顺带挖出两个活 bug，都已在代码里修掉**。它们不是"字段名对不上"，而是
     "名字对了、取法错了"——正是只有真实字段名到手才看得见的那一类：
     ① **trace.moe 的时间戳此前恒为 `00:00`**。库的字段名是**大写开头的 `From` / `To`**
        （沿用 trace.moe 原始响应的键名），而候选链里写的是 `from`/`from_`/`time`/`at`/`start`
        —— `getattr(item, 'from')` 恒为 None，于是每条结果都走"取不到"。这**不是**无害的：
        `time` 一旦写进结果，`result-formatter.ts` 就会打印它（判据是 `time != null`），
        表现是"每条都印 00:00"，与"接口没给时间"长得一模一样 —— 正是 formatter 那段注释
        点名的症状，从 Python 这一侧又被引入了回来。
     ② **动画结果的标题会变成来源串**。候选链里有一条"`origin` 本身是字符串标题"的兜底，
        可 `origin` 是基类字段（来源站点），`_first_text(origin)` 直接把那串 URL 当成了标题，
        而且它排在真正的 `title` **前面** → 标题永远轮不到 `title`。同一个坑的另一半：
        `_pick("https://…", "title")` 取到的是 **`str.title` 这个内置方法**（`getattr` 不区分
        属性与方法）。现在探属性前一律先过 `_attr_node`（字符串/数字/列表一律挡掉）。
     顺带把 `time` 的兜底口径改成**取不到就不写这个键**（原为写 `0.0`）：写 0 会让 formatter
     的"字段在不在"判据失效，等于把 ① 的症状再引入一次。真值 `From: 0`（正好片头）照写，
     `0.0` 不是空值、`_drop_empty` 不会丢它。
  f. **SauceNAO 的过滤档位（R18 掩码）住在构造函数上，不在 `search()` 的 kwargs 里**
     —— 已实测确认。整条签名是

         SauceNAO(base_url='https://saucenao.com', api_key=None, numres=5, hide=0, minsim=30,
                  output_type=2, testmode=0, dbmask=None, dbmaski=None, db=999,
                  dbs=None, **request_kwargs)

     而 `search()` 只收 `url` / `file` / `**kwargs`。`hide` 的语义是四档：**0 全部 / 1 隐藏
     预期 R18 / 2 隐藏预期存疑 / 3 只留预期安全**；`db` 是库编号（999 = 全部），`dbs` 是编号
     列表且**优先于 `db`**，`dbmask` / `dbmaski` 是按位开关。

     两件事因此被钉死：
     ① **掩码必须从构造走。** 递下去的路由是 `_engine` 里的 `kwargs.update(
        _saucenao_constructor_args(options))`，取值由 **Node 侧 `INTENT_PARAMS`** 那张三行表
        给出（`anime` → 0，`illustration` / `unknown` → 1，理由写在那边）。键名直接用引擎的
        `hide`：实测没有第二种叫法，所以**不需要** apiKey 那种 `_first_accepted` 改名协商。
     ② **这个分支必须是白名单，不能透传 options。** `__init__` 结尾是 `**request_kwargs`，
        `_has_var_keyword()` 对它返回 True，于是 `_filtered_call` 是**全传**的 —— 键名拼错
        不会被丢掉，会被原样塞给 HTTP 客户端：不报错、参数却没生效。白名单与 `hide` 的取值
        校验都在 `_saucenao_constructor_args` 里。

     **`dbmask` / `dbmaski` / `db` / `dbs` 有意不接**：它们的编号表**不在库里**（实测
     `constants` 只导出 `COPYSEEKER_CONSTANTS`，编号表在 saucenao.com 的
     `tools/examples/api/index_details.txt`）。凭印象填掩码的表现同样是"悄悄隐藏了另外几套
     库"，而结果里只有 `index_name` 一个线索 —— 要接就把编号表也一并落成显式常量。

     这次实测的入口是"在目标解释器上手跑一行"，因为当时 `--self-check` 还没打构造签名。
     现在它会打（`_dump_engine_params` 打每个引擎的 `__init__` 签名与类文档，
     `_dump_constants` 打取值表），所以**"某个参数住在构造还是 search 的 kwargs"这类问题
     此后一次点击即可**：设置页「Python 工具」→「跑一遍依赖自检」。

  第二次实测（同日）另外确认三件事：① 8 个引擎名**全部**可解析，`baidu →
  BaiDu` 与 `google_lens → GoogleLens`（不是那个按关键词搜的 `Google`）都对，说明候选链的
  顺序在起作用；② `TinEye` **不在** 3.12.11 的 22 个导出里（导出的是 `Tineye`），候选顺序已把
  实测名摆到前面；③ 那 22 个名字里另有 `Ascii2D` / `Copyseeker` / `EHentai` / `Iqdb` / `Lenso`
  五个引擎我们**没接** —— 将来要接就是加一行 `ENGINE_CLASS_CANDIDATES` + 在 Node 的 `ORDER`
  里给它定位置，不在本轮范围。

  另有一条实测：`Network(internal=False, proxies=None, headers=None, cookies=None, timeout=30,
  verify_ssl=True, http2=False)`。构造函数确实收 `timeout`（本文件的 `timeout=30` 生效），
  但那个参数是**复数 `proxies`** —— 写成 `proxy` 会被 `_filtered_call` 静默丢掉（行为无差，
  只是看着像配了代理）。

改过 `ENGINE_CLASS_CANDIDATES` / `_normalize_*` / `_input_param` / `_saucenao_constructor_args`
里的任何一张表之后，**再跑一次 `--self-check` 并把结论写回上面这几条** —— 这张表是那几处唯一的
判据来源。**这四条 2026-09-29
已全部收口，所以此后重跑这件事的用途是「回归 / 升级探测」**（换了 PicImageSearch 版本、或改了
表里任何一行），不是"补未知"。dump 的取数路径是按实测修的（第一版取不到，因为只试了"类上声明
的注解"，而本库一个都不声明），所以它现在打出来的字段名可以**直接**与本文件比对，不必再猜。

本文件仍有**两条 ⚑ 与对账无关的未知**，由代码里的 `⚑未验证` 标出（不收进上面四条，因为
`--self-check` 看不见它们）：`_enter_network` 里 Network 是**异步**还是**同步**上下文管理器
（随版本而变，进错模式抛 TypeError）；以及各 `_normalize_*` 里那些"旧猜测"候选名是否在**别的
版本**上更管用（实测名已在前，猜的名留着当兜底）。
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import dis
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
    # ⚠️ 库导出的名字是 **BaiDu**（大写的 D），不是 Baidu。2026-09-29 实测（PicImageSearch
    # 3.12.11）发现原先只写 Baidu，于是这个键**永远解析不到**：`baidu` 既不出现在
    # ready 事件的 engines 里，真去请求也会报 PROVIDER_UNAVAILABLE。
    # 之所以一直没被发现：**Node 与 Python 各有一份引擎名清单，两边没有任何东西比对**
    # （`types.ts` ↔ `PIC_IMAGE_SEARCH_ENGINES` 有编译期断言，Python 这一侧谁都管不着）。
    # 守护分两半，各自只看得见一半（`tests/t-image-source.mjs` 第 ⑨ 段）：
    #   ① 跨进程的**键集合**比对 —— 引擎少一个/多一个会红，但**看不见类名拼写**
    #      （把这里的 BaiDu 改回 Baidu，实测该套件仍全绿）；
    #   ② `MEASURED_CLASS_NAMES` —— 钉住 2026-09-29 实测到的类名，改回 Baidu 会红。
    #      它钉的是**实测结论**不是可推导的规则：库里真改名了，要重跑 `--self-check`
    #      并同时改这一行与那张表（本地没有库，推不出来）。
    "baidu": ("BaiDu", "Baidu"),
    "bing": ("Bing",),
    # GoogleLens 必须排在 Google 前面：`Google` 在库里是**按关键词搜**的另一个类，不收图。
    "google_lens": ("GoogleLens", "Google"),
    "yandex": ("Yandex",),
    # 实测确认导出名是 `Tineye`（`TinEye` **不在** 3.12.11 的 22 个导出里；留着只为兼容旧版。
    # 候选链里排在后面的死项无害，只是白跑一次 getattr）。
    "tineye": ("Tineye", "TinEye"),
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
# 这一整段的候选名已按 2026-09-29 的实测对齐（**实测名在前**，取不到的旧猜测留在后面当别的
# 版本的兜底，不删）。原则见模块头 b 条：取不到就退化成 None，绝不抛异常。


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


def _saucenao_constructor_args(options: dict[str, Any]) -> dict[str, Any]:
    """从 engineOptions 里挑出 SauceNAO 的**构造**参数。

    `hide` 住在构造上、而不是 `search()` 的 kwargs 里 —— 实测（PicImageSearch 3.12.11）：
    `SauceNAO(base_url, api_key, numres, hide, minsim, output_type, testmode, dbmask, dbmaski,
    db, dbs, **request_kwargs)`，而 `search()` 只收 `url` / `file` / `**kwargs`，所以照
    "把参数塞进 search 的 kwargs"那条路走**到不了它**（见模块头 ⚑ f 条）。

    **这个函数本身就是白名单，不是可选项**：`__init__` 带 `**request_kwargs`，
    `_has_var_keyword()` 对它返回 True，于是 `_filtered_call` 是**全传**的 —— 一旦把这里
    换成"整份 options 透传"，键名拼错就再没有任何声音，未识别的键会被原样塞给 HTTP 客户端。
    同一个理由，`hide` 必须在这里显式校验：`hide=7` 这种值不报错的话，症状只是
    "结果少了几条"，与"这张图本来就没结果"长得一模一样。

    实测同住构造的还有 `dbmask` / `dbmaski` / `db` / `dbs`：**暂时不接**。它们的编号表不在
    库里（`constants` 只导出 `COPYSEEKER_CONSTANTS`，实测过），凭印象填掩码的表现同样是
    "悄悄隐藏了另外几套库"。要接就在这里加一段校验，并在 Node 的 `INTENT_PARAMS` 里给它取值。
    """
    args: dict[str, Any] = {}
    if "hide" in options and options["hide"] is not None:
        hide = _as_int(options["hide"])
        if hide is None or not 0 <= hide <= 3:
            raise ProviderFailure(
                E_PROVIDER_UNAVAILABLE,
                f"engineOptions.hide 必须是 0-3 的整数（收到 {options['hide']!r}）——"
                "0 全部 / 1 隐藏预期 R18 / 2 隐藏预期存疑 / 3 只留预期安全",
            )
        args["hide"] = hide
    return args


def _attr_node(value: Any) -> Any:
    """只有 `value` 是个「像对象的东西」时才返回它，否则 None。

    **防的是字符串的同名方法**：`_pick("https://trace.moe", "title")` 取到的是 `str.title`
    这个内置方法 —— `getattr` 不区分属性与方法，于是标题会被渲染成方法对象或者那串 URL。
    实测踩到过（见模块头 ⚑ e 条 ②）。
    """
    if value is None or isinstance(value, (str, bytes, int, float, bool, list, tuple, set)):
        return None
    return value


def _scalar_id(value: Any) -> Any:
    """只把 `int` 或纯数字字符串当 id 用；URL / 对象 / None 一律不认。"""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.strip().isdigit():
        return value
    return None


def _items(response: Any) -> list[Any]:
    """从响应对象里取出结果条目列表。

    ⚑ 已实测（2026-09-29）：**两个响应类里都没有 `results`**，条目列表就在 **`.raw`** ——
    `SauceNAOResponse{…, raw, …}`、`TraceMoeResponse{frameCount, error, origin, url, raw}`，
    基类 `BaseSearchResponse{origin, url, raw}` 也是同一个约定。所以 `raw` 排在候选第一位。
    `results` 留着只是给别的版本，**别因为它排在后面就删掉**。

    仍然**只接受 list/tuple**：`raw` 在别的引擎上是原始 JSON dict，这条防线不能拆。
    """
    if response is None:
        return []
    if isinstance(response, (list, tuple)):
        return list(response)
    for attr in ("raw", "results", "items", "data"):
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
    """SauceNAO → 归一化条目。

    ⚑ 已实测（2026-09-29）：`SauceNAOItem` 的字段是
    `similarity, thumbnail, index_id, index_name, hidden, title, url, ext_urls, author,
    author_url, source, origin` —— 候选链里第一个名字全部命中，后面的旧猜测（`similarity_score`
    / `index` / `jp_name` / `material` 等）留着给别的版本，**不删**。

    两条要点：① 库**不解析** `characters`，所以下面那个键恒为空（`_drop_empty` 会去掉它，
    展示层不会冒出空行）—— 键保留给会解析它的库版本；② `ext_urls` 是数组、`url` 是字符串，
    两者都在，先取 `ext_urls`（那是真正的来源站点，`url` 只是 SauceNAO 的结果页）。
    """
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

    ⚑ 已实测（2026-09-29）：库里 `TraceMoeItem` **直接**给了四个平铺标题字段
    （`title_chinese` / `title_native` / `title_romaji` / `title_english`）与一个通用的
    `title`，另有 `anime_info` / `anilist` / `idMal`。所以**实测名放最前**（中文优先，与旧
    provider 的口径一致），嵌套路径（`anime_info`/`anilist`/`origin` 里的 `title` 子树）
    只作别的版本的兜底，通用 `title` 排最后。

    ⚠️ 两条实测踩到的雷，改这段之前先读 ⚑ e 条：
    ① `origin` 是**基类字段（来源站点）**，不是标题 —— 旧版把"origin 本身是字符串时当标题"
       当兜底，于是那串来源 URL 会顶掉真正的 `title`（它排在 `title` 前面）；
    ② 对字符串取 `title` 会拿到 **`str.title` 内置方法**，所以探属性前必须先过 `_attr_node`。
    `idMal` **刻意不用**：那是 MyAnimeList 的 id，拿它拼 `anilist.co/anime/{id}` 是错的链接。
    """
    info = _pick(raw_item, "anime_info")
    fallback = _pick(raw_item, "anilist", "anilist_info", "origin")
    anilist_id = _first_text(
        _pick(raw_item, "anilist_id", "anilistId"),
        _scalar_id(_pick(raw_item, "anilist")),
        _pick(_attr_node(info), "id"),
        _pick(_attr_node(fallback), "id"),
    )
    title_node = _pick(_attr_node(info), "title") or _pick(_attr_node(fallback), "title")
    title = _first_text(
        _pick(raw_item, "title_chinese"),
        _pick(raw_item, "title_native"),
        _pick(raw_item, "title_romaji"),
        _pick(raw_item, "title_english"),
        # 嵌套写法（其它版本）：origin/anime_info 里的 title 子树再分语言
        _pick(_attr_node(title_node), "chinese", "zh"),
        _pick(_attr_node(title_node), "native", "jp"),
        _pick(_attr_node(title_node), "romaji", "en", "english"),
        _pick(raw_item, "title", "name", "filename"),
    )
    if not title and anilist_id:
        title = f"AniList {anilist_id}"
    return title, anilist_id


def _normalize_trace_moe(raw_item: Any) -> dict[str, Any]:
    """trace.moe / anime_trace → 归一化条目。字段名已实测（见模块头 ⚑ b/e 条）。"""
    title, anilist_id = _tracemoe_title(raw_item)
    episode = _pick(raw_item, "episode", "ep", "part")
    # 实测：库的字段名是**大写开头的 `From` / `To`**（trace.moe 原始响应的键名），
    # 小写的 `from` 恒取不到 —— 那正是"每条结果都印 00:00"的成因（⚑ e 条 ①）。
    # `To` 不取：Node 侧 `ImageSourceResult` 没有对应槽位，取了也没人渲染。
    seconds = _as_float(_pick(raw_item, "From", "from", "from_", "time", "at", "start"))
    url = _first_text(_pick(raw_item, "url", "anilist_url"))
    if not url and anilist_id:
        url = f"https://anilist.co/anime/{anilist_id}"
    return _drop_empty(
        {
            "similarity": _as_float(_pick(raw_item, "similarity")),
            "title": title,
            "episode": None if episode is None else _as_text(episode),
            # **取不到时间就不写这个键**（旧版写 0.0）。写 0 会让 formatter 的"字段在不在"
            # 判据失效 —— 它会照印 `00:00`，与"接口没给"长得一模一样（那正是 ⚑ e 条 ① 的症状）。
            # 真值 `From: 0`（正好片头）照写：`0.0` 不是空值，`_drop_empty` 不会把它丢掉。
            "time": seconds,
            "url": url,
            "previewUrl": _first_text(
                _pick(raw_item, "image", "thumbnail", "cover_image", "preview", "cover")
            ),
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
        所以两条路都留着 —— 进错模式会直接抛 TypeError，白瞎一次启动。这是**对账之外的**
        那条未知（见模块头末尾）：`--self-check` 只打 `Network.__init__` 的签名，看不见
        这一点，所以它不随上面四条一起收口。
        """
        network_cls = getattr(self._module, "Network", None)
        if network_cls is None:
            raise ProviderFailure(E_PROVIDER_UNAVAILABLE, "PicImageSearch 里没有 Network 类")
        assert self._stack is not None
        try:
            # 实测签名是 `Network(internal=False, proxies=None, headers=None, cookies=None,
            # timeout=30, verify_ssl=True, http2=False)` —— 注意是**复数 `proxies`**。
            # 两个参数都写在这里是为了让"我们想要什么"是显式的（超时 30s、不用代理）：
            # `_filtered_call` 会按签名过滤，版本里没有的参数自动丢掉，不会抛。
            # 顺带一提，这里的 30s 是**兜底**：真正的超时以 Node 侧为准（见模块头硬约束 5）。
            network = _filtered_call(network_cls, timeout=30, proxies=None)
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
            # 过滤档位（R18 掩码）也住在构造上，白名单与理由见 `_saucenao_constructor_args`。
            kwargs.update(_saucenao_constructor_args(options))

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

        **已实测（PicImageSearch 3.12.11）**：每个引擎都是
        `search(self, url=None, file: Union[str, bytes, pathlib.Path, NoneType] = None, **kwargs)`，
        所以名字恒为 `file`，候选链里后面那几个（image / image_path / img / path）是给
        "某个版本改过名"留的保险。挑错名字的后果不是崩，而是**过滤之后一个参数都没传**，
        引擎拿着空输入去请求 —— 白烧一次配额还拿到一个看不懂的错误。所以宁可在这里显式报错。
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

        **已实测（PicImageSearch 3.12.11）**：`file` 的注解是
        `Union[str, bytes, pathlib.Path, NoneType]` —— 字节可以直接喂，默认的 bytes 路径是对的。

        下面那条"失败就换临时文件"的降级因此是**纯保险**，正常永远不该触发：注解不等于
        实现、以及将来某个版本收紧成只收路径，这两种情况它兜得住。

        为什么不做「失败就换个方式再试一次」意义上的重试：**每次重试都是一次真实的配额消耗**
        （SauceNAO 免费额度尤其紧）。所以降级只允许发生一次、只在 TypeError 上发生、
        只对同一个引擎发生一次，并留下一条显眼的告警。

        TypeError 是「签名/类型不接受字节」最可能的形态。若某个版本把它用在更内部的位置，
        这一次会白费一次配额 —— 这个风险被显式接受，且它只可能发生一次。
        实测之后 `IMAGE_SOURCE_INPUT_MODE=file` 已无必要（bytes 就是正路），保留它只是为了
        在某个引擎上临时绕开问题。
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


def _own(base: Any, key: str, default: Any = None) -> Any:
    """只读**这个类自己**的 `__dict__`（不取继承来的）。

    `getattr(cls, '__annotations__')` 在本库上会骗人：实测 3.12.11 的响应类一个注解都没有，
    而 Python 3.10+ 访问时会给它**现造**一个空的 `__annotations__`，看起来"读到了、是空的"。
    """
    return getattr(base, "__dict__", {}).get(key, default)


def _annotation_types(annotation: Any) -> list[type]:
    """把一个注解摊平成类列表：`Union[A, B]` → `[A, B]`，`list[X]` → `[X]`。

    实测（2026-09-29）`google_lens` 的返回注解就是 `Union[GoogleLensResponse,
    GoogleLensExactMatchesResponse]` —— 只看 `isinstance(annotation, type)` 会把它整条判成
    "取不到"，于是那个引擎的结果字段永远是空白。`NoneType` 不算。
    """
    if annotation is None or annotation is inspect.Signature.empty:
        return []
    if isinstance(annotation, type):
        return [] if annotation is type(None) else [annotation]
    out: list[type] = []
    for arg in getattr(annotation, "__args__", ()) or ():
        out.extend(_annotation_types(arg))
    return list(dict.fromkeys(out))


def _iter_code(code: Any) -> list[Any]:
    """`code` 及其**嵌套** code object（列表推导 / 生成器 / 内层函数各是一个 code）。

    必须递归：`self.raw = [SauceNAOResult(i) for i in …]` 里的 `LOAD_GLOBAL SauceNAOResult`
    发生在**推导式自己的** code object 里，只看外层 `__init__.__code__` 会漏掉它
    （实测：假夹具上 `_item_classes` 因此返回空表，条目类型照样推不出来）。
    """
    out = [code]
    for const in getattr(code, "co_consts", ()) or ():
        if hasattr(const, "co_code"):
            out.extend(_iter_code(const))
    return out


def _method_codes(base: Any) -> list[Any]:
    """`base` **自己的**方法（含 `__init__`）的所有 code object（含嵌套）。"""
    codes: list[Any] = []
    for value in (getattr(base, "__dict__", {}) or {}).values():
        code = getattr(value, "__code__", None)
        if code is not None:
            codes.extend(_iter_code(code))
    return codes


def _assigned_attrs(base: Any) -> list[str]:
    """从 `base` **自己的**方法（含 `__init__`）里取出 `STORE_ATTR` 的属性名。

    实测逼出来的第四种来源（2026-09-29）：本库的响应类与条目类既没有注解、也没有 pydantic
    字段，属性全在 `__init__` 里 `self.x = …` 赋值 —— 只试前三种，dump 出来是一片 `{}`，
    等于没说话。属性名在 CPython 里是 `STORE_ATTR` 指令的 `argval`，所以从字节码里读得到。
    取不到就空：**这一段绝不能抛**，自检挂了等于没跑。
    """
    out: list[str] = []
    for code in _method_codes(base):
        try:
            for instruction in dis.get_instructions(code):
                if instruction.opname == "STORE_ATTR" and isinstance(instruction.argval, str):
                    out.append(instruction.argval)
        except (TypeError, ValueError):
            continue
    return list(dict.fromkeys(out))


def _declared_fields(cls: Any) -> list[str]:
    """尽量取全一个类上「声明的字段名」。

    四种来源都试，因为库换过数据类型（普通注解 / pydantic v1 的 `__fields__` /
    pydantic v2 的 `model_fields` / `__slots__` / `__init__` 里的 `self.x = …`）。
    **走整条 MRO**：这些响应类自己什么都不声明，字段在基类上（实测 3.12.11 就是如此）。
    取不到就是空列表 —— **这一段绝不能抛**：自检的价值就在于"在有库的机器上说话"。
    """
    names: list[str] = []
    for base in getattr(cls, "__mro__", ()) or ():
        hints = _own(base, "__annotations__")
        if isinstance(hints, dict):
            names.extend(str(key) for key in hints)
        for attr in ("__fields__", "model_fields"):  # pydantic v1 / v2
            mapping = _own(base, attr)
            if isinstance(mapping, dict):
                names.extend(str(key) for key in mapping)
        slots = _own(base, "__slots__")
        if isinstance(slots, str):
            names.append(slots)
        elif isinstance(slots, (list, tuple)):
            names.extend(str(name) for name in slots)
        names.extend(_assigned_attrs(base))
    return list(dict.fromkeys(name for name in names if name and not name.startswith("__")))


def _global_names(cls: Any) -> list[str]:
    """`cls` **自己的**方法里 `LOAD_GLOBAL` 的名字（用来找"这个方法构造了哪个类"）。"""
    out: list[str] = []
    for code in _method_codes(cls):
        try:
            for instruction in dis.get_instructions(code):
                if instruction.opname == "LOAD_GLOBAL" and isinstance(instruction.argval, str):
                    out.append(instruction.argval)
        except (TypeError, ValueError):
            continue
    return list(dict.fromkeys(out))


def _item_classes(response_cls: Any) -> list[Any]:
    """从响应类上取「结果条目的类」。三处都找：注解里的 `list[X]`、类属性、`__init__` 里构造的类。

    第三条的依据同样是实测：`self.raw = [SauceNAOResult(i) for i in …]` 这种写法里，
    条目类名是 `LOAD_GLOBAL` 的名字，从字节码里能捞出来、再用模块 globals 解析成真类。
    只要**和响应类同一个模块**、且真读得出字段的那些 —— 过滤器就是"它看起来像不像条目类"。
    """
    found: list[Any] = []
    for base in getattr(response_cls, "__mro__", ()) or ():
        hints = _own(base, "__annotations__")
        for annotation in (hints or {}).values():
            found.extend(_annotation_types(annotation))
    module = sys.modules.get(getattr(response_cls, "__module__", "") or "")
    module_globals = getattr(module, "__dict__", {}) or {}
    for value in (getattr(response_cls, "__dict__", {}) or {}).values():
        if isinstance(value, type):
            found.append(value)
    for name in _global_names(response_cls):
        candidate = module_globals.get(name)
        if isinstance(candidate, type):
            found.append(candidate)
    own_module = getattr(response_cls, "__module__", None)
    return [
        cls
        for cls in dict.fromkeys(found)
        if cls is not response_cls
        and getattr(cls, "__module__", None) == own_module
        and (_declared_fields(cls) or _assigned_attrs(cls))
    ]


def _dump_result_fields(module: Any, resolved: dict[str, Any]) -> None:
    """打印每个引擎的结果条目类与其字段名。

    模块头 b 条（`_normalize_*` 里那一串候选名哪个才对）**没法从 search() 的签名推出来**，
    只能看条目类声明了哪些字段。a 条（`.raw` 还是 `.results`）在这里也一并见分晓：
    响应类的字段名就是答案。`google_lens` 有两个返回形态（`Union[…, …ExactMatches…]`），
    所以这里是**按返回类型逐个**打，不是一个引擎一行。
    """
    print("\n结果类型与字段（模块头 a / b 条的判据）：", file=sys.stderr)
    for engine, cls in resolved.items():
        try:
            annotation = inspect.signature(cls.search).return_annotation
        except (TypeError, ValueError):
            annotation = inspect.Signature.empty
        types_ = _annotation_types(annotation)
        if not types_:
            print(f"  {engine:<12} <返回类型取不到：{annotation!r}>", file=sys.stderr)
            continue
        for response in types_:
            print(
                f"  {engine:<12} {response.__name__} "
                f"{{{', '.join(_declared_fields(response)) or '（类上读不出字段）'}}}",
                file=sys.stderr,
            )
            items = _item_classes(response)
            if not items:
                print(f"  {'':<12} └ 条目类型推不出来，看下面模型模块的成员", file=sys.stderr)
            for item in items:
                print(
                    f"  {'':<12} └ 条目 {item.__name__} "
                    f"{{{', '.join(_declared_fields(item)) or '（类上读不出字段）'}}}",
                    file=sys.stderr,
                )

    model_pkg = getattr(module, "model", None)
    if model_pkg is None:
        return
    print("\nPicImageSearch.model 下的类与字段（只看结果/响应类）：", file=sys.stderr)
    for sub_name in sorted(dir(model_pkg)):
        if sub_name.startswith("_"):
            continue
        sub = getattr(model_pkg, sub_name, None)
        if not inspect.ismodule(sub):
            continue
        for cls_name, obj in sorted(inspect.getmembers(sub, inspect.isclass)):
            # 只要这个子模块里**自己定义**的类，不要它 import 进来的。
            if getattr(obj, "__module__", None) != getattr(sub, "__name__", None):
                continue
            if not any(token in cls_name for token in ("Result", "Item", "Response", "Entry")):
                continue
            # 不过滤"字段为空"的类：正是空的那几个曾经把 dump 变成一片 `{}`（实测 3.12.11）。
            declared = ", ".join(_declared_fields(obj)) or "（类上读不出字段）"
            print(f"  {sub_name}.{cls_name:<26} {{{declared}}}", file=sys.stderr)


def _dump_engine_params(resolved: dict[str, Any]) -> None:
    """打印每个引擎的**构造签名**与类文档。

    为什么 `search()` 的签名不够：它只回答"收图片的参数叫什么"，而**引擎自己的搜索参数
    （SauceNAO 的 `db` / `hide` 掩码这类）收在构造还是交给 `search(**kwargs)`** 是另一件事。
    两者的区别是致命的 —— `_filtered_call` 对**没有 `**kwargs`** 的签名会**静默丢掉**不认识的
    参数，所以传错一层不会报任何错，只会让"改了配置但请求没变"。

    类文档一并打出来是因为**取值表常写在 `__init__` 的 docstring 里**，而不是代码里的常量。
    """
    print("\n各引擎的构造签名（判据：搜索参数收在构造还是 search 的 kwargs）：", file=sys.stderr)
    for engine, cls in resolved.items():
        try:
            signature = inspect.signature(cls)
        except (TypeError, ValueError) as exc:
            signature = f"<取不到：{exc}>"
        print(f"  {engine:<12} {cls.__name__}{signature}", file=sys.stderr)
        init = cls.__init__
        doc = None if init is object.__init__ else getattr(init, "__doc__", None)
        lines = [line.rstrip() for line in (doc or cls.__doc__ or "").splitlines()]
        lines = [line for line in lines if line.strip()]
        if not lines:
            print("      （无文档）", file=sys.stderr)
            continue
        if len(lines) > 40:
            lines = lines[:40] + [f"…（还有 {len(lines) - 40} 行）"]
        for line in lines:
            print(f"      {line}", file=sys.stderr)


def _dump_constants(module: Any) -> None:
    """打印 `PicImageSearch.constants` 的成员。

    引擎参数的**取值表**（SauceNAO 的 database 编号各是什么）常被库收在这里。打它是为了
    **照抄**：掩码表凭印象填错，表现不是报错而是"隐藏了另外几套库"，而结果里只有
    `index_name` 一个线索。
    """
    constants = getattr(module, "constants", None)
    if constants is None:
        print("\n（库里没有 constants 模块）", file=sys.stderr)
        return
    print("\nPicImageSearch.constants（引擎参数取值表）：", file=sys.stderr)
    holders: list[tuple[str, Any]] = [("", constants)]
    for sub_name in sorted(dir(constants)):
        if sub_name.startswith("_"):
            continue
        sub = getattr(constants, sub_name, None)
        if inspect.ismodule(sub):
            holders.append((f"{sub_name}.", sub))
    printed = False
    for prefix, holder in holders:
        for name in sorted(dir(holder)):
            if name.startswith("_"):
                continue
            value = getattr(holder, name)
            if inspect.ismodule(value) or callable(value):
                continue
            print(f"  {prefix}{name} = {value!r}", file=sys.stderr)
            printed = True
    if not printed:
        print("  （没有可打印的取值；试看下面模块导出的名字）", file=sys.stderr)


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

        _dump_engine_params(resolved)

    _dump_constants(module)

    # 整段套 try：自检是一张"诊断报告"，它自己崩掉等于一个字都没说。
    try:
        _dump_result_fields(module, resolved)
    except Exception as exc:  # noqa: BLE001
        print(f"\n<结果字段 dump 失败：{type(exc).__name__}: {exc}>", file=sys.stderr)

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
        "各 _normalize_* 里的候选名，以及每个引擎收图片的参数名，"
        "并把结论写回本文件模块头的「⚑ 与真实库的对账状态」。",
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
