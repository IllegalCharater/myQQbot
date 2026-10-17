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

// ── 15. 战斗的先攻与指针（P5，纯函数）──────────────────────────────────────
//
// 这一段全部是**定值断言**：注入脚本化的随机源，逐面核对"谁排第几"。先攻序会直接发进群
// （`.combat start` 的回执、玩家笔记里那一段），所以它错了是**所有人都看得见**的错。
{
  const { DEFAULT_INITIATIVE, advance, clampTurn, rollInitiative } = await load('extra/trpg/rules/combat.js');

  ok('缺省的先攻属性是 DEX（规则表没声明 `initiative` 时的默认行为，写明的常量）',
    DEFAULT_INITIATIVE === 'DEX');

  const card = (name, initiative, hp = 5) => ({ name, initiative, hp });
  /** 每个参战者按名单顺序取一次平手判据 —— 脚本化：第 i 个人拿到 `want[i]`。 */
  const tiesOf = (...want) => {
    let i = 0;
    return () => want[i++] ?? 0.5;
  };

  // ── 主排序：先攻值降序 ──
  {
    const r = rollInitiative([card('阿飞', 10), card('小满', 20), card('线人', null)], () => 0.5);
    ok('按先攻值降序排（20 → 10 → 没属性按 0）',
      JSON.stringify(r.order) === JSON.stringify(['小满', '阿飞', '线人']), JSON.stringify(r));
    ok('`scores` 只含**真有那个属性**的人',
      JSON.stringify(r.scores) === JSON.stringify({ 阿飞: 10, 小满: 20 }), JSON.stringify(r.scores));
    ok('没有那个属性的人进 `missing`（回执要靠它说出"这张卡没写 DEX"）',
      JSON.stringify(r.missing) === JSON.stringify(['线人']), JSON.stringify(r.missing));
  }

  // ── ⚠️ `null` 与 `0` 是两件事 ──
  {
    // 这条是本段最要紧的一条：分不开的话，一次漏填属性会被读成"他先攻垫底" —— 那是错的方向。
    const r = rollInitiative([card('没写', null), card('真是零', 0)], () => 0.5);
    ok('**`null`（没写这一项）与 `0`（这一项真的是 0）分得开**',
      r.missing.length === 1 && r.missing[0] === '没写'
      && r.scores['真是零'] === 0 && !('没写' in r.scores),
      JSON.stringify(r));
    ok('两者都按 0 参与排序（都得有一个位置，否则轮到谁就断了）',
      r.order.length === 2, JSON.stringify(r.order));
  }

  // ── 平手：靠平手判据，而不是靠名单顺序 ──
  {
    const r = rollInitiative([card('甲', 10), card('乙', 10)], tiesOf(0.9, 0.1));
    ok('平手时按平手判据升序（名单在后的 `乙` 先动）',
      JSON.stringify(r.order) === JSON.stringify(['乙', '甲']), JSON.stringify(r.order));
    // 对照：判据也相同时退回名单顺序 —— 顺序**稳定**，不是随机的。
    const same = rollInitiative([card('甲', 10), card('乙', 10)], () => 0.5);
    ok('平手判据也相同时按名单顺序（顺序稳定，不是"每次开打都是同一批人先动"的反面）',
      JSON.stringify(same.order) === JSON.stringify(['甲', '乙']), JSON.stringify(same.order));
  }

  // ── 熵量：每人一次，与有没有平手无关 ──
  {
    const box = counting(() => 0.5);
    rollInitiative([card('甲', 10), card('乙', 20), card('丙', 30)], box.rng);
    ok('随机源恰好调用**人数**次（每人取一次判据，与有没有平手无关）',
      box.calls === 3, `calls=${box.calls}`);
  }

  // ── 坏的随机源不该毁掉排序 ──
  {
    const r = rollInitiative([card('甲', 10), card('乙', 20)], () => NaN);
    ok('坏随机源（NaN）夹成 0，排序照常按先攻值走（不崩、不随机）',
      JSON.stringify(r.order) === JSON.stringify(['乙', '甲']), JSON.stringify(r.order));
  }

  // ── 指针：夹回区间（存档可以被手改，`order[-1]` 是 `undefined`）──
  ok('`clampTurn` 把负数夹回末尾（-1 在三个人里是第 3 个）', clampTurn(-1, 3) === 2);
  ok('`clampTurn` 把越界夹回区间', clampTurn(5, 3) === 2 && clampTurn(3, 3) === 0);
  ok('`clampTurn` 对空顺序与坏输入给 0', clampTurn(0, 0) === 0 && clampTurn('x', 3) === 0
    && clampTurn(NaN, 3) === 0 && clampTurn(undefined, 3) === 0);

  const ORDER = ['甲', '乙', '丙'];
  {
    const r = advance(ORDER, { turn: 0, round: 1 });
    ok('推进一格（0 → 1，轮次不变）', r.turn === 1 && r.round === 1, JSON.stringify(r));
    const wrap = advance(ORDER, { turn: 2, round: 1 });
    ok('转回起点算一轮（2 → 0，轮次 +1）', wrap.turn === 0 && wrap.round === 2, JSON.stringify(wrap));
  }
  {
    const r = advance(ORDER, { turn: 0, round: 1 }, new Set(['乙']));
    ok('跳过动不了的人（0 → 跳过 乙 → 丙，轮次不变）',
      r.turn === 2 && r.round === 1, JSON.stringify(r));
    // 绕圈时也要跳：从丙出发、甲倒下了 → 先回到 0（轮次 +1），再跳过甲落到乙。
    const wrap = advance(ORDER, { turn: 2, round: 1 }, new Set(['甲']));
    ok('绕圈时同样跳过（2 → 回起点 轮次+1 → 跳过 甲 → 乙）',
      wrap.turn === 1 && wrap.round === 2, JSON.stringify(wrap));
  }
  {
    // ⚠️ **这条是 `advance` 里最容易写错的一处**：全员动不了时那一圈已经在循环里数过了，
    // 再 `+1` 会让一次全员昏迷**跳掉两轮**。
    const r = advance(['甲', '乙'], { turn: 0, round: 1 }, new Set(['甲', '乙']));
    ok('**全员动不了时只走一圈**（回到起点，轮次 +1 而不是 +2）',
      r.turn === 0 && r.round === 2, JSON.stringify(r));
    const empty = advance([], { turn: 0, round: 5 }, new Set());
    ok('空顺序原样返回（没有可推的东西）', empty.turn === 0 && empty.round === 5, JSON.stringify(empty));
  }
}

