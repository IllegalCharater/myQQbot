// 跑团规则引擎 · 骰子表达式（**纯函数**，没有任何 I/O、没有全局状态、**不 import 本目录之外的任何东西**）
//
// ── 为什么单独一个模块、且必须纯 ──
//
// 掷骰是跑团里唯一"错了会毁掉整局信任"的东西：玩家会拿结果去质疑 DM，而 DM 是模型，
// 它说不清自己怎么算的。所以这里守三条：
//   ① **可复现** —— 随机源 `rng` 是**必填参数**，测试注入确定序列就能逐面核对；
//   ② **可复核** —— 结果里保留**每一颗骰子的面值**（含被 kh/kl 丢掉的），
//      于是"6+5+4=15"能被当场验算，而不是只给一个总数；
//   ③ **可解释的失败** —— 解析不了就抛 `DiceError`，文案是给模型/群友看的
//      （工具会把 `error.message` 原样回给模型，换成"表达式错误"等于什么都没说）。
//
// `rng` 没有默认值是刻意的：给一个默认值（比如 `Math.random`）会让"忘了注入"变成静默的，
// 而症状恰好就是"掷骰可被预测"。真熵源在 `../entropy.ts`，由调用方递进来。
// 本目录受 `scripts/check-layers.mjs` 的闸门约束（相对 import 不许离开 `rules/`，
// 非相对 import 一律禁止），所以它永远能脱离平台独立测试。
//
// ── 文法 ──
//
// 采用 [OneDice 标准](https://github.com/OlivOS-Team/onedice)的子集，用**递归下降**而不是正则：
// 正则无法处理 `(2d6+3)*2` 这类嵌套，也无法在出错时指出是哪个字符。
//
//     expression := term (("+" | "-") term)*
//     term       := unary (("*" | "/") unary)*
//     unary      := ("+" | "-") unary | power
//     power      := primary ["^" unary]                    # `^` 右结合、优先级高于乘除
//     primary    := dice | percentile | NUMBER | "(" expression ")"
//     dice       := [NUMBER] "d" [NUMBER] [KEEP [NUMBER]] [MODIFIER [NUMBER]]
//     KEEP       := "kh" | "kl" | "k" | "q"
//     MODIFIER   := "b" | "p"
//     percentile := ("b" | "p") [NUMBER]
//
// **不做**：骰池（`a`）、双重十字（`c`）、命运骰（`f`）、多元组与循环。这三样在 OneDice 里
// 各自引出一套独立的语义（面值集合、成功计数、正负抵消），而跑团的绝大多数场合用不到；
// 遇到它们会明确说出"不支持"并给出支持的形态，而不是报一句"语法错误"。
//
// **关于 `kh`/`kl` 与 `k`/`q`**：`kh`/`kl` 是本仓库既有的写法（`/掷骰` 用法提示、提示词目录、
// 既有断言都用它），`k`/`q` 是 OneDice 的写法。两种都接受，`k` ≡ `kh`（留高）、`q` ≡ `kl`（留低）。
// 这一点与 DiceRobot 有意不同：它因为 OneDice 里 `kl` 另有含义（取结果最小值）而只用 `q`；
// 本模块不做多元组，`kl` 没有冲突语义，留着它才不会打红既有断言。
import { PERCENTILE_FACES, formatPercentile, rollPercentile } from './percentile.js';
import type { PercentileRoll } from './percentile.js';

/** 随机源：返回 `[0, 1)`。**必填** —— 见文件头那段说明。 */
export type DiceRng = () => number;

/**
 * 规则引擎的输入错误。**带 `code`**：文案是给人（模型/群友）看的，`code` 是给日志看的 ——
 * 两者受众不同，压成一个字段的状态码，日志里就只剩一句中文长句，没法聚合。
 * 形状照 `media/task-error.ts` 的先例。
 *
 * `position` 只有语法错误才有：指出出错的字符在**归一化后**的表达式里的下标（0 基）。
 */
export class DiceError extends Error {
  readonly code: string;
  readonly position: number | null;
  constructor(code: string, message: string, position: number | null = null) {
    super(message);
    this.name = 'DiceError';
    this.code = code;
    this.position = position;
  }
}

