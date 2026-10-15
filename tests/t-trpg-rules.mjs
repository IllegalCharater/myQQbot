// 跑团规则引擎：骰子表达式与检定。
//
// 这是跑团里唯一"错了会毁掉整局信任"的部分，所以本套件的重点是**可复现**与**可复核**：
// 每一条都用注入的确定随机源跑，逐面核对 `dice` / `kept` / `total` 三个数，
// 而不是"结果落在合法区间里"这种什么都证明不了的断言。
//
// 没有文件、没有网络、没有子进程 —— 被测的两个模块是纯函数，连 config 都不 import。
import { checker, dataDir } from './lib/harness.mjs';
import { load } from './lib/src.mjs';

// 与别的套件同一条纪律：先造临时数据目录，再 load 任何模块。
// （这两个模块当下不碰 DATA_DIR，但保持这个顺序，将来它们真要用时不会静默写进真 data/。）
dataDir('qqagent-trpg-rules-');

const { ok, done } = checker();
const { DiceError, rollDice } = await load('extra/trpg/rules/dice.js');
const { defaultJudge, resolveCheck } = await load('extra/trpg/rules/check.js');

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

/** 一个 rng 被调用了几次。用来验"颗数真的按表达式来"。 */
const counting = (inner) => {
  const box = { calls: 0 };
  box.rng = () => { box.calls++; return inner(); };
  return box;
};

// ── 1. 解析与求值：逐面核对 ─────────────────────────────────────────────────
{
  const r = rollDice('3d6', rollOf(6, 4, 2, 5));
  ok('3d6：三颗骰子的面值按掷出顺序原样保留', JSON.stringify(r.dice) === '[4,2,5]', JSON.stringify(r.dice));
  ok('3d6：没有 kh/kl 时 kept 就是 dice', JSON.stringify(r.kept) === '[4,2,5]' && r.dropped === 0);
  ok('3d6：total 是各面之和', r.total === 11, String(r.total));
  ok('3d6：count / faces 如实回填', r.count === 3 && r.faces === 6);

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

  const flat = rollDice('12');
  ok('纯数字：没有骰子、dice 为空、total 就是它本身',
    flat.count === 0 && flat.faces === 0 && flat.dice.length === 0 && flat.total === 12, JSON.stringify(flat));

  const spaced = rollDice('  4 D 6 KH 3  ', rollOf(6, 6, 5, 4, 1));
  ok('空白与前缀大写都被归一化（expr 回显的是归一化后的形态）',
    spaced.expr === '4d6kh3' && spaced.total === 15, JSON.stringify(spaced));
}

// ── 2. kh / kl 真的留对了 ──────────────────────────────────────────────────
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
}