// ── 16. 规则扩展：编译、互斥与两个钩子（P7-c）────────────────────────────────
//
// `rules/rule-set.ts` 是**语法与互斥的权威** —— 抽取管线（`scenario/extract/mechanics.ts`）、
// 人手改过的 `<id>.rule.json`、以及开局那一步（P7-d）走的都是它。所以这一段全部是定值断言：
// 逐条核对"这份数据编译出来是什么"。
//
// ⚠️ **互斥表本身是私有的**（`EFFECT_EXCLUSIONS` 不导出），所以下面那些断言一律**从行为上探**
// —— 用 `compileRuleSet` 喂一对机制进去，看它拒不拒。探行为比探常量强：常量改名、表被换掉
// 都不影响这些断言，而"两条相反的机制真的被拦住了"才是这张表存在的全部理由。
{
  const {
    MECHANIC_TYPES, EFFECT_HANDLERS, TRIGGER_OPS, TRIGGER_ATOMS, TRIGGER_COMBINATORS,
    EMPTY_RULE_SET, isMechanicType, compileRuleSet, triggerKey, describeTrigger, describeMechanic,
    activeMechanics, applyCheckModifiers, damageBlockers
  } = await load('extra/trpg/rules/rule-set.js');

  /** 一条**一定编译得过**的机制。`over` 覆盖任意字段。 */
  const mech = (over = {}) => ({
    type: 'npc_trait',
    note: '守夜人不吃普通伤害',
    trigger: { op: 'actor', value: '守夜人' },
    effect: { handler: 'narrate', params: {} },
    sourceQuote: '守夜人刀枪不入',
    ...over
  });
  /** 只编译一条，返回 `RuleSetLookup`。 */
  const one = (over = {}) => compileRuleSet({ version: 1, mechanics: [mech(over)] });
  /** 只编译一条、且要求它成功 —— 拿它读编译结果里那条机制。 */
  const built = (over = {}) => {
    const r = one(over);
    if (!r.ok) throw new Error(`本该编译得过，却被拒了：${JSON.stringify(r.problems)}`);
    return r.set.mechanics[0];
  };
  /** 一条只带 `scene: 灯塔` 的机制 —— 用来拼互斥对。 */
  const scene = (handler, params = {}) => mech({
    trigger: { op: 'scene', value: '灯塔' }, effect: { handler, params }
  });
  const ctx = (over = {}) => ({ scene: '', flags: {}, actor: '', skill: '', ...over });

  // ── 16a. 两张清单 ──
  ok('机制类型恰好八种，且与判据同源（多一个少一个都会让抽取层与编译层对不上）',
    MECHANIC_TYPES.length === 8 && MECHANIC_TYPES.every((t) => isMechanicType(t)),
    MECHANIC_TYPES.join('/'));
  ok('`narrative_hook` 在清单里（它是认不出的 type 的**降级目标档**，缺了降级无处可去）',
    isMechanicType('narrative_hook'));
  ok('认不出的 type 与空值都不是合法类型（`isMechanicType` 不能退化成真值判断）',
    !isMechanicType('reduce_damage') && !isMechanicType('') && !isMechanicType(null)
    && !isMechanicType(undefined));
  ok('handler 恰好五个 —— **收窄是有意的**，一个都不自动改状态（没有 set_flag / damage / san_loss）',
    EFFECT_HANDLERS.length === 5
    && JSON.stringify([...EFFECT_HANDLERS])
      === JSON.stringify(['bonus_to_check', 'penalty_to_check', 'force_outcome', 'immune_to_damage', 'narrate']),
    EFFECT_HANDLERS.join('/'));
  ok('trigger 的 op 是四个原子 + 三个组合子（原子在前，提示词照这个顺序念）',
    JSON.stringify([...TRIGGER_OPS]) === JSON.stringify([...TRIGGER_ATOMS, ...TRIGGER_COMBINATORS])
    && TRIGGER_ATOMS.length === 4 && TRIGGER_COMBINATORS.length === 3);
  ok('⚠️ **没有 `item` 这个 op**：战役状态里根本没有物品栏，加一个永远为假的 op 只会让机制静默失效',
    !TRIGGER_OPS.includes('item'));

  // ── 16b. 空与形状 ──
  ok('`null` / `undefined` → 空集，而且**就是那个同一个对象**（`EMPTY_RULE_SET` 是共享常量）',
    compileRuleSet(null).set === EMPTY_RULE_SET && compileRuleSet(undefined).set === EMPTY_RULE_SET);
  ok('空集**不是**"没有规则"的同义词：基础表照旧生效，这里只说明"这一局没有特殊规则"',
    EMPTY_RULE_SET.mechanics.length === 0 && EMPTY_RULE_SET.warnings.length === 0);
  ok('不是对象（数组 / 字符串 / 数）→ 拒绝，且给的是可读的一句',
    !compileRuleSet([]).ok && !compileRuleSet('x').ok && !compileRuleSet(3).ok
    && compileRuleSet([]).problems[0] === '规则扩展的形状不对（应该是一个对象）');
  ok('版本不是 1 → 拒绝（把 `2` 当成 `1` 读会让新格式的字段静默失效）',
    !compileRuleSet({ version: 2 }).ok
    && compileRuleSet({ version: 2 }).problems[0] === '规则扩展的版本是 2，这份代码只认 1');
  ok('`mechanics` 不是数组 → 拒绝（当空数组处理的话表现是"一条机制都没有"，而文件里明明写着）',
    !compileRuleSet({ mechanics: {} }).ok
    && compileRuleSet({ mechanics: {} }).problems[0] === '规则扩展的 mechanics 要写成一个数组');
  ok('没有 `mechanics` 这一栏 → **编译得过**，但记一笔（手写的剧本本来就没有规则扩展）',
    compileRuleSet({}).ok && compileRuleSet({}).set.warnings.length === 1
    && compileRuleSet({}).set.warnings[0].includes('没有 mechanics 这一栏'));
  ok('`mechanics: []` → 编译得过且**一笔都不记**（空数组是"我明确写了没有"，与"漏了那一栏"不同）',
    compileRuleSet({ mechanics: [] }).ok && compileRuleSet({ mechanics: [] }).set.warnings.length === 0);
  ok('数组里混进一个不是对象的东西 → 拒绝并点明是第几条',
    !compileRuleSet({ mechanics: [mech(), 7] }).ok
    && compileRuleSet({ mechanics: [mech(), 7] }).problems[0] === '第 2 条机制不是一个对象');

  // ── 16c. type：认不出就降级，不拒绝 ──
  ok('认不出的 type → **降级成 `narrative_hook`**（它只是分类标签，丢了不影响判定）',
    built({ type: 'reduce_damage' }).type === 'narrative_hook');
  ok('降级那句话点名了原类型，而且说明"不影响判定"（不说的话管理员会以为那条机制没了）',
    one({ type: 'reduce_damage' }).set.warnings[0]
      === '第 1 条机制的 type「reduce_damage」我不认识，已按纯叙事处理（不影响判定）');
  ok('type 为空也走同一条路（不写成"第 1 条的 type 我不认识"这种读不出写的是什么的话）',
    one({ type: '' }).set.warnings[0].includes('type「（空）」'));

  // ── 16d. trigger ──
  ok('**`flag` 要同时写 key 与 value**：只写 value 是"哪个旗标等于是"当场丢掉，那条机制此后永不触发',
    !one({ trigger: { op: 'flag', value: '是' } }).ok
    && one({ trigger: { op: 'flag', value: '是' } }).problems[0].includes('就得写 key'));
  ok('`flag` 只写 key 也拒（"旗标存在"与"旗标为真"是两件事，读的人推不出来）',
    !one({ trigger: { op: 'flag', key: '灯灭了' } }).ok
    && one({ trigger: { op: 'flag', key: '灯灭了' } }).problems[0].includes('要同时写 key 与 value'));
  ok('`flag` 写全了就过（值原样带出来）',
    JSON.stringify(built({ trigger: { op: 'flag', key: '灯灭了', value: '是' } }).trigger)
      === JSON.stringify({ op: 'flag', key: '灯灭了', value: '是' }));
  ok('原子谓词少了 `value` → 拒绝，且**念出是哪个 op**（"就得写 value"那句要能自己定位）',
    !one({ trigger: { op: 'scene' } }).ok
    && one({ trigger: { op: 'scene' } }).problems[0].includes('op 是「scene」'));
  ok('组合子少了 `items`（或给空数组）→ 拒绝（空 `all_of` 恒为真，那是"无条件生效"的伪装）',
    !one({ trigger: { op: 'all_of', items: [] } }).ok
    && one({ trigger: { op: 'all_of', items: [] } }).problems[0].includes('非空的 items 数组'));
  ok('认不出的 op → 拒绝，并把**全部可选值念出来**（模型/人手改时照着改得动）',
    !one({ trigger: { op: 'item', value: '钥匙' } }).ok
    && one({ trigger: { op: 'item', value: '钥匙' } }).problems[0]
      === `第 1 条机制：trigger 的 op 写的是「item」，我不认识（只有 ${TRIGGER_OPS.join(' / ')}）`);
  ok('trigger 不是对象（写成字符串 / 数组）→ 拒绝',
    !one({ trigger: '灯塔' }).ok && !one({ trigger: [] }).ok
    && one({ trigger: '灯塔' }).problems[0].includes('trigger 要写成一个对象'));
  {
    const wrap = (n, leaf) => { let node = leaf; for (let i = 0; i < n; i += 1) node = { op: 'all_of', items: [node] }; return node; };
    ok('嵌套三层组合子照常过（"这一场且灯灭了且不是守夜人"就在这一档）',
      one({ trigger: wrap(3, { op: 'scene', value: '灯塔' }) }).ok);
    ok('嵌套超过上限 → 拒绝并说明上限（深度是**成本**，也是"读得懂"的上限）',
      !one({ trigger: wrap(4, { op: 'scene', value: '灯塔' }) }).ok
      && one({ trigger: wrap(4, { op: 'scene', value: '灯塔' }) }).problems[0].includes('嵌套太深了'));
  }

  // ── 16e. effect：认不出的 handler 拒绝（与 type 相反）──
  ok('⚠️ **认不出的 handler 是拒绝而不是降级**：它是"这条机制要做什么"，不认识就没法诚实地应用它',
    !one({ effect: { handler: 'reduce_damage' } }).ok
    && one({ effect: { handler: 'reduce_damage' } }).problems[0]
      === `第 1 条机制：effect.handler 写的是「reduce_damage」，我不认识它（只有 ${EFFECT_HANDLERS.join(' / ')}）`);
  ok('handler 是空值也拒，且那句话印的是「（空）」而不是 `undefined`',
    one({ effect: {} }).problems[0].includes('写的是「（空）」'));
  ok('effect 不是对象 → 拒绝',
    !one({ effect: 'narrate' }).ok && one({ effect: 'narrate' }).problems[0].includes('effect 要写成一个对象'));
  ok('`bonus_to_check` 缺 `value` → 拒绝，并把允许区间写出来（+200 那种笔误该当场拦）',
    !one({ effect: { handler: 'bonus_to_check' } }).ok
    && one({ effect: { handler: 'bonus_to_check' } }).problems[0].includes('1–100 的整数'));
  ok('`value` 写成字符串 `"20"` → **收下并转成数**（模型偶尔这么写，为此拒一条机制不划算）',
    built({ effect: { handler: 'bonus_to_check', params: { value: '20' } } }).effect.params.value === 20);
  ok('但别的类型一律不收：`true` / `"abc"` / 越界 / 小数都拒（它们说明这一栏写的不是数）',
    !one({ effect: { handler: 'bonus_to_check', params: { value: true } } }).ok
    && !one({ effect: { handler: 'bonus_to_check', params: { value: 'abc' } } }).ok
    && !one({ effect: { handler: 'bonus_to_check', params: { value: 0 } } }).ok
    && !one({ effect: { handler: 'bonus_to_check', params: { value: 101 } } }).ok
    && !one({ effect: { handler: 'penalty_to_check', params: { value: 20.5 } } }).ok);
  ok('两个加减 handler 都**写正数**，方向由 handler 决定（允许负数的话"penalty + (-20)"要读代码才知道）',
    one({ effect: { handler: 'penalty_to_check', params: { value: -20 } } }).problems[0].includes('都写正数'));
  ok('`force_outcome` 的 `outcome` 只认 success / failure（写别的没法判，也没法回执）',
    !one({ effect: { handler: 'force_outcome', params: {} } }).ok
    && !one({ effect: { handler: 'force_outcome', params: { outcome: 'maybe' } } }).ok);
  ok('`force_outcome` 不写 grade / label 时给一套默认（回执不能出现空白档位）',
    JSON.stringify(built({ effect: { handler: 'force_outcome', params: { outcome: 'success' } } }).effect.params)
      === JSON.stringify({ outcome: 'success', grade: 'forced', label: '机制强制成功' }));
  ok('写了就原样留着（失败那一档的默认文案与成功不同）',
    built({ effect: { handler: 'force_outcome', params: { outcome: 'failure', grade: '必败', label: '这一枪打不中' } } })
      .effect.params.label === '这一枪打不中'
    && built({ effect: { handler: 'force_outcome', params: { outcome: 'failure' } } })
      .effect.params.label === '机制强制失败');
  ok('`immune_to_damage` / `narrate` 多写的一律忽略（为"顺手多写一栏"整条拒绝不划算）',
    JSON.stringify(built({ effect: { handler: 'immune_to_damage', params: { value: 5 } } }).effect.params)
      === JSON.stringify({})
    && JSON.stringify(built({ effect: { handler: 'narrate', params: { 胡说: 1 } } }).effect.params)
      === JSON.stringify({}));

  // ── 16f. narrative_hook 的语义：强制 narrate ──
  ok('`narrative_hook` 写了别的 handler → 记一笔并**按纯叙事处理**（分类与判定对不上该说出来）',
    one({ type: 'narrative_hook', effect: { handler: 'bonus_to_check', params: { value: 20 } } })
      .set.warnings[0].includes('是 narrative_hook，却写了 bonus_to_check')
    && built({ type: 'narrative_hook', effect: { handler: 'bonus_to_check', params: { value: 20 } } })
      .effect.handler === 'narrate');
  ok('`narrative_hook` 的 effect 看不懂时也只记一笔（它本来就不参与判定）',
    one({ type: 'narrative_hook', effect: 'oops' }).set.warnings[0].includes('effect 看不懂')
    && built({ type: 'narrative_hook', effect: 'oops' }).effect.handler === 'narrate');
  ok('`narrative_hook` **可以不写 trigger**（trigger 为 `null` = 无条件，对纯叙事提示是正当的）',
    built({ type: 'narrative_hook', trigger: undefined }).trigger === null);
  ok('⚠️ 别的 type 不写 trigger → **拒绝**（无条件生效的判定会让每一次检定都受影响）',
    !one({ trigger: undefined }).ok
    && one({ trigger: undefined }).problems[0]
      === '第 1 条机制（npc_trait）没写 trigger —— 无条件生效的判定会让每一次检定都受影响');
  ok('`trigger: null` 与"没写"同义（都走上面那条路，不另开一个分岔）',
    !one({ trigger: null }).ok && one({ trigger: null }).problems[0].includes('没写 trigger'));

  // ── 16g. 互斥表（决定 4）──
  const pair = (a, b) => compileRuleSet({ version: 1, mechanics: [a, b] });
  ok('同一个触发条件下 **加值 vs 减值 → 拒绝**，那句话同时点出两条的序号与各自的 handler',
    !pair(scene('bonus_to_check', { value: 20 }), scene('penalty_to_check', { value: 20 })).ok
    && pair(scene('bonus_to_check', { value: 20 }), scene('penalty_to_check', { value: 20 })).problems[0]
      === '第 1 条与第 2 条的触发条件相同（场景：灯塔），但一条是 bonus_to_check、一条是 penalty_to_check'
        + ' —— 两条不能同时生效，只能留一条');
  ok('反着写（减值在前）照样拒 —— 表是**对称**的，读的人不必自己推',
    !pair(scene('penalty_to_check', { value: 20 }), scene('bonus_to_check', { value: 20 })).ok);
  ok('`force_outcome` 与自己互斥（同一个条件下"必中"和"必败"不能共存，两条"必中"更是重复）',
    !pair(scene('force_outcome', { outcome: 'success' }), scene('force_outcome', { outcome: 'failure' })).ok);
  ok('`force_outcome` 与加减也互斥（同时算的话"必中"这句话就没有意义了）',
    !pair(scene('bonus_to_check', { value: 20 }), scene('force_outcome', { outcome: 'success' })).ok
    && !pair(scene('penalty_to_check', { value: 20 }), scene('force_outcome', { outcome: 'success' })).ok);
  ok('⚠️ **上面那条两个方向都要成立** —— 只看先出现的那一条那一行会让闸门变成顺序相关，'
    + '而 `rule.json` 里谁写在前面是抽取时模型给的顺序（曾经的写法就是单向的，'
    + '于是"先写加值、后写必中"那份文件编译得过、两条机制一起开了局）',
    !pair(scene('force_outcome', { outcome: 'success' }), scene('bonus_to_check', { value: 20 })).ok
    && !pair(scene('force_outcome', { outcome: 'success' }), scene('penalty_to_check', { value: 20 })).ok
    && !pair(scene('force_outcome', { outcome: 'success' }), scene('force_outcome', { outcome: 'failure' })).ok);
  ok('（正对照）同一个触发条件下**两条加值不互斥** —— 它们相加，那是规则书里常见的东西',
    pair(scene('bonus_to_check', { value: 20 }), scene('bonus_to_check', { value: 5 })).ok);
  ok('（正对照）`immune_to_damage` / `narrate` 不与任何东西冲突：免疫是同向的，叙事提示与判定并行不悖',
    pair(scene('immune_to_damage'), scene('bonus_to_check', { value: 20 })).ok
    && pair(scene('narrate'), scene('penalty_to_check', { value: 20 })).ok
    && pair(scene('narrate'), scene('narrate')).ok);
  ok('**触发条件不同就不互斥**（"灯塔里 -20"与"守夜人 +20"是两条各管一摊的规则）',
    pair(scene('bonus_to_check', { value: 20 }), mech({ effect: { handler: 'penalty_to_check', params: { value: 20 } } })).ok);
  ok('⚠️ 组合子的子节点**换顺序**后仍算同一个条件（不排序的话换个顺序就能绕过这张表）',
    !pair(
      mech({ trigger: { op: 'all_of', items: [{ op: 'scene', value: '灯塔' }, { op: 'flag', key: '灯灭了', value: '是' }] }, effect: { handler: 'bonus_to_check', params: { value: 20 } } }),
      mech({ trigger: { op: 'all_of', items: [{ op: 'flag', key: '灯灭了', value: '是' }, { op: 'scene', value: '灯塔' }] }, effect: { handler: 'penalty_to_check', params: { value: 20 } } })
    ).ok);
  ok('互斥是**编译期**的：被拒时 `ok` 为假，而 `mechanics` 一条都不交出去（不是"交一半再报错"）',
    !pair(scene('bonus_to_check', { value: 20 }), scene('penalty_to_check', { value: 20 })).set);
  ok('超条数上限时**截断并记一笔**（它每条都进 system prompt，是成本不是洁癖）', (() => {
    const many = Array.from({ length: 41 }, (_, i) => mech({ trigger: { op: 'scene', value: `场${i}` } }));
    const r = compileRuleSet({ version: 1, mechanics: many });
    return r.ok && r.set.mechanics.length === 40
      && r.set.warnings.some((w) => w.includes('超过 40 条上限') && w.includes('第 41 条起没进来'));
  })());

  // ── 16h. 指纹与人话 ──
  ok('`triggerKey(null)` 是 `*`（无条件那一档也要有个键，否则两条"无条件"永远不互斥）',
    triggerKey(null) === '*');
  ok('指纹把组合子的子节点排序后拼（与上面那条换顺序的断言同源，两处都要成立）',
    triggerKey({ op: 'any_of', items: [{ op: 'scene', value: '灯塔' }, { op: 'actor', value: '守夜人' }] })
      === triggerKey({ op: 'any_of', items: [{ op: 'actor', value: '守夜人' }, { op: 'scene', value: '灯塔' }] }));
  ok('指纹区分 op：`scene:灯塔` 与 `actor:灯塔` 不是同一个条件',
    triggerKey({ op: 'scene', value: '灯塔' }) !== triggerKey({ op: 'actor', value: '灯塔' }));
  ok('`describeTrigger` 给的是中文人话（回执与提示词共用它）',
    describeTrigger({ op: 'flag', key: '灯灭了', value: '是' }) === '旗标：灯灭了 = 是'
    && describeTrigger({ op: 'all_of', items: [{ op: 'scene', value: '灯塔' }, { op: 'skill', value: '侦查' }] })
      === '（场景：灯塔 且 技能：侦查）'
    && describeTrigger({ op: 'none_of', items: [{ op: 'actor', value: '守夜人' }] }) === '（非 角色：守夜人）'
    && describeTrigger(null) === '无条件');
  ok('`describeMechanic` 一行给全：note（模型写的）+ type + 触发条件 —— 提示词与回执**共用这一个拼法**',
    describeMechanic(built()) === '守夜人不吃普通伤害（npc_trait / 角色：守夜人）');
  ok('没写 note 时退化成触发条件（不印出一个空括号）',
    describeMechanic(built({ note: '' })) === '角色：守夜人（npc_trait / 角色：守夜人）');

  // ── 16i. 求值：判定是**去空白后的全等**，不做子串匹配 ──
  {
    const set = compileRuleSet({
      version: 1,
      mechanics: [
        mech({ trigger: { op: 'scene', value: '灯塔' } }),
        mech({ trigger: { op: 'flag', key: '灯灭了', value: '是' } }),
        mech({ trigger: { op: 'skill', value: '侦查' } }),
        mech({ type: 'narrative_hook', trigger: undefined })
      ]
    }).set;
    const names = (c) => activeMechanics(set, ctx(c)).length;
    ok('场景**全等**才算命中（中文没有分词：`includes` 会让「灯塔的雾」误报）',
      names({ scene: '灯塔' }) === 2 && names({ scene: '灯塔的雾' }) === 1);
    ok('比对前两侧都去空白（`" 灯塔 "` 与 `"灯塔"` 是同一个场景）',
      names({ scene: ' 灯塔 ' }) === 2);
    ok('旗标要**键与值都对上**（键对值不对 = 没命中）',
      names({ flags: { 灯灭了: '是' } }) === 2 && names({ flags: { 灯灭了: '否' } }) === 1
      && names({ flags: {} }) === 1);
    ok('技能名同样全等（`侦查` 命中，`侦查（视觉）` 不命中）',
      names({ skill: '侦查' }) === 2 && names({ skill: '侦查（视觉）' }) === 1);
    ok('**无条件的机制（trigger 为 null）总是命中** —— 那正是纯叙事提示该有的行为',
      names({}) === 1);
  }
  {
    const wrap = (op, items) => compileRuleSet({
      version: 1, mechanics: [mech({ trigger: { op, items } })]
    }).set;
    const c = { scene: '灯塔', actor: '守夜人' };
    const hit = (op, items) => activeMechanics(wrap(op, items), ctx(c)).length === 1;
    const A = { op: 'scene', value: '灯塔' };
    const B = { op: 'actor', value: '守夜人' };
    const C = { op: 'actor', value: '线人' };
    ok('`all_of` 全中才命中', hit('all_of', [A, B]) && !hit('all_of', [A, C]));
    ok('`any_of` 中一个就命中', hit('any_of', [A, C]) && hit('any_of', [C, B]) && !hit('any_of', [C]));
    ok('`none_of` 是"一个都不中"（不是"不全中"）', hit('none_of', [C]) && !hit('none_of', [A, C]));
  }

  // ── 16j. 检定钩子 ──
  {
    const set = (list) => compileRuleSet({ version: 1, mechanics: list }).set;
    const C = ctx({ scene: '灯塔', actor: '守夜人', skill: '侦查' });
    const bonus = (v) => mech({ trigger: { op: 'scene', value: '灯塔' }, effect: { handler: 'bonus_to_check', params: { value: v } } });
    const penalty = (v) => mech({ trigger: { op: 'skill', value: '侦查' }, effect: { handler: 'penalty_to_check', params: { value: v } } });
    const forced = (outcome) => mech({ trigger: { op: 'actor', value: '守夜人' }, effect: { handler: 'force_outcome', params: { outcome } } });

    const none = applyCheckModifiers(set([mech({ trigger: { op: 'scene', value: '别处' } })]), C, 60);
    ok('没有机制命中时**原样返回**目标值（不夹紧、不加 0）',
      none.target === 60 && none.applied.length === 0 && none.overridden.length === 0 && !none.judge);

    const plus = applyCheckModifiers(set([bonus(20)]), C, 60);
    ok('加值真的加在目标值上，并且把生效的那条报出来（回执要说清"为什么是 80"）',
      plus.target === 80 && plus.applied.length === 1 && plus.applied[0].type === 'npc_trait');

    const mixed = applyCheckModifiers(set([bonus(20), penalty(5)]), C, 60);
    ok('多条同时命中时**都算**（20 加、5 减 → 75）', mixed.target === 75 && mixed.applied.length === 2);

    const floor = applyCheckModifiers(set([penalty(20)]), C, 10);
    ok('⚠️ **不夹紧结果**：`-20` 打在 10 的检定上得到 `-10`（那是"这一枪不可能成"，是机制的正当表达）',
      floor.target === -10);

    const force = applyCheckModifiers(set([bonus(20), forced('success')]), C, 60);
    ok('`force_outcome` 一命中 → **加减全部作废**，而且被盖住的那几条记进 `overridden`',
      force.target === 60 && force.applied.length === 1 && force.applied[0].effect.handler === 'force_outcome'
      && force.overridden.length === 1 && force.overridden[0].effect.handler === 'bonus_to_check');
    ok('给出的 `judge` 直接返回那一档（**传了 judge 就完全绕过等级表**，那是 `resolveCheck` 的现成钩子）',
      force.judge({}).success === true && force.judge({}).grade === 'forced'
      && force.judge({}).label === '机制强制成功');
    const forcedFail = applyCheckModifiers(set([forced('failure')]), C, 60);
    ok('强制失败那一档同样成立（success 为假、档位与文案来自机制自己）',
      forcedFail.judge({}).success === false && forcedFail.judge({}).grade === 'forced'
      && forcedFail.judge({}).label === '机制强制失败');

    const blocked = damageBlockers(set([mech({ trigger: { op: 'actor', value: '守夜人' }, effect: { handler: 'immune_to_damage', params: {} } })]), C);
    ok('`damageBlockers` 只挑"免疫伤害"那几条（它是**闸门**，不是"自动把伤害改成 0"）',
      blocked.length === 1 && blocked[0].effect.handler === 'immune_to_damage');
    ok('不命中时返回空数组（调用方据此照常扣血）',
      damageBlockers(set([mech({ trigger: { op: 'actor', value: '线人' }, effect: { handler: 'immune_to_damage', params: {} } })]), C).length === 0);
    ok('`narrate` **不算**免疫（两条都叫"不参与判定"，但一个挡伤害、一个只给提示，不能混）',
      damageBlockers(set([mech({ trigger: { op: 'actor', value: '守夜人' } })]), C).length === 0);
  }
}

