// 跑团（TRPG）· **剧本抽取管线**（P7-a）：L1 切片、L2 逐片抽取、L3 归并、L4 校验，外加伴生文件。
//
// ── 为什么单独一个套件 ──
//
// `t-trpg.mjs` 里那一批验的是"命令与工具的接线"（一次调用、一个产物），而这条管线是
// **多轮模型调用 + 一份结构化产物 + 四个伴生文件**，形状完全不同：它要一个**脚本式**的假
// 模型端点（第 N 次调用答什么），还要能**控制时钟**（预算降级那条路只有把钟拨快才走得到）。
// 塞进 `t-trpg.mjs` 会让那个套件的假端点脚本变成一锅粥。
//
// ── 这里能证明什么、证明不了什么 ──
//
// 能证明：切片是确定性的、每一片的 payload 逐字对得上、归并的每条判据、L4 四条校验、
// 伴生文件的读写与"手改伴生也生效"、以及**四条降级路各自的产物**。
// **证明不了**：真模型在一份真实 PDF 上抽得对不对 —— 那只能人工冒烟（真机 + 真模型）。
// 所以下面每条断言的判据都必须是**代码算得出来的东西**，不许出现"看起来抽得还行"。
//
// ── 两条纪律 ──
//
// ① 管线内部的纯函数层**直接取文件**（`scenario/extract/*.js`），不走桶文件 —— 桶
//    （`extra/trpg/index.ts`）**不转发**它们，而它们存在的意义正是"能脱离平台独立被测"
//    （同 `rules/`）。这也意味着**改了导出名这里会当场炸**，不会静默退化。
// ② 每个"本该不调用模型"的用例都要**重装一份全新的脚本数组** —— 假端点的脚本是**消耗式**的
//    （`shift()`），复用同一个引用等于没装（`t-trpg.mjs` 记过这个坑：第一版就是这么假绿的）。
import fs from 'node:fs';
import path from 'node:path';
import { checker, dataDir } from './lib/harness.mjs';
import { load } from './lib/src.mjs';

const DIR = dataDir('qqagent-trpg-extract-');
const { ok, done } = checker();

const { outlineDocument } = await load('extra/trpg/scenario/extract/outline.js');
const { coerceStruct, parseStruct, emptyStruct } = await load('extra/trpg/scenario/extract/schema.js');
const { mergeStructs, extractScenario } = await load('extra/trpg/scenario/extract/pipeline.js');
// ⚠️ **机制的类型清单与判据只有一处**（`rules/rule-set.ts`）：抽取层（`schema.ts` / `prompts.ts`）
// 一份都不存，`pipeline.ts` 把它当参数递进提示词。所以这里也从权威那一处取 —— 这条 import
// 本身就是"没有第二份定义"的证据（`schema.ts` 里那个 `STRUCT_MECHANIC_TYPES` 已随 P7-c 删掉）。
const { MECHANIC_TYPES, TRIGGER_OPS, EFFECT_HANDLERS, isMechanicType } =
  await load('extra/trpg/rules/rule-set.js');
const { MAX_CHUNKS, MAX_CHUNK_CHARS, MAX_STRUCT_ITEMS } = await load('extra/trpg/model/limits.js');
const { ScenarioStore } = await load('extra/trpg/index.js');

/**
 * 脚本式的假 `ask` 端口。
 *
 * 每一项要么是一条结果，要么是一个**收下 request 再返回结果**的函数 —— 后者是给"按第几片
 * 答不同的东西"以及"顺手把钟拨快"用的。脚本用完就如实失败（不是静默给空内容：那会让
 * "调用次数不对"这件事被一次空响应掩盖过去）。
 */
function fakeAsk(script) {
  const seen = [];
  const port = async (request, _signal) => {
    seen.push(request);
    const next = script.shift();
    if (!next) return { ok: false, message: '（脚本用完了）' };
    return typeof next === 'function' ? next(request) : next;
  };
  return { port, seen };
}

/** 一次 `chunk` 调用的正常答复：一份部分结构（默认空）。 */
const structJson = (over = {}) => ({
  ok: true,
  content: JSON.stringify({
    summary: '', scenes: [], npcs: [], clues: [], items: [], mechanics: [], ...over
  })
});

/** 规定格式的正文（`isFormattedScenario` 为真）。与 `t-trpg.mjs` 用的是同一个形状。 */
const FORM = '---\ntitle: 灯塔\nscene: 码头\n---\n正文';

/** 同上，但内容是"抽出来的那份部分结构"。
 *  ⚠️ `ok: true` 不能省 —— 端口的约定是**可辨识联合**，少这个键会被 `askWithTimeout` 当成
 *  "这一发失败了"（它读的是 `outcome.ok`），于是整条管线以"一片都没抽出来"收场，
 *  而断言看到的是一条与真实原因毫无关系的报错。 */
const chunkOf = (body) => ({ ok: true, content: JSON.stringify(body), usage: '' });

// ══ 一、L1：切片（纯函数，零模型调用）══════════════════════════════════════
//
// 这一段的每一条都**手算得出期望值**：切片只认结构（标题行、空行、长度），所以字数、
// 片数、标题都是确定的。手算不出来就说明这段代码不可测，那才是问题。

