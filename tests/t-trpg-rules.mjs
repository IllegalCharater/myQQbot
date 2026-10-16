// 跑团规则引擎：骰子表达式与检定。
//
// 这是跑团里唯一"错了会毁掉整局信任"的部分，所以本套件的重点是**可复现**与**可复核**：
// 每一条都用注入的确定随机源跑，逐面核对 `dice` / `kept` / `total` 三个数，
// 而不是"结果落在合法区间里"这种什么都证明不了的断言。
//
// 顶层三分之二是纯函数：没有文件、没有网络、没有子进程 —— 规则层连 config 都不 import。
// `scripts/check-layers.mjs` 有一条闸门钉着这件事（`extra/trpg/rules/**` 不许 import 到该目录之外）。
// 最后一段（§13）例外：它测的是**规则表的存储**（`rule-store.ts`），那个模块当然要读盘 ——
// 所以它在临时数据目录里跑（`DIR`），而规则层本身仍然拿不到任何 I/O 能力。
import path from 'node:path';
import { checker, dataDir } from './lib/harness.mjs';
import { load } from './lib/src.mjs';

// 与别的套件同一条纪律：先造临时数据目录，再 load 任何模块。
const DIR = dataDir('qqagent-trpg-rules-');

const { ok, done } = checker();
const { DiceError, rollDice } = await load('extra/trpg/rules/dice.js');
const {
  BUILTIN_RULE_FILES, GENERIC_RULE, RuleError, check, compileRule, defaultJudge, resolveCheck, toVars, verifyRule
} = await load('extra/trpg/rules/check.js');
const { derive, rollChargen } = await load('extra/trpg/rules/chargen.js');
const { ConditionError, compileCondition } = await load('extra/trpg/rules/condition.js');
const { combine, formatPercentile, rollPercentile } = await load('extra/trpg/rules/percentile.js');
const { RuleStore } = await load('extra/trpg/store/rule-store.js');
const { safeFileName } = await load('extra/trpg/model/paths.js');

/** 内置的 COC 表 —— 它现在是**种子数据**，用同一套编译路径编出来（不再是一个写死的常量）。 */
const COC7_RULE = compileRule(BUILTIN_RULE_FILES.coc7);

/**
 * 让第 i 颗骰子掷出 `want[i]`（骰子面数 `n`）。
 *
 * `rollOne` 算的是 `floor(v * n) + 1`，所以要让面值等于 f，只需要 `v ∈ [(f-1)/n, f/n)`；
 * 取区间中点 `(f - 0.5) / n`。用中点而不是左端点，是为了让"实现改成四舍五入"这类
 * 改动也能被这些断言抓住（左端点会同时满足 floor 与部分 round 实现）。
 */
const rollOf = (n, ...want) => {
  let i = 0;
  return () => (want[i++] - 0.5) / n;
};

/** 十位/个位骰的脚本化随机源：让第 i 个数字骰掷出 `want[i]`（0–9）。 */
const digitsOf = (...want) => {
  let i = 0;
  return () => (want[i++] + 0.5) / 10;
};

/** 一个 rng 被调用了几次。用来验"颗数真的按表达式来"。 */
const counting = (inner) => {
  const box = { calls: 0 };
  box.rng = () => { box.calls++; return inner(); };
  return box;
};

/** 任何掷骰调用都要给随机源 —— 规则层**没有默认值**（`tsc` 拦漏掉的调用点，这里也一样）。 */
const anyRng = () => 0.5;

// ── 1. 解析与求值：逐面核对 ─────────────────────────────────────────────────
{
  const r = rollDice('3d6', rollOf(6, 4, 2, 5));
  ok('3d6：三颗骰子的面值按掷出顺序原样保留', JSON.stringify(r.dice) === '[4,2,5]', JSON.stringify(r.dice));
  ok('3d6：没有 kh/kl 时 kept 就是 dice', JSON.stringify(r.kept) === '[4,2,5]' && r.dropped === 0);
  ok('3d6：total 是各面之和', r.total === 11, String(r.total));
  ok('3d6：count / faces 如实回填', r.count === 3 && r.faces === 6);
  ok('3d6：算式明细印得出每一颗（`3d6 → 4+2+5 = 11`）', r.detail === '4+2+5', r.detail);

  // `d20` 省略颗数 = 1 颗。这条是"省略写法"唯一的存在理由，钉死。
  const one = rollDice('d20', rollOf(20, 20));
  ok('d20：省略颗数即 1 颗', one.count === 1 && JSON.stringify(one.dice) === '[20]', JSON.stringify(one));

  const pct = rollDice('1d100', rollOf(100, 1));
  ok('1d100：面数 100 可用，掷出 1 也照实记', pct.faces === 100 && pct.total === 1);

  const plus = rollDice('2d6+3', rollOf(6, 6, 6));
  ok('2d6+3：修饰值加进 total 但**不进** dice（骰面永远是骰面）',
    plus.total === 15 && JSON.stringify(plus.dice) === '[6,6]' && plus.modifier === 3, JSON.stringify(plus));

  const minus = rollDice('2d6-1', rollOf(6, 1, 1));
  ok('2d6-1：负修饰可用（total 允许低于骰面之和）',
    minus.total === 1 && minus.modifier === -1, JSON.stringify(minus));

  const flat = rollDice('12', anyRng);
  ok('纯数字：没有骰子、dice 为空、total 就是它本身',
    flat.count === 0 && flat.faces === 0 && flat.dice.length === 0 && flat.total === 12, JSON.stringify(flat));
  ok('纯数字：没有算式明细（不印 `12 → 12 = 12` 那种废话）', flat.detail === '');

  const spaced = rollDice('  4 D 6 KH 3  ', rollOf(6, 6, 5, 4, 1));
  ok('空白与前缀大写都被归一化（expr 回显的是归一化后的形态）',
    spaced.expr === '4d6kh3' && spaced.total === 15, JSON.stringify(spaced));

  // 全角来自中文输入法，`x` 作乘号是常见写法 —— 两者都折算，而 `expr` 回显的是折算后的形态。
  const wide = rollDice('（2d6）×3', rollOf(6, 3, 3));
  ok('全角括号与乘号都被折算（`（2d6）×3` 与 `(2d6)*3` 同义）',
    wide.expr === '(2d6)*3' && wide.total === 18, JSON.stringify(wide));
  const xMul = rollDice('2x3', anyRng);
  ok('`x` 作乘号', xMul.total === 6, String(xMul.total));
}

