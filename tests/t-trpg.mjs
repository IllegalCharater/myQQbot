// 跑团（TRPG）扩展：状态层、工具、命令、提示词，以及**真起一次 app 的端到端**。
//
// ── 这一套最要紧的断言是"接管真的换了模型看到的东西" ──
//
// 前五段是单元（纯函数 + 工具处理器），第六段真起 `createApp()`：在配置里把 `group:701` 绑给
// trpg，然后真跑一轮，断言**假模型端点收到的请求**里工具表只剩跑团那 4 个、system prompt
// 是跑团人格而不是"你是「小鲸鱼」"；同时断言另一个群照常拿到内置工具与主人格。
//
// 为什么值得花这个成本：`web/app.ts` 里那句 `isOverridden(chatKey) ? mine : [...BUILTIN_TOOLS, ...mine]`
// 是"接管时内置工具让位"的**唯一**实现处，而 `extras.toolDefs()` 那一层的断言看不见它
// （那一层只管扩展自己那几个）。少了这一段，把内置工具重新拼回去不会有任何东西变红，
// 而症状是"接管之后模型手里同时有跑团工具和 25 个内置工具，人格指令却在叫它用 say"。
import fs from 'node:fs';
import path from 'node:path';
import { checker, dataDir, fakeModelServer, toolCall } from './lib/harness.mjs';
import { ROOT, load, stripComments } from './lib/src.mjs';

const DIR = dataDir('qqagent-trpg-');
const { ok, done } = checker();

const {
  TrpgStore, appendLog, campaignFile, clampInt, emptyCampaign, findCharacter, normalizeCampaign, text
} = await load('extra/trpg/state.js');
const {
  formatCheck, formatRoll, renderForModel, renderForPlayers, renderStatusCard
} = await load('extra/trpg/render.js');
const { createHandlers } = await load('extra/trpg/tools.js');
const { createRuntime } = await load('extra/trpg/impl.js');
const { DiceError, rollDice } = await load('extra/trpg/rules/dice.js');
const { createLedger, consume, recall, remember } = await load('extra/trpg/rules/economy.js');
const { RuleStore } = await load('extra/trpg/rule-store.js');
const { ScenarioStore } = await load('extra/trpg/scenario.js');
const { beginCampaign } = await load('extra/trpg/tools.js');
const { EXTRA_REGISTRY } = await load('extra/registry.js');

const store = new TrpgStore();
/** 规则表存在临时数据目录的 `rules/` 下（内置两套由它懒补齐，所以这里不用自己造）。 */
const ruleStore = new RuleStore(path.join(DIR, 'rules'));

/** 假 `ToolContext`：工具只碰 `chatKey` / `sender` / `session` / `emit` 四样。 */
function fakeCtx(chatKey, over = {}) {
  const events = [];
  let nextId = 1;
  return {
    chatKey,
    events,
    session: { id: 'sess-1', sent: [] },
    emit: (type, payload) => events.push([type, payload]),
    sender: {
      async sendTextBatch(_key, messages, _options) {
        const list = Array.isArray(messages) ? messages : [messages];
        return { sent: list.map((t) => ({ text: String(t), messageId: nextId++, at: '00:00:01' })), failed: [] };
      }
    },
    ...over
  };
}

// **一份共享的 handlers**，不是每次调用新建一个：行动经济账本按 `ToolContext` 分组
// （见 `tools.ts` 的 `WeakMap`），每次新建就等于账本永远是空的 —— 去重与配额两条都测不出来。
// 每个 `fakeCtx(...)` 是一个新的 `ctx`，也就等于**一次新的运行**（那正是"一个回合"的定义）。
const notes = [];
const handlers = createHandlers({
  store,
  rules: ruleStore,
  // 固定随机源：工具层的断言关心的是"接线对不对"，不是骰子分布（那在 t-trpg-rules 里）。
  rng: () => 0.5,
  deliverNote: (chatKey, note) => notes.push({ chatKey, ...note })
});
const call = (name, ctx, args) => handlers[name](ctx, args);
const body = (result) => String(result.content);
const status = (key) => store.read(key);

// ── 1. 状态层：上限、归一化、落盘、旧形状迁移 ────────────────────────────────
{
  const key = 'group:901';
  ok('没有战役文件时读到 null（不是空对象 —— "没开团"与"开了个空团"是两件事）',
    store.read(key) === null);

  const campaign = emptyCampaign(key, { title: '废弃灯塔', system: '通用骰子', rule: 'generic' });
  ok('emptyCampaign 填了标题与规则表，日志空、序号从 1 起',
    campaign.title === '废弃灯塔' && campaign.rule === 'generic' && campaign.seq === 1);

  store.write(campaign);
  ok('落盘后读得回来，且文件在 data/trpg/ 下',
    store.read(key)?.title === '废弃灯塔' && campaignFile(key).startsWith(path.join(DIR, 'trpg')));

  const dirty = normalizeCampaign({
    title: 'x'.repeat(80), scene: 'y'.repeat(500),
    flags: { 旗标: 'v'.repeat(999) },
    characters: [
      { name: '好卡', hp: 999, hpMax: 10, san: -5, sanMax: 20, stats: { 力量: 1e9 }, notes: [1, 2, 'ok'] },
      { hpMax: 5 },                       // 没名字 → 丢掉
      { name: '好卡', hpMax: 3 },         // 重名 → 丢掉（同名两张卡会让"改谁的血"变成运气）
      'not an object'
    ],
    log: [{ seq: 3, text: 'a' }, { seq: 9, text: 'b' }, { text: '' }, null],
    seq: 1
  }, key);
  ok('归一化夹住长度（标题 / 场景 / 旗标值）',
    dirty.title.length === 60 && dirty.scene.length === 400 && dirty.flags.旗标.value.length === 160,
    `${dirty.title.length}/${dirty.scene.length}/${dirty.flags.旗标.value.length}`);
  ok('归一化丢掉没有名字的卡与重名的卡（只剩一张）',
    dirty.characters.length === 1 && dirty.characters[0].name === '好卡',
    JSON.stringify(dirty.characters.map((c) => c.name)));
  ok('HP/SAN 被夹进 [0, 上限]、属性被夹进合法区间',
    dirty.characters[0].hp === 10 && dirty.characters[0].san === 0 && dirty.characters[0].stats.力量 === 9999,
    JSON.stringify(dirty.characters[0]));
  ok('日志里的坏条目被丢掉、留下的有内容', dirty.log.length === 2, JSON.stringify(dirty.log));
  ok('序号只增不减：取 max(文件里的 seq, 日志最大 seq + 1)',
    dirty.seq === 10, String(dirty.seq));
  ok('完全不是对象时归一化成 null（当成没开团）',
    normalizeCampaign('nope', key) === null && normalizeCampaign([], key) === null);

  // 旗标的**旧形状迁移**：老存档里 `flags` 是 `Record<string, string>`。
  // 升级不该让已开团的群丢掉旗标，也不该把原本公开的事实一夜之间变成暗线。
  const legacy = normalizeCampaign({ flags: { 老旗标: '还在' } }, key);
  ok('旧形状的旗标读成"玩家可见"（升级不丢数据、也不偷偷变成暗线）',
    legacy.flags.老旗标?.value === '还在' && legacy.flags.老旗标?.visible === true,
    JSON.stringify(legacy.flags));
  const explicit = normalizeCampaign({ flags: { 暗线: { value: '藏', visible: false } } }, key);
  ok('新形状按 visible 读（false 保持 false）',
    explicit.flags.暗线?.value === '藏' && explicit.flags.暗线?.visible === false);

  // 日志上限：留档 60 条，序号不回退。
  const big = emptyCampaign('group:902', { title: 't', system: '', rule: 'generic' });
  for (let i = 0; i < 80; i++) appendLog(big, 'roll', `第 ${i} 条`);
  ok('日志留档有上限（留最近 60 条），但序号继续往前走（否则序号会重复）',
    big.log.length === 60 && big.seq === 81 && big.log[59].text === '第 79 条',
    `len=${big.log.length} seq=${big.seq}`);

  ok('clampInt / text 的边界：非数给 fallback、超长截断',
    clampInt('abc', 0, 10, 7) === 7 && clampInt(99, 0, 10, 0) === 10 && clampInt(1.6, 0, 10, 0) === 2
    && text('  a  ', 1) === 'a' && text(null, 5) === '');
}