{
  const empty = outlineDocument('');
  const blank = outlineDocument('   \n\n  \n');
  ok('空文本切出 0 片（不是"兜底一片"）—— 兜底那条要求 `source.trim()` 非空',
    empty.chunks.length === 0 && empty.totalChars === 0 && empty.droppedChars === 0,
    JSON.stringify(empty));
  ok('**只有空白**的文本同样切出 0 片（否则上层会把一份空文件报成"有内容"）',
    blank.chunks.length === 0, JSON.stringify(blank));
  ok('`unknown` 入参不抛（`null` / `undefined` 都当空文本）—— 它上面那条路拿的是 Python 抽出来的东西',
    outlineDocument(null).chunks.length === 0 && outlineDocument(undefined).chunks.length === 0);

  // 两个 `#` 标题、各带 600 字正文。片长 = 标题行(8) + 空行(2) + 正文(600) = 610。
  const two = `# 第一章 灯塔\n\n${'甲'.repeat(600)}\n\n# 第二章 码头\n\n${'乙'.repeat(600)}`;
  const split = outlineDocument(two);
  ok('两个标题 → 2 片，下标重新编号成 0/1',
    split.chunks.length === 2 && split.chunks[0].index === 0 && split.chunks[1].index === 1,
    JSON.stringify(split.chunks.map((c) => c.index)));
  ok('每片的 `heading` 是它**起始小节的标题**（去掉 `#`）',
    split.chunks[0].heading === '第一章 灯塔' && split.chunks[1].heading === '第二章 码头',
    JSON.stringify(split.chunks.map((c) => c.heading)));
  ok('`chars` 是**含标题行**的字数（手算：8 + 2 + 600 = 610）—— 它决定 droppedChars 的账',
    split.chunks[0].chars === 610 && split.chunks[1].chars === 610,
    JSON.stringify(split.chunks.map((c) => c.chars)));
  ok('正文整段进片（标题只决定切在哪，内容一个字都不因为标题被丢）',
    split.chunks[0].text === `# 第一章 灯塔\n\n${'甲'.repeat(600)}`
    && split.chunks[1].text === `# 第二章 码头\n\n${'乙'.repeat(600)}`);

  // 第一个标题**之前**的内容自成一片，heading 是空串。
  const preface = outlineDocument(`${'前'.repeat(600)}\n\n# 标题\n\n${'后'.repeat(600)}`);
  ok('第一个标题之前的内容自成一片，且 `heading` 是空串（裸设定文档常先写一段总述）',
    preface.chunks.length === 2 && preface.chunks[0].heading === ''
    && preface.chunks[0].chars === 600 && preface.chunks[1].heading === '标题',
    JSON.stringify(preface.chunks.map((c) => [c.heading, c.chars])));

  // 没有空行的超长单段 → 按上限硬切。
  const hard = outlineDocument('字'.repeat(13000));
  ok('一整个没有空行的长段按 `MAX_CHUNK_CHARS` 硬切（13000 → 6000 / 6000 / 1000）',
    hard.chunks.length === 3
    && hard.chunks.map((c) => c.chars).join(',') === `${MAX_CHUNK_CHARS},${MAX_CHUNK_CHARS},1000`,
    JSON.stringify(hard.chunks.map((c) => c.chars)));
  ok('没撞上限时 `droppedChars` 是 0（"没丢"这件事必须能被打出来，否则上面那条断言证明不了任何事）',
    hard.droppedChars === 0 && hard.totalChars === 13000, String(hard.droppedChars));

  // 片数上限：48000 字 = 8 片，只留 6 片。
  const over = outlineDocument('字'.repeat(48000));
  ok(`片数撞上 MAX_CHUNKS(${MAX_CHUNKS}) 时**多出来的不静默丢**：字数记进 droppedChars`,
    over.chunks.length === MAX_CHUNKS && over.droppedChars === 12000 && over.totalChars === 48000,
    JSON.stringify({ n: over.chunks.length, dropped: over.droppedChars, total: over.totalChars }));

  // CRLF 归一。
  const crlf = outlineDocument('a\r\n\r\nb');
  ok('`\\r\\n` 先归一成 `\\n` 再切（`totalChars` 按归一后的算：4 而不是 6）',
    crlf.totalChars === 4 && crlf.chunks.length === 1 && crlf.chunks[0].text === 'a\n\nb',
    JSON.stringify(crlf));

  // 短小节会被并起来（下限 MIN_CHUNK_CHARS = 400）。
  // 手算：`# An0`–`# An9` 各 5 字（10 × 5 = 50），`# An10`–`# An19` 各 6 字（10 × 6 = 60），合计 110。
  const tiny = outlineDocument(Array.from({ length: 20 }, (_, i) => `# An${i}`).join('\n\n'));
  ok('一堆小到不能再小的小节会被并成**一片**（下限存在的意义就是别让每行一个标题变成 20 次调用）',
    tiny.chunks.length === 1 && tiny.chunks[0].chars === 110, JSON.stringify(tiny.chunks.map((c) => c.chars)));

  // 每片都不超上限。
  const fat = outlineDocument(Array.from({ length: 5 }, (_, i) => `# H${i}\n\n${'字'.repeat(5000)}`).join('\n\n'));
  ok('每一片都 ≤ `MAX_CHUNK_CHARS`（超了的话单片提示词会顶爆模型的上下文）',
    fat.chunks.length === 5 && fat.chunks.every((c) => c.chars <= MAX_CHUNK_CHARS),
    JSON.stringify(fat.chunks.map((c) => c.chars)));
}

// ══ 二、L2 逐片抽取 + L3 归并 ══════════════════════════════════════════════
//
// 3 片 × 505 字的文档：每片都是"标题 + 500 字正文"，片长 505 越过下限 400，所以按标题自然断开。

