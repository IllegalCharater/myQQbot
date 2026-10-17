// 跑团状态的**上限与取值助手**（从 `state.ts` 拆出，2026-10-16）。
//
// ── 为什么上限是头等大事 ──
//
// 这份状态**每一轮都要拼进 system prompt**（`impl.prompt(chatKey)` 渲染它）。所以它的每一项
// 上限都不是"整洁"，而是**成本**：日志多留 40 条、场景多写两千字，就是每一轮都多付一次 token，
// 而且会一路挤掉 user prompt 里真正该给模型看的东西。所有的数因此都写在这里、集中一处，
// 并且**读取时也归一化**（同 `media/hot-search/state-store.ts`）—— 手改过 config 一样的东西、
// 或旧版本写下的更大值，都不会绕过上限。
//
// `text` 与 `clampInt` 住在这里而不是另开一个文件：它们就是"按上限取值"的两种形态
// （截断 / 夹进区间），与这些常量是同一件事的两半。`model/` 下所有文件都从这里取它们。
//
// ⚠️ **本目录（`model/`）不许出现 `node:fs` / `node:path`** —— 这一层是纯数据变换，
// 需要读写时一律收 store 端口作参数。闸门在 `scripts/check-layers.mjs`。

// ── 上限 ─────────────────────────────────────────────────────────────────────

/** 一个会话最多几场？——一场。这条常量只是把那个决定写下来，不参与判断。 */
export const MAX_LOG_STORED = 60;
/** 渲染进提示词的日志条数（留档 60 条，但只把最近这些给模型看）。 */
export const MAX_LOG_RENDER = 14;
export const MAX_LOG_CHARS = 600;
export const MAX_CHARACTERS = 30;
/**
 * 一局最多几个玩家（`.trpg join` 的上限）。
 *
 * 它同时是**成本**：玩家名单一路进提示词（`.trpg status` 与 DM 那份局势卡都要列出来），
 * 而「一桌坐得下几个人」本来也就是这么个数。
 */
export const MAX_PLAYERS = 8;
export const MAX_STATS_PER_CHARACTER = 30;
export const MAX_NOTES = 12;
export const MAX_NOTE_CHARS = 160;
export const MAX_FLAGS = 30;
export const MAX_FLAG_VALUE_CHARS = 160;
export const MAX_SCENE_CHARS = 400;
export const MAX_TITLE_CHARS = 60;
export const MAX_SYSTEM_CHARS = 60;
/**
 * 规则表 id 的长度上限。**它同时是文件名的上限**，所以只写在这一处：`store/rule-store.ts`
 * 从这里取，免得两个文件各写一个数然后漂移（漂移的表现是"长 id 在存档里被截短、于是指向另一个文件"）。
 */
export const MAX_RULE_CHARS = 64;
/**
 * 剧本 id（= 剧本名 = 文件名）的长度上限。**它同时是文件名的上限**，所以只写在这一处：
 * `safeFileName` 拿它当缺省（剧本名是它的主用途），`model/campaign.ts` 的剧本快照与
 * `model/session.ts` 的开局参数也各取一次。
 *
 * ⚠️ 它与 `MAX_RULE_CHARS` 是**两个不同的数**，别合并：规则表 id 是管理员手写的短标识，
 * 剧本名是群友随手起的（可能是一整句中文），两个数各由各自的用法决定。
 */
export const MAX_SCENARIO_ID_CHARS = 40;
export const MAX_NAME_CHARS = 24;

/**
 * 一场战斗最多几个人进先攻序（P5）。
 *
 * 与 `MAX_PLAYERS` / `MAX_CHARACTERS` 是**两个不同的数**，别合并：玩家名单只管报名，
 * 而先攻序里还有 NPC —— 人数上限由"这一轮要印多长的顺序"决定，而那份顺序**每一轮都进
 * system prompt**（`render/model.ts` 的战斗段）。所以它同样是成本，不是整洁。
 */
export const MAX_COMBATANTS = 20;
/**
 * 回合数的上限（P5）。它的用途只有一个：手改过的存档里 `round` 可能是个 `1e9` 或负数，
 * 而那个数会一路印进提示词。**它不拦"这局打了多久"** —— 打到第 9999 轮是玩家自己的事。
 */
export const MAX_COMBAT_ROUNDS = 9999;

/** 属性/技能值的合法区间。防的是模型给出 `1e9` 或 `NaN` 这种让它自己以后都算不明白的数。 */
export const MIN_STAT = -999;
export const MAX_STAT = 9999;
/** HP / SAN 上限的合法区间。 */
export const MAX_POOL = 9999;

// ── 取值助手 ─────────────────────────────────────────────────────────────────

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
