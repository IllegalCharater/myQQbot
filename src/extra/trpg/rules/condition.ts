// 跑团规则引擎 · 检定条件的表达式求值（**纯函数**，零 import）
//
// ── 它服务的对象是**管理员写的规则文件** ──
//
// `data/trpg/rules/<id>.json` 每一级的 `condition` 是一段表达式，比如 `roll <= target // 5`。
// 那是**用户内容**，所以第一原则是**不许执行任意代码**：白名单之外的一切（函数调用、属性访问、
// 下标、赋值、分号、注释、字符串）一律拒绝并指出出错位置。**绝不用 `eval` / `new Function`。**
//
// ── 文法 ──
//
//     expression   := or
//     or           := and ("or" and)*
//     and          := not ("and" not)*
//     not          := "not" not | comparison
//     comparison   := additive (("<" | "<=" | ">" | ">=" | "==" | "!=") additive)?
//     additive     := multiplicative (("+" | "-") multiplicative)*
//     multiplicative := unary (("*" | "/" | "//" | "%") unary)*
//     unary        := ("+" | "-") unary | primary
//     primary      := NUMBER | VARIABLE | "(" expression ")"
//
// ── 变量（七个，全是数）──
//
//   `total` 合计 ｜ `target` 目标值/技能值 ｜ `count` 骰子颗数 ｜ `faces` 面数（多组时为 0）
//   `roll` **单颗骰的面值**（不是单颗时是 0）｜ `max` / `min` 所有骰面的最大/最小
//
// 这七个够逐字表达本仓库内置的两套规则表（含 `generic` 那条"单颗骰掷出最大面算大成功"）——
// "数据化没有表达力损失"这件事由 `t-trpg-rules.mjs` 的等价性断言钉住，不靠嘴说。
//
// ── 除法的两种写法（**与骰子表达式有意不同**）──
//
// `/` 是**真除法**（`roll / 2` 在 roll=7 时是 3.5），`//` 是**向下取整**（照 Python）。
// 规则书里的"五分之一"该写 `// 5`。⛔ 别把它和 `dice.ts` 里那个"全程整数、除法向下取整"
// 混起来：那是**掷骰**的语义，这是**判定**的语义，两处各自写在各自文件头。
// 两种除法除零都**抛错**（不是给个 `Infinity` 让后面的比较悄悄变成 false —— 那是最难查的一类）。

/** 条件的求值上下文。全是标量：数组归 `max`/`min` 这一层消化，见文件头。 */
export interface ConditionVars {
  total: number;
  target: number;
  count: number;
  faces: number;
  /** **单颗骰的面值**；不是单颗时恒为 0。 */
  roll: number;
  max: number;
  min: number;
}

/** 表达式无法编译。`position` 是出错字符的下标（0 基），文案要能直接给人看。 */
export class ConditionError extends Error {
  readonly position: number;
  constructor(message: string, position: number) {
    super(message);
    this.name = 'ConditionError';
    this.position = position;
  }
}

type Value = number | boolean;
type Thunk = (vars: ConditionVars) => Value;

/** 变量表。**只认这七个** —— 多一个都可能变成绕过白名单的口子。 */
const VARIABLES: readonly (keyof ConditionVars)[] = ['total', 'target', 'count', 'faces', 'roll', 'max', 'min'];

/** 支持形态，出错时原样附在文案里（人照着它就能改对）。 */
const HINT = `支持的写法：数字、七个变量（${VARIABLES.join(' / ')}）、`
  + '`+ - * / // %`、比较（< <= > >= == !=）、`and` / `or` / `not` 与括号；不支持函数调用、下标、注释';

export const MAX_CONDITION_CHARS = 200;

/**
 * 把一段条件表达式编译成谓词。**加载规则时调一次**，之后每级判定只调这个闭包。
 *
 * Raises:
 *   `ConditionError`：无法解析、超长、或含有白名单之外的写法。
 */
export function compileCondition(source: unknown): (vars: ConditionVars) => boolean {
  const text = String(source ?? '');
  if (!text.trim()) throw new ConditionError(`判定条件是空的 —— ${HINT}`, 0);
  if (text.length > MAX_CONDITION_CHARS) {
    throw new ConditionError(`判定条件太长了（最多 ${MAX_CONDITION_CHARS} 个字符，收到 ${text.length} 个）`, MAX_CONDITION_CHARS);
  }
  const parser = new Parser(tokenize(text), text);
  const thunk = parser.parseAll();
  return (vars) => truthy(thunk(vars));
}