{
  const THREE = ['一', '二', '三']
    .map((head) => `# ${head}\n\n${'甲'.repeat(500)}`).join('\n\n');
  const outline = outlineDocument(THREE);
  ok('（前置）3 片文档切出 3 片 —— 下面每一条都建立在这个形状上',
    outline.chunks.length === 3, JSON.stringify(outline.chunks.map((c) => c.chars)));

  const script = [
    chunkOf({ summary: '第一片', scenes: [{ name: '灯塔', summary: '', npcs: ['守夜人'], clues: [] }] }),
    chunkOf({ summary: '第二片', scenes: [{ name: '灯塔', summary: '门厅', npcs: ['水手'], clues: [] }] }),
    chunkOf({ summary: '第三片', npcs: [{ name: '守夜人', summary: '话少', attitude: '敌意', location: '灯塔' }] }),
    { ok: true, content: '```markdown\n' + FORM + '\n```' }
  ];
  const { port, seen } = fakeAsk(script);
  const outcome = await extractScenario(THREE, { name: '测试模组', source: 'text' }, { ask: port });

  ok('3 片各发一次 + 合成一次 → `calls === 4`（这个数是回执上"花了几次调用"的唯一来源）',
    outcome.ok === true && outcome.result.calls === 4, JSON.stringify(outcome));
  ok('每片的 payload 带**从 1 开始的**序号与总片数（模型要靠它知道自己在抽第几片）',
    seen[0].job === 'chunk' && seen[0].payload.index === 1 && seen[0].payload.total === 3
    && seen[1].payload.index === 2 && seen[2].payload.index === 3,
    JSON.stringify(seen.map((r) => [r.job, r.payload?.index])));
  ok('每片的 payload 带那一片自己的正文与标题（拿错片 = 抽出来的东西张冠李戴，而不会有任何报错）',
    seen[0].payload.heading === '一' && seen[1].payload.heading === '二' && seen[2].payload.heading === '三'
    && seen[0].payload.text === `# 一\n\n${'甲'.repeat(500)}`,
    JSON.stringify(seen.map((r) => r.payload?.heading)));
  ok('**片与片互不知情**：第二片的 payload 里没有第一片的正文（带上就是把同一段抽两遍、白花钱）',
    !String(seen[1].payload.text).includes('# 一\n\n'));
  ok('payload 里的上限与类型清单**取自同一处常量**（写死在提示词里的话，改了上限两边就漂了）',
    seen[0].payload.maxItems === MAX_STRUCT_ITEMS
    && seen[0].payload.mechanicTypes.join(',') === MECHANIC_TYPES.join(','),
    JSON.stringify(seen[0].payload.mechanicTypes));
  // P7-c：机制要写成**受控语法**，所以另外两张清单（trigger 的 op、effect 的 handler）也得递进去。
  // 判据与上一条同源 —— 提示词念的与 `compileRuleSet` 认的必须是同一份：抄一遍的话，加了新
  // handler 而提示词没跟上，表现是"模型写了一个其实支持、却没人告诉它可以写的值"（抽取静默变少）。
  ok('trigger 的 op 与 effect 的 handler 两张清单**也取自同一处**（它们是受控语法的全部词表）',
    seen[0].payload.triggerOps.join(',') === TRIGGER_OPS.join(',')
    && seen[0].payload.effectHandlers.join(',') === EFFECT_HANDLERS.join(','),
    JSON.stringify([seen[0].payload.triggerOps, seen[0].payload.effectHandlers]));

  const merge = seen[3];
  ok('L3 那一发是 `merge`，吃的是**归并好的结构**而不是原文（原文塞不进去，那正是切片存在的理由）',
    merge.job === 'merge' && typeof merge.payload.extracted === 'string'
    && !merge.payload.extracted.includes('甲'.repeat(500)),
    String(merge.payload?.extracted).slice(0, 120));
  ok('L3 的 payload 里带原文总字数（它据此判断"压缩到多少合适"）',
    merge.payload.chars === outline.totalChars, JSON.stringify(merge.payload?.chars));
  ok('给模型看的那份结构里**没有 `warnings`**（那是我们的账，不是给模型看的资料）',
    !Object.prototype.hasOwnProperty.call(JSON.parse(merge.payload.extracted), 'warnings'),
    Object.keys(JSON.parse(merge.payload.extracted)).join(','));
  ok('归并后的结构里两片的场景真的并成了一条，`npcs` 取并集（同名合并、后面的补空缺）',
    outcome.ok === true && outcome.result.struct.scenes.length === 1
    && outcome.result.struct.scenes[0].summary === '门厅'
    && outcome.result.struct.scenes[0].npcs.join(',') === '守夜人,水手',
    JSON.stringify(outcome.ok ? outcome.result.struct.scenes : null));
  ok('归并后的结构里 NPC 也是同名合并（后出现的补上空字段，不覆盖已有的）',
    outcome.ok === true && outcome.result.struct.npcs.length === 1
    && outcome.result.struct.npcs[0].summary === '话少'
    && outcome.result.struct.npcs[0].attitude === '敌意'
    && outcome.result.struct.npcs[0].location === '灯塔',
    JSON.stringify(outcome.ok ? outcome.result.struct.npcs : null));
  ok('`summary` 是各片用 ` / ` 串起来的（顺序按片序，两次抽取并出同一个结果）',
    outcome.ok === true && outcome.result.struct.summary === '第一片 / 第二片 / 第三片',
    outcome.ok ? outcome.result.struct.summary : '');
  ok('落库的正文是 L3 合成的、**且已经剥掉围栏**（提示词说了别套，而它经常套）',
    outcome.ok === true && outcome.result.body === FORM, outcome.ok ? outcome.result.body : '');
  ok('`chunks` 原样带出来（它要落成 `raw/`，是"正文压缩过、结构可能抽漏"的保底）',
    outcome.ok === true && outcome.result.chunks.length === 3
    && outcome.result.chunks[0].text === `# 一\n\n${'甲'.repeat(500)}`);
}

// ── L3 的归并：纯函数，单独钉（它不必跑一遍管线就能测）──

