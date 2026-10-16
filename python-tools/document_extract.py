"""从 pdf / docx / txt / md 里抽出纯文本。

用法（Node 侧只会用这一种）：

    <python> document_extract.py --max-chars 20000  < 文件字节流  > 结果帧

- **字节走 stdin**：不落临时文件，于是没有"临时文件什么时候删""路径会不会越界"这两件事，
  也把攻击面从"文件路径"收成"一段字节流"。argv 里因此只有两个数字/开关，不含任何用户内容。
- **结果走 stdout 的一帧**：`__QQ_AGENT_RESULT__{json}`，与 `jmcomic_download.py` 同形，
  Node 侧用同一套"只看最后一帧、stdout 任意分块"的读法（见 `media/jmcomic/python.ts`）。
  而"字节走 stdin、结果走 stdout"这个形状本身与搜图 worker 同形。

── 为什么四种格式都在这一个进程里 ──

这个能力对外是**一件事**（"把文件读成文本"），所以它对内也只该有一处格式判断。
分成"Node 读文本 + Python 读 pdf"那种写法，会让"这个后缀到底归谁"变成两份知识，
而它们必然漂移 —— 表现是"同一个文件改个后缀就从能读变成不能读"，且没有任何报错。

── 格式判断靠**嗅探字节**，不靠文件名 ──

后缀是用户打的，字节是文件自己的。Node 侧不传文件名，正是为了让"这是什么格式"只有一个判据。
判据顺序见 `sniff()`：先看魔数（`%PDF-` / `PK` / OLE2 复合文档），再看有没有 NUL
（文本文件不会有，UTF-8 的多字节序列里也不会出现 `0x00`）。

── 依赖只有 pypdf（而且只有 pdf 需要它）──

docx / txt / md 走 Python 标准库（`zipfile` + `xml.etree`），**永远可用**；
pdf 要 `pypdf`，缺了就在结果帧里给 `code: MISSING_PDF_LIB` + 一句"装什么、怎么装"，
Node 侧原样透给模型/群友（同 `PYTHON_MISSING_HINT` 的取舍）。
"""

import io
import json
import sys
import zipfile

RESULT_PREFIX = "__QQ_AGENT_RESULT__"

# 单次送进来的字节上限的**第二道**（第一道在 Node 侧，它才是用户看到的那个）。
# 放在这里是因为 stdin 是流：真读到一个 2GB 的东西不该先把内存吃光再说话。
MAX_INPUT_BYTES = 32 * 1024 * 1024
# 抽出来的正文字符上限的**第二道**（Node 侧还会再按配置截一次并给出"共 N 字"）。
# 它的用途是别让一份 500 页的 PDF 在结果帧里撑出几十 MB 的 JSON。
MAX_TEXT_CHARS = 200_000

# OLE2 复合文档的魔数（旧版 .doc / .xls / .ppt）。
OLE2_MAGIC = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"


class MissingLib(Exception):
    """缺一个库 —— 带 code，好让 Node 侧能把它与"这份文件读不了"分开。"""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


# 编码尝试顺序。**GBK 只在前一档明确失败时才试**，且试成功了会在结果里如实说出用的是哪个 ——
# 中文文档里 GBK 太常见，直接拒掉会让"另存为 UTF-8 再传一次"变成用户唯一的路；
# 而猜错了的表现是看起来通顺的乱码，所以这一档必须留痕、不能默默做。
ENCODINGS = ("utf-8", "gbk")


def emit_result(payload):
    line = RESULT_PREFIX + json.dumps(payload, ensure_ascii=False) + "\n"
    sys.stdout.buffer.write(line.encode("utf-8"))
    sys.stdout.buffer.flush()


def sniff(data):
    """认出这是什么格式。返回 ('pdf'|'docx'|'text'|'ole2'|'zip'|'binary', 说明)。"""
    if data.startswith(b"%PDF-"):
        return "pdf", ""
    if data.startswith(OLE2_MAGIC):
        return "ole2", ""
    if data.startswith(b"PK\x03\x04"):
        # ZIP 只是个容器：是 .docx 还是别的压缩包，要看里面有没有 Word 的主文档。
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as zf:
                names = zf.namelist()
        except Exception as error:
            return "binary", f"这个文件以 ZIP 开头但打不开（{error}）"
        if "word/document.xml" in names:
            return "docx", ""
        return "zip", ""
    # 文本文件不会有 NUL，UTF-8 的多字节序列里也不会出现 0x00 —— 判据同 scenario.ts 那条。
    # 只看开头一段：真有 NUL 的文件，前 8KB 里几乎必然出现。
    if b"\x00" in data[:8192]:
        return "binary", ""
    return "text", ""


# ── 文本 ─────────────────────────────────────────────────────────────────────

def decode_text(data):
    """字节 → (文本, 编码)。前一档失败得明显才试下一档。"""
    best = None
    for encoding in ENCODINGS:
        try:
            text = data.decode(encoding)
        except UnicodeDecodeError:
            continue
        broken = text.count("�")
        # 两条同时要求：绝对量（个别错字该被忽略）与占比（一篇短乱码不该蒙混过关）。
        # 这个判据与 `extra/trpg/scenario.ts` 的 `decodeScenarioFile` 逐字同源。
        if broken < 10 or broken / max(1, len(text)) <= 0.01:
            return text, encoding
        if best is None:
            best = (text, encoding)
    if best is not None:
        return best
    raise ValueError("这个文件不是文本（UTF-8 与 GBK 都解不出来）")


