// 跑团（TRPG）扩展：状态层、工具、命令、提示词，以及**真起一次 app 的端到端**。
//
// ── 这一套最要紧的断言是"接管真的换了模型看到的东西" ──
//
// 前四段是单元（纯函数 + 工具处理器），第五段真起 `createApp()`：在配置里把 `group:701` 绑给
// trpg，然后真跑一轮，断言**假模型端点收到的请求**里工具表只剩跑团那 7 个、system prompt
// 是跑团人格而不是"你是「小鲸鱼」"；同时断言另一个群照常拿到内置工具与主人格。
//
// 为什么值得花这个成本：`web/app.ts` 里那句 `isOverridden(chatKey) ? mine : [...BUILTIN_TOOLS, ...mine]`
// 是"接管时内置工具让位"的**唯一**实现处，而 `extras.toolDefs()` 那一层的断言看不见它
// （那一层只管扩展自己那几个）。少了这一段，把内置工具重新拼回去不会有任何东西变红，
// 而症状是"接管之后模型手里同时有跑团工具和 25 个内置工具，人格指令却在叫它用 say"。
import path from 'node:path';
import { checker, dataDir, fakeModelServer, toolCall } from './lib/harness.mjs';
import { load } from './lib/src.mjs';

const DIR = dataDir('qqagent-trpg-');
const { ok, done } = checker();

const {
  TrpgStore, appendLog, campaignFile, clampInt, emptyCampaign, findCharacter, normalizeCampaign, text
} = await load('extra/trpg/state.js');
const { formatCheck, formatRoll, renderForModel, renderStatusCard } = await load('extra/trpg/render.js');
const { createHandlers } = await load('extra/trpg/tools.js');
const { createRuntime } = await load('extra/trpg/impl.js');
const { DiceError, rollDice } = await load('extra/trpg/rules/dice.js');
const { EXTRA_REGISTRY } = await load('extra/registry.js');
const { createExtrasRuntime } = await load('extra/runtime.js');

const store = new TrpgStore();

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

const call = (name, ctx, args) => createHandlers(store)[name](ctx, args);
const body = (result) => String(result.content);
const status = (key) => store.read(key);

// ── 1. 状态层：上限、归一化、落盘 ────────────────────────────────────────────
{
  const key = 'group:901';
  ok('没有战役文件时读到 null（不是空对象 —— "没开团"与"开了个空团"是两件事）',
    store.read(key) === null);

  const campaign = emptyCampaign(key, { title: '废弃灯塔', system: '通用骰子' });
  ok('emptyCampaign 填了标题与规则，日志空、序号从 1 起',
    campaign.title === '废弃灯塔' && campaign.system === '通用骰子' && campaign.seq === 1);

  store.write(campaign);
  ok('落盘后读得回来，且文件在 data/trpg/ 下',
    store.read(key)?.title === '废弃灯塔' && campaignFile(key).startsWith(path.join(DIR, 'trpg')),
    campaignFile(key));

  // 归一化：坏文件不该让扩展崩，也不该让越界值进提示词。
  const dirty = normalizeCampaign({
    title: 'x'.repeat(500),
    scene: 'y'.repeat(5000),
    characters: [
      { name: '好卡', hp: 999, hpMax: 10, san: -5, sanMax: 20, stats: { 力量: 1e9 }, notes: [1, 2, 'ok'] },
      { hpMax: 5 },                       // 没名字 → 丢掉
      { name: '好卡', hpMax: 3 },         // 重名 → 丢掉（同名两张卡会让"改谁的血"变成运气）
      'not an object'
    ],
    flags: { 旗标: 'v'.repeat(999) },
    log: [{ seq: 3, text: 'a' }, { seq: 9, text: 'b' }, { text: '' }, null],
    seq: 1
  }, key);
  ok('归一化夹住长度（标题 / 场景 / 旗标值）',
    dirty.title.length === 60 && dirty.scene.length === 400 && dirty.flags.旗标.length === 160,
    `title=${dirty.title.length} scene=${dirty.scene.length}`);
  ok('归一化丢掉没有名字的卡与重名的卡（只剩一张）',
    dirty.characters.length === 1 && dirty.characters[0].name === '好卡',
    JSON.stringify(dirty.characters.map((c) => c.name)));
  ok('HP/SAN 被夹进 [0, 上限]、属性被夹进合法区间',
    dirty.characters[0].hp === 10 && dirty.characters[0].san === 0 && dirty.characters[0].stats.力量 === 9999,
    JSON.stringify(dirty.characters[0]));
  ok('日志里的坏条目被丢掉、留下的有内容',
    dirty.log.length === 2, JSON.stringify(dirty.log));
  ok('序号只增不减：取 max(文件里的 seq, 日志最大 seq + 1)',
    dirty.seq === 10, String(dirty.seq));

  ok('完全不是对象时归一化成 null（当成没开团）',
    normalizeCampaign('nope', key) === null && normalizeCampaign([], key) === null);

  // 日志上限：留档 60 条，序号不回退。
  const big = emptyCampaign('group:902', { title: 't', system: '' });
  for (let i = 0; i < 80; i++) appendLog(big, 'roll', `第 ${i} 条`);
  ok('日志留档有上限（留最近 60 条），但序号继续往前走（否则序号会重复）',
    big.log.length === 60 && big.seq === 81 && big.log[59].text === '第 79 条',
    `len=${big.log.length} seq=${big.seq}`);

  ok('clampInt / text 的边界：非数给 fallback、超长截断',
    clampInt('abc', 0, 10, 7) === 7 && clampInt(99, 0, 10, 0) === 10 && clampInt(1.6, 0, 10, 0) === 2
    && text('  a  ', 1) === 'a' && text(null, 5) === '');
}

