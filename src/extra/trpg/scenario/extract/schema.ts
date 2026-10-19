// 跑团扩展 · 抽取管线的**产物形状与校验**（L4 的一半）。
//
// ── 唯一解释处 ──
//
// `TrpgScenarioRef.struct` 在 `types.ts` 里声明成 `unknown`（那个文件不许 import 本模块的
// 任何东西，见它自己的文件头）。**这里就是那个 `unknown` 的唯一解释处** —— 收 `unknown` 出类型，
// 与 `rules/check.ts` 的 `compileRule` 同形。别在别处再写一份"这个对象长什么样"：
// 两份定义必然漂移，而漂移的表现是"抽的时候按 A 写、读的时候按 B 读"，两边都不报错。
//
// ── 读路径要比写路径宽 ──
//
// 这个文件可能是**人手改过的**（`.trpg check` 的回执就教人这么干）。所以 `coerceStruct` 不抛错、
// 不整体拒绝：认得出来的字段照收，认不出来的丢进 `warnings`。**整体拒绝**留给"根本不是对象"
// 那一档 —— 那种情况没有任何可救的内容，假装有才是真的坏。
import {
  MAX_ACT_GOAL_CHARS, MAX_ACT_KEEPER_CHARS, MAX_ACT_NAME_CHARS, MAX_ACT_SCENES, MAX_ACTS,
  MAX_ENDING_KEEPER_CHARS, MAX_ENDING_NAME_CHARS, MAX_ENDING_READ_ALOUD_CHARS,
  MAX_ENDING_REWARDS_CHARS, MAX_ENDINGS,
  MAX_STRUCT_ITEMS, MAX_STRUCT_QUOTE_CHARS, MAX_STRUCT_TEXT_CHARS, text
} from '../../model/limits.js';
import { compileTrigger, type TriggerNode } from '../../rules/rule-set.js';

export interface StructScene { name: string; summary: string; npcs: string[]; clues: string[] }
export interface StructNpc { name: string; summary: string; attitude: string; location: string; discovered: boolean }
export interface StructClue { text: string; visible: boolean; location: string }
export interface StructItem { name: string; summary: string; location: string }

/**
 * 剧本里的**一幕**（P8）。
 *
 * ── 为什么场景用**名字**引用 ──
 *
 * `StructScene` 只有 `name`、没有 id（它是抽取产物，模型按名字去重）。给 scene 加 id 会
 * 牵动 `coerceStruct` / `mergeStructs` / `describeStruct` / `.trpg check` 四处，而名字本来
 * 就是合并时的去重键 —— 所以幕用名字引用，匹配时做一次归一化（见 `scenario/acts.ts`）。
 *
 * ── 两个条件的类型是**编译后的节点**，不是原始 JSON ──
 *
 * `entryCondition` / `exitCondition` 在 `coerceAct` 里就编译好（`compileTrigger`），坏条件
 * **当场丢掉并记待核项**。这样运行期（换场景时）不必再编译一次，也不会在两处各判一遍语法。
 * 条件语言与机制 trigger 同一套：`flag` / `all_of` / `any_of` / `none_of`（没有第二份 DSL）。
 *
 * ⚠️ **`keeperNotes` 只给 DM**：它会被 `renderForModel` 印进模型的状态段，
 * **绝不进 `renderForPlayers`、`.trpg status` 或 `.trpg check`**。`visible` 是另一件事
 * （玩家能不能看到"第几幕"），两者别混。
 */
export interface StructAct {
  /** 稳定标识（同一份剧本内唯一）。抽取没给时用 `name`。 */
  id: string;
  name: string;
  /** 幕序，从 1 起。**数组顺序才是权威**（`normalizeActs` 按它排序），`order` 只用于展示。 */
  order: number;
  /** 本幕目标（DM 可见）。 */
  goal: string;
  /** 幕后信息（**仅 DM**）。 */
  keeperNotes: string;
  entryCondition: TriggerNode | null;
  exitCondition: TriggerNode | null;
  /** 本幕包含的场景**名**（= `StructScene.name`）。 */
  scenes: string[];
  /** 玩家能不能看到"第几幕"。`false` = 暗线幕：玩家视角整段不出现。 */
  visible: boolean;
}

