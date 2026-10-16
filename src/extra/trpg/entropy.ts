// 跑团扩展的**唯一熵源**。
//
// ── 为什么它不在 `rules/` 里 ──
//
// `rules/` 那一层是纯函数目录（不许 import 到该目录之外，由 `scripts/check-layers.mjs` 机检），
// 而真熵源要 `node:crypto`。所以熵源住在这里，由 `tools/` / `commands/` / `impl.ts` **注入**进规则层。
//
// ── 为什么不能用 `Math.random` ──
//
// 掷骰结果直接影响游戏进程，而玩家会盯着点数看。`Math.random` 是 xorshift128+，内部状态可从
// 少量输出反推 —— 一个能预测下一个点数的群友就毁掉了整局信任。DiceRobot 为同一条理由用了
// `random.SystemRandom()`（`plugins/dice.py:23-24`：「掷骰结果直接影响游戏进程，不应存在
// 可预测的序列」）。
//
// ⚠️ **规则层没有默认随机源**（`rollDice` 的 `rng` 是必填参数）：默认值的存在会让"忘了注入"
// 变成静默的，而症状恰好就是"掷骰可被预测"。改成必填后 `tsc` 会拦下每一个漏掉的调用点。
import { randomInt } from 'node:crypto';
import type { DiceRng } from './rules/dice.js';

/**
 * 密码学随机的 `[0, 1)`。
 *
 * `2 ** 32` 既是上界也是分母：`randomInt` 要求区间宽度小于 2⁴⁸（不是小于等于），2³² 留了充足余量；
 * 用它做分母，商精确落在 `[0, 1)`，而且 `randomInt` 本身是无偏的（它做了拒绝采样）。
 * 32 位熵对掷骰绰绰有余 —— 面数上限 1000 只用到 10 位。
 */
export const secureRng: DiceRng = () => randomInt(0, 2 ** 32) / 2 ** 32;