{
  const scene = (name, over = {}) => ({ name, summary: '', npcs: [], clues: [], ...over });
  const npc = (over) => ({ name: '', summary: '', attitude: '', location: '', discovered: true, ...over });
  const mechanic = (over) => ({ type: 'npc_trait', triggerText: '', effectText: '', note: '', sourceQuote: '', ...over });
  const part = (over) => ({ ...emptyStruct(), ...over });

  const dedup = mergeStructs([
    part({ mechanics: [mechanic({ sourceQuote: '雾里什么都看不清' }), mechanic({ sourceQuote: '同一句' })] }),
    part({ mechanics: [mechanic({ sourceQuote: '同一句' })] })
  ]);
  ok('机制按 `sourceQuote` 去重（引文是它的身份；不去重的话同一句会被印两遍，还各占一条上限）',
    dedup.mechanics.length === 2, JSON.stringify(dedup.mechanics.map((m) => m.sourceQuote)));

  const noQuote = mergeStructs([
    part({ mechanics: [mechanic({ sourceQuote: '', type: 'npc_trait', triggerText: '在灯塔里' })] }),
    part({ mechanics: [mechanic({ sourceQuote: '', type: 'npc_trait', triggerText: '在灯塔里' })] })
  ]);
  ok('没有引文时退化成"类型 + 触发条件"当身份（否则同一句机制会因为引文为空而被判成两条）',
    noQuote.mechanics.length === 1, JSON.stringify(noQuote.mechanics.length));

  // **归并之后**才越限的那一种：单片的截断由 `coerceStruct` 记，这一种它一次都看不见。
  const many = (prefix) => Array.from({ length: MAX_STRUCT_ITEMS }, (_, i) => scene(`${prefix}${i}`));
  const capped = mergeStructs([part({ scenes: many('A') }), part({ scenes: many('B') })]);
  ok(`归并后超过 ${MAX_STRUCT_ITEMS} 条上限时**把截了几条说出来**（静默 slice 的表现是"抽出来的比原文里有的少"，而少了几条一处线索都没有）`,
    capped.scenes.length === MAX_STRUCT_ITEMS
    && capped.warnings.includes(`场景合并后超过 ${MAX_STRUCT_ITEMS} 条上限，后面的 ${MAX_STRUCT_ITEMS} 条没进来`),
    JSON.stringify(capped.warnings));
  const notCapped = mergeStructs([part({ scenes: many('A') })]);
  ok('（对照）**没越限时不许**冒出那条警告 —— 否则"总有东西被截"这句话会变成噪音，没人再看它',
    notCapped.scenes.length === MAX_STRUCT_ITEMS
    && !notCapped.warnings.some((w) => w.includes('合并后超过')),
    JSON.stringify(notCapped.warnings));
  ok('每一类各自计上限（场景满了不影响人物 —— 它们是各自独立的预算）',
    mergeStructs([
      part({ scenes: many('A'), npcs: [npc({ name: '守夜人' })] })
    ]).npcs.length === 1);
}

// ══ 三、L4：四条硬判据 ════════════════════════════════════════════════════