// ── 2. kh / kl 真的留对了（`k` / `q` 是它们的 OneDice 简写）────────────────────
{
  const rng = rollOf(6, 1, 6, 3, 5);
  const h = rollDice('4d6kh3', rng);
  ok('4d6kh3：丢掉最小的那颗（1），其余按**原始顺序**留下',
    JSON.stringify(h.kept) === '[6,3,5]' && h.dropped === 1, JSON.stringify(h));
  ok('4d6kh3：dice 里仍然看得见被丢掉的那一颗（可复核的全部依据）',
    JSON.stringify(h.dice) === '[1,6,3,5]', JSON.stringify(h.dice));
  ok('4d6kh3：total 只算留下的 + 修饰', h.total === 14, String(h.total));

  const l = rollDice('4d6kl3', rollOf(6, 1, 6, 3, 5));
  ok('4d6kl3：丢掉最大的那颗（6）',
    JSON.stringify(l.kept) === '[1,3,5]' && l.total === 9, JSON.stringify(l));

  const all = rollDice('2d6kh2', rollOf(6, 2, 4));
  ok('kh 等于颗数时 = 不丢（边界合法，不是错误）', all.dropped === 0 && all.total === 6);

  const withMod = rollDice('4d6kh3+2', rollOf(6, 6, 6, 6, 1));
  ok('kh 与修饰连用：先 kh 再 +2', withMod.total === 20 && withMod.modifier === 2, JSON.stringify(withMod));

  // 同一颗骰面，`k` 与 `kh` 必须给出相同的结果（简写不该有第二种语义）。
  // **不比 `expr`**：它回显的是归一化后的输入，`4d6k3` 与 `4d6kh3` 本来就该各印各的。
  const legacy = rollDice('4d6kh3', rollOf(6, 1, 6, 3, 5));
  const short = rollDice('4d6k3', rollOf(6, 1, 6, 3, 5));
  ok('`k` ≡ `kh`（除 expr 回显外逐字段相同）',
    short.expr === '4d6k3' && JSON.stringify({ ...short, expr: '' }) === JSON.stringify({ ...legacy, expr: '' }),
    JSON.stringify(short));
  const qShort = rollDice('4d6q3', rollOf(6, 1, 6, 3, 5));
  ok('`q` ≡ `kl`', qShort.total === 9 && JSON.stringify(qShort.kept) === '[1,3,5]', JSON.stringify(qShort));
}

// ── 3. 多组骰子 / 括号 / 四则 / 乘方 ────────────────────────────────────────
//
// 这一整节在旧版本里是"**刻意不支持**"的（`2d6+1d4` 报错）。扩成 OneDice 子集之后
// 它们成了正向能力，所以断言也翻过来了。
{
  const multi = rollDice('2d6+1d4', rollOf(6, 4, 3, 2));
  ok('2d6+1d4：多组相加，total 是两组之和', multi.total === 9, JSON.stringify(multi));
  ok('2d6+1d4：groups 逐组留档（每一组的颗数/面数/骰面都在）',
    multi.groups.length === 2
    && JSON.stringify(multi.groups[0].dice) === '[4,3]' && multi.groups[0].faces === 6
    && JSON.stringify(multi.groups[1].dice) === '[2]' && multi.groups[1].faces === 4,
    JSON.stringify(multi.groups));
  ok('2d6+1d4：顶层 dice 是各组按顺序拼接（"全部骰面都看得见"这条不因多组而失效）',
    JSON.stringify(multi.dice) === '[4,3,2]' && multi.count === 3, JSON.stringify(multi.dice));
  ok('2d6+1d4：多组时 faces 没有单一含义，记 0（要看精确值就查 groups）',
    multi.faces === 0, String(multi.faces));
  ok('2d6+1d4：算式明细给两组各自加括号（不加就会读成"一次掷了三颗"）',
    multi.detail === '(4+3)+(2)', multi.detail);

  const paren = rollDice('(2d6+3)*2', rollOf(6, 4, 3));
  ok('(2d6+3)*2：先算括号再乘（(4+3+3)×2 = 20）', paren.total === 20, JSON.stringify(paren));
  ok('(2d6+3)*2：明细里括号保留得住（不然"先乘后加"会算成二十几）',
    paren.detail === '(4+3+3)×2', paren.detail);

  const pow = rollDice('2^3^2', anyRng);
  ok('`^` 右结合：2^3^2 = 2^(3^2) = 512（不是 (2^3)^2 = 64）', pow.total === 512, String(pow.total));

  const div = rollDice('9/2', anyRng);
  ok('除法是整数运算、向下取整（9/2 = 4）', div.total === 4, String(div.total));
  const negDiv = rollDice('-9/2', anyRng);
  ok('负数除法也向下取整（-9/2 = -5，不是 -4）', negDiv.total === -5, String(negDiv.total));

  const unary = rollDice('-(2d6)', rollOf(6, 2, 3));
  ok('一元负号可用', unary.total === -5, String(unary.total));
}