# ── docx ─────────────────────────────────────────────────────────────────────
#
# 用标准库手解，而不是装 python-docx：docx 就是一个 zip + 一份 XML，而
# `python-docx` 会拖进 lxml 那一整条链 —— 为了一件标准库 30 行就能做的事，
# 让"读个剧本"也变成"先装一堆东西"，不划算。

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def _paragraph_text(node, out):
    """一段（`w:p`）→ 文本。递归，因为 run 里可能还套着 smartTag 之类。"""
    for child in node:
        tag = child.tag
        if tag == W + "t":
            out.append(child.text or "")
        elif tag == W + "tab":
            out.append("\t")
        elif tag in (W + "br", W + "cr"):
            out.append("\n")
        elif tag in (W + "delText", W + "instrText"):
            continue  # 已删除的修订、域代码 —— 都不是正文
        else:
            _paragraph_text(child, out)


def _block_text(node, out):
    """块级（文档体 / 单元格 / 表格）→ 文本。"""
    for child in node:
        tag = child.tag
        if tag == W + "p":
            _paragraph_text(child, out)
            out.append("\n")
        elif tag in (W + "tbl", W + "sdt", W + "sdtContent", W + "body"):
            _block_text(child, out)
        elif tag == W + "tc":
            # 单元格内的段落已经各留了换行；这里补一个制表符当分隔，不追求表格对齐。
            _block_text(child, out)
            out.append("\t")
        elif tag == W + "tr":
            _block_text(child, out)
            out.append("\n")
        else:
            # 未知块级容器：继续往下找段落，别把里面整段正文丢掉。
            _block_text(child, out)


def extract_docx(data):
    import xml.etree.ElementTree as ET

    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        xml = zf.read("word/document.xml")
    root = ET.fromstring(xml)
    out = []
    _block_text(root, out)
    return "".join(out), {}


# ── pdf ──────────────────────────────────────────────────────────────────────

def extract_pdf(data):
    try:
        from pypdf import PdfReader
    except ImportError:
        raise MissingLib(
            "MISSING_PDF_LIB",
            "当前 Python 解释器未安装 pypdf（读 PDF 要用它）。"
            "请用**同一个**解释器装一遍项目依赖："
            "`<python> -m pip install -r python-tools/requirements.txt`"
            "（解释器路径见设置页「Python 工具」，也可以用环境变量 QQ_AGENT_PYTHON 指定；"
            "那里还有一个「跑一遍依赖自检」的按钮）",
        )

    try:
        reader = PdfReader(io.BytesIO(data))
    except Exception as error:
        # pypdf 的原话是英文，而这句话会经 Node 回到模型/群友眼前 —— 换成中文并带上原文。
        raise ValueError(f"这份 PDF 打不开（{error}）")

    if reader.is_encrypted:
        try:
            # 空密码能解开的"加密"PDF 很常见（只是设了权限位），先试一次。
            unlocked = bool(reader.decrypt(""))
        except Exception:
            unlocked = False
        if not unlocked:
            raise ValueError("这份 PDF 加了密码，读不了它的正文")

    pages = []
    for page in reader.pages:
        try:
            pages.append(page.extract_text() or "")
        except Exception:
            # 单页抽不出来不该毁掉整份：把它留成空行，继续下一页。
            pages.append("")
    return "\n".join(pages), {"pages": len(reader.pages)}


# ── 归一 ─────────────────────────────────────────────────────────────────────

def tidy(text):
    """压掉抽取器留下的排版噪声：行尾空白、三个以上的连续空行。"""
    import re

    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def main():
    max_chars = MAX_TEXT_CHARS
    argv = sys.argv[1:]
    if len(argv) == 2 and argv[0] == "--max-chars":
        try:
            max_chars = max(1, int(argv[1]))
        except ValueError:
            raise ValueError("--max-chars 要一个整数")
    elif argv:
        raise ValueError("参数格式：document_extract.py [--max-chars N]（文件字节从 stdin 读）")

    data = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
    if not data:
        raise ValueError("这个文件是空的")
    if len(data) > MAX_INPUT_BYTES:
        raise ValueError(f"这个文件太大了（超过 {MAX_INPUT_BYTES // (1024 * 1024)} MB）")

    fmt, note = sniff(data)
    meta = {}
    if fmt == "pdf":
        text, meta = extract_pdf(data)
    elif fmt == "docx":
        text, meta = extract_docx(data)
    elif fmt == "text":
        text, encoding = decode_text(data)
        meta = {"encoding": encoding}
    elif fmt == "ole2":
        raise ValueError("这是旧版的 Office 二进制格式（.doc / .xls / .ppt），不是 .docx —— 请用 Word / WPS 另存为 .docx 再传一次")
    elif fmt == "zip":
        raise ValueError("这是一个压缩包，但里面没有 Word 文档（没有 word/document.xml）—— 本工具只认 .pdf / .docx / .txt / .md")
    else:
        raise ValueError(note or "这个文件看起来不是文本（含空字节），也不是 PDF / DOCX —— 本工具只认 .pdf / .docx / .txt / .md")

    text = tidy(text)
    if not text:
        # 抽完了什么都没有：**别说成成功**。扫描件、纯图片 PDF 都落在这里，
        # 而"给模型一段空正文"会让它以为这份文件本来就没内容。
        raise ValueError("没能从这份文件里抽出任何文字 —— 如果它是扫描件（整页是图片），本工具读不出内容")

    total = len(text)
    truncated = total > max_chars
    emit_result({
        "ok": True,
        "format": fmt,
        "text": text[:max_chars],
        "chars": total,
        "truncated": truncated,
        **meta,
    })


if __name__ == "__main__":
    # Node 按 UTF-8 读子进程输出；显式统一编码，避免中文变成乱码（同 jmcomic_download.py）。
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    try:
        main()
    except MissingLib as error:
        emit_result({"ok": False, "error": str(error), "code": error.code})
        raise SystemExit(1)
    except Exception as error:
        emit_result({"ok": False, "error": str(error)})
        raise SystemExit(1)
