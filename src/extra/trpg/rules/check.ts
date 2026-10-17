// 跑团规则引擎 · 检定（**纯函数**）
//
// ── 这一层的接缝在哪 ──
//
// "掷出来的这个数算不算成功"是**唯一与规则书绑定**的判断：COC 是掷低、百分制、六级成功；
// D&D 是掷高、d20 + 调整值、优势/劣势。把它写死在判定里就等于现在就选定了某一套规则书。
//
// 所以判定被抽成一张**有序等级表**：`resolveCheck` 负责机械部分（解析、掷骰、算差值），
// 这些与规则书无关；`CheckRule` 负责"算不算成功、算哪一档"，换规则书只换一张表 —— 而**表本身
// 是数据**（`RuleFile`，一个 JSON），由 `../rule-store.ts` 从 `data/trpg/rules/<id>.json` 读进来。
// 本文件只做三件**纯**事：把数据**编译**成闭包（`compileRule`）、**穷举校验**它会不会漏
// （`verifyRule`）、按顺序**取档**（`check`）。读写文件在 `rule-store.ts` —— 本目录不许有 I/O。
//
// ⚠️ **顺序即优先级**：`check()` 取首个匹配的等级，所以大成功、大失败这类特例必须排在
// 普通成功之前 —— 否则技能值达到 100 时，掷出的 100 会被判成"成功"。
//
// ⚠️ **表的最后一条必须无条件匹配**（`condition: "true"`）。这条不是风格要求：漏了它，
// 某组取值会一个等级都匹配不上，而故障要等玩家恰好掷出那个点数才暴露 —— `verifyRule`
// 就是为此存在的，它在加载与设置页里都会跑。
import { ConditionError, compileCondition } from './condition.js';

/** 没写 `dice` 时技能检定掷什么。**写明的常量**：改它等于改所有老表的默认行为。 */
const DEFAULT_CHECK_DICE = '1d100';
import { DEFAULT_INITIATIVE } from './combat.js';
import { DiceError, parseDiceExpr, rollDice } from './dice.js';
import type { ChargenSpec } from './chargen.js';
import type { ConditionVars } from './condition.js';
import type { DiceRng, DiceRoll } from './dice.js';

/** 判定函数的入参。给足原始材料，因为不同规则书要的东西不同（差值 / 骰面 / 单骰还是多骰）。 */
export interface JudgeInput {
  /** `kept` 之和（表达式的最终取值）。 */
  total: number;
  /** 每一颗骰子的面值（含被丢掉的）。 */
  dice: number[];
  /** kh/kl 之后留下的。 */
  kept: number[];
  /** **单组时**的面数 —— 判"掷出了最大值"、认"这是一个百分骰"都要用它。多组时为 0。 */
  faces: number;
  /** 目标值（难度 / 技能值）。 */
  target: number;
}

/** 规则文件里的一级。**这是管理员在 `data/trpg/rules/*.json` 里写的形状。** */
export interface RuleLevelFile {
  /** 等级标识，对外就是 `CheckResult.grade`（如 `critical` / `extreme`）。 */
  name: string;
  /** 给群友看的中文名。 */
  label: string;
  /** 这一档算不算成功。 */
  success: boolean;
  /** 判定条件表达式，语法见 `condition.ts`。**按顺序取首个匹配**。 */
  condition: string;
}

