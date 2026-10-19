// 跑团扩展 · **规则扩展**（P7-c）：把剧本里那些超出基础规则表的特殊机制编译成判定。
//
// ── 它解决的是什么 ──
//
// 基础规则表（`coc7.json` / `generic.json`）只管"掷什么骰、多少算成功、怎么建卡"。而真实模组
// 里到处都是**那一本自己的规矩**：「灯塔的浓雾里所有侦察类检定 -20」「守夜人不吃普通伤害」。
// 今天这些只写在正文散文里，DM 每轮现读现猜 —— 猜错的代价是它按错规则跑，而**没有人会立刻
// 发现**（群里看到的只是一段叙事）。
//
// 所以这里做的是：把那些机制编译成**能参与判定的**运行期规则集。数据来自 `<id>.rule.json`
// （抽取管线产出的草稿，或管理员手写的），编译成闭包，由三个工具与四条命令路的钩子消费。
//
// ── 三个边界，改动时别拆散 ──
//
// ① **handler 只有五个，一个都不自动改状态**：`bonus_to_check` / `penalty_to_check`（改检定
//    目标值）、`force_outcome`（强制成功/失败）、`immune_to_damage`（挡伤害）、`narrate`
//    （只给 DM 一句提示）。**没有 `set_flag` / `damage` / `san_loss` 这类东西** —— 那会绕过
//    「状态归代码管、模型只能请求改动」这条最硬的分界：一个自动改 HP 的机制，群友在群里看不到
//    任何工具调用，而状态已经变了。
// ② **触发条件是原子谓词 + 三个组合子，不接受任意表达式**。`rules/condition.ts` 那套求值器
//    的七个变量全是骰子相关的（`total` / `target` / `count`…），表达不了"场景/旗标/角色"，
//    而为一门 JSON 再发明一套表达式语言是**多一份要维护、要校验、要解释的东西**。
// ③ **认不出的东西要么降级要么拒绝，绝不静默**：认不出的 `type` → 降级成 `narrative_hook`
//    并记进 `warnings`（它只是分类标签，丢了不影响判定）；认不出的 `handler` → **拒绝**
//    （它是"这条机制要做什么"，不认识它就没法诚实地应用它）。
//
// ── 为什么常量住在这里，而不是 `model/limits.ts` ──
//
// `scripts/check-layers.mjs` 有一条闸门：`rules/**` 的相对 import **不许离开该目录**（连
// `node:` 都不许，真熵源因此在 `entropy.ts` 由调用方注入）。所以 `MAX_MECHANICS` 这类上限
// 只能住在本文件里 —— 与 `model/limits.ts` 里那些是**两回事**：那些管"抽取时收多少"，
// 这个管"编译时收多少"。**别为了"统一"把它搬出去**，搬出去的那一刻闸门会红。
import type { CheckJudge } from './check.js';

// ── 机制类型（**分类标签**，不参与判定）────────────────────────────────────────

/**
 * 认得出的机制类型。**这是这份清单的权威位置**，消费者一律从这里 import。
 * `scenario/extract/schema.ts` 原先那份 `STRUCT_MECHANIC_TYPES` 已**删掉**（不是转手再导出：
 * 转导出会让下一个人以为那里仍是可以加类型的地方，而在那里加一个类型，本文件是不认识的 ——
 * 症状是"抽出来的机制一条都不生效"，没有任何报错）。
 *
 * 它只是一张分类表：判据全在 `effect.handler` 上。唯一的例外是 `narrative_hook` ——
 * 它的语义是"抽取时说不清，只当提示"，所以它**强制** `narrate`（见 `compileRuleSet`）。
 */
export const MECHANIC_TYPES = [
  'check_modifier', 'conditional_immunity', 'san_trigger', 'npc_trait',
  'location_effect', 'environmental_effect', 'item_effect', 'narrative_hook',
  // P8-b：这两条**不参与检定与伤害**，只影响"推进保证"（阈值覆盖 / 切幕策略）。
  // 它们照旧走 `narrate` handler，于是 `applyCheckModifiers` / `damageBlockers` 自然忽略它们。
  'advancement_threshold', 'stage_advance'
] as const;

export type MechanicType = (typeof MECHANIC_TYPES)[number];

const KNOWN_TYPES = new Set<string>(MECHANIC_TYPES);

export function isMechanicType(value: unknown): value is MechanicType {
  return KNOWN_TYPES.has(String(value ?? ''));
}

// ── 触发条件 ─────────────────────────────────────────────────────────────────

/**
 * 触发条件。**原子谓词四个 + 组合子三个**，没有别的。
 *
 * ⚠️ **刻意没有 `item`**（"谁拿着什么"）：战役状态里**根本没有物品栏**这件事
 * （`TrpgCharacter` 没有 inventory），加一个永远为假的 op 只会让抽取出来的机制静默失效。
 * "拿到了钥匙"本来就该写成一个**旗标** —— 那是这套状态里表达"发生过什么"的既有方式，
 * 多开一条更弱的路只会让同一件事有两种写法。
 *
 * 判定全是**去空白后的全等**，**不做子串匹配**：中文没有分词，`场景：灯塔` 用 `includes`
 * 会命中「灯塔的雾」那种误报，而误报的机制是"该触发的没触发、不该触发的触发了"，两边
 * 都没有任何线索。写条件的人和写场景名的人是同一个（都是 DM），对齐是他们的活。
 */