// ── 4. 奖惩骰（d100 的十位骰与个位骰）──────────────────────────────────────
{
  // 个位 5，十位 3 → 35。`b` 缺省追加 1 颗，所以共 2 个十位骰。
  ok('combine(3,5) = 35', combine(3, 5) === 35);
  ok('combine(0,5) = 5（十位 0 是个位不变，不是 100）', combine(0, 5) === 5);
  ok('combine(0,0) = 100（十位与个位都是 0）', combine(0, 0) === 100);
  ok('combine(9,0) = 90', combine(9, 0) === 90);

  // ⚠️ 这两条是这一节最要紧的：候选**必须先组合成结果再比大小**。
  // 若改成比十位数字，个位 0 + 十位 {0,9} 时奖励骰会取到十位 0 → 结果 100，
  // 而不是正确的 90 —— 大成功从此永远掷不出来。
  const bonus = rollPercentile({ rng: digitsOf(0, 0, 9), extra: 1 });
  ok('奖励骰：个位 0、十位 0 与 9 → 候选 100 与 90，必须取 90',
    bonus.value === 90 && bonus.base === 100, JSON.stringify(bonus));
  const pen = rollPercentile({ rng: digitsOf(0, 9, 0), extra: 1, penalty: true });
  ok('惩罚骰：同一组候选取 100', pen.value === 100, JSON.stringify(pen));

  ok('formatPercentile：没有追加骰时就是结果本身',
    formatPercentile(rollPercentile({ rng: digitsOf(2, 5) })) === '52');
  ok('formatPercentile：有追加骰时展开成 `基准[奖励骰:…]`（舍弃的那些也印出来）',
    formatPercentile(rollPercentile({ rng: digitsOf(5, 3, 9), extra: 1 })) === '35[奖励骰:9]',
    formatPercentile(rollPercentile({ rng: digitsOf(5, 3, 9), extra: 1 })));

  // `bN` 的 N 是**追加**的十位骰个数：b2 一共掷 3 个十位骰，个位仍只掷一次。
  const roll = rollDice('1d100b2', digitsOf(5, 3, 7, 1));
  ok('1d100b2：个位 5、十位 3/7/1 → 候选 35/75/15，取 15',
    roll.total === 15 && roll.faces === 100 && roll.count === 1, JSON.stringify(roll));
  ok('1d100b2：明细展开了被舍弃的十位骰（`35[奖励骰:7 1]`）', roll.detail === '35[奖励骰:7 1]', roll.detail);

  const bare = rollDice('b', digitsOf(5, 3, 9));
  ok('裸 `b` = 一颗带 1 个奖励骰的 d100（取 min(35,95) = 35）', bare.total === 35, JSON.stringify(bare));
  const p2 = rollDice('p2', digitsOf(5, 3, 7, 1));
  ok('`p2` 取最大的候选（75）', p2.total === 75, String(p2.total));

  const withMod = rollDice('1d100b1+10', digitsOf(5, 3, 9));
  ok('奖惩骰可以参与四则运算', withMod.total === 45, String(withMod.total));
}

// ── 5. 失败要说清楚（工具会把 error.message 原样回给模型）────────────────────
{
  const fails = (expr, code, label) => {
    try {
      rollDice(expr, anyRng);
      ok(label, false, '居然没抛错');
    } catch (error) {
      const isOurs = error instanceof DiceError;
      // 判据是"文案里有面向用户的实质信息"，所以用的是**领域词**而不是"是个中文句子"：
      // `骰` 一个字就够（覆盖骰子/奖惩骰/骰面），刻意的宽 —— 它的作用是拦住
      // "把 message 换成 `表达式错误`" 那类退化，不是逐字比对文案。
      const has = (message) => /骰|支持|颗数|面数|保留|目标值/.test(String(error.message));
      ok(label, isOurs && error.code === code && has(),
        `code=${isOurs ? error.code : '(不是 DiceError)'} msg=${String(error.message).slice(0, 60)}`);
    }
  };

  fails('', 'EMPTY', '空表达式报 EMPTY');
  fails(null, 'EMPTY', 'null 报 EMPTY（工具参数里它很常见）');
  fails('x'.repeat(80), 'TOO_LONG', '超长表达式报 TOO_LONG');
  fails('0d6', 'DICE_COUNT', '0 颗骰报 DICE_COUNT');
  fails('101d6', 'DICE_COUNT', '超过 100 颗报 DICE_COUNT');
  fails('d1', 'DICE_FACES', '单面骰报 DICE_FACES');
  fails('d1001', 'DICE_FACES', '超过 1000 面报 DICE_FACES');
  fails('2d20b1', 'DICE_FACES', '奖惩骰写非 100 的面数报 DICE_FACES');
  fails('4d6kh0', 'KEEP_COUNT', 'kh0 报 KEEP_COUNT');
  fails('4d6kh5', 'KEEP_COUNT', 'kh 超过颗数报 KEEP_COUNT');
  fails('1d100b0', 'EXTRA_COUNT', '奖惩骰 0 颗报 EXTRA_COUNT');
  fails('1d100b11', 'EXTRA_COUNT', '奖惩骰超过 10 颗报 EXTRA_COUNT');
  fails('1/0', 'DIV_ZERO', '除零报 DIV_ZERO');
  fails('2^-1', 'EXPONENT', '负指数报 EXPONENT（整数运算下它没有意义）');
  fails('2^999', 'EXPONENT', '指数过大报 EXPONENT');
  fails('999^60', 'POWER_SIZE', '乘方结果过大报 POWER_SIZE（在算之前就该拦住）');
  fails('100d6+100d6+100d6', 'TOTAL_DICE', '整个表达式的骰子总量超限报 TOTAL_DICE（加法绕不开单组上限）');
  fails('3d6+', 'SYNTAX', '残缺修饰报 SYNTAX');
  fails('(3d6', 'SYNTAX', '括号没闭合报 SYNTAX');
  fails('3d6)', 'SYNTAX', '多余内容报 SYNTAX');
  fails('abc', 'SYNTAX', '不是表达式报 SYNTAX');
  fails('3d6x', 'SYNTAX', '未知修饰报 SYNTAX');
  fails('2b3', 'SYNTAX', '`2b3` 的左值无意义，报 SYNTAX（文案要指出正确写法是 2db3）');
  fails('3d6a6', 'SYNTAX', '骰池（a）明确报"不支持"而不是含糊的语法错');

  // 文案必须带上"下一步" —— 模型照着它才改得对。
  try { rollDice('2b3', anyRng); } catch (error) {
    ok('`2b3` 的报错文案给出正确写法与支持的形态',
      /2db3/.test(error.message) && /3d6/.test(error.message), String(error.message));
  }
  try { rollDice('3d6a6', anyRng); } catch (error) {
    ok('骰池的报错文案点名"骰池"并列出支持的形态',
      /骰池/.test(error.message) && /支持/.test(error.message), String(error.message));
  }
}

