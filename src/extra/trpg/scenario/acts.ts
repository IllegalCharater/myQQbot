// 分幕（P8）的**运行期助手**：从剧本快照里取幕、按场景/条件算"现在该在第几幕"。
//
// ── 为什么单独一个文件 ──
//
// 三处消费点（开局、换场景、两份渲染）都要同一套判据，而它们分居 `model/`、`tools/`
// 与 `render/`。放在这里的好处是**纯函数**：不碰磁盘、不认识 `TrpgCampaign`（只收
// 场景名、幕 id 与一个 `MechanicContext`），于是能脱离存档直接测。
//
// ── 场景匹配为什么要归一化 ──
//
// `campaign.scene` 是 **DM 的自由文本**（"灯塔一层·门厅"），而幕的 `scenes` 来自模组原文
// （"灯塔"）。精确匹配在真实游玩里**大概率一次都不命中**，症状是"分幕好像没做"。
// 所以先精确匹配，再按"去掉空白与标点、大小写不敏感"比一次。
//
// ⚠️ **刻意不做双向包含**：`"灯塔"` 与 `"灯塔地下室"` 互相包含，那会让刚进地下室就命中
// 上一层的那一幕，把进度提前推走。宁可漏判（还有 `exitCondition` 兜底），不要误判。
import { parseStruct, type ScenarioStruct, type StructAct } from './extract/schema.js';
import { triggerMatches } from '../rules/rule-set.js';
import type { MechanicContext } from '../rules/rule-set.js';

/** 快照里的幕。读不出来 / 旧文件没有这一栏 → **空数组**（= 单幕模式，不报错）。 */
export function actsOf(struct: unknown): readonly StructAct[] {
  return structOf(struct)?.acts ?? [];
}

/**
 * 解析剧本快照。**解不动返回 `null`**（与 `parseStruct` 的三态一致：这里只关心"有没有"）。
 *
 * 它给 `.trpg check` 与渲染层共用 —— 谁都不必再写一遍 `parseStruct(...).ok ? ... : ...`。
 */
export function structOf(struct: unknown): ScenarioStruct | null {
  if (struct === undefined || struct === null) return null;
  const parsed = parseStruct(struct);
  return parsed.ok ? parsed.struct : null;
}

/** 按 id 找一幕。找不到返回 `null`（**不回落到第一幕** —— 那个决定留给调用方）。 */
export function findAct(acts: readonly StructAct[], id: unknown): StructAct | null {
  const wanted = String(id ?? '').trim();
  if (!wanted) return null;
  return acts.find((act) => act.id === wanted) ?? null;
}

/** 第一幕（数组顺序已经是权威，见 `normalizeActs`）。 */
export function firstAct(acts: readonly StructAct[]): StructAct | null {
  return acts[0] ?? null;
}

/** 这一幕在**全部**幕里的序号（从 1 起；找不到返回 0）。 */
export function actNumber(acts: readonly StructAct[], id: unknown): number {
  const at = acts.findIndex((act) => act.id === String(id ?? '').trim());
  return at < 0 ? 0 : at + 1;
}

/** 玩家看得见的那些幕（`visible !== false`）。 */
export function visibleActs(acts: readonly StructAct[]): readonly StructAct[] {
  return acts.filter((act) => act.visible);
}

/**
 * 场景名的比较键：去掉空白与常见标点、转小写。
 *
 * 中文没有分词，能做的最稳的一件事就是"看起来一样的两个名字算同一个"。
 */
export function sceneKey(value: unknown): string {
  return String(value ?? '')
    .replace(/[\s　·、，,。.．:：;；!！?？「」『』（）()【】[\]《》<>—\-_/\\|"'“”‘’]/g, '')
    .toLowerCase();
}

/** 这个场景属于哪一幕：先精确、再归一化。都不中返回 `null`。 */
export function actForScene(acts: readonly StructAct[], scene: unknown): StructAct | null {
  const wanted = String(scene ?? '').trim();
  if (!wanted) return null;
  const exact = acts.find((act) => act.scenes.some((name) => name.trim() === wanted));
  if (exact) return exact;
  const key = sceneKey(wanted);
  if (!key) return null;
  return acts.find((act) => act.scenes.some((name) => sceneKey(name) === key)) ?? null;
}

/** 下一幕（按数组顺序）。最后一幕之后返回 `null`。 */
export function nextAct(acts: readonly StructAct[], id: unknown): StructAct | null {
  const at = acts.findIndex((act) => act.id === String(id ?? '').trim());
  if (at < 0) return null;
  return acts[at + 1] ?? null;
}

/**
 * 换场景时**该进入哪一幕**。返回 `moved: false` = 原地不动（未知场景也**保持当前幕**）。
 *
 * 判据顺序（与设计稿一致）：
 *   ① 新场景命中某一幕的 `scenes` → 进那一幕；
 *   ② 否则，当前幕的 `exitCondition` 在这个局面下成立 → 进**下一幕**；
 *   ③ 都不成立 → 不动。
 *
 * ⚠️ **"未知场景不回落"是有意的**：DM 随手写个过场场景（"走廊""马车上"）不该把进度打回
 * 第一幕 —— 那比不推进坏得多。
 */
export function resolveAct(
  acts: readonly StructAct[],
  currentId: unknown,
  scene: unknown,
  ctx: MechanicContext
): { act: StructAct | null; moved: boolean } {
  if (!acts.length) return { act: null, moved: false };
  const current = findAct(acts, currentId) ?? firstAct(acts);
  const byScene = actForScene(acts, scene);
  if (byScene) return { act: byScene, moved: byScene.id !== current?.id };
  if (current?.exitCondition && triggerMatches(current.exitCondition, ctx)) {
    const next = nextAct(acts, current.id);
    if (next) return { act: next, moved: true };
  }
  return { act: current, moved: false };
}