/**
 * 一条**原文里的特殊机制**（还没编译成判定 —— 那是 `rules/rule-set.ts` 的活）。
 *
 * `triggerText` / `effectText` 是模型用自己的话说的一遍，`sourceQuote` 是**原文里的那几句**：
 * 它是唯一能被人核对的东西（L4 会查它在原文里逐字找不找得到）。**没有引文的机制等于无法核对**，
 * 所以它虽允许为空，却一定会进 `warnings`。
 *
 * ⚠️ `trigger` / `effect` 是**受控语法**那一份（P7-c）：`rules/rule-set.ts` 的 `TriggerNode`
 * 与 `{ handler, params }`。在这里声明成 `unknown` 是**有意的** —— 判据只有一份，在
 * `compileRuleSet` 里（它收 `unknown` 出类型）。在这个文件里再收一遍等于同一个语法有两份
 * 定义，而两份必然漂移：漂移的表现是"抽的时候按 A 写、编译的时候按 B 读"，两边都不报错。
 *
 * 认不出的 `type` 在 `compileRuleSet` 里降级成 `narrative_hook`，那一条**也会记进
 * `struct.warnings`**（L4 把编译结果转抄过来）—— 所以 `.trpg check` 照旧看得到。
 */
export interface StructMechanic {
  type: string;
  triggerText: string;
  effectText: string;
  note: string;
  sourceQuote: string;
  trigger?: unknown;
  effect?: unknown;
}

/**
 * 剧本里的一个**结局**（P8-c）。
 *
 * - `trigger` 与幕的进出条件、机制的 trigger 是**同一套语法与求值器**（`TriggerNode`），
 *   在 `coerceEnding` 里就编译好：坏条件当场丢掉并记待核项，运行期不再判语法。
 * - `readAloud` 是**收团那一刻**念给玩家听的那一段。它**不进提示词**（只在 `action=end`
 *   的回执里出现一次），所以给得比 briefing 里的东西宽松。
 * - `rewards` 是**一句人话**（`SAN +1D6`），代码**不结算** —— 收团后人物卡就删了。
 * - `keeperNotes` 只给 DM，**不进任何提示词**（连 `action=end` 的回执都不带）。
 */
export interface StructEnding {
  id: string;
  name: string;
  trigger: TriggerNode | null;
  readAloud: string;
  rewards: string;
  keeperNotes: string;
}

export interface ScenarioStruct {
  summary: string;
  scenes: StructScene[];
  npcs: StructNpc[];
  clues: StructClue[];
  items: StructItem[];
  mechanics: StructMechanic[];
  /**
   * 分幕（P8）。**旧 `.struct.json` 没有这一栏 → `[]`**，于是那一局走单幕模式
   * （`currentAct === ''`），不报错、不阻断任何既有玩法。
   */
  acts: StructAct[];
  /** 结局（P8-c）。旧 `.struct.json` 没有这一栏 → `[]`（自由结局仍然可用）。 */
  endings: StructEnding[];
  /** 待核项：引文在原文里找不到、超限被裁、认不出的字段…… `.trpg check` 逐条列出来。 */
  warnings: string[];
}

export type StructLookup = { ok: true; struct: ScenarioStruct } | { ok: false; message: string };

/**
 * ⚠️ **机制类型的清单不在这里**（P7-c 起）：它在 `rules/rule-set.ts` 的 `MECHANIC_TYPES`，
 * 消费者直接从那里 import。
 *
 * 原先这里有一份 `STRUCT_MECHANIC_TYPES`，注释写着"权威位置会挪走、**挪的时候别留副本**"。
 * 挪的办法就是**删掉它**而不是转手再导出一次：转导出看着无害，但它会让下一个人以为这里
 * 仍然是那个可以加类型的地方 —— 而在那里加一个类型，`compileRuleSet` 是不认识的，
 * 症状是"抽出来的机制一条都不生效"，没有任何报错。
 */