// ── 6. 可复现：同一个 rng 序列必得同一个结果 ────────────────────────────────
{
  const build = () => rollOf(6, 3, 1, 4, 1, 5, 3);
  const a = rollDice('3d6+2', build());
  const b = rollDice('3d6+2', build());
  ok('同序列两次掷骰逐字段相同（这是"可复核"的机械前提）',
    JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);

  // 不变式：三条，换任意表达式都成立。随机跑一批，比钉死几个用例更值。
  // ⚠️ 不变式里的 `total === Σkept + modifier` 在**有乘除的表达式的上不成立**（`modifier` 是
  // `total − Σkept`，见 `DiceRoll` 的说明），所以这里只跑"一组骰子 + kh/kl"的形态。
  let invariantOk = true;
  let detail = '';
  for (let i = 0; i < 200 && invariantOk; i++) {
    const n = 1 + (i % 7);
    const faces = 2 + (i % 11);
    const keep = 1 + (i % n);
    const expr = i % 3 === 0 ? `${n}d${faces}kh${keep}` : i % 3 === 1 ? `${n}d${faces}kl${keep}` : `${n}d${faces}`;
    const r = rollDice(expr, rollOf(faces, ...Array.from({ length: n }, (_, k) => 1 + ((i + k) % faces))));
    const sum = r.kept.reduce((s, v) => s + v, 0);
    if (r.dice.length !== r.count) { invariantOk = false; detail = `${expr}: dice.length ${r.dice.length} ≠ count ${r.count}`; }
    else if (r.kept.length + r.dropped !== r.dice.length) { invariantOk = false; detail = `${expr}: kept+dropped ≠ dice`; }
    else if (r.total !== sum + r.modifier) { invariantOk = false; detail = `${expr}: total ≠ Σkept + mod`; }
    else if (r.dice.some((v) => v < 1 || v > r.faces)) { invariantOk = false; detail = `${expr}: 面值越界 ${JSON.stringify(r.dice)}`; }
  }
  ok('200 组随机表达式都满足三条不变式（颗数 / 留下+丢掉 = 总数 / total = Σkept+mod，且面值在 [1, faces]）',
    invariantOk, detail);
}

// ── 7. 坏的随机源不该毁掉掷骰 ──────────────────────────────────────────────
{
  // rng 是**注入**的，所以它可能返回任何东西。越界的面值会让 total 变成谁也算不出的怪数，
  // 比抛错难查得多 —— 所以实现把值夹回 [0,1)。这条钉的就是那个夹取。
  const bad = [1, -1, 5, NaN, Infinity, undefined];
  const r = rollDice(`${bad.length}d6`, () => bad.shift() ?? 0);
  ok('rng 返回越界值 / NaN / Infinity 时，面值仍落在 [1, faces]（夹回合法区间，而不是抛错）',
    r.dice.every((v) => Number.isInteger(v) && v >= 1 && v <= 6), JSON.stringify(r.dice));

  // 奖惩骰那条路要各自夹一次个位与十位。
  const badDigits = [1, -1, NaN, 5, Infinity];
  const p = rollDice('1d100b1', () => badDigits.shift() ?? 0);
  ok('奖惩骰的个位/十位骰也被夹回 0–9（坏随机源不毁掉整次掷骰）',
    p.total >= 1 && p.total <= 100, String(p.total));
}

// ── 8. 检定：机械部分（与规则书无关）──────────────────────────────────────
{
  const r = resolveCheck('3d6', 10, { rng: rollOf(6, 4, 5, 6) });
  ok('resolveCheck 回填目标值与差值（margin = total - target）',
    r.target === 10 && r.roll.total === 15 && r.margin === 5, JSON.stringify(r));

  const exact = resolveCheck('3d6', 15, { rng: rollOf(6, 4, 5, 6) });
  ok('恰好等于目标值算成功（>= 而不是 >）', exact.success === true && exact.margin === 0);

  const short = resolveCheck('3d6', 16, { rng: rollOf(6, 4, 5, 6) });
  ok('差 1 就是不成功，且 margin 说得出差多少', short.success === false && short.margin === -1);

  try {
    resolveCheck('3d6', '难', { rng: anyRng });
    ok('目标值不是数时报错', false, '居然没抛错');
  } catch (error) {
    ok('目标值不是数时报错，且文案给出正确写法',
      error instanceof DiceError && error.code === 'TARGET' && /3d6 对 12/.test(error.message),
      String(error.message));
  }

  // 传了 target 就是检定；不传就是掷骰 —— 但**判定的机械部分**与掷骰共用同一个解析器，
  // 所以多组骰子照样能检定。
  const multi = resolveCheck('2d6+1d4', 8, { rng: rollOf(6, 4, 3, 2) });
  ok('多组骰子的表达式也能检定', multi.roll.total === 9 && multi.success === true, JSON.stringify(multi));
}

// ── 9. 默认判定：大成功/大失败只在单颗骰时 ──────────────────────────────────
{
  const crit = resolveCheck('1d20', 30, { rng: rollOf(20, 20) });
  ok('单颗骰掷出最大面 = critical，且**压过**目标值（难度再高也算大成功）',
    crit.grade === 'critical' && crit.success === true, JSON.stringify(crit));
  ok('critical 带中文档位名（展示层优先用它）', crit.label === '大成功', String(crit.label));

  const fumble = resolveCheck('1d20', 0, { rng: rollOf(20, 1) });
  ok('单颗骰掷出 1 = fumble，且**压过** target=0（大失败就是失败）',
    fumble.grade === 'fumble' && fumble.success === false, JSON.stringify(fumble));

  const multi = resolveCheck('3d6', 3, { rng: rollOf(6, 6, 6, 6) });
  ok('多颗骰即使全是最大值也不判 critical —— 多骰下"全最大"没有公认语义，不替规则书发明',
    multi.grade === 'success' && multi.success === true, JSON.stringify(multi));

  const plain = resolveCheck('12', 10, { rng: anyRng });
  ok('纯数字表达式（没有骰子）走普通成功/失败，不会误判成大成功',
    plain.grade === 'success' && plain.success === true, JSON.stringify(plain));
}

// ── 10. 判定函数是可换的（换规则书只换它）───────────────────────────────────
{
  // COC 那种"掷低为佳"的读法：同一个骰面在两个判定下结论必须相反 —— 这是"接缝真的存在"
  // 的判据。只断言"自定义 judge 被调到了"证明不了什么。
  const lowIsGood = ({ total, target }) => ({
    success: total <= target, grade: total <= target ? 'success' : 'failure'
  });
  const opts = { rng: rollOf(100, 30) };
  const dflt = resolveCheck('1d100', 50, opts);
  const coc = resolveCheck('1d100', 50, { ...opts, judge: lowIsGood });
  ok('同一个骰面（30）在"掷高"下失败、在"掷低"下成功 —— 接缝真的起作用',
    dflt.success === false && coc.success === true,
    `默认 grade=${dflt.grade} / 自定义 grade=${coc.grade}`);

  const spy = { seen: null };
  resolveCheck('2d6+1', 5, {
    rng: rollOf(6, 1, 2),
    judge: (input) => { spy.seen = input; return { success: true, grade: 'success' }; }
  });
  ok('判定函数拿到的是原始材料（total / dice / kept / faces / target 一样不少）',
    spy.seen?.total === 4 && JSON.stringify(spy.seen?.dice) === '[1,2]'
    && spy.seen?.faces === 6 && spy.seen?.target === 5,
    JSON.stringify(spy.seen));

  ok('默认判定是导出的具名函数（扩展要拿它当"不换规则书"的默认值）',
    typeof defaultJudge === 'function');

  const viaDefault = resolveCheck('3d6', 10, { rng: rollOf(6, 4, 5, 6) });
  const viaRule = resolveCheck('3d6', 10, { rng: rollOf(6, 4, 5, 6), rule: GENERIC_RULE });
  ok('默认判定与 generic 规则表逐字段一致（两处不会漂移）',
    JSON.stringify(viaDefault) === JSON.stringify(viaRule), JSON.stringify(viaDefault));
}