export type TriggerNode =
  | { op: 'scene'; value: string }
  | { op: 'flag'; key: string; value: string }
  | { op: 'actor'; value: string }
  | { op: 'skill'; value: string }
  | { op: 'all_of' | 'any_of' | 'none_of'; items: TriggerNode[] };

/**
 * op 的两张清单。**这是清单的权威位置** —— 提示词（`extra/prompts.ts` 的 `extractChunk`）
 * 与错误文案都念它，而 `extra/prompts.ts` 必须零 import，所以由 `pipeline.ts` 递进去。
 *
 * 分成原子与组合子两份而不是一份：`coerceTrigger` 要按这个分法走两条不同的路（原子吃
 * `value`、组合子吃 `items`），而**加一个 op 只该改一处** —— 合成一份清单的话，
 * 那一处改动还要记得同步改这个分法。
 */
export const TRIGGER_ATOMS = ['scene', 'flag', 'actor', 'skill'] as const;
export const TRIGGER_COMBINATORS = ['all_of', 'any_of', 'none_of'] as const;
/** 全部 op（原子在前）。提示词里照这个顺序念。 */
export const TRIGGER_OPS: readonly string[] = [...TRIGGER_ATOMS, ...TRIGGER_COMBINATORS];

/**
 * 机制求值用的那一份局面。
 *
 * 它是**纯数据**，由调用方（P7-d 的 `mechanicContextOf`）从战役快照里现算 —— 规则层不认识
 * `TrpgCampaign`，那是 `model/` 的东西。
 */
export interface MechanicContext {
  /** 当前场景（`campaign.scene`）。 */
  scene: string;
  /** 全部旗标的名字 → 值（**含暗线的**：机制可以挂在暗线上，那是 DM 自己的数据）。 */
  flags: Readonly<Record<string, string>>;
  /** 正在行动的角色名（检定/改卡时的那个）。没有就传空串。 */
  actor: string;
  /** 正在用的技能名。没有就传空串。 */
  skill: string;
}

// ── handler ─────────────────────────────────────────────────────────────────

/**
 * 五个 handler。**收窄是有意的** —— 见文件头第 ① 条。
 *
 * `force_outcome` 接的是 `resolveCheck` 的 `judge` 选项（那是**现成**的钩子：传了它就完全
 * 绕过等级表，见 `check.ts` 的注释）—— 所以"剧本规定这一枪必中"不需要改判定引擎一行。
 */
export const EFFECT_HANDLERS = [
  'bonus_to_check', 'penalty_to_check', 'force_outcome', 'immune_to_damage', 'narrate'
] as const;

export type EffectHandler = (typeof EFFECT_HANDLERS)[number];

/**
 * **写死的互斥表**（决定 4）。
 *
 * 判据是**同一个触发条件下的 handler 指纹**：两条机制在同一个场景里一条要 +20、一条要 -20，
 * 那不是"两条都生效"，那是**一份自相矛盾的数据** —— 谁先谁后取决于声明顺序，而声明顺序对
 * 写它的人来说是偶然的。所以编译期就拒掉，让改的人去决定留哪一条。
 *
 * 四条细节：
 * - **对称**：`bonus` 列了 `penalty`，`penalty` 也列了 `bonus`（查一对就够，但两边都写，
 *   读的人不必自己推）。⚠️ **表与判据两处都必须是双向的**：下面 `compileRuleSet` 里那次查找
 *   同时看两个方向，而这里每一对也都写全 —— 只靠其中一处的话，改动任何一处都会把这条闸门
 *   **悄悄变回顺序相关**（`force_outcome` 那条曾经只有单向声明，于是"先写加值、后写必中"
 *   的那份 `rule.json` 编译得过）。那种回归不会有任何报错，表现只是"两条本该互斥的机制
 *   一起开了局"。
 * - **`force_outcome` 与自己互斥**：同一个条件下"必中"和"必败"不能共存，两条"必中"更是
 *   重复。
 * - **`immune_to_damage` / `narrate` 不与任何东西冲突**：免疫是同向的，叙事提示与判定
 *   并行不悖（一条机制既改检定、又给 DM 一句说明，是正常的写法）。
 * - 两条 `bonus_to_check` 在同一条件下**不互斥**，它们相加 —— 可预期，且"叠加两个加值"
 *   是规则书里常见的东西。
 */
const EFFECT_EXCLUSIONS: Readonly<Record<EffectHandler, readonly EffectHandler[]>> = {
  bonus_to_check: ['penalty_to_check', 'force_outcome'],
  penalty_to_check: ['bonus_to_check', 'force_outcome'],
  force_outcome: ['bonus_to_check', 'penalty_to_check', 'force_outcome'],
  immune_to_damage: [],
  narrate: []
};

// ── 形状 ─────────────────────────────────────────────────────────────────────

/**
 * 推进度的三个指标（P8-b）。
 *
 * ⚠️ 与 `types.ts` 的 `ADVANCEMENT_METRICS` **是两份**，而且只能两份：`rules/**` 的纯度闸门
 * 禁止它 import 本模块之外的任何东西（连 `node:` 都不许）。三条断言钉住两边逐字一致
 * （`t-trpg-rules`），所以漂移会当场红。
 */
export const ADVANCE_METRICS = ['scene', 'flag', 'act'] as const;
export type AdvanceMetric = (typeof ADVANCE_METRICS)[number];

