// 跑团规则引擎 · 骰子表达式（**纯函数**，没有任何 I/O、没有全局状态）
//
// ── 为什么单独一个模块、且必须纯 ──
//
// 掷骰是跑团里唯一"错了会毁掉整局信任"的东西：玩家会拿结果去质疑 DM，而 DM 是模型，
// 它说不清自己怎么算的。所以这里守三条：
//   ① **可复现** —— 随机源 `rng` 是参数，测试注入确定序列就能逐面核对；
//   ② **可复核** —— 结果里保留**每一颗骰子的面值**（含被 kh/kl 丢掉的），
//      于是"6+5+4=15"能被当场验算，而不是只给一个总数；
//   ③ **可解释的失败** —— 解析不了就抛 `DiceError`，文案是给模型/群友看的
//      （工具会把 `error.message` 原样回给模型，换成"表达式错误"等于什么都没说）。
//
// 刻意**只支持一种骰子组**（`3d6+2`），不做 `2d6+1d4` 那种多组相加：多组会引出
// "kh 作用于哪一组"、"结果怎么展示"一连串歧义，而跑团里绝大多数场合用不到。
// 要掷两组就调两次 —— 这个取舍写在错误文案里，让模型知道下一步该干什么。

/** 随机源：返回 `[0, 1)`。默认 `Math.random`；测试注入确定序列。 */
export type DiceRng = () => number;

/**
 * 规则引擎的输入错误。**带 `code`**：文案是给人（模型/群友）看的，`code` 是给日志看的 ——
 * 两者受众不同，压成一个字段的状态码，日志里就只剩一句中文长句，没法聚合。
 * 形状照 `media/task-error.ts` 的先例。
 */
export class DiceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'DiceError';
    this.code = code;
  }
}

/** 一次掷骰的完整事实。 */
export interface DiceRoll {
  /** 归一化后的表达式（去掉空白、小写化），回显给玩家看的就是它。 */
  expr: string;
  /** 骰子颗数。纯数字表达式时为 0。 */
  count: number;
  /** 每颗骰子的面数（最大值）。纯数字表达式时为 0。 */
  faces: number;
  /**
   * **每一颗骰子的面值，按掷出顺序，含被丢掉的** —— 这是"可复核"的全部依据。
   * 只留 `kept` 的话，"我掷了 4 颗为什么只算 3 颗"就无从验证。
   */
  dice: number[];
  /** `kh`/`kl` 之后留下的那些，**按原始掷出顺序**（不是排序后的）。 */
  kept: number[];
  /** 被 kh/kl 丢掉的颗数。 */
  dropped: number;
  /** 固定修饰值（`2d6+3` 里的 `3`）。 */
  modifier: number;
  /** `kept` 之和 + `modifier`。 */
  total: number;
}

/** 表达式长度上限。真正防的是"把一整段话当表达式传进来"。 */
const MAX_EXPR_CHARS = 64;
/** 单次最多掷几颗。防 `999999d999999` 把进程打爆 —— 那是一个真实的拒绝服务面。 */
const MAX_DICE = 100;
const MIN_FACES = 2;
const MAX_FACES = 1000;

/** 支持的形态，出错时原样附在文案里（模型照着它就能改对）。 */
const SYNTAX_HINT = '支持 3d6、d20、1d100、2d6+3、2d6-1、4d6kh3（留高）、4d6kl3（留低），'
  + '也可以直接给一个数（如 12）；**一次只能掷一组骰子**，要掷两组就调两次';

/**
 * 解析并掷一次骰。**同一个 `rng` 序列必得同一个结果**（可复现）。
 *
 * `expr` 收 `unknown` 而不是 `string`：调用方拿到的是工具参数里的 `unknown`（JSON 里可能是
 * 数字、可能是 null），在这里归一化比在每个调用点各写一遍 `String(x ?? '')` 好 ——
 * 后者会漂移，而漂移的表现是"某个入口的报错文案不同"。
 */