// ── 11. 规则表：COC 六级 + 穷举自检 ────────────────────────────────────────
//
// 穷举那两条是这一节的重点：**"某个等级永远匹配不到"这种错误今天完全静默** ——
// 它只有等玩家恰好掷出那个点数才会暴露，而那时你已经在跑了。
{
  const coc = (roll, skill) => resolveCheck('1d100', skill, { rng: rollOf(100, roll), rule: COC7_RULE });
  ok('COC：掷出 1 = 大成功', coc(1, 50).grade === 'critical' && coc(1, 50).success === true, JSON.stringify(coc(1, 50)));
  ok('COC：掷出 100 = 大失败（哪怕技能值 80）', coc(100, 80).grade === 'fumble', JSON.stringify(coc(100, 80)));
  ok('COC：技能值小于 50 时，96 以上也是大失败', coc(96, 40).grade === 'fumble', JSON.stringify(coc(96, 40)));
  ok('COC：技能值 50 时 96 不是大失败（判据里有 `skill < 50`）', coc(96, 50).grade === 'failure', JSON.stringify(coc(96, 50)));
  ok('COC：roll ≤ skill/5 = 极难成功', coc(10, 50).grade === 'extreme', JSON.stringify(coc(10, 50)));
  ok('COC：roll ≤ skill/2 = 困难成功（25 ≤ 25）', coc(25, 50).grade === 'hard', JSON.stringify(coc(25, 50)));
  ok('COC：roll ≤ skill = 成功', coc(30, 50).grade === 'success', JSON.stringify(coc(30, 50)));
  ok('COC：roll > skill = 失败', coc(60, 50).grade === 'failure', JSON.stringify(coc(60, 50)));
  ok('COC 的六个档位都有中文名（展示层直接印，不必自己查表）',
    ['大成功', '大失败', '极难成功', '困难成功', '成功', '失败']
      .every((label) => COC7_RULE.levels.some((level) => level.label === label)));

  // 选了 COC 却掷别的骰子：必须**明确拒绝**，而不是给出一个"看起来正常"的错误答案。
  try {
    resolveCheck('3d6', 10, { rng: anyRng, rule: COC7_RULE });
    ok('COC 规则表对非 d100 的掷骰明确拒绝', false, '居然没抛错');
  } catch (error) {
    ok('COC 规则表对非 d100 的掷骰明确拒绝，且文案指出用 1d100',
      error instanceof DiceError && /1d100/.test(error.message), String(error.message));
  }

  ok('内置的两套表都能过穷举校验（源码里的种子本身不许是坏的）',
    verifyRule(GENERIC_RULE).length === 0 && verifyRule(COC7_RULE).length === 0,
    JSON.stringify([...verifyRule(GENERIC_RULE), ...verifyRule(COC7_RULE)]));

  // ── 穷举校验**真的抓得住**两类坏表 ──
  //
  // 这两条是本节的要点：`verifyRule` 的价值全在"不跑就发现不了"上 —— 漏了兜底等级与
  // 等级顺序写反，都只有等玩家恰好掷出那个点数才暴露，而那时你已经在跑了。
  const good = BUILTIN_RULE_FILES.generic.levels;
  const missingFallback = compileRule({
    id: 'bad1', name: '漏了兜底', levels: good.slice(0, 3)   // 去掉最后那条 `true`
  });
  ok('漏掉无条件兜底那一级 → 校验报"某组取值一个等级都匹配不上"',
    verifyRule(missingFallback).some((p) => /一个等级都匹配不上/.test(p)),
    JSON.stringify(verifyRule(missingFallback)));

  const wrongOrder = compileRule({
    id: 'bad2', name: '顺序写反',
    levels: [
      { name: 'success', label: '成功', success: true, condition: 'total >= target' },
      { name: 'critical', label: '大成功', success: true, condition: 'count == 1 and roll == faces' },
      { name: 'failure', label: '失败', success: false, condition: 'true' }
    ]
  });
  ok('特例排在通例之后 → 校验报"某个等级永远匹配不到"',
    verifyRule(wrongOrder).some((p) => /匹配不到/.test(p) && /critical/.test(p)),
    JSON.stringify(verifyRule(wrongOrder)));

  // 单条坏条件不该让整张表编不出来（它只该让**那一级**报错，并指出是哪一级）。
  let compileProblem = '';
  try {
    compileRule({ id: 'bad3', name: 'x', levels: [{ name: 'a', label: 'A', success: true, condition: 'total >= ' }] });
  } catch (error) {
    compileProblem = error instanceof RuleError ? error.problems.join('；') : `不是 RuleError: ${error}`;
  }
  ok('编译失败时指明是**哪一级**、问题是什么',
    /第 1 级/.test(compileProblem) && /判定条件/.test(compileProblem), compileProblem);

  // ── `dice`：技能检定掷什么（`.ra` 照它去掷） ──
  //
  // 它拼错的表现是"群里点一下 `.ra` 报个看不懂的语法错"，所以判据放在编译期（与其余"坏表拒绝"同源）。
  let diceProblem = '';
  try {
    compileRule({ id: 'bad4', name: 'x', dice: '3d6+', levels: [{ name: 'a', label: 'A', success: true, condition: 'true' }] });
  } catch (error) {
    diceProblem = error instanceof RuleError ? error.problems.join('；') : `不是 RuleError: ${error}`;
  }
  ok('`dice` 不是一个能掷的表达式 → 编译期就拒绝（不是等到群友点 `.ra` 才炸）',
    /dice「3d6\+」/.test(diceProblem) && /不是一个能掷的表达式/.test(diceProblem), diceProblem);
  ok('`dice` 编译进规则对象（`.ra` 直接取它去掷）',
    COC7_RULE.dice === '1d100' && GENERIC_RULE.dice === '1d100',
    JSON.stringify([COC7_RULE.dice, GENERIC_RULE.dice]));
  ok('**没写 `dice` 的老表照常能用**（缺省 `1d100`，与两套内置表一致）',
    compileRule({ id: 'legacy', name: 'x', levels: [{ name: 'a', label: 'A', success: true, condition: 'true' }] }).dice === '1d100');
  ok('`dice` 写得对就照单全收（用 d20 的团不必改代码）',
    compileRule({
      id: 'd20ish', name: 'x', dice: '1d20',
      levels: [{ name: 'a', label: 'A', success: true, condition: 'true' }]
    }).dice === '1d20');
}