/**
 * 一条"推进保证"指令（P8-b）。**只对 `advancement_threshold` / `stage_advance` 有效。**
 *
 * - `advancement_threshold` 要 `{ metric, turns }`：把某个指标的阈值覆盖成 `turns` 轮。
 * - `stage_advance` 要 `{ mode }`：当前幕的 `exitCondition` 成立时，是**只提示**（`hint`，缺省）
 *   还是**自动切幕**（`auto`）。
 *
 * ⚠️ **它不走 `effect.params`**：`narrate` 的 params 会被 `coerceEffect` **丢掉**
 * （"免疫与叙事提示不吃参数"），把阈值塞进去等于写进一个黑洞。所以它是机制自己的**字段**。
 */
export interface AdvanceDirective {
  metric?: AdvanceMetric;
  turns?: number;
  mode?: 'hint' | 'auto';
}

/** 一条**编译得过**的机制。 */
export interface RuleMechanic {
  type: MechanicType;
  /** 一句话说明（模型写的，≤60 字）。进 system prompt 与回执，见 `describeMechanic`。 */
  note: string;
  /** `null` = **无条件**（整局都算数）。只有 `narrate` 允许为 `null`，见 `compileRuleSet`。 */
  trigger: TriggerNode | null;
  effect: { handler: EffectHandler; params: Readonly<Record<string, unknown>> };
  /** 原文里逐字照抄的那几句（L4 拿它去原文里核对）。 */
  sourceQuote: string;
  /** 推进保证指令（只有 `advancement_threshold` / `stage_advance` 有）。见 `AdvanceDirective`。 */
  advance?: AdvanceDirective;
}

/**
 * 落盘草稿（`<id>.rule.json` 的形状）。**它还没有被验过** —— `compileRuleSet` 才是那道闸门。
 *
 * `trigger` / `effect` 在这里是 `unknown`，因为写它的是模型：字段**原样带过**，于是管理员在
 * 文件里看到的就是模型当初写的东西，出了问题改得动。这与 `check.ts` 的 `RuleFile`（输入）
 * 与 `CheckRule`（编译结果）是同一组关系。
 *
 * ⚠️ **这里没有 `warnings` 这一栏**（计划稿里那版有）：降级的账属于**剧本的抽取产物**
 * （`struct.json` 的 `warnings`，`.trpg check` 读的就是它）。写在规则文件里的话，同一个事实
 * 会有两处落点，而"哪一处才是真的"没人说得清 —— 何况手改过的文件本来就不会去维护它。
 */
export interface RuleDraftMechanic {
  type: string;
  note: string;
  trigger: unknown;
  effect: unknown;
  sourceQuote: string;
  /** 推进保证指令（P8-b）。收 `unknown`，唯一解释处是 `coerceAdvance`。 */
  advance?: unknown;
}

export interface RuleExtensionDraft {
  version: 1;
  mechanics: RuleDraftMechanic[];
}

/** 编译结果里的一条机制：`RuleMechanic` 加上判据闭包。 */
export interface RuntimeMechanic extends RuleMechanic {
  matches: (ctx: MechanicContext) => boolean;
}

export interface RuntimeRuleSet {
  mechanics: readonly RuntimeMechanic[];
  /** 降级与截断的账（认不出的 type、超过条数上限……）。**渲染与回执要如实说出去**。 */
  warnings: readonly string[];
}

/** 没有规则扩展时的那一份。**空集不是"没有规则"的同义词** —— 基础表照旧生效。 */
export const EMPTY_RULE_SET: RuntimeRuleSet = { mechanics: [], warnings: [] };

export type RuleSetLookup = { ok: true; set: RuntimeRuleSet } | { ok: false; problems: readonly string[] };

// ── 上限（住在 rules/ 里，见文件头最后一条）──────────────────────────────────

/** 编译进来的机制条数上限。**它每一条都进 system prompt**，所以是成本不是洁癖。 */
const MAX_MECHANICS = 40;
/** 触发条件的嵌套层数上限。三层的组合子已经够表达"这一场且灯灭了且不是守夜人"。 */
const MAX_TRIGGER_DEPTH = 4;
/** `note` 的字符上限。它每轮进 system prompt，也进群友可见的回执。 */
const MAX_NOTE_CHARS = 60;
/**
 * 引文的**安全**上限（不是业务上限）。
 *
 * 业务上限是 `model/limits.ts` 的 `MAX_STRUCT_QUOTE_CHARS`（抽取时由 `mechanics.ts` 截），
 * 这里另写一个**更大的**数只为"别让一份 1MB 的引文进内存"。两个数不是同一个数，所以
 * 不存在"改一处忘一处"那种漂移 —— 这也正是 `rules/` 不许 import 出目录时该有的写法。
 */
const MAX_QUOTE_CHARS = 2000;
/** 检定加减值的允许区间。超出是数据错误（+200 的加值多半是笔误），所以**拒绝**而不是夹紧。 */
const MIN_CHECK_MODIFIER = 1;
const MAX_CHECK_MODIFIER = 100;

// ── 取值助手 ─────────────────────────────────────────────────────────────────

function trimmed(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, max);
}

/** 认得出的一栏：`{ handler, params }`。 */
type Effect = { handler: EffectHandler; params: Record<string, unknown> };

const HANDLER_SET = new Set<string>(EFFECT_HANDLERS);

