// 跑团规则引擎 · 奖惩骰（**纯函数**）
//
// ── 它是 d100 的一种特殊掷法，不是"另一套判定" ──
//
// 奖励骰与惩罚骰来自 COC：d100 实际由一个**十位骰**与一个**个位骰**掷出。追加若干个十位骰后
// 共 n+1 个候选，奖励骰取结果**最小**的那个、惩罚骰取**最大**的那个，个位骰始终只掷一次。
// 它改变的是"怎么掷出这个 d100"，不改变"这个数算不算成功" —— 所以判定层（`check.ts`）
// 完全不需要知道它存在。掷骰引擎与检定共用本模块。
//
// ⚠️ **必须先组合成结果再比较**（下面 `combine` 的注释）—— 这条写错会让大成功永远掷不出来，
// 而且是一半的边界情况才暴露。
import type { DiceRng } from './dice.js';

export const BONUS_LABEL = '奖励骰';
export const PENALTY_LABEL = '惩罚骰';

/** 奖惩骰固定 D100：这类骰子以十位骰与个位骰定义，面数不是可选项（见 `dice.ts` 的报错）。 */
export const PERCENTILE_FACES = 100;

/**
 * 把十位骰与个位骰组合为 1 到 100 的结果。
 *
 * 十位与个位**都是 0** 时结果是 100 —— 所以个位为 0、十位掷出 0 与 9 时候选是 **100 与 90**，
 * 奖励骰取 90；若改比十位数字则会取到 0，反而得出 100，**大成功将永远掷不出**。
 * 组合之后再比较是唯一正确的顺序。
 */
export function combine(tens: number, units: number): number {
  return tens === 0 && units === 0 ? 100 : tens * 10 + units;
}

/** 一次 d100 的完整事实（含被舍弃的十位骰，供当场验算）。 */
export interface PercentileRoll {
  /** 最终采用的结果（1–100）。 */
  value: number;
  /** 个位骰。 */
  units: number;
  /** 全部十位骰，首个为基础骰、其余为追加的奖惩骰，按掷出顺序。 */
  tens: number[];
  /** 追加的是惩罚骰。没有追加骰时该字段无意义。 */
  penalty: boolean;
  /** 基础 d100，即首个十位骰与个位骰的组合。 */
  base: number;
}

/**
 * 掷一次 d100（可带奖惩骰）。
 *
 * `rng` **必填**：规则层没有默认随机源，`tsc` 会拦下漏掉的调用点（见 `entropy.ts`）。
 */
export function rollPercentile({ rng, extra = 0, penalty = false }: {
  rng: DiceRng; extra?: number; penalty?: boolean;
}): PercentileRoll {
  const units = rollDigit(rng);
  const tens: number[] = [];
  for (let i = 0; i <= extra; i++) tens.push(rollDigit(rng));
  const candidates = tens.map((one) => combine(one, units));
  return {
    value: penalty ? Math.max(...candidates) : Math.min(...candidates),
    units,
    tens,
    penalty,
    base: combine(tens[0], units)
  };
}

/**
 * 展开为 `52[奖励骰:3 6 9]`；没有追加骰时即结果本身。
 *
 * 方括号里是**追加的十位骰原值**。不写成 `10`：那会被读作结果 100，而十位 0 只在个位也是 0 时
 * 才记 100，否则是 01 到 09。
 */
export function formatPercentile(roll: PercentileRoll): string {
  if (roll.tens.length === 1) return String(roll.value);
  const label = roll.penalty ? PENALTY_LABEL : BONUS_LABEL;
  return `${roll.base}[${label}:${roll.tens.slice(1).join(' ')}]`;
}

/**
 * 掷一个十位/个位数字。
 *
 * `rng` 是注入的、可能返回任何东西（测试会故意喂边界值），所以这里把它**夹回** `[0, 1)` 而不是抛错：
 * 一个坏的随机源不该让整次掷骰失败，而越界的数字会让两个候选变成一个怪结果，比抛错难查得多。
 * 与 `dice.ts` 的 `rollOne` 是同一条取舍（那边夹的是 `[1, faces]`）。
 */
function rollDigit(rng: DiceRng): number {
  const value = Number(rng());
  const safe = Number.isFinite(value) ? Math.min(0.999999999, Math.max(0, value)) : 0;
  return Math.floor(safe * 10);
}
