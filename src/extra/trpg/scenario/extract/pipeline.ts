// 跑团扩展 · 抽取管线的**编排**（L2 逐片抽取 → L3 合成 → L4 校验）。
//
// ── 四级各做什么 ──
//
//   L1 `outline.ts`   纯代码切片。**不在这里**：它是纯函数，单独一个文件、单独一套断言。
//   L2 本文件         每一片一次调用，各自抽出一份**部分结构**；片与片之间互不知情。
//   L3 本文件         **归并是纯代码**（`mergeStructs`），然后一次调用把归并结果合成剧本正文。
//   L4 本文件         引文核对、超限标进 `warnings`；机制编译成规则扩展草稿；正文必须过 `isFormattedScenario`。
//
// ── 为什么 L3 拿到的不是原文 ──
//
// 原文**可能大得塞不进一次调用** —— 那正是切片存在的理由。所以 L3 吃的是"已经归并好的
// 结构化结果"（JSON），它做的是**压缩与串联**：把结构里的世界观与主线写成正文。把原文
// 再喂给它一次，等于把"塞不下"这件事重新引入一遍。
//
// ── 归并为什么是纯代码而不是又一次调用 ──
//
// 六份部分结构合成一份，判据是**机械的**（同名合并、去重、按上限截断），没有一处需要
// 判断力。交给模型只会多一次调用、多一处不确定，还得让模型把已经抽出来的东西再抄一遍。
//
// ── 预算：每一发都从同一条死线倒推 ──
//
// 同 `image-source` 那条"给兜底留位置"的纪律：`EXTRACT_TOTAL_BUDGET_MS` 是**整条管线**的
// 死线，每一发的超时是 `min(EXTRACT_CALL_TIMEOUT_MS, 剩余)`；剩余低于 `EXTRACT_MIN_CALL_MS`
// 就**不发**那一发，并把"少抽了几片"如实说出来（原文还在 `raw/` 里，没有丢）。
//
// ⚠️ **L2 与 L3 用的是两条死线，差一个 `EXTRACT_CALL_TIMEOUT_MS`**（2026-10-19 加）：
// 分片是可选的，L3 是**唯一的交付物** —— 它失败就等于整轮白跑。所以 L2 只准用到
// `EXTRACT_L2_BUDGET_MS`，把最后那 60 秒原样留给 L3。合成一条死线的后果实测过：
// 两片各 44 秒吃光 90 秒，L3 分到 2 秒、当场超时，而群里看到的是"抽取没成"。
//
// ⚠️ **本目录（`scenario/extract/`）不许出现 `node:fs` / `node:path`**（`check-layers.mjs`
// 有一条闸门，与 `model/` 同形）：落盘是 `store/` 的事，这一层要能脱离磁盘被测。
import {
  EXTRACT_CALL_TIMEOUT_MS, EXTRACT_L2_BUDGET_MS, EXTRACT_MIN_CALL_MS, EXTRACT_TOTAL_BUDGET_MS,
  MAX_ACT_GOAL_CHARS, MAX_ACT_KEEPER_CHARS, MAX_ACT_SCENES, MAX_ACTS, MAX_CHARACTERS,
  MAX_ENDING_KEEPER_CHARS, MAX_ENDING_READ_ALOUD_CHARS, MAX_ENDING_REWARDS_CHARS, MAX_ENDINGS, MAX_FLAGS,
  MAX_STRUCT_ITEMS, MAX_STRUCT_TEXT_CHARS, MAX_STRUCT_QUOTE_CHARS
} from '../../model/limits.js';
import { isFormattedScenario } from '../parse.js';
import { BODY_BUDGET, stripFence } from '../format.js';
import { MECHANIC_TYPES, EFFECT_HANDLERS, TRIGGER_OPS, compileRuleSet, type RuleExtensionDraft } from '../../rules/rule-set.js';
import { outlineDocument, type DocChunk, type DocOutline } from './outline.js';
import { coerceStruct, type ScenarioStruct } from './schema.js';
import { buildRuleExtension } from './mechanics.js';
import type { AskPort, AskRequest, ChunkPayload } from './prompt.js';

export interface ExtractDeps {
  /** 一次模型调用。生产实现是 `prompt.ts` 的 `askModel`，测试注入假端点。 */
  ask: AskPort;
  /** 现在几点（毫秒）。测试可以给一个自己控制的钟。 */
  now?: () => number;
}