// ── 11b. 属性生成与派生（P4，COC 7 版）────────────────────────────────────
//
// 属性是"一次掷定、之后一直用"的数字，所以它和掷骰同级：**给定 rng 必得同一结果**。
// 这里用两个极端的 rng（全 0 → 全 1 点、全 0.999 → 全最大）把每一面都钉死，
// 再单独把 DB/Build 表的**每一档边界**与 MOV 的**三种情形**穷举一遍。
{
  const COC7_CHARGEN = BUILTIN_RULE_FILES.coc7.chargen;

  const min = rollChargen(COC7_CHARGEN, () => 0);
  ok('rng 全 0 → 八个属性都是最小值（`3d6*5` → 15、`(2d6+6)*5` → 40）',
    JSON.stringify(min.stats) === JSON.stringify({
      STR: 15, CON: 15, DEX: 15, APP: 15, POW: 15, SIZ: 40, INT: 40, EDU: 40
    }), JSON.stringify(min.stats));
  ok('派生：HP=(CON+SIZ)/10 向下取整、MP=POW/5、SAN=POW',
    min.derived.hpMax === 5 && min.derived.mpMax === 3 && min.derived.sanMax === 15,
    JSON.stringify(min.derived));
  ok('派生：STR+SIZ=55 落在最低那一档（DB -2 / Build -2）',
    min.derived.db === '-2' && min.derived.build === -2, JSON.stringify(min.derived));
  ok('派生：STR 与 DEX 都比 SIZ 小 → MOV 7',
    min.derived.mov === 7, String(min.derived.mov));

  const max = rollChargen(COC7_CHARGEN, () => 0.999);
  ok('rng 全 0.999 → 八个属性都是最大值（90）',
    Object.values(max.stats).every((value) => value === 90), JSON.stringify(max.stats));
  ok('派生：HP 18 / MP 18 / SAN 90',
    max.derived.hpMax === 18 && max.derived.mpMax === 18 && max.derived.sanMax === 90,
    JSON.stringify(max.derived));
  ok('派生：STR+SIZ=180 落在 +1d6 那一档（Build 2）',
    max.derived.db === '+1d6' && max.derived.build === 2, JSON.stringify(max.derived));
  ok('派生：STR 与 DEX 都不小于 SIZ → MOV 9',
    max.derived.mov === 9, String(max.derived.mov));

  ok('同一份 spec + 同一个 rng 序列 → **逐字相同的结果**（`rules/` 那条约定的判据）',
    JSON.stringify(rollChargen(COC7_CHARGEN, () => 0.4)) === JSON.stringify(rollChargen(COC7_CHARGEN, () => 0.4)));

  // ── DB / Build 表的**每一档边界** ──
  //
  // 表是按 STR+SIZ 查的，而边界最容易写错（`<` 还是 `<=`）。所以每一档的两个端点都点名。
  const dbAt = (total) => {
    const { derived } = derive({ STR: Math.floor(total / 2), SIZ: total - Math.floor(total / 2), DEX: 50, CON: 50, POW: 50 });
    return `${derived.db}/${derived.build}`;
  };
  const rows = [
    [64, '-2/-2'], [65, '-1/-1'], [84, '-1/-1'], [85, '0/0'], [124, '0/0'],
    [125, '+1d4/1'], [164, '+1d4/1'], [165, '+1d6/2'], [204, '+1d6/2'],
    [205, '+2d6/3'], [284, '+2d6/3'], [285, '+3d6/4'], [364, '+3d6/4'],
    [365, '+4d6/5'], [444, '+4d6/5'], [445, '+5d6/6'], [600, '+5d6/6']
  ];
  const wrong = rows.filter(([total, want]) => dbAt(total) !== want);
  ok('DB/Build 表**每一档的两个端点**都对（`<` 写成 `<=` 会在这里红）',
    !wrong.length, JSON.stringify(wrong.map(([total, want]) => `${total}: 想要 ${want} 拿到 ${dbAt(total)}`)));
  ok('表的**兜底行**在（超出最后一行也不该掉出去）', dbAt(9999) === '+5d6/6', dbAt(9999));

  // ── MOV 的三种情形（含"等于"落在哪一边） ──
  const movOf = (STR, DEX, SIZ) => derive({ STR, DEX, SIZ, CON: 50, POW: 50 }).derived.mov;
  ok('STR 与 DEX **都小于** SIZ → 7；等号不算"小于"',
    movOf(40, 40, 50) === 7 && movOf(49, 49, 50) === 7, `${movOf(40, 40, 50)}/${movOf(49, 49, 50)}`);
  ok('STR 与 DEX **都不小于** SIZ → 9（等于也算）',
    movOf(50, 50, 50) === 9 && movOf(80, 50, 50) === 9 && movOf(50, 80, 50) === 9,
    `${movOf(50, 50, 50)}/${movOf(80, 50, 50)}/${movOf(50, 80, 50)}`);
  ok('一高一低 → 8', movOf(80, 30, 50) === 8 && movOf(30, 80, 50) === 8,
    `${movOf(80, 30, 50)}/${movOf(30, 80, 50)}`);

  // ── 缺属性 ──
  //
  // 判据是"缺哪个报哪个、**只丢那几项**"：改一个名字不该把另外几项也一起弄没。
  const partial = derive({ STR: 60, SIZ: 70, DEX: 50, POW: 40 });
  ok('缺 `CON` → HP 算不出来，但 MP/SAN/DB/MOV 照算（逐项独立）',
    partial.derived.hpMax === undefined && partial.derived.mpMax === 8 && partial.derived.sanMax === 40
    && partial.derived.db === '+1d4' && partial.derived.build === 1 && partial.derived.mov === 7,
    JSON.stringify(partial));
  ok('`missing` 报出缺的名字（调用方据此说一句"缺 CON"而不是"算出来是 0"）',
    JSON.stringify(partial.missing) === JSON.stringify(['CON']), JSON.stringify(partial.missing));
  ok('全是空属性 → 一个派生值都没有，`missing` 把**全部**要的名字列出来（不短路）',
    JSON.stringify(derive({}).derived) === '{}'
    && JSON.stringify(derive({}).missing) === JSON.stringify(['CON', 'SIZ', 'POW', 'STR', 'DEX']),
    JSON.stringify(derive({}).missing));

  // ── 规则表的 `chargen` 段 ──
  ok('内置 coc7 声明了 chargen（八项，掷法与规则书一致）',
    !!COC7_CHARGEN && Object.keys(COC7_CHARGEN.attributes).length === 8
    && COC7_CHARGEN.attributes.STR === '3d6*5' && COC7_CHARGEN.attributes.SIZ === '(2d6+6)*5',
    JSON.stringify(COC7_CHARGEN?.attributes));
  ok('**内置 generic 没有 chargen**（它那套没有属性生成这件事，不许为了好看硬塞一份）',
    BUILTIN_RULE_FILES.generic.chargen === undefined && GENERIC_RULE.chargen === null);
  ok('chargen 编译进规则对象（`.pc roll` 直接取它去掷）',
    JSON.stringify(COC7_RULE.chargen?.attributes) === JSON.stringify(COC7_CHARGEN.attributes));

  let chargenProblem = '';
  try {
    compileRule({
      id: 'badc', name: 'x', chargen: { attributes: { STR: '3d6*' } },
      levels: [{ name: 'a', label: 'A', success: true, condition: 'true' }]
    });
  } catch (error) {
    chargenProblem = error instanceof RuleError ? error.problems.join('；') : `不是 RuleError: ${error}`;
  }
  ok('`chargen` 的掷法写错了 → 编译期就拒绝（并指明是哪个属性）',
    /chargen/.test(chargenProblem) && /STR/.test(chargenProblem), chargenProblem);
  let emptyChargen = '';
  try {
    compileRule({
      id: 'badc2', name: 'x', chargen: { attributes: {} },
      levels: [{ name: 'a', label: 'A', success: true, condition: 'true' }]
    });
  } catch (error) {
    emptyChargen = error instanceof RuleError ? error.problems.join('；') : `不是 RuleError: ${error}`;
  }
  ok('`chargen.attributes` 是空的 → 拒绝（写了个空段比不写更坏：看起来支持、其实掷不出东西）',
    /空的/.test(emptyChargen), emptyChargen);
}

