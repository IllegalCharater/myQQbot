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
  MAX_STRUCT_ITEMS, MAX_STRUCT_QUOTE_CHARS, MAX_STRUCT_TEXT_CHARS, text
} from '../../model/limits.js';

export interface StructScene { name: string; summary: string; npcs: string[]; clues: string[] }
export interface StructNpc { name: string; summary: string; attitude: string; location: string; discovered: boolean }
export interface StructClue { text: string; visible: boolean; location: string }
export interface StructItem { name: string; summary: string; location: string }

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

export interface ScenarioStruct {
  summary: string;
  scenes: StructScene[];
  npcs: StructNpc[];
  clues: StructClue[];
  items: StructItem[];
  mechanics: StructMechanic[];
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
  return { summary: '', scenes: [], npcs: [], clues: [], items: [], mechanics: [], warnings: [] };
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
  raw: unknown, limit: number, label: string, warnings: string[], coerce: (item: Record<string, unknown>) => T | null
): T[] {
  const out: T[] = [];
  let bad = 0;
  let over = 0;
  for (const item of asList(raw)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      bad += 1;
      continue;
    }
    const made = coerce(item as Record<string, unknown>);
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
