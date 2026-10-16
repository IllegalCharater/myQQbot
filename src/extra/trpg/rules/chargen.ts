// **属性生成与派生值**（P4，决策 3：先做 COC 7 版这一套）。
//
// ── 为什么是纯函数目录里的一个文件 ──
//
// 属性是"一次掷定、之后一直用"的数字，所以它的正确性与掷骰同级 —— `rules/` 的门是
// "给定 `rng` 必得同一结果"（`check-layers.mjs` 机检），于是套件能注入固定 `rng` 逐面核对。
// 它不许 import 任何外部模块（连 `node:` 都不许），熵源由调用方**注入**。
//
// ── 那三种掷法 ──
//
//   • `3d6*5`：STR / CON / DEX / APP / POW（3-18 的属性，乘 5 成百分制）
//   • `(2d6+6)*5`：SIZ / INT / EDU（人类体型/智力/教育的下限更高）
// 掷法是**规则文件里的数据**（`RuleFile.chargen`），这里只负责掷与算。
//
// ── 派生值：认死几个名字 ──
//
// HP 要 CON 与 SIZ、MP 要 POW、DB/Build 要 STR+SIZ、MOV 要 STR/DEX/SIZ。这些公式是
// **COC7 的知识**，所以它们是代码；而规则文件那边只声明"这几个属性怎么掷"。
// ⚠️ **代价**：管理员把 `CON` 改名成 `体质` 之后，HP 就派生不出来了 —— 那种情况会**明说**
// 缺了谁（`derive` 返回 `missing`），而不是算出一个错数。
import { rollDice } from './dice.js';
import type { DiceRng } from './dice.js';

/** 规则文件里的 `chargen` 段（形状按 COC7 设计，见 `rules/check.ts` 的说明）。 */
export interface ChargenSpec {
  /**
   * 属性名 → 掷法（`rules/dice.ts` 的语法，如 `3d6*5` / `(2d6+6)*5`）。
   *
   * ⚠️ 上面那几个派生公式**认这几个名字**，所以键名不是随便起的。
   */
  attributes: Record<string, string>;
}

/** 派生出来的那一组（COC7 的算法）。 */
export interface Derived {
  /** HP 上限 = `(CON + SIZ) / 10`，向下取整。 */
  hpMax: number;
  /** MP 上限 = `POW / 5`，向下取整。 */
  mpMax: number;
  /** SAN 上限 = `POW`。 */
  sanMax: number;
  /** 伤害加值，形如 `+1d4` / `-2` / `0` —— **它是一条掷骰表达式**，不是数字。 */
  db: string;
  /** 体格（与 DB 同一行给出）。 */
  build: number;
  /** 移动力：STR 与 DEX 都比 SIZ 小 → 7；都不小 → 9；否则 8。 */
  mov: number;
}

/** 一次属性生成的产物。 */
export interface ChargenResult {
  stats: Record<string, number>;
  derived: Partial<Derived>;
  /** 派生不出来的成因（缺哪个属性）—— 空数组 = 全算出来了。 */
  missing: string[];
}

/**
 * COC7 的 DB / Build 表：**按 STR+SIZ 查档**。
 *
 * 每一行 `[上限（含）, DB, Build]`，按顺序取第一个 `total <= 上限` 的。最后一行是兜底。
 * 用 `3d6*5` + `(2d6+6)*5` 掷出来时 STR+SIZ 落在 30–180，也就是前五行；后面几行是给
 * 手改过属性（或将来别的掷法）留的。
 */
const DB_TABLE: ReadonlyArray<readonly [number, string, number]> = [
  [64, '-2', -2],
  [84, '-1', -1],
  [124, '0', 0],
  [164, '+1d4', 1],
  [204, '+1d6', 2],
  [284, '+2d6', 3],
  [364, '+3d6', 4],
  [444, '+4d6', 5],
  [Number.POSITIVE_INFINITY, '+5d6', 6]
];

/** 派生值要读的属性名。**写明的常量**：它们就是上面那几个公式里的字母。 */
const ATTR = { str: 'STR', con: 'CON', siz: 'SIZ', dex: 'DEX', pow: 'POW' } as const;

/**
 * 按属性算派生值。
 *
 * **缺哪个属性就少算哪一项**（而不是整组报废）：`missing` 里报出缺的名字，调用方据此说一句
 * "HP/DB 这几项没算出来（缺 CON、SIZ）"。逐项独立是有意的 —— 改一个名字不该把另外几项
 * 也一起弄没。
 */
export function derive(stats: Record<string, number>): { derived: Partial<Derived>; missing: string[] } {
  const derived: Partial<Derived> = {};
  const missing = new Set<string>();
  // ⚠️ **不能短路**：一组里缺两个时只报第一个的话，`missing` 就是半句话，而它唯一的用途
  // 正是"告诉人该补哪几个名字"。
  const need = (...names: string[]): number[] | null => {
    const out: number[] = [];
    let lacking = false;
    for (const name of names) {
      const value = stats[name];
      if (typeof value !== 'number' || !Number.isFinite(value)) { missing.add(name); lacking = true; continue; }
      out.push(value);
    }
    return lacking ? null : out;
  };

  const hp = need(ATTR.con, ATTR.siz);
  if (hp) derived.hpMax = Math.max(1, Math.floor((hp[0] + hp[1]) / 10));

  const pow = need(ATTR.pow);
  if (pow) {
    derived.mpMax = Math.max(0, Math.floor(pow[0] / 5));
    derived.sanMax = Math.max(0, Math.floor(pow[0]));
  }

  const muscle = need(ATTR.str, ATTR.siz);
  if (muscle) {
    const total = muscle[0] + muscle[1];
    const row = DB_TABLE.find(([cap]) => total <= cap) ?? DB_TABLE[DB_TABLE.length - 1];
    derived.db = row[1];
    derived.build = row[2];
  }

  const move = need(ATTR.str, ATTR.dex, ATTR.siz);
  if (move) {
    const [str, dex, siz] = move;
    if (str < siz && dex < siz) derived.mov = 7;
    else if (str >= siz && dex >= siz) derived.mov = 9;
    else derived.mov = 8;
  }

  return { derived, missing: [...missing] };
}

/**
 * 掷一整套属性并算派生。**同一份 `spec` + 同一个 `rng` 序列必得同一结果**（`rules/` 那条门）。
 *
 * 掷法是数据、公式是代码，两者在这里合流：先按 `spec.attributes` 逐个掷，再拿掷出来的数
 * 去 `derive`。
 */
export function rollChargen(spec: ChargenSpec, rng: DiceRng): ChargenResult {
  const stats: Record<string, number> = {};
  for (const [name, expr] of Object.entries(spec.attributes ?? {})) {
    const key = String(name).trim();
    if (!key) continue;
    const roll = rollDice(expr, rng);
    stats[key] = roll.total;
  }
  const { derived, missing } = derive(stats);
  return { stats, derived, missing };
}