// ── 2. 工具：开局、建卡、改卡、旗标、掷骰、检定 ──────────────────────────────
{
  const key = 'group:903';
  const ctx = fakeCtx(key);

  ok('没有开局时，需要战役的工具回一句可执行的下一步',
    /还没有开局/.test(body(await call('character_create', ctx, { name: '甲' })))
    && /campaign_start/.test(body(await call('roll_dice', ctx, { expr: '3d6' }))));

  // 顺序：先答"这个会话能不能掷"，再解析表达式。反过来的话，没开局的会话会**先白掷一次**
  // （消耗掉一组随机数）再把"还没开局"回给模型 —— 而模型问的是骰子。
  ok('没开局时连非法表达式也先说"还没开局"（先判能不能掷，再掷）',
    /还没有开局/.test(body(await call('roll_dice', ctx, { expr: '2d6+1d4' })))
    && /还没有开局/.test(body(await call('skill_check', ctx, { expr: '1d20', target: 5 }))));

  ok('campaign_start 需要标题', (await call('campaign_start', ctx, {})).isError === true);

  const started = await call('campaign_start', ctx, { title: '灯塔', system: '通用骰子', scene: '码头' });
  ok('开局成功，并提示下一步做什么',
    !started.isError && /灯塔/.test(body(started)) && /character_create/.test(body(started)), body(started));
  ok('开局落盘了（含一条 scene 日志）',
    status(key).title === '灯塔' && status(key).log[0].kind === 'scene', JSON.stringify(status(key).log));

  const again = await call('campaign_start', ctx, { title: '另一场' });
  ok('已经开过团时再开被拒，且回话里带"怎么解"',
    again.isError === true && /已经有/.test(body(again)) && /restart/.test(body(again)), body(again));

  // ── 人物卡 ──
  const created = await call('character_create', ctx, {
    name: '阿飞', ownerId: 10001, hpMax: 12, sanMax: 50, stats: { 力量: 14, 侦查: 45 }
  });
  ok('建卡：HP/SAN 从满值开始，属性如实写进去',
    status(key).characters[0].hp === 12 && status(key).characters[0].san === 50
    && status(key).characters[0].stats.力量 === 14, body(created));
  ok('ownerId 是玩家 QQ 号；NPC 留空',
    status(key).characters[0].ownerId === '10001'
    && (await call('character_create', ctx, { name: '酒保' }), status(key).characters[1].ownerId === ''));

  const dupe = await call('character_create', ctx, { name: '阿飞' });
  ok('重名建卡被拒，并指向 character_update',
    dupe.isError === true && /character_update/.test(body(dupe)), body(dupe));

  const ghost = await call('character_update', ctx, { name: '不存在', hpDelta: -1 });
  ok('改不存在的卡时报错，并把现有卡名列出来（免得它瞎猜）',
    ghost.isError === true && /阿飞/.test(body(ghost)), body(ghost));

  // ── HP / SAN ──
  await call('character_update', ctx, { name: '阿飞', hpDelta: -3, sanDelta: -7 });
  ok('hpDelta / sanDelta 是增量，日志里记着"从多少变到多少"',
    status(key).characters[0].hp === 9 && status(key).characters[0].san === 43
    && /HP 12→9/.test(status(key).log.at(-1).text) && /SAN 50→43/.test(status(key).log.at(-1).text),
    JSON.stringify(status(key).log.at(-1)));

  await call('character_update', ctx, { name: '阿飞', hpDelta: -999 });
  ok('HP 被钳在 0，不会变成负数',
    status(key).characters[0].hp === 0, String(status(key).characters[0].hp));

  await call('character_update', ctx, { name: '阿飞', full: true });
  ok('full 把 HP 与 SAN 一起回满',
    status(key).characters[0].hp === 12 && status(key).characters[0].san === 50);

  await call('character_update', ctx, { name: '阿飞', stats: { 力量: 15, 潜行: 30 } });
  ok('stats 是合并覆盖：只动提到的那几项',
    status(key).characters[0].stats.力量 === 15 && status(key).characters[0].stats.潜行 === 30
    && status(key).characters[0].stats.侦查 === 45, JSON.stringify(status(key).characters[0].stats));

  await call('character_update', ctx, { name: '阿飞', note: '左臂有旧伤' });
  await call('character_update', ctx, { name: '阿飞', forget: '左臂有旧伤' });
  ok('note 追加、forget 按内容精确删除（伤好了要能写掉，否则备注会一直骗模型）',
    status(key).characters[0].notes.length === 0, JSON.stringify(status(key).characters[0].notes));

  const nothing = await call('character_update', ctx, { name: '阿飞' });
  ok('一次什么都不改的调用被拒（否则日志里会堆"什么都没发生"的噪音）',
    nothing.isError === true && /没有改变任何东西/.test(body(nothing)), body(nothing));

  await call('character_update', ctx, { name: '酒保', remove: true });
  ok('remove 让角色退场（人物卡从这场团里移除）',
    status(key).characters.length === 1 && status(key).characters[0].name === '阿飞');

  // ── 场景与旗标 ──
  await call('story_update', ctx, { scene: '灯塔一层', flags: { 已拿到钥匙: '是', 门: '锁着' } });
  ok('story_update 写场景与旗标',
    status(key).scene === '灯塔一层' && status(key).flags.已拿到钥匙 === '是');

  await call('story_update', ctx, { flags: { 门: '' } });
  ok('旗标值为空串 = 删掉这个旗标',
    !('门' in status(key).flags) && status(key).flags.已拿到钥匙 === '是');

  ok('story_update 什么都没给时被拒',
    (await call('story_update', ctx, {})).isError === true);

  // ── 掷骰 / 检定 ──
  const rolled = await call('roll_dice', ctx, { expr: '3d6', reason: '火焰伤害' });
  ok('roll_dice 把每一颗骰子都印出来（"3d6 → 9" 是不可复核的）',
    /3d6 → \d\+\d\+\d = \d+/.test(body(rolled)) && /火焰伤害/.test(body(rolled)), body(rolled));
  ok('掷骰会明说"不会自动发言"（说不说是模型的判断）',
    /不会自动发言/.test(body(rolled)));
  ok('掷骰写进了日志',
    status(key).log.at(-1).kind === 'roll' && /3d6/.test(status(key).log.at(-1).text));

  const kh = await call('roll_dice', ctx, { expr: '4d6kh3' });
  ok('kh 的结果说清了丢掉几颗（否则 4d6kh3 与 3d6 在结果上分不出来）',
    /丢掉 1 颗/.test(body(kh)), body(kh));

  const badExpr = await call('roll_dice', ctx, { expr: '2d6+1d4' });
  ok('非法表达式把可读的中文原因回给模型（不是一句"失败了"）',
    badExpr.isError === true && /骰子表达式看不懂/.test(body(badExpr)) && /一次只能掷一组/.test(body(badExpr)),
    body(badExpr));

  const checked = await call('skill_check', ctx, { expr: '1d20', target: 5, reason: '撬锁' });
  ok('skill_check 给出成败与差值',
    /对 5 → (成功|失败)/.test(body(checked)) && status(key).log.at(-1).kind === 'check', body(checked));

  const badTarget = await call('skill_check', ctx, { expr: '1d20', target: '难' });
  ok('目标值不是数时报错并给出写法',
    badTarget.isError === true && /目标值必须是一个数/.test(body(badTarget)), body(badTarget));
}