/** 一组骰子的一次掷出。**逐颗留档**是"可复核"的全部依据。 */
export interface DiceGroup {
  /** 骰子颗数。奖惩骰组也一样（一次 `2db3` 就是 2 颗 d100）。 */
  count: number;
  /** 每颗骰子的面数。奖惩骰组恒为 100。 */
  faces: number;
  /** 每一颗的面值，**按掷出顺序，含被 kh/kl 丢掉的**。 */
  dice: number[];
  /** `kh`/`kl` 之后留下的那些，**按原始掷出顺序**（不是排序后的）。 */
  kept: number[];
  /** 被 kh/kl 丢掉的颗数。 */
  dropped: number;
  /**
   * 奖惩骰的展开（十位骰与个位骰）。**只在"一组一颗"时给** —— 多颗逐颗展开会让回执过长，
   * 那时看 `dice` 就够了。展示层按"字段在不在"决定印不印（同仓库其他可选字段的规矩）。
   */
  percentile?: PercentileRoll;
}

/** 一次掷骰的完整事实。 */
export interface DiceRoll {
  /** 归一化后的表达式（去空白、小写、全角折算），回显给玩家看的就是它。 */
  expr: string;
  /**
   * **除骰子之外的全部贡献**，即 `total − Σkept`。
   *
   * 一组骰子加常数时它就是这个常识意义上的"修饰值"（`2d6+3` 是 3，也是既有断言钉的那个）；
   * 表达式的其余部分（乘除、别的骰子组、括号）体现在 `groups` 与 `detail` 里。
   * 保留它是因为"`total = Σkept + modifier`"是既有消费者与断言读的对外契约。
   */
  modifier: number;
  /** 每一组的掷出明细，按求值顺序（左到右）。纯数字表达式时为空。 */
  groups: DiceGroup[];
  /** 算式明细（如 `(4+3+3)×2`）—— 让"这个总数是怎么来的"能当场验算。 */
  detail: string;
  /**
   * 全部组的面值，按顺序拼接。单组时就是那一组。
   * `groups.length !== 1` 时 `count`/`faces` 没有单一含义（`faces` 记 0），需要精确值请看 `groups`。
   */
  dice: number[];
  /** 全部组保留下来的面值，按顺序拼接。 */
  kept: number[];
  /** 全部组丢掉的颗数合计。 */
  dropped: number;
  /** 全部组的颗数合计。 */
  count: number;
  /** 单组时的面数；多组或纯数字时为 0（见 `dice` 的说明）。 */
  faces: number;
  /** 最终取值。 */
  total: number;
}

/** 表达式长度上限。真正防的是"把一整段话当表达式传进来"。 */
const MAX_EXPR_CHARS = 64;
/** 单次最多掷几颗。防 `999999d999999` 把进程打爆 —— 那是一个真实的拒绝服务面。 */
const MAX_DICE = 100;
const MIN_FACES = 2;
const MAX_FACES = 1000;
/** 一次最多追加几个奖惩骰。 */
const MAX_EXTRA = 10;
/** **整个表达式**的骰子颗数上限。单组上限可以用加法绕开（`60d6+60d6+60d6`），故需这一层。 */
const MAX_TOTAL_DICE = 200;
/** 乘方的指数上限。 */
const MAX_EXPONENT = 64;
/**
 * 乘方结果的规模上限，以二进制位数计。
 *
 * **53 = `Number.MAX_SAFE_INTEGER` 的位数**：JS 的数字都是双精度浮点，超过 53 位整数的运算就不再
 * 精确（`2**64 + 1 === 2**64`），而"算出一个谁也不认识的数"正是掷骰最不能出的错。
 * 估算取 `bitLength(base) * exponent`，是结果位数的**上界**，所以偏保守（`10^15` 会被拒，
 * 而它其实还在安全区内）—— 掷骰用不到那么大的数。
 */
const MAX_POWER_BITS = 53;
/** 未写明面数时用的面数（`d`、`2d`）。d100 是最常见的省略写法，也是各类规则书里的百分骰。 */
const DEFAULT_FACES = 100;