function isHandler(value: unknown): value is EffectHandler {
  return HANDLER_SET.has(String(value ?? ''));
}

function intIn(value: unknown, min: number, max: number): number | null {
  // 模型偶尔把数字写成字符串（`"20"`）—— 收下它，但**别的一律不收**：`true` / `"abc"` /
  // 数组都说明这一栏写的不是数，那正该拒绝。
  const num = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof num !== 'number' || !Number.isFinite(num)) return null;
  if (!Number.isInteger(num) || num < min || num > max) return null;
  return num;
}

// ── 编译：trigger ────────────────────────────────────────────────────────────

type TriggerCoercion = { ok: true; node: TriggerNode } | { ok: false; reason: string };

/**
 * 吃 `value` 的原子谓词。**从 `TRIGGER_ATOMS` 派生**，只排掉 `flag` 一个 —— 它另走一条路
 * （还要 `key`），所以不需要第三份"哪些 op 吃 value"的清单。
 */
const VALUE_OPS = new Set<string>(TRIGGER_ATOMS.filter((op) => op !== 'flag'));
const COMBINATOR_OPS = new Set<string>(TRIGGER_COMBINATORS);

function coerceTrigger(raw: unknown, depth = 0): TriggerCoercion {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'trigger 要写成一个对象（例如 {"op":"scene","value":"灯塔"}）' };
  }
  if (depth >= MAX_TRIGGER_DEPTH) {
    return { ok: false, reason: `trigger 嵌套太深了（最多 ${MAX_TRIGGER_DEPTH} 层）` };
  }
  const source = raw as Record<string, unknown>;
  const op = String(source.op ?? '');

  // ⚠️ `flag` **必须排在原子那条之前**：它比别的原子多要一个 `key`，而两者都取自
  // `TRIGGER_ATOMS`。顺序反了的话它会落进"只要求 value"那条路，于是
  // `{"op":"flag","value":"是"}` 被当成合法 —— "是**哪个**旗标等于是"当场丢掉，
  // 而那条机制此后**永远不触发**，没有任何报错。
  if (op === 'flag') {
    const key = trimmed(source.key, 80);
    if (!key) return { ok: false, reason: 'trigger 的 op 是「flag」，就得写 key' };
    // ⚠️ `value` 是**必填**的。"旗标存在"与"旗标为真"是两件事，而 `{"op":"flag","key":"灯灭了"}`
    // 到底是哪一件，读的人推不出来 —— 留这种含糊，症状是"机制该触发时没触发"，而写它的人
    // 完全不知道差在哪。要判真假就把值写出来（`"value":"是"`）。
    const value = trimmed(source.value, 80);
    if (!value) return { ok: false, reason: 'trigger 的 flag 要同时写 key 与 value（"这个旗标等于什么"）' };
    return { ok: true, node: { op: 'flag', key, value } };
  }
  if (VALUE_OPS.has(op)) {
    const value = trimmed(source.value, 80);
    if (!value) return { ok: false, reason: `trigger 的 op 是「${op}」，就得写 value` };
    return { ok: true, node: { op: op as 'scene' | 'actor' | 'skill', value } };
  }
  if (COMBINATOR_OPS.has(op)) {
    if (!Array.isArray(source.items) || !source.items.length) {
      return { ok: false, reason: `trigger 的 op 是「${op}」，就得写一个非空的 items 数组` };
    }
    const items: TriggerNode[] = [];
    for (const item of source.items) {
      const made = coerceTrigger(item, depth + 1);
      if (!made.ok) return made;
      items.push(made.node);
    }
    return { ok: true, node: { op: op as 'all_of' | 'any_of' | 'none_of', items } };
  }
  return {
    ok: false,
    reason: `trigger 的 op 写的是「${op}」，我不认识（只有 ${TRIGGER_OPS.join(' / ')}）`
  };
}

// ── 编译：effect ─────────────────────────────────────────────────────────────

type EffectCoercion = { ok: true; effect: Effect } | { ok: false; reason: string };

function coerceEffect(raw: unknown): EffectCoercion {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'effect 要写成一个对象（{"handler":"…","params":{…}}）' };
  }
  const source = raw as Record<string, unknown>;
  const handler = source.handler;
  if (!isHandler(handler)) {
    return {
      ok: false,
      reason: `effect.handler 写的是「${String(handler ?? '（空）')}」，我不认识它`
        + `（只有 ${EFFECT_HANDLERS.join(' / ')}）`
    };
  }
  const rawParams = source.params;
  const params = rawParams && typeof rawParams === 'object' && !Array.isArray(rawParams)
    ? { ...(rawParams as Record<string, unknown>) } : {};

  if (handler === 'bonus_to_check' || handler === 'penalty_to_check') {
    // 两个都写**正数**，方向由 handler 决定 —— 允许写负数的话，"penalty + (-20)"是加值还是
    // 减值就要读代码才知道，而那种含糊没有任何报错。
    const value = intIn(params.value, MIN_CHECK_MODIFIER, MAX_CHECK_MODIFIER);
    if (value === null) {
      return {
        ok: false,
        reason: `${handler} 需要 params.value 是一个 ${MIN_CHECK_MODIFIER}–${MAX_CHECK_MODIFIER} 的整数`
          + `（两个 handler 都写正数，方向由 handler 决定）`
      };
    }
    return { ok: true, effect: { handler, params: { value } } };
  }
  if (handler === 'force_outcome') {
    const outcome = String(params.outcome ?? '');
    if (outcome !== 'success' && outcome !== 'failure') {
      return { ok: false, reason: 'force_outcome 需要 params.outcome 是 "success" 或 "failure"' };
    }
    const grade = trimmed(params.grade, 20) || 'forced';
    const label = trimmed(params.label, 20)
      || (outcome === 'success' ? '机制强制成功' : '机制强制失败');
    return { ok: true, effect: { handler, params: { outcome, grade, label } } };
  }
  // `immune_to_damage` / `narrate` 不吃参数：**多写的一律忽略**。为"模型顺手多写了一栏"整条
  // 拒绝不划算，而这两条的语义也不会因为多一栏而变。
  return { ok: true, effect: { handler, params: {} } };
}