export function rollDice(expr: unknown, rng: DiceRng = Math.random): DiceRoll {
  const normalized = String(expr ?? '').replace(/\s+/g, '').toLowerCase();
  if (!normalized) {
    throw new DiceError('EMPTY', `骰子表达式是空的 —— 写一个吧，${SYNTAX_HINT}`);
  }
  if (normalized.length > MAX_EXPR_CHARS) {
    throw new DiceError('TOO_LONG', `骰子表达式太长了（最多 ${MAX_EXPR_CHARS} 个字符，收到 ${normalized.length} 个）`);
  }

  // 形态固定为「一组骰子 + 一个可选修饰」，或者干脆一个数。
  const matched = /^(?:(\d*)d(\d+)(?:(kh|kl)(\d+))?|(\d+))([+-]\d+)?$/.exec(normalized);
  if (!matched) {
    throw new DiceError('SYNTAX', `骰子表达式看不懂：「${String(expr ?? '')}」（${SYNTAX_HINT}）`);
  }

  const [, rawCount, rawFaces, keepMode, rawKeep, rawPlain, rawModifier] = matched;
  const modifier = rawModifier ? Number(rawModifier) : 0;

  // ── 纯数字：没有任何骰子 ──
  if (rawPlain !== undefined) {
    const flat = Number(rawPlain) + modifier;
    return {
      expr: normalized, count: 0, faces: 0, dice: [], kept: [], dropped: 0, modifier, total: flat
    };
  }

  // `d20` 这种省略颗数的写法 = 1 颗。
  const count = rawCount === '' ? 1 : Number(rawCount);
  const faces = Number(rawFaces);
  if (!Number.isFinite(count) || count < 1 || count > MAX_DICE) {
    throw new DiceError('DICE_COUNT', `骰子颗数要在 1–${MAX_DICE} 之间，收到 ${count}`);
  }
  if (!Number.isFinite(faces) || faces < MIN_FACES || faces > MAX_FACES) {
    throw new DiceError('DICE_FACES', `骰子面数要在 ${MIN_FACES}–${MAX_FACES} 之间，收到 ${faces}`);
  }

  const dice: number[] = [];
  for (let i = 0; i < count; i++) dice.push(rollOne(faces, rng));

  let kept = dice;
  if (keepMode) {
    const keep = Number(rawKeep);
    if (!Number.isFinite(keep) || keep < 1 || keep > count) {
      throw new DiceError('KEEP_COUNT', `${keepMode} 的保留颗数要在 1–${count} 之间，收到 ${rawKeep}`);
    }
    // 留下最高/最低的 keep 颗，但**按原始顺序**返回 —— 丢掉的顺序信息比排序好看更重要
    // （展示层要印"4d6 → 6+1+5+3，留 6+5+3"时，靠的就是原始顺序）。
    const picked = new Set(
      [...dice.keys()].sort((a, b) => (keepMode === 'kh' ? dice[b] - dice[a] : dice[a] - dice[b])).slice(0, keep)
    );
    kept = dice.filter((_, index) => picked.has(index));
  }

  return {
    expr: normalized,
    count,
    faces,
    dice,
    kept,
    dropped: dice.length - kept.length,
    modifier,
    total: kept.reduce((sum, value) => sum + value, 0) + modifier
  };
}

/**
 * 掷一颗骰。
 *
 * `rng` 是**注入的**，所以它可能返回任何东西（测试会故意注入边界值）。这里把它夹回合法区间
 * 而不是抛错：一个坏的随机源不该让整次掷骰失败，而"夹一下"是唯一能保证结果仍在 `[1, faces]`
 * 的做法 —— 越界的面值会让 `total` 变成谁也算不出来的怪数，比抛错难查得多。
 */
function rollOne(faces: number, rng: DiceRng): number {
  const value = Number(rng());
  const safe = Number.isFinite(value) ? Math.min(0.999999999, Math.max(0, value)) : 0;
  return Math.floor(safe * faces) + 1;
}