/** 支持的形态，出错时原样附在文案里（模型照着它就能改对）。 */
const SYNTAX_HINT = '支持 3d6、d20、1d100、2d6+3、2d6+1d4（多组相加）、4d6kh3/4d6kl3（留高/留低）、'
  + '(2d6+3)*2（括号与四则）、1d100b2/1d100p1（奖励骰/惩罚骰）；骰池(a)、双重十字(c)、命运骰(f) 不支持';

/** 输入端的等价写法统一折算为标准形式：全角来自中文输入法，`x` 作乘号是常见写法。 */
const NORMALIZE: Record<string, string> = {
  '（': '(', '）': ')',
  '×': '*', '✕': '*', 'x': '*', 'X': '*', '＊': '*',
  '÷': '/', '／': '/',
  '－': '-', '＋': '+', '＾': '^'
};

// 由上面那张表**派生**出匹配模式，而不是另写一个字符类：两份必然漂移，而漂移的表现是
// "某个写法在表里、却不生效"（`x` 作乘号就踩过这一次 —— 字符类里漏了它，报错说"不认识 x"）。
const NORMALIZE_PATTERN = new RegExp(`[${Object.keys(NORMALIZE).join('').replace(/[\\\]^-]/g, '\\$&')}]`, 'g');

/** 明确不做、但用户/模型很可能写出来的记号 —— 单独认出来，报错才说得清下一步。 */
const UNSUPPORTED_NOTES: Record<string, string> = {
  a: '骰池（a）',
  c: '双重十字（c）',
  f: '命运骰（f）'
};

// ── 词法 ─────────────────────────────────────────────────────────────────────

type TokenKind =
  | 'number' | 'dice' | 'keepHigh' | 'keepLow' | 'bonus' | 'penalty'
  | 'plus' | 'minus' | 'star' | 'slash' | 'caret' | 'lparen' | 'rparen' | 'end';

interface Token { kind: TokenKind; at: number; value: number }

const PUNCTUATION: Record<string, TokenKind> = {
  '+': 'plus', '-': 'minus', '*': 'star', '/': 'slash', '^': 'caret',
  '(': 'lparen', ')': 'rparen'
};

/** 归一化：全角折半角、大小写拉平、去掉全部空白。`expr` 回显的就是这一步的产物。 */
function normalize(expr: unknown): string {
  return String(expr ?? '')
    .replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(NORMALIZE_PATTERN, (char) => NORMALIZE[char] ?? char)
    .replace(/\s+/g, '')
    .toLowerCase();
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < text.length) {
    const char = text[index];

    if (char >= '0' && char <= '9') {
      const start = index;
      while (index < text.length && text[index] >= '0' && text[index] <= '9') index++;
      tokens.push({ kind: 'number', at: start, value: Number(text.slice(start, index)) });
      continue;
    }

    if (char === 'd') { tokens.push({ kind: 'dice', at: index, value: 0 }); index++; continue; }
    if (char === 'q') { tokens.push({ kind: 'keepLow', at: index, value: 0 }); index++; continue; }
    if (char === 'b') { tokens.push({ kind: 'bonus', at: index, value: 0 }); index++; continue; }
    if (char === 'p') { tokens.push({ kind: 'penalty', at: index, value: 0 }); index++; continue; }
    if (char === 'k') {
      // `kh` / `kl` 是本仓库的写法，`k` 是 OneDice 的简写，两者等价。
      const next = text[index + 1];
      const low = next === 'l';
      tokens.push({ kind: low ? 'keepLow' : 'keepHigh', at: index, value: 0 });
      index += low || next === 'h' ? 2 : 1;
      continue;
    }

    const punctuation = PUNCTUATION[char];
    if (punctuation) { tokens.push({ kind: punctuation, at: index, value: 0 }); index++; continue; }

    const unsupported = UNSUPPORTED_NOTES[char];
    throw new DiceError('SYNTAX',
      unsupported
        ? `骰子表达式里的 ${unsupported} 不在支持的范围内（${SYNTAX_HINT}）`
        : `骰子表达式第 ${index + 1} 个字符 ${JSON.stringify(char)} 不认识（${SYNTAX_HINT}）`,
      index);
  }

  tokens.push({ kind: 'end', at: text.length, value: 0 });
  return tokens;
}