/** 一份规则文件。 */
export interface RuleFile {
  id: string;
  name: string;
  description?: string;
  /**
   * 这套规则接受什么样的掷骰（可选）。条件为真 = 接受。
   *
   * 有它是因为**规则表可以被显式选中而不匹配**：选着 COC 却掷了 `3d6`，两条 `roll <= target`
   * 之类的判据会给出一个"看起来正常"的错误答案。静默算错是这一层最坏的失败模式，所以宁可拒绝。
   */
  requires?: { condition: string; message: string };
  /**
   * `.ra` / `.rh` 拿哪种骰子做技能检定（可选，**缺省 `1d100`**）。
   *
   * **为什么在规则文件里而不是写死在命令里**：技能检定掷什么骰是规则的一部分（COC 是 d100、
   * D&D 是 d20），而规则表本来就是数据。写死 d100 等于让所有用 d20 的团永远用不了 `.ra`。
   * 缺省 d100 与两套内置表一致，也让"没写这一栏的老表"照常能用。
   *
   * ⚠️ 它与 `requires` 是**两件事**：这一栏说"该掷什么"（`.ra` 照它去掷），
   * `requires` 说"接不接受"（掷出来的形状不合就拒绝）。写了 `requires` 的表最好也写这一栏，
   * 否则 `.ra` 会拿 d100 去撞一个只收 d20 的规则（那会被明确拒绝，但体验是"点一下报个错"）。
   */
  dice?: string;
  /**
   * **属性生成**（可选）。写一栏 = 这套规则支持"掷一套属性"（`.pc roll`），
   * 形状按 COC 7 版设计（决策 3：先做这一套）。
   *
   * ⚠️ **键名不是随便起的**：派生公式（HP 要 `CON`/`SIZ`、MP 要 `POW`、DB 要 `STR`+`SIZ`、
   * MOV 要 `STR`/`DEX`/`SIZ`）认的就是这几个名字，见 `rules/chargen.ts`。
   * 改了名不会算错 —— 那几项会**派生不出来**，并明说缺谁。
   */
  chargen?: ChargenSpec;
  /**
   * **排先攻用卡上哪个属性**（可选，P5）。缺省 `DEFAULT_INITIATIVE`（`DEX`）。
   *
   * ⚠️ 它是**属性名**，不是掷骰表达式 —— 与上面 `dice` 那一栏正好相反：先攻顺序用的是卡上
   * 已经有的数值，不掷。所以它**不在编译期被 `parseDiceExpr` 校验**（那样会把一个合法的属性名
   * `DEX` 判成"不是表达式"而拒绝整张表）；能校验的只有"非空字符串"，而缺省已经保证了这一条。
   *
   * 卡上没有这个属性的人按 0 参与排序，并被点名（`InitiativeOrder.missing`）——
   * 改名不会算错，只会让所有人一起"垫底"并被告知缺的是哪个属性。
   */
  initiative?: string;
  levels: RuleLevelFile[];
}

/** 编译后的一级。 */
export interface CheckLevel {
  name: string;
  label: string;
  success: boolean;
  matches: (input: JudgeInput) => boolean;
}

/** 编译后的一套规则。**顺序即优先级**（见文件头）。 */
export interface CheckRule {
  id: string;
  name: string;
  description: string;
  /** 技能检定该掷的表达式（`.ra` 用它）。已在编译期校验过**解析得了**。 */
  dice: string;
  /** 属性生成的掷法（`.pc roll` 用它）。**没有这一栏 = 这套规则不支持掷属性**。 */
  chargen: ChargenSpec | null;
  /** 排先攻读卡上哪个属性（`.combat start` 用它）。**永远非空**（缺省 `DEFAULT_INITIATIVE`）。 */
  initiative: string;
  /** 上面那条 `requires` 编译成的东西；没写就是"什么形状都接受"。 */
  refuses: ((input: JudgeInput) => string | null) | null;
  levels: readonly CheckLevel[];
}

/** 规则文件本身有问题（结构不对、等级为空、条件编不过…）。`problems` 是逐条的原因。 */
export class RuleError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(problems.join('；'));
    this.name = 'RuleError';
    this.problems = problems;
  }
}

/**
 * 内置的两套规则表 —— **种子数据**，不是运行时的事实来源。
 *
 * `rule-store.ts` 在启动时把它们**补齐**到 `data/trpg/rules/` 下（缺哪个写哪个，已存在的一律
 * 不动），此后一律以文件为准：管理员改了、删了、加了自己的，都以磁盘上的为准。
 * 这与 `jmcomic.pythonPath` → `python.path`、`bookmarkFirst` → `bookmarkMode` 那两处迁移同一条
 * 取舍 —— 种子只负责"第一次启动时有个能用的东西"。
 */