export function emptyStruct(): ScenarioStruct {
  return { summary: '', scenes: [], npcs: [], clues: [], items: [], mechanics: [], acts: [], endings: [], warnings: [] };
}

// ── 取值助手 ──

function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function field(source: Record<string, unknown>, key: string, max = MAX_STRUCT_TEXT_CHARS): string {
  return text(source[key], max);
}

/** 字符串数组：去空、去重、按上限截断。 */
function stringList(value: unknown, limit: number): string[] {
  const out: string[] = [];
  for (const item of asList(value)) {
    const line = text(item, MAX_STRUCT_TEXT_CHARS);
    if (!line || out.includes(line)) continue;
    if (out.length >= limit) break;
    out.push(line);
  }
  return out;
}

/**
 * 收一类条目，两个方向都记进 `warnings`。
 *
 * ⚠️ **"缺字段"与"超上限"要分开说**：前者是抽取质量问题（该重传或该手改），后者是我们
 * 自己的成本上限（内容在 `raw/` 里还在）。合成一句的话，看回执的人分不出该去改什么。
 */
function takeItems<T>(
  raw: unknown, limit: number, label: string, warnings: string[],
  /**
   * `warnings` 也递进去：`coerceAct` 要把"某一幕的条件写坏了"记成待核项 —— 那是**这一条**
   * 的问题，不是整份结构的，所以它比 `takeItems` 自己那句"有 N 条缺名字"更具体。
   */
  coerce: (item: Record<string, unknown>, warnings: string[]) => T | null
): T[] {
  const out: T[] = [];
  let bad = 0;
  let over = 0;
  for (const item of asList(raw)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      bad += 1;
      continue;
    }
    const made = coerce(item as Record<string, unknown>, warnings);
    if (!made) {
      bad += 1;
      continue;
    }
    if (out.length >= limit) {
      over += 1;
      continue;
    }
    out.push(made);
  }
  if (bad) warnings.push(`${label}里有 ${bad} 条缺名字或内容，已经丢掉`);
  if (over) warnings.push(`${label}超过 ${limit} 条上限，后面的 ${over} 条没进来`);
  return out;
}

function coerceScene(source: Record<string, unknown>): StructScene | null {
  const name = field(source, 'name');
  const summary = field(source, 'summary');
  if (!name && !summary) return null;
  return {
    name,
    summary,
    npcs: stringList(source.npcs, MAX_STRUCT_ITEMS),
    clues: stringList(source.clues, MAX_STRUCT_ITEMS)
  };
}

function coerceNpc(source: Record<string, unknown>): StructNpc | null {
  const name = field(source, 'name');
  if (!name) return null;
  return {
    name,
    summary: field(source, 'summary'),
    attitude: field(source, 'attitude'),
    location: field(source, 'location'),
    // 缺省**可见**：抽取时默认不藏东西，藏是 DM 自己的显式动作（同 `normalizeFlag` 那条取舍）。
    discovered: source.discovered !== false
  };
}

function coerceClue(source: Record<string, unknown>): StructClue | null {
  const body = field(source, 'text');
  if (!body) return null;
  return { text: body, visible: source.visible !== false, location: field(source, 'location') };
}

function coerceItem(source: Record<string, unknown>): StructItem | null {
  const name = field(source, 'name');
  if (!name) return null;
  return { name, summary: field(source, 'summary'), location: field(source, 'location') };
}