// ── 语法树 ───────────────────────────────────────────────────────────────────

type BinaryOperator = '+' | '-' | '*' | '/' | '^';
type UnaryOperator = '+' | '-';

interface NumberNode { kind: 'number'; value: number }
interface DiceNode {
  kind: 'dice';
  /** `null` = 未写明，按 1 处理。 */
  count: number | null;
  /** `null` = 未写明。普通骰按 100（d100 是最常见的省略写法），奖惩骰固定 100。 */
  faces: number | null;
  /** `null` = 全部计入。 */
  keep: number | null;
  keepLowest: boolean;
  /** `null` = 这不是奖惩骰。 */
  extra: number | null;
  penalty: boolean;
}
interface UnaryNode { kind: 'unary'; operator: UnaryOperator; operand: Node }
interface BinaryNode { kind: 'binary'; operator: BinaryOperator; left: Node; right: Node }
type Node = NumberNode | DiceNode | UnaryNode | BinaryNode;

class Parser {
  #tokens: Token[];
  #index = 0;

  constructor(tokens: Token[]) {
    this.#tokens = tokens;
  }

  parse(): Node {
    const node = this.#expression();
    const token = this.#peek();
    if (token.kind !== 'end') {
      throw new DiceError('SYNTAX',
        `骰子表达式第 ${token.at + 1} 个字符之后有多余的内容 —— 每种写法都读不通（${SYNTAX_HINT}）`,
        token.at);
    }
    return node;
  }

  #peek(): Token { return this.#tokens[this.#index]; }

  #advance(): Token { return this.#tokens[this.#index++]; }

  #accept(...kinds: TokenKind[]): Token | null {
    return kinds.includes(this.#peek().kind) ? this.#advance() : null;
  }

  #expect(kind: TokenKind, message: string): Token {
    const token = this.#accept(kind);
    if (!token) throw new DiceError('SYNTAX', message, this.#peek().at);
    return token;
  }

  #expression(): Node {
    let node = this.#term();
    while (true) {
      const token = this.#accept('plus', 'minus');
      if (!token) return node;
      node = { kind: 'binary', operator: token.kind === 'plus' ? '+' : '-', left: node, right: this.#term() };
    }
  }

  #term(): Node {
    let node = this.#unary();
    while (true) {
      const token = this.#accept('star', 'slash');
      if (!token) return node;
      node = { kind: 'binary', operator: token.kind === 'star' ? '*' : '/', left: node, right: this.#unary() };
    }
  }

  #unary(): Node {
    const token = this.#accept('plus', 'minus');
    if (token) return { kind: 'unary', operator: token.kind === 'plus' ? '+' : '-', operand: this.#unary() };
    return this.#power();
  }

  #power(): Node {
    const node = this.#primary();
    // 右操作数递归回 #unary，因而 `^` 右结合（`2^3^2` = `2^(3^2)`），且指数可以带正负号。
    if (this.#accept('caret')) {
      return { kind: 'binary', operator: '^', left: node, right: this.#unary() };
    }
    return node;
  }

  #primary(): Node {
    if (this.#accept('lparen')) {
      const node = this.#expression();
      this.#expect('rparen', `骰子表达式的括号没有闭合（${SYNTAX_HINT}）`);
      return node;
    }

