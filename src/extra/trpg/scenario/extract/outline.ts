// 跑团扩展 · 抽取管线 **L1：把一份长文切成片**。
//
// ── 这一层为什么是纯代码 ──
//
// 切片的判据是**结构**（标题行、空行、长度），不是语义 —— 那正是代码能做的事。把它交给模型
// 只会多一次调用、多一处不确定，还得让模型把原文再抄一遍（抄漏了就永久丢内容）。
// 所以这里是**纯函数、零 I/O、零模型调用**：给定同一份文本，永远切出同一组片。
//
// ── 为什么不静默丢 ──
//
// 片数撞上 `MAX_CHUNKS` 之后剩下的正文**进不了任何切片**。静默丢掉的话，表现是"抽出来的
// 比原文少，而没有任何人知道" —— 所以超出的字数记进 `droppedChars`，回执与 `.trpg check`
// 都要把它说出来（同"抽取器截断过的正文当场拒"那条约定的精神）。
//
// ⚠️ **本目录（`scenario/extract/`）不许出现 `node:fs` / `node:path`**（`check-layers.mjs`
// 有一条闸门，与 `model/` 同形）：这一层要能脱离磁盘被测。落盘是 `store/` 的事。
import { MAX_CHUNK_CHARS, MAX_CHUNKS, MIN_CHUNK_CHARS } from '../../model/limits.js';

export interface DocChunk {
  /** 在 `chunks` 里的下标（切片后重新编号，所以恒为 0..n-1）。 */
  index: number;
  /** 这一片的**起始小节标题**（没有标题的小节是空串）。只用于日志与回执，不进提示词的判据。 */
  heading: string;
  chars: number;
  text: string;
}

export interface DocOutline {
  chunks: DocChunk[];
  /** 原文总字数（含空行 —— 它只是"这份文件多大"的一个参照，不是任何判据）。 */
  totalChars: number;
  /** **没进任何切片**的正文字数：片数撞上 `MAX_CHUNKS` 之后剩下的那些。0 = 全切进来了。 */
  droppedChars: number;
}

const MD_HEADING = /^#{1,6}\s+\S/;
const CN_HEADING = /^第\s*[0-9零一二三四五六七八九十百千]+\s*[章节幕回部篇场]/;
const EN_HEADING = /^(chapter|scene|act|part|section)\s+[0-9ivxl]+\b/i;
const BRACKET_HEADING = /^[【[][^】\]]{1,30}[】\]]$/;
const SETEXT = /^(={3,}|-{3,})\s*$/;
/** 独立成行、两边是空行的短句 —— 裸设定文档里最常见的"标题"形态。 */
const PLAIN_HEADING_MAX = 30;

/**
 * 一眼就是标题的行（Markdown 井号、中文"第X章"、英文 Chapter N、方括号包起来的一行）。
 *
 * ⚠️ 判错的代价很小：标题只决定"片切在哪"，不影响任何内容（正文永远整段进片，从不因为
 * 一个标题被丢掉）。所以这里宁可宽一点 —— 多认一个假标题只是多一个切片边界。
 */
function isStrongHeading(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  return MD_HEADING.test(trimmed) || CN_HEADING.test(trimmed) || EN_HEADING.test(trimmed) || BRACKET_HEADING.test(trimmed);
}

/**
 * "短句 + 不以句读结尾" —— 裸设定文档里最常见的标题形态。
 *
 * ⚠️ **它必须额外要求"两边都是空行"**（由 `splitSections` 加）：中文没有分词，正文里
 * 随便一句短话都长这样。只看这一条的话，一段三句话的正文会被切成三个小节。
 */
function isPlainHeading(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > PLAIN_HEADING_MAX) return false;
  return !/[。！？；：，、.!?;:,]$/.test(trimmed);
}

interface Section { heading: string; lines: string[] }

/**
 * 按标题行切成小节。**第一个标题之前的内容自成一个"前言"小节**（heading 为空串）——
 * 裸设定文档经常在开头先写一段总述，那段不该被算进第一章。
 */