function coerceMechanic(source: Record<string, unknown>): StructMechanic | null {
  const type = field(source, 'type', 40);
  if (!type) return null;
  return {
    type,
    triggerText: field(source, 'triggerText'),
    effectText: field(source, 'effectText'),
    note: field(source, 'note'),
    // 引文比别的字段宽：它要能在原文里逐字找得到，截短了反而永远对不上。
    sourceQuote: field(source, 'sourceQuote', MAX_STRUCT_QUOTE_CHARS),
    // 结构化那两栏**原样带过**，一个字都不动：它们是 `rules/rule-set.ts` 的地盘，
    // 在这里"顺手规范一下"就是那份语法的第二份定义。
    ...(source.trigger === undefined ? {} : { trigger: source.trigger }),
    ...(source.effect === undefined ? {} : { effect: source.effect })
  };
}

/** 驼峰与蛇形都收：模型可能照文档写成 `keeper_notes`，而 `.struct.json` 现有键全是驼峰。 */
function pick(source: Record<string, unknown>, camel: string, snake: string): unknown {
  return source[camel] !== undefined ? source[camel] : source[snake];
}

function coerceAct(source: Record<string, unknown>, warnings: string[]): StructAct | null {
  const name = field(source, 'name', MAX_ACT_NAME_CHARS);
  if (!name) return null;
  const id = field(source, 'id', MAX_ACT_NAME_CHARS) || name;
  // ⚠️ **条件在这里就编译**：坏条件当场丢掉并记待核项，运行期（换场景时）不必再判一次语法，
  // 也不会出现"抽取时说能编译、推进时说不能"这种两边各判一遍的分岔。
  const entry = compileTrigger(pick(source, 'entryCondition', 'entry_condition'));
  const exit = compileTrigger(pick(source, 'exitCondition', 'exit_condition'));
  if (!entry.ok) warnings.push(`幕「${name}」的进入条件写坏了：${entry.reason}（已按"无条件"处理）`);
  if (!exit.ok) warnings.push(`幕「${name}」的离开条件写坏了：${exit.reason}（已按"无条件"处理）`);
  return {
    id,
    name,
    order: Math.round(Number(source.order)) || 0,
    goal: field(source, 'goal', MAX_ACT_GOAL_CHARS),
    keeperNotes: text(pick(source, 'keeperNotes', 'keeper_notes'), MAX_ACT_KEEPER_CHARS),
    entryCondition: entry.ok ? entry.node : null,
    exitCondition: exit.ok ? exit.node : null,
    scenes: stringList(source.scenes, MAX_ACT_SCENES),
    visible: source.visible !== false
  };
}

/**
 * 幕的**去重与排序**。`order` 只是展示用的序号，**数组顺序才是权威**（与 `mergeStructs`
 * 的去重键、`campaign.log` 的 `seq` 同一条规矩）。
 *
 * 三种情况：全会写且不重复 → 按 `order` 排；**完全没写** → 按数组位置补 1..N，**不报警**
 * （模型漏写序号是小事，数组顺序已经说明了一切）；**部分写或重复** → 按数组顺序重编号
 * 并记一条待核项（那才是真的"这份表的人没想清楚"）。
 */
function coerceEnding(source: Record<string, unknown>, warnings: string[]): StructEnding | null {
  const name = field(source, 'name', MAX_ENDING_NAME_CHARS);
  if (!name) return null;
  const id = field(source, 'id', MAX_ENDING_NAME_CHARS) || name;
  // 条件在这里编译（同 `coerceAct`）：坏条件当场丢掉并记待核项，运行期不再判语法。
  const made = compileTrigger(source.trigger);
  if (!made.ok) {
    warnings.push(`结局「${name}」的触发条件写坏了：${made.reason}（已按"没有触发条件"处理）`);
  }
  return {
    id,
    name,
    trigger: made.ok ? made.node : null,
    readAloud: text(pick(source, 'readAloud', 'read_aloud'), MAX_ENDING_READ_ALOUD_CHARS),
    rewards: text(source.rewards, MAX_ENDING_REWARDS_CHARS),
    keeperNotes: text(pick(source, 'keeperNotes', 'keeper_notes'), MAX_ENDING_KEEPER_CHARS)
  };
}