{
  // 单片文档，于是"发了几次调用"恒为 2（1 片 + 1 合成），下面每条只需盯产物。
  const ONE = `# 一\n\n${'甲'.repeat(500)}`;
  const run = async (struct, body = FORM) => {
    const { port } = fakeAsk([chunkOf(struct), { ok: true, content: body }]);
    return extractScenario(ONE, { name: '模组', source: 'text' }, { ask: port });
  };

  /**
   * 一条**写得完整**的机制：trigger 与 effect 都是受控语法里的合法取值。
   *
   * ⚠️ 下面每条都得给全 —— P7-c 起 L4 会拿 `compileRuleSet` 试编译一次，**写不出可判定的
   * trigger/effect 的机制会被降级成纯叙事并记一笔**。只给 `triggerText`/`effectText`（散文）
   * 而指望"不标待核项"的那几条断言，在降级落地之后**必然变红** —— 而那正是降级该有的行为。
   */
  const solid = (over = {}) => ({
    type: 'npc_trait', note: '守夜人',
    trigger: { op: 'actor', value: '守夜人' },
    effect: { handler: 'narrate', params: {} },
    triggerText: '遇到守夜人', effectText: '他会开口',
    sourceQuote: '甲甲甲甲', ...over
  });

  const good = await run({ mechanics: [solid()] });
  ok('引文在原文里**逐字**找得到 → 不算待核项（引文是唯一能被人核对的东西，核对得上就不该吵）',
    good.ok === true && good.result.struct.warnings.length === 0,
    JSON.stringify(good.ok ? good.result.struct.warnings : good));

  const known = await run({ mechanics: [{
    type: 'conditional_immunity', note: '免伤',
    trigger: { op: 'actor', value: '守夜人' },
    effect: { handler: 'immune_to_damage', params: {} },
    triggerText: '守夜人不吃普通伤害', effectText: '免伤', sourceQuote: '甲甲'
  }] });
  ok('写得出可判定 trigger/effect 的机制**原样保住它的 type**（降级判据是"编译不过"，不是"类型眼生"）',
    known.ok === true && known.result.struct.warnings.length === 0
    && known.result.ruleExt?.mechanics[0].type === 'conditional_immunity',
    JSON.stringify(known.ok ? [known.result.struct.warnings, known.result.ruleExt] : known));

  const unknownType = await run({ mechanics: [{
    type: 'reduce_damage', triggerText: '', effectText: '', note: '', sourceQuote: '甲甲'
  }] });
  ok('认不出的 `type` → 标进待核项**并指名道姓**（降级由 `compileRuleSet` 做，这里不替它决定）',
    unknownType.ok === true
    && unknownType.result.struct.warnings.some((w) => w === '第 1 条机制的 type「reduce_damage」我不认识，已按纯叙事处理（不影响判定）'),
    JSON.stringify(unknownType.ok ? unknownType.result.struct.warnings : unknownType));

  // ⚠️ P7-c 新加的那一档降级：`type` 认得，但 trigger/effect 写不出可判定的东西（只给了散文）。
  // 判据是**编译不过**，所以它与"类型眼生"是两条路、各有各的账。
  const prose = await run({ mechanics: [{
    type: 'check_modifier', triggerText: '在灯塔里', effectText: '侦察 -20', note: '浓雾', sourceQuote: '甲甲甲甲'
  }] });
  ok('type 认得、却写不出可判定的 trigger/effect → **降级成纯叙事**并记一笔（信息仍留在 note 与散文里，不丢）',
    prose.ok === true && prose.result.ruleExt?.mechanics[0].type === 'narrative_hook'
    && prose.result.struct.warnings.length === 1
    && prose.result.struct.warnings[0].includes('第 1 条机制（check_modifier）没能写成可判定的规则'),
    JSON.stringify(prose.ok ? [prose.result.struct.warnings, prose.result.ruleExt] : prose));
  ok('降级那句话里的**原因不重复印前缀**（`whyNot` 要剥掉 `第 N 条机制（type）` 那一截 —— 外面那句本来就已经写过了）',
    /没能写成可判定的规则（没写 trigger/.test(prose.result.struct.warnings[0] ?? ''),
    prose.ok ? prose.result.struct.warnings[0] : '');
  ok('降级**只动 `rule.json` 的草稿**：`struct.json` 里那条机制的类型原样留着（`struct` 是抽取记录，不是编译产物）',
    prose.ok === true && prose.result.struct.mechanics[0].type === 'check_modifier',
    JSON.stringify(prose.ok ? prose.result.struct.mechanics : prose));

  const missingQuote = await run({ mechanics: [solid({ sourceQuote: '' })] });
  ok('没有引文的机制 → 待核项说"没法核对"（它虽允许为空，却一定进不了"已核对"那一档）',
    missingQuote.ok === true && missingQuote.result.struct.warnings.length === 1
    && missingQuote.result.struct.warnings[0] === '第 1 条机制（npc_trait）没给原文引文，没法核对',
    JSON.stringify(missingQuote.ok ? missingQuote.result.struct.warnings : missingQuote));

  const badQuote = await run({ mechanics: [solid({ sourceQuote: '这句原文里没有' })] });
  ok('引文对不上 → 标进待核项，**而且机制保留**（丢掉会让抽取静默变少，而"少了"和"本来就没有"在群里长得一样）',
    badQuote.ok === true && badQuote.result.struct.mechanics.length === 1
    && badQuote.result.struct.warnings.length === 1
    && badQuote.result.struct.warnings[0].includes('的引文在原文里找不到：这句原文里没有'),
    JSON.stringify(badQuote.ok ? badQuote.result.struct.warnings : badQuote));

  // PDF 抽取会在行末断句，模型照抄时不会带上那个换行 —— 只认逐字的话这一档会把大量其实对得上的
  // 引文判成待核项，于是待核项列表变成噪音，没人再看它。
  const wrapped = '雾里什么都\n看不清';
  const { port: wrapPort } = fakeAsk([
    chunkOf({ mechanics: [solid({ sourceQuote: '雾里什么都看不清' })] }),
    { ok: true, content: FORM }
  ]);
  const wrapOutcome = await extractScenario(wrapped, { name: '模组', source: 'pdf' }, { ask: wrapPort });
  ok('引文与原文只差**空白**（PDF 断行）时算对得上 —— 否则待核项会被"其实对得上"的那些淹没',
    wrapOutcome.ok === true && wrapOutcome.result.struct.warnings.length === 0,
    JSON.stringify(wrapOutcome.ok ? wrapOutcome.result.struct.warnings : wrapOutcome));

  // 每类超上限：单片的截断由 `coerceStruct` 记一笔。
  const manyScenes = Array.from({ length: MAX_STRUCT_ITEMS + 3 }, (_, i) => ({
    name: `S${i}`, summary: '', npcs: [], clues: []
  }));
  const overItems = await run({ scenes: manyScenes });
  ok(`单片超过 ${MAX_STRUCT_ITEMS} 条 → 记一笔"后面的 N 条没进来"（超上限是**我们自己的成本**，与"抽漏了"要分开说）`,
    overItems.ok === true
    && overItems.result.struct.scenes.length === MAX_STRUCT_ITEMS
    && overItems.result.struct.warnings.some((w) => w === `场景超过 ${MAX_STRUCT_ITEMS} 条上限，后面的 3 条没进来`),
    JSON.stringify(overItems.ok ? overItems.result.struct.warnings : overItems));

  // 判据是"名字与内容**都**空才丢"（`coerceScene` 的 `if (!name && !summary) return null`），
  // 所以夹具必须是一个两样都没有的对象 —— 写 `{ summary: '…' }` 是**不会被丢**的（那是合法的一条）。
  const brokenItems = await run({ scenes: [{ npcs: ['守夜人'] }, { name: '好的' }] });
  ok('缺名字或内容的条目被丢掉**并计数**（与"超上限"分开说：一个是抽取质量，一个是我们自己的上限）',
    brokenItems.ok === true && brokenItems.result.struct.scenes.length === 1
    && brokenItems.result.struct.warnings.some((w) => w === '场景里有 1 条缺名字或内容，已经丢掉'),
    JSON.stringify(brokenItems.ok ? brokenItems.result.struct.warnings : brokenItems));

  const notFormatted = await run({}, '这就是一段随便的话');
  ok('L3 合成出来的正文**过不了 `isFormattedScenario` 就如实失败**（放进去的表现是"开局了但什么都没注入"）',
    notFormatted.ok === false && /不是剧本格式/.test(notFormatted.message), JSON.stringify(notFormatted));

  const emptyBody = await run({}, '');
  ok('L3 什么都没给 → 如实失败（把空正文当成"整理好了"是最坏的一种成功）',
    emptyBody.ok === false && /没有给出剧本内容/.test(emptyBody.message), JSON.stringify(emptyBody));

  const badJson = await run({}, FORM);
  ok('（对照）正文过关的用例确实 `ok:true` —— 上面两条失败不是因为别的地方坏了',
    badJson.ok === true && badJson.result.body === FORM);
}

// ── L4 的收窄：`coerceStruct` / `parseStruct` ──

{
  ok('`coerceStruct` 收到非对象（数组 / 字符串 / null）时返回 `null` —— 整体拒绝只留给这一档',
    coerceStruct([], []) === null && coerceStruct('x', []) === null && coerceStruct(null, []) === null);
  ok('不是对象时 `parseStruct` 给的是**可读的一句**，不是"抽不出东西"这种含混话',
    parseStruct(null).ok === false && parseStruct(null).message === '这份剧本还没有抽取产物（伴生结构）'
    && parseStruct([]).ok === false && /形状不对/.test(parseStruct([]).message));
  ok('读一份已落盘的结构时**文件里存的那份 warnings 接着用**（L4 是在抽取那一刻算的，重读时原文早就不在手边）',
    (() => {
      const read = parseStruct({ scenes: [], warnings: ['第 1 条机制的引文在原文里找不到：x'] });
      return read.ok === true && read.struct.warnings.includes('第 1 条机制的引文在原文里找不到：x');
    })());
  ok('warnings 去重（同一句重复落盘时不该印两遍）',
    (() => {
      const read = parseStruct({ warnings: ['同一句', '同一句'] });
      return read.ok === true && read.struct.warnings.filter((w) => w === '同一句').length === 1;
    })());
  ok('`discovered` / `visible` 缺省是 **true**（抽取时默认不藏东西，藏是 DM 的显式动作）',
    (() => {
      const read = parseStruct({ npcs: [{ name: '守夜人' }], clues: [{ text: '日志' }] });
      return read.ok === true && read.struct.npcs[0].discovered === true && read.struct.clues[0].visible === true;
    })());
  ok('`discovered: false` 是**显式**藏（写成 `!== false` 的判据不能退化成真值判断）',
    (() => {
      const read = parseStruct({ npcs: [{ name: '守夜人', discovered: false }] });
      return read.ok === true && read.struct.npcs[0].discovered === false;
    })());
  // ⚠️ P7-c 起**清单只有一处**（`rules/rule-set.ts`）。`schema.ts` 里那个 `STRUCT_MECHANIC_TYPES`
  // 与它的 `isKnownMechanicType` 已删掉 —— 抽取层不存第二份定义，判据一律去问权威。
  ok('机制类型清单与判据同源（`isMechanicType` 认的就是那八个，多一个少一个都会漂）',
    MECHANIC_TYPES.every((type) => isMechanicType(type)) && !isMechanicType('reduce_damage'));
  ok('清单里确实有 `narrative_hook`（它是降级的目标档，缺了的话降级无处可去）',
    isMechanicType('narrative_hook') && MECHANIC_TYPES.includes('narrative_hook'));
}

