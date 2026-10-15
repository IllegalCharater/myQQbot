// 跑团的状态层：**读写、归一化、上限**。
//
// ── 为什么上限是这里的头等大事 ──
//
// 这份状态**每一轮都要拼进 system prompt**（`impl.prompt(chatKey)` 渲染它）。所以它的每一项
// 上限都不是"整洁"，而是**成本**：日志多留 40 条、场景多写两千字，就是每一轮都多付一次 token，
// 而且会一路挤掉 user prompt 里真正该给模型看的东西。所有的数因此都写在这里、集中一处，
// 并且**读取时也归一化**（同 `media/hot-search/state-store.ts`）—— 手改过 config 一样的东西、
// 或旧版本写下的更大值，都不会绕过上限。
//
// ── 落盘 ──
//
// 一个会话一个文件：`data/trpg/<会话>.json`。原子替换（tmp + rename），读不到就返回 `null`
// （**不是**空对象 —— "还没有开团"与"开了一场空的团"是两件事，前者要提示模型去开局）。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../core/paths.js';
import type { TrpgCampaign, TrpgCharacter, TrpgLogEntry } from './types.js';

// ── 上限 ─────────────────────────────────────────────────────────────────────
/** 一个会话最多几场？——一场。这条常量只是把那个决定写下来，不参与判断。 */
export const MAX_LOG_STORED = 60;
/** 渲染进提示词的日志条数（留档 60 条，但只把最近这些给模型看）。 */
export const MAX_LOG_RENDER = 14;
export const MAX_LOG_CHARS = 600;
export const MAX_CHARACTERS = 30;
export const MAX_STATS_PER_CHARACTER = 30;
export const MAX_NOTES = 12;
export const MAX_NOTE_CHARS = 160;
export const MAX_FLAGS = 30;
export const MAX_FLAG_VALUE_CHARS = 160;
export const MAX_SCENE_CHARS = 400;
export const MAX_TITLE_CHARS = 60;
export const MAX_SYSTEM_CHARS = 60;
export const MAX_NAME_CHARS = 24;
/** 属性/技能值的合法区间。防的是模型给出 `1e9` 或 `NaN` 这种让它自己以后都算不明白的数。 */
export const MIN_STAT = -999;
export const MAX_STAT = 9999;
/** HP / SAN 上限的合法区间。 */
export const MAX_POOL = 9999;

const TRPG_DIR = path.join(DATA_DIR, 'trpg');

/**
 * 会话标识 → 文件名。
 *
 * 与 `chat/store.ts` 的 `safeName` **同形但各自一份**：两处落在**不同的目录**里，
 * 彼此不需要一致（`data/messages/group_123.json` 与 `data/trpg/group_123.json` 是两回事），
 * 所以不值得为它去动 core 的路径锚点。判据是"两个东西需不需要互相读得到"，不是"长得像不像"。
 */
function safeName(chatKey: string): string {
  return String(chatKey).replace(/[^a-z0-9_]/gi, '_');
}

export function campaignFile(chatKey: string): string {
  return path.join(TRPG_DIR, `${safeName(chatKey)}.json`);
}

// ── 归一化 ───────────────────────────────────────────────────────────────────

/** 截断到上限并去空白。`undefined` / 非字符串一律给空串 —— 读坏文件不该炸。 */
export function text(value: unknown, maxChars: number): string {
  return String(value ?? '').trim().slice(0, maxChars);
}

/**
 * 取一个整数并夹进区间。取不到（`NaN` / `Infinity` / 非数）时给 `fallback`。
 *
 * ⚠️ **夹取发生在写入与读取两处**，这是有意的重复：写入那次是"我们不让坏值进文件"，
 * 读取那次是"文件里已经有坏值也不让它进提示词"。
 */
export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** 一张卡归一化：丢弃畸形字段、裁掉越界值、砍掉多余的备注。 */
function normalizeCharacter(raw: unknown): TrpgCharacter | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const name = text(source.name, MAX_NAME_CHARS);
  if (!name) return null;      // 没有名字的卡没有任何用处，宁可丢掉也不留一张空壳

  const hpMax = clampInt(source.hpMax, 0, MAX_POOL, 10);
  const sanMax = clampInt(source.sanMax, 0, MAX_POOL, 0);
  const stats: Record<string, number> = {};
  const rawStats = source.stats;
  if (rawStats && typeof rawStats === 'object' && !Array.isArray(rawStats)) {
    for (const [key, value] of Object.entries(rawStats as Record<string, unknown>)) {
      if (Object.keys(stats).length >= MAX_STATS_PER_CHARACTER) break;
      const label = text(key, MAX_NAME_CHARS);
      if (!label) continue;
      stats[label] = clampInt(value, MIN_STAT, MAX_STAT, 0);
    }
  }

  const notes: string[] = [];
  if (Array.isArray(source.notes)) {
    for (const item of source.notes) {
      if (notes.length >= MAX_NOTES) break;
      const note = text(item, MAX_NOTE_CHARS);
      if (note) notes.push(note);
    }
  }

  return {
    name,
    ownerId: /^\d+$/.test(String(source.ownerId ?? '')) ? String(source.ownerId) : '',
    stats,
    hp: clampInt(source.hp, 0, hpMax, hpMax),
    hpMax,
    san: clampInt(source.san, 0, sanMax, sanMax),
    sanMax,
    notes
  };
}

function normalizeLogEntry(raw: unknown): TrpgLogEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const body = text(source.text, MAX_LOG_CHARS);
  if (!body) return null;
  return {
    seq: clampInt(source.seq, 0, Number.MAX_SAFE_INTEGER, 0),
    ts: clampInt(source.ts, 0, Number.MAX_SAFE_INTEGER, 0),
    kind: text(source.kind, 16) || 'note',
    text: body
  };
}