/** 一个值的"真"：布尔就是它自己，数字非零为真（同 Python/JS 的常规读法）。 */
function truthy(value: Value): boolean {
  return typeof value === 'boolean' ? value : value !== 0;
}

function asNumber(value: Value, at: number, what: string): number {
  if (typeof value === 'number') return value;
  throw new ConditionError(`${what}要是一个数，这里拿到的是一个真假值 —— 别把比较结果拿去算数`, at);
}

// ── 词法 ─────────────────────────────────────────────────────────────────────

type Kind =
  | 'number' | 'ident' | 'plus' | 'minus' | 'star' | 'slash' | 'slashslash' | 'percent'
  | 'lt' | 'le' | 'gt' | 'ge' | 'eq' | 'ne' | 'lparen' | 'rparen' | 'end';

interface Token { kind: Kind; at: number; value: number; name: string }

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < text.length) {
    const char = text[index];

    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') { index++; continue; }

    if (char >= '0' && char <= '9') {
      const start = index;
      while (index < text.length && text[index] >= '0' && text[index] <= '9') index++;
      if (text[index] === '.') {
        index++;
        while (index < text.length && text[index] >= '0' && text[index] <= '9') index++;
      }
      tokens.push({ kind: 'number', at: start, value: Number(text.slice(start, index)), name: '' });
      continue;
    }

    // 标识符：字母/下划线开头，后面可以跟字母数字下划线。中文变量名**有意不支持** ——
    // 变量表是固定的七个英文名，放开中文只会让"拼错了却不报错"变得更常见。
    if (/[A-Za-z_]/.test(char)) {
      const start = index;
      while (index < text.length && /[A-Za-z0-9_]/.test(text[index])) index++;
      tokens.push({ kind: 'ident', at: start, value: 0, name: text.slice(start, index) });
      continue;
    }

    const two = text.slice(index, index + 2);
    if (two === '//') { tokens.push({ kind: 'slashslash', at: index, value: 0, name: '' }); index += 2; continue; }
    if (two === '<=') { tokens.push({ kind: 'le', at: index, value: 0, name: '' }); index += 2; continue; }
    if (two === '>=') { tokens.push({ kind: 'ge', at: index, value: 0, name: '' }); index += 2; continue; }
    if (two === '==') { tokens.push({ kind: 'eq', at: index, value: 0, name: '' }); index += 2; continue; }
    if (two === '!=') { tokens.push({ kind: 'ne', at: index, value: 0, name: '' }); index += 2; continue; }

    const single: Record<string, Kind> = {
      '+': 'plus', '-': 'minus', '*': 'star', '/': 'slash', '%': 'percent',
      '<': 'lt', '>': 'gt', '(': 'lparen', ')': 'rparen'
    };
    const kind = single[char];
    if (kind) { tokens.push({ kind, at: index, value: 0, name: '' }); index++; continue; }

    // `=`（单个）、`&`、`|`、`!`、`;`、`#`、引号…… 都会落到这里。
    throw new ConditionError(`判定条件第 ${index + 1} 个字符 ${JSON.stringify(char)} 不认识（${HINT}）`, index);
  }

  tokens.push({ kind: 'end', at: text.length, value: 0, name: '' });
  return tokens;
}

// ── 语法分析（顺带求值：每个节点直接编成一个闭包）──────────────────────────────

class Parser {
  #tokens: Token[];
  #index = 0;
  #source: string;

  constructor(tokens: Token[], source: string) {
    this.#tokens = tokens;
    this.#source = source;
  }

  parseAll(): Thunk {
    const thunk = this.#or();
    const token = this.#peek();
    if (token.kind !== 'end') {
      // ⚠️ 这一条同时挡住**分号与注释**：`roll == 1; true` 与 `roll == 1 # 注释` 都会在这里断。
      throw new ConditionError(
        `判定条件第 ${token.at + 1} 个字符之后有多余的内容（${JSON.stringify(this.#source.slice(token.at, token.at + 12))}）—— ${HINT}`,
        token.at);
    }
    return thunk;
  }

  #peek(): Token { return this.#tokens[this.#index]; }

  #accept(...kinds: Kind[]): Token | null {
    return kinds.includes(this.#peek().kind) ? this.#tokens[this.#index++] : null;
  }

