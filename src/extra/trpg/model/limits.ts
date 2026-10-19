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
// 下面这三个数是**成本**，不是洁癖：一份模组按"每片一次模型调用"计费，而抽取发生在
// `.trpg scenario` 那条命令里 —— 群友正对着群等回执。改它们等于改行为（同
// `FALLBACK_RESERVE_MS` 那条纪律），所以写死在这里、集中一处。
//
// ⚠️ **紧跟其后的那两个预算数是这条规矩的例外**（2026-10-19 起）：它们进了设置页，因为
// "这台机器上的模型有多快"是用户比我清楚的事。切片的形状（几个数）则仍然是我们的判据 ——
// 见下面那一段。

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
 * 整条抽取管线的时间预算（毫秒）—— **默认值**，可被配置 `trpg.extractTotalBudgetMs` 覆盖。
 *
 * 它是**整条管线**的死线（不是单次调用）：每一片都从它倒推（同 `image-source` 那条
 * "给兜底留位置"的纪律），剩下的时间不够一次最小调用时，后面的片**不发**，
 * 只把已抽到的部分交出去并如实说明。
 *
 * ⚠️ **90 秒这个数曾把整条管线送进必败**（2026-10-19 真机实测）：一份 7345 字的模组切成
 * 2 片，每片实测约 44 秒，两片吃掉约 88 秒 —— 于是 L3（合成剧本文件，**唯一的交付物**）
 * 只分到 2 秒，超时、整轮报废、退回一次格式整理。而"90 秒"当初的算法是
 * "既有 `formatScenarioText` 那 60 秒的 1.5 倍"，即**按一次调用**估的 ——
 * 可它要装的是 1 次归并 + 最多 `MAX_CHUNKS` 次分片抽取，也就是 7 次调用。
 * 现在的数是按**实测单次耗时**倒推的：每次上限 60 秒，L2 那几片最多用掉
 * `总预算 - 单次上限`，剩下的整整 60 秒留给 L3。
 *
 * ── 为什么这两个数 2026-10-19 起进了设置页（推翻了"写死常量"那一版）──
 *
 * 合适的值取决于**这台机器上的模型有多快**：实测单次 44 秒的那台，5 分钟刚好够两片加一次
 * 合成；换一个更慢的端点、或一份更长的模组，同一个数就不够了。而这正是
 * `webSearch.fetchTextMaxChars` 当初变成配置项的同一条理由（"合适的值取决于用户怎么用"）。
 *
 * ⚠️ **只有这两个是旋钮**。`EXTRACT_L2_BUDGET_MS` 是派生量（见下），`EXTRACT_MIN_CALL_MS`
 * 是"再发也是白等"的判据 —— 两者都不该让用户调，调了只会造出"L3 分不到一整次调用"这种
 * 从表面上看不出来的坏配置（症状是抽取偶发失败，与"模型今天有点慢"长得一模一样）。
 */
export const EXTRACT_TOTAL_BUDGET_MS = 300_000;
/** 单次调用的上限（默认值，可被配置 `trpg.extractCallTimeoutMs` 覆盖）。真正生效的是 `min(它, 剩余预算)`。 */
export const EXTRACT_CALL_TIMEOUT_MS = 60_000;
/**
 * L2（逐片抽取）那一段的子预算 —— **派生量，不是第二个旋钮**。
 *
 * 它存在的唯一理由是"**L3 永远分得到一整次调用**"：分片是可选的（少抽一片只是少一点细节，
 * 而且会如实说出来），而 L3 是**唯一的交付物** —— 它失败就等于整轮白跑。所以 L2 在
 * `总预算 - 单次上限` 处就收手，把最后那一整次调用原样留给 L3。
 *
 * ⚠️ **运行期算的是 `budget.totalMs - budget.callMs`，不是这个常量**（见 `pipeline.ts`）：
 * 用户拧了那两个旋钮之后，只有这条减法跟着走，L3 才照样分得到一整次调用。这个常量只是
 * **默认预算下**的那一份 —— 留着是因为套件拿它拨假钟（`t-trpg-extract.mjs`）。
 *
 * 别把它写成另一个可独立调的数：它一旦不等于 `总预算 - 单次上限`，上面那句话就不成立了
 * （L2 用满时 L3 会分到不足一整次调用，而那正是这一版要修的病）。
 */
export const EXTRACT_L2_BUDGET_MS = EXTRACT_TOTAL_BUDGET_MS - EXTRACT_CALL_TIMEOUT_MS;
/** 剩余预算低于这个数就不再发下一片 —— 发了也多半是超时。 */
export const EXTRACT_MIN_CALL_MS = 5_000;
/**
 * 两个旋钮的钳制区间。
 *
 * **设置页侧另有一份同口径的钳制**（`ui/js/views/settings/save.js` 的 `sec === 'trpg'`
 * 那一段），两处必须一起改 —— 漂移的表现是"我填了 300 秒却按别的数走"，没人会去比两边源码
 * （同 `media/image-gen/config.ts` 那条"钳制只在这一处 + 设置页侧一份"的取舍）。
 */