    if (this.#peek().kind === 'dice') return this.#dice(null);

    // 独立的 `b` / `p` 即一颗带奖惩骰的 d100（`.r b`、`.r p2`）。
    if (this.#peek().kind === 'bonus' || this.#peek().kind === 'penalty') {
      return { kind: 'dice', count: null, faces: null, keep: null, keepLowest: false, ...this.#modifier() };
    }

    const number = this.#accept('number');
    if (number) {
      // 数字后紧跟 `d` 才构成骰子，否则是普通字面量。
      if (this.#peek().kind === 'dice') return this.#dice(number.value);
      // `2b3` 的左值在 OneDice 里没有意义。不实现没有语义的参数，直接指出正确写法。
      if (this.#peek().kind === 'bonus' || this.#peek().kind === 'penalty') {
        throw new DiceError('SYNTAX',
          `奖惩骰不能写骰数 —— 一次要掷多颗请写成 2db3 这种形式（${SYNTAX_HINT}）`, this.#peek().at);
      }
      return { kind: 'number', value: number.value };
    }

    throw new DiceError('SYNTAX', `骰子表达式这里需要一个数字、骰子或括号（${SYNTAX_HINT}）`, this.#peek().at);
  }

  #dice(count: number | null): DiceNode {
    this.#advance();   // 消耗 `d`
    const faces = this.#accept('number');
    let keep: number | null = null;
    let keepLowest = false;

    const keepToken = this.#accept('keepHigh', 'keepLow');
    if (keepToken) {
      keepLowest = keepToken.kind === 'keepLow';
      // 只写 `k` 不写数量时保留一颗，与常见掷骰记法一致。
      keep = this.#accept('number')?.value ?? 1;
    }

    return {
      kind: 'dice', count, faces: faces ? faces.value : null, keep, keepLowest, ...this.#modifier()
    };
  }

  /** 解析跟在骰子之后的奖惩骰。未写明个数时追加一颗。 */
  #modifier(): { extra: number | null; penalty: boolean } {
    const token = this.#accept('bonus', 'penalty');
    if (!token) return { extra: null, penalty: false };
    return { extra: this.#accept('number')?.value ?? 1, penalty: token.kind === 'penalty' };
  }
}

// ── 求值 ─────────────────────────────────────────────────────────────────────

/**
 * 一个子式的求值结果。
 *
 * `detail` 是给模型/群友看的算式明细，`precedence` 决定拼接时要不要加括号。
 * `hasDice` 用来消歧：`2d6+1d4` 的明细若不加括号会读成"一次掷了三颗"。
 */
interface Evaluated {
  value: number;
  detail: string;
  precedence: number;
  hasDice: boolean;
}

const PRECEDENCE: Record<BinaryOperator, number> = { '+': 1, '-': 1, '*': 2, '/': 2, '^': 3 };
const UNARY_PRECEDENCE = 4;
const ATOM_PRECEDENCE = 5;

class Evaluator {
  #rng: DiceRng;
  #groups: DiceGroup[] = [];
  #totalDice = 0;
  /** 乘法在明细里用全角 `×`：与玩家手写的算式一致（同展示层的旧习惯）。 */
  static #SYMBOL: Record<BinaryOperator, string> = { '+': '+', '-': '-', '*': '×', '/': '÷', '^': '^' };

  constructor(rng: DiceRng) {
    this.#rng = rng;
  }

  get groups(): DiceGroup[] { return this.#groups; }

  visit(node: Node): Evaluated {
    switch (node.kind) {
      case 'number': return { value: node.value, detail: String(node.value), precedence: ATOM_PRECEDENCE, hasDice: false };
      case 'dice': return this.#visitDice(node);
      case 'unary': return this.#visitUnary(node);
      case 'binary': return this.#visitBinary(node);
    }
  }

  #visitDice(node: DiceNode): Evaluated {
    const count = node.count ?? 1;
    const group = node.extra !== null
      ? this.#rollPercentile(node, count, node.extra)
      : this.#rollFaces(node, count);

    this.#groups.push(group);
    const value = group.kept.reduce((sum, face) => sum + face, 0);
    // 奖惩骰只有一颗时展开十位骰（`25[奖励骰:6 0 1]`），那比一串数字更可复核。
    const expanded = group.percentile && group.count === 1 ? formatPercentile(group.percentile) : null;
    // 多颗骰子的明细自带 `+`，因而优先级记 1（它就是一条加法链）；一颗骰或已展开的奖惩骰是原子。
    return {
      value,
      detail: expanded ?? group.kept.join('+'),
      precedence: expanded || group.kept.length === 1 ? ATOM_PRECEDENCE : 1,
      hasDice: true
    };
  }

  #rollFaces(node: DiceNode, count: number): DiceGroup {
    const faces = node.faces ?? DEFAULT_FACES;
    this.#check(count, faces, node.keep, null);
    const dice = Array.from({ length: count }, () => this.#rollOne(faces));
    const kept = keepFaces(dice, node.keep, node.keepLowest);
    return { count, faces, dice, kept, dropped: dice.length - kept.length };
  }

  #rollPercentile(node: DiceNode, count: number, extra: number): DiceGroup {
    // 面数不接受 100 之外的取值：改面数无从解释，而静默忽略会让 `2d20b1` 看起来掷的是 d20。
    if (node.faces !== null && node.faces !== PERCENTILE_FACES) {
      throw new DiceError('DICE_FACES',
        `奖惩骰只能是 D${PERCENTILE_FACES}，面数请留空或写 ${PERCENTILE_FACES}（收到 d${node.faces}）`);
    }
    this.#check(count, PERCENTILE_FACES, node.keep, extra);
    const rolls = Array.from({ length: count }, () =>
      rollPercentile({ rng: this.#rng, extra, penalty: node.penalty }));
    const values = rolls.map((roll) => roll.value);
    const kept = keepFaces(values, node.keep, node.keepLowest);
    const group: DiceGroup = {
      count, faces: PERCENTILE_FACES, dice: values, kept, dropped: values.length - kept.length
    };
    // 只有一颗时展开十位骰：多颗逐一展开会让回执长到没法读。
    if (count === 1) group.percentile = rolls[0];
    return group;
  }

  #visitUnary(node: UnaryNode): Evaluated {
    const operand = this.visit(node.operand);
    const text = wrap(operand.detail, operand.precedence, UNARY_PRECEDENCE, false, '');
    return {
      value: node.operator === '-' ? -operand.value : operand.value,
      detail: node.operator + text,
      precedence: UNARY_PRECEDENCE,
      hasDice: operand.hasDice
    };
  }

  #visitBinary(node: BinaryNode): Evaluated {
    const left = this.visit(node.left);
    const right = this.visit(node.right);
    const precedence = PRECEDENCE[node.operator];
    // 加/减链里两边**都含骰子**时各自加括号：否则 `2d6+1d4` 的明细会变成一串没有边界的数字，
    // 读起来像"一次掷了三颗"。
    const separate = (node.operator === '+' || node.operator === '-') && left.hasDice && right.hasDice;
    const leftText = separate
      ? `(${left.detail})` : wrap(left.detail, left.precedence, precedence, false, node.operator);
    const rightText = separate
      ? `(${right.detail})` : wrap(right.detail, right.precedence, precedence, true, node.operator);

    return {
      value: this.#apply(node.operator, left.value, right.value),
      detail: `${leftText}${Evaluator.#SYMBOL[node.operator]}${rightText}`,
      precedence,
      hasDice: left.hasDice || right.hasDice
    };
  }

  #apply(operator: BinaryOperator, left: number, right: number): number {
    switch (operator) {
      case '+': return left + right;
      case '-': return left - right;
      case '*': return left * right;
      case '/':
        if (right === 0) throw new DiceError('DIV_ZERO', '骰子表达式里除零了 —— 除数不能是 0');
        // 全程整数运算，除法向下取整。
        return Math.floor(left / right);
      case '^': return this.#power(left, right);
    }
  }

  /**
   * 乘方。**规模必须在计算之前判断**：先算再检查会在 `9^9^9` 这类输入上耗尽内存。
   * 以底数的位数乘指数估算结果位数，估计偏保守。
   */
  #power(base: number, exponent: number): number {
    if (exponent < 0) {
      // 全程整数运算，负指数得不到整数结果。
      throw new DiceError('EXPONENT', `骰子表达式的指数不能是负数（收到 ${exponent}）`);
    }
    if (exponent > MAX_EXPONENT) {
      throw new DiceError('EXPONENT', `骰子表达式的指数最大 ${MAX_EXPONENT}（收到 ${exponent}）`);
    }
    const bits = Math.max(1, Math.abs(base).toString(2).length) * exponent;
    if (bits > MAX_POWER_BITS) {
      throw new DiceError('POWER_SIZE',
        `骰子表达式 ${base}^${exponent} 的结果过大（整数运算超过 ${MAX_POWER_BITS} 位就不精确了）—— 请把指数改小`);
    }
    return base ** exponent;
  }

  #check(count: number, faces: number, keep: number | null, extra: number | null): void {
    if (!Number.isFinite(count) || count < 1) {
      throw new DiceError('DICE_COUNT', `骰子颗数必须是正数（收到 ${count}）`);
    }
    if (count > MAX_DICE) {
      throw new DiceError('DICE_COUNT', `一次最多掷 ${MAX_DICE} 颗骰子（收到 ${count}）`);
    }
    this.#totalDice += count;
    // 单组上限可以用加法绕开（`60d6+60d6+60d6`），所以还要限制整个表达式的总量。
    if (this.#totalDice > MAX_TOTAL_DICE) {
      throw new DiceError('TOTAL_DICE',
        `整个表达式最多掷 ${MAX_TOTAL_DICE} 颗骰子（已经到 ${this.#totalDice} 颗）—— 分开掷几次吧`);
    }
    if (!Number.isFinite(faces) || faces < MIN_FACES) {
      throw new DiceError('DICE_FACES', `骰子面数至少 ${MIN_FACES}（收到 ${faces}）`);
    }
    if (faces > MAX_FACES) {
      throw new DiceError('DICE_FACES', `骰子最多 ${MAX_FACES} 面（收到 ${faces}）`);
    }
    if (keep !== null) {
      if (!Number.isFinite(keep) || keep < 1) {
        throw new DiceError('KEEP_COUNT', `保留的骰子颗数必须是正数（收到 ${keep}）`);
      }
      if (keep > count) {
        throw new DiceError('KEEP_COUNT', `保留的骰子颗数（${keep}）不能超过骰子总数（${count}）`);
      }
    }
    if (extra !== null) {
      if (!Number.isFinite(extra) || extra < 1) {
        throw new DiceError('EXTRA_COUNT', `奖惩骰的个数必须是正数（收到 ${extra}）`);
      }
      if (extra > MAX_EXTRA) {
        throw new DiceError('EXTRA_COUNT', `最多追加 ${MAX_EXTRA} 个奖惩骰（收到 ${extra}）`);
      }
    }
  }