  /** 关键字读法：当前记号是标识符且名字等于 `word`。 */
  #acceptWord(word: string): Token | null {
    const token = this.#peek();
    return token.kind === 'ident' && token.name === word ? this.#tokens[this.#index++] : null;
  }

  #or(): Thunk {
    let left = this.#and();
    while (this.#acceptWord('or')) {
      const right = this.#and();
      const head = left;
      left = (vars) => truthy(head(vars)) || truthy(right(vars));
    }
    return left;
  }

  #and(): Thunk {
    let left = this.#not();
    while (this.#acceptWord('and')) {
      const right = this.#not();
      const head = left;
      left = (vars) => truthy(head(vars)) && truthy(right(vars));
    }
    return left;
  }

  #not(): Thunk {
    const token = this.#acceptWord('not');
    if (!token) return this.#comparison();
    const operand = this.#not();
    return (vars) => !truthy(operand(vars));
  }

  #comparison(): Thunk {
    const left = this.#additive();
    const token = this.#accept('lt', 'le', 'gt', 'ge', 'eq', 'ne');
    if (!token) return left;
    const right = this.#additive();
    const at = token.at;
    const op = token.kind;
    return (vars) => {
      const a = asNumber(left(vars), at, '比较的一边');
      const b = asNumber(right(vars), at, '比较的另一边');
      switch (op) {
        case 'lt': return a < b;
        case 'le': return a <= b;
        case 'gt': return a > b;
        case 'ge': return a >= b;
        case 'eq': return a === b;
        case 'ne': return a !== b;
        default: return false;
      }
    };
  }

  #additive(): Thunk {
    let left = this.#multiplicative();
    while (true) {
      const token = this.#accept('plus', 'minus');
      if (!token) return left;
      const right = this.#multiplicative();
      const head = left;
      const add = token.kind === 'plus';
      const at = token.at;
      left = (vars) =>
        (add ? asNumber(head(vars), at, '加号左边') + asNumber(right(vars), at, '加号右边')
          : asNumber(head(vars), at, '减号左边') - asNumber(right(vars), at, '减号右边'));
    }
  }

  #multiplicative(): Thunk {
    let left = this.#unary();
    while (true) {
      const token = this.#accept('star', 'slash', 'slashslash', 'percent');
      if (!token) return left;
      const right = this.#unary();
      const head = left;
      const op = token.kind;
      const at = token.at;
      left = (vars) => {
        const a = asNumber(head(vars), at, '运算符左边');
        const b = asNumber(right(vars), at, '运算符右边');
        if (op === 'star') return a * b;
        if (b === 0) {
          throw new ConditionError(
            op === 'percent' ? '判定条件里对一个数取了余数，而除数是 0' : '判定条件里除零了 —— 除数这一项在有些取值下会是 0',
            at);
        }
        if (op === 'slash') return a / b;          // 真除法（`roll / 2` 在 roll=7 时是 3.5）
        if (op === 'slashslash') return Math.floor(a / b);
        return a % b;
      };
    }
  }

  #unary(): Thunk {
    const token = this.#accept('plus', 'minus');
    if (token) {
      const operand = this.#unary();
      if (token.kind === 'plus') return operand;
      const at = token.at;
      return (vars) => -asNumber(operand(vars), at, '负号后面');
    }
    return this.#primary();
  }

  #primary(): Thunk {
    if (this.#accept('lparen')) {
      const inner = this.#or();
      if (!this.#accept('rparen')) {
        throw new ConditionError(`判定条件的括号没有闭合（第 ${this.#peek().at + 1} 个字符处）—— ${HINT}`, this.#peek().at);
      }
      return inner;
    }

    const number = this.#accept('number');
    if (number) return () => number.value;

    const ident = this.#accept('ident');
    if (ident) {
      if ((VARIABLES as readonly string[]).includes(ident.name)) {
        return (vars) => vars[ident.name as keyof ConditionVars];
      }
      if (ident.name === 'true') return () => true;
      if (ident.name === 'false') return () => false;
      // 函数调用会在这里被挡住：`sqrt(` 走到这里就报"不认识的变量"，而调用语法根本没有对应分支。
      throw new ConditionError(
        `判定条件第 ${ident.at + 1} 个字符处的「${ident.name}」不是可用变量`
        + `（可用的只有：${VARIABLES.join(' / ')}，另有 true / false）—— ${HINT}`,
        ident.at);
    }

    throw new ConditionError(`判定条件在这里需要一个数、一个变量或一个括号（${HINT}）`, this.#peek().at);
  }
}
