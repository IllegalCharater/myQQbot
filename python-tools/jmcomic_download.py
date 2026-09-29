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


def main():
    # Node 按 UTF-8 保存子进程日志；显式统一编码，避免中文日志变成乱码。
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")

    if len(sys.argv) != 3:
        raise ValueError("参数格式：jmcomic_download.py <漫画ID> <下载目录>")

    comic_id = sys.argv[1].strip()
    if not comic_id.isdigit() or len(comic_id) > 20:
        raise ValueError("漫画ID必须是 1 至 20 位数字")

    pdf_path, cached = get_comic_pdf(comic_id, sys.argv[2])
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