  /**
   * 掷一颗骰。
   *
   * `rng` 是**注入的**，所以它可能返回任何东西（测试会故意注入边界值）。这里把它夹回合法区间
   * 而不是抛错：一个坏的随机源不该让整次掷骰失败，而"夹一下"是唯一能保证结果仍在 `[1, faces]`
   * 的做法 —— 越界的面值会让 `total` 变成谁也算不出来的怪数，比抛错难查得多。
   */
  #rollOne(faces: number): number {
    const value = Number(this.#rng());
    const safe = Number.isFinite(value) ? Math.min(0.999999999, Math.max(0, value)) : 0;
    return Math.floor(safe * faces) + 1;
  }
}

/** 留下最高/最低的 keep 颗。**按原始顺序**返回 —— 丢掉的顺序信息比排序好看更重要。 */
function keepFaces(faces: number[], keep: number | null, lowest: boolean): number[] {
  if (keep === null) return faces;
  const picked = new Set(
    [...faces.keys()].sort((a, b) => (lowest ? faces[a] - faces[b] : faces[b] - faces[a])).slice(0, keep)
  );
  return faces.filter((_, index) => picked.has(index));
}

/** 按运算优先级与结合性决定子式要不要加括号。 */
function wrap(text: string, precedence: number, parent: number, rightOperand: boolean, parentOperator: string): string {
  if (precedence < parent) return `(${text})`;
  if (precedence === parent) {
    // 减与除的右操作数需要括号（`1-(2-3)` 与 `1-2-3` 不等价）；右结合的乘方相反，需要括号的是左操作数。
    if (rightOperand && (parentOperator === '-' || parentOperator === '/')) return `(${text})`;
    if (!rightOperand && parentOperator === '^') return `(${text})`;
  }
  return text;
}

