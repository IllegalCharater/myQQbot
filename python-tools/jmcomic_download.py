import json
import os
import shutil
import sys


BLACKLIST = {350234, 350235}
MAX_PDF_FILES = 6
MAX_DOWNLOAD_PAGES = 300
RESULT_PREFIX = "__QQ_AGENT_RESULT__"
IMAGE_CONCURRENCY = 6
REQUEST_TIMEOUT_SECONDS = 120

# 搜索：只返回条目，**绝不下载**。
# 分页大小由服务端决定（实测 page_count 与条数对不上，只认 total/条数）。
MAX_SEARCH_RESULTS = 40
# 关键词与 tag 的长度上限。搜索词会进 URL，超长值没有意义还容易被服务端拒。
MAX_QUERY_LEN = 100

# 排序方式白名单（对应 JmMagicConstants.ORDER_BY_*）。**必须白名单**：
# 这些值会拼进查询串，直接透传模型给的字符串等于让模型决定 URL 内容。
ORDER_BY_CHOICES = {
    "latest": "mr",   # 最新
    "view": "mv",     # 最多观看
    "picture": "mp",  # 最多图片
    "like": "tf",     # 最多点赞
    "score": "tr",    # 评分
    "comment": "md",  # 最多评论
}

# 搜索范围。`keyword` 是站内搜索，其余是禁漫的分类检索入口。
SEARCH_MODES = {
    "keyword": "search_site",
    "tag": "search_tag",
    "author": "search_author",
    "actor": "search_actor",
    "work": "search_work",
}


def emit_result(payload):
    line = RESULT_PREFIX + json.dumps(payload, ensure_ascii=False) + "\n"
    sys.stdout.buffer.write(line.encode("utf-8"))
    sys.stdout.buffer.flush()


def build_download_option():
    from jmcomic import JmOption

    option = JmOption.default()
    # 默认 30 路并发在较慢的图片 CDN 上会互相争抢带宽，导致所有请求
    # 一起撞上 30 秒 curl 超时。降低并发并放宽单请求时间，优先保证完成率。
    option.download.threading.image = IMAGE_CONCURRENCY
    option.client.timeout = REQUEST_TIMEOUT_SECONDS
    option.client.postman.meta_data.timeout = REQUEST_TIMEOUT_SECONDS
    return option


def ensure_page_limit(comic_id, option):
    """在下载任何图片前统计整本漫画的页数。"""
    client = option.new_jm_client()
    album = client.get_album_detail(comic_id)

    # 单章漫画通常直接提供总页数，可以避免额外请求。
    declared_pages = int(getattr(album, "page_count", 0) or 0)
    if declared_pages > MAX_DOWNLOAD_PAGES:
        raise ValueError(
            f"漫画 {comic_id} 共 {declared_pages} 页，超过单次下载上限 {MAX_DOWNLOAD_PAGES} 页"
        )
    if declared_pages > 0:
        return declared_pages

    # 多章合集的 page_count 可能为 0，只能逐章读取详情并累计；超过上限后立即停止。
    total_pages = 0
    for chapter in album:
        photo = client.get_photo_detail(
            chapter.id,
            fetch_album=False,
            fetch_scramble_id=True,
        )
        total_pages += len(photo)
        if total_pages > MAX_DOWNLOAD_PAGES:
            raise ValueError(
                f"漫画 {comic_id} 已统计到 {total_pages} 页，超过单次下载上限 {MAX_DOWNLOAD_PAGES} 页"
            )

    return total_pages


