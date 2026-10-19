// 结局（P8-c）的**纯助手**：从剧本快照里取结局、按 id 找、拼一行说明。
//
// 与 `scenario/acts.ts` 同一层、同一条纪律：不碰磁盘、不认识 `TrpgCampaign`。
// 解析快照这件事两边都要，所以直接复用 `acts.ts` 的 `structOf`（它是"快照 → 结构"的
// 唯一解释处，不是"幕专用的"）。
import { structOf } from './acts.js';
import { describeTrigger } from '../rules/rule-set.js';
import type { StructEnding } from './extract/schema.js';

/** 快照里的结局。读不出来 / 旧文件没有这一栏 → **空数组**（自由结局仍可用）。 */
export function endingsOf(struct: unknown): readonly StructEnding[] {
  return structOf(struct)?.endings ?? [];
}

/**
 * 按 **id 或名字**找结局。
 *
 * 名字也认是有意的：抽取产出的 `id` 缺省就等于 `name`，而模型很容易把"远行"这个**名字**
 * 当成 id 传进来。**未知的一律返回 `null`** —— 调用方必须拒绝（硬约束：不许幻觉出剧本没有的结局）。
 */
export function findEnding(endings: readonly StructEnding[], id: unknown): StructEnding | null {
  const wanted = String(id ?? '').trim();
  if (!wanted) return null;
  return endings.find((ending) => ending.id === wanted || ending.name === wanted) ?? null;
}

/** 一行说明（进 briefing 与 `.trpg check`）：`远行 —— 当旗标「灯塔熄灭」= 是（SAN +1D6）`。 */
export function describeEnding(ending: StructEnding): string {
  const when = ending.trigger ? describeTrigger(ending.trigger) : '无条件';
  return `${ending.name} —— ${when}${ending.rewards ? `（${ending.rewards}）` : ''}`;
}