// ── 触发条件的规范化与描述 ───────────────────────────────────────────────────

/**
 * 触发条件的**指纹**（互斥判据用它比"是不是同一个条件"）。
 *
 * 组合子的子节点**排序**后再拼：`all_of` / `any_of` / `none_of` 都是可交换的，所以
 * `all_of[场景A, 旗标B]` 与 `all_of[旗标B, 场景A]` 是同一个条件 —— 不排序的话，两条互斥的
 * 机制只要把子节点换个顺序就能双双通过编译，而那正是这张表要拦的东西。
 */
export function triggerKey(node: TriggerNode | null): string {
  if (!node) return '*';
  switch (node.op) {
    case 'scene': return `scene:${node.value}`;
    case 'flag': return `flag:${node.key}=${node.value}`;
    case 'actor': return `actor:${node.value}`;
    case 'skill': return `skill:${node.value}`;
    default: {
      const kids = node.items.map(triggerKey).sort();
      return `${node.op}(${kids.join('|')})`;
    }
  }
}

/** 触发条件的**人话**（进提示词与回执）。 */
export function describeTrigger(node: TriggerNode | null): string {
  if (!node) return '无条件';
  switch (node.op) {
    case 'scene': return `场景：${node.value}`;
    case 'flag': return `旗标：${node.key} = ${node.value}`;
    case 'actor': return `角色：${node.value}`;
    case 'skill': return `技能：${node.value}`;
    case 'all_of': return `（${node.items.map(describeTrigger).join(' 且 ')}）`;
    case 'any_of': return `（${node.items.map(describeTrigger).join(' 或 ')}）`;
    default: return `（${node.items.map((item) => `非 ${describeTrigger(item)}`).join(' 且 ')}）`;
  }
}

/**
 * 触发条件里提到了**哪些旗标名**（空数组 = 没提）。组合子递归进去，只收 `flag` 原子。
 *
 * ── 它为什么必须存在 ──
 *
 * `describeTrigger` 把 `{op:'flag'}` 印成 `旗标：真凶是医生 = 是`，而这句话会进
 * **`.ra` 的群回执**（`describeCheckModifiers` 在没有 `note` 时退到触发条件）。暗线旗标
 * （`visible: false`）的名字因此会当着全群的面印出来 —— 而 `render/players.ts` 那边为了
 * 不泄漏，连"一条全是问号的旗标"都不印。所以判据要能回答"这条机制的触发条件里，有没有
 * 玩家不该看到的名字"，而这个回答只能靠**走一遍触发树**（在拼好的那句人话上做字符串匹配
 * 是第二份判据，迟早与 `describeTrigger` 漂移）。
 *
 * 树的形状只有 `rules/rule-set.ts` 知道，所以它住在这里、与 `describeTrigger` 并排。
 */
export function triggerFlagNames(node: TriggerNode | null): string[] {
  if (!node) return [];
  switch (node.op) {
    case 'flag': return [node.key];
    case 'scene': case 'actor': case 'skill': return [];
    default: return node.items.flatMap((item) => triggerFlagNames(item));
  }
}

/**
 * 单独编译一条触发条件（**分幕的 entry / exit 用它**）。
 *
 * `undefined` / `null` = **无条件**（`node: null`）—— 与 `compileRuleSet` 里
 * "`narrate` 允许不写 trigger"同一条读法。
 *
 * ⚠️ **不新增第三套条件语法**：幕的进出条件就是机制 trigger 那一套（flag / all_of / …），
 * 判据在 `coerceTrigger` 一处。另写一份的话，"同一个旗标组合在机制里成立、在幕里不成立"
 * 这种分岔不会有任何报错。
 */
export type TriggerLookup = { ok: true; node: TriggerNode | null } | { ok: false; reason: string };

export function compileTrigger(raw: unknown): TriggerLookup {
  if (raw === undefined || raw === null) return { ok: true, node: null };
  const made = coerceTrigger(raw);
  return made.ok ? { ok: true, node: made.node } : { ok: false, reason: made.reason };
}

/**
 * 这条条件在**这个局面**下成不成立。`null` 节点 = **无条件成立**（同 `matcher`）。
 *
 * 求值器只有 `matcher` 一份 —— 幕的推进与机制的命中因此永远给同一个答案。
 */
export function triggerMatches(node: TriggerNode | null, ctx: MechanicContext): boolean {
  return matcher(node)(ctx);
}