def get_comic_pdf(comic_id, download_dir):
    try:
        from jmcomic import Feature, download_album
    except ImportError as error:
        raise RuntimeError(
            "当前 Python 解释器未安装 jmcomic。请用**同一个**解释器装一遍项目依赖："
            f"{sys.executable} -m pip install -r python-tools/requirements.txt"
            "（两个 Python 工具共用一个解释器，路径在设置页「Python 工具」里配置，"
            "也可以用环境变量 QQ_AGENT_PYTHON 指定）"
        ) from error

    numeric_id = int(comic_id)
    if numeric_id in BLACKLIST:
        raise PermissionError(f"漫画 {comic_id} 已被禁止下载")

    download_dir = os.path.abspath(download_dir)
    os.makedirs(download_dir, exist_ok=True)
    os.chdir(download_dir)

    pdf_files = [
        name for name in os.listdir(download_dir)
        if name.lower().endswith(".pdf")
    ]
    if len(pdf_files) > MAX_PDF_FILES:
        for name in pdf_files:
            try:
                os.remove(os.path.join(download_dir, name))
            except OSError as error:
                print(f"[删除失败] {name}: {error}", file=sys.stderr, flush=True)

    option = build_download_option()
    page_count = ensure_page_limit(comic_id, option)
    print(
        f"[页数检查] 漫画 {comic_id} 共 {page_count} 页，允许下载",
        file=sys.stderr,
        flush=True,
    )

    # 即使已有 PDF 缓存也先执行页数检查，避免旧的大型缓存绕过新限制。
    pdf_path = os.path.join(download_dir, f"{comic_id}.pdf")
    if is_valid_pdf(pdf_path):
        return pdf_path, True

    staging_dir = os.path.join(download_dir, ".staging", f"{comic_id}-{os.getpid()}")
    os.makedirs(staging_dir, exist_ok=True)
    staging_pdf = os.path.join(staging_dir, f"{comic_id}.pdf")

    success = False
    try:
        result = download_album(
            comic_id,
            option=option,
            extra=Feature.export_pdf(
                pdf_dir=staging_dir,
                filename_rule="Aid",
                delete_original_file=True,
            ),
        )

        exported = result.manifest.get_export_filepath_list("pdf")
        if not exported:
            raise FileNotFoundError(f"jmcomic 未报告 PDF 导出结果，临时目录：{staging_dir}")

        generated_pdf = exported[0]
        if not is_valid_pdf(generated_pdf):
            raise FileNotFoundError(f"PDF 未生成或文件无效：{generated_pdf}")

        os.replace(generated_pdf, pdf_path)
        success = True
    finally:
        if success:
            shutil.rmtree(staging_dir, ignore_errors=True)
        else:
            print(f"[调试] 保留失败现场：{staging_dir}", file=sys.stderr, flush=True)
    
    return pdf_path, False


def is_valid_pdf(path):
    try:
        if os.path.getsize(path) < 1024:
            return False
        with open(path, "rb") as file:
            return file.read(5) == b"%PDF-"
    except OSError:
        return False


def normalize_query(value):
    """搜一个词之前先清一遍：去空白、限长。"""
    text = str(value or "").strip()
    if len(text) > MAX_QUERY_LEN:
        raise ValueError(f"搜索词过长（上限 {MAX_QUERY_LEN} 字）")
    return text


def to_int(value, default):
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return default