export const EXTRACT_TOTAL_MIN_MS = 60_000;
export const EXTRACT_TOTAL_MAX_MS = 1_800_000;
export const EXTRACT_CALL_MAX_MS = 120_000;
/**
 * 一次抽取要用的两个数（毫秒）。
 *
 * ⚠️ **`callMs` 不是"L2 的子预算"**：子预算永远是 `totalMs - callMs`（见
 * `EXTRACT_L2_BUDGET_MS`）。三个数都当旋钮，就等于允许"L2 用满时 L3 分不到一整次调用"
 * 这种坏配置 —— 而它的症状（抽取偶发失败）与"模型今天有点慢"长得一模一样。
 */
export interface ExtractBudget {
  totalMs: number;
  callMs: number;
}

/** 没配任何东西时用的那一份（= 上面两个默认常量）。 */
export const DEFAULT_EXTRACT_BUDGET: ExtractBudget = {
  totalMs: EXTRACT_TOTAL_BUDGET_MS,
  callMs: EXTRACT_CALL_TIMEOUT_MS
};

/**
 * 从配置里读出这一份预算。**纯函数**，不读全局（调用方把 `getConfig().trpg` 递进来）。
 *
 * 判据两条，**顺序不能反**：
 *   ① `totalMs` 先夹进 `[EXTRACT_TOTAL_MIN_MS, EXTRACT_TOTAL_MAX_MS]`；
 *   ② `callMs` 再夹进 `[EXTRACT_MIN_CALL_MS, min(EXTRACT_CALL_MAX_MS, totalMs - EXTRACT_MIN_CALL_MS)]`
 *      —— 上界跟着 `totalMs` 走，于是 `totalMs - callMs >= EXTRACT_MIN_CALL_MS` 恒成立，
 *      也就是"L2 至少发得出一发"。
 *
 * ⚠️ **回落值也要一起夹**（`Math.min(callMax, EXTRACT_CALL_TIMEOUT_MS)`）：没写这个键时
 * `clampInt` 原样返回回落值，而回落值 60 秒在 `totalMs` 被填成 1 分钟时会**大于**上界 55 秒
 * —— 那正是 ② 要保证的东西，漏掉它这条不变量就只对"用户两个键都填了"的情况成立。
 *
 * ⚠️ **入参是结构化类型，不是 `AppConfig`**：`model/` 这一层不认识 `core/`，连类型都不认识
 * （反向依赖闸门会拦）。所以它的形状是"给我两个 `unknown`，还你两个合法的数"。
 *
 * ⚠️ 手改配置留下的非数（`null` / `''`）会被 `clampInt` 夹到**下限**而不是回落默认值 ——
 * 这是本文件既有的语义（"手改过 config 一样的东西也不会绕过上限"），别在这里另开一套。
 */
export function resolveExtractBudget(
  raw: { extractTotalBudgetMs?: unknown; extractCallTimeoutMs?: unknown } | undefined
): ExtractBudget {
  const totalMs = clampInt(
    raw?.extractTotalBudgetMs, EXTRACT_TOTAL_MIN_MS, EXTRACT_TOTAL_MAX_MS, EXTRACT_TOTAL_BUDGET_MS
  );
  // ② 的上界：`totalMs` 那一档的下限 60 秒远大于 `2 × EXTRACT_MIN_CALL_MS`，所以它不会
  // 小于自己的下界（`totalMs - 5 秒 >= 55 秒 > 5 秒`）。两个数一起改时留意这一条。
  const callMax = Math.min(EXTRACT_CALL_MAX_MS, totalMs - EXTRACT_MIN_CALL_MS);
  const callMs = clampInt(
    raw?.extractCallTimeoutMs, EXTRACT_MIN_CALL_MS, callMax, Math.min(callMax, EXTRACT_CALL_TIMEOUT_MS)
  );
  return { totalMs, callMs };
}

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
// （见 `rules/rule-set.ts`）。写成常量而不是配置项的理由是"合适的值取决于**这一本模组的
// 节奏**"，而那本来就是模组自己的事 —— 它已经有一条**自己的**覆盖路径（就是上面那个
// mechanic，按模组写、跟着剧本走），不必再开一个全局旋钮：全局旋钮只能同时对所有模组生效，
// 而节奏恰好是逐模组不同的东西。（与 `EXTRACT_TOTAL_BUDGET_MS` 那条不同 —— 那一个是
// "这台机器有多快"，全局只可能有一个答案，所以它进了设置页。）

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
// 这两个数的用途是**压住滥用**，不是"按用量调优"：它们的判据是"一个群友连敲十次会怎样"，
// 而不是"这台机器能跑多快"。与抽取预算那两个旋钮的区别正在这里 —— 那两个的合适值取决于
// 用户的机器与模型（他比我清楚），这两个的合适值取决于"白名单群里任何人"这个事实（判据
// 在我们这边）。它们的推导也全在本文件里（`MAX_CHUNKS` 与"一次暗骰一次调用"），放在一起
// 才看得出为什么是这个数。
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