// ── 3. say：接管模式唯一的发言通道，也是会话账本的入口 ───────────────────────
//
// 这一段钉的是**上一条地基**（`recordSent`）在真实扩展里的落地：漏掉记账的表现是
// "说了话却被记成没说过，而且模型被追着再发一次"，两样都不报错。
{
  const key = 'group:904';
  const ctx = fakeCtx(key);
  await call('campaign_start', ctx, { title: '夜航' });

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

// ── 4. 渲染与 prompt(chatKey) ───────────────────────────────────────────────
{
  const key = 'group:906';
  const ctx = fakeCtx(key);
  await call('campaign_start', ctx, { title: '雾港', system: '通用骰子', scene: '码头' });
  await call('character_create', ctx, { name: '阿飞', ownerId: 10001, hpMax: 12, sanMax: 50 });
  await call('character_update', ctx, { name: '阿飞', hpDelta: -4 });
  await call('character_create', ctx, { name: '商贩', hpMax: 6 });
  await call('story_update', ctx, { flags: { 雾很浓: '是' } });
  await call('roll_dice', ctx, { expr: '1d20', reason: '察觉' });

  const forModel = renderForModel(status(key));
  ok('给模型的状态含标题 / 场景 / 角色 / 旗标 / 日志',
    /雾港/.test(forModel) && /码头/.test(forModel) && /阿飞/.test(forModel)
    && /HP 8\/12/.test(forModel) && /雾很浓 = 是/.test(forModel) && /#\d+ \[roll\]/.test(forModel),
    forModel.slice(0, 300));
  ok('NPC 与玩家在状态里分得清（谁是真人很重要）',
    /阿飞（玩家 10001）/.test(forModel) && /商贩（NPC）/.test(forModel));
  ok('没有 SAN 的卡不印 SAN（印一个 0/0 只会让模型困惑）',
    !/商贩（NPC）[^\n]*SAN/.test(forModel), forModel);
  ok('没有战役时给的是"还没开局 + 下一步"，不是空白',
    /还没有开局/.test(renderForModel(null)) && /campaign_start/.test(renderForModel(null)));

  const card = renderStatusCard(status(key));
  ok('状态卡给群友看：含标题/角色/最近日志',
    /《雾港》/.test(card) && /阿飞/.test(card) && /最近：/.test(card), card.slice(0, 200));
  ok('状态卡里**没有**给模型的指令（读它的是人）',
    !/campaign_start/.test(card) && !/character_update/.test(card), card);
  ok('没开团时的状态卡告诉群友怎么开',
    /\/能力 加载 trpg/.test(renderStatusCard(null)), renderStatusCard(null));

  // `prompt(chatKey)`：真实现的接线。
  const runtime = createRuntime();
  const plan = runtime.prompt(key);
  ok('prompt(chatKey) 把人格放在**前面**、状态放在**后面**（公共前缀能命中到状态段之前）',
    plan.body.length === 2 && /【跑团主持人】/.test(plan.body[0]) && /【当前跑团状态】/.test(plan.body[1]),
    JSON.stringify(plan.body.map((t) => t.slice(0, 20))));
  ok('人格段是一整块（含换行），不是被空行拆散的数组',
    plan.body[0].includes('\n') && plan.body[0].includes('状态归系统管'));
  ok('没开团的会话拿到的是"还没开局"那段',
    /还没有开局/.test(runtime.prompt('group:999')?.body[1] ?? ''));
  ok('空会话不抛（装载时 checkRuntimeShape 就是这么调它的）',
    Array.isArray(runtime.prompt('')?.body) && runtime.prompt('').body.length === 2);

  // 命令处理函数。
  const commands = runtime.commandHandlers;
  ok('命令处理函数的键就是 names[0]（装载时两个方向对账）',
    Object.keys(commands ?? {}).sort().join(',') === '/掷骰,/跑团', JSON.stringify(Object.keys(commands ?? {})));

  const rollReceipt = await commands['/掷骰']({
    chatKey: key, senderId: '10001', text: '/掷骰 3d6', media: [], replyToMessageId: null
  });
  ok('/掷骰 直接给结果，并记进日志（零 LLM 成本的快路径）',
    /3d6 → \d\+\d\+\d/.test(rollReceipt) && /10001 掷/.test(status(key).log.at(-1).text), String(rollReceipt));

  ok('/掷骰 不带表达式时回用法（而不是静默）',
    /用法/.test(await commands['/掷骰']({ chatKey: key, senderId: '1', text: '/掷骰', media: [], replyToMessageId: null })));

  // 坏表达式**抛**出去 —— 外壳会把 message 原样发进群。
  let thrown = null;
  try {
    await commands['/掷骰']({ chatKey: key, senderId: '1', text: '/掷骰 2d6+1d4', media: [], replyToMessageId: null });
  } catch (error) { thrown = error; }
  ok('/掷骰 的非法表达式**抛出**（外层 runCommand 会把这句中文原样发进群）',
    thrown instanceof DiceError && /一次只能掷一组/.test(thrown.message), String(thrown?.message));

  ok('/跑团 给出状态卡', /《雾港》/.test(await commands['/跑团']({ chatKey: key, senderId: '1', text: '/跑团', media: [], replyToMessageId: null })));
}

// ── 5. 注册表接点 ───────────────────────────────────────────────────────────
{
  const entry = EXTRA_REGISTRY.find((item) => item.id === 'trpg');
  ok('trpg 注册在注册表里，是接管模式', !!entry && entry.mode === 'override');
  ok('默认关（重能力一律默认关：imageSource / transcription / imageGen 都是）',
    entry.defaultEnabled === false);
  ok('声明了发言工具名，且它真的在 tools 里（装配期强校验）',
    entry.overrideTools?.sendTool === 'say' && entry.tools.some((t) => t.name === 'say'));
  ok('finishTool 显式写 null（跑团没有收尾工具，框架段不提它）',
    entry.overrideTools?.finishTool === null);
  ok('7 个工具 + 2 条命令', entry.tools.length === 7 && (entry.commands ?? []).length === 2);

  // 真装载一次：声明与实现对得上（这是这套设计唯一的漂移点）。
  const runtime = createRuntime();
  const declared = entry.tools.map((t) => t.name).sort();
  const implemented = Object.keys(runtime.handlers).sort();
  ok('声明 ⇄ 实现逐个对上（少的 = 调得到却执行不了；多的 = 死代码）',
    JSON.stringify(declared) === JSON.stringify(implemented),
    `声明 ${declared.join(',')} / 实现 ${implemented.join(',')}`);
}

// ── 6. 端到端：真起 app，接管一个群，看模型实际收到什么 ──────────────────────
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

  const runOnce = async (key, text) => {
    model.script = [{ content: '（测试：这一轮不说话）' }];
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
    return model.requests[model.requests.length - 1];
  };

  const taken = await runOnce('group:701', '我们开跑吧');
  const toolNames = (taken?.tools ?? []).map((tool) => tool.function?.name);
  const systemText = String((taken?.messages ?? []).find((m) => m.role === 'system')?.content ?? '');

  ok('接管会话的模型请求真的发出去了（否则下面都是空转的绿）', !!taken && toolNames.length > 0);
  ok('**接管会话的工具表只剩跑团那 7 个**（内置 25 个全部让位）',
    JSON.stringify([...toolNames].sort()) === JSON.stringify(
      ['campaign_start', 'character_create', 'character_update', 'roll_dice', 'say', 'skill_check', 'story_update']
    ), JSON.stringify(toolNames));
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
  const plain = await runOnce('group:702', '在吗');
  const plainTools = (plain?.tools ?? []).map((tool) => tool.function?.name);
  const plainSystem = String((plain?.messages ?? []).find((m) => m.role === 'system')?.content ?? '');
  ok('**没被接管的群照常**：内置工具都在、跑团工具一个都没有',
    plainTools.includes('send_message') && plainTools.includes('finish')
    && !plainTools.includes('say') && !plainTools.includes('roll_dice'),
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

  // 接口层：面板那一页要看得见这个扩展，且如实标成接管模式。
  const listRes = await fetch(`http://127.0.0.1:${port}/api/extras`, { headers });
  const listBody = await listRes.json();
  const row = (listBody.extras ?? []).find((item) => item.id === 'trpg');
  ok('/api/extras 里看得见 trpg，标成 override、且 enabled 是从配置读出来的',
    listRes.status === 200 && row?.mode === 'override' && row?.enabled === true && !!row?.description,
    JSON.stringify(row));

  await core.stop();
}

process.exit(done() ? 0 : 1);