export interface ExtractResult {
  /** L3 合成的剧本文件正文（frontmatter + 正文）。**已经过 `isFormattedScenario`**。 */
  body: string;
  /** 结构化剧情。落成 `<id>.struct.json`。 */
  struct: ScenarioStruct;
  /**
   * 规则扩展的草稿，落成 `<id>.rule.json`。**`null` = 这份剧本一条机制都没抽到** ——
   * 那是"没有规则扩展"这个事实，与"有一份空规则扩展"是两回事（后者会落一个空文件，
   * 而 `.trpg check` 会报一句"0 条机制"，前者什么都不该有）。
   *
   * 它是**草稿**：编译过没过由 `compileRuleSet` 说了算，`struct.warnings` 里记着结果。
   */
  ruleExt: RuleExtensionDraft | null;
  /** 切出来的片（原文切片，落成 `<id>.raw/` 下的文件）。 */
  chunks: DocChunk[];
  /** 原文总字数（`DocOutline.totalChars`）。 */
  totalChars: number;
  /**
   * 因为片数上限而**没进抽取**的字数（`DocOutline.droppedChars`）。`0` = 全都进了。
   *
   * 它必须能被调用方拿到：回执上"抽了几片"与"还有多少字没抽"是**两件事**，而后者是
   * 管理员判断"要不要手工再传一次"的唯一依据（原文在 `raw/` 里没丢，但那份切片只到上限）。
   */
  droppedChars: number;
  /** 真的发出去的模型调用次数（L2 的片数 + L3 那一次，若发了）。 */
  calls: number;
  /** 用掉的时间（毫秒）。 */
  ms: number;
}

export type ExtractOutcome =
  | { ok: true; result: ExtractResult }
  | { ok: false; kind: ExtractFailureKind; message: string; salvage: ExtractSalvage };

/**
 * 抽取**没成**时抢救下来的东西（2026-10-19 加）。
 *
 * ── 为什么要有它 ──
 *
 * 抽取失败之后调用方会退回 `formatScenarioText`（只让模型把原文重排成规定格式）。那条路
 * **是有损的**：实测一份 7345 字的模组进去、2687 字出来（少了 63%），而它的产物只有一份
 * `.md` —— 于是**原文在磁盘上再也没有第二份副本**，管理员连"回去对着原文补结构"都做不到。
 *
 * 所以失败路径也要把已经到手的东西交出去：`chunks` 落成 `raw/`（原文切片是这份文件唯一的
 * 完整副本），`struct` 落成 `.struct.json`（抽到一半的结构比没有强，但它必须**标明不全**，
 * 见 `salvageOf`）。
 *
 * ⚠️ **没有 `ruleExt`**：降级路径不交付 `.rule.json` —— 那是 `ruleSetFor` 在开局时读的东西，
 * 写了它就等于那一局**真的会应用特殊规则**，而回执上明明写着"不会"。宁可少一样产物，
 * 也不要让回执里那句话变成谎话（详见 `commands/scenario.ts` 里 `writeExtras` 那一段）。
 */
export interface ExtractSalvage {
  /** 抽到一半的结构。**`null` = 一片都没抽成**（那时 `raw/` 是唯一的产物）。 */
  struct: ScenarioStruct | null;
  /** L1 切出来的原文切片（与成功路径同源，只是没能变成交付物）。 */
  chunks: DocChunk[];
  totalChars: number;
  droppedChars: number;
  /** 真的发出去的模型调用次数 —— **失败也是花了钱的**，回执与账本都要说得出这个数。 */
  calls: number;
}

/**
 * 失败**分档**（2026-10-19 加）。取值只有四种，判据是"下一步该做什么不一样"：
 *
 * - `timeout` —— 我们自己的死线到了（某一发超时、或者整条预算用光）。**重发一次多半还是不够**：
 *   同一份文件、同样的片数、同样的死线。要给它一个"拆小一点"的建议。
 * - `empty`   —— 这份文件里压根没有可抽取的正文（扫描件、整页图片）。重发结果一样。
 * - `format`  —— 模型这次没按格式答。**这一档才是真的偶发**，重发通常就好。
 * - `request` —— 请求本身失败（网络、接口、5xx）。与这份文件无关，也是偶发。
 *
 * ⚠️ **它存在的唯一理由是回执里那句"下一步"**（`commands/scenario.ts` 的
 * `extractFailureAdvice`）：原先无论哪种失败都说"要重试就把原文件重新发一次"，于是
 * 配置性的必然失败被说成"偶发，建议重试" —— 管理员拿着一次真实的失败去撞同一堵墙，
 * 而回执本身没给他任何别的线索。**别把它降级成一个字符串前缀**：分档是要给分支用的。
 */
export type ExtractFailureKind = 'timeout' | 'request' | 'format' | 'empty';

/** 一次调用的失败。`timedOut` 区分"我们自己的死线到了"与"这次请求真的失败了"。 */
type AskFailure = { ok: false; message: string; timedOut: boolean };

