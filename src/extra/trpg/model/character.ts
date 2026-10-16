// 人物卡的**归一化**（从 `state.ts` 拆出，2026-10-16）。
//
// 判据与 `model/campaign.ts` 那条一致：**文件里的东西能不能信**。读坏文件、旧版本文件、
// 手改过的文件、以及剧本里的预置人物卡，全都走这两个函数。
//
// `normalizeCharacter` 是**导出**的，因为剧本里的预置人物卡必须走**同一套**判据
// （`scenario/parse.ts`）—— 另写一份必然漂移，而漂移的表现是"手写 json 能被夹回、
// 剧本里的却被原样收下"。
import { HIDDEN_FIELDS } from '../types.js';
import { MAX_NAME_CHARS, MAX_NOTES, MAX_NOTE_CHARS, MAX_POOL, MAX_STATS_PER_CHARACTER, MAX_STAT, MIN_STAT, clampInt, text } from './limits.js';

import type { HiddenField, TrpgCharacter } from '../types.js';

/** DB 的长度上限。它是一条表达式（`+1d4`），不是自由文本。 */
const MAX_DB_CHARS = 16;
/** MOV 的合法区间。规则书给的是 7/8/9，但手改的表可能给别的 —— 只挡明显不合理的。 */
const MIN_MOV = 0;
const MAX_MOV = 20;

/**
 * 一张卡归一化：丢弃畸形字段、裁掉越界值、砍掉多余的备注。
 *
 * 没有名字的卡返回 `null` —— 没有名字的卡没有任何用处，宁可丢掉也不留一张空壳。
 */
export function normalizeCharacter(raw: unknown): TrpgCharacter | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const name = text(source.name, MAX_NAME_CHARS);
  if (!name) return null;

  const hpMax = clampInt(source.hpMax, 0, MAX_POOL, 10);
  const sanMax = clampInt(source.sanMax, 0, MAX_POOL, 0);
  const mpMax = clampInt(source.mpMax, 0, MAX_POOL, 0);
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
    // MP 与 HP/SAN 同一套：缺省"满"，越界夹回区间。
    mp: clampInt(source.mp, 0, mpMax, mpMax),
    mpMax,
    // DB / Build / MOV 是**派生值**（P4 起）：老存档里没有它们，缺省分别是空串 / 0 / 0 ——
    // 0 表示"这套规则没有这个概念"，渲染据此不印那一栏（同 `sanMax` 那条）。
    db: text(source.db, MAX_DB_CHARS),
    build: clampInt(source.build, -MAX_POOL, MAX_POOL, 0),
    mov: clampInt(source.mov, MIN_MOV, MAX_MOV, 0),
    notes,
    // 缺省是"玩家已经见过"：老存档里没有这两个字段，而把既有的卡一夜之间变成"没发现"
    // 会让玩家笔记整页空掉。要藏起来是一个**显式动作**（建卡时 visible=false）。
    discovered: source.discovered !== false,
    hidden: normalizeHidden(source.hidden),
    // 缺省 false：旧卡（以及 DM 用工具建的卡）都还没「确认」过。这只影响 `preparing`
    // 那一档的闸门 —— 旧存档迁移成 `active`，所以升级不会挡住任何正在跑的团。
    confirmed: source.confirmed === true
  };
}

/**
 * 字段级可见度：只留认识的那几个字段名，去重。
 *
 * 认不出来的一律丢弃而不是报错 —— 它可能来自一个更早/更晚的版本，而"某个字段名不认识"
 * 不该让整张卡报废（同 `normalizeCharacter` 其余部分的取舍）。
 */
export function normalizeHidden(raw: unknown): HiddenField[] {
  if (!Array.isArray(raw)) return [];
  const out: HiddenField[] = [];
  for (const item of raw) {
    const name = text(item, MAX_NAME_CHARS).toLowerCase() as HiddenField;
    if ((HIDDEN_FIELDS as readonly string[]).includes(name) && !out.includes(name)) out.push(name);
  }
  return out;
}
