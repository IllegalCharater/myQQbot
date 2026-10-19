// 推进度（P8-b）的**纯逻辑**：计数、阈值、冷却、提示正文、切幕。
//
// ── 它回答的问题 ──
//
// "故事是不是在原地打转"。三个指标各自记"距上次变化过了几轮"：场景 / 剧情旗标 / 幕。
// 超阈值时由宿主落一条【推进提示】—— **只给 DM、只陈述事实**，不替它决定叙事。
//
// ── 为什么计数在存档里 ──
//
// `campaign.log` 没有"轮"的边界（一次运行可能写好几条、也可能一条不写），从日志反推轮数
// 要么加一种"回合标记"条目（60 条的环形缓冲会被它吃掉），要么按时间猜。三个小整数是唯一
// 确定的做法。
//
// ── 这一层不碰磁盘 ──
//
// 与 `model/` 其余文件同一条规矩：读写由调用方经 `TrpgStore` 做。于是"超阈值/冷却/换指标"
// 这些判据能脱离存档直接测。
import { ADVANCE_HINT_COOLDOWN, ADVANCE_THRESHOLDS } from './limits.js';
import { ADVANCEMENT_METRICS } from '../types.js';
import { appendLog } from './campaign.js';
import { actNumber, actsOf, findAct, firstAct, nextAct } from '../scenario/acts.js';
import { describeTrigger, triggerMatches } from '../rules/rule-set.js';
import type { AdvancementMetric, TrpgCampaign } from '../types.js';
import type { MechanicContext, RuntimeRuleSet } from '../rules/rule-set.js';
import type { StructAct } from '../scenario/extract/schema.js';

/** 指标的中文名（提示正文用）。 */
export const ADVANCEMENT_LABEL: Record<AdvancementMetric, string> = {
  scene: '场景',
  flag: '剧情旗标',
  act: '幕'
};

/**
 * **变更点唯一的置位处**（场景 / 旗标 / 幕四处调用它）。
 *
 * 它做两件事：把计数归零、把 `dirty` 置上。第二件是必须的 —— 本轮的收尾还会再跑一次
 * `tickAdvancement`，没有 `dirty` 的话"刚变完"会被记成 1 而不是 0，所有阈值整体偏移一格。
 *
 * ⚠️ **不要在各变更点手写 `campaign.advancement.x = 0`**：漏了 `dirty` 不会有任何报错，
 * 只会让提示晚一轮。套件里有一条源级断言扫这四处都走它。
 */
export function resetAdvance(campaign: TrpgCampaign, metric: AdvancementMetric): void {
  campaign.advancement[metric] = 0;
  campaign.advancement.dirty = { ...(campaign.advancement.dirty ?? {}), [metric]: true };
}

/**
 * 一轮收尾：本轮**变过**的指标保持 0（并按语义清零），其余 +1；然后清空 `dirty`。
 *
 * 调它的人负责落盘（`impl.ts` 的 `onRunEnd`）。**只数真人推动的运行** —— 否则提示自己
 * 唤醒的那一轮也在计数，阈值会自己跑赢自己（见 `impl.ts` 里那条判据）。
 */
export function tickAdvancement(campaign: TrpgCampaign): void {
  const dirty = campaign.advancement.dirty ?? {};
  for (const metric of ADVANCEMENT_METRICS) {
    if (dirty[metric]) {
      campaign.advancement[metric] = 0;
      continue;
    }
    campaign.advancement[metric] += 1;
  }
  delete campaign.advancement.dirty;
}

/**
 * 阈值表：默认值 + 规则扩展里 `advancement_threshold` 的覆盖。
 *
 * 同一指标被多条覆盖时**后者赢**（声明顺序即优先级，与机制按声明顺序生效同一条）。
 */
export function thresholdsOf(set: RuntimeRuleSet | null): Record<AdvancementMetric, number> {
  const out: Record<AdvancementMetric, number> = { ...ADVANCE_THRESHOLDS };
  for (const mechanic of set?.mechanics ?? []) {
    if (mechanic.type !== 'advancement_threshold') continue;
    const advance = mechanic.advance;
    if (!advance?.metric || !advance.turns) continue;
    out[advance.metric] = advance.turns;
  }
  return out;
}

/** 一条"该提示了"的判定结果。 */
export interface AdvancementHint {
  metric: AdvancementMetric;
  /** 当前已经连续几轮没变化。 */
  turns: number;
  /** 触发它的是哪个阈值（可能被规则扩展覆盖过）。 */
  threshold: number;
}

/**
 * 本轮该提示哪个指标（**至多一个**）。
 *
 * 判据：① 计数 ≥ 阈值；② 距上次提示同一指标 ≥ `ADVANCE_HINT_COOLDOWN` 轮（**按轮算**，
 * 不是按时间 —— 重启后仍然成立）；③ 多个都满足时取"超得最多"的那个，平手按
 * `ADVANCEMENT_METRICS` 的顺序。**换一个指标可以立即落**：冷却按指标分开记。
 */
export function pickHint(campaign: TrpgCampaign, set: RuntimeRuleSet | null): AdvancementHint | null {
  const thresholds = thresholdsOf(set);
  let best: AdvancementHint | null = null;
  for (const metric of ADVANCEMENT_METRICS) {
    const turns = campaign.advancement[metric];
    const threshold = thresholds[metric];
    if (turns < threshold) continue;
    if (!hintAllowed(campaign, metric)) continue;
    const over = turns - threshold;
    if (!best || over > best.turns - best.threshold) best = { metric, turns, threshold };
  }
  return best;
}