/**
 * **条件还差什么**（`campaign action=advance` 的回执用它）。
 *
 * 返回**没被满足的那几条**的人话（`旗标「钥匙到手」= 是（现在是「否」）`）；全满足或无条件
 * 时返回空数组。三种组合子各有各的说法：
 * - `all_of`：逐条列（每一条都得满足）；
 * - `any_of`：只有**一条都不满足**时才算没满足，那时列出"任一满足即可"的那几句；
 * - `none_of`：只有**有子条件意外成立**时才算没满足。
 *
 * ⚠️ 它是 `triggerMatches` 的**解释版**，不是第二份判据：两者都依赖同一棵 `TriggerNode`，
 * 而"成不成立"的唯一答案永远来自 `matcher`。这里只负责在**不成立**时说出为什么。
 */
export function explainUnmet(node: TriggerNode | null, ctx: MechanicContext): string[] {
  if (!node) return [];
  switch (node.op) {
    case 'flag': {
      const actual = (ctx.flags[node.key] ?? '').trim();
      if (actual === node.value) return [];
      return [`旗标「${node.key}」= ${node.value}（现在是「${actual || '还没写'}」）`];
    }
    case 'scene':
      return ctx.scene.trim() === node.value ? [] : [`场景是「${node.value}」（现在是「${ctx.scene || '还没定'}」）`];
    case 'actor':
      return ctx.actor.trim() === node.value ? [] : [`行动者是「${node.value}」（现在是「${ctx.actor || '不知道'}」）`];
    case 'skill':
      return ctx.skill.trim() === node.value ? [] : [`技能是「${node.value}」（现在是「${ctx.skill || '不知道'}」）`];
    case 'all_of':
      return node.items.flatMap((item) => explainUnmet(item, ctx));
    case 'any_of': {
      const each = node.items.map((item) => explainUnmet(item, ctx));
      // **任一条满足就通过**（`some` 而不是 `every`：写成 `every` 的话，"一条满足、一条不满足"
      // 的 `any_of` 会被报成没满足 —— 而它明明是满足的）。
      if (each.some((list) => list.length === 0)) return [];
      return [`以下任一满足即可：${each.map((list) => list[0] ?? '').filter(Boolean).join(' 或 ')}`];
    }
    default: {
      // `none_of`：子条件里**有成立的**才算没满足
      const hit = node.items.find((item) => explainUnmet(item, ctx).length === 0);
      return hit ? [`不应该满足：${describeTrigger(hit)}`] : [];
    }
  }
}

/**
 * 一条机制的**一行说明**。
 *
 * 唯一拼法：提示词那一节（P7-e）与三条工具的回执都调它 —— 各拼一遍的话，"回执里说的"与
 * "提示词里说的"必然漂移，而那种不一致没有人会去核对。
 */
export function describeMechanic(mechanic: RuleMechanic): string {
  const where = describeTrigger(mechanic.trigger);
  return `${mechanic.note || where}（${mechanic.type} / ${where}）`;
}

// ── 编译 ─────────────────────────────────────────────────────────────────────

function matcher(node: TriggerNode | null): (ctx: MechanicContext) => boolean {
  if (!node) return () => true;
  switch (node.op) {
    case 'scene': {
      const want = node.value;
      return (ctx) => ctx.scene.trim() === want;
    }
    case 'flag': {
      const { key, value } = node;
      return (ctx) => (ctx.flags[key] ?? '').trim() === value;
    }
    case 'actor': {
      const want = node.value;
      return (ctx) => ctx.actor.trim() === want;
    }
    case 'skill': {
      const want = node.value;
      return (ctx) => ctx.skill.trim() === want;
    }
    default: {
      const kids = node.items.map(matcher);
      if (node.op === 'all_of') return (ctx) => kids.every((test) => test(ctx));
      if (node.op === 'any_of') return (ctx) => kids.some((test) => test(ctx));
      return (ctx) => kids.every((test) => !test(ctx));
    }
  }
}

/**
 * 把一份规则扩展（落盘草稿 / 人手改过的文件）编译成运行期规则集。
 *
 * **收 `unknown` 出类型** —— 与 `check.ts` 的 `compileRule` 同形，也是 `types.ts` 那个
 * `unknown` 字段的**唯一解释处**。
 *
 * 三档结局：
 * - `null` / `undefined` → 空集（**这是常态**：手写的剧本本来就没有规则扩展）。
 * - `{ ok: true }` → 编译好了，可能有 `warnings`（认不出的 type 降级、条数超限截断）。
 * - `{ ok: false, problems }` → **拒绝**。每一条都自报家门（第几条、错在哪），由 P7-f 拼成回执。
 */
/** 覆盖阈值的合法区间。住在 `rules/` 里是因为 `model/limits.ts` 进不来（纯度闸门）。 */
const MIN_ADVANCE_TURNS = 1;
const MAX_ADVANCE_TURNS = 99;

/**
 * 编译一条推进保证指令（P8-b）。
 *
 * 三档：不是那两种类型 → 不看（返回 `undefined`，调用方会记一条 warning）；是 → **坏就拒绝**
 * （阈值写错会让提示永远不发、或者每轮都发，而两种症状都像"这个功能没做"）。
 */