/**
 * 解析并掷一次骰。**同一个 `rng` 序列必得同一个结果**（可复现）。
 *
 * `expr` 收 `unknown` 而不是 `string`：调用方拿到的是工具参数里的 `unknown`（JSON 里可能是
 * 数字、可能是 null），在这里归一化比在每个调用点各写一遍 `String(x ?? '')` 好 ——
 * 后者会漂移，而漂移的表现是"某个入口的报错文案不同"。
 */
/**
 * 归一化 + 三条通用校验 + 解析。**掷之前那段公用就这一份**（`rollDice` 与 `parseDiceExpr` 共用）。
 *
 * 抽出来是为了**不重复解析**：`rollDice` 既要校验又要 AST，各写一遍就等于每掷一次解析两次。
 */
function parseChecked(expr: unknown): { text: string; node: Node } {
  const text = normalize(expr);
  if (!text) {
    throw new DiceError('EMPTY', `骰子表达式是空的 —— 写一个吧（${SYNTAX_HINT}）`, 0);
  }
  if (text.length > MAX_EXPR_CHARS) {
    throw new DiceError('TOO_LONG',
      `骰子表达式太长了（最多 ${MAX_EXPR_CHARS} 个字符，收到 ${text.length} 个）`, MAX_EXPR_CHARS);
  }
  return { text, node: new Parser(tokenize(text)).parse() };
}