/**
 * 把任意输入归一整场战役。**读坏文件、旧版本文件、手改过的文件都会走这里**，
 * 所以它是"文件里的东西能不能信"的唯一判据。
 */
export function normalizeCampaign(raw: unknown, chatKey: string): TrpgCampaign | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const now = Date.now();

  const characters: TrpgCharacter[] = [];
  if (Array.isArray(source.characters)) {
    for (const item of source.characters) {
      if (characters.length >= MAX_CHARACTERS) break;
      const card = normalizeCharacter(item);
      // 重名的只留第一张。同名两张卡会让"改谁的血"变成运气，而工具是按名字找卡的。
      if (card && !characters.some((c) => c.name === card.name)) characters.push(card);
    }
  }

  const flags: Record<string, string> = {};
  const rawFlags = source.flags;
  if (rawFlags && typeof rawFlags === 'object' && !Array.isArray(rawFlags)) {
    for (const [key, value] of Object.entries(rawFlags as Record<string, unknown>)) {
      if (Object.keys(flags).length >= MAX_FLAGS) break;
      const label = text(key, MAX_NAME_CHARS);
      if (!label) continue;
      flags[label] = text(value, MAX_FLAG_VALUE_CHARS);
    }
  }

  const log: TrpgLogEntry[] = [];
  if (Array.isArray(source.log)) {
    for (const item of source.log) {
      const entry = normalizeLogEntry(item);
      if (entry) log.push(entry);
    }
  }
  // 留档只留最近 MAX_LOG_STORED 条。**序号不回退**：下面 seq 取最大值 + 1。
  const trimmed = log.slice(-MAX_LOG_STORED);
  const maxSeq = trimmed.reduce((max, entry) => Math.max(max, entry.seq), 0);

  return {
    chatKey,
    title: text(source.title, MAX_TITLE_CHARS),
    system: text(source.system, MAX_SYSTEM_CHARS),
    scene: text(source.scene, MAX_SCENE_CHARS),
    flags,
    characters,
    log: trimmed,
    seq: Math.max(clampInt(source.seq, 1, Number.MAX_SAFE_INTEGER, 1), maxSeq + 1),
    createdAt: clampInt(source.createdAt, 0, Number.MAX_SAFE_INTEGER, now),
    updatedAt: clampInt(source.updatedAt, 0, Number.MAX_SAFE_INTEGER, now)
  };
}

/** 开一场新团。不落盘 —— 由调用方决定什么时候写。 */
export function emptyCampaign(chatKey: string, { title, system }: { title: string; system: string }): TrpgCampaign {
  const now = Date.now();
  return {
    chatKey,
    title: text(title, MAX_TITLE_CHARS) || '未命名',
    system: text(system, MAX_SYSTEM_CHARS),
    scene: '',
    flags: {},
    characters: [],
    log: [],
    seq: 1,
    createdAt: now,
    updatedAt: now
  };
}

// ── 变更（就地改，调用方负责 write）─────────────────────────────────────────

/**
 * 追加一条日志并推进序号。**所有会改变状态的动作都要经过它** —— 这是"发生了什么都记得下来"
 * 的唯一入口，也是渲染层给模型看的"最近发生"。
 */
export function appendLog(campaign: TrpgCampaign, kind: string, body: string): TrpgLogEntry | null {
  const line = text(body, MAX_LOG_CHARS);
  if (!line) return null;
  const entry: TrpgLogEntry = { seq: campaign.seq, ts: Date.now(), kind: text(kind, 16) || 'note', text: line };
  campaign.seq += 1;
  campaign.log.push(entry);
  if (campaign.log.length > MAX_LOG_STORED) campaign.log.splice(0, campaign.log.length - MAX_LOG_STORED);
  campaign.updatedAt = Date.now();
  return entry;
}

/** 按名字找卡。名字是唯一的键（`normalizeCampaign` 保证不重名）。 */
export function findCharacter(campaign: TrpgCampaign, name: unknown): TrpgCharacter | null {
  const wanted = text(name, MAX_NAME_CHARS);
  if (!wanted) return null;
  return campaign.characters.find((card) => card.name === wanted) ?? null;
}

// ── 读写 ─────────────────────────────────────────────────────────────────────

/**
 * 一个会话的战役文件。**读不到返回 `null`**（而不是空对象）——"还没有开团"与"开了一场空的团"
 * 是两件事：前者要提示模型去 `campaign_start`，后者不该提示。
 *
 * 写是**原子替换**（tmp + rename），与 `chat/store.ts` / `hot-search/state-store.ts` 同形。
 */
export class TrpgStore {
  readonly dir: string;

  constructor(dir: string = TRPG_DIR) {
    this.dir = dir;
  }

  file(chatKey: string): string {
    return path.join(this.dir, `${safeName(chatKey)}.json`);
  }

  read(chatKey: string): TrpgCampaign | null {
    if (!chatKey) return null;
    try {
      const raw = fs.readFileSync(this.file(chatKey), 'utf8');
      return normalizeCampaign(JSON.parse(raw), chatKey);
    } catch {
      return null;   // 没有文件 / 坏 JSON / 读不动，一律当"没有这场团"
    }
  }

  write(campaign: TrpgCampaign): TrpgCampaign {
    const safe = normalizeCampaign(campaign, campaign.chatKey) ?? campaign;
    fs.mkdirSync(this.dir, { recursive: true });
    const target = this.file(campaign.chatKey);
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(safe, null, 1), 'utf8');
    fs.renameSync(tmp, target);
    return safe;
  }

  remove(chatKey: string): void {
    try { fs.rmSync(this.file(chatKey)); } catch { /* 本来就没有 */ }
  }
}