// ── 12. 条件表达式：白名单之外的一切都拒绝 ─────────────────────────────────
//
// 规则文件是**用户内容**（`data/trpg/rules/*.json` 由管理员写），所以这一节守的是
// "它绝不能变成一段能跑的代码"。`eval` / `new Function` 一次都不许出现。
{
  const vars = { total: 15, target: 10, count: 3, faces: 6, roll: 0, max: 6, min: 2 };
  const evalWith = (src, over = {}) => compileCondition(src)({ ...vars, ...over });

  ok('算术、比较、布尔与括号都能用',
    evalWith('total >= target') === true
    && evalWith('total >= target and count == 3') === true
    && evalWith('target > total or true') === true
    && evalWith('not (target > total)') === true
    && evalWith('(total - target) * 2 == 10') === true
    && evalWith('total % 4 == 3') === true);

  ok('`/` 是真除法、`//` 是向下取整（照 Python 的读法）',
    evalWith('7 / 2 == 3.5') === true && evalWith('7 // 2 == 3') === true
    && evalWith('(-7) // 2 == -4') === true);

  ok('七个变量都在（含派生量 max / min，以及"单颗时才是面值"的 roll）',
    evalWith('roll == 5', { roll: 5 }) === true
    && evalWith('max == 6 and min == 2') === true
    && evalWith('faces == 6') === true
    && evalWith('count == 3') === true);

  ok('`true` / `false` 字面量可用（兜底那一级就靠它）',
    evalWith('true') === true && evalWith('false') === false);

  // ── 拒绝路径：白名单之外的一切 ──
  const refuses = (src, label) => {
    try {
      compileCondition(src);
      ok(label, false, '居然编过了');
    } catch (error) {
      ok(label, error instanceof ConditionError && !!error.message, String(error));
    }
  };
  refuses('sqrt(total)', '函数调用被拒（不只有括号，还有前面的名字）');
  refuses('roll.constructor', '属性访问被拒');
  refuses('dice[0]', '下标被拒（`dice` 本身也不是可用变量）');
  refuses('total = 3', '赋值被拒（`=` 不是比较）');
  refuses('roll == 1; true', '分号被拒（后面还有内容）');
  refuses('roll == 1 # 注释', '注释被拒');
  refuses('"abc"', '字符串被拒');
  refuses('notARealVariable', '不认识的变量被拒，且文案列出可用的那几个');
  refuses('(total >= target', '括号没闭合');
  refuses('', '空条件被拒');
  refuses('x'.repeat(300), '超长条件被拒');
  refuses('1 +', '残缺表达式被拒');

  try { compileCondition('sqrt(total)'); } catch (error) {
    ok('报错文案带上位置与"支持的写法"（人照着就能改对）',
      /第 1 个字符|第 1 个/.test(error.message) && /支持的写法/.test(error.message), error.message);
  }
  try { compileCondition('1 / 0 == 1'); compileCondition('total / (target - 10)')(vars); } catch (error) {
    ok('除零**抛错**而不是给个 Infinity 让后面的比较悄悄变成 false',
      /除零/.test(String(error.message)), String(error.message));
  }

  // ⚠️ 数据化没有表达力损失：`generic` 那条"单颗骰掷出最大面算大成功"必须能用数据写出来。
  const crit = compileCondition(BUILTIN_RULE_FILES.generic.levels[0].condition);
  ok('内置表里那条最刁的条件（单颗 + 面数>1 + 掷出最大面）能被数据表达',
    crit({ ...vars, count: 1, faces: 20, roll: 20 }) === true
    && crit({ ...vars, count: 1, faces: 20, roll: 19 }) === false
    && crit({ ...vars, count: 2, faces: 20, roll: 20 }) === false);
}