// ── 17. 规则的**唯一取用口**（P7-d，决定 3）──────────────────────────────────
//
// `model/rule-set.ts` 是"这一局按什么规则判"的**唯一**答案：六处消费点全走它，谁都不再自己
// `rules.read`。它把两件事合成一次取用 —— 基础表（`RuleStore.read` 那一路）与这一局冻结的
// 规则扩展（`ruleExt`，`compileRuleSet` 那一路）。
//
// ⚠️ 这一段的每一条都对着一种**安静的坏法**（探针实测过：改掉之后行为断言一条都不红）：
//   • 基础表那句 `note`（引用的表不存在 → 回落 generic）必须**原样透传** —— 吞掉的话
//     "填了、看着生效、实际用的是别的"就回来了；
//   • 规则扩展坏了必须**拒绝**（`ok: false`），**不是**回落成空集 —— 静默丢掉一局自己的机制，
//     表现是"这些规则填了、一条都没跑"，而群里一切照常；
//   • `sceneMechanics` 读不出来时给 `null` 而不是 `[]` —— 合并成一个会让"规则集坏了"
//     看起来像"这一场很太平"。
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { ruleSetOf, ruleSetFor, mechanicContextOf, sceneMechanics } =
    await load('extra/trpg/model/rule-set.js');
  const { compileRuleSet, EMPTY_RULE_SET } = await load('extra/trpg/rules/rule-set.js');
  // 自己一个目录：§13 那份 `rules/` 被那一段改过（`generic.json` 换成了"我改过的"），
  // 借它的目录会让这里的"回落 generic"读到别人改过的表。
  const dir = path.join(DIR, 'rs');
  const rules = new RuleStore(dir);

  /** 一份战役对象。取用口只读 `rule` / `scenario?.ruleExt` / `scene` / `flags` 四处。 */
  const camp = (over = {}) => ({ rule: 'coc7', scene: '', flags: {}, ...over });
  /** 一条编译得过的机制。 */
  const mech = (over = {}) => ({
    type: 'npc_trait',
    note: '守夜人不吃普通伤害',
    trigger: { op: 'scene', value: '灯塔' },
    effect: { handler: 'narrate', params: {} },
    sourceQuote: '守夜人刀枪不入',
    ...over
  });
  /** 一份规则扩展（`<id>.rule.json` 的形状）。 */
  const ext = (...mechanics) => ({ version: 1, mechanics, warnings: [] });
  /** 同 trigger 下互斥的两条 —— 编译必拒（互斥表在 `rules/rule-set.ts` 里写死）。 */
  const CLASH = () => ext(
    mech({ effect: { handler: 'bonus_to_check', params: { value: 20 } } }),
    mech({ effect: { handler: 'penalty_to_check', params: { value: 5 } } })
  );

  // ── 17a. 基础表那一路：三种结果逐字透传 ──
  const plain = ruleSetOf('coc7', undefined, rules);
  ok('没有扩展时 `set` 就是那个空集常量（空集不是"没有规则"—— 基础表照常在 `base` 里）',
    plain.ok === true && plain.base.id === 'coc7' && plain.set === EMPTY_RULE_SET
    && plain.set.mechanics.length === 0 && plain.note === '',
    plain.ok ? `${plain.base.id}/${plain.note}` : plain.message);
  ok('`null` 与 `undefined` 一视同仁（手写的剧本一个扩展都没有，那是常态不是错误）',
    ruleSetOf('coc7', null, rules).ok === true && ruleSetOf('coc7', null, rules).set.mechanics.length === 0);

  const missing = ruleSetOf('查无此表', undefined, rules);
  ok('引用的基础表不存在 → 仍 `ok`，回落 generic，且**那句 note 原样带出来**（取用口不许吞掉它）',
    missing.ok === true && missing.base.id === 'generic' && /不存在/.test(missing.note),
    missing.ok ? missing.note : missing.message);

  fs.writeFileSync(path.join(dir, 'broken.json'),
    JSON.stringify({ name: '坏', levels: [{ name: 'a', label: 'A', success: true, condition: 'total >= ' }] }), 'utf8');
  const brokenBase = ruleSetOf('broken', undefined, rules);
  ok('基础表本身坏了 → `ok: false`，消息与 `RuleStore.read` 那句同源（判据没有第二份）',
    brokenBase.ok === false && /有问题/.test(brokenBase.message), JSON.stringify(brokenBase));

  // ── 17b. 扩展那一路：编译不过就拒绝 ──
  const good = ruleSetOf('coc7', ext(mech()), rules);
  ok('扩展编译得过 → 机制进 `set`，`base` 仍是那张基础表',
    good.ok === true && good.set.mechanics.length === 1 && good.base.id === 'coc7'
    && good.set.mechanics[0].note === '守夜人不吃普通伤害');

  const clash = ruleSetOf('coc7', CLASH(), rules);
  ok('同 trigger 下互斥的两条 → **拒绝**（`ok: false`），不是静默丢掉其中一条',
    clash.ok === false, JSON.stringify(clash));
  // 判据是"逐字等于前缀 + 底层 `problems` 用 `；` 连起来"，不是"消息里碰巧有个 `；`"——
  // 只有一条 problem 时那个分隔符根本不出现，按"含 `；`"写会红（实测踩到）。
  const clashProblems = compileRuleSet(CLASH());
  ok('拒绝时那句消息**自报家门**（前缀 + 逐条原样带出），调用方整句照印就够用',
    clash.ok === false && clashProblems.ok === false
    && clash.message === `这一局的规则扩展有问题：${clashProblems.problems.join('；')}`,
    clash.ok ? '' : clash.message);
  ok('扩展坏掉时**不是**回落成空集（回落的表现是"机制填了、一条都没跑"，而没有人看得出来）',
    clash.ok === false && !('set' in clash) && !('base' in clash));

  // ── 17b2. `source` / `problems`（P7-f 加）──
  //
  // **只有 `beginCampaign` 读这两个字段**：`source` 决定回执里指哪一份文件（基础表 →
  // `data/trpg/rules/<id>.json`；扩展 → `data/trpg/scenarios/<剧本>.rule.json`），`problems`
  // 决定"逐条说"时说的是哪几条。六处消费点**不读**（它们只照印 `message`，失败形状逐字不变）。
  ok('坏在**基础表**那头 → `source: \'base\'`，且 `problems` 只有一条（分条能力住在 `rule-store.ts`，'
    + '这一层再拆一次就是第二份判据）',
    brokenBase.ok === false && brokenBase.source === 'base'
    && brokenBase.problems.length === 1 && brokenBase.problems[0] === brokenBase.message,
    JSON.stringify(brokenBase));
  ok('坏在**规则扩展**那头 → `source: \'extension\'`，`problems` 就是 `compileRuleSet` 的原样逐条',
    clash.ok === false && clash.source === 'extension' && clashProblems.ok === false
    && clash.problems.length === clashProblems.problems.length
    && clash.problems.every((one, at) => one === clashProblems.problems[at]),
    JSON.stringify(clash));

  // 两条问题的夹具：**两条**都写坏 effect（`coerceEffect` 失败在互斥检查**之前** `return`，
  // 所以两条各留一条 problem，而不是被互斥吃掉一条）。
  const BAD_TWO = () => ext(
    mech({ effect: { handler: 'reduce_damage', params: {} } }),
    mech({ effect: { handler: 'reduce_damage', params: {} } })
  );
  const badTwo = BAD_TWO();
  const badTwoProblems = compileRuleSet(badTwo);
  const badTwoAccess = ruleSetOf('coc7', badTwo, rules);
  ok('`problems` 是**逐条**的（两条问题就是两条），不是把 `message` 再切一遍 —— '
    + '切分要另写一份判据，而它与 `compileRuleSet` 必然漂移',
    badTwoProblems.ok === false && badTwoProblems.problems.length === 2
    && badTwoAccess.ok === false && badTwoAccess.problems.length === 2
    && badTwoAccess.problems.every((one, at) => one === badTwoProblems.problems[at]),
    JSON.stringify(badTwoAccess));
  ok('两条问题各自带着自己的序号 —— "逐条说"不等于把同一句话印两遍',
    badTwoAccess.ok === false && badTwoAccess.problems[0] !== badTwoAccess.problems[1]
    && badTwoAccess.problems[0].includes('第 1 条') && badTwoAccess.problems[1].includes('第 2 条'),
    JSON.stringify(badTwoAccess.ok ? '' : badTwoAccess.problems));
  ok('成功那一档**没有** `source` / `problems` 两个字段（`\'source\' in good` 为假）—— '
    + '否则调用方会以为成功时也该去看它们',
    !('source' in good) && !('problems' in good));

  // ── 17c. 两个入口、一份实现 ──
  ok('`ruleSetFor(campaign)` 与 `ruleSetOf(campaign.rule, campaign.scenario?.ruleExt)` 逐项同源',
    ruleSetFor(camp({ rule: 'coc7' }), rules).base.id === 'coc7'
    && ruleSetFor(camp({ rule: '查无此表' }), rules).note === ruleSetOf('查无此表', undefined, rules).note
    && ruleSetFor(camp({ rule: 'broken' }), rules).ok === false);
  ok('战役里**冻结的那一份** `ruleExt` 被读出来（快照，不是剧本文件此刻那份）',
    ruleSetFor(camp({ scenario: { id: 'x', body: '', ruleExt: ext(mech()) } }), rules).set.mechanics.length === 1);
  ok('冻结的 `ruleExt` 坏了 → 同样拒绝（正常路径上开局已经拦过，能到这儿只有"有人手改了存档"）',
    ruleSetFor(camp({ scenario: { id: 'x', body: '', ruleExt: CLASH() } }), rules).ok === false);
  ok('没有 `scenario` 的战役不炸（那个 `?.` 是必需的：`.trpg new` 起的团可以没有剧本）',
    ruleSetFor(camp({ scenario: undefined }), rules).ok === true
    && ruleSetFor(camp({ scenario: null }), rules).ok === true);

  // ── 17d. 求值上下文：旗标摊平、暗线照样进 ──
  const ctxOf = mechanicContextOf(camp({
    scene: '灯塔',
    flags: { 灯塔已熄: { value: '是', visible: true }, 真凶是医生: { value: '是', visible: false } }
  }), '阿飞', '侦查');
  ok('旗标**摊平成 名字 → 值**（存档里那份是 `{value, visible}`，而机制匹配只问值）',
    ctxOf.flags['灯塔已熄'] === '是' && typeof ctxOf.flags['灯塔已熄'] === 'string',
    JSON.stringify(ctxOf.flags));
  ok('**暗线旗标照样进上下文** —— 机制本来就该能挂在暗线上，可见性是展示层的事',
    ctxOf.flags['真凶是医生'] === '是');
  ok('场景与行动者/技能原样带上（它们分别决定 `{op:scene}` / `{op:actor}` / `{op:skill}` 三类命中）',
    ctxOf.scene === '灯塔' && ctxOf.actor === '阿飞' && ctxOf.skill === '侦查');
  ok('没传行动者/技能时是**空串**（`{op:actor}` 因此不命中 —— 裸掷骰不该被角色的机制影响）',
    mechanicContextOf(camp(), '', '').actor === '' && mechanicContextOf(camp(), '', '').skill === '');
  ok('没有旗标的战役给出空对象（不是 `undefined`：`matcher` 靠它做空串兜底）',
    Object.keys(mechanicContextOf(camp(), '', '').flags).length === 0);

  // ── 17e. `sceneMechanics`：空数组与 `null` 是两件事 ──
  const withExt = (ruleExt, scene = '灯塔') => camp({ scene, scenario: { id: 'x', body: '', ruleExt } });
  const hit = sceneMechanics(withExt(ext(mech())), rules);
  ok('场景对得上 → 命中那条（这一份就是"换场景时该报给 DM 的东西"）',
    Array.isArray(hit) && hit.length === 1 && hit[0].note === '守夜人不吃普通伤害');
  ok('场景对不上 → **空数组**（"这一刻没有机制命中"，什么都不用说）',
    Array.isArray(sceneMechanics(withExt(ext(mech()), '别处'), rules))
    && sceneMechanics(withExt(ext(mech()), '别处'), rules).length === 0);
  ok('**读不出来时是 `null`，不是 `[]`** —— 合并成一个会让"规则集坏了"看起来像"这一场很太平"',
    sceneMechanics(withExt(CLASH()), rules) === null);
  ok('基础表坏了时同样是 `null`（两种坏法走同一条出口）',
    sceneMechanics(camp({ rule: 'broken' }), rules) === null);
  ok('`{op:actor}` / `{op:skill}` 那一类在这一份里**不命中**（行动者要到检定的那一刻才知道，这不是漏了）',
    sceneMechanics(withExt(ext(mech({ trigger: { op: 'actor', value: '守夜人' } }))), rules).length === 0);
}

process.exit(done() ? 0 : 1);