// ══ 四、落盘与伴生文件 ════════════════════════════════════════════════════

{
  const scenarios = new ScenarioStore(path.join(DIR, 'scenarios'));
  const STRUCT = {
    summary: '废弃灯塔',
    scenes: [{ name: '灯塔', summary: '', npcs: [], clues: [] }],
    npcs: [], clues: [], items: [],
    mechanics: [{ type: 'npc_trait', triggerText: '', effectText: '', note: '', sourceQuote: '' }],
    warnings: ['第 1 条机制的引文在原文里找不到：x']
  };
  /**
   * 一份**能编译通过**的规则扩展草稿（P7-c）。
   *
   * ⚠️ 这里刻意用 `penalty_to_check` 而不是 `narrate`：只有真 effect 才带 `params`，而"落盘之后
   * 连参数都还在"正是这一段要钉的东西（`writeExtras` 是 `JSON.stringify`，一个字段被吞掉
   * 不会有任何报错 —— 表现是开局时那条机制静默失效）。
   */
  const RULE = {
    version: 1,
    mechanics: [{
      type: 'check_modifier', note: '浓雾里侦察更难',
      trigger: { op: 'scene', value: '灯塔' },
      effect: { handler: 'penalty_to_check', params: { value: 20 } },
      sourceQuote: '浓雾弥漫，侦察难度增加'
    }]
  };
  scenarios.write('甲', FORM);
  const written = scenarios.writeExtras('甲', {
    struct: STRUCT,
    ruleExt: RULE,
    raw: [{ heading: '第一章', text: '正文一' }, { heading: '', text: '正文二' }]
  });
  ok('`writeExtras` 写成功（它不看 `.md`、也不做格式校验 —— 调用方负责保证 `.md` 已经写好了）',
    written.ok === true, JSON.stringify(written));
  ok('`struct.json` 真的落盘了、而且 `read()` 读得回来（不是只记在内存里）',
    scenarios.read('甲').ok === true && scenarios.read('甲').scenario.struct !== undefined,
    JSON.stringify(scenarios.read('甲').ok));
  ok('`raw/` 按顺序落成 `00.md` / `01.md`，带标题的那一片首行是 `# 标题`',
    scenarios.read('甲').scenario?.rawParts === 2
    && fsRead(scenarios.rawDir('甲'), '00.md') === '# 第一章\n\n正文一'
    && fsRead(scenarios.rawDir('甲'), '01.md') === '正文二',
    String(scenarios.read('甲').scenario?.rawParts));

  // ── P7-c：`<id>.rule.json` ──
  const ruled = scenarios.read('甲').scenario?.ruleExt;
  ok('`rule.json` 落盘且 `read()` 读得回来（`ruleExt` 与 `struct` 走的是同一条伴生通道）',
    ruled !== undefined && ruled !== null && typeof ruled === 'object',
    JSON.stringify(ruled));
  ok('落盘**逐字保真**：`trigger` 的嵌套对象与 `effect.params` 的数字都原样在（被吞掉的话表现是开局时那条机制静默失效，一处报错都没有）',
    JSON.stringify(ruled) === JSON.stringify(RULE),
    JSON.stringify(ruled));
  ok('`sourceQuote` 跟着落进 `rule.json` —— 它是人**唯一**能核对"这条机制是从哪句话来的"的凭据（`.trpg check` 的待核项也认它）',
    ruled?.mechanics?.[0]?.sourceQuote === '浓雾弥漫，侦察难度增加',
    JSON.stringify(ruled?.mechanics?.[0]));

  ok('`list()` 里能看到这一份有结构、有几片（面板与 `.trpg check` 都靠这两个数）',
    (() => {
      const row = scenarios.list().find((item) => item.id === '甲');
      return row?.hasStruct === true && row?.rawParts === 2;
    })());
  ok('`list()` **只列 `.md`**：`.struct.json` / `.rule.json` / `raw/` 一个都不能冒充成剧本（`.json` 后缀不匹配、`raw/` 是子目录）',
    scenarios.list().length === 1 && scenarios.list()[0].id === '甲'
    && !scenarios.list().some((item) => item.id.includes('json')),
    JSON.stringify(scenarios.list().map((item) => item.id)));

  // 缓存签名：手改伴生**不动 `.md`**，而 `.trpg check` 的回执正是教人这么干的。
  const before = scenarios.read('甲').scenario?.struct;
  scenarios.writeExtras('甲', { struct: { ...STRUCT, summary: '手改过的' } });
  const after = scenarios.read('甲').scenario?.struct;
  ok('**手改伴生也生效**（缓存签名含 struct 的 mtime，不只看 `.md`）—— 只看 `.md` 的话第二次读到的还是旧的那份，表现是"改了没反应"',
    JSON.stringify(before) !== JSON.stringify(after) && after?.summary === '手改过的',
    JSON.stringify(after));
  ok('⚠️ 只给 `struct` 的那次 `writeExtras` **没把 `rule.json` 一起抹掉**（"缺的字段不写"是 `writeExtras` 的既有语义；写成"没给就删"会让一次局部刷新静默清空规则）',
    scenarios.read('甲').scenario?.ruleExt !== undefined,
    JSON.stringify(scenarios.read('甲').scenario?.ruleExt));

  // 缓存签名里**规则文件也占一位**（`#signature` 的四段）。手改 `rule.json` 与手改 `struct.json`
  // 是同一个工作流（`.trpg check` 的回执教人改的是前者），漏掉它表现同样是"改了没反应"。
  const edited = { ...RULE, mechanics: [{ ...RULE.mechanics[0], note: '手改过的机制' }] };
  scenarios.writeExtras('甲', { ruleExt: edited });
  ok('**手改 `rule.json` 也生效**（缓存签名的四段里有一份是它的 mtime —— 漏掉的话"改完再敲一次这条命令"那个工作流整个失效）',
    scenarios.read('甲').scenario?.ruleExt?.mechanics?.[0]?.note === '手改过的机制',
    JSON.stringify(scenarios.read('甲').scenario?.ruleExt));


  // 伴生坏了**不掀翻剧本**：一份好好的 `.md` 不该因为旁路文件被手改坏就开不了局。
  scenarios.write('乙', FORM);
  writeFile(scenarios.structFile('乙'), '{ 这不是 JSON');
  const broken = scenarios.read('乙');
  ok('伴生文件解不开时**剧本照样可用**（`.md` 是唯一权威），问题走 `extrasProblems` 而不是 `problems`',
    broken.ok === true && broken.scenario.struct === undefined
    && (broken.scenario.extrasProblems ?? []).some((p) => /剧情结构文件/.test(p) && /解不开/.test(p)),
    JSON.stringify(broken.ok ? broken.scenario.extrasProblems : broken));

  // `rule.json` 走的是**同一条**伴生通道，所以坏文件的待遇也必须一样。两处各写一遍的话，
  // 后加的那一份（规则）很容易只在"好文件"那一侧接上 —— 表现是手改坏 `rule.json` 之后
  // 剧本整个读不出来，而 `.md` 明明是好的。
  scenarios.write('丁', FORM);
  writeFile(scenarios.ruleFile('丁'), '[这不是对象');
  const brokenRule = scenarios.read('丁');
  ok('`rule.json` 坏掉时**同样不掀翻剧本**，而且问题里点名的是「规则扩展」那一份（不点名的话管理员不知道该去改哪个文件）',
    brokenRule.ok === true && brokenRule.scenario.ruleExt === undefined
    && (brokenRule.scenario.extrasProblems ?? []).some((p) => /规则扩展文件/.test(p) && /解不开/.test(p)),
    JSON.stringify(brokenRule.ok ? brokenRule.scenario.extrasProblems : brokenRule));

  // 重写 `.md` 会清掉伴生 —— 它们描述的是**上一份**正文。
  scenarios.writeExtras('丙', { struct: STRUCT, ruleExt: RULE, raw: [{ heading: '', text: 'x' }] });
  scenarios.write('丙', FORM);
  ok('重写 `.md` 时**清掉伴生**（留着的话 DM 手里是一份与手上模组对不上的结构，而群里没人看得出来）',
    scenarios.read('丙').scenario?.struct === undefined && scenarios.read('丙').scenario?.rawParts === 0
    && scenarios.read('丙').scenario?.ruleExt === undefined);

  // remove 连伴生一起删。
  scenarios.remove('甲');
  ok('`remove()` 连伴生一起删（只删 `.md` 的话结构文件会变成没人认得出来的孤儿）',
    scenarios.read('甲').ok === false
    && !exists(scenarios.structFile('甲')) && !exists(scenarios.rawDir('甲')));
  ok('`remove()` **连 `rule.json` 一起删**（它是三个伴生里最后加的一个 —— 漏掉它不会有任何报错，只会在剧本库里留下一份没人认领的规则）',
    !exists(scenarios.ruleFile('甲')),
    JSON.stringify(scenarios.list().map((item) => item.id)));
}

