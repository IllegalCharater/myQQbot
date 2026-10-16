// 跑团规则引擎 · 战斗（**纯函数**）
//
// ── 这一层管什么 ──
//
// 两件事：**先攻排序**（`rollInitiative`）与**指针推进**（`clampTurn` / `advance`）。
// 战斗状态本身（存在哪、长什么样、归一化）在 `model/combat.ts` —— 本目录不许有 I/O，
// 连 `node:` 都不许（`scripts/check-layers.mjs` 那条闸门）。
//
// ── 为什么"伤害"不在这里 ──
//
// 伤害的算术**已经有一处唯一实现**：`tools/character.ts` 的 `update` 分支（增量钳进
// `0…hpMax`，并把"从多少变到多少"写进日志）。把它抄到这里就是同一件事的第二份实现，
// 而两份必然漂移 —— 漂移的表现是"卡上写着 3 点 HP、日志里写着 8 点"，谁也不会去核对。
// 战斗这一层对伤害的**真实职责**是另一件事：**倒下的人不占回合**（见 `advance` 的 `skip`）。
//
// ── 为什么 `rng` 是必填参数 ──
//
// 与 `dice.ts` 同一条：真熵源住在 `entropy.ts`，由调用方注入。规则层没有默认随机源 ——
// 一个默认的 `Math.random` 会让"换熵源"变成没人看得见的改动。
import type { DiceRng } from './dice.js';

/**
 * 规则表没写 `initiative` 时按哪个属性排先攻。
 *
 * ⚠️ 它是**属性名**，不是掷骰表达式（对比 `RuleFile.dice` 那一栏）—— 先攻顺序用的是卡上
 * 已经有的数值，不是当场掷一次。**写明的常量**：改它等于改所有没声明这一栏的表的默认行为。
 */
export const DEFAULT_INITIATIVE = 'DEX';

/**
 * 一个参战者。
 *
 * `initiative: null` = **这张卡上没有那个属性**。它与 `0` 是两件事：0 是"这个人的 DEX 是 0"，
 * `null` 是"这张卡压根没写 DEX"。分不开的话，一次漏填属性会被读成"他先攻垫底"，
 * 而那是错的方向 —— 见 `InitiativeOrder.missing`。
 */
export interface Combatant {
  name: string;
  initiative: number | null;
  hp: number;
}

/** 掷出来的先攻顺序。`scores` 只含**真有那个属性**的人（渲染按"字段在不在"决定印不印）。 */
export interface InitiativeOrder {
  /** 名字，从先到后。 */
  order: string[];
  /** 名字 → 先攻值。没有那个属性的人**不在表里**（不是 `0`）。 */
  scores: Record<string, number>;
  /** 卡上没有那个属性的人。回执要点名，否则 DM 以为他们"先攻垫底"。 */
  missing: string[];
}

/** 回合指针。`turn` 是 `order` 的下标，`round` 从 1 起数。 */
export interface CombatPointer {
  turn: number;
  round: number;
}

/**
 * 取一个平手判据。
 *
 * 坏随机源（`NaN` / 越界 / 非数）一律夹成 `0` —— 与 `rollDice` 对注入 `rng` 的取舍同一条：
 * 一个坏源不该让排序崩掉，只该让平手退回"按名单顺序"。
 */
function nextRandom(rng: DiceRng): number {
  const value = Number(rng());
  if (!Number.isFinite(value) || value < 0 || value >= 1) return 0;
  return value;
}

/**
 * 掷先攻顺序。
 *
 * 排序键是**三段**：先攻值降序 → 平手判据升序 → 名单顺序升序。三段缺一不可：
 *   • 只按值排，平手的人顺序就由名单顺序决定 —— 每次开打都是同一批人先动；
 *   • 平手判据是**每人取一次**（而不是"只在平手时才取"），所以消耗的熵量恒等于人数，
 *     与 `rollDice` 那边"先算完再挑"同形，测试注入定值 `rng` 时也数得清。
 *
 * 没有那个属性的人按 `0` 参与排序（不是排除在外）：他们**得**有一个位置，
 * 否则轮到谁就断了。回执靠 `missing` 把这件事说出来。
 */
export function rollInitiative(combatants: readonly Combatant[], rng: DiceRng): InitiativeOrder {
  const missing: string[] = [];
  const scores: Record<string, number> = {};
  const rows = combatants.map((item, index) => {
    const value = item.initiative;
    if (value === null) missing.push(item.name);
    else scores[item.name] = value;
    return { name: item.name, score: value === null ? 0 : value, tie: nextRandom(rng), index };
  });
  rows.sort((a, b) => (b.score - a.score) || (a.tie - b.tie) || (a.index - b.index));
  return { order: rows.map((row) => row.name), scores, missing };
}

/**
 * 把指针下标夹回 `[0, size)`。`size <= 0` 时给 `0`。
 *
 * ⚠️ **负数也要夹**（`((n % size) + size) % size`）：存档是可以被手改的，而 `order[-1]`
 * 在 JS 里是 `undefined` —— 症状是**指针停在一个不存在的人身上，且不报任何错**，
 * 渲染那边只会印出一个空名字。取模那一步不能省。
 */
export function clampTurn(turn: unknown, size: number): number {
  if (!(size > 0)) return 0;
  const n = Math.trunc(Number(turn));
  if (!Number.isFinite(n)) return 0;
  return ((n % size) + size) % size;
}

/**
 * 把指针往前推一格，**跳过 `skip` 里的人**（卡没了的、已经倒下的）。
 *
 * 三条边界：
 *   • **最多走 `size` 步**：全员都动不了时不能无限转，走满一圈就停；
 *   • **转回起点算一轮**（`round + 1`）；
 *   • **全员动不了时返回 `{ turn: 起点, round }`** —— 注意 `round` **不加一**。
 *     那一圈已经在循环里数过了：起点在 `[0, size)`，而恰好走 `size` 步必然绕回起点一次，
 *     所以走到这里时 `round` 已经是"下一轮"了。再 `+1` 会让一次全员昏迷**跳掉两轮**。
 */
export function advance(
  order: readonly string[],
  pointer: CombatPointer,
  skip: ReadonlySet<string> = new Set()
): CombatPointer {
  const size = order.length;
  if (size <= 0) return { turn: 0, round: pointer.round };
  const start = clampTurn(pointer.turn, size);
  let turn = start;
  let round = pointer.round;
  for (let step = 0; step < size; step++) {
    turn += 1;
    if (turn >= size) { turn = 0; round += 1; }
    if (!skip.has(order[turn])) return { turn, round };
  }
  return { turn: start, round };
}