/** 一次调用的结果：成功给内容，失败给一句可读的原因。 */
async function askWithTimeout(
  ask: AskPort, request: AskRequest, timeoutMs: number
): Promise<{ ok: true; content: string } | AskFailure> {
  const controller = new AbortController();
  const seconds = Math.round(timeoutMs / 1000);
  let timedOut = false;
  // `timer` 刻意**不 unref**：这里的超时是唯一的兜底，而"卡住不退出的假端点"不持有任何句柄，
  // unref 掉的计时器会被无视 —— 那正是 `core/python-probe.ts` 那条踩过的坑（套件会静默中止）。
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`抽取调用超时（${seconds} 秒）`));
  }, timeoutMs);
  // 死线到了就**用我们自己这句话**，不转述端口的报错。理由有两条，都不是洁癖：
  // ① `chatCompletion` 会把调用方中止洗成 `模型请求失败：…`，而那个前缀的含义是"网络层失败、
  //    可以重试" —— 恰恰是这条路上最错的建议（预算已经用光）；`llm.ts` 那边也已改（外部
  //    signal 上的中止不再走那个前缀），但这一层不该指望它：端口是**注入的**，假的实现
  //    完全可能给一句别的话。
  // ② 回执那句"下一步"要按档给，而档来自这里 —— 没有这个标记就只能去猜字符串。
  const timedOutFailure = (): AskFailure => ({ ok: false, message: `抽取调用超时（${seconds} 秒）`, timedOut: true });
  try {
    const outcome = await ask(request, controller.signal);
    if (outcome.ok) return { ok: true, content: outcome.content };
    return timedOut ? timedOutFailure() : { ok: false, message: outcome.message, timedOut: false };
  } catch (error) {
    // 端口自己吞了异常是它的约定（`askModel` 就是这么写的），但假的实现可能不吞 ——
    // 在这里兜一层，免得一个抛异常的端口把整条命令变成一次未捕获异常。
    if (timedOut) return timedOutFailure();
    return { ok: false, message: error instanceof Error ? error.message : String(error), timedOut: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 从模型的回复里抠出一个 JSON 对象。
 *
 * 先剥围栏（提示词说了不要套，而它经常套），再从**第一个 `{` 到最后一个 `}`** 取一段 ——
 * 模型爱在前后写"以下是抽取结果："这类话。取不出来或解不动都**如实失败**：把一段解不动的
 * 文本当成空结构收下，表现是"抽取完了但什么都没抽到"，而没人知道是模型没按格式答。
 */
function parseJsonObject(content: unknown): { ok: true; value: unknown } | { ok: false; message: string } {
  const text = stripFence(content);
  if (!text) return { ok: false, message: '模型没有给出任何内容' };
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return { ok: false, message: '模型给的不是一个 JSON 对象' };
  try {
    return { ok: true, value: JSON.parse(text.slice(start, end + 1)) };
  } catch (error) {
    return { ok: false, message: `模型给的 JSON 解不动：${error instanceof Error ? error.message : String(error)}` };
  }
}

// ── L3 的归并（纯代码）──────────────────────────────────────────────────────

/**
 * 按上限截断，**并且把截掉几条说出来**。
 *
 * 单片的截断由 `coerceStruct` 的 `takeItems` 负责（它已经会记一笔）；这里管的是**归并之后**
 * 才越限的那一种 —— 六片各抽 24 条、并起来 40 条，`takeItems` 一次都没触发过。
 * 静默 slice 的表现是"抽出来的比原文里有的少"，而少了几条、为什么少，**一处线索都没有**。
 */
function cap<T>(items: T[], limit: number, label: string, warnings: string[]): T[] {
  if (items.length <= limit) return items;
  warnings.push(`${label}合并后超过 ${limit} 条上限，后面的 ${items.length - limit} 条没进来`);
  return items.slice(0, limit);
}

/**
 * 把若干片的部分结构并成一份。
 *
 * **先出现者优先**：同一个场景在两片里都出现了，第一片的说法留着（它通常是"第一次介绍"），
 * 后面的只用来补空缺（空字段）与并集（场景里的 `npcs` / `clues` 名单）。顺序按片序稳定 ——
 * 顺序即缓存，同一份原文两次抽取必须并出同一个结果。
 */
export function mergeStructs(parts: readonly ScenarioStruct[]): ScenarioStruct {
  const merged: ScenarioStruct = { summary: '', scenes: [], npcs: [], clues: [], items: [], mechanics: [], acts: [], endings: [], warnings: [] };

  const summaries: string[] = [];
  const sceneAt = new Map<string, number>();
  const npcAt = new Map<string, number>();
  const clueAt = new Map<string, number>();
  const itemAt = new Map<string, number>();
  const mechanicAt = new Map<string, number>();
  const actAt = new Map<string, number>();
  const endingAt = new Map<string, number>();

  for (const part of parts) {
    if (part.summary) summaries.push(part.summary);
    merged.warnings.push(...part.warnings);

    for (const scene of part.scenes) {
      const key = scene.name || scene.summary;
      const at = sceneAt.get(key);
      if (at === undefined) {
        sceneAt.set(key, merged.scenes.length);
        merged.scenes.push({ ...scene, npcs: [...scene.npcs], clues: [...scene.clues] });
        continue;
      }
      const kept = merged.scenes[at];
      if (!kept.summary) kept.summary = scene.summary;
      for (const npc of scene.npcs) if (!kept.npcs.includes(npc)) kept.npcs.push(npc);
      for (const clue of scene.clues) if (!kept.clues.includes(clue)) kept.clues.push(clue);
    }

    for (const npc of part.npcs) {
      const at = npcAt.get(npc.name);
      if (at === undefined) {
        npcAt.set(npc.name, merged.npcs.length);
        merged.npcs.push({ ...npc });
        continue;
      }
      const kept = merged.npcs[at];
      if (!kept.summary) kept.summary = npc.summary;
      if (!kept.attitude) kept.attitude = npc.attitude;
      if (!kept.location) kept.location = npc.location;
    }

    for (const clue of part.clues) {
      if (clueAt.has(clue.text)) continue;
      clueAt.set(clue.text, merged.clues.length);
      merged.clues.push({ ...clue });
    }

    for (const item of part.items) {
      const at = itemAt.get(item.name);
      if (at === undefined) {
        itemAt.set(item.name, merged.items.length);
        merged.items.push({ ...item });
        continue;
      }
      const kept = merged.items[at];
      if (!kept.summary) kept.summary = item.summary;
      if (!kept.location) kept.location = item.location;
    }

    for (const mechanic of part.mechanics) {
      // 引文是机制的**身份**（L4 就拿它去原文里找）。没有引文时退化成"类型 + 触发条件"。
      const key = mechanic.sourceQuote || `${mechanic.type}\u0000${mechanic.triggerText}`;
      if (mechanicAt.has(key)) continue;
      mechanicAt.set(key, merged.mechanics.length);
      merged.mechanics.push({ ...mechanic });
    }

    // 幕：**按 id 合并**（同一幕可能横跨两片）。合并方向是"补空、不覆盖" —— 与上面几类
    // 同一条取舍；`visible` 取 **AND**（任何一片说它该藏就藏：多藏一条只是玩家少看见一点，
    // 少藏一条是泄漏）。
    for (const act of part.acts) {
      const at = actAt.get(act.id);
      if (at === undefined) {
        actAt.set(act.id, merged.acts.length);
        merged.acts.push({ ...act, scenes: [...act.scenes] });
        continue;
      }
      const kept = merged.acts[at];
      if (!kept.goal) kept.goal = act.goal;
      if (!kept.keeperNotes) kept.keeperNotes = act.keeperNotes;
      if (!kept.entryCondition) kept.entryCondition = act.entryCondition;
      if (!kept.exitCondition) kept.exitCondition = act.exitCondition;
      kept.visible = kept.visible && act.visible;
      for (const scene of act.scenes) if (!kept.scenes.includes(scene)) kept.scenes.push(scene);
    }

    // 结局：同样按 id 合并、**补空不覆盖**（同一段结局可能横跨两片）。
    for (const ending of part.endings) {
      const at = endingAt.get(ending.id);
      if (at === undefined) {
        endingAt.set(ending.id, merged.endings.length);
        merged.endings.push({ ...ending });
        continue;
      }
      const kept = merged.endings[at];
      if (!kept.trigger) kept.trigger = ending.trigger;
      if (!kept.readAloud) kept.readAloud = ending.readAloud;
      if (!kept.rewards) kept.rewards = ending.rewards;
      if (!kept.keeperNotes) kept.keeperNotes = ending.keeperNotes;
    }
  }

  merged.summary = summaries.join(' / ').slice(0, MAX_STRUCT_TEXT_CHARS * 4);
  merged.scenes = cap(merged.scenes, MAX_STRUCT_ITEMS, '场景', merged.warnings);
  merged.npcs = cap(merged.npcs, MAX_STRUCT_ITEMS, '人物', merged.warnings);
  merged.clues = cap(merged.clues, MAX_STRUCT_ITEMS, '线索', merged.warnings);
  merged.items = cap(merged.items, MAX_STRUCT_ITEMS, '道具', merged.warnings);
  merged.mechanics = cap(merged.mechanics, MAX_STRUCT_ITEMS, '机制', merged.warnings);
  merged.acts = cap(merged.acts, MAX_ACTS, '幕', merged.warnings);
  merged.endings = cap(merged.endings, MAX_ENDINGS, '结局', merged.warnings);
  return merged;
}

// ── L4：校验与回填（全部确定性）──────────────────────────────────────────────

/**
 * 引文核对。
 *
 * 先试**逐字**（`text.includes`），不行再去掉全部空白再试一次：PDF 抽取会把句子在行末
 * 断开，模型照抄时不会带上那个换行 —— 只认逐字的话这一档会把大量**其实对得上**的引文
 * 判成待核项，于是待核项列表变成噪音，没人再看它。
 *
 * ⚠️ **对不上的不丢弃**（决定 B）：丢弃会让抽取静默变少，而"少了"和"本来就没有"在群里
 * 长得一样。标进待核项，把判断权交回给人。
 */
function verifyQuotes(struct: ScenarioStruct, source: string): void {
  const flat = source.replace(/\s+/g, '');
  struct.mechanics.forEach((mechanic, index) => {
    if (!mechanic.sourceQuote) {
      struct.warnings.push(`第 ${index + 1} 条机制（${mechanic.type}）没给原文引文，没法核对`);
      return;
    }
    if (source.includes(mechanic.sourceQuote) || flat.includes(mechanic.sourceQuote.replace(/\s+/g, ''))) return;
    struct.warnings.push(`第 ${index + 1} 条机制（${mechanic.type}）的引文在原文里找不到：${mechanic.sourceQuote.slice(0, 40)}`);
  });
}

/**
 * 机制的**成形与对账**（P7-c）。
 *
 * 两件事分开做，各自只有一个权威：
 * - `buildRuleExtension`（`./mechanics.ts`）管**抽取质量**：认不出的 type、写不出可判定的
 *   trigger/effect 的那几条降级成纯叙事，并记一笔。
 * - `compileRuleSet`（`rules/rule-set.ts`）管**语法与互斥**：人手改过的文件与这份草稿走的是
 *   同一条路，所以这里不自己判一遍。
 *
 * 本函数只做第三件事：**把两者的账转抄进 `struct.warnings`**。于是 `.trpg check` 那一个出口
 * 就能看到全部待核项，而管理员在开一局**之前**就有机会看到冲突。
 *
 * ⚠️ **编译失败在这里只记待核项，不拒绝这次抽取**。理由与 `buildRuleExtension` 那条同源：
 * 拒绝会让整份剧本白抽一遍（调用已经花掉了）。真正该拒绝的是**开局**那一步（P7-d 的
 * `beginCampaign`）—— 那时人已经看过待核项、而且**什么都还没写盘**。所以冲突的那份草稿
 * **照样交出去**：把它丢掉等于让开局悄悄少掉几条规则，那比拒绝坏得多。
 */
function verifyMechanics(struct: ScenarioStruct): RuleExtensionDraft | null {
  const draft = buildRuleExtension(struct.mechanics, struct.warnings);
  if (!draft) return null;
  const compiled = compileRuleSet(draft);
  if (compiled.ok) struct.warnings.push(...compiled.set.warnings);
  else struct.warnings.push(...compiled.problems);
  return draft;
}

/**
 * 幕的**交叉校验**（L4）。
 *
 * 两类都是"不跑就发现不了"的错：
 *   ① 幕引用的场景名在结构里找不到 —— 自动推进**永远轮不到这一幕**，而群里只会觉得
 *      "分幕好像没生效"；
 *   ② 这一幕既没有关联场景、也没有进出条件 —— 同上，而且连手改都无从下手。
 *
 * **只记待核项，不拒绝**（同 `verifyMechanics` 那条取舍）：抽得糙的幕仍然能跑（单幕或半自动），
 * 拒绝会让整份剧本白抽一遍。
 *
 * **导出只为单测**（同 `scenarioNameFromFile`）：真跑一遍要起假端点，而这四个判据是纯函数。
 */
export function verifyActs(struct: ScenarioStruct): void {
  if (!struct.acts.length) return;
  const names = new Set(struct.scenes.map((scene) => scene.name).filter(Boolean));
  for (const act of struct.acts) {
    const missing = act.scenes.filter((scene) => !names.has(scene));
    if (missing.length) {
      struct.warnings.push(
        `第 ${act.order} 幕「${act.name}」引用了结构里没有的场景：${missing.join('、')}（自动推进会轮不到这一幕）`
      );
    }
    if (!act.scenes.length && !act.entryCondition && !act.exitCondition) {
      struct.warnings.push(
        `第 ${act.order} 幕「${act.name}」既没有关联场景也没有进出条件，自动推进轮不到它`
      );
    }
  }
}

/**
 * 结局的**交叉校验**（L4）。
 *
 * 只报一件事：**没有触发条件的结局**。那种结局等于"随时可以结束"，而模型被告知
 * "每轮检查是否满足" —— 于是它会在第一轮就把团收掉，且没有任何报错。
 *
 * ⚠️ **不校验 trigger 里的旗标存不存在**：旗标是 DM 运行时起的（`campaign action=flag`），
 * 模组里没写不代表错。所以这里不查"引用了结构里没有的旗标"（与 `verifyActs` 查场景名不同：
 * 场景名是剧本内的结构，旗标是运行期的事实）。
 *
 * **导出只为单测**（同 `verifyActs`）。
 */
export function verifyEndings(struct: ScenarioStruct): void {
  if (!struct.endings.length) return;
  for (const ending of struct.endings) {
    if (ending.trigger) continue;
    struct.warnings.push(
      `结局「${ending.name}」没有触发条件 —— 它随时可以被宣布，模型可能第一轮就把团收掉`
    );
  }
}

/** 归并结果给 L3 看的那一份：**不含 `warnings`**（那是我们的账，不是给模型看的资料）。 */
function forPrompt(struct: ScenarioStruct): string {
  return JSON.stringify({
    summary: struct.summary,
    scenes: struct.scenes,
    npcs: struct.npcs,
    clues: struct.clues,
    items: struct.items,
    mechanics: struct.mechanics
  }, null, 1);
}

// ── 编排 ─────────────────────────────────────────────────────────────────────

/**
 * 把"已经到手、但没能交出去"的那部分留下来（2026-10-19 加，见 `ExtractSalvage`）。
 *
 * ⚠️ **只跑三个只记待核项的校验**（引文 / 幕 / 结局），**刻意不跑 `verifyMechanics`**：
 * 它返回的是那份规则扩展草稿，而降级路径**不交付 `.rule.json`** —— 跑了只会把"机制编译过了"
 * 的账记进 `warnings`，读起来像那些机制会生效。回执上那句"这一局不会应用剧本里的特殊规则"
 * 必须是**真的**。
 *
 * ⚠️ 待核项的**第一条是我们的账**："下面是抽到一半的结果"。少了它，这份结构落盘之后与一次
 * **成功**的抽取长得一模一样 —— 而"看着完整、其实少了一半"正是这一轮在修的那类故障
 * （DM 会拿着半份结构照常开团，没人知道场景少了一半）。
 */
function salvageOf(
  struct: ScenarioStruct | null, outline: DocOutline, calls: number, source: string
): ExtractSalvage {
  if (struct) {
    // `unshift` 而不是 `push`：这一条要说在**所有**待核项之前 —— 它改变的是后面每一条的读法
    // （"引文找不到"在"结果只有一半"的背景下是另一件事）。
    struct.warnings.unshift('这次抽取没成，下面是抽到一半的结果 —— 场景 / NPC / 线索 / 道具都可能不全');
    verifyQuotes(struct, source);
    verifyActs(struct);
    verifyEndings(struct);
  }
  return {
    struct,
    chunks: outline.chunks,
    totalChars: outline.totalChars,
    droppedChars: outline.droppedChars,
    calls
  };
}

/**
 * L2 + L3 + L4。
 *
 * 失败一律是**如实失败**（调用方拿这条消息去回报，或退回 `formatScenarioText`）—— 这里
 * 绝不返回一份"抽了一半但看着像成功了"的结果。
 *
 * 失败时**必带 `kind`**（见 `ExtractFailureKind`）：调用方靠它决定回执里那句"下一步"。
 * 判据是"重发有没有用"，而不是那句报错长什么样 —— 别让调用方去匹配消息文本。
 *
 * 失败时**必带 `salvage`**（见 `ExtractSalvage`）：已经到手的原文切片与半份结构要交出去，
 * 否则降级之后磁盘上连原文的第二份副本都没有（后备那条路是有损的）。
 */
export async function extractScenario(
  text: string, { name, source }: { name: string; source: string }, deps: ExtractDeps
): Promise<ExtractOutcome> {
  const now = deps.now ?? Date.now;
  const started = now();
  // 两条死线，差一个 `EXTRACT_CALL_TIMEOUT_MS`：L2 只准用到 `l2Deadline`，好让 L3（唯一的
  // 交付物）无论如何都分得到一整次调用。见文件头「L2 与 L3 用的是两条死线」那段。
  const deadline = started + EXTRACT_TOTAL_BUDGET_MS;
  const l2Deadline = started + EXTRACT_L2_BUDGET_MS;

  const outline = outlineDocument(text);
  // `empty` 这一档与别的三档不同：它不是"这次不巧"，而是"这份文件里没有可抽的东西"。
  // 回执因此不能建议重发 —— 重发一次结果逐字相同。
  if (!outline.chunks.length) {
    return { ok: false, kind: 'empty', message: '这份文件里没有可抽取的正文', salvage: salvageOf(null, outline, 0, text) };
  }

  const warnings: string[] = [];
  if (outline.droppedChars > 0) {
    warnings.push(`原文太长，只抽了前 ${outline.chunks.length} 片（还有 ${outline.droppedChars} 字没进抽取）`);
  }

  // ── L2：逐片抽取 ──
  const parts: ScenarioStruct[] = [];
  let calls = 0;
  let skipped = 0;
  let firstFailure = '';
  // 与 `firstFailure` 并行的那条线：**第一片为什么失败**。回执那句"下一步"按它分岔，
  // 而分岔的判据是"重发有没有用"，与那句报错本身无关 —— 所以不能靠去匹配报错文本。
  let firstFailureKind: ExtractFailureKind | null = null;

  for (const chunk of outline.chunks) {
    // ⚠️ 这里读的是 `l2Deadline` 而**不是** `deadline`：分片是可选的，L3 是唯一的交付物。
    // 用整条管线的死线的话，几片慢调用就能把 L3 挤到零秒（实测过，见文件头）。
    const remaining = l2Deadline - now();
    if (remaining < EXTRACT_MIN_CALL_MS) {
      skipped = outline.chunks.length - chunk.index;
      break;
    }
    const payload: ChunkPayload = {
      name,
      index: chunk.index + 1,
      total: outline.chunks.length,
      heading: chunk.heading,
      text: chunk.text,
      maxItems: MAX_STRUCT_ITEMS,
      maxTextChars: MAX_STRUCT_TEXT_CHARS,
      maxQuoteChars: MAX_STRUCT_QUOTE_CHARS,
      maxActs: MAX_ACTS,
      maxActScenes: MAX_ACT_SCENES,
      maxActGoalChars: MAX_ACT_GOAL_CHARS,
      maxActKeeperChars: MAX_ACT_KEEPER_CHARS,
      maxEndings: MAX_ENDINGS,
      maxEndingReadAloudChars: MAX_ENDING_READ_ALOUD_CHARS,
      maxEndingRewardsChars: MAX_ENDING_REWARDS_CHARS,
      maxEndingKeeperChars: MAX_ENDING_KEEPER_CHARS,
      mechanicTypes: MECHANIC_TYPES,
      // 另外两张清单也递进去：提示词念的与 `compileRuleSet` 认的必须是同一份（见 `ChunkPayload`）。
      triggerOps: TRIGGER_OPS,
      effectHandlers: EFFECT_HANDLERS
    };
    calls += 1;
    const answered = await askWithTimeout(deps.ask, { job: 'chunk', payload }, Math.min(EXTRACT_CALL_TIMEOUT_MS, remaining));
    if (!answered.ok) {
      // 一片抽不出来**不中断整条管线**：别的片、以及原文切片都还在。
      // 但也不装作没发生 —— 记下来，回执里会说"少抽了几片"。
      if (!firstFailure) { firstFailure = answered.message; firstFailureKind = answered.timedOut ? 'timeout' : 'request'; }
      warnings.push(`第 ${chunk.index + 1} 片没抽出来：${answered.message}`);
      continue;
    }
    const parsed = parseJsonObject(answered.content);
    if (!parsed.ok) {
      if (!firstFailure) { firstFailure = parsed.message; firstFailureKind = 'format'; }
      warnings.push(`第 ${chunk.index + 1} 片没抽出来：${parsed.message}`);
      continue;
    }
    const part = coerceStruct(parsed.value, []);
    if (!part) {
      if (!firstFailure) { firstFailure = '模型给的不是一个对象'; firstFailureKind = 'format'; }
      warnings.push(`第 ${chunk.index + 1} 片没抽出来：模型给的不是一个对象`);
      continue;
    }
    parts.push(part);
  }

  if (!parts.length) {
    // 一片都没成 —— 没有任何可交出去的东西。如实失败，让调用方退回后备那条路。
    // ⚠️ "一片都没成"的成因不止一种，而回执那句建议完全不同：一片都没答上来**且**有片被
    // 跳过（`skipped > 0`）时，真凶是预算 —— 那是**配置性的必然**，重发一次还是撞同一堵墙；
    // 而模型答得不对是偶发的。原先两者共用一句"模型一片都没答上来"，把前者也说成了后者。
    const nothing = skipped > 0 ? '时间不够，一片都没抽成' : '模型一片都没答上来';
    return {
      ok: false,
      kind: firstFailureKind ?? (skipped > 0 ? 'timeout' : 'format'),
      message: `抽取没成：${firstFailure || nothing}`,
      // 一片都没成 → 没有结构可抢救，但**原文切片照交**：它是这份文件唯一的完整副本，
      // 而后备那条路会把原文重排一遍（有损）。
      salvage: salvageOf(null, outline, calls, text)
    };
  }
  if (skipped > 0) warnings.push(`时间预算用完，最后 ${skipped} 片没抽（原文已另存）`);

  const struct = mergeStructs(parts);
  struct.warnings.push(...warnings);

  // ── L3：一次调用合成剧本文件 ──
  //
  // ⚠️ 这一发**不设 `EXTRACT_MIN_CALL_MS` 那道闸门**，只要求"还有时间"。判据是它与 L2 的角色
  // 不同：L2 那几发是**尽力而为**（少一片还有别的片），而 L3 是**唯一的交付物** —— 前面抽到
  // 的东西全靠它才出得去。用同一个阈值卡它的话，"有片被跳过"与"能合成"就**永远不可能同时
  // 成立**（两处读的是同一个时钟，而时钟只往前走），于是上面那条「最后 N 片没抽」的警告
  // **一次也到不了回执** —— 那不是一条降级路径，是死代码。剩下多少时间就给它多少。
  //
  // ⚠️ 而且它读的是**整条管线的死线**（`deadline`），不是 L2 那条子死线 —— L2 已经在
  // `EXTRACT_L2_BUDGET_MS` 处收手了，所以这里算出来的剩余**至少是 `EXTRACT_CALL_TIMEOUT_MS`**
  // （一整次调用）。那个 `remaining <= 0` 分支因此只在注入的钟被拨到终点时才走得到，留着是
  // 兜底而不是主路径。改 L2 的死线时**两处要一起看**：把它们并回一条，L3 就又会被挤空。
  const remaining = deadline - now();
  if (remaining <= 0) {
    return {
      ok: false, kind: 'timeout', message: '抽取没成：时间预算用完了，没来得及合成剧本文件',
      salvage: salvageOf(struct, outline, calls, text)
    };
  }
  calls += 1;
  const merged = await askWithTimeout(deps.ask, {
    job: 'merge',
    payload: {
      name, source, chars: outline.totalChars,
      maxChars: BODY_BUDGET, maxFlags: MAX_FLAGS, maxCharacters: MAX_CHARACTERS,
      extracted: forPrompt(struct)
    }
  }, Math.min(EXTRACT_CALL_TIMEOUT_MS, remaining));
  // ⚠️ 这一发是**唯一的交付物**，所以它超时与它"请求失败"要分开：前者说明预算给少了
  // （重发无用，得拆小），后者才是网络/接口的偶发问题。合并成一档的话，最需要那句
  // "别再重发了"的场景恰好拿到"建议重发"。
  if (!merged.ok) {
    return {
      ok: false, kind: merged.timedOut ? 'timeout' : 'request', message: `合成剧本文件时出错：${merged.message}`,
      salvage: salvageOf(struct, outline, calls, text)
    };
  }

  const body = stripFence(merged.content);
  if (!body) {
    return { ok: false, kind: 'format', message: '模型没有给出剧本内容，稍后再试', salvage: salvageOf(struct, outline, calls, text) };
  }

  // **后置条件**：合成的必须是规定格式。不满足就如实失败 —— 把一份解析不了的文件写进
  // 剧本库的表现是"开局了但什么都没注入"，而群里没人知道为什么（同 `format.ts` 那条）。
  if (!isFormattedScenario(body, name)) {
    return {
      ok: false, kind: 'format', message: '模型合成出来的东西不是剧本格式（没有骨架）—— 稍后再试一次',
      salvage: salvageOf(struct, outline, calls, text)
    };
  }

  // ── L4：校验（在正文过关之后做，于是待核项一定跟着一份可用的文件一起交出去）──
  verifyQuotes(struct, String(text ?? ''));
  verifyActs(struct);
  verifyEndings(struct);
  const ruleExt = verifyMechanics(struct);

  return {
    ok: true,
    result: {
      body,
      struct,
      ruleExt,
      chunks: outline.chunks,
      totalChars: outline.totalChars,
      droppedChars: outline.droppedChars,
      calls,
      ms: now() - started
    }
  };
}