/**
 * **只解析、不掷**。成功返回归一化后的表达式，失败抛 `DiceError`。
 *
 * 为什么需要一个不掷的入口：`intercept` 要在**每一条**入站消息上判断"这句是不是掷骰请求"，
 * 判完才真的掷一次。拿 `rollDice` 去试探等于每句话都白掷一遍（消耗熵，而且"这句话算不算请求"
 * 与"掷出来什么"两件事从此缠在一起）。
 */
export function parseDiceExpr(expr: unknown): string {
  return parseChecked(expr).text;
}

/**
 * OneDice 的几种前缀：`.r` / `。r` / `r`，后面可以跟空白。**只认这一种形态。**
 */
const DICE_PREFIX = /^[.。]?\s*r\s*/i;

/**
 * 这条消息是不是一句"**掷骰请求**"？是就返回要掷的那个表达式，不是返回 `null`。
 *
 * 两条判据，都必须是确定性的：
 *   ① 剥掉可选的 OneDice 前缀与首尾空白之后，**整条**消息就是一个合法表达式 —— **不做子串匹配**；
 *   ② 里面**至少要有一组 `NdM`**。少了这条的后果很具体：纯数字也是合法表达式（`12`），
 *      而群里那句"12"显然不是让人掷一个 12。
 *
 * ⚠️ **为什么不放宽成"包含 `NdB` 就算"**：中文没有分词，`我觉得3d6这骰子不错` 会被当成掷骰请求，
 * 而它只是一句话 —— 然后它会拿到一句"骰子表达式看不懂"。放宽一条规则容易，把误判收回来很难，
 * 同「提到我」那条子串标签的教训（AGENTS.md「是不是在叫我」）。
 *
 * ⚠️ **代价是知情的：判据是"整串能不能解析"，所以 `3d6x`（敲错了）与 `3d6 帮我看看`（半句话）
 * 都返回 `null`** —— 调用方对 `null` 的处理是"静默拦下"，于是这两种都**得不到任何回话**。
 * 想听到"看不懂"的走 `/掷骰 3d6x`（那条命令**不做**这层判据，`DiceError` 的文案原样进群）。
 * 放宽到这里就会把第二种变成一句语法错误 —— 而"帮我掷 3d6"是群里很正常的说法，
 * 对它回一句"看不懂"比沉默更糟。两条路都掷不出骰子，选安静的那条。
 */
export function looksLikeDiceRequest(text: unknown): string | null {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  const body = raw.replace(DICE_PREFIX, '').trim();
  if (!body || !/\d*d\d+/i.test(body)) return null;
  try {
    return parseDiceExpr(body);
  } catch {
    return null;
  }
}

export function rollDice(expr: unknown, rng: DiceRng): DiceRoll {
  const { text, node } = parseChecked(expr);
  const evaluator = new Evaluator(rng);
  const root = evaluator.visit(node);
  const groups = evaluator.groups;

  const kept = groups.flatMap((group) => group.kept);
  const dice = groups.flatMap((group) => group.dice);
  const keptSum = kept.reduce((sum, face) => sum + face, 0);

  return {
    expr: text,
    modifier: root.value - keptSum,
    groups,
    detail: groups.length ? root.detail : '',
    dice,
    kept,
    dropped: dice.length - kept.length,
    count: dice.length,
    faces: groups.length === 1 ? groups[0].faces : 0,
    total: root.value
  };
}