function coerceAdvance(
  type: MechanicType, raw: unknown
): { ok: true; value?: AdvanceDirective } | { ok: false; reason: string } {
  if (type !== 'advancement_threshold' && type !== 'stage_advance') {
    return { ok: true };
  }
  const source = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown> : {};
  if (type === 'advancement_threshold') {
    const metric = String(source.metric ?? '').trim();
    if (!(ADVANCE_METRICS as readonly string[]).includes(metric)) {
      return { ok: false, reason: `advancement_threshold 要写 advance.metric（${ADVANCE_METRICS.join(' / ')}）` };
    }
    const turns = intIn(source.turns, MIN_ADVANCE_TURNS, MAX_ADVANCE_TURNS);
    if (turns === null) {
      return {
        ok: false,
        reason: `advancement_threshold 的 advance.turns 要是 ${MIN_ADVANCE_TURNS}–${MAX_ADVANCE_TURNS} 的整数`
      };
    }
    return { ok: true, value: { metric: metric as AdvanceMetric, turns } };
  }
  const mode = String(source.mode ?? 'hint').trim();
  if (mode !== 'hint' && mode !== 'auto') {
    return { ok: false, reason: 'stage_advance 的 advance.mode 只能是 hint / auto' };
  }
  return { ok: true, value: { mode } };
}

export function compileRuleSet(raw: unknown): RuleSetLookup {
  if (raw === null || raw === undefined) return { ok: true, set: EMPTY_RULE_SET };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, problems: ['规则扩展的形状不对（应该是一个对象）'] };
  }
  const source = raw as Record<string, unknown>;
  if (source.version !== undefined && source.version !== 1) {
    return { ok: false, problems: [`规则扩展的版本是 ${String(source.version)}，这份代码只认 1`] };
  }
  const listed = source.mechanics;
  if (listed !== undefined && !Array.isArray(listed)) {
    return { ok: false, problems: ['规则扩展的 mechanics 要写成一个数组'] };
  }
  const entries = Array.isArray(listed) ? listed : [];
  const warnings: string[] = [];
  if (listed === undefined) {
    warnings.push('规则扩展里没有 mechanics 这一栏，按"这一局没有特殊规则"处理');
  }

  const problems: string[] = [];
  const mechanics: RuntimeMechanic[] = [];
  /** 指纹 → 已经收下的 `{ 序号, handler }`，用来查互斥。 */
  const byTrigger = new Map<string, Array<{ index: number; handler: EffectHandler }>>();

  entries.forEach((entry, at) => {
    const index = at + 1;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      problems.push(`第 ${index} 条机制不是一个对象`);
      return;
    }
    const item = entry as Record<string, unknown>;
    const note = trimmed(item.note, MAX_NOTE_CHARS);
    const sourceQuote = trimmed(item.sourceQuote, MAX_QUOTE_CHARS);

    // ── type：认不出就降级，不拒绝（它只是分类标签）──
    const rawType = trimmed(item.type, 40);
    let type: MechanicType;
    if (isMechanicType(rawType)) {
      type = rawType;
    } else {
      type = 'narrative_hook';
      warnings.push(`第 ${index} 条机制的 type「${rawType || '（空）'}」我不认识，已按纯叙事处理（不影响判定）`);
    }

    // ── trigger ──
    // 这三类**不要求 trigger**：叙事提示本来就可以无条件；阈值与切幕策略不是"什么条件下生效"，
    // 它们的语义在 `advance` 那一栏里。
    const triggerOptional = type === 'narrative_hook'
      || type === 'advancement_threshold' || type === 'stage_advance';
    let trigger: TriggerNode | null = null;
    if (item.trigger === undefined || item.trigger === null) {
      if (!triggerOptional) {
        problems.push(`第 ${index} 条机制（${type}）没写 trigger —— 无条件生效的判定会让每一次检定都受影响`);
        return;
      }
    } else {
      const made = coerceTrigger(item.trigger);
      if (!made.ok) {
        problems.push(`第 ${index} 条机制：${made.reason}`);
        return;
      }
      trigger = made.node;
    }

    // ── effect ──
    let effect: Effect;
    if (type === 'advancement_threshold' || type === 'stage_advance') {
      // 不参与检定与伤害：照旧挂 `narrate`，于是所有按 handler 过滤的消费点自然忽略它们。
      effect = { handler: 'narrate', params: {} };
    } else if (type === 'narrative_hook') {
      // `narrative_hook` 的语义就是"只当提示"，所以它**强制** narrate：写别的 handler 说明
      // 抽取时分类与判定对不上，那该说出来，而不是照着 handler 应用一条分类不明的规则。
      const made = coerceEffect(item.effect);
      if (made.ok && made.effect.handler !== 'narrate') {
        warnings.push(`第 ${index} 条机制是 narrative_hook，却写了 ${made.effect.handler} —— 已按纯叙事处理`);
      } else if (!made.ok && item.effect !== undefined && item.effect !== null) {
        warnings.push(`第 ${index} 条机制的 effect 看不懂（${made.reason}）—— 已按纯叙事处理`);
      }
      effect = { handler: 'narrate', params: {} };
    } else {
      const made = coerceEffect(item.effect);
      if (!made.ok) {
        problems.push(`第 ${index} 条机制：${made.reason}`);
        return;
      }
      effect = made.effect;
    }

    // ── 互斥（决定 4）──
    //
    // ⚠️ **两个方向都查**。只看 `EFFECT_EXCLUSIONS[other.handler]`（先出现的那一条那一行）会让
    // 这条闸门**顺序相关**：同一对机制，谁写在前面决定编译过不过，而声明顺序对写 `rule.json`
    // 的人来说是偶然的（抽取时是模型给的顺序）。表本身也写全了双向，两处都成立才算守住。
    const key = triggerKey(trigger);
    const seen = byTrigger.get(key) ?? [];
    const clash = seen.find((other) =>
      EFFECT_EXCLUSIONS[other.handler].includes(effect.handler)
      || EFFECT_EXCLUSIONS[effect.handler].includes(other.handler));
    if (clash) {
      problems.push(`第 ${clash.index} 条与第 ${index} 条的触发条件相同（${describeTrigger(trigger)}），`
        + `但一条是 ${clash.handler}、一条是 ${effect.handler} —— 两条不能同时生效，只能留一条`);
      return;
    }
    seen.push({ index, handler: effect.handler });
    byTrigger.set(key, seen);

    // ── 推进保证指令（P8-b）──
    const directive = coerceAdvance(type, item.advance);
    if (!directive.ok) {
      problems.push(`第 ${index} 条机制：${directive.reason}`);
      return;
    }
    if (!directive.value && item.advance !== undefined && item.advance !== null) {
      warnings.push(`第 ${index} 条机制的 advance 用不上（只有 advancement_threshold / stage_advance 认它），已忽略`);
    }

    if (mechanics.length >= MAX_MECHANICS) {
      warnings.push(`机制超过 ${MAX_MECHANICS} 条上限，第 ${index} 条起没进来`);
      return;
    }
    mechanics.push({
      type, note, trigger, effect, sourceQuote,
      ...(directive.value ? { advance: directive.value } : {}),
      matches: matcher(trigger)
    });
  });

  if (problems.length) return { ok: false, problems };
  return { ok: true, set: { mechanics, warnings } };
}