function splitSections(text: string): Section[] {
  const lines = text.split('\n');
  const sections: Section[] = [];
  let heading = '';
  let buf: string[] = [];
  const flush = (): void => {
    const body = buf.join('\n').trim();
    if (body) sections.push({ heading, lines: [body] });
    buf = [];
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const next = lines[i + 1] ?? '';
    const prev = lines[i - 1] ?? '';
    // Setext 标题：这一行是正文、下一行是 `===` / `---`。
    const setext = SETEXT.test(next.trim()) && line.trim().length > 0;
    const strong = isStrongHeading(line);
    // "短句标题"只在两边都是空行时才算 —— 否则正文里随便一句短话都会被当成标题。
    const plain = !strong && !setext && !prev.trim() && !next.trim() && isPlainHeading(line);
    if (strong || setext || plain) {
      flush();
      heading = line.trim().replace(/^#+\s*/, '').slice(0, 60);
      buf = [line];
      if (setext) {
        buf.push(lines[i + 1]);
        i += 1;
      }
      continue;
    }
    buf.push(line);
  }
  flush();
  return sections;
}

/** 一段超过上限时按空行再切；切不动（一整个没有空行的长段）就硬切。 */
function splitLong(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const paragraphs = text.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
  const out: string[] = [];
  let current = '';
  for (const paragraph of paragraphs) {
    if (paragraph.length > max) {
      if (current) {
        out.push(current);
        current = '';
      }
      for (let i = 0; i < paragraph.length; i += max) out.push(paragraph.slice(i, i + max));
      continue;
    }
    if (current && current.length + paragraph.length + 2 > max) {
      out.push(current);
      current = '';
    }
    current = current ? `${current}\n\n${paragraph}` : paragraph;
  }
  if (current) out.push(current);
  return out;
}

interface Piece { heading: string; text: string; startsSection: boolean }

function toPieces(sections: readonly Section[]): Piece[] {
  const out: Piece[] = [];
  for (const section of sections) {
    const body = section.lines.join('\n').trim();
    if (!body) continue;
    splitLong(body, MAX_CHUNK_CHARS).forEach((part, i) => {
      out.push({ heading: section.heading, text: part, startsSection: i === 0 });
    });
  }
  return out;
}

/**
 * L1：把 `text` 切成片。
 *
 * 切法是"先按标题分小节、再把小节并成片"：片长夹在 `[MIN_CHUNK_CHARS, MAX_CHUNK_CHARS]` 里 ——
 * 到了下限、又正好遇到新标题就收片；超过上限无论如何收片。最后按 `MAX_CHUNKS` 截断。
 */
export function outlineDocument(text: unknown): DocOutline {
  const source = String(text ?? '').replace(/\r\n?/g, '\n');
  const pieces = toPieces(splitSections(source));

  const packed: DocChunk[] = [];
  let current: { heading: string; parts: string[]; chars: number } | null = null;
  const close = (): void => {
    if (!current) return;
    packed.push({ index: packed.length, heading: current.heading, chars: current.chars, text: current.parts.join('\n\n').trim() });
    current = null;
  };

  for (const piece of pieces) {
    if (current) {
      const overflow = current.chars + piece.text.length > MAX_CHUNK_CHARS;
      const natural = piece.startsSection && current.chars >= MIN_CHUNK_CHARS;
      if (overflow || natural) close();
    }
    if (!current) current = { heading: piece.heading, parts: [], chars: 0 };
    current.parts.push(piece.text);
    current.chars += piece.text.length;
    if (current.chars >= MAX_CHUNK_CHARS) close();
  }
  close();

  // 兜底：整份都是空白（或只有空行）时切不出任何片，但调用方手里确实有内容 ——
  // 那就当成一片。切不出片而返回空清单会让上层报"没有内容"，与事实不符。
  if (!packed.length && source.trim()) {
    packed.push({ index: 0, heading: '', chars: source.trim().length, text: source.trim().slice(0, MAX_CHUNK_CHARS) });
  }

  const kept = packed.slice(0, MAX_CHUNKS);
  const dropped = packed.slice(MAX_CHUNKS);
  return {
    chunks: kept.map((chunk, index) => ({ ...chunk, index })),
    totalChars: source.length,
    droppedChars: dropped.reduce((sum, chunk) => sum + chunk.chars, 0)
  };
}
