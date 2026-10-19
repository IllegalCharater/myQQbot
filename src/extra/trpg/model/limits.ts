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

// ── 剧本抽取（P7-a）───────────────────────────────────────────────────────────
//
// 这四个数全是**成本**，不是洁癖：一份模组按"每片一次模型调用"计费，而抽取发生在
// `.trpg scenario` 那条命令里 —— 群友正对着群等回执。改它们等于改行为（同
// `FALLBACK_RESERVE_MS` 那条纪律），所以写死在这里、集中一处。

/**
 * 一份模组最多切几片（= 最多几次 L2 抽取调用，另加 L3 那一次合并）。
 *
 * 撞上它就**不静默丢**：没进切片的字数记进 `DocOutline.droppedChars`，回执与
 * `.trpg check` 都要说。丢弃会让"抽出来的比原文少"这件事没有任何人知道。
 */
export const MAX_CHUNKS = 6;
/** 单片的最大字数。超长的小节会先按空行再切，切不动就硬切。 */
export const MAX_CHUNK_CHARS = 6000;
/**
 * 单片的目标下限：到了这个长度，遇到新的标题就收片。
 *
 * 它只影响**切在哪**，不影响切多少 —— 一份全是两行小标题的文档会因此被并成几大片，
 * 而不是变成几十个各含一句话的片（那样每一片都要单独一次调用）。
 */
export const MIN_CHUNK_CHARS = 400;
/**
 * 整条抽取管线的时间预算（毫秒）。**每一片都从同一条死线倒推**（同
 * `image-source` 那条"给兜底留位置"的纪律）：剩下的时间不够一次最小调用时，
 * 后面的片**不发**，只把已抽到的部分交出去并如实说明。
 *
 * 90 秒是既有 `formatScenarioText` 那 60 秒的 1.5 倍 —— 它已经是一次同步等待了，
 * 抽取只是把同一件事切成几发。异步化（队列 + 回流）是 P8 的事。
 */
export const EXTRACT_TOTAL_BUDGET_MS = 90_000;
/** 单次调用的上限。真正生效的是 `min(它, 剩余预算)`。 */
export const EXTRACT_CALL_TIMEOUT_MS = 45_000;
/** 剩余预算低于这个数就不再发下一片 —— 发了也多半是超时。 */
export const EXTRACT_MIN_CALL_MS = 5_000;

/** 剧情结构里每一类（场景 / 人物 / 线索 / 道具 / 机制）最多几条。 */
export const MAX_STRUCT_ITEMS = 24;
/** 结构里每个文本字段的字数上限（梗概、说明、态度、地点……）。 */
export const MAX_STRUCT_TEXT_CHARS = 200;
/**
 * 机制那条**引文**的字数上限。它比别的字段宽：引文要能在原文里逐字找得到（L4 的判据），
 * 截短了反而永远对不上。
 */
export const MAX_STRUCT_QUOTE_CHARS = 300;

// ── 分幕（P8，2026-10-19）────────────────────────────────────────────────────
//
// 幕的六个字段都是**每局只在换幕时变**的东西，所以它们不全量进提示词（只有当前幕的
// goal / 条件 / 下一幕名进，见 `render/model.ts`）。但上限仍然是成本：`keeperNotes`
// 会进 DM 的上下文，而 `.struct.json` 是抽取产物、可能被模型写得很长。

/** 一份剧本最多分几幕。超过的截掉并记待核项（同 `MAX_STRUCT_ITEMS` 的取舍）。 */
export const MAX_ACTS = 20;
/** 幕名 / 幕 id 的字数上限。 */
export const MAX_ACT_NAME_CHARS = 60;
/** 本幕目标的字数上限（DM 可见）。 */
export const MAX_ACT_GOAL_CHARS = 200;
/** 本幕**幕后信息**的字数上限（只给 DM，绝不进玩家可见文本）。 */
export const MAX_ACT_KEEPER_CHARS = 400;
/** 一幕最多关联几个场景。 */
export const MAX_ACT_SCENES = 24;

// ── 结局（P8-c）──────────────────────────────────────────────────────────────
//
// 与幕同一档成本：`readAloud` 只在收团那一刻随回执给模型（**不进提示词**），
// 而结局清单（名字 + 触发 + 奖励）**每轮都进** briefing，所以条数上限是成本。