/** 结局去重（按 id，后者丢掉并记待核项）。数组顺序即声明顺序。 */
function normalizeEndings(raw: StructEnding[], warnings: string[]): StructEnding[] {
  const out: StructEnding[] = [];
  const seen = new Set<string>();
  for (const ending of raw) {
    if (seen.has(ending.id)) {
      warnings.push(`结局 id「${ending.id}」重复，只保留第一条`);
      continue;
    }
    seen.add(ending.id);
    out.push(ending);
  }
  return out;
}

function normalizeActs(raw: StructAct[], warnings: string[]): StructAct[] {
  const out: StructAct[] = [];
  const seen = new Set<string>();
  for (const act of raw) {
    if (seen.has(act.id)) {
      warnings.push(`幕 id「${act.id}」重复，只保留第一条`);
      continue;
    }
    seen.add(act.id);
    out.push(act);
  }
  const positives = out.map((act) => act.order).filter((n) => n > 0);
  const duplicated = new Set(positives).size !== positives.length;
  const mixed = positives.length > 0 && positives.length < out.length;
  if (duplicated || mixed) warnings.push('幕的 order 有缺失或重复，已按数组顺序重新编号');
  if (duplicated || mixed || !positives.length) {
    out.forEach((act, index) => { act.order = index + 1; });
  } else {
    out.sort((a, b) => a.order - b.order);
  }
  return out;
}

/**
 * 把任意输入归一整份剧情结构。**形状根本不对时返回 `null`**（不是对象 / 是数组），
 * 其余一律"能收多少收多少"并把问题记进 `warnings`。
 */
export function coerceStruct(raw: unknown, warnings: string[]): ScenarioStruct | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  return {
    summary: field(source, 'summary', 600),
    scenes: takeItems(source.scenes, MAX_STRUCT_ITEMS, '场景', warnings, coerceScene),
    npcs: takeItems(source.npcs, MAX_STRUCT_ITEMS, '人物', warnings, coerceNpc),
    clues: takeItems(source.clues, MAX_STRUCT_ITEMS, '线索', warnings, coerceClue),
    items: takeItems(source.items, MAX_STRUCT_ITEMS, '道具', warnings, coerceItem),
    mechanics: takeItems(source.mechanics, MAX_STRUCT_ITEMS, '机制', warnings, coerceMechanic),
    // 旧 `.struct.json` 没有这一栏 → `[]` → 单幕模式（不报错、不阻断任何既有玩法）。
    acts: normalizeActs(takeItems(source.acts, MAX_ACTS, '幕', warnings, coerceAct), warnings),
    // 旧 `.struct.json` 没有这一栏 → `[]` → 只能"自由结局"（`action=end` 照常可用）。
    endings: normalizeEndings(takeItems(source.endings, MAX_ENDINGS, '结局', warnings, coerceEnding), warnings),
    warnings
  };
}

/**
 * 读一份**已经落盘的** `struct.json`（`store/scenario-store.ts` 交出来的就是 `JSON.parse` 的产物）。
 *
 * 与 `coerceStruct` 的差别只有一处：**文件里存着的那份 `warnings` 要接着用**。L4 的判据
 * （引文对不对得上、类型认不认识）是在抽取那一刻算的，重读时原文早就不在手边了 ——
 * 丢掉它等于"核对过一次的东西第二次读就没了"。
 */
export function parseStruct(raw: unknown): StructLookup {
  if (raw === null || raw === undefined) return { ok: false, message: '这份剧本还没有抽取产物（伴生结构）' };
  const warnings: string[] = [];
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const item of asList((raw as Record<string, unknown>).warnings)) {
      const line = text(item, MAX_STRUCT_TEXT_CHARS);
      if (line && !warnings.includes(line)) warnings.push(line);
    }
  }
  const struct = coerceStruct(raw, warnings);
  if (!struct) return { ok: false, message: '伴生结构的形状不对（应该是一个对象）' };
  return { ok: true, struct };
}
