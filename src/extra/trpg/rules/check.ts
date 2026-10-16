// 跑团规则引擎 · 检定（**纯函数**）
//
// ── 这一层的接缝在哪 ──
//
// "掷出来的这个数算不算成功"是**唯一与规则书绑定**的判断：COC 是掷低、百分制、六级成功；
// D&D 是掷高、d20 + 调整值、优势/劣势。把它写死在判定里就等于现在就选定了某一套规则书。
//
// 所以判定被抽成一张**有序等级表**：`resolveCheck` 负责机械部分（解析、掷骰、算差值），
// 这些与规则书无关；`CheckRule` 负责"算不算成功、算哪一档"，换规则书只换一张表。
//
// ⚠️ **顺序即优先级**：`check()` 取首个匹配的等级，所以大成功、大失败这类特例必须排在
// 普通成功之前 —— 否则技能值达到 100 时，掷出的 100 会被判成"成功"。
//
// ⚠️ **表的最后一条必须无条件匹配**。这条不是风格要求：漏了它，某组取值会一个等级都匹配
// 不上，而故障要等玩家恰好掷出那个点数才暴露（DiceRobot 为此在加载时穷举全部取值，
// 见 `rules.py:184-203`）。本模块把同一件事放进 `tests/t-trpg-rules.mjs` 的穷举断言里。
import { DiceError, rollDice } from './dice.js';
import type { DiceRng, DiceRoll } from './dice.js';

/** 判定函数的入参。给足原始材料，因为不同规则书要的东西不同（差值 / 骰面 / 单骰还是多骰）。 */
export interface JudgeInput {
  /** `kept` 之和（表达式的最终取值）。 */
  total: number;
  /** 每一颗骰子的面值（含被丢掉的）。 */
  dice: number[];
  /** kh/kl 之后留下的。 */
  kept: number[];
  /** **单组时**的面数 —— 判"掷出了最大值"、认"这是不是一个百分骰"都要用它。多组时为 0。 */
  faces: number;
  /** 目标值（难度 / 技能值）。 */
  target: number;
}

/** 一个结果等级。 */
export interface CheckLevel {
  /**
   * 等级标识。**对外就是 `CheckResult.grade`** —— 通用那套用的是四档
   * `critical` / `success` / `failure` / `fumble`（跨规则书最通行的语义），
   * 别的规则表可以返回自己的字符串，展示层认不出来就原样印。
   */
  name: string;
  /** 给群友看的中文名。 */
  label: string;
  /** 这一档算不算成功。 */
  success: boolean;
  matches: (input: JudgeInput) => boolean;
}

/** 一套检定规则。**顺序即优先级**（见文件头）。 */
export interface CheckRule {
  id: string;
  name: string;
  levels: readonly CheckLevel[];
  /**
   * 这套规则接受什么样的掷骰。返回非空字符串 = 不接受，内容是要回给模型的原因。
   *
   * 有它是因为**规则表可以被显式选中而不匹配**：选着 COC 却掷了 `3d6`，两条 `roll <= skill`
   * 之类的判据会给出一个"看起来正常"的错误答案。静默算错是这一层最坏的失败模式，所以宁可拒绝。
   */
  accepts?: (input: JudgeInput) => string | null;
}

/**
 * "掷出来的这个数算不算成功"。**唯一与规则书相关的接缝**，换规则书只换它。
 *
 * 保留这个形状是因为它是一份**对外契约**：`resolveCheck` 的 `judge` 选项、以及既有断言
 * 按它读默认判定。规则表（`CheckRule`）是更完整的形态 —— 它多带了等级的中文名与适用前提。
 * 只需要一个函数时就用它；需要一套完整规则时用 `CheckRule`。
 */
export type CheckJudge = (input: JudgeInput) => { success: boolean; grade: string };

/** 通用默认判定背后的那张表。`defaultJudge` 就是它的一层薄封装（见下），两处不会漂移。 */
export const GENERIC_RULE: CheckRule = {
  id: 'generic',
  name: '通用（掷高为佳）',
  levels: [
    // 大成功 / 大失败**只在单颗骰时**才判：多骰（尤其带 kh/kl）下"全最大值"没有公认语义 ——
    // 我们不替规则书发明一个。单骰时"掷出最大面 = 大成功、掷出 1 = 大失败"是跨系统最通行的读法。
    {
      name: 'critical', label: '大成功', success: true,
      matches: ({ dice, faces }) => dice.length === 1 && faces > 1 && dice[0] === faces
    },
    // 大失败**压过** `total >= target`：掷出 1 就是失败，哪怕难度设成 0。那正是"大失败"的意思。
    { name: 'fumble', label: '大失败', success: false, matches: ({ dice }) => dice.length === 1 && dice[0] === 1 },
    { name: 'success', label: '成功', success: true, matches: ({ total, target }) => total >= target },
    { name: 'failure', label: '失败', success: false, matches: () => true }
  ]
};

