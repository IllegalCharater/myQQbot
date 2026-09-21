import json
import os
import shutil
import sys


BLACKLIST = {350234, 350235}
MAX_PDF_FILES = 6
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


def get_comic_pdf(comic_id, download_dir):
    try:
        from jmcomic import Feature, download_album
    except ImportError as error:
        raise RuntimeError(
            "Conda 环境 my_bot 未安装 jmcomic，请执行 "
            "conda run -n my_bot python -m pip install jmcomic，"
            "或用 JMCOMIC_PYTHON 指定其他已安装该模块的解释器"
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

    pdf_path = os.path.join(download_dir, f"{comic_id}.pdf")
    if is_valid_pdf(pdf_path):
        return pdf_path, True

    staging_dir = os.path.join(download_dir, ".staging", f"{comic_id}-{os.getpid()}")
    os.makedirs(staging_dir, exist_ok=True)
    staging_pdf = os.path.join(staging_dir, f"{comic_id}.pdf")
    option = build_download_option()

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