def search_comics(argv):
    """
    按关键词或 tag 搜索漫画。

    **只搜索、只返回条目，绝不下载。** 这是刻意的：搜索是廉价的只读操作，下载要跑
    页数检查、拉全部图片、导出 PDF、上传群文件，代价高且不可撤销。把两者合成一个动作
    就等于让"模型猜一个关键词"触发一次完整下载。要不要下载由模型看到结果后再单独决定，
    走的仍是既有的 download_jmcomic。
    """
    try:
        from jmcomic import JmOption
    except ImportError as error:
        raise RuntimeError(
            "当前 Python 解释器未安装 jmcomic。请用**同一个**解释器装一遍项目依赖："
            f"{sys.executable} -m pip install -r python-tools/requirements.txt"
            "（两个 Python 工具共用一个解释器，路径在设置页「Python 工具」里配置，"
            "也可以用环境变量 QQ_AGENT_PYTHON 指定）"
        ) from error

    raw = argv[0] if argv else ""
    # 支持两种写法：`tag:巨乳`（简写）与显式 `--mode tag 巨乳`。
    # 简写是为了让模型少一层参数，但**只有带已知前缀时才切**，
    # 否则一个正常含冒号的标题会被误当成模式。
    mode = "keyword"
    query = raw
    if ":" in raw:
        prefix, _, rest = raw.partition(":")
        if prefix.strip().lower() in SEARCH_MODES:
            mode = prefix.strip().lower()
            query = rest

    options = {}
    rest_args = list(argv)
    index = 0
    while index < len(rest_args) - 1:
        token = rest_args[index]
        if token.startswith("--"):
            options[token[2:]] = rest_args[index + 1]
            index += 2
        else:
            index += 1

    if "mode" in options:
        candidate = str(options["mode"]).strip().lower()
        if candidate not in SEARCH_MODES:
            raise ValueError(
                f"不支持的搜索范围：{candidate}（可选：{'、'.join(sorted(SEARCH_MODES))}）"
            )
        mode = candidate
    if "query" in options:
        query = options["query"]

    query = normalize_query(query)
    if not query:
        raise ValueError("搜索词不能为空")

    order_key = str(options.get("orderBy", "latest")).strip().lower()
    if order_key not in ORDER_BY_CHOICES:
        raise ValueError(
            f"不支持的排序方式：{order_key}（可选：{'、'.join(sorted(ORDER_BY_CHOICES))}）"
        )
    order_by = ORDER_BY_CHOICES[order_key]

    page = max(1, to_int(options.get("page"), 1))
    limit = min(MAX_SEARCH_RESULTS, max(1, to_int(options.get("limit"), 10)))

    option = JmOption.default()
    option.client.timeout = REQUEST_TIMEOUT_SECONDS
    option.client.postman.meta_data.timeout = REQUEST_TIMEOUT_SECONDS
    client = option.new_jm_client()

    method = getattr(client, SEARCH_MODES[mode])
    result_page = method(query, page=page, order_by=order_by)

    items = []
    for album_id, title, tags in result_page.iter_id_title_tag():
        items.append({
            "comicId": str(album_id),
            "title": str(title or "").strip(),
            "tags": [str(tag) for tag in (tags or [])],
        })
        if len(items) >= limit:
            break

    print(
        f"[搜索] {mode}={query} 排序={order_key} 第 {page} 页，返回 {len(items)} 条"
        f"（共 {getattr(result_page, 'total', 0)} 条）",
        file=sys.stderr,
        flush=True,
    )
    emit_result({
        "ok": True,
        "mode": mode,
        "query": query,
        "orderBy": order_key,
        "page": page,
        "total": to_int(getattr(result_page, "total", 0), 0),
        "items": items,
    })


def main():
    # Node 按 UTF-8 保存子进程日志；显式统一编码，避免中文日志变成乱码。
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")

    argv = sys.argv[1:]

    # 子命令分发。**默认（无子命令）= 旧的下载路径**，参数与语义逐字不变：
    # 老的 `jmcomic_download.py <漫画ID> <下载目录>` 必须继续可用（Node 侧的下单路径
    # 与已有测试都按这个形状调用）。
    if argv and argv[0] == "search":
        search_comics(argv[1:])
        return

    if len(argv) != 2:
        raise ValueError(
            "参数格式：jmcomic_download.py <漫画ID> <下载目录>"
            "，或 jmcomic_download.py search <关键词|tag:标签> [--mode keyword] [--page 1] [--limit 10]"
        )

    comic_id = argv[0].strip()
    if not comic_id.isdigit() or len(comic_id) > 20:
        raise ValueError("漫画ID必须是 1 至 20 位数字")

    pdf_path, cached = get_comic_pdf(comic_id, argv[1])
    emit_result({
        "ok": True,
        "comicId": comic_id,
        "pdfPath": pdf_path,
        "cached": cached,
    })


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        emit_result({"ok": False, "error": str(error)})
        raise SystemExit(1)
