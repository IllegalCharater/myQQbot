// 跑团规则引擎 · 检定（**纯函数**）
//
// ── 这一层的接缝在哪 ──
//
// "掷出来的这个数算不算成功"是**唯一与规则书绑定**的判断：COC 是掷低、百分制、六级成功；
// D&D 是掷高、d20 + 调整值、优势/劣势。把它写死在 `resolveCheck` 里就等于现在就选定了
// 一套规则书，而那恰恰是本模块刻意不做的决定。
//
// 所以判定被抽成一个**可替换的函数** `CheckJudge`：
//   • `resolveCheck` 负责机械部分（解析、掷骰、算差值），这些与规则书无关；
//   • `judge` 负责"算不算成功、算哪一档"，换规则书只换它。
// 默认给一个**保守的通用判定**（`total >= target` 即成功），它不假装知道任何规则书。
import { DiceError, rollDice } from './dice.js';
import type { DiceRng, DiceRoll } from './dice.js';

/**
 * 成功等级。
 *
 * ⚠️ 只有四档，是**通用**语义，不是任何一本书的六级分级：
 *   `critical` 大成功 / `success` 成功 / `failure` 失败 / `fumble` 大失败。
 * 接 COC 那种六级（大成功/极难/困难/常规/失败/大失败）时，扩展自己的 `CheckJudge`
 * 返回它自己的档位字符串，本模块不管 —— `CheckGrade` 是默认判定的取值域，不是全局封闭集。
 */
export type CheckGrade = 'critical' | 'success' | 'failure' | 'fumble';

/** 判定函数的入参。给足原始材料，因为不同规则书要的东西不同（差值 / 骰面 / 单骰还是多骰）。 */
export interface JudgeInput {
  /** `kept` 之和 + 修饰值。 */
  total: number;
  /** 每一颗骰子的面值（含被丢掉的）。 */
  dice: number[];
  /** kh/kl 之后留下的。 */
  kept: number[];
  /** 每颗骰子的面数 —— 判"掷出了最大值"要用它。 */
  faces: number;
  /** 目标值（难度）。 */
  target: number;
}

/**
 * "掷出来的这个数算不算成功"。**唯一与规则书相关的接缝**，换规则书只换它。
 *
 * 返回 `grade` 的字符串取值由实现自定（见 `CheckGrade` 的说明）；默认判定只吐那四档。
 */
export type CheckJudge = (input: JudgeInput) => { success: boolean; grade: string };

/**
 * 通用默认判定：**掷高**，`total >= target` 即成功。
 *
 * 大成功 / 大失败**只在单颗骰时**才判，因为多骰（尤其带 `kh`/`kl`）下"全最大值"没有公认语义 ——
 * 我们不替规则书发明一个。单骰时"掷出最大面 = 大成功、掷出 1 = 大失败"是跨系统最通行的读法
 * （`1d100` 掷出 100 / 1 正好也是 COC 那两个极端档）。
 *
 * ⚠️ 大失败**压过** `total >= target`：掷出 1 就是失败，哪怕难度设成 0。
 * 这正是"大失败"这个词的意思；如果某套规则不这么认为，那是它该提供自己的 `CheckJudge` 的理由。
 */
export const defaultJudge: CheckJudge = ({ total, dice, faces, target }) => {
  if (dice.length === 1) {
    if (faces > 1 && dice[0] === faces) return { success: true, grade: 'critical' };
    if (dice[0] === 1) return { success: false, grade: 'fumble' };
  }
  const success = total >= target;
  return { success, grade: success ? 'success' : 'failure' };
};

export interface CheckResult {
  /** 掷骰的完整事实（含每一颗骰面）—— 检定结果要能当场验算，不能只有一个成功/失败。 */
  roll: DiceRoll;
  target: number;
  success: boolean;
  grade: string;
  /** `total - target`。正数 = 超出多少，负数 = 差多少。给"差一点"这类叙事留素材。 */
  margin: number;
}

/**
 * 掷一次骰并判定。
 *
 * `rng` 与 `judge` 都可注入：前者为了可复现，后者为了换规则书。两者缺省时行为完全确定
 * （默认随机源除外）。
 */
export function resolveCheck(
  expr: unknown,
  target: unknown,
  { rng = Math.random, judge = defaultJudge }: { rng?: DiceRng; judge?: CheckJudge } = {}
): CheckResult {
  const goal = Number(target);
  if (!Number.isFinite(goal)) {
    throw new DiceError(
      'TARGET',
      `检定的目标值必须是一个数，收到「${String(target ?? '')}」——比如 "3d6 对 12" 里的 12`
    );
  }
  const roll = rollDice(expr, rng);
  const { success, grade } = judge({
    total: roll.total, dice: roll.dice, kept: roll.kept, faces: roll.faces, target: goal
  });
  return { roll, target: goal, success, grade, margin: roll.total - goal };
}