/**
 * 这个指标现在能不能落提示：距上次提示同一指标 ≥ `ADVANCE_HINT_COOLDOWN` **轮**。
 *
 * **按轮算而不是按时间**：与"轮"同源，重启后仍然成立；换一个指标可以立即落（冷却按指标分开）。
 * `stage_advance` 的提示也走这里（记在 `act` 名下 —— 它说的是幕）。
 */
export function hintAllowed(campaign: TrpgCampaign, metric: AdvancementMetric): boolean {
  const last = campaign.advancement.hinted?.[metric];
  return last === undefined || campaign.advancement[metric] - last >= ADVANCE_HINT_COOLDOWN;
}

/** 落过提示之后记冷却（调用方负责落盘）。 */
export function markHinted(campaign: TrpgCampaign, metric: AdvancementMetric): void {
  campaign.advancement.hinted = {
    ...(campaign.advancement.hinted ?? {}),
    [metric]: campaign.advancement[metric]
  };
}

/**
 * 【推进提示】的正文。**事实陈述，不是命令**。
 *
 * 三条边界：
 * - **不含 `keeperNotes`**：它是幕后信息，而这条提示虽然只给 DM，正文却会被模型原样念出来。
 * - 没有分幕时只印场景/旗标那一句（沙盒团同样会原地打转）。
 * - 结尾那句明确说"不是命令" —— 硬约束是"软提示，不硬阻断"。
 */
export function advanceHintText(
  campaign: TrpgCampaign, hint: AdvancementHint, ctx: MechanicContext
): string {
  const label = ADVANCEMENT_LABEL[hint.metric];
  const acts = actsOf(campaign.scenario.struct);
  const current = findAct(acts, campaign.currentAct) ?? firstAct(acts);
  const lines: string[] = [];
  if (current) {
    lines.push(
      `当前处于第 ${actNumber(acts, current.id)} 幕「${current.name}」，`
      + `已连续 ${hint.turns} 轮没有${label}变化。`
    );
    if (current.goal) lines.push(`本幕目标：${current.goal}`);
    if (current.exitCondition) {
      const met = triggerMatches(current.exitCondition, ctx);
      lines.push(`本幕完成条件：${describeTrigger(current.exitCondition)}（目前：${met ? '已满足' : '未满足'}）`);
    } else {
      lines.push('本幕没有完成条件。');
    }
  } else {
    lines.push(`当前没有分幕，已连续 ${hint.turns} 轮没有${label}变化。`);
  }
  lines.push('以上只是事实，不是命令 —— 你可以继续这样演，也可以推一把。');
  return lines.join('\n');
}

/** `stage_advance` 声明的策略：`null` = 没声明（保持 P8-a 的行为：换场景时按条件推进）。 */
export function stageAdvanceMode(set: RuntimeRuleSet | null): 'hint' | 'auto' | null {
  let mode: 'hint' | 'auto' | null = null;
  for (const mechanic of set?.mechanics ?? []) {
    if (mechanic.type !== 'stage_advance') continue;
    mode = mechanic.advance?.mode ?? 'hint';
  }
  return mode;
}

/**
 * 【推进提示】的**另一种**：这一幕的完成条件已经满足（`stage_advance` 的 `hint` 档）。
 *
 * 与阈值提示分开是因为**原因不同**：那条说"你们在原地打转"，这条说"这一步已经做到了"。
 * 两者的冷却共用 `act` 那个指标 —— 都是关于幕的。
 */
export function stageHintText(campaign: TrpgCampaign, ctx: MechanicContext): string {
  const acts = actsOf(campaign.scenario.struct);
  const current = findAct(acts, campaign.currentAct) ?? firstAct(acts);
  if (!current?.exitCondition) return '';
  const next = nextAct(acts, current.id);
  const lines = [
    `第 ${actNumber(acts, current.id)} 幕「${current.name}」的完成条件已经满足：`
    + `${describeTrigger(current.exitCondition)}。`
  ];
  lines.push(next
    ? `按剧本的顺序，下一幕是「${next.name}」。真要推进就调 campaign 的 action=advance —— 它会再校验一次条件。`
    : '这已经是最后一幕了。');
  lines.push('这一步要不要跨过去由你决定，代码没有替你切幕。');
  return lines.join('\n');
}

/**
 * 切到下一幕：**唯一实现**（`campaign action=advance`、`stage_advance` 的 auto 档、
 * 以及将来的入口都走它）。
 *
 * 它只做四件事：改 `currentAct`、把 `act` 计数归零/置 dirty、落一条 `[state]` 日志
 * （暗线幕那条不进战报 —— 幕名就是泄漏）。
 */
export function advanceTo(campaign: TrpgCampaign, next: StructAct): void {
  const acts = actsOf(campaign.scenario.struct);
  campaign.currentAct = next.id;
  resetAdvance(campaign, 'act');
  appendLog(
    campaign, 'state',
    `推进到第 ${actNumber(acts, next.id) || next.order} 幕：${next.name}`,
    next.visible
  );
}