// ── 13. 规则表的存储：种子、列表、读取、坏表拒绝 ────────────────────────────
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  const dir = path.join(DIR, 'rules');
  const store = new RuleStore(dir);

  ok('首次用到规则时把内置的补齐到目录里（懒执行，构造时不写盘）',
    !fs.existsSync(dir) && store.list().length >= 2 && fs.existsSync(path.join(dir, 'generic.json')),
    JSON.stringify(store.list().map((r) => r.id)));

  const seeded = fs.readFileSync(path.join(dir, 'generic.json'), 'utf8');
  ok('补齐的是**种子**：文件内容与源码里那份逐字一致（种子即初始状态）',
    JSON.parse(seeded).levels.length === BUILTIN_RULE_FILES.generic.levels.length);

  // 已存在的文件一律不动：升级不该覆盖管理员改过的表。
  fs.writeFileSync(path.join(dir, 'generic.json'), JSON.stringify({ name: '我改过的', levels: [
    { name: 'ok', label: '行', success: true, condition: 'true' }
  ] }), 'utf8');
  store.list();
  ok('再 ensureBuiltins 不会覆盖已存在的文件（管理员改过的表留着）',
    JSON.parse(fs.readFileSync(path.join(dir, 'generic.json'), 'utf8')).name === '我改过的');

  ok('内置表在列表里标出来（可以删，但删了看得出是内置的）',
    store.list().find((r) => r.id === 'coc7')?.builtin === true
    && store.list().find((r) => r.id === 'generic')?.builtin === true);

  const lookup = store.read('coc7');
  ok('读一张正常的表：拿到编译好的规则，且没有回落提示',
    lookup.ok === true && lookup.rule.id === 'coc7' && lookup.note === '');
  ok('读表按 mtime 缓存：同一个文件连读两次拿到同一个对象',
    store.read('coc7').rule === store.read('coc7').rule);

  const missing = store.read('查无此表');
  ok('引用的表不存在 → **回落 generic 并给一句 note**（静默回落是最忌讳的那类故障）',
    missing.ok === true && missing.rule.id === 'generic' && /不存在/.test(missing.note), JSON.stringify(missing));

  // 坏表：**拒绝**，不静默换一套 —— 静默换一套会让"同一个骰面在两局里判出不同的档"没人能解释。
  fs.writeFileSync(path.join(dir, 'broken.json'),
    JSON.stringify({ name: '坏的', levels: [{ name: 'a', label: 'A', success: true, condition: 'total >= ' }] }), 'utf8');
  const broken = store.read('broken');
  ok('坏表**拒绝**而不是回落到别的表（配置错误就该当场可见）',
    broken.ok === false && /有问题/.test(broken.message), JSON.stringify(broken));
  ok('坏表照样出现在列表里并带上问题（跳过它只会让管理员看到"少了一个"）',
    store.list().some((r) => r.id === 'broken' && r.problems.length > 0),
    JSON.stringify(store.list().find((r) => r.id === 'broken')));

  fs.rmSync(path.join(dir, 'broken.json'));
  ok('删掉之后列表里也没了，且读取回落到"不存在"那条路',
    !store.list().some((r) => r.id === 'broken') && store.read('broken').note !== '');

  // ── 改了文件要**不重启就生效** ──
  //
  // ⚠️ 这两条补的是**探针实测出来的守护空白**：把 `#load` 里"按 mtime 失效"改成"永不失效"，
  // 上面全部断言照样绿 —— 而设置页上明明写着"改完剧本或规则表**不必重启**：两者都是每次现读的"。
  // 规则表**只能手工改文件**（它没有 write 方法），所以 mtime 是唯一的失效路径，
  // 这条断言就是那句承诺的唯一凭据。
  //
  // 判据是"改了之后读到新的一版"，所以 mtime 必须**真的变**：两条内容等长，光靠写盘
  // 在有些文件系统上会落在同一个 mtime 刻度里（那样断言会假红/假绿都说不准），
  // 这里显式把 mtime 推到未来。
  const live = path.join(dir, 'live.json');
  const version = (name) => JSON.stringify({ name, levels: [{ name: 'a', label: 'A', success: true, condition: 'true' }] });
  fs.writeFileSync(live, version('第一版'), 'utf8');
  ok('第一次读拿到第一版', store.read('live').rule?.name === '第一版');
  fs.writeFileSync(live, version('第二版'), 'utf8');
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(live, future, future);
  ok('改了文件之后**不重启也读到新的一版**（按 mtime 失效，不是永不失效的缓存）',
    store.read('live').rule?.name === '第二版', String(store.read('live').rule?.name));

  // id 即文件名：**路径安全**靠 `safeFileName`，所以从命令 / URL 来的 id 穿不出目录。
  // （这一条必须在这里正面测，不能靠"文件没被删掉"间接推 —— 那在删错文件时也是绿的。）
  ok('用户起的名字过路径安全：中文保留、分隔符与 `..` 被清、Windows 保留字加前缀',
    safeFileName('../etc/passwd') === 'etcpasswd'
    && safeFileName('..') === '' && safeFileName('.') === ''
    && safeFileName('CON') === '_CON' && safeFileName('com1') === '_com1'
    && safeFileName('灯塔') === '灯塔' && safeFileName('灯塔.') === '灯塔'
    && safeFileName('') === '' && safeFileName('  ') === '');
  ok('remove 一个不存在的表返回 false（不抛）', store.remove('查无此表') === false);
}

// ── 14. 颗数真的按表达式来（rng 调用次数是唯一的证据）──────────────────────
{
  const box = counting(rollOf(6, 1, 2, 3, 4, 5, 6));
  const r = rollDice('6d6', box.rng);
  ok('6d6 恰好调用随机源 6 次（不是"多掷几颗再挑"，那会让结果分布悄悄变样）',
    box.calls === 6 && r.dice.length === 6, `calls=${box.calls}`);

  // 奖惩骰：个位掷一次、十位掷 extra+1 次 —— 多掷一个十位骰会悄悄改变分布。
  const pbox = counting(digitsOf(1, 2, 3));
  rollDice('1d100b2', pbox.rng);
  ok('1d100b2 恰好调用随机源 4 次（个位 1 + 十位 3）', pbox.calls === 4, `calls=${pbox.calls}`);

  // 多组：每一组各自掷自己的颗数。
  const mbox = counting(rollOf(6, 1, 2, 3));
  const multi = rollDice('2d6+1d4', mbox.rng);
  ok('2d6+1d4 恰好调用随机源 3 次（两组各自掷）', mbox.calls === 3 && multi.count === 3, `calls=${mbox.calls}`);
}

process.exit(done() ? 0 : 1);