// ── 3. 失败要说清楚（工具会把 error.message 原样回给模型）────────────────────
{
  const fails = (expr, code, label) => {
    try {
      rollDice(expr);
      ok(label, false, '居然没抛错');
    } catch (error) {
      const isOurs = error instanceof DiceError;
      const has = (message) => /骰子|支持|颗数|面数|保留|目标值/.test(String(error.message));
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
  fails('4d6kh0', 'KEEP_COUNT', 'kh0 报 KEEP_COUNT');
  fails('4d6kh5', 'KEEP_COUNT', 'kh 超过颗数报 KEEP_COUNT');
  fails('3d6+', 'SYNTAX', '残缺修饰报 SYNTAX');
  fails('abc', 'SYNTAX', '不是表达式报 SYNTAX');
  fails('2d6+1d4', 'SYNTAX', '多组相加报 SYNTAX（刻意不支持，文案要点出这点）');
  fails('3d6x', 'SYNTAX', '未知修饰报 SYNTAX');

  // 文案必须带上"下一步" —— 模型照着它才改得对。三条都要在。
  try { rollDice('2d6+1d4'); } catch (error) {
    ok('报错文案给出了可执行的下一步（支持的形态 + 一次只能掷一组）',
      /3d6/.test(error.message) && /一次只能掷一组骰子/.test(error.message), String(error.message));
  }
}

// ── 4. 可复现：同一个 rng 序列必得同一个结果 ────────────────────────────────
{
  const build = () => rollOf(6, 3, 1, 4, 1, 5, 9 % 6);
  const a = rollDice('3d6+2', build());
  const b = rollDice('3d6+2', build());
  ok('同序列两次掷骰逐字段相同（这是"可复核"的机械前提）',
    JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);

  // 不变式：三条，换任意表达式都成立。随机跑一批，比钉死几个用例更值。
  let invariantOk = true;
  let detail = '';
  for (let i = 0; i < 200 && invariantOk; i++) {
    const n = 1 + (i % 7);
    const faces = 2 + (i % 11);
    const keep = 1 + (i % n);
    const expr = i % 3 === 0 ? `${n}d${faces}kh${keep}` : i % 3 === 1 ? `${n}d${faces}kl${keep}` : `${n}d${faces}`;
    const r = rollDice(expr);
    const sum = r.kept.reduce((s, v) => s + v, 0);
    if (r.dice.length !== r.count) { invariantOk = false; detail = `${expr}: dice.length ${r.dice.length} ≠ count ${r.count}`; }
    else if (r.kept.length + r.dropped !== r.dice.length) { invariantOk = false; detail = `${expr}: kept+dropped ≠ dice`; }
    else if (r.total !== sum + r.modifier) { invariantOk = false; detail = `${expr}: total ≠ Σkept + mod`; }
    else if (r.dice.some((v) => v < 1 || v > r.faces)) { invariantOk = false; detail = `${expr}: 面值越界 ${JSON.stringify(r.dice)}`; }
  }
  ok('200 组随机表达式都满足三条不变式（颗数 / 留下+丢掉 = 总数 / total = Σkept+mod，且面值在 [1, faces]）',
    invariantOk, detail);
}

// ── 5. 坏的随机源不该毁掉掷骰 ──────────────────────────────────────────────
{
  // rng 是**注入**的，所以它可能返回任何东西。越界的面值会让 total 变成谁也算不出的怪数，
  // 比抛错难查得多 —— 所以实现把值夹回 [0,1)。这条钉的就是那个夹取。
  const bad = [1, -1, 5, NaN, Infinity, undefined];
  const r = rollDice(`${bad.length}d6`, () => bad.shift() ?? 0);
  ok('rng 返回越界值 / NaN / Infinity 时，面值仍落在 [1, faces]（夹回合法区间，而不是抛错）',
    r.dice.every((v) => Number.isInteger(v) && v >= 1 && v <= 6), JSON.stringify(r.dice));
}

// ── 6. 检定：机械部分（与规则书无关）──────────────────────────────────────
{
  const r = resolveCheck('3d6', 10, { rng: rollOf(6, 4, 5, 6) });
  ok('resolveCheck 回填目标值与差值（margin = total - target）',
    r.target === 10 && r.roll.total === 15 && r.margin === 5, JSON.stringify(r));

  const exact = resolveCheck('3d6', 15, { rng: rollOf(6, 4, 5, 6) });
  ok('恰好等于目标值算成功（>= 而不是 >）', exact.success === true && exact.margin === 0);

  const short = resolveCheck('3d6', 16, { rng: rollOf(6, 4, 5, 6) });
  ok('差 1 就是不成功，且 margin 说得出差多少', short.success === false && short.margin === -1);

  try {
    resolveCheck('3d6', '难');
    ok('目标值不是数时报错', false, '居然没抛错');
  } catch (error) {
    ok('目标值不是数时报错，且文案给出正确写法',
      error instanceof DiceError && error.code === 'TARGET' && /3d6 对 12/.test(error.message),
      String(error.message));
  }
}

// ── 7. 默认判定：大成功/大失败只在单颗骰时 ──────────────────────────────────
{
  const crit = resolveCheck('1d20', 30, { rng: rollOf(20, 20) });
  ok('单颗骰掷出最大面 = critical，且**压过**目标值（难度再高也算大成功）',
    crit.grade === 'critical' && crit.success === true, JSON.stringify(crit));

  const fumble = resolveCheck('1d20', 0, { rng: rollOf(20, 1) });
  ok('单颗骰掷出 1 = fumble，且**压过** target=0（大失败就是失败）',
    fumble.grade === 'fumble' && fumble.success === false, JSON.stringify(fumble));

  const multi = resolveCheck('3d6', 3, { rng: rollOf(6, 6, 6, 6) });
  ok('多颗骰即使全是最大值也不判 critical —— 多骰下"全最大"没有公认语义，不替规则书发明',
    multi.grade === 'success' && multi.success === true, JSON.stringify(multi));

  const plain = resolveCheck('12', 10);
  ok('纯数字表达式（没有骰子）走普通成功/失败，不会误判成大成功',
    plain.grade === 'success' && plain.success === true, JSON.stringify(plain));
}

// ── 8. 判定函数是可换的（换规则书只换它）───────────────────────────────────
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
}

// ── 9. 颗数真的按表达式来（rng 调用次数是唯一的证据）────────────────────────
{
  const box = counting(rollOf(6, 1, 2, 3, 4, 5, 6));
  const r = rollDice('6d6', box.rng);
  ok('6d6 恰好调用随机源 6 次（不是"多掷几颗再挑"，那会让结果分布悄悄变样）',
    box.calls === 6 && r.dice.length === 6, `calls=${box.calls}`);
}

process.exit(done() ? 0 : 1);