/** COC 7 版常用的六级检定。判据照规则书：`skill` 是技能值（即 `target`），`roll` 是 d100 骰面。 */
export const COC7_RULE: CheckRule = {
  id: 'coc7',
  name: 'COC 7 版检定',
  accepts: (input) => (percentileFace(input) === null
    ? 'COC 7 版检定要掷 1d100（技能检定是百分骰）—— 当前掷的不是单颗 d100。改用 1d100，'
      + '或把这一局的规则表换成 generic（在 campaign 的 action=start 里用 rule 指定）'
    : null),
  levels: [
    { name: 'critical', label: '大成功', success: true, matches: (input) => percentileFace(input) === 1 },
    {
      // 骰出 100 一律大失败；技能值小于 50 时，96 以上也是。
      name: 'fumble', label: '大失败', success: false,
      matches: (input) => {
        const roll = percentileFace(input);
        return roll === 100 || (roll !== null && roll >= 96 && input.target < 50);
      }
    },
    { name: 'extreme', label: '极难成功', success: true, matches: (input) => atMost(input, 5) },
    { name: 'hard', label: '困难成功', success: true, matches: (input) => atMost(input, 2) },
    { name: 'success', label: '成功', success: true, matches: (input) => atMost(input, 1) },
    { name: 'failure', label: '失败', success: false, matches: () => true }
  ]
};

/** 可选的规则表。**id 是配置里写的那个字符串**（`campaign.rule`）。 */
export const LEVEL_RULES: readonly CheckRule[] = [GENERIC_RULE, COC7_RULE];

/** 按 id 取规则表；认不出来一律回落到通用那套（不抛错 —— 它是读取路径，不是写入路径）。 */
export function getCheckRule(id: unknown): CheckRule {
  const key = String(id ?? '').trim().toLowerCase();
  return LEVEL_RULES.find((rule) => rule.id === key) ?? GENERIC_RULE;
}

/**
 * 通用默认判定：**掷高**，`total >= target` 即成功。
 *
 * ⚠️ 大失败**压过** `total >= target`：掷出 1 就是失败，哪怕难度设成 0。
 * 这正是"大失败"这个词的意思；如果某套规则不这么认为，那是它该提供自己的 `CheckRule` 的理由。
 */
export const defaultJudge: CheckJudge = (input) => {
  const level = check(GENERIC_RULE, input);
  return { success: level.success, grade: level.name };
};

/**
 * 取首个匹配的等级。
 *
 * Raises:
 *   `DiceError('RULE')`：这套规则不接受这次掷骰，或一个等级都没匹配上（后者说明表写漏了
 *   —— 最后一条应当无条件匹配；启动期的穷举断言就是为了让它永远不在运行期发生）。
 */
export function check(rule: CheckRule, input: JudgeInput): CheckLevel {
  const refusal = rule.accepts?.(input);
  if (refusal) throw new DiceError('RULE', refusal);
  for (const level of rule.levels) {
    if (level.matches(input)) return level;
  }
  throw new DiceError('RULE',
    `检定规则「${rule.name}」没有覆盖这一组取值（合计 ${input.total}、目标 ${input.target}）`
    + '—— 最后一条等级应当无条件匹配');
}

export interface CheckResult {
  /** 掷骰的完整事实（含每一颗骰面）—— 检定结果要能当场验算，不能只有一个成功/失败。 */
  roll: DiceRoll;
  target: number;
  success: boolean;
  grade: string;
  /** 这一档的中文名（来自规则表）。自定义 `judge` 没有它，展示层按 `grade` 查表兜底。 */
  label?: string;
  /** `total - target`。正数 = 超出多少，负数 = 差多少。给"差一点"这类叙事留素材。 */
  margin: number;
}

/**
 * 掷一次骰并判定。
 *
 * `rng` **必填**（见 `dice.ts` 与 `entropy.ts`）。`rule` 与 `judge` 二选一：
 * 给了 `judge` 就用它（自定义判定的老路），否则用 `rule`（缺省通用那套）。
 */
export function resolveCheck(
  expr: unknown,
  target: unknown,
  { rng, judge, rule }: { rng: DiceRng; judge?: CheckJudge; rule?: CheckRule }
): CheckResult {
  const goal = Number(target);
  if (!Number.isFinite(goal)) {
    throw new DiceError(
      'TARGET',
      `检定的目标值必须是一个数，收到「${String(target ?? '')}」——比如 "3d6 对 12" 里的 12`
    );
  }
  const roll = rollDice(expr, rng);
  const input: JudgeInput = {
    total: roll.total, dice: roll.dice, kept: roll.kept, faces: roll.faces, target: goal
  };
  const margin = roll.total - goal;

  if (judge) {
    const { success, grade } = judge(input);
    return { roll, target: goal, success, grade, margin };
  }
  const level = check(rule ?? GENERIC_RULE, input);
  return { roll, target: goal, success: level.success, grade: level.name, label: level.label, margin };
}

/** 单颗 d100 的骰面；不是单颗百分骰时给 `null`。 */
function percentileFace(input: JudgeInput): number | null {
  return input.dice.length === 1 && input.faces === 100 ? input.dice[0] : null;
}

/** `roll <= skill / divisor`，且必须是单颗百分骰。 */
function atMost(input: JudgeInput, divisor: number): boolean {
  const roll = percentileFace(input);
  return roll !== null && roll <= Math.floor(input.target / divisor);
}
