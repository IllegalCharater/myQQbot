// 掷骰 / 检定结果的**展示**（从 `render.ts` 拆出，2026-10-16）。
//
// 这两份文本是**模型唯一能看到的骰子真相**（`roll` 工具的结果），也是 `.r` 命令发给群友
// 的那句话。所以两条纪律：
//   ① **每一颗骰子都印出来** —— "4d6kh3 → 14" 是不可复核的，玩家会问"我掷了哪四颗"；
//   ② 判据是**字段在不在**，不是值是否为零（同 `image-source/result-formatter.ts` 的规矩）：
//      算式明细由求值器给出（`DiceRoll.detail`），被丢弃的骰子才印"丢掉哪几颗"。
import type { CheckResult } from '../rules/check.js';
import type { DiceRoll } from '../rules/dice.js';

/** `3d6 → 4+2+5 = 11`、`4d6kh3 → 6+3+5 = 14（掷出 1,6,3,5，丢掉 1 颗；骰子和 14）`。 */
export function formatRoll(roll: DiceRoll): string {
  const keptSum = roll.kept.reduce((total, value) => total + value, 0);
  // 没有骰子（纯数字表达式）时不印 `12 → 12 = 12` 那种废话。
  let line = roll.detail
    ? `${roll.expr} → ${roll.detail} = ${roll.total}`
    : `${roll.expr} = ${roll.total}`;
  // 被丢弃的骰子要说出来，否则 `4d6kh3` 与 `3d6` 在结果上分不出来。
  if (roll.dropped > 0) {
    line += `（掷出 ${roll.dice.join(',')}，丢掉 ${roll.dropped} 颗；骰子和 ${keptSum}）`;
  }
  return line;
}

/** `1d100 对 50 → 30 = 30 ｜ 成功（差 20）`。档位的中文名优先取规则表给的 `label`。 */
export function formatCheck(result: CheckResult): string {
  const grade = result.label ?? GRADE_LABEL[result.grade] ?? result.grade;
  const gap = result.margin === 0 ? '正好' : (result.margin > 0 ? `超出 ${result.margin}` : `差 ${-result.margin}`);
  return `${formatRoll(result.roll)} ｜ 对 ${result.target} → ${result.success ? '成功' : '失败'}（${grade}，${gap}）`;
}

/**
 * 已知档位的中文名。
 *
 * 这只是**兜底**：规则表的 `label` 才是权威（COC 那套的"极难成功/困难成功"不在下表里）。
 * 认不出来就原样印 `grade`（同 `image-source` 的"字段在不在"那条规矩 —— 不替规则书编名字）。
 */
const GRADE_LABEL: Record<string, string> = {
  critical: '大成功',
  success: '普通成功',
  failure: '失败',
  fumble: '大失败'
};