export const BUILTIN_RULE_FILES: Readonly<Record<string, RuleFile>> = {
  generic: {
    id: 'generic',
    name: '通用（掷高为佳）',
    description: '含修饰的合计 ≥ 目标值即成功；只有单颗骰时才判大成功 / 大失败。',
    dice: '1d100',
    levels: [
      // 大成功 / 大失败**只在单颗骰时**才判：多骰（尤其带 kh/kl）下"全最大值"没有公认语义 ——
      // 我们不替规则书发明一个。单骰时"掷出最大面 = 大成功、掷出 1 = 大失败"是跨系统最通行的读法。
      { name: 'critical', label: '大成功', success: true, condition: 'count == 1 and faces > 1 and roll == faces' },
      // 大失败**压过** `total >= target`：掷出 1 就是失败，哪怕难度设成 0。那正是"大失败"的意思。
      { name: 'fumble', label: '大失败', success: false, condition: 'count == 1 and roll == 1' },
      { name: 'success', label: '成功', success: true, condition: 'total >= target' },
      { name: 'failure', label: '失败', success: false, condition: 'true' }
    ]
  },
  coc7: {
    id: 'coc7',
    name: 'COC 7 版检定',
    description: 'd100 技能检定，六个档位（大成功 / 极难 / 困难 / 成功 / 失败 / 大失败）。',
    dice: '1d100',
    // COC 7 版的属性掷法：3d6×5 那一组与 (2d6+6)×5 那一组（见 `rules/chargen.ts`）。
    // 派生值（HP/MP/SAN/DB/Build/MOV）由代码按同一份规则书算，不在这里声明。
    chargen: {
      attributes: {
        STR: '3d6*5', CON: '3d6*5', DEX: '3d6*5', APP: '3d6*5', POW: '3d6*5',
        SIZ: '(2d6+6)*5', INT: '(2d6+6)*5', EDU: '(2d6+6)*5'
      }
    },
    requires: {
      condition: 'count == 1 and faces == 100',
      message: 'COC 7 版检定要掷 1d100（技能检定是百分骰）'
    },
    levels: [
      { name: 'critical', label: '大成功', success: true, condition: 'roll == 1' },
      // 骰出 100 一律大失败；技能值小于 50 时，96 以上也是。
      { name: 'fumble', label: '大失败', success: false, condition: 'roll == 100 or (roll >= 96 and target < 50)' },
      { name: 'extreme', label: '极难成功', success: true, condition: 'roll <= target // 5' },
      { name: 'hard', label: '困难成功', success: true, condition: 'roll <= target // 2' },
      { name: 'success', label: '成功', success: true, condition: 'roll <= target' },
      { name: 'failure', label: '失败', success: false, condition: 'true' }
    ]
  }
};

/** `JudgeInput` → 条件表达式能看见的那七个标量（数组归 `max`/`min` 消化）。 */
export function toVars(input: JudgeInput): ConditionVars {
  const dice = input.dice;
  return {
    total: input.total,
    target: input.target,
    count: dice.length,
    faces: input.faces,
    // **不是单颗时 `roll` 恒为 0**（而不是"第一颗"）：那样 `roll == 1` 这类写法在多颗骰上
    // 会悄悄命中，而它显然不是在说那件事。写 0 让这种表在校验里就露出来。
    roll: dice.length === 1 ? dice[0] : 0,
    max: dice.length ? Math.max(...dice) : 0,
    min: dice.length ? Math.min(...dice) : 0
  };
}