// ── 运行期取用 ───────────────────────────────────────────────────────────────

/** 这一份局面下**命中**的机制（按声明顺序 —— 顺序即缓存，声明顺序整局不变）。 */
export function activeMechanics(set: RuntimeRuleSet, ctx: MechanicContext): readonly RuntimeMechanic[] {
  return set.mechanics.filter((mechanic) => mechanic.matches(ctx));
}

export interface CheckModifiers {
  /** 改过之后的目标值。没有机制命中时**原样返回**。 */
  target: number;
  /** 命中 `force_outcome` 时给出的判定函数（`resolveCheck` 的 `judge`）。 */
  judge?: CheckJudge;
  /** 真的生效了的机制。 */
  applied: readonly RuntimeMechanic[];
  /**
   * 命中了、但被 `force_outcome` 盖住、**没有生效**的加减。
   *
   * 如实说出去而不是假装没发生：DM 手里那份状态与它以为的不一样时，"为什么 -20 没算"
   * 必须有个答案，否则它只会以为机制坏了。
   */
  overridden: readonly RuntimeMechanic[];
}

/**
 * 检定钩子（`roll` 与 `.ra` / `.rh` 那条路用）。
 *
 * 三条边界：
 * - **只作用于"有目标值的检定"**。裸 `rollDice`（`3d6` 那种）没有目标值，也就没有可加减的
 *   东西 —— 那是确定性分界，不是"忘了接"。
 * - **不夹紧结果**：`-20` 打在一个 10 的检定上得到 `-10`，那就是"这一枪不可能成"，是机制的
 *   正当表达。夹到 0 反而会把它变成一个"极小概率能成"的检定。
 * - **`force_outcome` 一命中，加减全部作废**（记进 `overridden`）。两条同时算的话，"必中"
 *   这句话就没有意义了。
 */
export function applyCheckModifiers(
  set: RuntimeRuleSet, ctx: MechanicContext, target: number
): CheckModifiers {
  const hits = activeMechanics(set, ctx);
  const forced = hits.find((mechanic) => mechanic.effect.handler === 'force_outcome');
  if (forced) {
    const outcome = String(forced.effect.params.outcome ?? '');
    const grade = String(forced.effect.params.grade ?? 'forced');
    const label = String(forced.effect.params.label ?? '');
    const judge: CheckJudge = () => ({
      success: outcome === 'success',
      grade,
      ...(label ? { label } : {})
    });
    return {
      target,
      judge,
      applied: [forced],
      overridden: hits.filter((mechanic) =>
        mechanic.effect.handler === 'bonus_to_check' || mechanic.effect.handler === 'penalty_to_check')
    };
  }

  const applied: RuntimeMechanic[] = [];
  let next = target;
  for (const mechanic of hits) {
    const { handler, params } = mechanic.effect;
    if (handler === 'bonus_to_check' || handler === 'penalty_to_check') {
      const value = Number(params.value ?? 0);
      next += handler === 'bonus_to_check' ? value : -value;
      applied.push(mechanic);
    }
  }
  return { target: next, applied, overridden: [] };
}

/**
 * 伤害钩子（`character` 的 `update` 带 `hpDelta < 0` 时用）。
 *
 * 返回**命中"免疫伤害"的机制**（空数组 = 不挡）。调用方拿它决定"拒绝这次改动并说明"——
 * 它是一个**闸门**，不是"自动把伤害改成 0"：状态怎么变仍由工具那一条路写。
 */
export function damageBlockers(set: RuntimeRuleSet, ctx: MechanicContext): readonly RuntimeMechanic[] {
  return activeMechanics(set, ctx).filter((mechanic) => mechanic.effect.handler === 'immune_to_damage');
}