// ══ 五、失败与降级（**四条路各自交什么**）══════════════════════════════════
//
// 这一段是本轮最要紧的：管线的价值一半在"抽得好"，另一半在"抽不成时说得清、而且交得出手
// 上有的东西"。降级路是**只有断言拦得住**的那一类 —— 它不影响启动、不影响聊天，表现只是
// 群里少一句话或者多等两分钟。

{
  const ONE = `# 一\n\n${'甲'.repeat(500)}`;
  const THREE = ['一', '二', '三'].map((head) => `# ${head}\n\n${'甲'.repeat(500)}`).join('\n\n');

  const noText = await (async () => {
    const { port, seen } = fakeAsk([]);
    const outcome = await extractScenario('   \n\n ', { name: 'x', source: 'text' }, { ask: port });
    return { outcome, seen };
  })();
  ok('没有可抽取的正文时**一次调用都不发**就失败（先切再看，切片为空就不该去打扰模型）',
    noText.outcome.ok === false && /没有可抽取的正文/.test(noText.outcome.message) && noText.seen.length === 0,
    JSON.stringify(noText.outcome));

  const allBad = await (async () => {
    const { port } = fakeAsk([{ ok: true, content: '我做不到' }]);
    return extractScenario(ONE, { name: 'x', source: 'text' }, { ask: port });
  })();
  ok('一片都没成 → 如实失败，且把**第一片那句原因**带出来（不返回一份"抽了一半但看着像成功了"的东西）',
    allBad.ok === false && allBad.message === '抽取没成：模型给的不是一个 JSON 对象',
    JSON.stringify(allBad));

  // 3 片 → **4 次调用**（3 片各一次 + 合成一次）。脚本必须给满这四发：少一发的话合成那一发会
  // 撞上"脚本用完了"，于是整条管线以 `ok:false` 收场 —— 而断言想钉的是"第一片炸了、别的照跑"。
  const halfBad = await (async () => {
    const { port } = fakeAsk([
      { ok: false, message: '端点炸了' },
      chunkOf({ npcs: [{ name: '守夜人' }] }),
      chunkOf({}),
      { ok: true, content: FORM }
    ]);
    return extractScenario(THREE, { name: 'x', source: 'text' }, { ask: port });
  })();
  ok('某一片抽不出来**不中断整条管线**（别的片与原文切片都还在），但要记一笔"第 N 片没抽出来"',
    halfBad.ok === true && halfBad.result.calls === 4
    && halfBad.result.struct.warnings.includes('第 1 片没抽出来：端点炸了'),
    JSON.stringify(halfBad.ok ? halfBad.result.struct.warnings : halfBad));

  // 同上：端口抛异常那一片之外还得有片能成，否则 `parts` 为空 → 管线走"一片都没成"那条失败路，
  // 而这条断言要钉的是**兜住异常**（`askWithTimeout` 的 catch），不是那条失败路。
  const thrown = await (async () => {
    const { port } = fakeAsk([
      () => { throw new Error('端口自己炸了'); },
      chunkOf({}), chunkOf({}),
      { ok: true, content: FORM }
    ]);
    return extractScenario(THREE, { name: 'x', source: 'text' }, { ask: port });
  })();
  ok('端口**抛异常**被兜住（端口自己的约定是吞，但假的实现可能不吞 —— 一个抛异常的端口不该让整条命令变成未捕获异常）',
    thrown.ok === true && thrown.result.struct.warnings.includes('第 1 片没抽出来：端口自己炸了'),
    JSON.stringify(thrown.ok ? thrown.result.struct.warnings : thrown));

  const mergeBad = await (async () => {
    const { port } = fakeAsk([chunkOf({}), { ok: false, message: '模型挂了' }]);
    return extractScenario(ONE, { name: 'x', source: 'text' }, { ask: port });
  })();
  ok('L3 那一发失败 → 如实失败并点明是**合成**这一步（调用方据此退回后备那条路）',
    mergeBad.ok === false && mergeBad.message === '合成剧本文件时出错：模型挂了', JSON.stringify(mergeBad));

  const dropped = await (async () => {
    const { port, seen } = fakeAsk([
      ...Array.from({ length: MAX_CHUNKS }, () => chunkOf({})), { ok: true, content: FORM }
    ]);
    const outcome = await extractScenario('字'.repeat(48000), { name: 'x', source: 'text' }, { ask: port });
    return { outcome, seen };
  })();
  ok('撞上片数上限时**把"还有多少字没进抽取"说出来**（原文在 `raw/` 里没丢，但那份切片只到上限）',
    dropped.outcome.ok === true
    && dropped.outcome.result.droppedChars === 12000
    && dropped.outcome.result.struct.warnings.some((w) => w === `原文太长，只抽了前 ${MAX_CHUNKS} 片（还有 12000 字没进抽取）`),
    JSON.stringify(dropped.outcome.ok ? dropped.outcome.result.struct.warnings : dropped.outcome));
  ok('（对照）撞上限时只发了 `MAX_CHUNKS` 次片调用 —— 多发的那些是白花钱',
    dropped.seen.filter((r) => r.job === 'chunk').length === MAX_CHUNKS,
    String(dropped.seen.length));

  // ── 预算降级：钟拨快之后，**片被跳过但合成照做** ──
  //
  // 这两条钉的是本轮改掉的那道闸门：原先 L3 与 L2 共用 `EXTRACT_MIN_CALL_MS` 阈值，于是
  // "有片被跳过"与"能合成"永远不可能同时成立（两处读同一个只会往前走的钟），上面那条
  // 「最后 N 片没抽」的警告**一次也到不了回执** —— 那不是降级路径，是死代码。
  const skipped = await (async () => {
    let clock = 0;
    const { port, seen } = fakeAsk([
      () => { clock = 86_000; return chunkOf({}); },
      { ok: true, content: FORM }
    ]);
    const outcome = await extractScenario(THREE, { name: 'x', source: 'text' },
      { ask: port, now: () => clock });
    return { outcome, seen };
  })();
  ok('时间不够再抽下一片时**跳过它、但把合成做完**：交出去的是"抽到多少就多少"（跳过 2 片）',
    skipped.outcome.ok === true && skipped.outcome.result.calls === 2
    && skipped.seen.filter((r) => r.job === 'chunk').length === 1
    && skipped.seen[1].job === 'merge',
    JSON.stringify(skipped.seen.map((r) => r.job)));
  ok('被跳过的那几片要**如实说出来**（不说的话管理员以为 3 片全抽了，而结构里少了两片的内容）',
    skipped.outcome.ok === true
    && skipped.outcome.result.struct.warnings.includes('时间预算用完，最后 2 片没抽（原文已另存）'),
    JSON.stringify(skipped.outcome.ok ? skipped.outcome.result.struct.warnings : skipped.outcome));

  const outOfTime = await (async () => {
    let clock = 0;
    const { port, seen } = fakeAsk([
      () => { clock = 90_001; return chunkOf({}); },
      { ok: true, content: FORM }
    ]);
    const outcome = await extractScenario(THREE, { name: 'x', source: 'text' },
      { ask: port, now: () => clock });
    return { outcome, seen };
  })();
  ok('预算**彻底**用完（连合成的余量都没有）→ 如实失败，并说清是"没来得及合成"（不是"模型不行"）',
    outOfTime.outcome.ok === false
    && outOfTime.outcome.message === '抽取没成：时间预算用完了，没来得及合成剧本文件'
    && outOfTime.seen.filter((r) => r.job === 'merge').length === 0,
    JSON.stringify(outOfTime.outcome));
}

console.log('\n—— 说明：真模型在真实模组上的抽取质量只能人工冒烟，套件证明不了它用得对。');
process.exit(done() ? 0 : 1);

// ── 小助手（只给"落盘"那一段用；`node:fs` 在这里是**允许**的 —— 被闸门管的是
//    `scenario/extract/` 那一层，测试不是源码）──
function fsRead(dir, name) {
  return fs.readFileSync(path.join(dir, name), 'utf8');
}
function writeFile(file, text) {
  fs.writeFileSync(file, text, 'utf8');
}
function exists(target) {
  return fs.existsSync(target);
}