/** 把一份规则文件编译成闭包。加载时调一次，之后每级判定只调编译出来的东西。 */
export function compileRule(file: RuleFile): CheckRule {
  const problems: string[] = [];
  if (!file || typeof file !== 'object') throw new RuleError(['规则文件不是一个对象']);
  const id = String(file.id ?? '').trim();
  const name = String(file.name ?? '').trim();
  if (!id) problems.push('缺少 id');
  if (!name) problems.push('缺少 name');
  if (!Array.isArray(file.levels) || !file.levels.length) problems.push('levels 不能为空');
  // `dice` 只在写错了的时候才有话说：它会被 `.ra` 拿去真的掷，拼错的表现是"点一下报个
  // 看不懂的语法错"。放在编译期拦下来，与其余"坏表拒绝"同一条判据。
  const dice = String(file.dice ?? '').trim() || DEFAULT_CHECK_DICE;
  try {
    parseDiceExpr(dice);
  } catch (error) {
    problems.push(`dice「${dice}」不是一个能掷的表达式：${error instanceof Error ? error.message : String(error)}`);
  }
  // `initiative` 与 `dice` 不同：它是**属性名**，没有"能不能掷"可言，所以只做"非空"这一条
  // （缺省已经保证）。刻意不拿 `parseDiceExpr` 试它 —— 那会把 `DEX` 判成语法错、拒绝整张表。
  const initiative = String(file.initiative ?? '').trim() || DEFAULT_INITIATIVE;

  const levels: CheckLevel[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of (Array.isArray(file.levels) ? file.levels : []).entries()) {
    const where = `第 ${index + 1} 级「${String(raw?.label ?? raw?.name ?? '?')}」`;
    const levelName = String(raw?.name ?? '').trim();
    if (!levelName) { problems.push(`${where}缺少 name（等级标识）`); continue; }
    if (seen.has(levelName)) { problems.push(`${where}的 name「${levelName}」与前面重复`); continue; }
    seen.add(levelName);
    try {
      const matches = compileCondition(raw?.condition);
      levels.push({
        name: levelName,
        label: String(raw?.label ?? levelName).trim() || levelName,
        success: raw?.success === true,
        matches: (input) => matches(toVars(input))
      });
    } catch (error) {
      problems.push(`${where}的判定条件有问题：${error instanceof ConditionError ? error.message : String(error)}`);
    }
  }

  let refuses: CheckRule['refuses'] = null;
  if (file.requires) {
    const message = String(file.requires.message ?? '').trim() || `「${name || id}」不接受这种掷骰`;
    try {
      const ok = compileCondition(file.requires.condition);
      refuses = (input) => (ok(toVars(input)) ? null : message);
    } catch (error) {
      problems.push(`requires 的条件有问题：${error instanceof ConditionError ? error.message : String(error)}`);
    }
  }

  // `chargen`：每一格都要能掷（同 `dice` 那条）。写在表里但掷不出来的表现是
  // "群友敲 `.pc roll` 报一个看不懂的语法错"，所以在编译期拦下。
  let chargen: ChargenSpec | null = null;
  if (file.chargen !== undefined && file.chargen !== null) {
    const raw = file.chargen.attributes;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      problems.push('chargen.attributes 要是一个对象（属性名 → 掷法）');
    } else {
      const attributes: Record<string, string> = {};
      for (const [key, expr] of Object.entries(raw as Record<string, unknown>)) {
        const name = String(key ?? '').trim();
        const text = String(expr ?? '').trim();
        if (!name) { problems.push('chargen.attributes 里有一个空的属性名'); continue; }
        try {
          parseDiceExpr(text);
        } catch (error) {
          problems.push(`chargen.attributes 的「${name}」掷法「${text}」有问题：`
            + `${error instanceof Error ? error.message : String(error)}`);
          continue;
        }
        attributes[name] = text;
      }
      if (!Object.keys(attributes).length) problems.push('chargen.attributes 是空的（要么别写这一栏）');
      chargen = Object.keys(attributes).length ? { attributes } : null;
    }
  }

  if (problems.length) throw new RuleError(problems);
  return { id, name, description: String(file.description ?? '').trim(), dice, chargen, initiative, refuses, levels };
}

/**
 * 校验的取样域。**它是常量、写明的** —— 改它等于改校验的语义。
 *
 * 域是**单颗 d100**：`target ∈ [0,100]`、`roll ∈ [1,100]`。选它有两个理由：
 *   ① 本仓库的两套内置表都是单颗骰的规则（多颗骰的规则不在覆盖范围内 —— 别以为它被盖住了）；
 *   ② 它与 DiceRobot 的 `_verify`（`skill ∈ [0,100] × roll ∈ [1,100]`）同一口径，而那套口径
 *      在它那边被实测证明能抓住"等级顺序写错"。
 * 规则用 `requires` 声明"不管这个形状"时，那个取样点会被**跳过**而不是报错。
 */
const VERIFY_TARGET_MAX = 100;
const VERIFY_FACES = 100;

/**
 * 穷举取样域，返回发现的问题（空数组 = 通过）。
 *
 * 报两类问题，两类都是"不跑就发现不了、跑了也要等玩家恰好掷出那个点数才暴露"的：
 *   • **某组取值一个等级都匹配不上** —— 通常漏了兜底那条 `condition: "true"`；
 *   • **某个等级永远匹配不到** —— 通常是特例排到了通例后面。
 */