/** 一份剧本最多几个结局。超过的截掉并记待核项（同 `MAX_ACTS`）。 */
export const MAX_ENDINGS = 8;
/** 结局名 / id 的字数上限。 */
export const MAX_ENDING_NAME_CHARS = 60;
/** 结局宣读文本的字数上限（只在 `action=end` 的回执里出现一次）。 */
export const MAX_ENDING_READ_ALOUD_CHARS = 600;
/** 奖励那句话的字数上限（进 briefing，每轮都印）。 */
export const MAX_ENDING_REWARDS_CHARS = 120;
/** 结局的幕后备注字数上限（只给 DM，且**不进任何提示词**）。 */
export const MAX_ENDING_KEEPER_CHARS = 400;

// ── 推进度（P8-b）────────────────────────────────────────────────────────────
//
// 三个阈值是**默认值**：规则扩展里的 `advancement_threshold` mechanic 可以按模组覆盖
// （见 `rules/rule-set.ts`）。写成常量而不是配置项的理由同 `EXTRACT_TOTAL_BUDGET_MS` ——
// 合适的值取决于"这一本模组的节奏"，而那本来就是模组自己的事。

/** 距上次变化超过这么多**轮**才提示。 */
export const ADVANCE_THRESHOLDS = { scene: 8, flag: 12, act: 20 } as const;
/** 同一个指标至少隔这么多轮才再提示一次（换指标可以立即落）。 */
export const ADVANCE_HINT_COOLDOWN = 5;
// ⚠️ 覆盖阈值的合法区间（1..99）**不在这里**：它由 `rules/rule-set.ts` 在编译期校验，
// 而 `rules/**` 不许 import 本文件（纯度闸门）。与 `MAX_MECHANICS` 住在那边是同一条理由。
/**
 * 一份 `struct.json` / `rule.json` 的**序列化字节上限**（读存档快照时用）。
 *
 * 快照会随存档一起进提示词，所以手改过的存档不能拿一个 10MB 的对象把每一轮撑爆。
 */
export const MAX_STRUCT_BYTES = 60_000;

// ── 调用闸门（2026-10-19 加）──────────────────────────────────────────────────
//
// ── 为什么跑团也需要一本账 ──
//
// 这是白名单群里**任何群友**都能敲的两条命令，而它们各自要发模型调用：`.trpg scenario`
// 一份模组最多 `MAX_CHUNKS + 1` = 7 次，`.rh` 每次 1 次（那次私密叙事）。其余重能力
// （搜图 / 转写 / 出图 / 联网搜索）早就各有一本 `SlidingWindowBudget`，只有跑团这一块
// **一个闸门都没有** —— 一个群友连敲十次 `.trpg scenario`，那就是七十次调用。
//
// ── 为什么是写死的常量、不是设置页上的旋钮 ──
//
// 与 `EXTRACT_TOTAL_BUDGET_MS` 同一取舍：这两个数的用途是**压住滥用**，不是"按用量调优"，
// 而配置项要多付三处钳制（`core/config.ts` / `save.js` / 面板表单）与一整套守护。它们的
// 推导也全在本文件里（`MAX_CHUNKS` 与"一次暗骰一次调用"），放在一起才看得出为什么是这个数。
//
// ⚠️ **`.trpg scenario` 那一档按"命令调用次数"记账，不按"实际发了几次模型调用"** ——
// 与 image-source 那条"命中缓存的重复查询也占额度"是同一个方向（偏保守）。代价是传一份
// 格式本来就对的 `.md`（0 次调用）也要占一格；换来的是判据不必等到下载与解字节之后才成立。
export const SCENARIO_BUDGET = { perChatPerHour: 5, perDay: 100 } as const;
/**
 * `.rh` 暗骰的私密叙事。
 *
 * 比上面宽得多，因为它是**玩的时候的常规动作**（一次暗骰就是一次判定），而每次只花一次调用；
 * 这一档要压的是"有人把它当聊天用"，不是限制正常游玩。
 */
export const SECRET_ROLL_BUDGET = { perChatPerHour: 30, perDay: 300 } as const;

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