// ── 2. 四个工具：campaign / character / roll（+ say 在下一段）────────────────
{
  const key = 'group:903';
  const ctx = fakeCtx(key);

  ok('没有开局时，需要战役的工具回一句可执行的下一步',
    /还没有开局/.test(body(await call('character', ctx, { action: 'create', name: '甲' })))
    && /campaign/.test(body(await call('roll', ctx, { expr: '3d6' }))));

  // 顺序：先答"这个会话能不能掷"，再解析表达式。反过来的话，没开局的会话会**先白掷一次**
  // （消耗掉一组随机数）再把"还没开局"回给模型 —— 而模型问的是骰子。
  ok('没开局时连非法表达式也先说"还没开局"（先判能不能掷，再掷）',
    /还没有开局/.test(body(await call('roll', ctx, { expr: '3d6+' })))
    && /还没有开局/.test(body(await call('roll', ctx, { expr: '1d20', target: 5 }))));

  ok('action 不在取值域里时，报错点明四个取值',
    /start \/ scene \/ flag \/ reveal/.test(body(await call('campaign', ctx, { action: 'nope' }))));

  // ── 开局 ──
  ok('campaign start 需要标题',
    (await call('campaign', ctx, { action: 'start' })).isError === true);

  const started = await call('campaign', ctx, {
    action: 'start', title: '灯塔', system: '通用骰子', rule: 'coc7', scene: '码头'
  });
  ok('开局成功，回执里带上这一局的规则表（它决定检定怎么判）',
    !started.isError && /灯塔/.test(body(started)) && /coc7/.test(body(started)), body(started));
  ok('开局落盘了（含一条 scene 日志，且记的是规范化之后的规则 id）',
    status(key).title === '灯塔' && status(key).log[0].kind === 'scene' && status(key).rule === 'coc7',
    JSON.stringify(status(key).log));

  const again = await call('campaign', fakeCtx(key), { action: 'start', title: '另一场' });
  ok('已经开过团时再开局被拒，且回话里带"怎么解"',
    again.isError === true && /已经有/.test(body(again)) && /restart/.test(body(again)), body(again));

  const badRule = await call('campaign', fakeCtx('group:r1'), { action: 'start', title: 'X', rule: '不存在的表' });
  ok('认不出来的 rule 回落到 generic（读取路径不抛错，但**记的是回落后的 id**）',
    !badRule.isError && store.read('group:r1').rule === 'generic', store.read('group:r1')?.rule);

  // ── 场景与旗标 ──
  const sceneCtx = fakeCtx(key);
  ok('campaign scene 换了场景并进日志',
    /已更新/.test(body(await call('campaign', sceneCtx, { action: 'scene', scene: '灯塔底层' })))
    && status(key).scene === '灯塔底层' && status(key).log.at(-1).kind === 'scene');

  const flagCtx = fakeCtx(key);
  await call('campaign', flagCtx, { action: 'flag', flags: { 雾很浓: '是' } });
  ok('campaign flag 写旗标（默认玩家可见）',
    status(key).flags.雾很浓?.value === '是' && status(key).flags.雾很浓?.visible === true);
  ok('同一轮里第二次改旗标被配额拦下（一回合一个主行动）',
    /这一轮已经行动过了/.test(body(await call('campaign', flagCtx, { action: 'flag', flags: { 门开了: '是' } }))),
    body(await call('campaign', flagCtx, { action: 'flag', flags: { 门开了: '是' } })));
  ok('换个回合（新的 ctx）照常能改',
    !(await call('campaign', fakeCtx(key), { action: 'flag', flags: { 门开了: '是' } })).isError);

  const darkCtx = fakeCtx(key);
  await call('campaign', darkCtx, { action: 'flag', flags: { 幕后黑手: '是' }, visible: false });
  ok('visible=false 写的是**暗线**', status(key).flags.幕后黑手?.visible === false);
  const delCtx = fakeCtx(key);
  await call('campaign', delCtx, { action: 'flag', flags: { 幕后黑手: '' } });
  ok('旗标值给空串 = 删掉这个旗标（沿用合并前的语义）', !('幕后黑手' in status(key).flags));

  ok('campaign flag 什么都没给时被拒',
    (await call('campaign', fakeCtx(key), { action: 'flag', flags: {} })).isError === true);

  // ── 人物卡 ──
  const created = await call('character', ctx, {
    action: 'create', name: '阿飞', ownerId: 10001, hpMax: 12, sanMax: 50, stats: { 力量: 14, 侦查: 45 }
  });
  ok('建卡：HP/SAN 从满值开始，属性如实写进去',
    status(key).characters[0].hp === 12 && status(key).characters[0].san === 50
    && status(key).characters[0].stats.力量 === 14, body(created));
  ok('建卡默认"玩家已经见过"（要藏起来是一个显式动作）',
    status(key).characters[0].discovered === true && status(key).characters[0].hidden.length === 0);

  const npc = await call('character', ctx, { action: 'create', name: '酒保' });
  ok('没有 ownerId 的卡是 NPC（玩家为空的都算 DM 扮演）',
    status(key).characters[1].ownerId === '' && npc.isError !== true);

  ok('建卡不过行动闸门（不同的名字本来就是不同的动作）',
    !(await call('character', ctx, { action: 'create', name: '路人甲' })).isError);

  const dupe = await call('character', ctx, { action: 'create', name: '阿飞' });
  ok('同名重复建卡被拒，并指向 action=update',
    dupe.isError === true && /update/.test(body(dupe)), body(dupe));

  const ghost = await call('character', ctx, { action: 'update', name: '不存在的人', hpDelta: -1 });
  ok('改不存在的卡时说清现在有哪些卡',
    ghost.isError === true && /阿飞/.test(body(ghost)), body(ghost));

  // 一次调用改多项（合并工具的价值就在这 —— 分几次会被配额拦下）。
  const hitCtx = fakeCtx(key);
  const hit = await call('character', hitCtx, {
    action: 'update', name: '阿飞', hpDelta: -3, sanDelta: -7, note: '受了刀伤'
  });
  ok('一次调用能同时改 HP / SAN / 备注',
    status(key).characters[0].hp === 9 && status(key).characters[0].san === 43
    && status(key).characters[0].notes.includes('受了刀伤'), body(hit));
  ok('**同一个回合里再改同一张卡会被拒**（要改多项就一次给全）',
    /这一轮已经行动过了/.test(body(await call('character', hitCtx, { action: 'update', name: '阿飞', hpDelta: -1 }))));
  ok('同一回合里改**别人**照常（账本按卡名分）',
    !(await call('character', hitCtx, { action: 'update', name: '酒保', hpDelta: -1 })).isError);

  const downCtx = fakeCtx(key);
  await call('character', downCtx, { action: 'update', name: '阿飞', hpDelta: -100 });
  ok('掉血夹在 0 而不是负数', status(key).characters[0].hp === 0, String(status(key).characters[0].hp));

  const healCtx = fakeCtx(key);
  await call('character', healCtx, { action: 'update', name: '阿飞', full: true });
  ok('full 把 HP 与 SAN 都回满',
    status(key).characters[0].hp === 12 && status(key).characters[0].san === 50);

  const statCtx = fakeCtx(key);
  await call('character', statCtx, { action: 'update', name: '阿飞', stats: { 力量: 15, 潜行: 30 } });
  ok('改属性是覆盖式的（只动给出来的那几项）',
    status(key).characters[0].stats.力量 === 15 && status(key).characters[0].stats.潜行 === 30
    && status(key).characters[0].stats.侦查 === 45);

  const forgetCtx = fakeCtx(key);
  await call('character', forgetCtx, { action: 'update', name: '阿飞', forget: '受了刀伤' });
  ok('forget 删掉内容完全相同的那条备注',
    status(key).characters[0].notes.length === 0, JSON.stringify(status(key).characters[0].notes));

  ok('什么都没给时被拒，并列出可以给什么',
    /hpDelta/.test(body(await call('character', fakeCtx(key), { action: 'update', name: '阿飞' }))));

  const removeCtx = fakeCtx(key);
  await call('character', removeCtx, { action: 'remove', name: '路人甲' });
  ok('remove 让角色退场', !status(key).characters.some((c) => c.name === '路人甲'));

  // ── 掷骰 / 检定 ──
  const rolled = await call('roll', fakeCtx(key), { expr: '3d6', reason: '火焰伤害' });
  ok('roll 把每一颗骰子都印出来（"3d6 → 9" 是不可复核的）',
    /3d6 → \d\+\d\+\d = \d+/.test(body(rolled)) && /火焰伤害/.test(body(rolled)), body(rolled));
  ok('掷骰会明说"不会自动发言"（说不说是模型的判断）', /不会自动发言/.test(body(rolled)));
  ok('掷骰写进了日志',
    status(key).log.at(-1).kind === 'roll' && /3d6/.test(status(key).log.at(-1).text));

  const kh = await call('roll', fakeCtx(key), { expr: '4d6kh3' });
  ok('kh 的结果说清了丢掉几颗（否则 4d6kh3 与 3d6 在结果上分不出来）',
    /丢掉 1 颗/.test(body(kh)), body(kh));

  const legal = await call('roll', fakeCtx(key), { expr: '2d6+1d4' });
  ok('多组骰子现在是合法的（旧版本这里报"一次只能掷一组"）',
    !legal.isError && /2d6\+1d4 → \(/.test(body(legal)), body(legal));

  const badExpr = await call('roll', fakeCtx(key), { expr: '3d6+' });
  ok('非法表达式把可读的中文原因回给模型（不是一句"失败了"）',
    badExpr.isError === true && /骰子表达式/.test(body(badExpr)) && /支持/.test(body(badExpr)), body(badExpr));

  // 传了 target 就是检定 —— 用的是**这一局选的规则表**（上面 start 时选了 coc7，所以这里必须 d100）。
  const cocCheck = await call('roll', fakeCtx(key), { expr: '1d100', target: 50, reason: '撬锁' });
  ok('传了 target 就是检定，并按这一局的规则表判档（coc7 给了中文档位名）',
    /对 50 → (成功|失败)/.test(body(cocCheck))
    && /(大成功|极难成功|困难成功|成功|失败|大失败)/.test(body(cocCheck))
    && status(key).log.at(-1).kind === 'check', body(cocCheck));

  const badTarget = await call('roll', fakeCtx(key), { expr: '1d20', target: '难' });
  ok('目标值不是数时报错并给出写法',
    badTarget.isError === true && /目标值必须是一个数/.test(body(badTarget)), body(badTarget));

  const cocWrongDie = await call('roll', fakeCtx(key), { expr: '3d6', target: 10 });
  ok('选了 coc7 却掷 3d6：明确拒绝（而不是给出一个"看起来正常"的错误档位）',
    cocWrongDie.isError === true && /1d100/.test(body(cocWrongDie)), body(cocWrongDie));

  // ── 行动经济：同参数去重（这才是拦"重掷到成功"的那一条）──
  const rollCtx = fakeCtx(key);
  const first = await call('roll', rollCtx, { expr: '1d20', reason: '察觉' });
  const second = await call('roll', rollCtx, { expr: '1d20', reason: '察觉' });
  ok('**同一回合里参数完全相同的掷骰被去重**（不许把失败的结果重掷一遍）',
    /已经做过这件事/.test(body(second)) && body(second).includes(body(first)), body(second));
  ok('换个理由就是另一次判定（不误伤"为两个人各掷一次"）',
    !/已经做过这件事/.test(body(await call('roll', rollCtx, { expr: '1d20', reason: '搜索' }))));
  ok('声明了 actionSource 才放行同参数重复（规则允许的额外行动）',
    !/已经做过这件事/.test(body(await call('roll', rollCtx, { expr: '1d20', reason: '察觉', actionSource: 'extra_attack' }))));
  ok('去重按回合算：新的 ctx 就是新的一回合',
    !/已经做过这件事/.test(body(await call('roll', fakeCtx(key), { expr: '1d20', reason: '察觉' }))));

  // ── reveal：把藏起来的东西揭示给玩家，并回流一条笔记 ──
  const hiddenKey = 'group:910';
  const hctx = fakeCtx(hiddenKey);
  await call('campaign', hctx, { action: 'start', title: '暗线', scene: '密室' });
  await call('character', fakeCtx(hiddenKey), {
    action: 'create', name: '神秘人', visible: false, hidden: ['stats', 'pools']
  });
  await call('campaign', fakeCtx(hiddenKey), { action: 'flag', flags: { 幕后黑手: '是' }, visible: false });
  ok('藏起来的卡与旗标如实落盘',
    status(hiddenKey).characters[0].discovered === false
    && JSON.stringify(status(hiddenKey).characters[0].hidden) === '["stats","pools"]'
    && status(hiddenKey).flags.幕后黑手.visible === false);

  const before = notes.length;
  const revealed = await call('campaign', fakeCtx(hiddenKey), { action: 'reveal', name: '神秘人' });
  ok('reveal 把整张卡揭示出来（discovered 翻真、隐藏字段清空）',
    !revealed.isError && status(hiddenKey).characters[0].discovered === true
    && status(hiddenKey).characters[0].hidden.length === 0, body(revealed));
  ok('揭示之后**回流了一条【跑团笔记】**（否则模型下一轮看不到"玩家的认知变了"）',
    notes.length === before + 1 && notes.at(-1).chatKey === hiddenKey && notes.at(-1).kind === 'journal'
    && /群友现在知道了/.test(notes.at(-1).text), JSON.stringify(notes.at(-1)));

  const partial = await call('campaign', fakeCtx(hiddenKey), {
    action: 'reveal', name: '神秘人', fields: ['pools']
  });
  ok('fields 只揭示指定的那几个字段；本来就没藏的东西被点明"没什么可揭示的"',
    !partial.isError && /本来就没有/.test(body(partial)), body(partial));

  const noteBefore = notes.length;
  const flagReveal = await call('campaign', fakeCtx(hiddenKey), { action: 'reveal', name: '幕后黑手' });
  ok('reveal 也能揭示一条暗线旗标，并同样回流笔记',
    !flagReveal.isError && status(hiddenKey).flags.幕后黑手.visible === true
    && notes.length === noteBefore + 1 && /暗线/.test(notes.at(-1).text), body(flagReveal));

  ok('reveal 一个不存在的名字时列出可选项',
    /没有叫/.test(body(await call('campaign', fakeCtx(hiddenKey), { action: 'reveal', name: '查无此人' }))));

  // 没接线时（`deliverNote` 缺省）不该抛错 —— 测试与未接线的宿主都会走这条路。
  const bare = createHandlers({ store, rng: () => 0.5 });
  ok('没有 deliverNote 时 reveal 照常工作（回流是可选的口子）',
    !(await bare.campaign(fakeCtx(hiddenKey), { action: 'reveal', name: '神秘人' })).isError);
}

// ── 3. say：接管模式唯一的发言通道，也是会话账本的入口 ───────────────────────
//
// 这一段钉的是**上一条地基**（`recordSent`）在真实扩展里的落地：漏掉记账的表现是
// "说了话却被记成没说过，而且模型被追着再发一次"，两样都不报错。
{
  const key = 'group:904';
  const ctx = fakeCtx(key);
  await call('campaign', ctx, { action: 'start', title: '夜航' });

  const said = await call('say', ctx, { text: '船身在雾里吱呀作响。' });
  ok('say 真的发出去了', !said.isError && /已发送 1 条/.test(body(said)), body(said));
  ok('**say 记了会话账本**（少了它，这一轮会被判成 noreply）',
    ctx.session.sent.length === 1 && ctx.session.sent[0].text === '船身在雾里吱呀作响。',
    JSON.stringify(ctx.session.sent));
  ok('say 发了一次 session-update（面板要看得见）',
    ctx.events.some(([type]) => type === 'session-update'), JSON.stringify(ctx.events));
  ok('说的内容自动进跑团日志（记档由代码做，不给模型"说而不记"的口子）',
    status(key).log.at(-1).kind === 'narration' && status(key).log.at(-1).text === '船身在雾里吱呀作响。',
    JSON.stringify(status(key).log.at(-1)));

  const many = await call('say', ctx, { text: ['第一段。', '第二段。'] });
  ok('数组可以一次发多条，两条都进账本与日志',
    ctx.session.sent.length === 3 && status(key).log.length === 4 && /已发送 2 条/.test(body(many)));

  ok('空正文被拒', (await call('say', ctx, { text: '   ' })).isError === true);

  // 没开局时也能说话（DM 可能先打招呼再开局），只是没地方记。
  const bare = fakeCtx('group:905');
  const early = await call('say', bare, { text: '要跑团吗？' });
  ok('还没开局时 say 照常发得出去（只是不记日志）',
    !early.isError && bare.session.sent.length === 1 && status('group:905') === null);
}

// ── 4. 渲染：**给模型的那一份与给玩家的那一份是分开的** ─────────────────────
//
// 这一段是信息隔离的判据。两份如果有任何一处泄漏（DM 版少了隐藏信息 / 玩家版多了隐藏信息），
// 表现都是"藏了、没藏住"或者"模型不知道自己藏了什么"，而**没有任何报错**。
{
  const key = 'group:906';
  const ctx = fakeCtx(key);
  await call('campaign', ctx, { action: 'start', title: '雾港', system: '通用骰子', scene: '码头' });
  await call('character', fakeCtx(key), { action: 'create', name: '阿飞', ownerId: 10001, hpMax: 12, sanMax: 50 });
  await call('character', fakeCtx(key), { action: 'update', name: '阿飞', hpDelta: -4 });
  await call('character', fakeCtx(key), { action: 'create', name: '商贩', hpMax: 6 });
  await call('campaign', fakeCtx(key), { action: 'flag', flags: { 雾很浓: '是' } });
  await call('roll', fakeCtx(key), { expr: '1d20', reason: '察觉' });

  const forModel = renderForModel(status(key));
  ok('给模型的状态含标题 / 场景 / 规则表 / 角色 / 旗标 / 日志',
    /雾港/.test(forModel) && /码头/.test(forModel) && /检定规则表：generic/.test(forModel) && /阿飞/.test(forModel)
    && /HP 8\/12/.test(forModel) && /雾很浓 = 是/.test(forModel) && /#\d+ \[roll\]/.test(forModel),
    forModel.slice(0, 300));
  ok('NPC 与玩家在状态里分得清（谁是真人很重要）',
    /阿飞（玩家 10001）/.test(forModel) && /商贩（NPC）/.test(forModel));
  ok('没有 SAN 的卡不印 SAN（印一个 0/0 只会让模型困惑）',
    !/商贩（NPC）[^\n]*SAN/.test(forModel), forModel);
  ok('没有战役时给的是"还没开局 + 下一步"，不是空白',
    /还没有开局/.test(renderForModel(null)) && /campaign/.test(renderForModel(null)));

  // ── 隐藏的东西：DM 版照印且标注，玩家版根本不出现 ──
  const hideKey = 'group:907';
  await call('campaign', fakeCtx(hideKey), { action: 'start', title: '暗涌', scene: '停尸房' });
  await call('character', fakeCtx(hideKey), {
    action: 'create', name: '线人', hpMax: 8, stats: { 侦查: 70 }, visible: false
  });
  await call('character', fakeCtx(hideKey), {
    action: 'create', name: '医生', ownerId: 10002, hpMax: 10, sanMax: 40, hidden: ['pools', 'notes']
  });
  await call('character', fakeCtx(hideKey), {
    action: 'update', name: '医生', note: '袖口有干涸的血'
  });
  await call('campaign', fakeCtx(hideKey), { action: 'flag', flags: { 真凶是医生: '是' }, visible: false });

  const dm = renderForModel(status(hideKey));
  const players = renderForPlayers(status(hideKey));
  ok('DM 版**看得见**还没登场的人（它是 DM 的备忘录，不是玩家的清单）',
    /线人/.test(dm) && /\[玩家尚未见过\]/.test(dm), dm);
  ok('DM 版标出被隐藏的字段（标了它才知道哪句话不能说）',
    /\[对玩家隐藏: pools\/notes\]/.test(dm), dm);
  ok('DM 版把暗线旗标标成 [暗线]',
    /真凶是医生 = 是 \[暗线\]/.test(dm), dm);
  ok('DM 版另附一段"玩家已经知道的"（两份视图对着看，才知道认知差在哪）',
    /玩家已经知道的/.test(dm), dm.slice(-400));

  ok('**玩家版根本不出现还没登场的人**（不是印成 ??? —— 那本身就是一次泄漏）',
    !/线人/.test(players), players);
  ok('玩家版把隐藏字段印成 ???，且被藏起来的备注一个字都不出现',
    /医生（玩家 10002）[^\n]*HP \?\?\?[^\n]*SAN \?\?\?/.test(players)
    && !/袖口有干涸的血/.test(players), players);
  ok('玩家版不出现暗线旗标', !/真凶是医生/.test(players), players);
  ok('玩家版照样有可见的旗标与掷骰记录',
    /暗涌|停尸房/.test(players) && /最近的掷骰 \/ 检定：/.test(players) === (/\[roll\]|\[check\]/.test(players)),
    players);

  const card = renderStatusCard(status(key));
  ok('`/跑团` 的回执给的是玩家视角（含标题/角色）',
    /《雾港》/.test(card) && /阿飞/.test(card), card.slice(0, 200));
  ok('`/跑团` 回执里**没有**给模型的指令（读它的是人）',
    !/campaign/.test(card) && !/character/.test(card), card);
  ok('没开团时的回执告诉群友怎么开',
    /\/能力 加载 trpg/.test(renderStatusCard(null)), renderStatusCard(null));

  // ⚠️ 这一条抓的是一个**真实的泄漏**（实现改过之后才绿的）：玩家视角原本把最后 3 条日志
  // 原样印出来，而 `state` / `scene` 那两类日志是 DM 的记账 —— 它们的正文里混着
  // `隐藏：pools/notes`、`旗标：真凶是医生 = 是（暗线）` 这种刚藏好的东西。
  const leakKey = 'group:908';
  await call('campaign', fakeCtx(leakKey), { action: 'start', title: '泄漏检查', scene: '门厅' });
  await call('character', fakeCtx(leakKey), { action: 'create', name: '幕后', visible: false, hidden: ['notes'] });
  await call('campaign', fakeCtx(leakKey), { action: 'flag', flags: { 真凶是他: '是' }, visible: false });
  const leaked = renderForPlayers(status(leakKey));
  ok('**玩家视角不印记账类日志**（`state`/`scene` 的正文里带着隐藏卡与暗线的名字）',
    !/幕后/.test(leaked) && !/真凶是他/.test(leaked) && !/隐藏/.test(leaked) && !/暗线/.test(leaked),
    leaked);

  // `prompt(chatKey)`：真实现的接线。
  const runtime = createRuntime();
  const plan = runtime.prompt(key);
  ok('prompt(chatKey) 的段序是**人格 → 清单与剧本 → 状态**（公共前缀能命中到状态变化点之前）',
    plan.body.length === 3 && /【跑团主持人】/.test(plan.body[0])
    && /【剧本与规则】/.test(plan.body[1]) && /【当前跑团状态】/.test(plan.body[2]),
    JSON.stringify(plan.body.map((t) => t.slice(0, 20))));
  ok('中间那一段**永远非空**（规则清单至少有两个内置的）—— 段数飘忽会让"body 有几段"没法断言',
    plan.body[1].length > 0 && Array.isArray(runtime.prompt('').body) && runtime.prompt('').body.length === 3);
  ok('清单里列着可用规则（模型才知道 rule 能填什么）',
    /generic/.test(plan.body[1]) && /coc7/.test(plan.body[1]), plan.body[1].slice(0, 200));
  ok('没开局的会话在清单里明说"还没有任何剧本"',
    /还没有任何剧本/.test(runtime.prompt('group:999')?.body[1] ?? ''));
  ok('没开团的会话拿到的是"还没开局"那段（状态段最后一条）',
    /还没有开局/.test(runtime.prompt('group:999')?.body[2] ?? ''));
  ok('空会话不抛（装载时 checkRuntimeShape 就是这么调它的）',
    Array.isArray(runtime.prompt('')?.body) && runtime.prompt('').body.length === 3);
  ok('人格段是一整块（含换行），不是被空行拆散的数组',
    plan.body[0].includes('\n') && plan.body[0].includes('状态归系统管'));
  ok('人格段写明了"一回合只有一次主行动 / 额外行动要声明来源"（否则配额会被当成故障）',
    /一回合/.test(plan.body[0]) && /actionSource/.test(plan.body[0]));
  ok('人格段写明了"每轮收尾给 2-4 个选项"（这是零成本的正常路径，不说就每轮走兜底）',
    /2-4 个可执行/.test(plan.body[0]));
  ok('人格段写明了 [暗线] / [对玩家隐藏] 的含义（标注是模型唯一的判据）',
    /\[暗线\]/.test(plan.body[0]) && /\[对玩家隐藏/.test(plan.body[0]));
  ok('没开团的会话拿到的是"还没开局"那段',
    /还没有开局/.test(runtime.prompt('group:999')?.body[2] ?? ''));

  // 命令处理函数。
  const commands = runtime.commandHandlers;
  ok('命令处理函数的键就是 names[0]（装载时两个方向对账）',
    Object.keys(commands ?? {}).sort().join(',') === '/掷骰,/跑团', JSON.stringify(Object.keys(commands ?? {})));

  const rollReceipt = await commands['/掷骰']({
    chatKey: key, senderId: '10001', text: '/掷骰 3d6', media: [], replyToMessageId: null
  });
  ok('/掷骰 直接给结果，并记进日志（零 LLM 成本的快路径）',
    /3d6 → \d\+\d\+\d/.test(rollReceipt) && /10001 掷/.test(status(key).log.at(-1).text), String(rollReceipt));

  const multiReceipt = await commands['/掷骰']({
    chatKey: key, senderId: '1', text: '/掷骰 2d6+1d4', media: [], replyToMessageId: null
  });
  ok('/掷骰 也认得新文法（多组相加不再报错）', /2d6\+1d4 →/.test(multiReceipt), String(multiReceipt));

  ok('/掷骰 不带表达式时回用法（而不是静默）',
    /用法/.test(await commands['/掷骰']({ chatKey: key, senderId: '1', text: '/掷骰', media: [], replyToMessageId: null })));

  // 坏表达式**抛**出去 —— 外壳会把 message 原样发进群。
  let thrown = null;
  try {
    await commands['/掷骰']({ chatKey: key, senderId: '1', text: '/掷骰 3d6+', media: [], replyToMessageId: null });
  } catch (error) { thrown = error; }
  ok('/掷骰 的非法表达式**抛出**（外层 runCommand 会把这句中文原样发进群）',
    thrown instanceof DiceError && /骰子表达式/.test(thrown.message), String(thrown?.message));

  const statusReceipt = await commands['/跑团']({
    chatKey: hideKey, senderId: '1', text: '/跑团', media: [], replyToMessageId: null
  });
  ok('/跑团 给的是**玩家视角**：藏起来的人与暗线旗标都不出现',
    /《暗涌》/.test(statusReceipt) && !/线人/.test(statusReceipt) && !/真凶是医生/.test(statusReceipt),
    String(statusReceipt).slice(0, 200));
}

// ── 5. 剧本与规则：解析、开局注入、清单注入、工作台 ──────────────────────────
//
// 这一节的判据是"注入真的发生了"：骨架落进状态、正文进上下文、清单能被模型看到。
// 三件事少了任何一件的症状都是"开局了，但跟没注入一样"，而没有报错。
{
  const scenarios = new ScenarioStore(path.join(DIR, 'trpg', 'scenarios'));
  const rules = new RuleStore(path.join(DIR, 'trpg', 'rules'));
  const begin = (key, args) => beginCampaign(key, args, { store, rules, scenarios });

  // ── 解析：带骨架的完整剧本 ──
  const full = [
    '---',
    'title: 废弃灯塔',
    'rule: coc7',
    'scene: 午夜，码头',
    'flags: {"灯塔已熄":"是","真凶是守塔人":{"value":"是","visible":false}}',
    'characters: [{"name":"守塔人","visible":false,"hpMax":12,"stats":{"侦查":70}}]',
    '---',
    '这座灯塔三年前就废弃了。',
    '守塔人其实是……'
  ].join('\n');
  const written = scenarios.write('灯塔', full);
  ok('写一份带骨架的剧本：四个字段都解析出来了',
    written.ok === true && written.scenario.title === '废弃灯塔' && written.scenario.rule === 'coc7'
    && written.scenario.scene === '午夜，码头' && written.scenario.body === '这座灯塔三年前就废弃了。\n守塔人其实是……',
    JSON.stringify(written));
  ok('旗标支持 `{"value":..., "visible":false}` 这种带可见度的写法（暗线）',
    written.scenario.flags['灯塔已熄']?.value === '是'
    && written.scenario.flags['真凶是守塔人']?.visible === false);
  ok('人物卡里的 `visible: false` 真的把它藏起来了（文件里写 `visible`、字段叫 `discovered`，**这里必须做映射**）',
    written.scenario.characters[0]?.discovered === false
    && written.scenario.characters[0]?.hpMax === 12
    && written.scenario.characters[0]?.stats.侦查 === 70,
    JSON.stringify(written.scenario.characters));

  // ── 解析：没 frontmatter / 坏 frontmatter ──
  ok('没有 frontmatter 时整份当正文（"就贴一段设定"也要能用）',
    scenarios.write('散记', '这是一段随手的设定。').ok === true
    && scenarios.read('散记').scenario.body === '这是一段随手的设定。'
    && scenarios.read('散记').scenario.title === '散记');

  const noColon = scenarios.write('坏的', '---\ntitle 废弃灯塔\n---\n正文');
  ok('frontmatter 某行没冒号 → 报第几行（读它的人正在手改这个文件）',
    noColon.ok === false && /第 1 行/.test(noColon.message) && /冒号/.test(noColon.message), noColon.message);

  const badJson = scenarios.write('坏的2', '---\nflags: {不是 JSON}\n---\n正文');
  ok('flags 不是合法 JSON → 报字段名 + 该怎么写',
    badJson.ok === false && /flags/.test(badJson.message) && /JSON/.test(badJson.message), badJson.message);

  const unclosed = scenarios.write('坏的3', '---\ntitle: x\n正文');
  ok('frontmatter 没闭合 → 明说缺的是哪一行 `---`',
    unclosed.ok === false && /闭合/.test(unclosed.message), unclosed.message);

  const tooLong = scenarios.write('长的', `---\ntitle: x\n---\n${'字'.repeat(5000)}`);
  ok('正文超长**当场拒绝**（不是截断：截断是在人还能改的时候不说、跑起来才少半段）',
    tooLong.ok === false && /太长/.test(tooLong.message) && /4000/.test(tooLong.message), tooLong.message);

  const unknownKey = scenarios.write('多字段', '---\ntitle: x\n作者: 某人\n---\n正文');
  ok('认不出来的字段被忽略并记下来（多打一个字不该让整份剧本报废）',
    unknownKey.ok === true && unknownKey.ignored.includes('作者'), JSON.stringify(unknownKey));

  // ── 名字即文件名：路径安全（中文保留，见 §7 的 safeFileName 断言）──
  ok('剧本名过路径安全之后才当文件名',
    scenarios.write('../逃逸', '---\ntitle: x\n---\n正文').ok === true
    && !scenarios.list().some((item) => item.id.includes('/')),
    JSON.stringify(scenarios.list().map((item) => item.id)));
  ok('空名字被拒（不许拿一个默认值顶上）', scenarios.write('   ', '正文').ok === false);

  // ── 开局：把剧本**快照**进这一局 ──
  const started = begin('group:930', { scenario: '灯塔' });
  const campaign = store.read('group:930');
  ok('开局时剧本的骨架落进了状态（标题 / 场景 / 旗标 / 人物卡）',
    started.isError !== true && campaign.title === '废弃灯塔' && campaign.scene === '午夜，码头'
    && campaign.flags['灯塔已熄']?.value === '是' && campaign.flags['真凶是守塔人']?.visible === false
    && campaign.characters.length === 1 && campaign.characters[0].discovered === false,
    JSON.stringify({ title: campaign.title, scene: campaign.scene, flags: campaign.flags, chars: campaign.characters.length }));
  ok('剧本正文是**快照**进存档的（改剧本文件不该影响正在跑的团）',
    campaign.scenario.id === '灯塔' && /这座灯塔三年前就废弃了/.test(campaign.scenario.body));
  ok('剧本推荐的规则表被采用（没显式传 rule 时）', campaign.rule === 'coc7', campaign.rule);
  ok('回执说清了注入了什么（否则群里看不出剧本有没有生效）',
    /剧本「灯塔」已注入/.test(String(started.content)) && /预置 2 条旗标/.test(String(started.content)),
    String(started.content));

  // 快照的对照断言：改掉剧本文件，正在跑的团**一个字都不变**。
  scenarios.write('灯塔', '---\ntitle: 改过的\n---\n新的正文');
  ok('改了剧本文件之后，已经开着的那一局逐字不变（快照，不是引用）',
    store.read('group:930').title === '废弃灯塔'
    && /这座灯塔三年前就废弃了/.test(store.read('group:930').scenario.body));
  ok('但**新开**的一局用的是改过之后的版本',
    begin('group:931', { scenario: '灯塔' }).isError !== true && store.read('group:931').title === '改过的');

  // ── 开局：几种失败与回落 ──
  ok('剧本不存在 → 拒绝开局（不给自己编一个标题开半截团）',
    begin('group:932', { scenario: '查无此剧本' }).isError === true
    && /没有叫/.test(String(begin('group:932', { scenario: '查无此剧本' }).content)));
  ok('既没给标题也没给剧本 → 拒绝，并说清两个办法',
    /title/.test(String(begin('group:933', {}).content)) && /scenario/.test(String(begin('group:933', {}).content)));
  ok('可以用 `title` 覆写剧本的标题',
    begin('group:934', { scenario: '灯塔', title: '我的团' }).isError !== true
    && store.read('group:934').title === '我的团');

  const fallback = begin('group:935', { title: 'x', rule: '查无此表' });
  ok('规则表不存在 → 回落到 generic **并把那句 note 写进回执**（静默回落最忌讳）',
    /generic/.test(String(fallback.content)) && /不存在/.test(String(fallback.content))
    && store.read('group:935').rule === 'generic', String(fallback.content));

  // 坏规则表：**拒绝开局**，不静默换一套。
  fs.writeFileSync(path.join(rules.dir, 'broken.json'),
    JSON.stringify({ name: '坏', levels: [{ name: 'a', label: 'A', success: true, condition: 'total >= ' }] }), 'utf8');
  const broken = begin('group:936', { title: 'x', rule: 'broken' });
  ok('规则表本身坏了 → 拒绝开局（静默换一套会让"同一个骰面在两局里判出不同的档"没人能解释）',
    broken.isError === true && /有问题/.test(String(broken.content)), String(broken.content));

  ok('已经开过局时再开局被拒（命令与工具**共用**这一条判据）',
    begin('group:930', { scenario: '散记' }).isError === true
    && /已经有/.test(String(begin('group:930', { scenario: '散记' }).content)));

  // ── 清单注入：模型才知道 rule / scenario 能填什么 ──
  const runtime = createRuntime();
  const briefing = runtime.prompt('group:930').body[1];
  ok('上下文里列着可用的剧本与规则（含刚写进去的那份）',
    /灯塔/.test(briefing) && /generic/.test(briefing) && /coc7/.test(briefing), briefing.slice(0, 300));
  ok('这一局的剧本正文进了上下文，且标明是"给你看的设定"',
    /这座灯塔三年前就废弃了/.test(briefing) && /这一局的剧本是「灯塔」/.test(briefing), briefing.slice(0, 300));
  ok('没注入剧本的会话明说"由你自己发挥"',
    /没有注入剧本/.test(runtime.prompt('group:999')?.body[1] ?? ''));
  ok('坏规则表**不进清单**（它本来也选不中），但仍在工作台列表里',
    !/broken/.test(briefing) && rules.list().some((r) => r.id === 'broken'));

  // ── `/跑团 开局` 命令：与工具共用同一个实现 ──
  const commands = runtime.commandHandlers;
  const cmd = (text, key = 'group:940') => commands['/跑团']({
    chatKey: key, senderId: '10001', text, media: [], replyToMessageId: null
  });
  const opened = await cmd('/跑团 开局 灯塔');
  ok('`/跑团 开局 <剧本>` 真的开了一局，且与工具注入的东西一致',
    /剧本「灯塔」已注入/.test(String(opened)) && store.read('group:940').title === '改过的'
    && store.read('group:940').scenario.id === '灯塔', String(opened));
  ok('`/跑团 开局` 不带剧本名时回用法（而不是静默）', /用法/.test(String(await cmd('/跑团 开局'))));
  ok('不认识的子命令列出可用的那些（而不是当普通消息忽略）',
    /不认识的子命令/.test(String(await cmd('/跑团 存档 灯塔'))));
  ok('不带参数时仍是玩家视角的状态卡（**原语义一个字没变**）',
    /【跑团笔记】/.test(String(await cmd('/跑团', 'group:930')))
    && !/线人/.test(String(await cmd('/跑团', 'group:907'))));

  // ── 工作台：列表 + 删除 ──
  ok('工作台列表来自磁盘（列出来的，一定是真的有的）',
    scenarios.list().some((item) => item.id === '灯塔')
    && scenarios.list().every((item) => typeof item.title === 'string'));
  // 坏文件**直接落盘**（`write` 会拒绝且**不写** —— 那是对命令路径的取舍：别把垃圾持久化）。
  // 而管理员手放的文件是另一回事：它在盘上，就该看得见、看得见问题。
  fs.mkdirSync(scenarios.dir, { recursive: true });
  fs.writeFileSync(path.join(scenarios.dir, '坏的.md'), ['---', 'title 缺冒号', '---', '正文'].join('\n'), 'utf8');
  ok('坏剧本照样列出来并带上问题（跳过它只会让管理员看到"少了一个"）',
    scenarios.list().some((item) => item.id === '坏的' && item.problems.length > 0),
    JSON.stringify(scenarios.list().find((item) => item.id === '坏的')));
  ok('删掉之后列表里没了，且再读会明确说"没有叫…的剧本"',
    scenarios.remove('散记') === true && !scenarios.list().some((item) => item.id === '散记')
    && /没有叫/.test(scenarios.read('散记').message));
  ok('删一个不存在的剧本返回 false（不抛）', scenarios.remove('查无此剧本') === false);
  ok('内置规则表也允许删（它就是文件）', rules.remove('broken') === true && !rules.list().some((r) => r.id === 'broken'));
}

// ── 6. 注册表接点与 `onRunEnd` ──────────────────────────────────────────────
{
  const entry = EXTRA_REGISTRY.find((item) => item.id === 'trpg');
  ok('trpg 注册在注册表里，是接管模式', !!entry && entry.mode === 'override');
  ok('默认关（重能力一律默认关：imageSource / transcription / imageGen 都是）',
    entry.defaultEnabled === false);
  ok('声明了发言工具名，且它真的在 tools 里（装配期强校验）',
    entry.overrideTools?.sendTool === 'say' && entry.tools.some((t) => t.name === 'say'));
  ok('finishTool 显式写 null（跑团没有收尾工具，框架段不提它）',
    entry.overrideTools?.finishTool === null);
  ok('4 个工具 + 2 条命令（合并后的形态）',
    entry.tools.length === 4 && (entry.commands ?? []).length === 2,
    `${entry.tools.length}/${(entry.commands ?? []).length}`);
  ok('工具名就是 say / campaign / character / roll',
    JSON.stringify(entry.tools.map((t) => t.name)) === JSON.stringify(['say', 'campaign', 'character', 'roll']),
    JSON.stringify(entry.tools.map((t) => t.name)));
  ok('每个工具的 action 参数都声明了 enum（合并工具的可发现性全靠它）',
    (() => {
      // `say` 没有 action（它只做一件事）；有 action 的那两个必须把取值域列全 ——
      // 合并工具的代价正是"required 不能按 action 分支"，所以取值域必须让模型一眼看得到。
      const withAction = entry.tools.filter((t) => t.parameters.properties.action);
      return withAction.length === 2
        && withAction.every((t) => Array.isArray(t.parameters.properties.action.enum));
    })(),
    JSON.stringify(entry.tools.map((t) => [t.name, t.parameters.properties.action?.enum ?? null])));

  // 真装载一次：声明与实现对得上（这是这套设计唯一的漂移点）。
  const runtime = createRuntime();
  const declared = entry.tools.map((t) => t.name).sort();
  const implemented = Object.keys(runtime.handlers).sort();
  ok('声明 ⇄ 实现逐个对上（少的 = 调得到却执行不了；多的 = 死代码）',
    JSON.stringify(declared) === JSON.stringify(implemented),
    `声明 ${declared.join(',')} / 实现 ${implemented.join(',')}`);

  // ── `onRunEnd`：兜底建议的几条判据 ──
  //
  // ⚠️ **必须让生成真的能成功**，否则"没发条目"既可能是守卫拦下的、也可能是生成失败的 ——
  // 那是**假绿**（把守卫整行删掉，它照样绿）。所以这里起一个假模型端点，让它真的产出选项。
  const model = await fakeModelServer({ model: 'stub-suggest' });
  const { updateConfig } = await load('core/config.js');
  updateConfig({ api: { baseUrl: model.url, model: 'stub-suggest' } });

  const seed = (key) => {
    const campaign = emptyCampaign(key, { title: '兜底', system: '', rule: 'generic' });
    campaign.scene = '雨夜的巷口';
    appendLog(campaign, 'scene', '雨下得很大');
    store.write(campaign);
  };
  const person = { id: 1, mid: 1, ts: 1, senderId: '10001', senderName: '张三', text: '我在。', self: false, read: true, reply: null, media: [] };
  const machine = { ...person, senderId: '', senderName: '转写', kind: 'transcript' };
  const sessions = [];
  const withSink = createRuntime({ deliverNote: (chatKey, note) => sessions.push({ chatKey, ...note }) });
  /** 兜底生成器的假回应（三个像模像样的行动选项）。 */
  const suggestReply = '- 沿着血迹往仓库深处走\n- 先检查地上的箱子\n- 退回路口问酒保';
  /**
   * 每个"本该不兜底"的用例也要**重新装填脚本**，而且必须给一个**新数组**。
   *
   * ⚠️ 假模型端点的脚本是**消耗式**的（它会 `shift`），装一次只够一次调用。两个坑都踩过：
   * 不重装 → 那些用例即便守卫坏了也生成不出东西，断言照样绿；用同一个数组引用重装 →
   * 那个数组已经被 shift 空了，等于没装。探针（把守卫整行删掉再跑）就是这么揪出来的。
   */
  const arm = () => { model.script = [{ content: suggestReply }]; };

  // ① 正例：真人推动 + DM 沉默 → 真去生成，并把结果落成一条【行动建议】条目。
  seed('group:920');
  arm();
  await withSink.onRunEnd({ chatKey: 'group:920', status: 'noreply', sentCount: 0, trigger: [person] });
  ok('真人推动 + DM 沉默的那一轮，兜底生成一条【行动建议】条目',
    sessions.length === 1 && sessions[0].kind === 'suggest' && /沿着血迹/.test(sessions[0].text),
    JSON.stringify(sessions));
  ok('条目正文**明说是给 DM 的素材**（不许它照抄、不许它说是系统给的）',
    /别照抄/.test(sessions[0].text) && /系统/.test(sessions[0].text), sessions[0].text);

  // ② 冷却：同一个会话紧接着再来一次不再触发（防连着烧调用）。
  arm();
  await withSink.onRunEnd({ chatKey: 'group:920', status: 'noreply', sentCount: 0, trigger: [person] });
  ok('冷却窗口内不再兜底（连着几句沉默不会连着烧调用）', sessions.length === 1);

  // ③ 只有机器条目推动的那一轮不兜底。
  // **这条同时是循环终止的证明**：兜底落下的条目会唤醒下一轮，而那一轮的触发批里
  // 只有机器条目、没有真人消息 —— 少了这条守卫就是无限循环。
  seed('group:921');
  arm();
  await withSink.onRunEnd({ chatKey: 'group:921', status: 'noreply', sentCount: 0, trigger: [machine] });
  ok('**只有机器条目推动的那一轮不兜底**（否则兜底会自己触发自己，无限循环）',
    sessions.length === 1, JSON.stringify(sessions));

  // ④ DM 说了话的那一轮不兜底（提示词要求它自己给选项，正常路径零成本）。
  seed('group:922');
  arm();
  await withSink.onRunEnd({ chatKey: 'group:922', status: 'done', sentCount: 1, trigger: [person] });
  ok('DM 说了话的那一轮不兜底（提示词要求它自己给选项，正常路径零成本）',
    sessions.length === 1);

  // ⑤ 报错/被中止的轮次不算"沉默"：那是没跑成，不是它选择了不说话。
  seed('group:923');
  arm();
  await withSink.onRunEnd({ chatKey: 'group:923', status: 'error', sentCount: 0, trigger: [person] });
  arm();
  await withSink.onRunEnd({ chatKey: 'group:923', status: 'aborted', sentCount: 0, trigger: [person] });
  ok('报错 / 被中止的那一轮不兜底（那不是"沉默"，是没跑成）', sessions.length === 1);

  // ⑥ 还没开团：没有局面可参考。
  arm();
  await withSink.onRunEnd({
    chatKey: 'group:not-started', status: 'noreply', sentCount: 0, trigger: [person]
  });
  ok('还没开团的会话不做兜底', sessions.length === 1);

  // ⑦ 生成失败时**什么都不发**（发一条空的建议比不发更糟：白白唤醒一次模型）。
  seed('group:924');
  updateConfig({ api: { baseUrl: 'http://127.0.0.1:1/', model: 'nope' } });
  await withSink.onRunEnd({ chatKey: 'group:924', status: 'noreply', sentCount: 0, trigger: [person] });
  ok('生成失败时不发条目（它是旁路，不该把空条目塞进窗口）', sessions.length === 1, JSON.stringify(sessions));

  // ⑧ 模型给的话里混着元描述时，只把像选项的那些挑出来。
  seed('group:925');
  updateConfig({ api: { baseUrl: model.url, model: 'stub-suggest' } });
  model.script = [{ content: '好的，以下是几个选项：\n- 撬开木箱\n- 观察门缝\n这是一个很长的解释句子，不该被当成选项。' }];
  await withSink.onRunEnd({ chatKey: 'group:925', status: 'noreply', sentCount: 0, trigger: [person] });
  ok('只取列点行、丢掉元描述行（"以下是几个选项"不会被念给群友）',
    sessions.length === 2 && /撬开木箱/.test(sessions[1].text)
    && !/以下是几个选项/.test(sessions[1].text) && !/很长的解释/.test(sessions[1].text),
    sessions[1]?.text);
}

// ── 7. 行动经济账本（纯逻辑）──────────────────────────────────────────────
{
  const ledger = createLedger();
  ok('主行动每回合只有一次', consume(ledger, '阿飞', '').ok === true
    && consume(ledger, '阿飞', '').ok === false);
  ok('被拒的那一次不记账（再问一次还是拒，理由一致）',
    /这一轮已经行动过了/.test(consume(ledger, '阿飞', '').reason ?? ''));
  ok('不同行动者各有一份额度', consume(ledger, '酒保', '').ok === true);
  ok('声明了来源就是额外行动（不与主行动共享额度）', consume(ledger, '阿飞', 'multiattack').ok === true);
  ok('具名来源有合计上限（防"一轮打十次"）',
    consume(ledger, '阿飞', 'legendary_action').ok === true
    && consume(ledger, '阿飞', 'haste').ok === true
    && consume(ledger, '阿飞', 'time_stop').ok === false);

  const dedupe = createLedger();
  ok('没记过就没有可复用的结果', recall(dedupe, '阿飞', 'roll', { expr: '1d20' }) === null);
  remember(dedupe, '阿飞', 'roll', { expr: '1d20' }, '结果');
  ok('同样的参数能取回上次的结果', recall(dedupe, '阿飞', 'roll', { expr: '1d20' }) === '结果');
  ok('键排序无关（`{b,a}` 与 `{a,b}` 同键）',
    recall(dedupe, '阿飞', 'roll', { expr: '1d20', reason: '' }) === '结果');
  ok('空值与缺省同键（模型写不写 `reason: ""` 都是同一次调用）',
    recall(dedupe, '阿飞', 'roll', { expr: '1d20' }) === '结果');
  ok('参数不同就不是同一次调用', recall(dedupe, '阿飞', 'roll', { expr: '1d20', reason: '别的' }) === null);
  ok('行动者不同也不是同一次调用', recall(dedupe, '酒保', 'roll', { expr: '1d20' }) === null);
}

// ── 8. 源级断言：掷骰的熵源只能是那一个 ──────────────────────────────────────
//
// ⚠️ **这一节补的是一条探针实测出来的守护空白**：把 `impl.ts` 里的 `secureRng` 换成
// `Math.random`，**其余全部套件仍然全绿** —— 掷骰结果本来就随机，没有任何行为断言看得出熵源换了。
// 而它恰恰是"玩家会盯着点数看"那条信任的地基（见 `entropy.ts` 的说明）：`Math.random` 是
// xorshift128+，内部状态可从少量输出反推。
//
// 所以只能从源码文本上守。判据是"掷骰路径上不许出现 `Math.random`"，以及"`node:crypto`
// 只在 `entropy.ts` 里出现一次"（两处拿熵就等于有两个熵源，而其中一个迟早会漂移）。
{
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const impl = stripComments(read('src/extra/trpg/impl.ts'));
  const tools = stripComments(read('src/extra/trpg/tools.ts'));
  const rules = ['dice.ts', 'check.ts', 'percentile.ts', 'economy.ts']
    .map((file) => stripComments(read(`src/extra/trpg/rules/${file}`))).join('\n');

  ok('impl.ts 用 secureRng 掷骰，且**不出现** Math.random',
    /secureRng/.test(impl) && !/Math\.random/.test(impl),
    (impl.match(/Math\.random/) ?? []).join(' | '));
  ok('tools.ts 与规则层里也不出现 Math.random（随机源只有一个入口）',
    !/Math\.random/.test(tools) && !/Math\.random/.test(rules),
    [...(tools.match(/Math\.random/g) ?? []), ...(rules.match(/Math\.random/g) ?? [])].join(' | '));
  ok('`node:crypto` 只在 entropy.ts 里出现（两个熵源迟早会漂移）',
    /node:crypto/.test(read('src/extra/trpg/entropy.ts'))
    && !/node:crypto/.test(impl) && !/node:crypto/.test(tools) && !/node:crypto/.test(rules));
  ok('规则层是纯函数目录：里面一条相对 import 都没有指向 rules/ 之外',
    !/from\s*'\.\.\//.test(rules) && !/from\s*'node:/.test(rules));
}

// ── 9. 端到端：真起 app，接管一个群，看模型实际收到什么 ──────────────────────
console.log('\n=== 端到端：真起 app（createApp + start）===');
{
  const model = await fakeModelServer({ model: 'stub-trpg' });
  const { updateConfig } = await load('core/config.js');
  // 开机就接管 group:701（走 config 的 extras.override 播种那条路），并打开这个扩展。
  updateConfig({
    api: { baseUrl: model.url, model: 'stub-trpg', maxRounds: 3 },
    allowAllWhenEmpty: true, allow: { groups: [], private: [] },
    persona: { roleText: '你是一条小鱼。', botName: '小鲸鱼', selfNickname: '小鲸鱼' },
    store: { contextSliderPos: 95, historyCount: 10, maxContextMessages: 0 },
    reply: { maxWaitMs: 0, maxPerMinute: 0 },
    extras: { enabled: { trpg: true }, override: { 'group:701': 'trpg' } }
  });

  const { createApp } = await load('web/app.js');
  const core = createApp({ log: () => {} });

  // 真 app 里的 OneBot 是**没连上**的（测试不碰真协议端），而 `OneBotClient.call` 会真的去
  // `fetch(httpUrl/...)` —— 不挡的话 `say` 一律失败，整段端到端会以"发不出去"告终，
  // 而那**不是**被测代码的问题。所以在**唯一的出站漏斗**上垫一层：记下发出的文本，回一个 ok。
  // （只垫 `call`，不垫 `sendText` —— 后者带着"怎么把文本拼成消息段"的真实逻辑，那部分该照跑。）
  const outbox = [];
  core.onebot.call = async (action, params = {}) => {
    if (action === 'send_group_msg' || action === 'send_private_msg') {
      const segments = Array.isArray(params.message) ? params.message : [];
      outbox.push(segments.map((seg) => (seg?.type === 'text' ? String(seg.data?.text ?? '') : '')).join(''));
      return { message_id: 9000 + outbox.length };
    }
    if (action === 'get_group_info') return { group_name: '测试群' };
    if (action === 'get_login_info') return { user_id: '999', nickname: '小鲸鱼' };
    return {};
  };

  const port = await core.start();

  // ⚠️ 脚本里让模型**调 say**（而不是沉默）：兜底建议的判据之一是"这一轮 DM 一句话没说"，
  // 沉默的轮次会额外触发一次建议生成调用，那会让下面的"取最后一个请求"读错东西，
  // 而且它不是这一段要测的事（兜底在上一段按单元测过了）。
  // 等请求数不再变化 = 上一轮（含它的后续轮次）真的跑完了。
  //
  // **少了这一步会串台**：`runOnce` 取的是"这一轮的第一个请求"，而上一轮可能还有第二个
  // （`say` 之后模型再回一条）。基线取早了就会把上一轮那个请求当成这一轮的 ——
  // 症状正是"对照组拿到的是接管会话的工具表"，看起来像接管失效了。
  const settle = async () => {
    let last = -1;
    while (last !== model.requests.length) {
      last = model.requests.length;
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
  };

  const runOnce = async (key, text, script) => {
    await settle();
    model.script = script;
    const before = model.requests.length;
    const entry = core.store.appendIncoming(key, {
      mid: Date.now(), ts: Date.now(), senderId: '10001', senderName: '张三', text
    });
    core.orchestrator.onIncoming(key, entry);
    core.orchestrator.forceWake(key);
    const deadline = Date.now() + 8000;
    while (model.requests.length === before && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return model.requests[before];
  };

  const taken = await runOnce('group:701', '我们开跑吧', [
    { tool_calls: [toolCall('say', { text: '（测试）我先看看四周。' }, 's0')] },
    { content: null }
  ]);
  const toolNames = (taken?.tools ?? []).map((tool) => tool.function?.name);
  const systemText = String((taken?.messages ?? []).find((m) => m.role === 'system')?.content ?? '');

  ok('接管会话的模型请求真的发出去了（否则下面都是空转的绿）', !!taken && toolNames.length > 0);
  ok('**接管会话的工具表只剩跑团那 4 个**（内置 25 个全部让位）',
    JSON.stringify([...toolNames].sort()) === JSON.stringify(['campaign', 'character', 'roll', 'say']),
    JSON.stringify(toolNames));
  ok('框架契约段照接管者声明的名字写（send_message 不在表里，提示词也不该提它）',
    /要发言必须调用 say。/.test(systemText) && !/要发言必须调用 send_message/.test(systemText),
    systemText.slice(0, 120));
  ok('system prompt 换成了跑团人格，而不是"你是「小鲸鱼」"',
    /【跑团主持人】/.test(systemText) && !/你是「小鲸鱼」/.test(systemText) && !/你是一条小鱼/.test(systemText));
  ok('框架契约两段（安全规则 / 工具协议）仍然在（那是运行契约，谁都不能换掉）',
    /【安全规则/.test(systemText) && /【工作方式/.test(systemText));
  ok('能力段（漫画/转写/出图）让位了 —— 那些工具不在接管者的表里',
    !/download_jmcomic/.test(systemText) && !/【能力相关的工具规则】/.test(systemText));
  ok('这一轮模型看到的状态是"还没开局"（真 app 里 store 读的是真数据目录）',
    /还没有开局/.test(systemText), systemText.slice(-200));

  // 对照组：另一个群没有被接管。
  const plain = await runOnce('group:702', '在吗', [{ content: '（测试：这一轮不说话）' }]);
  const plainTools = (plain?.tools ?? []).map((tool) => tool.function?.name);
  const plainSystem = String((plain?.messages ?? []).find((m) => m.role === 'system')?.content ?? '');
  ok('**没被接管的群照常**：内置工具都在、跑团工具一个都没有',
    plainTools.includes('send_message') && plainTools.includes('finish')
    && !plainTools.includes('say') && !plainTools.includes('roll'),
    JSON.stringify(plainTools));
  ok('没被接管的群拿的是主人格（对照组：上一条不是假绿）',
    /你是「小鲸鱼」/.test(plainSystem) && !/【跑团主持人】/.test(plainSystem));

  // ── 接管会话里，模型调 say 的那一轮必须被记成 done ──
  //
  // 这是上面第 3 段（`say` 调 `recordSent`）与**收尾判据**之间的那一段接线在真 app 里的样子：
  // `agent-runner` 收尾看的是 `session.sent.length > 0 ? 'done' : 'noreply'`。
  // 漏了记账的表现就在这里 —— **真的说了话、会话却被记成没说过**，群里看着一切正常。
  const headers = { 'content-type': 'application/json', 'x-console-token': 'qq-agent-console' };
  const listIds = async () => ((await (await fetch(`http://127.0.0.1:${port}/api/sessions`, { headers })).json()).sessions ?? []);
  const before = new Set((await listIds()).map((row) => row.id));

  model.script = [
    { tool_calls: [toolCall('say', { text: '雾散了，前面是一座灯塔。' }, 's1')] },
    { content: null }
  ];
  const sayEntry = core.store.appendIncoming('group:701', {
    mid: Date.now(), ts: Date.now(), senderId: '10001', senderName: '张三', text: '我往前走'
  });
  core.orchestrator.onIncoming('group:701', sayEntry);
  core.orchestrator.forceWake('group:701');

  let finished = null;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const fresh = (await listIds()).find((row) => !before.has(row.id)
      && row.chatKey === 'group:701' && row.status !== 'running' && row.status !== 'waiting');
    if (fresh) {
      finished = await (await fetch(`http://127.0.0.1:${port}/api/sessions/${fresh.id}`, { headers })).json();
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  ok('真跑一轮：模型调 say 之后，这一轮被记成 done（而不是"没说过话"的 noreply）',
    finished?.status === 'done', JSON.stringify({ status: finished?.status ?? null }));
  ok('那句话真的从协议端出去了（垫掉的只是传输层，拼消息段那段是真跑的）',
    outbox.includes('雾散了，前面是一座灯塔。'), JSON.stringify(outbox));
  ok('同一份正文也在会话记录里（面板看得见），且只有这一条 —— 模型自己的普通文本没被代发',
    (finished?.sent ?? []).length === 1
    && (finished?.sent ?? []).some((item) => item.text === '雾散了，前面是一座灯塔。'),
    JSON.stringify(finished?.sent ?? null));

  // ── 接口层：面板那一页要看得见这个扩展，且如实标成接管模式 ──
  const listRes = await fetch(`http://127.0.0.1:${port}/api/extras`, { headers });
  const listBody = await listRes.json();
  const row = (listBody.extras ?? []).find((item) => item.id === 'trpg');
  ok('/api/extras 里看得见 trpg，标成 override、且 enabled 是从配置读出来的',
    listRes.status === 200 && row?.mode === 'override' && row?.enabled === true && !!row?.description,
    JSON.stringify(row));

  // ── 跑团笔记（新加的第四种异步结果）：它必须能唤醒一次运行 ──
  //
  // 这一条钉的是新 kind 的**整条接线**：`appendTrpgNote` 落库 → `isAsyncResult` 认它
  // （不参与窗口滑出）→ `evaluateWindowTrigger` 无条件响应 → 真起一次运行。
  // 少了任何一环的表现都是"扩展写了笔记、模型永远看不到"，而没有任何报错。
  const noteBefore = model.requests.length;
  core.store.appendTrpgNote('group:701', { noteKind: 'journal', text: '群友现在知道了：灯塔的门是虚掩的。' });
  core.orchestrator.forceWake('group:701');
  const noteDeadline = Date.now() + 8000;
  while (model.requests.length === noteBefore && Date.now() < noteDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const noteUser = String((model.requests[noteBefore]?.messages ?? [])
    .filter((m) => m.role === 'user').map((m) => String(m.content ?? '')).join('\n'));
  ok('跑团笔记唤醒了新一轮，且【跑团笔记】标签进了模型看到的正文',
    model.requests.length > noteBefore && /【跑团笔记】/.test(noteUser), noteUser.slice(-300));

  await core.stop();
}

process.exit(done() ? 0 : 1);
