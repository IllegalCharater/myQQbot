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

/**
 * 先攻序：`1. 阿飞 14\n2. 阿豪 12（倒下）`（P5）。
 *
 * 两个可选字段，判据都是**"字段在不在"**（同 `image-source` 的 `time` 与 `similarity` 两条规矩）：
 *   • `scores` 只有**排完那一次**手里有数值（`rollInitiative` 的返回）。中途渲染手里只有一份
 *     名字顺序，缺了就只印名字 —— **不印 `0`**：那会变成"这个人先攻是 0"，而真相是
 *     "我们此刻不知道他的先攻"。
 *   • `gone` 是已经动不了的人（卡没了 / 倒下了）。标出来，让"推进时会跳过谁"在文本里看得见。
 *
 * ⚠️ **`scores` 只该给模型看，不该进群、更不该进日志**：那个数就是卡上的属性（`DEX`），
 * 而 `hidden: ['stats']` 存在的理由正是"藏属性"；而日志会镜像进战报（P6 要导出成文件发群）。
 * 群友那一侧一律只传名字（`commands/combat.ts` 与 `render/players.ts` 都这么做）。
 *
 * 一行一个（不是 ` → ` 串起来）：这份列表会长到 20 人，横着串起来在群里折成好几屏。
 */
export interface InitiativeView {
  scores?: Record<string, number>;
  gone?: ReadonlySet<string>;
}

export function formatInitiative(order: readonly string[], view: InitiativeView = {}): string {
  return order
    .map((name, index) => {
      const score = view.scores?.[name];
      const mark = view.gone?.has(name) ? '（倒下）' : '';
      return `${index + 1}. ${name}${score === undefined ? '' : ` ${score}`}${mark}`;
    })
    .join('\n');
}

/**
 * 顺序的**紧凑写法**：`阿飞 → 阿豪（倒下） → 教授`（P5）。
 *
 * 与 `formatInitiative` 的分工：这一份**一行装得下**，所以它是"回执里顺带说一句现在什么局面"
 * 与"日志里留一条记录"用的；`formatInitiative` 那份一行一个，是排完先攻时的正式公布。
 * 两份都不印数值 —— 见 `InitiativeView` 那段（数值只给模型）。
 *
 * **日志那一处必须用它**：`appendLog` 的正文会镜像进战报（P6 要导出成文件发群），
 * 而战报是**给人看的**；多行的日志正文会破掉"一条日志一行"这个形状。
 */
export function formatOrder(order: readonly string[], gone?: ReadonlySet<string>): string {
  return order.map((name) => (gone?.has(name) ? `${name}（倒下）` : name)).join(' → ');
}