export function verifyRule(rule: CheckRule): string[] {
  const problems: string[] = [];
  const unreachable = new Set(rule.levels.map((level) => level.name));

  for (let target = 0; target <= VERIFY_TARGET_MAX; target++) {
    for (let roll = 1; roll <= VERIFY_FACES; roll++) {
      const input: JudgeInput = { total: roll, dice: [roll], kept: [roll], faces: VERIFY_FACES, target };
      if (rule.refuses?.(input)) continue;
      let matched: CheckLevel | null = null;
      for (const level of rule.levels) {
        if (level.matches(input)) { matched = level; break; }
      }
      if (!matched) {
        problems.push(`技能值/目标值 ${target}、骰值 ${roll} 时一个等级都匹配不上 —— 最后一级应当无条件匹配（condition 写 "true"）`);
        return problems;   // 一条就够：剩下的都是同一件事的重复
      }
      unreachable.delete(matched.name);
    }
  }

  for (const name of unreachable) {
    problems.push(`等级「${name}」在任何取值下都匹配不到 —— 多半是它被排在前面那些通例挡住了（顺序即优先级）`);
  }
  return problems;
}

/**
 * 取首个匹配的等级。
 *
 * Raises:
 *   `DiceError('RULE')`：这套规则不接受这次掷骰，或一个等级都没匹配上（后者说明表漏了兜底，
 *   而 `verifyRule` 本该在加载时拦住它 —— 走到这里说明表没经校验就被用上了）。
 */
export function check(rule: CheckRule, input: JudgeInput): CheckLevel {
  const refusal = rule.refuses?.(input);
  if (refusal) {
    throw new DiceError('RULE', `${refusal}；当前掷的是 ${describeShape(input)}。`
      + '改用这套规则要求的骰子，或把这一局的规则表换成别的（开局时用 rule 指定）');
  }
  for (const level of rule.levels) {
    if (level.matches(input)) return level;
  }
  throw new DiceError('RULE',
    `检定规则「${rule.name}」没有覆盖这一组取值（合计 ${input.total}、目标 ${input.target}）`
    + '—— 最后一条等级应当无条件匹配');
}

/** 把一次掷骰的形状说成人话，用在"这套规则不接受"的报错里。 */
function describeShape(input: JudgeInput): string {
  if (!input.dice.length) return '一个没有骰子的数';
  if (input.faces) return `${input.dice.length} 颗 d${input.faces}`;
  return `${input.dice.length} 颗（多组相加）`;
}

/**
 * "掷出来的这个数算不算成功"。**唯一与规则书相关的接缝**，换规则书只换它。
 *
 * 保留这个形状是因为它是一份**对外契约**（`resolveCheck` 的 `judge` 选项、既有断言按它读
 * 默认判定）。规则表是更完整的形态 —— 它多带了等级的中文名与适用前提。
 *
 * `label` 可选：自定义判定想给这一档起个中文名就填它，展示层优先用它。**不填也没有兜底表** ——
 * 展示层认不出就原样印 `grade`（不替规则书编名字，同 `image-source` 的"字段在不在"那条规矩）。
 */
export type CheckJudge = (input: JudgeInput) => { success: boolean; grade: string; label?: string };

/** 通用判定背后的那套规则。`defaultJudge` 就是它的一层薄封装（两处不会漂移）。 */
export const GENERIC_RULE: CheckRule = compileRule(BUILTIN_RULE_FILES.generic);

/**
 * 通用默认判定：**掷高**，`total >= target` 即成功；单颗骰掷出 1 就是大失败、掷出最大面是大成功。
 *
 * ⚠️ 大失败**压过** `total >= target`：掷出 1 就是失败，哪怕难度设成 0。
 * 这正是"大失败"这个词的意思；如果某套规则不这么认为，那是它该提供自己的规则表的理由。
 */
export const defaultJudge: CheckJudge = (input) => {
  const level = check(GENERIC_RULE, input);
  return { success: level.success, grade: level.name, label: level.label };
};

export interface CheckResult {
  /** 掷骰的完整事实（含每一颗骰面）—— 检定结果要能当场验算，不能只有一个成功/失败。 */
  roll: DiceRoll;
  target: number;
  success: boolean;
  grade: string;
  /**
   * 这一档的中文名。**权威是规则表**（`level.label`）；自定义 `judge` 想给就给一个，
   * 不给的话展示层原样印 `grade` —— 这里**没有兜底表**（曾经有一个 `GRADE_LABEL`，
   * 它编出的名字与规则表给的能不一致，见 `render/format.ts`）。
   */
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
    const { success, grade, label } = judge(input);
    return { roll, target: goal, success, grade, label, margin };
  }
  const level = check(rule ?? GENERIC_RULE, input);
  return { roll, target: goal, success: level.success, grade: level.name, label: level.label, margin };
}
