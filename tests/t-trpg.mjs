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
// 而症状是"接管之后模型手里同时有跑团工具和一堆内置工具，人格指令却在叫它用 say"。
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { checker, dataDir, fakeModelServer, toolCall } from './lib/harness.mjs';
import { ROOT, load, stripComments } from './lib/src.mjs';

const DIR = dataDir('qqagent-trpg-');
const { ok, done } = checker();

// 上层一律走**桶文件**（`web/` 路由也是这么用的）；只有纯函数层 `rules/` 直接取内部实现 ——
// 那是它存在的意义（能脱离平台独立测试），也是这个套件大半断言的对象。
const {
  TrpgStore, appendLog, campaignFile, campaignSummary, clampInt, emptyCampaign, findCharacter, normalizeCampaign, text,
  formatCheck, formatRoll, renderForModel, renderForPlayers, renderStatusCard, describeStruct,
  renderBriefing, renderRuleNotes,
  createHandlers, createRuntime, saveScenario, scenarioNameFromFile,
  RuleStore, ScenarioStore, isFormattedScenario, parseScenario, saveScenarioText,
  formatScenarioText, stripFence, MODE_LABEL, TrpgModeStore, parseMode, TRPG_ASSISTANT_TOOLS, beginCampaign,
  JournalStore
} = await load('extra/trpg/index.js');
const { DiceError, looksLikeDiceRequest, rollDice } = await load('extra/trpg/rules/dice.js');
const { createLedger, consume, recall, refund, remember } = await load('extra/trpg/rules/economy.js');
const {
  compileRuleSet, describeMechanic, EMPTY_RULE_SET
} = await load('extra/trpg/rules/rule-set.js');
const { EXTRA_REGISTRY } = await load('extra/registry.js');
// P7 的抽取端口**不在桶里**（同 `scenario/extract/*`：内部实现，套件直接取）。
const { createAskPort } = await load('extra/trpg/scenario/extract/prompt.js');

/**
 * `text` → 该由哪个处理函数接手。
 *
 * `.trpg <子命令>` 展开后的键是**两截**（`'.trpg mode'`，见 `ExtraCommandSpec.subs`），
 * 所以先试前两个词、再退回第一个。**两条都要试**：`.r 3d6` 的键只有一截。
 */
function routeIn(commands) {
  return (text) => {
    const words = String(text).trim().split(/\s+/);
    const two = `${words[0]} ${words[1] ?? ''}`;
    return typeof commands[two] === 'function' ? two : words[0];
  };
}

/**
 * 调一条命令。
 *
 * 命令缺席时**返回一句话**而不是让 `undefined(...)` 抛出去：抛了会让整个套件在第一个用例处
 * **中止**，后面的断言从未运行（仓库里记过这个坑，报出来仍只是"这个套件失败了"）。
 */
function callIn(commands) {
  const route = routeIn(commands);
  return (text, chatKey, media = []) => {
    const key = route(text);
    if (typeof commands[key] !== 'function') return Promise.resolve(`（没有这条命令：${key}）`);
    return commands[key]({ chatKey, senderId: '10001', text, media, replyToMessageId: null });
  };
}

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

  // ── 报错的那一次**不占额度**（2026-10-19 补）──
  //
  // `consume` 排在参数校验之前（工具得先知道"这一轮还能不能动"才去干活），所以一次纯粹
  // 写错参数的调用会把那个角色这一回合的行动吃掉 —— 模型改正参数重来时拿到的是
  // 「这一轮已经行动过了」，血没掉、卡没改，而群里看不出发生了什么（实测过两次）。
  // 判据与"被闸门拒掉的那一次不占额度"是同一条：**没做成的事不该收费**。
  await call('character', ctx, { action: 'create', name: '教授', hpMax: 12 });
  const retryCtx = fakeCtx(key);
  const badUpdate = await call('character', retryCtx, {
    // 一次调用带两项，其中 `stats` 写坏了 —— 这正是人格段要求的写法（"要改好几项就一次给全"），
    // 所以这条路径不是边角料，而是最常见的那种。
    action: 'update', name: '教授', hpDelta: -5, stats: {}
  });
  ok('夹具：一次调用里带写坏的参数 → 报错',
    badUpdate.isError === true && /stats 是空的/.test(body(badUpdate)), body(badUpdate));
  const fixedUpdate = await call('character', retryCtx, { action: 'update', name: '教授', hpDelta: -5 });
  ok('**改正参数重来就能成**（报错的那次没把这一回合的行动吃掉）',
    !fixedUpdate.isError && status(key).characters.at(-1).hp === 7, body(fixedUpdate));
  ok('负对照：**成功**的那一次照常占额度（同一个 ctx 再改一次还是被拒）',
    /这一轮已经行动过了/.test(body(await call('character', retryCtx, { action: 'update', name: '教授', hpDelta: -1 }))));

  const rerollCtx = fakeCtx(key);
  const badRoll = await call('roll', rerollCtx, { expr: '3d6x', actor: '教授' });
  ok('夹具：写错的骰子表达式（带 actor）也报错',
    badRoll.isError === true && /骰子表达式/.test(body(badRoll)), body(badRoll));
  // ⚠️ 判据不能只看 `isError`：被配额拦下时 `gate` 回的是 `ok(blocked)`（**不是** error），
  // 所以"没报错"在"被拦住"时也成立 —— 那样写是一条假绿（第一版就是这么写的）。
  const fixedRoll = await call('roll', rerollCtx, { expr: '1d100', target: 45, actor: '教授' });
  ok('`roll` 同理：改正表达式重掷就掷得出来（解析失败的那一次不占额度）',
    !fixedRoll.isError && /｜ 对 45 →/.test(body(fixedRoll)) && !/已经行动过/.test(body(fixedRoll)),
    body(fixedRoll));

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
  // ⚠️ `actionSource` 是**自由文本、声明即接受** —— 代码判不了"规则书允不允许这个来源"
  // （规则表里没有那一栏）。所以至少要**留痕**（2026-10-19）：事后有人问"他为什么这一回合
  // 动了两次"，翻得到那一行。留痕本身是 `visible:false`（战报要发进群）。
  //
  // ⚠️ 必须**带 `actor`**：不带 actor 的 `roll` 不占配额（`quota: Boolean(actor)`），
  // 也就不走"额外行动"那条账 —— 拿它去验留痕只会验到一个空转。
  await call('roll', fakeCtx(key), { expr: '1d20', actor: '阿飞', actionSource: 'multiattack' });
  const extraLogged = (status(key)?.log ?? []).find((entry) => entry.text.startsWith('额外行动：'));
  ok('声明了 `actionSource` 会在日志里留一条（含来源与行动者）',
    extraLogged?.text === '额外行动：multiattack（阿飞）' && extraLogged?.visible === false,
    JSON.stringify(extraLogged));
  ok('那条留痕**不进战报**（战报是发进群的文件，额外行动是 DM 的记账）',
    !new JournalStore().read(key).some((entry) => entry.text.startsWith('额外行动：')),
    JSON.stringify(new JournalStore().read(key).map((entry) => entry.text)));
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
  // 与 `checkRuntimeShape` 的装载期对账同一条判据：**声明 ⇄ 实现两个方向逐个相等**。
  // 从注册表取声明、从 `createRuntime()` 取实现 —— 两边各改一处而漏掉另一处的表现是
  // "命令敲下去没有任何反应"，而那是装配期就会拒绝装载的（这里只是提前钉住）。
  // ⚠️ **要展开 `subs`**：带 subs 的声明自己不占 `names[0]`，真正会被匹配的是
  // `<命令> <子命令>` 那些串（见 `ExtraCommandSpec.subs`）。不展开的话这条断言会把
  // 正确的实现判成"实现了却没声明"。
  const declaredCommands = (EXTRA_REGISTRY.find((item) => item.id === 'trpg')?.commands ?? [])
    .flatMap((spec) => (spec.subs?.length
      ? spec.subs.map((sub) => `${spec.names[0]} ${sub}`)
      : [spec.names[0]]));
  ok('命令处理函数的键就是 names[0]（装载时两个方向对账）',
    Object.keys(commands ?? {}).sort().join(',') === [...declaredCommands].sort().join(','),
    JSON.stringify(Object.keys(commands ?? {})));

  const rollReceipt = await commands['.r']({
    chatKey: key, senderId: '10001', text: '.r 3d6', media: [], replyToMessageId: null
  });
  ok('.r 直接给结果，并记进日志（零 LLM 成本的快路径）',
    /3d6 → \d\+\d\+\d/.test(rollReceipt) && /10001 掷/.test(status(key).log.at(-1).text), String(rollReceipt));

  const multiReceipt = await commands['.r']({
    chatKey: key, senderId: '1', text: '.r 2d6+1d4', media: [], replyToMessageId: null
  });
  ok('.r 也认得新文法（多组相加不再报错）', /2d6\+1d4 →/.test(multiReceipt), String(multiReceipt));

  ok('.r 不带表达式时回用法（而不是静默）',
    /用法/.test(await commands['.r']({ chatKey: key, senderId: '1', text: '.r', media: [], replyToMessageId: null })));

  // 坏表达式**抛**出去 —— 外壳会把 message 原样发进群。
  let thrown = null;
  try {
    await commands['.r']({ chatKey: key, senderId: '1', text: '.r 3d6+', media: [], replyToMessageId: null });
  } catch (error) { thrown = error; }
  ok('.r 的非法表达式**抛出**（外层 runCommand 会把这句中文原样发进群）',
    thrown instanceof DiceError && /骰子表达式/.test(thrown.message), String(thrown?.message));

  const statusReceipt = await commands['.trpg status']({
    chatKey: hideKey, senderId: '1', text: '.trpg status', media: [], replyToMessageId: null
  });
  ok('.trpg status 给的是**玩家视角**：藏起来的人与暗线旗标都不出现',
    /《暗涌》/.test(statusReceipt) && !/线人/.test(statusReceipt) && !/真凶是医生/.test(statusReceipt),
    String(statusReceipt).slice(0, 200));
}

// ── 4b. 剧情结构的一行式概览（`describeStruct`，P7-a）──────────────────────
//
// 抽出来的结构躺在 `.struct.json` 里，而 DM 每轮只看到**压缩过的**正文 —— 这一行式概览是
// "抽取到底有没有用"的唯一出口。它不进上下文，那这份结构等于没抽，而且**不会有任何报错**。
//
// 三条判据各自对应一种"安静地坏掉"：
//   ① 空结构必须返回**空串**（调用方靠它决定印不印）。返回一段光秃秃的标题会让每一次
//      "没抽到东西"的开局都多一截噪音，而噪音是每轮都进 system prompt 的成本。
//   ② 每一类有**条数上限**，截掉几条要说出来 —— 静默截断的表现是"抽出来的比原文里有的少"。
//   ③ 待核项那一句是**说给模型听的**：它不知道该核对什么，但"有些条目没核对上"这件事
//      直接决定它敢不敢把某条当硬规则用。**逐条列是 `.trpg check` 的活**，这里只给计数。
{
  const structOf = (over = {}) => ({
    summary: '', scenes: [], npcs: [], clues: [], items: [], mechanics: [], warnings: [], ...over
  });

  ok('空结构 → 空串（调用方靠它决定印不印）',
    describeStruct(structOf()) === '');
  ok('只有待核项、一条内容都没有 → 也是空串（"没抽到东西"与"抽到了但有疑问"是两件事）',
    describeStruct(structOf({ warnings: ['第 1 片没抽出来：超时'] })) === '');

  const rich = describeStruct(structOf({
    summary: '废弃灯塔与守夜人',
    scenes: [{ name: '灯塔', summary: '一层门厅', npcs: ['守夜人'], clues: ['缺页的航海日志'] }],
    npcs: [{ name: '守夜人', summary: '话少', attitude: '敌意', location: '灯塔', discovered: true }],
    clues: [{ text: '缺页的航海日志', visible: true, location: '灯塔' }],
    items: [{ name: '铜钥匙', summary: '', location: '灯塔' }],
    mechanics: [{
      type: 'check_modifier', triggerText: '在灯塔里', effectText: '侦察 -20',
      note: '浓雾', sourceQuote: '雾里什么都看不清'
    }]
  }));
  ok('每一类各印一行，首行说明它是"按它来铺"的',
    /^【剧情结构】（从剧本原文里抽出来的，按它来铺）/.test(rich), rich);
  ok('概要 / 场景（带在场与线索）/ NPC（带态度与位置）/ 线索 / 道具逐类印出来',
    /概要：废弃灯塔与守夜人/.test(rich)
    && /场景（按顺序）：灯塔（在场：守夜人，线索：缺页的航海日志）/.test(rich)
    && /NPC：守夜人（敌意，灯塔）/.test(rich)
    && /线索：缺页的航海日志/.test(rich)
    && /道具：铜钥匙（灯塔）/.test(rich), rich);
  ok('机制印成"当 X 时，Y（类型）"（X 来自 `triggerText`，Y 优先取 `effectText`）',
    /特殊机制（检定与伤害要照它来）：当在灯塔里时，侦察 -20（check_modifier）/.test(rich), rich);
  ok('机制没有 `triggerText` 时**不印那个半截从句**（"当…时，"后面空着比没有更难看）',
    /特殊机制（检定与伤害要照它来）：浓雾（narrative_hook）$/.test(describeStruct(structOf({
      mechanics: [{ type: 'narrative_hook', triggerText: '', effectText: '', note: '浓雾', sourceQuote: '' }]
    }))));

  // 上限与边界。这一段**每轮都进 system prompt**，所以上限是成本不是洁癖。
  const tenClues = (count) => structOf({
    clues: Array.from({ length: count }, (_unused, index) => ({ text: `线索${index + 1}`, visible: true, location: '' }))
  });
  ok('每一类封顶 8 条，**截掉几条要说出来**（静默截断的表现是"抽出来的比原文里有的少"，一处线索都没有）',
    /线索：线索1；线索2；线索3；线索4；线索5；线索6；线索7；线索8（还有 2 条）$/.test(describeStruct(tenClues(10))),
    describeStruct(tenClues(10)));
  ok('正好 8 条时**不印**"还有 0 条"（边界；写错会多一句永远为 0 的话）',
    !/还有 0 条/.test(describeStruct(tenClues(8))) && /线索8$/.test(describeStruct(tenClues(8))),
    describeStruct(tenClues(8)));

  ok('场景没有名字时退回 `summary`（模型偶尔只给一句描述）',
    /场景（按顺序）：一层门厅$/.test(describeStruct(structOf({
      scenes: [{ name: '', summary: '一层门厅', npcs: [], clues: [] }]
    }))));
  ok('道具没有位置时只印名字（不印一个空的括号）',
    /道具：铜钥匙$/.test(describeStruct(structOf({ items: [{ name: '铜钥匙', summary: '', location: '' }] }))));

  const warned = describeStruct(structOf({
    summary: 'x',
    warnings: ['第 1 条机制的引文在原文里找不到：雾里什么都看不清', '第 2 片没抽出来：超时']
  }));
  ok('待核项给的是**计数 + 该怎么对待**（"别当成板上钉钉的设定"是说给模型听的）',
    /（有 2 条抽取结果没核对上，仅供参考 —— 别把它们当成板上钉钉的设定）$/.test(warned), warned);
  ok('待核项**不逐条列**（逐条列是 `.trpg check` 的活；这里每轮进提示词，逐条列会吃掉预算）',
    !/雾里什么都看不清/.test(warned) && !/超时/.test(warned), warned);

  // 顺序即缓存：这一段每轮都进 system prompt，同一份结构两次渲染抖一个字符就整段前缀失效。
  ok('同一份结构渲染两次逐字相同（纯代码、确定性）',
    describeStruct(structOf({
      npcs: [{ name: '守夜人', summary: '', attitude: '', location: '', discovered: true }]
    })) === describeStruct(structOf({
      npcs: [{ name: '守夜人', summary: '', attitude: '', location: '', discovered: true }]
    })));
}

// ── 4c. 这一局的特殊规则进提示词（`renderRuleNotes`，P7-e）──────────────────
//
// `rules/rule-set.ts` 已经把模组自己的机制编译成**真的会参与判定**的东西（`roll` / `.ra` / `.rh`
// 的目标值会被它改），可 DM **看不到它改了什么** —— 它只知道"点数对不上"。这一节就是把机制
// 摊平给 DM 看，走 `renderBriefing` 的中间段（**不进 `campaign.log` 那 60 条上限**）。
//
// 三条判据各自对应一种"安静地坏掉"：
//   ① **三档不能合并**：`undefined`（这一局没有规则集）/ `null`（读不出来）/ 一份集合。
//      合并之后每一个还没开团的会话都会拿到一句"规则扩展坏了"（写这一节时真的这么写过一次）。
//   ② **判定的那几条一条都不许截断** —— 机制少一条意味着"目标值被改了而 DM 不知道为什么"，
//      而 `describeStruct` 那边每类封顶 8 条是对的（少一条线索只是少点风味）。两条相反。
//   ③ 每一条都走 `describeMechanic`（与三条工具的回执同一份）—— 各拼一遍必然漂移，
//      而"回执里说的"与"提示词里说的"对不上时，没有任何人会去核对。
{
  const compiled = (mechanics) => {
    const made = compileRuleSet({ version: 1, mechanics });
    if (!made.ok) throw new Error(`夹具编译不过：${made.problems.join('；')}`);
    return made.set;
  };
  const fog = {
    type: 'check_modifier', note: '灯塔的浓雾',
    trigger: { op: 'scene', value: '灯塔' },
    effect: { handler: 'penalty_to_check', params: { value: 20 } },
    sourceQuote: '浓雾里看不远'
  };
  const cold = {
    type: 'narrative_hook', note: '海风很冷',
    trigger: { op: 'scene', value: '码头' },
    effect: { handler: 'narrate', params: {} },
    sourceQuote: '风从海上灌进来'
  };

  ok('空集 → 空串（"没有特殊规则"与"这一局没有规则集"对模型是同一件事）',
    renderRuleNotes(EMPTY_RULE_SET) === '', renderRuleNotes(EMPTY_RULE_SET));
  ok('`null` → 一句"读不出来"（那时每一次检定都会报错，不说的话 DM 只会以为工具坏了）',
    /^【这一局的特殊规则】读不出来/.test(renderRuleNotes(null))
    && /检定与先攻都会报错/.test(renderRuleNotes(null)),
    renderRuleNotes(null));

  const notes = renderRuleNotes(compiled([fog]));
  ok('首行说明这是"这一本模组自己的规矩"',
    /^【这一局的特殊规则】（这一本模组自己的规矩，判定照它来）/.test(notes), notes);
  ok('每一条判定的机制各占一行，且那一行**逐字就是** `describeMechanic`（与三条工具的回执同一份）',
    notes.split('\n')[1] === `· ${describeMechanic(compiled([fog]).mechanics[0])}`
    && /· 灯塔的浓雾（check_modifier \/ 场景：灯塔）/.test(notes), notes);

  const mixed = renderRuleNotes(compiled([fog, cold]));
  ok('不参与判定的（`narrate`）并进"按叙事处理"那一行，**不单独占一条**'
    + '（单独列会让 DM 以为它也算数）',
    mixed.includes('按叙事处理：') && /海风很冷/.test(mixed)
    && mixed.split('\n').filter((line) => line.includes('海风很冷')).length === 1
    && mixed.split('\n').filter((line) => line.startsWith('· ')).length === 2, mixed);

  // ⚠️ 这一条是**反方向**的对照：`describeStruct` 每类封顶 8 条，这里一条都不许封。
  const many = Array.from({ length: 10 }, (_unused, index) => ({
    ...fog, note: `机制${index + 1}`, trigger: { op: 'scene', value: `场景${index + 1}` }
  }));
  const manyNotes = renderRuleNotes(compiled(many));
  ok('**判定的机制一条都不截断**（10 条全在）—— 少一条 = 目标值被改了而 DM 不知道为什么',
    manyNotes.split('\n').filter((line) => line.startsWith('· ')).length === 10
    && /机制10（check_modifier \/ 场景：场景10）/.test(manyNotes), manyNotes);

  const warned = renderRuleNotes(compiled([{ ...cold, type: 'weather_effect' }]));
  ok('降级的账要如实说出去（认不出的 type → 按叙事处理），并指向 `.trpg check` 看是哪几条',
    /有 1 条机制没能编译成判定/.test(warned) && /\.trpg check/.test(warned), warned);
  // ⚠️ 措辞的判据（P7-f 修）：认不出的 `type` **降级成了 `narrate`、确实在集合里**（上面那行
  // "按叙事处理"里就有它），所以只能说它"没能编译成**判定**"，不能说"没编译**进来**"。
  // 四种 warning 里只有"超过 `MAX_MECHANICS`"那一种是真的没进集合。
  ok('那句话说的是"没能编译成判定"而不是"没编译进来" —— 降级的那条**就在集合里**，'
    + '说成"没进来"是字面假话，而模型正是照它判断该不该认那条设定',
    warned.includes('按叙事处理：') && warned.includes('海风很冷')
    && !warned.includes('没编译进来'), warned);

  ok('同一份规则集渲染两次逐字相同（纯代码、确定性；它每轮都进 system prompt，抖一个字符就整段前缀失效）',
    renderRuleNotes(compiled([fog, cold])) === renderRuleNotes(compiled([fog, cold])));

  // ── 接进中间段：三档的区别**必须**体现在 `renderBriefing` 上（那才是模型真正看到的东西）──
  const camp = emptyCampaign('group:0', { title: 'T', system: '', rule: 'generic' });
  const brief = (set) => renderBriefing(camp, {
    scenarios: [], rules: [], ...(set === undefined ? {} : { set })
  });
  ok('⚠️ 调用方**没给** `set`（还没开局）→ 一个字都不印'
    + '（写成 `set ?? null` 会让每一个还没开团的会话都拿到一句"规则扩展坏了"）',
    !brief(undefined).includes('这一局的特殊规则'), brief(undefined));
  ok('`set: null`（有战役、但那份规则扩展读不出来）→ 印"读不出来"',
    brief(null).includes('读不出来'), brief(null));
  ok('`set: EMPTY_RULE_SET` → 也不印（与"这一局没有扩展"是同一个意思）',
    !brief(EMPTY_RULE_SET).includes('这一局的特殊规则'), brief(EMPTY_RULE_SET));
  const briefed = brief(compiled([fog]));
  ok('有机制 → 印出来，且排在剧本正文/结构**之后**（它与正文同稳定度，都在状态之前）',
    briefed.includes('· 灯塔的浓雾（check_modifier / 场景：灯塔）')
    && briefed.indexOf('【剧本与规则】') < briefed.indexOf('【这一局的特殊规则】'), briefed);
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

  // ── 抽取产物的三站通路：落盘 → 快照 → 中间段（P7-a）──
  //
  // 抽出来的结构要真的走到 DM 眼前，得经过三站：`writeExtras` 落盘 → `beginCampaign` 抄进快照
  // → `renderBriefing` 印进中间段。**任何一站断了都不会报错**：`.struct.json` 安安静静躺在
  // 磁盘上、工作台里也看得见，而 DM 手里的提示词一个字都没有 —— 那正是"抽了半天没人用"的样子。
  // 所以三站各钉一条，另配一条"快照不是引用"的对照（与上面 `灯塔` 那组同形）。
  const SNAP_STRUCT = {
    summary: '灯塔与守夜人',
    scenes: [{ name: '灯塔', summary: '', npcs: ['守夜人'], clues: [] }],
    npcs: [{ name: '守夜人', summary: '', attitude: '敌意', location: '灯塔', discovered: true }],
    clues: [], items: [], mechanics: [], warnings: []
  };
  scenarios.write('结构团', '---\ntitle: 结构团\n---\n正文一句。');
  ok('伴生文件写得进去（`.md` 已经是好的，写伴生是第二步；写失败也不回滚 `.md`）',
    scenarios.writeExtras('结构团', {
      struct: SNAP_STRUCT,
      ruleExt: { version: 1, mechanics: [], warnings: [] },
      raw: [{ heading: '一', text: '原文第一片' }, { heading: '二', text: '原文第二片' }]
    }).ok === true);

  const snapStart = begin('group:937', { scenario: '结构团' });
  ok('开局把结构**抄进快照**（`campaign.scenario.struct`）',
    snapStart.isError !== true && store.read('group:937')?.scenario?.struct?.summary === '灯塔与守夜人',
    String(snapStart.content));
  ok('规则扩展也一起进快照（P7-c 的产物在 P7-a 先把通路铺好）',
    store.read('group:937')?.scenario?.ruleExt?.version === 1,
    JSON.stringify(store.read('group:937')?.scenario?.ruleExt));
  ok('原文切片只留**计数**进快照（正文一个字都不进 —— 它每轮进 system prompt）',
    scenarios.read('结构团').scenario.rawParts === 2,
    String(scenarios.read('结构团').scenario.rawParts));
  ok('工作台列表也认得出这一份有结构、有几片原文（`.trpg check` 与设置页读的是同一份数据）',
    scenarios.list().find((item) => item.id === '结构团')?.hasStruct === true
    && scenarios.list().find((item) => item.id === '结构团')?.rawParts === 2,
    JSON.stringify(scenarios.list().find((item) => item.id === '结构团')));

  const snapBody = runtime.prompt('group:937')?.body ?? [];
  ok('结构并进**中间那一段**，不是新开一段（`body` 恒为 3 段；段数飘忽就没法断言）',
    snapBody.length === 3, JSON.stringify(snapBody.map((part) => part.slice(0, 24))));
  ok('DM 的提示词里真的印着【剧情结构】与它抽出来的人',
    /【剧情结构】（从剧本原文里抽出来的，按它来铺）/.test(snapBody[1] ?? '')
    && /NPC：守夜人（敌意，灯塔）/.test(snapBody[1] ?? ''),
    (snapBody[1] ?? '').slice(-500));
  ok('段内顺序：正文在前、结构紧跟其后（两者同稳定度，一起排在状态段之前才能命中前缀缓存）',
    (snapBody[1] ?? '').indexOf('正文一句。') >= 0
    && (snapBody[1] ?? '').indexOf('正文一句。') < (snapBody[1] ?? '').indexOf('【剧情结构】'));
  ok('原文切片**不进提示词**（它只保底给人看；进了就等于每轮把整份模组塞进上下文）',
    !/原文第一片/.test(snapBody[1] ?? '') && !/原文第二片/.test(snapBody[1] ?? ''));

  // 快照的对照断言：改掉**伴生文件**，正在跑的团一个字都不变（与 `灯塔` 那组同形，
  // 但这里改的是 `.struct.json` 而不是 `.md` —— 它是另一条缓存路径，见 `#signature`）。
  scenarios.writeExtras('结构团', { struct: { ...SNAP_STRUCT, summary: '改过的' } });
  ok('改了结构文件之后，已经开着的那一局逐字不变（快照，不是引用）',
    store.read('group:937')?.scenario?.struct?.summary === '灯塔与守夜人'
    && /概要：灯塔与守夜人/.test(runtime.prompt('group:937')?.body[1] ?? ''));
  ok('但**新开**的一局用的是改过之后的那一版（手改 `.struct.json` 不重启也生效）',
    begin('group:938', { scenario: '结构团' }).isError !== true
    && /概要：改过的/.test(runtime.prompt('group:938')?.body[1] ?? ''),
    (runtime.prompt('group:938')?.body[1] ?? '').slice(-400));

  ok('手写的剧本（一个伴生都没有）不印结构小节（这是绝大多数剧本的正常状态）',
    !/【剧情结构】/.test(runtime.prompt('group:930')?.body[1] ?? ''));

  scenarios.write('坏结构团', '---\ntitle: 坏结构团\n---\n正文。');
  scenarios.writeExtras('坏结构团', { struct: '这不是一个对象' });
  ok('结构文件坏了不掀翻剧本：照样开得了局，但对模型**沉默**（它没法修，印一句"结构坏了"只会让它以为这一局缺了东西）',
    begin('group:939', { scenario: '坏结构团' }).isError !== true
    && !/【剧情结构】/.test(runtime.prompt('group:939')?.body[1] ?? ''),
    (runtime.prompt('group:939')?.body[1] ?? '').slice(-300));

  // ── `.trpg new` 命令：与工具共用同一个实现（P2 起建局归 new，start 只推状态） ──
  const commands = runtime.commandHandlers;
  const at = (text, key) => callIn(commands)(text, key);
  const cmd = (text, key = 'group:940') => at(text, key);
  const opened = await cmd('.trpg new 灯塔');
  ok('`.trpg new <剧本>` 真的开了一局，且与工具注入的东西一致',
    /剧本「灯塔」已注入/.test(String(opened)) && store.read('group:940').title === '改过的'
    && store.read('group:940').scenario.id === '灯塔', String(opened));
  ok('新建的一局停在 **`preparing`**（等人报名/建卡/确认），而且发起人自动进了名单',
    store.read('group:940').status === 'preparing'
    && JSON.stringify(store.read('group:940').players) === JSON.stringify(['10001']),
    JSON.stringify([store.read('group:940').status, store.read('group:940').players]));
  ok('回执说清了下一步是 `.trpg join` / `.pc new` / `.trpg start`（不是让模型去建卡）',
    /\.trpg join/.test(String(opened)) && /\.pc new/.test(String(opened)), String(opened));
  // 不带名字 = **选剧本这一步**：列出可选的，再给用法（不是一句干巴巴的"用法"）。
  ok('`.trpg new` 不带名字时列出可选的剧本（而不是静默、也不是光一句"用法"）',
    /用法：/.test(String(await cmd('.trpg new', 'group:943')))
    && /剧本库里/.test(String(await cmd('.trpg new', 'group:943'))), String(await cmd('.trpg new', 'group:943')));
  // 认不出来的子命令落到**裸 `.trpg`** 上（它排在所有子命令之后）。
  // **不能静默忽略** —— 那样群友只会看到一张状态卡，不知道自己敲的那条为什么没生效。
  const stray = String(await at('.trpg 乱写', 'group:940'));
  ok('**认不出的子命令落到裸 `.trpg` 上**，回一张命令清单（不默默当成某一个）',
    /这几条各自是一条命令/.test(stray) && /\.trpg new/.test(stray), stray);
  ok('**子命令优先于裸命令**（顺序即行为）：`.trpg end` 走的是收团，不是被裸命令吃掉',
    /收团|没有在进行中的团/.test(String(await cmd('.trpg end', 'group:944'))),
    String(await cmd('.trpg end', 'group:944')));
  ok('`子命令` 那个词本身也能当参数用（`.trpg new status` 是"开一局叫 status 的团"）',
    !/这几条各自是一条命令/.test(String(await cmd('.trpg new status', 'group:942'))));
  ok('.trpg status 不带参数时仍是玩家视角的状态卡（**原语义一个字没变**）',
    /【跑团笔记】/.test(String(await at('.trpg status', 'group:930')))
    && !/线人/.test(String(await at('.trpg status', 'group:907'))));

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

  // ── `/剧本`：群友引用一份文件把它收进剧本库 ──
  //
  // 下载那一步（`safeFetchBinary`）要发网络请求，所以这里只测**它前后两半**：
  // 前半是"从 media 里认不认得出那个文件"（早退分支，不用网络），后半是"拿到文本之后怎么办"
  // （`saveScenarioText`，纯函数）。中间那两步（下载、抽字节）在别处守着 —— 抽取那一条在
  // `t-document.mjs`，它自带的假子进程让它能在不启动解释器的前提下跑。
  const fileEntry = (over = {}) => ({
    kind: 'file', name: 'test.md', file: 'test.md',
    fileId: 'd5df8391f95b09df4de35ea1c783c368_f14a71fa-c936-11f1-ad09-6dfb0de8648e',
    size: 4, url: 'http://180.101.246.192:80/asn.x', ...over
  });
  const save = (media, name, key = 'group:950') => commands['.trpg scenario']({
    chatKey: key, senderId: '10001', text: `.trpg scenario ${name}`, media, replyToMessageId: null
  });

  // 不带名字时：引用了文件就用文件名当名字（那条路会真的去下载，所以放在下面那个带回环服务的
  // 段里测），**没引用文件就是列出剧本库**。这里只测后一路。
  ok('没引用文件、又没给名字 → 列出剧本库，并说清"怎么再传一份"',
    /剧本库里/.test(String(await save([], ''))) && /(引用它敲|要再加一份)/.test(String(await save([], ''))));
  ok('引用的那条里没有文件 → 明说 + 回用法（不是一句"失败"）',
    /没有文件/.test(String(await save([], '甲'))) && /用法/.test(String(await save([], '甲'))));
  ok('有文件但协议端没给 url → 明说"只给了 file_id"并给出两条替代路（贴正文 / 直接放目录）',
    /没给下载地址/.test(String(await save([fileEntry({ url: undefined })], '甲')))
    && /data\/trpg\/scenarios/.test(String(await save([fileEntry({ url: undefined })], '甲'))));

  // 后半：**文本** → 落库（`saveScenarioText`，同步纯函数）。
  //
  // ⚠️ **"字节 → 文本"这一步不在这里测**了：它 2026-10-16 搬到了通用能力 `media/document/`
  // （四种格式一个 Python worker），要起子进程 —— 而本套件的规矩是不启动任何解释器。
  // 搬走时一起带走的是**那三条编码判据**（空字节、U+FFFD 绝对量+占比、编码阶梯），
  // 它们现在由 `t-document.mjs` 守着（对 `document_extract.py` 做源级断言 + 对 Node 侧的
  // 错误透传做行为断言）。这一层从此只收 `DocumentText`，所以它又能纯着测了。
  const doc = (text, over = {}) => ({ format: 'text', text, chars: text.length, truncated: false, ...over });

  const FM = (title, body) => `---\ntitle: ${title}\n---\n${body}`;

  ok('正常文本能落库（含 frontmatter）',
    saveScenarioText('上传的', doc(FM('传上来的', '正文')), scenarios).ok === true
    && scenarios.read('上传的').scenario.title === '传上来的');

  ok('抽取器截断过的正文**当场拒**（截断 = 人还能改的时候不说、跑起来才少半段）',
    /太长/.test(saveScenarioText('截断的', doc('正文', { chars: 99999, truncated: true }), scenarios).message ?? ''));

  ok('对照：没被截断的正文照常落库（上一条才不是假绿）',
    saveScenarioText('短的', doc(FM('短的', '正文')), scenarios).ok === true);

  ok('落库失败（正文超过单份剧本的上限）时把原因原样带回',
    /太长/.test(saveScenarioText('超长', doc(FM('x', '字'.repeat(5000))), scenarios).message ?? ''));

  // ── 格式匹配 → 不合规才让模型整理 ────────────────────────────────────────
  //
  // 判据是**确定性**的（有没有 frontmatter、能不能解析），所以"格式本来就对"的文件
  // **一次模型调用都不发** —— 那是这条命令的快路径，也是这一段最要紧的断言：
  // 把判据写反（`!isFormattedScenario`）会让每一份剧本都白烧一次调用，而没有任何东西会红。
  const PLAIN = '这座灯塔三年前就废弃了。守塔人换了三任。';
  const FORM = '---\ntitle: 灯塔\nscene: 码头\n---\n正文';

  ok('裸正文**不是**规定格式 —— 虽然 `parseScenario` 照样收得下它（那是给手写 .md 留的宽容口子，不是"格式匹配成功"）',
    isFormattedScenario(PLAIN) === false && parseScenario(PLAIN, 'x').ok === true);
  ok('有闭合 frontmatter 且能解析 → 是规定格式', isFormattedScenario(FORM) === true);
  ok('有 frontmatter 但里面 JSON 写坏 → **不是**规定格式（这一类模型修得了，所以要走整理）',
    isFormattedScenario('---\ntitle: x\nflags: {坏的\n---\n正文') === false);
  ok('frontmatter 没闭合 → 不是规定格式', isFormattedScenario('---\ntitle: x\n正文') === false);

  ok('模型套的代码块被剥掉（提示词说了不要套，而它经常套 —— 留着会让正文以 ``` 开头）',
    stripFence('```markdown\n' + FORM + '\n```') === FORM
    && stripFence(FORM) === FORM
    && stripFence('以下是整理结果：\n```\n' + FORM + '\n```') === FORM);

  {
    const model = await fakeModelServer({ model: 'stub-format' });
    const { updateConfig } = await load('core/config.js');
    updateConfig({ api: { baseUrl: model.url, model: 'stub-format' } });

    model.script = [{ content: FORM }];
    const hit = await formatScenarioText(PLAIN, { name: '灯塔', source: 'PDF' });
    ok('模型整理成功 → 返回的是**规定格式**的文本（后置条件）',
      hit.ok === true && isFormattedScenario(hit.text, '灯塔'), JSON.stringify(hit));
    const asked = String(model.requests[0]?.messages?.find((m) => m.role === 'user')?.content ?? '');
    ok('请求里带上了原文、剧本名、来源格式与**动态传进去的字数上限**（不是提示词里写死的字面量）',
      asked.includes(PLAIN) && asked.includes('灯塔') && /PDF/.test(asked) && /最多 \d+ 字/.test(asked),
      asked.slice(-200));

    model.script = [{ content: '抱歉，我做不到。' }];
    const bad = await formatScenarioText(PLAIN, { name: '灯塔', source: '文本' });
    ok('模型没按格式输出时**如实失败** —— 而不是把一份没有骨架的东西当剧本落库（那会变成"开局了但什么都没注入"）',
      bad.ok === false && /不是剧本格式/.test(bad.message), JSON.stringify(bad));

    updateConfig({ api: { baseUrl: 'http://127.0.0.1:1/', model: 'nope' } });
    const down = await formatScenarioText(PLAIN, { name: 'x', source: '文本' });
    ok('模型调不通时给一句可读的失败（不抛、也不假装成功）',
      down.ok === false && /出错/.test(down.message), JSON.stringify(down));
  }

  // ── `/剧本` 的完整那条路（回环下载 + 两个注入点）────────────────────
  //
  // 两件本机测不了的事都在这里被换掉：起 Python 抽文本、以及可能的那次模型调用。
  // 换掉它们**不是**在验假货 —— 验的是这一段真正的逻辑：**什么时候该调模型**。
  {
    const payload = Buffer.from('随便什么字节，抽取被换掉了');
    const server = http.createServer((_req, res) => { res.writeHead(200); res.end(payload); });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/f.md`;

    const { updateConfig, getConfig } = await load('core/config.js');
    const before = getConfig().security?.allowPrivateImageHosts;
    updateConfig({ security: { allowPrivateImageHosts: true } });
    try {
      const model = await fakeModelServer({ model: 'stub-format2' });
      updateConfig({ api: { baseUrl: model.url, model: 'stub-format2' } });
      const media = [{ kind: 'file', name: 'f.md', file: 'f.md', url }];
      const saves = new ScenarioStore(path.join(DIR, 'scenarios-fmt'));
      const extract = (text) => async () => ({ format: 'text', text, chars: text.length, truncated: false });
      // P7-a 之后 `usedModel` 那条路**先走抽取管线**，`format` 是它的后备。下面三条验的正是
      // 后备那条路，所以注入一个"必定失败"的管线 —— 于是它们逐字照旧（一次调用、同样的文案）。
      // **不注入的话它们会变成假绿**：管线会真的去调那个假端点，而它的脚本是消耗式的。
      const noPipeline = async () => ({ ok: false, message: '（本用例验的是后备那条路）' });

      model.requests = [];
      model.script = [{ content: '这条不该被用到' }];
      const fast = await saveScenario({ media }, '现成的', saves, { extract: extract(FORM) });
      ok('格式本来就对 → **一次模型调用都不发**（快路径；判据写反的话每条都会白烧一次，而没有任何东西会红）',
        model.requests.length === 0 && /已存剧本「现成的」/.test(fast) && !/模型整理/.test(fast), fast);
      // 回执末尾那句"下一步敲什么"是**用户可见**的，而且它跟着命令一起改过名 ——
      // 漏改的表现是**机器人教群友敲一条不存在的命令**，不会有任何报错。
      // ⚠️ 正确词形是 `.trpg new <名字>`：`.trpg start` **不带参数**（它只把 `preparing`
      // 推到 `active`），照抄 `start` 的话群友敲下去只会拿到一句用法提示。
      ok('回执末尾给的是**当前面**的开局命令（`.trpg new <名字>`，不是作废的 `/跑团 开局`，也不是 `.trpg start`）',
        /开局：\.trpg new 现成的/.test(fast) && !/开局：\.trpg start/.test(fast)
        && !/跑团 开局|\/开局/.test(fast), fast);

      model.requests = [];
      model.script = [{ content: '```markdown\n' + FORM + '\n```' }];
      const viaModel = await saveScenario({ media }, '整理过的', saves,
        { extract: extract(PLAIN), analyze: noPipeline });
      ok('格式不对 + 管线没成 → 退回让模型整理一次，落库的是**模型给的版本**（不是原文）',
        model.requests.length === 1 && saves.read('整理过的').scenario.title === '灯塔', viaModel);
      ok('回执里点明"让模型整理过"（它同时解释了两件事：回执为什么慢、内容为什么被重排过）',
        /已让模型整理/.test(viaModel) && /原文 20 字/.test(viaModel), viaModel);
      // ⚠️ 只印「文本」两个字时，同一批上传里对不上是哪一份（`文本` 既可能是这份 `.md`、
      // 也可能是随手贴的一段设定），而回执是管理员唯一的凭据 —— 所以来源那一栏要带**文件名**。
      ok('来源那一栏带上**文件名**（光印格式名的话，管理员对不上自己刚发的是哪一份）',
        /（来源 文本「f\.md」）/.test(viaModel), viaModel);
      // 对照：没有名字时**不硬凑** —— 否则回执上会印出「（没有名字的文件）」这种把兜底话术
      // 当文件名的东西，而那是 `openScenario` 给"下载失败"那句话用的词。
      model.requests = [];
      const unnamed = await saveScenario(
        { media: [{ kind: 'file', name: '', file: '', url }] }, '无名的', saves, { extract: extract(FORM) });
      ok('（对照）文件没有名字时不硬凑 —— 来源那一栏退回裸的格式名',
        /（来源 文本）/.test(unnamed) && !/没有名字的文件/.test(unnamed), unnamed);
      ok('退回整理时**明说抽取没成**（只说"整理过"，管理员会以为那份剧本有剧情结构）',
        /剧情抽取没成/.test(viaModel) && /没有剧情结构/.test(viaModel), viaModel);
      // 降级**不产生 `.rule.json`**，所以这一局一条机制都没有 —— 只说"没有剧情结构"
      // 会被读成"叙事少点细节"，而真相是"整本模组的规矩都不算数"。
      ok('而且**明说特殊规则不生效**，并给出重试的路',
        /不会应用剧本里的特殊规则/.test(viaModel) && /重新发一次/.test(viaModel), viaModel);

      model.requests = [];
      model.script = [{ content: '我做不到' }];
      const failed = await saveScenario({ media }, '失败了的', saves,
        { extract: extract(PLAIN), analyze: noPipeline });
      ok('模型整理失败时如实报错，**既不落库也不假装成功**',
        /不是剧本格式/.test(failed) && saves.read('失败了的').ok === false, failed);
      // 两条原因**都要在**：管线那句说的是"哪一片、哪一步没成"，后备那句说的是"连整理都没成"。
      // 只说一句会把一半事实丢掉，而排查的人正是靠这一半去分辨"模型不行"还是"文件不行"。
      ok('管线与后备**都**没成时，两条原因都在回执里',
        /本用例验的是后备那条路/.test(failed) && /退一步只做格式整理也没成/.test(failed), failed);

      // ── 拆成"前半就地 / 后半交出去"之后的那条路（2026-10-19）──
      //
      // 抽取最多 90 秒，而命令是被 `ingest.ts` 的**按会话串行**链 await 的 —— 就地跑完的
      // 代价是"传完剧本之后的一分钟里，这个群说什么都没反应"。判据因此是**命令立刻返回**
      // 且回执由 `sendText` 事后补上，而不是"最后拿到了什么"（后者就地跑也拿得到）。
      const { createScenarioCommand } = await load('extra/trpg/commands/scenario.js');
      const sent = [];
      const asyncCmd = createScenarioCommand({
        scenarios: saves, command: '.trpg scenario',
        sendText: async (_key, text) => { sent.push(text); },
        // 管线"没成"→ 走后备那次整理（`FORM`）→ 一次调用、结果确定，且不依赖假端点的脚本。
        save: { extract: extract(PLAIN), analyze: noPipeline, format: async () => ({ ok: true, text: FORM }) }
      });
      const immediate = String(await asyncCmd({
        chatKey: 'group:async', senderId: '10001', text: '.trpg scenario 异步的', media, replyToMessageId: null
      }));
      ok('需要模型时命令**立刻**回一句"正在收"，而不是等抽取跑完（那 90 秒不再堵住这个群）',
        /正在收「f.md」/.test(immediate) && !/已存剧本/.test(immediate), immediate);
      ok('夹具：那一刻回执还没发出去（补发是后台那条路的事）', sent.length === 0, JSON.stringify(sent));
      // 后台是 `void` 出去的，所以这里**轮询等它落地**（不是 `sleep(80)` 那种定值等待 ——
      // 机器一忙就会假红，而这条链上没有任何"它必须在这一刻完成"的语义）。
      for (let i = 0; i < 100 && sent.length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      ok('后台跑完之后用 `sendText` 把回执补上（与就地跑时逐字同形）',
        sent.length === 1 && /已存剧本「异步的」/.test(sent[0]) && /开局：\.trpg new 异步的/.test(sent[0]),
        JSON.stringify(sent));
      const fastSent = [];
      const inlineCmd = createScenarioCommand({
        scenarios: saves, command: '.trpg scenario',
        sendText: async (_key, text) => { fastSent.push(text); },
        save: { extract: extract(FORM) }
      });
      const inline = String(await inlineCmd({
        chatKey: 'group:inline', senderId: '10001', text: '.trpg scenario 现成的二号', media, replyToMessageId: null
      }));
      ok('格式本来就对 → 即使接了 `sendText` 也**就地**回（常见的那条路不该变成两条消息）',
        /已存剧本「现成的二号」/.test(inline) && fastSent.length === 0, inline);

      // ── 管线成了的那条路 ──
      //
      // 注入一个成功的管线（生产实现会真的发 N+1 次调用，本机不能发），验的是**接线**：
      // 落库的是管线给的正文、伴生文件真的写下去了、回执把"抽了几片/用了几次/丢了几个字/
      // 有没有待核项"都说出来。**抽取质量本身只能人工冒烟**（见 `t-trpg-extract.mjs` 文件头）。
      const STRUCT = {
        summary: '废弃灯塔与守夜人',
        scenes: [{ name: '灯塔', summary: '一层门厅', npcs: ['守夜人'], clues: ['缺页的航海日志'] }],
        npcs: [{ name: '守夜人', summary: '话少', attitude: '敌意', location: '灯塔' }],
        clues: [{ text: '缺页的航海日志', visible: true, location: '灯塔' }],
        items: [{ name: '铜钥匙', summary: '', location: '灯塔' }],
        mechanics: [{
          type: 'check_modifier', triggerText: '在灯塔里', effectText: '侦察 -20',
          note: '浓雾', sourceQuote: '雾里什么都看不清'
        }],
        warnings: ['第 1 条机制的引文在原文里找不到：雾里什么都看不清']
      };
      const pipeline = async () => ({
        ok: true,
        result: {
          body: FORM, struct: STRUCT,
          chunks: [{ index: 0, heading: '灯塔', chars: PLAIN.length, text: PLAIN }],
          totalChars: PLAIN.length, droppedChars: 300, calls: 2, ms: 1234
        }
      });
      model.requests = [];
      model.script = [{ content: '这条不该被用到' }];
      const drawn = await saveScenario({ media }, '抽过的', saves,
        { extract: extract(PLAIN), analyze: pipeline });
      ok('管线成了 → 落库的是管线合成的正文（标题来自它），而且**一次模型调用都没发**（注入的就是管线本身）',
        model.requests.length === 0 && saves.read('抽过的').scenario.title === '灯塔', drawn);
      ok('抽取产物落成**伴生文件**：`.struct.json` 真的写下去了（不是只记在内存里）',
        saves.read('抽过的').scenario.struct !== undefined
        && saves.read('抽过的').scenario.rawParts === 1,
        JSON.stringify(saves.list().find((item) => item.id === '抽过的')));
      ok('回执把抽取的账说清楚：几类各几条、切了几片、用了几次调用',
        /抽出了 1 个场景、1 个 NPC、1 条线索、1 件道具、1 条机制/.test(drawn)
        && new RegExp(`原文 ${PLAIN.length} 字切成 1 片，用了 2 次调用`).test(drawn), drawn);
      ok('**"没进抽取的字数"单独说**：它是管理员判断"要不要手工再传一次"的唯一依据',
        /还有 300 字超出片数上限没进抽取/.test(drawn), drawn);
      ok('待核项有计数、并**指向 `.trpg check`**（只报条数的话，管理员没法追问是哪几条 —— '
        + 'P7-b 之前这里写的是"记在 <id>.struct.json 里"，那个文件名群友打不开）',
        /待核项 1 条 —— 敲 `\.trpg check 抽过的` 逐条看。/.test(drawn), drawn);
      ok('走管线时**不再**说"已让模型整理过"（那句话会把"抽取"降格成"整理"，误导管理员）',
        !/已让模型整理/.test(drawn), drawn);
      ok('抽取成功的回执照旧以"开局怎么敲"收尾（回执的形状不因为走了管线而变）',
        typeof drawn === 'string' && /开局：\.trpg new 抽过的/.test(drawn), drawn);

      // 管线合成出来的正文**仍然要过 `parseScenario`** —— 抽取不是"绕过正文上限"的后门。
      // 一份 30 页模组被"压缩"成 5 万字（模型没照提示词做）时，这条路必须**如实拒绝**：
      // 放进去的话，下一轮 system prompt 会被一份超长正文顶爆，而没有人知道是谁放进来的。
      model.requests = [];
      const overlong = await saveScenario({ media }, '抽过头了', saves, {
        extract: extract(PLAIN),
        analyze: async () => ({
          ok: true,
          result: {
            body: `---\ntitle: x\n---\n${'字'.repeat(5000)}`,
            struct: STRUCT, chunks: [], totalChars: 5000, droppedChars: 0, calls: 1, ms: 1
          }
        })
      });
      ok('管线合成的正文超长 → 落库**如实失败**（抽取不是绕过正文上限的后门），而且不落盘',
        /太长/.test(overlong) && saves.read('抽过头了').ok === false, overlong);

      // ── 用量记账（2026-10-19 补）──
      //
      // 这条路最多发 **6 次**调用（`MAX_CHUNKS` 片 + 一次归并），或者后备那次整理 1 次 ——
      // 它们是"传一份剧本"的**全部成本**，不记账就没人知道它花了多少。
      // 这里直接对着**真端口**验（上面那些用例注入了假 `ask`，碰不到记账那一段）。
      model.requests = [];
      model.script = [{
        content: '{"scenes":[],"npcs":[],"clues":[],"items":[],"mechanics":[],"warnings":[]}'
      }];
      const portUsage = [];
      const portOutcome = await createAskPort((usage) => portUsage.push(usage))(
        {
          job: 'merge',
          payload: {
            name: '记账', source: '文本', chars: 10, maxChars: 4000, maxFlags: 9, maxCharacters: 9, extracted: '{}'
          }
        },
        new AbortController().signal
      );
      ok('抽取端口把每次调用的用量**交 recordUsage**（与 `suggest` / `.rh` 同一条链，不是只打日志）',
        portOutcome.ok && portUsage.length === 1 && portUsage[0].promptTokens === 10
        && portUsage[0].completionTokens === 5 && portUsage[0].totalTokens === 15,
        JSON.stringify(portUsage));

      model.script = [{ content: FORM }];
      const formatUsage = [];
      const formatted2 = await formatScenarioText(
        '随便一段设定', { name: '记账', source: '文本' }, (usage) => formatUsage.push(usage)
      );
      ok('后备那次格式整理**也交用量**（两条路的成本都要看得见）',
        formatted2.ok && formatUsage.length === 1 && formatUsage[0].totalTokens === 15,
        JSON.stringify(formatUsage));
      // 两次调用 → 脚本要装**两条**（假端点是消耗式的，见 `suggest` 那段踩过的坑）。
      model.script = [{ content: FORM }, { content: '{"scenes":[],"npcs":[],"clues":[],"items":[],"mechanics":[],"warnings":[]}' }];
      ok('**不给 `recordUsage` 时调用照常**（记不上是账面的小缺口，不该让一次传剧本失败）',
        (await formatScenarioText('随便一段设定', { name: '记账', source: '文本' })).ok === true
        && (await createAskPort()(
          { job: 'merge', payload: { name: 'x', source: '文本', chars: 1, maxChars: 9, maxFlags: 9, maxCharacters: 9, extracted: '{}' } },
          new AbortController().signal
        )).ok === true);
    } finally {
      updateConfig({ security: { allowPrivateImageHosts: before === true } });
      server.close();
      server.closeAllConnections?.();
    }
  }
}

// ── 5d. 运行模式：DM / 助手 ─────────────────────────────────────────────────
//
// 模式决定**三件事**，而三件事都必须按同一个会话取：露哪些工具（`toolsFor`）、给哪份人格
// （`prompt`）、跑不跑兜底建议（`onRunEnd`，在下面第 6 段 ⑨ 里验）。夹具刻意用**同一个 store
// 实例**去写、用 `createRuntime()` 造出来的运行时去读 —— 那正是生产里的形状（同一个文件、
// 两个实例），而不是"我以为它读得到"。
{
  const entry = EXTRA_REGISTRY.find((item) => item.id === 'trpg');
  const modes = new TrpgModeStore();
  const runtime = createRuntime();

  ok('没记录的会话 = **DM 模式**（缺省是那个更完整的形态，而不是"什么都没开"）',
    modes.read('group:never-set') === 'dm');

  ok('敲的那个词认得出来（中英各一份；认不出返回 null，而不是默默当成某一个）',
    parseMode('助手') === 'assistant' && parseMode('dice') === 'assistant'
    && parseMode('DM') === 'dm' && parseMode('主持人') === 'dm'
    && parseMode('随便') === null && parseMode('') === null);

  modes.write('group:mode-a', 'assistant');
  ok('切到助手模式读得回来', modes.read('group:mode-a') === 'assistant');

  ok('**助手模式下只露骰子**（say + roll）—— "仅能"是结构上的事实，不是提示词里的一句请求',
    JSON.stringify([...runtime.toolsFor('group:mode-a')].sort())
    === JSON.stringify([...TRPG_ASSISTANT_TOOLS].sort()),
    JSON.stringify(runtime.toolsFor('group:mode-a')));
  ok('DM 模式露全部四个（名单从 spec 派生，不在这里另抄一份）',
    runtime.toolsFor('group:mode-b').length === entry.tools.length,
    JSON.stringify(runtime.toolsFor('group:mode-b')));
  ok('**助手名单是声明过的工具名的子集**（拼错一个名字的表现是静默少一个工具，所以钉在这里）',
    TRPG_ASSISTANT_TOOLS.every((name) => entry.tools.some((tool) => tool.name === name))
    && JSON.stringify([...TRPG_ASSISTANT_TOOLS].sort()) === JSON.stringify(['roll', 'say']),
    JSON.stringify(TRPG_ASSISTANT_TOOLS));

  const assistantBody = runtime.prompt('group:mode-a').body;
  ok('助手模式**不注入任何人格**（body 是空的）—— 那个形态下 `intercept` 拦下每一条消息，'
    + '模型只在绕不过去的唤醒上才跑，而那时"什么都不说"正是要的行为；一份"你是骰子助手"的人格'
    + '反而在邀请它开口',
    Array.isArray(assistantBody) && assistantBody.length === 0, JSON.stringify(assistantBody));
  ok('对照：**空 body 不等于没有系统提示** —— 框架契约两段仍然在（`buildSystemPrompt` 的'
    + 'override 分支是 `[...SYSTEM_FRAMEWORK_SECTIONS, ...body]`），所以"要发言必须调用 say"照旧',
    Array.isArray(assistantBody) && !assistantBody.some((text) => /【跑团主持人】|【骰子助手】|剧本/.test(text)));

  const dmBody = runtime.prompt('group:mode-b').body;
  ok('对照：DM 模式仍是三段（人格 → 清单+剧本 → 状态），首段是主持人',
    dmBody.length === 3 && /【跑团主持人】/.test(dmBody[0]) && /【当前跑团状态】/.test(dmBody[2]),
    JSON.stringify(dmBody.map((text) => text.slice(0, 12))));

  modes.write('group:mode-a', 'dm');
  ok('切回 DM = **那条记录被删掉**（"文件里有的"永远是真的切过的）',
    !('group:mode-a' in modes.all()) && modes.read('group:mode-a') === 'dm');

  // 坏键 / 坏值 / 坏文件：一律当缺省，**不抛** —— 一个坏文件不该让跑团起不来。
  fs.mkdirSync(path.dirname(modes.file), { recursive: true });
  fs.writeFileSync(modes.file, JSON.stringify({
    'group:ok': 'assistant', '不是会话键': 'assistant', 'group:bad': '乱写'
  }));
  ok('坏键与坏值一律当缺省，读得出来的照读',
    modes.read('group:ok') === 'assistant' && modes.read('不是会话键') === 'dm'
    && modes.read('group:bad') === 'dm');
  fs.writeFileSync(modes.file, '这不是 JSON');
  ok('文件坏了也当缺省（同一个文件坏掉不该让跑团起不来）', modes.read('group:ok') === 'dm');
  fs.rmSync(modes.file, { force: true });

  // ── `/模式` 这条命令 ──
  const commands = createRuntime().commandHandlers;
  const tell = (text, chatKey = 'group:mode-c') => callIn(commands)(text, chatKey);

  ok('`/模式` 不带参数 → 报当前模式与两条可用命令',
    /当前：/.test(String(await tell('.trpg mode'))) && /助手/.test(String(await tell('.trpg mode'))));
  const switched = String(await tell('.trpg mode 助手'));
  ok('`/模式 助手` → 记住，并回一句"下一轮生效"',
    /已切到/.test(switched) && modes.read('group:mode-c') === 'assistant');
  // 那个形态下认不出骰子的消息（含 @ 与点名）**全部静默拦下** —— 对刚切过去的人是反直觉的，
  // 所以回执必须自己说出来（零成本，不消耗模型调用）。
  ok('切到助手模式时**明说 @ 也不会回**',
    /@ 我、跟我说话我都不会回/.test(switched), switched);
  ok('助手模式下不带参数敲 `/跑团` → 给的是**这个模式怎么用**，不是一张"还没开团"的空状态卡',
    /发一个骰子表达式/.test(String(await tell('.trpg status'))) && !/还没有开团/.test(String(await tell('.trpg status'))));
  ok('助手模式下那条回复指向的是 `.trpg mode DM`（写成旧词形的话群友照抄就切不回来）',
    /`\.trpg mode DM`/.test(String(await tell('.trpg status'))));
  const backToDm = String(await tell('.trpg mode DM'));
  ok('`/模式 DM` → 切回来', /已切到/.test(backToDm) && modes.read('group:mode-c') === 'dm');
  ok('对照：切回 DM 不附那句（它不是所有模式的通用提示）', !/@ 我/.test(backToDm), backToDm);
  ok('重复切到同一个模式时说清"已经是了"，不假装做了什么',
    /已经是/.test(String(await tell('.trpg mode DM'))) && String(await tell('.trpg mode DM')).includes(MODE_LABEL.dm));
  ok('不认识的模式 → 列出可用的两个（不默默当成某一个）',
    /不认识的模式/.test(String(await tell('.trpg mode 随便'))) && modes.read('group:mode-c') === 'dm');
  ok('帮助里列了「模式」这一条', /`\.trpg mode/.test(String(await tell('.trpg 乱写'))));
}

// ── 5e. 助手模式的拦截：整条消息都不进模型 ───────────────────────────────────
//
// 这是"跳过模型回复流程"的落点（`ExtraRuntime.intercept`）。判据刻意是**确定性**的：认得出
// 骰子就掷、认不出来就静默拦下 —— 代码里不做任何"这句话像不像在叫我"的猜测（那是模型的事，
// 而这条路压根不叫模型）。所以这一段的断言几乎都在钉同一件事：**判据是整串，不是子串**。
{
  const runtime = createRuntime();
  const modes = new TrpgModeStore();
  const feed = (text, chatKey = 'group:int') => runtime.intercept({
    chatKey, senderId: '10001', text, media: [], replyToMessageId: null
  });

  // 判据本身先单独钉（它跑在**每一条**入站消息上，误判的代价是"群里莫名其妙多一句"或"该掷没掷"）。
  ok('认得出：裸表达式、OneDice 的 `.r` / `。r` / `r` 前缀、大小写、首尾空白',
    ['3d6', 'd20', '4d6kh3', '(2d6+3)*2', '1d100b2', ' 3d6 ']
      .every((text) => looksLikeDiceRequest(text) !== null)
    && looksLikeDiceRequest('.r 3d6') === '3d6' && looksLikeDiceRequest('。r3d6') === '3d6'
    && looksLikeDiceRequest('R3D6') === '3d6',
    JSON.stringify(['.r 3d6', '。r3d6', 'R3D6'].map(looksLikeDiceRequest)));

  ok('**纯数字不算掷骰请求**（群里那句"12"不是让人掷一个 12）—— 判据是"至少要有一组 NdM"',
    looksLikeDiceRequest('12') === null && looksLikeDiceRequest('3d6') === '3d6');
  ok('**不做子串匹配**：句子里夹着表达式也不算（中文没有分词，"我觉得3d6不错"是一句话）',
    looksLikeDiceRequest('我觉得3d6这骰子不错') === null
    && looksLikeDiceRequest('3d6 帮我看看') === null
    && looksLikeDiceRequest('你好') === null && looksLikeDiceRequest('') === null);

  ok('DM 模式**不拦**（返回 null = 交给模型，这条路上一切照旧）',
    feed('3d6', 'group:dm') === null && feed('你好', 'group:dm') === null);

  modes.write('group:int', 'assistant');
  const rolled = feed('3d6');
  ok('助手模式：整条就是表达式 → 当场掷、当场回话（**一次模型调用都不发生**）',
    /^3d6 → \d\+\d\+\d = \d+$/.test(String(rolled?.reply)), JSON.stringify(rolled));
  ok('前缀形态回的是**归一化后**的表达式（`.r 3d6` 与 `3d6` 掷出来长得一样）',
    /^3d6 → /.test(String(feed('.r 3d6')?.reply)) && /^3d6 → /.test(String(feed('R3D6')?.reply)),
    String(feed('.r 3d6')?.reply));

  ok('认不出的（闲聊、@ 它、敲错的半句话）**拦下且一个字都不回** —— 不惊动模型、也不刷屏',
    JSON.stringify(feed('你好')) === '{}' && JSON.stringify(feed('@小鲸鱼 在吗')) === '{}'
    && JSON.stringify(feed('3d6x')) === '{}',
    JSON.stringify(feed('你好')));

  // 走到 catch 的不是"解析不了"（那种上面已经静默拦下了），而是**解析得了、掷不出来**。
  const overflow = feed('101d6');
  ok('数量越界的（`101d6`）把**可读的原因**回出去（它确实是掷骰请求，敲错的人正需要下一步）',
    !!overflow?.reply && /101|上限|最多/.test(String(overflow.reply)), JSON.stringify(overflow));

  // 有战役时顺手记进日志（同 `/掷骰`）—— 助手模式通常没有战役，但"从 DM 切过来"的群有。
  store.write(emptyCampaign('group:int', { title: '拦截测试团', system: '', rule: 'generic' }));
  const before = store.read('group:int').log.length;
  feed('3d6');
  ok('有战役时掷骰顺手记进日志（切回 DM 之后这段还在）',
    store.read('group:int').log.length === before + 1
    && store.read('group:int').log.at(-1).kind === 'roll',
    JSON.stringify(store.read('group:int').log.at(-1)));
  store.remove('group:int');
}

// ── 5e2. DM 模式的准入：只有这一局的人能惊动 DM（2026-10-19 加）───────────────
//
// 响应档位被抬到 4 档（见 5f）之后，"谁说话都响应"就必须由这一层把**谁**界定清楚 ——
// 否则旁观者插一句话也会叫起一整轮模型调用，而那一轮里 DM 只能对着"跟这一局无关的一句话"叙事。
//
// 判据落在 `intercept` 的第二档返回：`{}` = **拦下但不吭声**（消息照常存档、照常上面板，
// 只是落成已读历史）。所以这一段的两条断言形状不同 —— `null` 是放行，`'{}'` 是拦下。
{
  const runtime = createRuntime();
  const KEY = 'group:admit';
  const feed = (chatKey, senderId) => runtime.intercept({
    chatKey, senderId, text: '我推开门', media: [], replyToMessageId: null
  });
  /** 重写这一局的存档：`mutate` 拿到的是一份全新的 `active` 局。 */
  const open = (mutate) => {
    const campaign = emptyCampaign(KEY, { title: '准入测试团', system: '', rule: 'generic' });
    mutate(campaign);
    store.write(campaign);
  };
  const blocked = (chatKey, senderId) => JSON.stringify(feed(chatKey, senderId)) === '{}';

  ok('没开局：谁说话都照常（这条路必须在 —— 否则"还没开团"的群连话都不能说）',
    feed(KEY, '20001') === null && feed(KEY, '20002') === null);

  open((campaign) => { campaign.status = 'preparing'; campaign.players = ['20001']; });
  ok('还在建卡（preparing）：**一律放行** —— 那段时间群里讨论的正是"怎么加入、建什么卡"',
    feed(KEY, '20001') === null && feed(KEY, '20002') === null);

  open((campaign) => { campaign.players = ['20001']; });
  ok('开跑之后：报过名的玩家放行（`null`）', feed(KEY, '20001') === null);
  ok('**旁观者被拦下**（`{}` 而不是 null —— 拦下才进不了窗口）', blocked(KEY, '20002'));

  // DM 直接建卡给某个人（`character action=create` 带 `ownerId`）**不进 `players`** ——
  // 少了这条判据，那个人说话 DM 会当没听见，而**没有任何报错**。
  open((campaign) => {
    campaign.players = [];
    campaign.characters.push({ name: '被建卡的人', ownerId: '20003' });
  });
  ok('**有卡的人也算"这一局的人"**（只认 `players` 会静默漏掉"DM 建的卡"那一条路）',
    feed(KEY, '20003') === null && blocked(KEY, '20004'));

  ok('拿不到发送者时放行（宁可多惊动一次，也不要把说不清来源的消息静默吞掉）',
    feed(KEY, '') === null && feed(KEY, null) === null);

  // 助手模式**不走这条判据**：它整条都拦，与"是不是玩家"无关（判据在 5e 段）。
  new TrpgModeStore().write('group:admit-as', 'assistant');
  ok('助手模式照旧整条拦下（它不认识"玩家"这个概念，也不该因为这里新增判据而变松）',
    blocked('group:admit-as', '20001'));
  store.remove(KEY);
}

// ── 5f. 配置覆盖：挂载期间把"上下文宽度"抬起来 ──────────────────────────────
//
// `configPatch` 只影响**这一轮那份运行配置**（`ExtrasRuntime.configFor`），不落盘、不外溢。
// 它是跑团"够跑一局"的来源：人物卡、旗标、剧本正文、日志每轮都要带上，默认那点窗口会让 DM
// 看不见自己十分钟前说过什么。**语义是下限不是覆盖** —— 用户配得比下限宽就照用户的。
{
  const { getConfig, updateConfig } = await load('core/config.js');
  const previous = { ...getConfig().store };
  const runtime = createRuntime();
  const modes = new TrpgModeStore();
  const patchOf = (key) => runtime.configPatch(key).store ?? {};

  updateConfig({ store: { maxContextMessages: 20, historyCount: 20, promptContextMaxChars: 8000 } });
  const lifted = patchOf('group:cfg-dm');
  ok('挂载期间把三个"上下文宽度"旋钮一起抬到下限',
    lifted.maxContextMessages === 200 && lifted.historyCount === 200 && lifted.promptContextMaxChars === 60000,
    JSON.stringify(lifted));

  updateConfig({ store: { maxContextMessages: 500, historyCount: 900, promptContextMaxChars: 200000 } });
  const kept = patchOf('group:cfg-wide');
  ok('**是下限不是覆盖**：用户自己配得比下限宽就照用户的（不把它压回去）',
    kept.maxContextMessages === 500 && kept.historyCount === 900 && kept.promptContextMaxChars === 200000,
    JSON.stringify(kept));

  updateConfig({ store: { maxContextMessages: 0, historyCount: 0 } });
  const unlimited = patchOf('group:cfg-zero');
  ok('`0`（不限）**原样留着** —— 它已经是最宽的那一档，写成 200 反而是把它变窄',
    unlimited.maxContextMessages === 0 && unlimited.historyCount === 0, JSON.stringify(unlimited));

  modes.write('group:cfg-as', 'assistant');
  ok('助手模式**不抬**（它整条消息都拦下来、压根不跑模型，抬了只是白占内存）',
    JSON.stringify(runtime.configPatch('group:cfg-as')) === '{}',
    JSON.stringify(runtime.configPatch('group:cfg-as')));

  // ── 响应档位（2026-10-19 加）：这一项是**覆盖**，不是下限 ──
  //
  // 判据是"玩家说的每一句话 DM 都看得见"。滑条最右端（100 = 4 档）是唯一能保证这件事的位置，
  // 而默认的 95 本来也是 4 档 —— 所以这个覆盖只在管理员**手动调低过**时起作用，而那正是最需要
  // 它的群（低档位会让 DM 静默漏掉玩家的行动，日志里一条线索都没有）。
  //
  // **两个旋钮都要写**：`unifiedTier` 开着时只看 `contextSliderPos`，关掉时群聊按
  // `groupSliderPos[群号]` 覆盖全局 —— 只写一个的话，另一种配置下覆盖会静默失效。
  updateConfig({ store: { contextSliderPos: 0, unifiedTier: false, groupSliderPos: { 'cfg-tier': 0 } } });
  const tier = patchOf('group:cfg-tier');
  ok('挂载期间把**响应档位**抬到 4 档（滑条 100），且两个旋钮都写（两种 `unifiedTier` 配置下都生效）',
    tier.contextSliderPos === 100 && tier.groupSliderPos?.['cfg-tier'] === 100, JSON.stringify(tier));
  ok('私聊不写 `groupSliderPos`（它跟随全局 —— 写一个用不上的键只会让人以为那里也有判据）',
    patchOf('private:cfg-tier').groupSliderPos === undefined,
    JSON.stringify(patchOf('private:cfg-tier').groupSliderPos));
  updateConfig({ store: { unifiedTier: true, groupSliderPos: { __replace__: {} } } });

  updateConfig({ store: previous });
  ok('对照：复原之后读到的还是全局那份（覆盖从来没写回配置）',
    getConfig().store.maxContextMessages === previous.maxContextMessages,
    String(getConfig().store.maxContextMessages));
}

// ── 5g. 开一局的四步，各是一条独立命令 ──────────────────────────────────────
{
  const commands = createRuntime().commandHandlers;
  // 按 `text` 的第一个词路由到对应命令 —— 断言里写的因此仍是**群友真敲的那一整句**，
  // 而不是"我以为该调哪个 handler"。
  const tell = (text, chatKey = 'group:flow', media = []) => callIn(commands)(text, chatKey, media);

  ok('**每条命令各自是一个 handler**（加一个动作 = 加一行声明 + 一个 handler）',
    ['.trpg new', '.trpg join', '.trpg status', '.trpg start', '.trpg end', '.trpg mode',
      '.trpg scenario', '.trpg check', '.trpg', '.pc new', '.pc roll', '.pc confirm', '.pc show', '.pc save', '.pc',
      '.combat start', '.combat next', '.combat end', '.combat',
      '.log export', '.log',
      '.ra', '.rh', '.st', '.r']
      .every((name) => typeof commands[name] === 'function')
    && Object.keys(commands).length === 25, JSON.stringify(Object.keys(commands)));

  const wizard = String(await tell('.trpg status'));
  ok('还没开局时 `.trpg status` 给的是**向导**（已经开局给的是局势卡，那是另一段的事）',
    /还没开局/.test(wizard) && /1\. 定模式/.test(wizard) && /2\. 传剧本/.test(wizard)
    && /3\. 起一局/.test(wizard) && /5\. 都确认了/.test(wizard), wizard.slice(0, 80));
  ok('向导按「定模式 → 传剧本 → 起一局 → 建卡 → 开跑」排，而且把**当前模式**写在明面上',
    wizard.indexOf('定模式') < wizard.indexOf('传剧本')
    && wizard.indexOf('传剧本') < wizard.indexOf('3. 起一局')
    && wizard.indexOf('3. 起一局') < wizard.indexOf('4.')
    && wizard.indexOf('4.') < wizard.indexOf('5. 都确认了')
    && wizard.includes(MODE_LABEL.dm), wizard.slice(0, 240));
  ok('向导里带上了剧本清单（不是干巴巴一句"没有"）',
    /剧本库里/.test(wizard) && /(引用它敲|要再加一份)/.test(wizard));
  ok('向导指向的是**当前面的命令**（写着旧词形的话，群友照抄就敲不动）',
    /`\.trpg mode DM`/.test(wizard) && /`\.trpg scenario`/.test(wizard)
    && /`\.trpg new/.test(wizard) && /`\.trpg join`/.test(wizard)
    && /`\.pc new/.test(wizard) && /`\.pc confirm`/.test(wizard) && /`\.trpg start`/.test(wizard)
    && !/\/跑团|\/模式|\/剧本|\/开局/.test(wizard), wizard);

  ok('`/剧本` 不带名字又没引用文件 → **列出剧本库**（顺带说了怎么再传一份）',
    /剧本库里/.test(String(await tell('.trpg scenario')))
    && /(引用它敲|要再加一份)/.test(String(await tell('.trpg scenario'))));
  ok('`/剧本 甲` 带了名字却没引用文件 → 明说没有文件 + 用法（不假装存下了）',
    /没有文件/.test(String(await tell('.trpg scenario 甲')))
    && /用法/.test(String(await tell('.trpg scenario 甲'))));
  // 命令真的把 `input.media` 递给了 `saveScenario`，而且名字是**从文件名推的**：
  // 这两件事由"没有 url 时的早退分支"验出来 —— 它在下载**之前**返回，所以既不联网、也不起 Python。
  // 推不出名字的话这里拿到的是剧本清单（而不是这条回执），断言当场红。
  ok('`/剧本` 引用了一份没给下载地址的文件 → 名字取自文件名，media 真的递到了 saveScenario',
    /拿到了「灯塔.md」/.test(String(await tell('.trpg scenario', 'group:flow4',
      [{ kind: 'file', name: '灯塔.md', file: '灯塔.md' }]))),
    String(await tell('.trpg scenario', 'group:flow4', [{ kind: 'file', name: '灯塔.md', file: '灯塔.md' }])));

  ok('`.trpg new` 不带名字 = **选剧本**这一步：列清单 + 说清怎么敲',
    /用法：/.test(String(await tell('.trpg new')))
    && /剧本库里/.test(String(await tell('.trpg new'))));
  ok('`.trpg new 乱起一个名字` 照常开局，但**明说没有注入剧本**（剧本是可选的）',
    /没有注入剧本/.test(String(await tell('.trpg new 乱起一个名字', 'group:flow2'))));

  // 认不出的子命令落到**裸 `.trpg`** 上。**不静默忽略** —— 群友得知道自己敲的那条为什么没生效。
  const stray = String(await tell('.trpg 乱写', 'group:flow3'));
  ok('认不出的子命令 → 回一张命令清单，把每一条都列出来（不默默当成某一个）',
    /这几条各自是一条命令/.test(stray) && ['.trpg mode', '.trpg scenario', '.trpg start', '.r']
      .every((name) => stray.includes(`\`${name}`)), stray);
  ok('对照：**不带参数**的 `.trpg status` 仍然给向导（上面那条不是把整条命令吃掉了）',
    /还没开局/.test(String(await tell('.trpg status', 'group:flow5'))));

  // 从文件名推名字：判据在这一层单独钉 —— 它上面那条路会真的去下载并**起 Python 抽文本**，
  // 而仓库的测试约定是不启动真解释器。
  const file = (name) => [{ kind: 'file', name, file: name, url: 'http://x/y' }];
  ok('从引用的文件名推剧本名（去掉扩展名，中文原样留着）',
    scenarioNameFromFile(file('灯塔.md')) === '灯塔'
    && scenarioNameFromFile(file('模组 v1.2.pdf')) === '模组 v1.2'
    && scenarioNameFromFile(file('本子.DOCX')) === '本子',
    JSON.stringify(['灯塔.md', '模组 v1.2.pdf', '本子.DOCX'].map((n) => scenarioNameFromFile(file(n)))));
  ok('`name` 缺失时退回 `file` 字段；推不出来（没有 file 段 / 名字是空白 / 只剩扩展名）返回 `null`',
    scenarioNameFromFile([{ kind: 'file', file: 'x.docx', url: 'u' }]) === 'x'
    && scenarioNameFromFile([{ kind: 'image', name: 'a.md' }]) === null
    && scenarioNameFromFile([{ kind: 'file', name: '   ' }]) === null
    && scenarioNameFromFile(file('.md')) === null,
    JSON.stringify(scenarioNameFromFile(file('.md'))));
}

// ── 5g2. `.trpg check <名字>`（P7-b）：把抽取结果摊开给管理员看 ────────────────
//
// 抽取管线（P7-a）把一份非结构化模组变成三样东西（`.md` / `.struct.json` / `.raw/`），而
// **抽得对不对、有没有条目被上限裁掉、引文对不对得上原文，管理员在群里一处都看不到**。
// 这条命令就是那个出口。它零模型调用、零写入，所以这里可以随便敲。
//
// ⚠️ 它与 `commands/check.ts`（`.ra` / `.rh` / `.st`）**不是一件事**，名字像只是巧合。
{
  const commands = createRuntime().commandHandlers;
  const tell = (text, chatKey = 'group:chk') => callIn(commands)(text, chatKey, []);
  // 与其余段落一样用**独立的 store 实例**：它读的是同一批文件（目录的薄视图），
  // 所以不必给 `ExtrasRuntime` 开一个"取某个扩展内部对象"的口子。
  const scenarios = new ScenarioStore();

  // 夹具：一份"抽过、且抽得不算干净"的剧本（两条待核项），一份"抽得很干净"的，
  // 一份"手写的、压根没抽过"的，以及两种坏法（形状不对 / JSON 半截）。
  const BODY = '正文一句。';
  scenarios.write('核对团', `---\ntitle: 核对团\nrule: coc7\n---\n${BODY}`);
  scenarios.writeExtras('核对团', {
    struct: {
      summary: '灯塔与守夜人',
      scenes: [{ name: '灯塔', summary: '', npcs: ['守夜人'], clues: [] }],
      npcs: [{ name: '守夜人', summary: '', attitude: '敌意', location: '灯塔', discovered: true }],
      clues: [{ text: '门厅的血迹', visible: true, location: '灯塔' }],
      items: [],
      mechanics: [{ type: 'narrative_hook', triggerText: '', effectText: '灯灭时别回头', note: '', sourceQuote: '' }],
      warnings: ['引文对不上：守夜人不吃普通伤害', '原文太长，只抽了前 3 片']
    },
    ruleExt: { version: 1, mechanics: [], warnings: [] },
    raw: [{ heading: '一', text: '原文第一片' }, { heading: '二', text: '原文第二片' }, { heading: '三', text: '原文第三片' }]
  });
  scenarios.write('干净团', `---\ntitle: 干净团\n---\n${BODY}`);
  scenarios.writeExtras('干净团', {
    struct: { summary: '', scenes: [], npcs: [], clues: [], items: [], mechanics: [], warnings: [] }
  });
  scenarios.write('无结构团', `---\ntitle: 无结构团\n---\n${BODY}`);
  scenarios.write('形状坏团', `---\ntitle: 形状坏团\n---\n${BODY}`);
  scenarios.writeExtras('形状坏团', { struct: '这不是一个对象' });
  scenarios.write('半截团', `---\ntitle: 半截团\n---\n${BODY}`);
  fs.writeFileSync(scenarios.structFile('半截团'), '{ "summary": ', 'utf8');
  scenarios.write('多警告团', `---\ntitle: 多警告团\n---\n${BODY}`);
  scenarios.writeExtras('多警告团', {
    struct: {
      summary: '', scenes: [], npcs: [], clues: [], items: [], mechanics: [],
      warnings: Array.from({ length: 11 }, (_, i) => `第 ${i + 1} 条没核对上`)
    }
  });

  const checked = String(await tell('.trpg check 核对团'));
  ok('`.trpg check <名字>` 把统计**逐项**摊开（标题、推荐规则表、正文字数、切片数、五类计数）',
    checked.startsWith('【剧本核对】核对团')
    && checked.includes('标题：核对团（推荐规则表：coc7）')
    && checked.includes(`正文 ${BODY.length} 字，原文切片 3 片`)
    && checked.includes('剧情结构：1 个场景、1 个 NPC、1 条线索、0 件道具、1 条机制'), checked);
  ok('待核项**逐条**印出来 —— `.trpg scenario` 的回执只报得出条数，逐条看正是这条命令的存在理由',
    checked.includes('待核项（2 条）：')
    && checked.includes('· 引文对不上：守夜人不吃普通伤害')
    && checked.includes('· 原文太长，只抽了前 3 片'), checked);
  ok('下一步给的是**真能敲的词形**，而且指出要改哪个文件、改完敲什么',
    checked.includes('要开局：.trpg new 核对团')
    && checked.includes('data/trpg/scenarios/核对团.struct.json')
    && checked.includes('再敲一次 `.trpg check 核对团`'), checked);
  ok('没有待核项时明说"没有"（把那一节省掉的话，"没有"与"没印"分不出来）',
    String(await tell('.trpg check 干净团')).includes('待核项：没有。'),
    String(await tell('.trpg check 干净团')));

  const bare = String(await tell('.trpg check'));
  ok('不带名字 = 用法 + 剧本库清单（复用 `renderScenarioList`，与另两处同一份拼法）',
    bare.includes('用法：.trpg check <剧本名>') && /剧本库里/.test(bare), bare);

  const missing = String(await tell('.trpg check 不存在的东西'));
  ok('剧本库里没有这个名字 → 明说没有 + 现在有什么（`read()` 的文案本来就有那句，**不拼第二遍**）',
    missing.includes('不存在的东西') && missing.includes('现在有：')
    && missing.indexOf('现在有：') === missing.lastIndexOf('现在有：'), missing);

  const noExtras = String(await tell('.trpg check 无结构团'));
  ok('手写的、格式本来就对的剧本**没有抽取产物** —— 如实说一句，并给出"要抽就重传一次"那条路',
    noExtras.includes('还没有抽取产物') && noExtras.includes('.trpg scenario 无结构团'), noExtras);

  const brokenShape = String(await tell('.trpg check 形状坏团'));
  ok('伴生结构形状不对 → 说"形状不对"，**不谎报"没有抽取产物"**（抽过，只是文件坏了）',
    brokenShape.includes('形状不对') && !brokenShape.includes('还没有抽取产物'), brokenShape);

  const halfJson = String(await tell('.trpg check 半截团'));
  ok('伴生文件是半截 JSON → 说"没有可用的"并指向「伴生文件」那一段（成因与上一条不同，两条都得说清）',
    halfJson.includes('剧情结构：没有可用的') && halfJson.includes('伴生文件：') && /解不开/.test(halfJson),
    halfJson);

  const many = String(await tell('.trpg check 多警告团'));
  ok('待核项超过 8 条时**截断并说还有几条**（回执不该长到刷屏；全量都在 struct.json 里）',
    many.includes('待核项（11 条）：') && many.includes('还有 3 条没列'), many);

  // ── 规则扩展那一段（P7-f）：三类**分开列** ──
  //
  // 判据只有一条：`effect.handler` 是不是 `narrate`（编译期定的，不是这里猜的）。非分不可的
  // 理由是"可执行的那几条**真的会改检定与伤害**" —— 混在一张单子里，管理员没法回答
  // "这份模组到底改了什么判定"这个唯一要紧的问题。
  scenarios.write('机制团', `---\ntitle: 机制团\n---\n${BODY}`);
  scenarios.writeExtras('机制团', {
    ruleExt: {
      version: 1,
      mechanics: [
        {
          type: 'check_modifier', note: '灯塔的浓雾', trigger: { op: 'scene', value: '灯塔' },
          effect: { handler: 'penalty_to_check', params: { value: 20 } }, sourceQuote: '浓雾里看不远'
        },
        {
          type: 'narrative_hook', note: '灯灭时别回头', trigger: { op: 'scene', value: '灯塔' },
          effect: { handler: 'narrate', params: {} }, sourceQuote: '别回头'
        },
        {
          type: 'weather_effect', note: '风很冷', trigger: { op: 'scene', value: '码头' },
          effect: { handler: 'narrate', params: {} }, sourceQuote: '风很冷'
        }
      ]
    }
  });
  const mechCheck = String(await tell('.trpg check 机制团'));
  ok('规则扩展那一段**先给账**：可执行 / 只作叙事提示 / 编译时没进判定 各几条',
    mechCheck.includes('规则扩展：可执行 1 条、只作叙事提示 2 条、编译时没进判定 1 条'), mechCheck);
  ok('**可执行的**逐条列全（一条都不截断 —— 少印一条 = 管理员以为这份模组没这条规则）',
    mechCheck.includes('可执行的（检定与伤害照它来）：')
    && mechCheck.includes('· 灯塔的浓雾（check_modifier / 场景：灯塔）'), mechCheck);
  ok('**只作叙事提示的**另起一段、排在那一段之后（混在一起会让管理员以为它也算数）',
    mechCheck.includes('只作叙事提示的（不参与判定，DM 拿它当氛围参考）：')
    && mechCheck.includes('· 灯灭时别回头（narrative_hook / 场景：灯塔）')
    && mechCheck.indexOf('只作叙事提示的') > mechCheck.indexOf('可执行的（'), mechCheck);
  ok('**编译时没进判定的**原文逐字带出 —— 认不出的 type 也在这一档（它降级成了叙事，不是消失了，'
    + '所以上面"只作叙事提示"那一段里**也有它**）',
    mechCheck.includes('编译时没进判定的：')
    && mechCheck.includes('· 第 3 条机制的 type「weather_effect」我不认识，已按纯叙事处理（不影响判定）')
    && mechCheck.includes('· 风很冷（narrative_hook / 场景：码头）'), mechCheck);

  // "没有扩展"与"扩展是空的"**不是同一句话**：前者检定按基础规则表走，后者文件确实在。
  ok('没有 `.rule.json` 的剧本明说"没有"，并点出后果（检定按基础规则表走）',
    noExtras.includes('规则扩展：没有 —— 这份剧本的检定按基础规则表走。'), noExtras);
  ok('有 `.rule.json` 但一条机制都没有 → 说"空的"（与上一条分开：文件确实在，只是里面没东西）',
    checked.includes('规则扩展：空的（文件在，但里面一条机制都没有）。'), checked);
  ok('有 `.rule.json` 时**多给一句**"改哪份文件"（机制与结构分居两份文件，只说 struct.json '
    + '会让人以为改那儿就能改规则）',
    checked.includes('规则扩展要改：编辑 data/trpg/scenarios/核对团.rule.json'), checked);
  ok('对照：没有 `.rule.json` 的剧本**不说**这句（让人去改一份不存在的文件，比不说更坏）',
    !noExtras.includes('规则扩展要改：'), noExtras);

  // 扩展坏了：**逐条**列出来，并点出后果。
  scenarios.write('坏扩展团', `---\ntitle: 坏扩展团\n---\n${BODY}`);
  scenarios.writeExtras('坏扩展团', {
    ruleExt: {
      version: 1,
      mechanics: [{
        type: 'check_modifier', note: '浓雾', trigger: { op: 'scene', value: '灯塔' },
        effect: { handler: 'reduce_damage', params: {} }, sourceQuote: '看不远'
      }]
    }
  });
  const badExt = String(await tell('.trpg check 坏扩展团'));
  ok('扩展坏了 → 明说"读不出来"，并点出**后果**（用它的那一局开局会被拒）—— '
    + '只说一堆问题的话，管理员不知道它此刻有没有生效',
    badExt.includes('规则扩展：读不出来（这份规则扩展坏了，用它的那一局开局会被拒）：')
    && badExt.includes('· 第 1 条机制：effect.handler 写的是「reduce_damage」，我不认识它'), badExt);
  ok('⚠️ 扩展坏了时**不印**"可执行的 / 只作叙事提示的"那两段（编译没通过，一条机制都没成立）',
    !badExt.includes('可执行的（检定与伤害照它来）：')
    && !badExt.includes('只作叙事提示的（'), badExt);
  ok('群友可见的回执里不含 Markdown 的 `**`（QQ 不认，星号会原样显示）',
    !mechCheck.includes('**') && !badExt.includes('**') && !checked.includes('**'),
    mechCheck.split('\n').filter((line) => line.includes('**')).join(' ｜ '));

  // 正在用这份剧本的那一局：那时"去开一局"是**错的**提示。
  ok('对照（先说结论）：还没开局的那个会话，给的是"要开局"', checked.includes('要开局：.trpg new 核对团'));
  ok('`.trpg new 核对团` 真的开了一局（下面那条的前提，不成立的话它会静默变成假绿）',
    !String(await tell('.trpg new 核对团', 'group:chk-live')).startsWith('这份剧本'));
  const live = String(await tell('.trpg check 核对团', 'group:chk-live'));
  ok('正在用这份剧本的那一局**优先说**，并且不再劝你"去开一局"',
    live.includes('正在用这份剧本') && !live.includes('要开局：'), live);

  // ── 用法清单的守护（补一个**空白**）──
  //
  // `COMMAND_USAGE`（裸 `.trpg` 的回执）是"这一族有哪些命令"的**唯一**清单位置，而它此前
  // 没有任何守护：加一条子命令、忘了加一行，表现只是"群友敲错时看到的清单少一条"，不报任何错。
  // `.trpg check` 自己就是这么加上去的（加之前 grep `COMMAND_USAGE` 零命中）。
  //
  // ⚠️ **正方向对裸命令是"顺带成立"的**：`.trpg` / `.pc` / `.combat` / `.log` 在清单里只作为前缀
  // 出现（`.trpg new …`），`includes('`.trpg')` 由那条子命令的条目顺带满足 —— 所以对四个裸命令
  // 它查不出新东西（裸命令本来也不需要单独一行：它回的就是这份清单）。对**两词命令**它才是真判据。
  // 真正有判别力的是**反方向**：清单里提到的每个命令都必须真的存在，它守的是
  // "教群友敲一条已经不存在的命令"。
  const usage = String(await tell('.trpg'));
  const specs = EXTRA_REGISTRY.find((item) => item.id === 'trpg')?.commands ?? [];
  const declared = specs.flatMap((spec) => (spec.subs ?? []).length
    ? spec.subs.map((sub) => `${spec.names[0]} ${sub}`)
    : [spec.names[0]]);
  const absent = declared.filter((word) => !usage.includes('`' + word));
  ok('每个声明过的命令词形都在用法清单里（少一行不会有任何报错，表现只是群友看到的清单少一条）',
    absent.length === 0, absent.join('、') || `${declared.length} 个词形逐个查过`);
  // ⚠️ 判据对**带 subs 的那一族**必须比到第二个词：只认首词的话，`.trpg list` 这种"家族前缀对、
  // 子命令不存在"的条目会被放过 —— 而它正是这条断言要拦的东西（教群友敲一条敲不动的命令）。
  const families = new Set(specs.filter((spec) => (spec.subs ?? []).length).map((spec) => spec.names[0]));
  const stale = [...usage.matchAll(/`([^`]+)`/g)].map((match) => match[1].split(/\s+/))
    .filter((words) => {
      if (declared.includes(words.slice(0, 2).join(' '))) return false;
      if (families.has(words[0])) return true;
      return !declared.includes(words[0]);
    })
    .map((words) => words.join(' '));
  ok('对照：清单里提到的每个命令都真的声明过（留着一条已删掉的命令 = 教群友敲一条敲不动的命令）',
    stale.length === 0, stale.join('、') || '清单里提到的每一条都查过');
}

// ── 5h. 会话全链路（P2）：建团 → 报名 → 建卡 → 确认 → 开跑 → 收团 ──────────
//
// 这一段按**群友实际会怎么走**跑一遍：每一步都用不同的 senderId（身份是 QQ 号，决策 2），
// 所以它同时验了"谁的卡是谁的"这件事。
{
  const commands = createRuntime().commandHandlers;
  const route = routeIn(commands);
  const as = (qq, text) => {
    const key = route(text);
    if (typeof commands[key] !== 'function') return Promise.resolve(`（没有这条命令：${key}）`);
    return commands[key]({ chatKey: chain, senderId: qq, text, media: [], replyToMessageId: null });
  };
  const chain = 'group:p2-chain';
  const now = () => new TrpgStore().read(chain);
  const A = '20001'; const B = '20002';
  const journal = new JournalStore();

  ok('没有局时 `.trpg join` 说清先建局（而不是静默）',
    /\.trpg new/.test(String(await as(A, '.trpg join'))), String(await as(A, '.trpg join')));
  ok('没有局时 `.trpg start` 也说清先建局', /\.trpg new/.test(String(await as(A, '.trpg start'))));
  ok('没有局时 `.pc new` 也说清先建局', /\.trpg new/.test(String(await as(A, '.pc new 阿飞'))));

  const created = String(await as(A, '.trpg new 灯塔'));
  ok('`.trpg new` 建出 **`preparing`** 的一局，发起人自动进名单',
    now()?.status === 'preparing' && JSON.stringify(now()?.players) === JSON.stringify([A]), created);
  ok('回执把下一步写全了（`.trpg join` / `.pc new` / `.trpg start`）',
    /\.trpg join/.test(created) && /\.pc new/.test(created) && /\.trpg start/.test(created));

  ok('`preparing` 的 `.trpg status` 明说"准备中"（那是唯一一个还开不了跑的状态）',
    /准备中/.test(String(await as(B, '.trpg status'))), String(await as(B, '.trpg status')));
  // ⚠️ **只有玩家那份说是不够的**（2026-10-19 补）：模型那份原先一个字都不提状态，于是
  // `.trpg new` 之后群里随便说句话，DM 就可能开讲 —— 而 `preparing` 那道闸门存在的理由
  // 正是"卡没建完、没确认时不该开始"。
  ok('模型那一侧也看得到「准备中」（缺了它，`.trpg new` 之后 DM 会以为已经开跑了）',
    /准备中/.test(renderForModel(now())), renderForModel(now()).slice(0, 400));
  // `preparing` 时**不许**把 DM 引向 `restart`：那一档的局并没有在跑，而 restart 会清掉
  // 全队刚建好的卡。正确的下一步是"让群友敲 .trpg start"。
  const prepTool = await createRuntime().handlers.campaign(fakeCtx(chain), { action: 'start', title: '另一局' });
  ok('`campaign action=start` 在 `preparing` 局里被拒时说的是**还没开跑**，并把人指去 `.trpg start`',
    /还没开跑/.test(body(prepTool)) && /\.trpg start/.test(body(prepTool)), body(prepTool));
  ok('对照：那一档的拒绝话术里**不出现 restart**（照着做会清掉全队的卡）',
    !/restart/.test(body(prepTool)), body(prepTool));

  ok('第二个人 `.trpg join` 进得来', /已加入/.test(String(await as(B, '.trpg join'))));
  ok('重复 join 被拒，并说清为什么', /已经在这一局里/.test(String(await as(B, '.trpg join'))));
  ok('join 的人也进名单了', JSON.stringify(now()?.players) === JSON.stringify([A, B]));

  const early = String(await as(A, '.trpg start'));
  ok('**卡没建好时开不了跑**，而且**逐人**说清还差谁、下一步敲什么（不是一句"还有人不合格"）',
    /还差/.test(early) && early.includes(A) && early.includes(B) && /\.pc new/.test(early), early);

  const made = String(await as(A, '.pc new 阿飞'));
  ok('`.pc new` 建出**自己的**卡（`ownerId` = 敲命令的人），并停在"未确认"',
    now()?.characters.at(-1)?.ownerId === A && now()?.characters.at(-1)?.confirmed === false, made);
  ok('回执点明"定下来之后要 `.pc confirm`"', /\.pc confirm/.test(made), made);
  ok('`preparing` 时模型那份会标出**谁还没确认**（它替不了玩家点确认，但能催一句）',
    renderForModel(now()).includes('[还没确认]'), renderForModel(now()).slice(-500));
  // **没先 join 的人直接建卡，也要进名单** —— 不把"报名"与"建卡"分成两步（群友会漏掉
  // 前一步，而 `canActivate` 是按名单逐人查的，那张卡会落进"查不到这个人"的缝里）。
  const lazy = 'group:p2-lazy';
  await commands['.trpg new']({ chatKey: lazy, senderId: A, text: '.trpg new 懒人测试', media: [], replyToMessageId: null });
  await commands['.pc new']({ chatKey: lazy, senderId: '20077', text: '.pc new 直接建卡', media: [], replyToMessageId: null });
  ok('**没先 join 就建卡 → 也算报名**（名单按 QQ 号收，不用先敲 `.trpg join`）',
    JSON.stringify(new TrpgStore().read(lazy)?.players) === JSON.stringify([A, '20077']),
    JSON.stringify(new TrpgStore().read(lazy)?.players));
  ok('同一个人再建一次卡被拒（并说清改卡走哪条路）',
    /已经有一张卡/.test(String(await as(A, '.pc new 阿飞二号'))));
  ok('别人用同一个名字建卡也被拒（名字是唯一的键）',
    /已经有叫/.test(String(await as(B, '.pc new 阿飞'))));

  await as(B, '.pc new 小满');
  ok('两个人都建了卡之后，`start` 仍然拦住（**确认还没做**）',
    /还没确认/.test(String(await as(A, '.trpg start'))), String(await as(A, '.trpg start')));

  const confirmed = String(await as(A, '.pc confirm'));
  ok('`.pc confirm` 认自己的卡，并顺手报出还差谁', now()?.characters[0]?.confirmed === true
    && /还差/.test(confirmed) && confirmed.includes('小满'), confirmed);
  ok('重复确认说一句"已经确认过了"', /已经确认过/.test(String(await as(A, '.pc confirm'))));
  ok('没建卡的人 `.pc confirm` 被引导去 `.pc new`',
    /先敲 `.pc new/.test(String(await as('20009', '.pc confirm'))));

  await as(B, '.pc confirm');
  const started = String(await as(A, '.trpg start'));
  ok('全员确认之后 `.trpg start` 真的把这一局推成 **`active`**',
    now()?.status === 'active' && /开跑/.test(started), started);
  // 开跑之后群里会安静（`.trpg start` 不唤醒模型），所以回执要**告诉新手该干什么**。
  ok('`.trpg start` 的回执给出第一个动作的例子（"直接说话就行"对没跑过团的人等于没说）',
    /比如描述你的第一个行动/.test(started), started);
  ok('已经在跑时再 `.trpg start` 说一句"已经在跑了"', /已经在跑/.test(String(await as(A, '.trpg start'))));
  // 这次状态迁移对模型是**不可见**的（`.trpg start` 落成已读历史、不唤醒模型，而
  // `renderForModel` 只在 `preparing` 时多一行）—— 日志是它下一轮唯一的线索。
  ok('`.trpg start` 在日志里留下一条「开跑」（否则这一次迁移对模型完全不可见）',
    now()?.log.some((entry) => entry.kind === 'state' && entry.text.startsWith('开跑：')),
    JSON.stringify(now()?.log.slice(-2)));
  ok('那条「开跑」也进了战报（写盘之后镜像，与其余命令同形）',
    journal.read(chain).some((entry) => entry.text.startsWith('开跑：')),
    JSON.stringify(journal.read(chain).slice(-2)));
  ok('开了跑之后模型那份**不再**说「准备中」（两个状态在提示词里必须分得开）',
    !/准备中/.test(renderForModel(now())), renderForModel(now()).slice(0, 400));

  const mine = String(await as(A, '.pc show'));
  ok('`.pc show` 不带名字看的是**自己的**卡（标题与全群那份不同）',
    /【我的跑团卡】/.test(mine) && /阿飞/.test(mine) && !/小满/.test(mine) || /场上的人/.test(mine), mine.slice(0, 200));
  ok('`.pc show <别人>` 给的是**玩家视角**（与全群那份逐字同形）',
    /小满/.test(String(await as(A, '.pc show 小满'))));
  ok('`.pc show <不存在的名字>` 列出你见过的人，而不是一句"找不到"',
    /你见过的是/.test(String(await as(A, '.pc show 查无此人'))));
  ok('`.pc save` 给一份凭据（人数/卡数/旗标/记录）',
    /已保存这一局/.test(String(await as(A, '.pc save'))), String(await as(A, '.pc save')));

  // ── 收团 ──
  // "走过的场景"取的是**日志里的 scene 条目**（那才是走过的路），所以这里走一次 `appendLog`
  // 而不是直接改 `campaign.scene` —— 直接改字段只反映"此刻在哪"，摘要要的是轨迹。
  // 再塞一条暗线，好让"没解开的事"有东西。
  const withSecret = now();
  withSecret.flags['真凶是守塔人'] = { value: '是', visible: false };
  appendLog(withSecret, 'scene', '场景：灯塔一层·门厅');
  new TrpgStore().write(withSecret);

  // ── 工具那一路也要进战报 ──
  // 命令路与工具路各写各的落盘（命令自己 `store.write`，工具走 `withCampaign` 外壳），
  // 所以两条都要被钉住 —— 只钉一条的话另一条漏了镜像不会有任何报错。
  const beforeTool = journal.read(chain).length;
  await createRuntime().handlers.campaign(fakeCtx(chain), { action: 'scene', scene: '控制室' });
  ok('**工具路径的落盘也进战报**（`withCampaign` 那份镜像没漏）',
    journal.read(chain).length > beforeTool && /控制室/.test(journal.read(chain).at(-1).text),
    JSON.stringify(journal.read(chain).at(-1)));

  const ended = String(await as(A, '.trpg end'));
  ok('`.trpg end` 回的是**代码算出来的摘要**（时长/玩家/场景/没解开的事），不是让模型总结',
    /收团/.test(ended) && /阿飞（20001）/.test(ended) && /小满（20002）/.test(ended)
    && /灯塔一层·门厅/.test(ended) && /真凶是守塔人/.test(ended), ended);
  ok('收团**清掉了这一局的存档**（下一局才起得来 —— 否则只能靠 restart 清）',
    now() === null && /存档已经清掉/.test(ended));
  // 删的只是**存档**：剧本库与抽取产物以剧本为键，`.trpg end` 碰不到它们 ——
  // 不说的话"存档已经清掉"会被读成"连剧本也没了、下次还得重抽"。
  ok('回执说清"什么还在"：战报、剧本库与抽出来的结构都留着（下次用同一份剧本不用重抽）',
    /剧本库与它抽出来的结构也留着/.test(ended), ended);
  ok('没有局时再 `.trpg end` 说一句"没有在进行中的团"',
    /没有在进行中的团/.test(String(await as(A, '.trpg end'))));

  // ── 满员 ──
  const full = 'group:p2-full';
  await commands['.trpg new']({ chatKey: full, senderId: '30000', text: '.trpg new 满员测试', media: [], replyToMessageId: null });
  for (let i = 1; i < 8; i++) {
    await commands['.trpg join']({ chatKey: full, senderId: `3000${i}`, text: '.trpg join', media: [], replyToMessageId: null });
  }
  const overflow = String(await commands['.trpg join']({
    chatKey: full, senderId: '30099', text: '.trpg join', media: [], replyToMessageId: null
  }));
  ok('满员（8 人）之后 `.trpg join` 被拒，并把上限说出来',
    /已经满了/.test(overflow) && overflow.includes('8'), overflow);
  ok('满员时 `.pc new` 也进不来（名单满了就不该再落一张卡进"查不到这个人"的缝里）',
    /已经满了/.test(String(await commands['.pc new']({
      chatKey: full, senderId: '30099', text: '.pc new 挤一挤', media: [], replyToMessageId: null
    }))));

  // ── 旧存档迁移 ──
  const legacy = 'group:p2-legacy';
  const legacyFile = new TrpgStore().file(legacy);
  fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
  fs.writeFileSync(legacyFile, JSON.stringify({
    title: '老团', system: '', rule: 'generic', scene: '', scenario: { id: '', body: '' },
    flags: { 旧旗标: '是' }, characters: [{ name: '老卡', ownerId: '40001', hp: 5, hpMax: 5 }],
    log: [], seq: 1, createdAt: 1, updatedAt: 1
  }), 'utf8');
  const migrated = new TrpgStore().read(legacy);
  ok('**旧存档缺 `status` 一律读成 `active`**（升级不该把正在跑的团退回建卡阶段）',
    migrated?.status === 'active' && migrated?.players.length === 0 && migrated?.sessionId === '');
  ok('旧存档里的卡也读得回来，`confirmed` 缺省 false（不影响 `active` 的局）',
    migrated?.characters[0]?.name === '老卡' && migrated?.characters[0]?.confirmed === false);
  ok('旧形状的旗标照样迁成"玩家可见"（与既有的那条迁移同源）',
    migrated?.flags['旧旗标']?.visible === true);

  // ── 战报（P2 只落写侧） ──
  const lines = journal.read(chain);
  ok('战报真的落下来了：这一条链上每一步的日志都在（P2 起就在记，不必等 P6 的导出）',
    lines.length >= 5 && lines.some((line) => line.text.startsWith('开团：')), `共 ${lines.length} 条`);
  ok('战报里的 kind 认得出是掷骰/建卡/场景（它就是 `campaign.log` 的那个形状）',
    lines.some((line) => line.kind === 'state'), JSON.stringify(lines.map((line) => line.kind)));
  const again = journal.read(chain);
  ok('append-only：再读一次，前面的行**逐字不变**',
    JSON.stringify(again.slice(0, lines.length)) === JSON.stringify(lines));
  ok('**收团不清战报**（清掉的只是 `campaign.log` 那份环形缓冲）', journal.read(chain).length === lines.length);
}

// ── 5h2. 收团摘要的"走过的场景"只收 `场景：`（2026-10-19 修）────────────────────
//
// `kind:'scene'` 那一族里混着三种东西：`场景：X`、`开团：《X》`、以及
// `旗标：真凶是医生 = 是（暗线）`（`tools/campaign.ts` 的 `setFlags` 也记成 `scene`）。
// 原先靠"排除 `开团：`"来筛，于是**暗线旗标的名字被当成一处场景印进收团摘要**发进群 ——
// 一条真实的隐藏泄漏（勘察确认）。改成白名单前缀之后，将来再加一类 `scene` 日志也不会漏。
{
  const c = emptyCampaign('group:summary', { title: '摘要团', system: '', rule: 'generic' });
  appendLog(c, 'scene', '开团：《摘要团》 ｜ 检定规则：通用（掷高为佳）');
  appendLog(c, 'scene', '场景：码头');
  appendLog(c, 'scene', '旗标：真凶是医生 = 是（暗线）');
  appendLog(c, 'scene', '旗标-：旧线索');
  c.flags['真凶是医生'] = { value: '是', visible: false };
  const text = campaignSummary(c);
  // 判据要**只看"走过的场景"那一行**：暗线名字在本段的另一处（"没解开的事"）是**该印**的，
  // 拿整段去搜会让这条断言自相矛盾（第一版就是这么假红的）。
  const sceneLine = text.split('\n').find((line) => line.startsWith('走过的场景')) ?? '';
  ok('"走过的场景"**只收 `场景：` 开头**（暗线旗标名不许混进来）',
    /走过的场景：码头/.test(sceneLine) && !sceneLine.includes('真凶是医生') && !sceneLine.includes('旧线索'),
    text);
  ok('对照：`开团：` 也不进"走过的场景"（它本来就不是一处场景）', !text.includes('开团'), text);
  ok('"没解开的事"仍按设计列出暗线**名字**（收团时的仪式感，不是泄漏 —— 见文档的已知取舍）',
    /没解开的事（原本的暗线）：真凶是医生/.test(text), text);
}

// ── 5i. 检定与暗骰（P3）：.ra 公开 / .rh 暗骰 / .st 改属性 ─────────────────────
//
// 暗骰那一段会发一次**独立模型调用**（私密叙事），所以这里起假模型端点 —— 与 `suggest` /
// 剧本整理两条路同一个做法：验的是"真的走了那一步"，而不是拿桩子把它绕过去。
{
  const { updateConfig, getConfig } = await load('core/config.js');
  const model = await fakeModelServer({ model: 'stub-secret' });
  const previous = { ...getConfig().api };
  updateConfig({ api: { baseUrl: model.url, model: 'stub-secret' } });

  try {
    const K = 'group:p3-check';
    const A = '31001';
    const sent = [];
    /** 独立模型调用的用量交给宿主的那个口子（生产里接 `SessionRegistry.addExtraUsage`）。 */
    const usage = [];
    // **私聊端口是递进去的**（生产里 `web/app.ts` 接 `SendQueue`）—— 扩展只说"给谁、说什么"。
    const runtime = createRuntime({
      sendPrivate: async (qq, text) => { sent.push({ qq, text }); },
      recordUsage: (recorded) => usage.push(recorded)
    });
    const commands = runtime.commandHandlers;
    // ⚠️ 按**前两个词**路由（`.pc confirm` 的键是两截，见 `ExtraCommandSpec.subs`）——
    // 只取第一个词会落到裸 `.pc` 上，而那是个用法提示，测试会以"看起来没生效"假红。
    const route = routeIn(commands);
    const as = (text) => commands[route(text)]({
      chatKey: K, senderId: A, text, media: [], replyToMessageId: null
    });
    const store = new TrpgStore();
    const journal = new JournalStore();

    // 先开一局、建卡、填两个技能（走命令，顺带把前面几段的路再走一遍）。
    await commands['.trpg new']({ chatKey: K, senderId: A, text: '.trpg new 检定测试', media: [], replyToMessageId: null });
    await commands['.pc new']({ chatKey: K, senderId: A, text: '.pc new 阿飞', media: [], replyToMessageId: null });

    const stat = String(await as('.st 侦查 45'));
    ok('`.st` 给一张还没确认的卡填技能（这是 chargen 之外的手工路）',
      store.read(K)?.characters[0]?.stats['侦查'] === 45 && /侦查 = 45/.test(stat), stat);
    ok('`.st` 记进日志（状态变更都要留痕）',
      store.read(K)?.log.some((entry) => entry.text.includes('侦查：')), JSON.stringify(store.read(K)?.log.at(-1)));
    ok('`.st` 不带参数时列出卡上有什么（不是一句"用法"）',
      /侦查/.test(String(await as('.st'))));
    ok('`.st 侦查` 只给名字时回显当前值', /侦查 = 45/.test(String(await as('.st 侦查'))));
    ok('`.st` 的值不是数就说清楚（不静默）', /不是一个数/.test(String(await as('.st 侦查 难'))));
    const clamped = String(await as('.st 力量 99999'));
    ok('`.st` 与 `character` 用**同一套钳制**（99999 被夹到 MAX_STAT）',
      store.read(K)?.characters[0]?.stats['力量'] === 9999, clamped);

    // ── `.ra` 公开检定 ──
    const before = journal.read(K).length;
    const pub = String(await as('.ra 侦查'));
    ok('`.ra` 自动读卡上的技能值，回执与 `formatCheck` 逐字同形',
      /阿飞 的侦查：1d100 → \d+ = \d+ ｜ 对 45 → (成功|失败)/.test(pub), pub);
    ok('`.ra` 记进 `campaign.log` 的 `check` 类（那正是玩家视角要回看的东西）',
      store.read(K)?.log.at(-1)?.kind === 'check', JSON.stringify(store.read(K)?.log.at(-1)));
    ok('`.ra` 的日志也进战报', journal.read(K).length > before);

    ok('`.ra` 不带技能名时列出卡上有什么，并给出 `.r` 这条替代路',
      /你卡上有/.test(String(await as('.ra'))) && /\.r /.test(String(await as('.ra'))));
    ok('**卡上没有这个技能**时列出有的那些（清单 30，不是一句"没有"）',
      /你卡上没有【?「?游泳/.test(String(await as('.ra 游泳'))) && /侦查/.test(String(await as('.ra 游泳'))),
      String(await as('.ra 游泳')));
    ok('**没建卡的人** `.ra` 被引导去 `.pc new`（清单 29）',
      /先敲 `.pc new/.test(String(await commands['.ra']({
        chatKey: K, senderId: '31099', text: '.ra 侦查', media: [], replyToMessageId: null
      }))));
    ok('**没有战役**时 `.ra` 被引导去 `.trpg new`', /\.trpg new/.test(String(await commands['.ra']({
      chatKey: 'group:p3-none', senderId: A, text: '.ra 侦查', media: [], replyToMessageId: null
    }))));
    // 对照：`.ra` 纯代码掷骰，一次模型调用都不发 —— 所以此刻一个用量都不该记。
    // 少了它，"下面那条用量断言"在"`.ra` 顺手也发了一次调用"时照样是绿的。
    ok('`.ra` 不发起模型调用，因此用量一个都没记（对照）', usage.length === 0, JSON.stringify(usage));

    // ── `.rh` 暗骰 ──
    model.requests = [];
    model.script = [{ content: '你屏住呼吸，指尖在桌沿上停了一瞬 —— 有什么地方不对劲，但你说不上来。' }];
    const secretReceipt = String(await as('.rh 侦查'));
    ok('**`.rh` 在群里那句话逐字不含点数**（那是暗骰的全部意义）',
      secretReceipt === '暗骰结果已私聊发送 —— 点开和我的私聊看。', secretReceipt);
    ok('`.rh` 把点数**私聊**发给了掷骰的人（收件人是那个 QQ 号）',
      sent.length === 1 && sent[0].qq === A && /1d100 → \d+ = \d+/.test(sent[0].text), JSON.stringify(sent));
    ok('`.rh` 那段私密叙事来自**一次独立模型调用**（提示词在 `EXTRA_PROMPT_JOBS.trpg.secretRoll`）',
      model.requests.length === 1 && /暗骰/.test(JSON.stringify(model.requests[0].messages))
      && /不对劲/.test(sent[0].text), JSON.stringify(sent[0].text.slice(0, 120)));
    ok('**暗骰不留痕**：不写 `campaign.log`、也不进战报（决策 7）',
      !store.read(K)?.log.some((entry) => entry.text.includes('暗骰'))
      && !journal.read(K).some((line) => line.text.includes('暗骰')),
      JSON.stringify(store.read(K)?.log.at(-1)));
    // 那一次叙事调用的用量**记进账**（2026-10-17 补的缺口）：它发生在 `finish()` 之后，
    // 借不了会话那条记账路，所以走 `recordUsage` → `SessionRegistry.addExtraUsage`。
    // 假端点恒定回 `{prompt:10, completion:5, total:15}`，所以这里能逐字段钉死。
    ok('`.rh` 那次独立模型调用的用量**交宿主的 `recordUsage`**（不是只打一行日志）',
      usage.length === 1 && usage[0].promptTokens === 10 && usage[0].completionTokens === 5
      && usage[0].totalTokens === 15 && usage[0].cachedTokens === 0, JSON.stringify(usage));

    // 模型抽风时只发点数：暗骰不该因为叙事失败而失败。
    sent.length = 0;
    model.script = [{ content: '' }];
    const degraded = String(await as('.rh 侦查'));
    ok('叙事生成失败时**照发点数**（旁路失败不该让这次暗骰丢掉）',
      degraded === secretReceipt && sent.length === 1 && /1d100 →/.test(sent[0].text), degraded);
    // 判据是"**发过一次调用**"，不是"拿到了一段叙事"：那一次真的花了钱，
    // 把 `recordUsage` 挪进 `if (narration)` 里就会让它悄悄漏账。
    ok('叙事为空的那一次**也照记用量**（记账认的是调用，不是结果）',
      usage.length === 2, JSON.stringify(usage));

    // 没装私聊端口时**先说不掷** —— 掷了却发不出去等于把这次暗骰丢了。
    const bare = createRuntime();
    const beforeBare = new TrpgStore().read(K)?.log.length ?? 0;
    const noChannel = String(await bare.commandHandlers['.rh']({
      chatKey: K, senderId: A, text: '.rh 侦查', media: [], replyToMessageId: null
    }));
    ok('**没装私聊通道时不掷**，并且如实说一句（而不是掷完才发现发不出去）',
      /没装私聊通道/.test(noChannel) && (new TrpgStore().read(K)?.log.length ?? 0) === beforeBare, noChannel);

    // ── 确认之后归 DM ──
    await as('.pc confirm');
    ok('`.st` 在**确认之后被拒**（那张卡定下来了，改数值归 DM）',
      /已经确认过/.test(String(await as('.st 侦查 90')))
      && store.read(K)?.characters[0]?.stats['侦查'] === 45);
    ok('`.ra` 在确认之后照常能用（确认管的是改卡，不是掷骰）', /对 45/.test(String(await as('.ra 侦查'))));
  } finally {
    updateConfig({ api: previous });
  }
}

// ── 5j. 属性生成（P4）：`.pc roll` 与派生值的落点 ─────────────────────────────
//
// 掷法本身在 `t-trpg-rules.mjs` 里逐面钉着（那是纯函数层）；这一段管的是**接线**：
// 掷出来的东西有没有写进卡、有没有进日志、三份视野里认不认它、以及"不支持时说不支持"。
{
  const runtime = createRuntime();
  const commands = runtime.commandHandlers;
  const route = routeIn(commands);
  const K = 'group:p4-chargen';
  const A = '41001';
  const as = (text, qq = A, key = K) => commands[route(text)]({
    chatKey: key, senderId: qq, text, media: [], replyToMessageId: null
  });
  const at = (text, key) => commands[route(text)]({
    chatKey: key, senderId: A, text, media: [], replyToMessageId: null
  });

  // COC7 那一栏在规则表里，所以这里显式选它。
  await at('.trpg new 属性测试 coc7', K);
  await as('.pc new 阿飞');

  const rolled = String(await as('.pc roll'));
  const afterRoll = new TrpgStore().read(K);
  const card = afterRoll.characters[0];
  ok('`.pc roll` 掷出八个属性并写进卡',
    Object.keys(card.stats).length === 8 && typeof card.stats.STR === 'number', JSON.stringify(card.stats));
  ok('派生值也写进卡了（HP / MP / SAN / DB / Build / MOV）',
    card.hpMax > 0 && card.mpMax > 0 && card.sanMax > 0 && card.db !== ''
    && typeof card.build === 'number' && card.mov > 0,
    JSON.stringify({ hp: card.hpMax, mp: card.mpMax, san: card.sanMax, db: card.db, build: card.build, mov: card.mov }));
  ok('刚掷完是满的（当前值跟着上限走 —— 掷属性等于新建一个人）',
    card.hp === card.hpMax && card.mp === card.mpMax && card.san === card.sanMax);
  // ⚠️ **判据必须是"按公式算出来的那个数"，不是"大于 0"**：`.pc new` 就已经给了 10 点 HP，
  // 所以"有没有写派生值"这件事，只有把结果与公式对上才验得出来（探针实测：把掷属性那一步
  // 里写 `hpMax` 的那一行拆掉，只查 `> 0` 的断言**照样全绿**）。
  ok('派生值是**按公式从刚掷出的属性算的**（HP=(CON+SIZ)/10、MP=POW/5、SAN=POW）',
    card.hpMax === Math.max(1, Math.floor((card.stats.CON + card.stats.SIZ) / 10))
    && card.mpMax === Math.floor(card.stats.POW / 5)
    && card.sanMax === card.stats.POW,
    JSON.stringify({ stats: { CON: card.stats.CON, SIZ: card.stats.SIZ, POW: card.stats.POW },
      got: { hp: card.hpMax, mp: card.mpMax, san: card.sanMax } }));
  ok('回执把属性与派生都念出来（群友不必自己算）',
    /STR \d+/.test(rolled) && /派生：/.test(rolled) && /DB /.test(rolled) && /MOV \d/.test(rolled), rolled);
  ok('回执告诉你可以重掷', /再敲一次/.test(rolled), rolled);
  ok('掷属性记进日志（状态变更都要留痕）',
    afterRoll.log.at(-1)?.kind === 'state' && /掷属性/.test(afterRoll.log.at(-1)?.text ?? ''),
    JSON.stringify(afterRoll.log.at(-1)));
  ok('**确认之前可以重掷**', /已掷出/.test(String(await as('.pc roll'))));

  // ── 三份视野都认这几个新字段 ──
  const mine = String(await as('.pc show'));
  ok('玩家视角带上 MP / DB / Build / MOV',
    /MP \d+\/\d+/.test(mine) && /DB /.test(mine) && /MOV \d/.test(mine), mine);
  const dmView = runtime.prompt(K).body[2];
  ok('DM 那份也带上（它得知道这个人打得疼不疼）',
    /MP \d+\/\d+/.test(dmView) && /DB /.test(dmView), dmView.slice(0, 400));

  const hideStore = new TrpgStore();
  const hidden = hideStore.read(K);
  hidden.characters[0].hidden = ['pools', 'stats'];
  hideStore.write(hidden);
  const masked = String(await as('.pc show'));
  ok('`pools` 藏起来时 **MP 也变 `???`**（它和 HP/SAN 是同一类东西）', /MP \?\?\?/.test(masked), masked);
  ok('`stats` 藏起来时 DB / Build / MOV **一起藏**（藏属性却露 DB 等于没藏）',
    /属性\/技能 \?\?\?/.test(masked) && !/DB /.test(masked), masked);

  // ── "不支持"要说出来 ──
  const G = 'group:p4-generic';
  await at('.trpg new 通用测试 generic', G);
  await at('.pc new 阿飞', G);
  const noChargen = String(await at('.pc roll', G));
  ok('规则表**没有** `chargen` 时如实说一句，并给出 `.st` 这条替代路（不许硬塞一套出来）',
    /没有属性生成/.test(noChargen) && /\.st /.test(noChargen), noChargen);
  ok('没卡的人 `.pc roll` 被引导去 `.pc new`',
    /先敲 `.pc new/.test(String(await commands['.pc roll']({
      chatKey: G, senderId: '41099', text: '.pc roll', media: [], replyToMessageId: null
    }))));

  // ── MP 也归代码管（工具那一路）──
  //
  // 每次 `update` 都换一个 `ctx`：行动经济按 `ctx` 记账，同一个 ctx 第二次会被配额拦下
  // （那是另一段的事，这里要的是"MP 能扣、`full` 能回满"）。
  const handlers = createRuntime().handlers;
  const before = new TrpgStore().read(K)?.characters[0]?.mp ?? 0;
  const cut = await handlers.character(fakeCtx(K), { action: 'update', name: '阿飞', mpDelta: -3 });
  ok('MP 能被扣（`mpDelta`），回执里带上当前 MP',
    new TrpgStore().read(K)?.characters[0]?.mp === Math.max(0, before - 3) && /MP \d+\/\d+/.test(String(cut.content)),
    String(cut.content));
  ok('**MP 的变化进了日志**（工具回执给的是"现在多少"，日志记的是"从多少变到多少"）',
    /MP \d+→\d+/.test(new TrpgStore().read(K)?.log.at(-2)?.text ?? '')
    || /MP \d+→\d+/.test(new TrpgStore().read(K)?.log.at(-1)?.text ?? ''),
    JSON.stringify(new TrpgStore().read(K)?.log.slice(-2)));
  const refill = await handlers.character(fakeCtx(K), { action: 'update', name: '阿飞', full: true });
  ok('`full` 回满时 **MP 一起回满**（它也是"回满"该管的东西）',
    new TrpgStore().read(K)?.characters[0]?.mp === new TrpgStore().read(K)?.characters[0]?.mpMax,
    String(refill.content));
  const withMp = await handlers.character(fakeCtx(K), { action: 'create', name: '小满', mpMax: 12 });
  // ⚠️ 判"没出错"要写 `!== true`：`ok()` 返回的是 `{ content }`，成功时**根本没有 `isError`**
  // （只有 `err()` 才带上它）。写成 `=== false` 的断言永远红。
  ok('MP 上限也能在建卡时给（`mpMax`）',
    withMp.isError !== true && new TrpgStore().read(K)?.characters.at(-1)?.mpMax === 12
    && /MP 12\/12/.test(String(withMp.content)),
    JSON.stringify([withMp, new TrpgStore().read(K)?.characters.map((c) => [c.name, c.mpMax])]));

  // ── 确认之后不能重掷 ──
  await as('.pc confirm');
  ok('确认之后不能重掷（那张卡定下来了）', /已经确认过/.test(String(await as('.pc roll'))));

  // ── 重掷会**整份替换** `stats`：顶掉了旧值就要说出来（2026-10-19 加）──
  //
  // 重掷本身是正当的（"掷到满意为止"是这类游戏的常规玩法），坏的只是"没人知道刚才那次覆盖了
  // 什么"：主持人手工给的技能、玩家用 `.st` 填的那几项会悄无声息地消失，而回执一字不提。
  const K2 = 'group:p4-replace';
  const as2 = (line, key = K2) => commands[route(line)]({
    chatKey: key, senderId: A, text: line, media: [], replyToMessageId: null
  });
  await as2('.trpg new 覆盖测试 coc7');
  await as2('.pc new 阿飞');
  await as2('.st 侦查 45');
  const first = String(await as2('.pc roll'));
  ok('第一次重掷：卡上原有 1 项 → 回执**明说被顶掉了**',
    /顶掉了卡上原有的 1 项/.test(first), first);
  ok('第二次重掷：现在卡上是一整套（8 项）→ 数字跟着变（不是写死的一句）',
    /顶掉了卡上原有的 8 项/.test(String(await as2('.pc roll'))));
  // 负对照必须**真的开一局并建卡**：拿一个"还没有局"的会话去掷，回的是那句开局提示，
  // 断言照样绿 —— 那是假绿。
  const K3 = 'group:p4-fresh';
  await as2('.trpg new 全新 coc7', K3);
  await as2('.pc new 阿飞', K3);
  const fresh = String(await as2('.pc roll', K3));
  ok('负对照：**第一次**掷属性（卡上一个数都没有）不提这件事 —— 那时没有任何东西被顶掉',
    /已掷出/.test(fresh) && !/顶掉了卡上原有的/.test(fresh), fresh);
}

// ── 5k. 战斗（P5）：先攻、回合指针，以及"行动即推进" ─────────────────────────
//
// 排序本身的**定值断言**在 `t-trpg-rules.mjs` §15（注入脚本化随机源，逐面核对谁排第几）。
// 这一段管**接线**，而接线里有三处是别的东西看不见的：
//   ① **两条路各写各的落盘**（命令 `.combat` 与工具 `campaign action=combat`），所以两条都要钉；
//   ② **先攻数值只给模型**（它等于卡上的属性，而 `hidden: ['stats']` 存在的理由就是藏属性）；
//   ③ `tools/shared.ts` 的 `acted` 那条缝（行动被消费 → 指针前进）—— 它只在闸门与 `withCampaign`
//      之间有代码，删掉它不会有任何别的套件变红。
{
  const runtime = createRuntime();
  const commands = runtime.commandHandlers;
  const route = routeIn(commands);
  const K = 'group:p5-cmd';
  const as = (text, qq = '51001') => commands[route(text)]({
    chatKey: K, senderId: qq, text, media: [], replyToMessageId: null
  });
  const combat = () => new TrpgStore().read(K)?.combat ?? null;

  // ── 三条"做不了"分开说 ──
  ok('没开局时 `.combat start` 引导去 `.trpg new`（而不是给一句看不懂的话）',
    /还没有开局/.test(String(await as('.combat start'))) && /\.trpg new/.test(String(await as('.combat start'))));

  await as('.trpg new 战斗测试 coc7');
  ok('一张卡都没有时 `.combat start` 明说"没有可以参战的人"并给出建卡那一步',
    /没有可以参战的人/.test(String(await as('.combat start')))
    && /\.pc new/.test(String(await as('.combat start'))));

  // ── 建三个人（走玩家真敲的那条路：`.pc new` + `.st`）──
  // 先攻值取 87 / 63 / 41：**多位数**才验得出"回执里没印那个数"（一位数会和序号撞上）。
  // ⚠️ 一人一个 QQ 号：`.pc new` 是"给自己建卡"，同一个人敲第二次只会得到"你已经有一张卡了"。
  let qq = 51001;
  for (const [name, dex] of [['甲', 87], ['乙', 63], ['丙', 41]]) {
    await as(`.pc new ${name}`, String(qq));
    await as(`.st DEX ${dex}`, String(qq));
    qq += 1;
  }
  // 一张**玩家还没见过**的卡：顺序是公开的（要发进群、进玩家笔记），所以它不该出现在里面。
  await handlers.character(fakeCtx(K), { action: 'create', name: '线人', visible: false, stats: { DEX: 99 } });

  const started = String(await as('.combat start'));
  const after = combat();
  ok('`.combat start` 按规则表声明的属性排一次先攻，落进存档（第 1 轮、指针在第一个）',
    after?.key === 'DEX' && after.order.length === 3 && after.turn === 0 && after.round === 1,
    JSON.stringify(after));
  ok('**玩家还没见过的人不进先攻序**（顺序是公开的 —— 排进去就是把幕后的人说出来了）',
    !after.order.includes('线人'), JSON.stringify(after.order));
  ok('回执把顺序念出来，并点名"轮到谁"',
    /先攻（按 DEX）：/.test(started) && after.order.every((name) => started.includes(name))
    && started.includes(`第 1 轮，轮到「${after.order[0]}」。`), started);
  // ⚠️ **这一条是本段的重点**：先攻值就是卡上的属性，而 `hidden: ['stats']` 存在的理由正是藏属性。
  // 印进群等于悄悄把藏起来的东西说出去，且没有任何报错。
  ok('**回执里不印先攻数值**（只印名字与序号）',
    !started.includes('87') && !started.includes('63') && !started.includes('41'), started);
  const startLog = new TrpgStore().read(K).log.at(-1);
  ok('日志只留**名字顺序**的一行，也不印数值（日志会镜像进战报，而战报以后要发进群）',
    /先攻（按 DEX）：/.test(startLog.text) && !startLog.text.includes('\n')
    && !startLog.text.includes('87') && !startLog.text.includes('63'), JSON.stringify(startLog));

  // ── 再排一次 = 重排（中途加人的唯一办法）──
  const restarted = String(await as('.combat start'));
  ok('再排一次 = 重排（不拒绝 —— 拒绝会让 DM 在"有人来晚了"时卡住），且回执把这件事说出来',
    /重排/.test(restarted) && /第 1 轮/.test(restarted), restarted);

  // ── 推进 ──
  const before = combat();
  const next = String(await as('.combat next'));
  const moved = combat();
  ok('`.combat next` 把指针往前推一格（轮次不变）',
    moved.turn === (before.turn + 1) % 3 && moved.round === before.round, JSON.stringify([before, moved]));
  ok('回执点名新的行动者，并附一条紧凑的顺序', /轮到「/.test(next) && /顺序：/.test(next), next);

  // ── 倒下的人不占回合 ──
  const withDown = new TrpgStore().read(K);
  withDown.characters.find((c) => c.name === '乙').hp = 0;
  new TrpgStore().write(withDown);
  const rerolled = String(await as('.combat start'));
  ok('**倒下的卡不进先攻序**（`isMobile`：HP 掉到 0 的人不该占一个回合位）',
    !(combat()?.order ?? []).includes('乙') && (combat()?.order ?? []).length === 2, JSON.stringify(combat()));
  ok('重排时倒下的人也不出现在回执里', !rerolled.includes('乙'), rerolled);

  // ── 收场 ──
  ok('`.combat end` 收场', /战斗结束/.test(String(await as('.combat end'))) && combat() === null);
  ok('没有战斗时再收一次、或直接 next，都明说"现在没有在进行中的战斗"',
    /现在没有在进行中的战斗/.test(String(await as('.combat end')))
    && /先敲 `.combat start`/.test(String(await as('.combat next'))));

  // ── 认不出的子命令落到裸 `.combat` 上，回用法清单（不静默）──
  const bare = String(await as('.combat'));
  ok('裸 `.combat` 回用法清单（三条子命令各自一行）',
    /\.combat start/.test(bare) && /\.combat next/.test(bare) && /\.combat end/.test(bare), bare);
  ok('敲错的子命令**不静默**：落到裸 `.combat` 上回用法（静默的话群友不知道自己为什么没生效）',
    /\.combat start/.test(String(await as('.combat 乱写'))));
}

// ── 5l. 战斗（P5）：工具那一路，以及"行动被消费 → 指针前进" ───────────────────
//
// 两条路（命令 / 工具）**各写各的落盘**，所以上一条钉完命令，这里还要钉工具。
// 工具用注入的定值随机源（文件顶部那份共享 `handlers`），于是顺序是**可预期的**：
// 平手判据全相同 ⇒ 按名单顺序。
{
  const K = 'group:p5-tool';
  const started = await call('campaign', fakeCtx(K), { action: 'start', title: '工具路', rule: 'coc7' });
  ok('工具路也能开局（对照：下面几条不是空转的绿）', started.isError !== true, String(started.content));

  // 先攻值刻意不同 ⇒ 顺序可预期（丙 30 > 甲 20 > 乙 10）。
  for (const [name, dex] of [['甲', 20], ['乙', 10], ['丙', 30]]) {
    await call('character', fakeCtx(K), { action: 'create', name, stats: { DEX: dex } });
  }
  const roll = await call('campaign', fakeCtx(K), { action: 'combat', sub: 'start' });
  const view = store.read(K).combat;
  ok('工具路排出的顺序与卡上的属性一致（丙 30 → 甲 20 → 乙 10）',
    JSON.stringify(view.order) === JSON.stringify(['丙', '甲', '乙']), JSON.stringify(view));
  ok('**给模型的那一份带先攻数值**（它本来就看得到全量状态，叙事时心里要有数）',
    /1\. 丙 30/.test(body(roll)) && /2\. 甲 20/.test(body(roll)) && /3\. 乙 10/.test(body(roll)), body(roll));
  ok('工具回执也点名当前行动者与轮次', /第 1 轮，轮到「丙」/.test(body(roll)), body(roll));

  ok('`sub=next` 推进并回一行摘要',
    /轮到「甲」/.test(body(await call('campaign', fakeCtx(K), { action: 'combat', sub: 'next' }))));
  ok('`sub=end` 收场，再收一次给一句"不用收场"',
    /收场/.test(body(await call('campaign', fakeCtx(K), { action: 'combat', sub: 'end' })))
    && /没有在进行中的战斗/.test(body(await call('campaign', fakeCtx(K), { action: 'combat', sub: 'end' }))));
  ok('`sub` 写错时把三个合法取值都列出来（`required` 不能按 action 分支，只能靠文案补救）',
    /sub 只能是 start \/ next \/ end/.test(body(await call('campaign', fakeCtx(K), { action: 'combat', sub: 'x' }))));
  ok('没开局时 `campaign action=combat` 走的是"先开局"那句话（同其余 action）',
    /还没有开局/.test(body(await call('campaign', fakeCtx('group:p5-none'), { action: 'combat', sub: 'start' }))));
}

// ── 5m. 战斗（P5）：行动被消费 → 指针前进（`acted` 那条缝）──────────────────
{
  const K = 'group:p5-act';
  await call('campaign', fakeCtx(K), { action: 'start', title: '推进', rule: 'coc7' });
  for (const [name, dex] of [['甲', 20], ['乙', 10], ['丙', 30]]) {
    await call('character', fakeCtx(K), { action: 'create', name, stats: { DEX: dex } });
  }
  await call('campaign', fakeCtx(K), { action: 'combat', sub: 'start' });
  const at = () => store.read(K).combat;

  ok('排好之后指针在「丙」', at().turn === 0 && at().round === 1, JSON.stringify(at()));

  // ── 当前行动者**真的做了事** → 指针自己往前走 ──
  const ctx1 = fakeCtx(K);
  await call('roll', ctx1, { expr: '1d6', actor: '丙', reason: '先攻后的第一次' });
  ok('**当前行动者掷了一次骰 → 指针前进一格**（不必 DM 每次去敲 next）',
    at().turn === 1 && at().round === 1, JSON.stringify(at()));

  // ── 别人做事不推 ──
  await call('roll', fakeCtx(K), { expr: '1d6', actor: '乙', reason: '别人' });
  ok('**不是当前行动者的人做事不推**（否则"玩家掷一次骰、DM 给敌人记伤害"会连推两格）',
    at().turn === 1, JSON.stringify(at()));

  // ── 被拒的那一次不推 ──
  const ctx2 = fakeCtx(K);
  await call('roll', ctx2, { expr: '1d6', actor: '甲', reason: '重掷' });
  const afterFirst = at().turn;
  const dup = await call('roll', ctx2, { expr: '1d6', actor: '甲', reason: '重掷' });
  ok('同一轮里参数完全相同的第二次掷骰被拒（既有断言），**指针也不动**',
    /已经做过这件事/.test(body(dup)) && at().turn === afterFirst, JSON.stringify(at()));

  // ── ⚠️ 一次运行只推一格（`acted` 在 `withCampaign` 里读完即清）──
  //
  // 判据必须让"没清空"真的多推一格，否则这条是假的绿。构造：顺序只剩两个人、**后面那个倒下了**，
  // 于是推一格会绕回原处 —— 此时"上一轮留下的名字"与"当前行动者"恰好是同一个。
  const W = 'group:p5-act2';
  await call('campaign', fakeCtx(W), { action: 'start', title: '绕圈', rule: 'coc7' });
  for (const [name, dex] of [['甲', 20], ['乙', 10]]) {
    await call('character', fakeCtx(W), { action: 'create', name, stats: { DEX: dex } });
  }
  await call('campaign', fakeCtx(W), { action: 'combat', sub: 'start' });
  const down = store.read(W);
  down.characters.find((c) => c.name === '乙').hp = 0;
  store.write(down);
  const ctx3 = fakeCtx(W);
  await call('character', ctx3, { action: 'update', name: '甲', hpDelta: -1 });
  const wrapped = store.read(W).combat;
  ok('顺序里后面那个倒下时，推一格会绕回起点（第 2 轮、还是甲）—— 这是下面那条的前提',
    wrapped.turn === 0 && wrapped.round === 2, JSON.stringify(wrapped));
  // 同一次运行里的第二次调用**没有**消费任何人的主行动（不填 actor 的掷骰不占配额），
  // 所以它不该再推一格。没清空 `acted` 的话，上一次留下的「甲」会被当成"他又动了"。
  await call('roll', ctx3, { expr: '1d6', reason: '不占配额的掷骰' });
  ok('**同一次运行里不会因为上一轮留下的名字多推一格**（`acted` 读完即清）',
    store.read(W).combat.round === 2, JSON.stringify(store.read(W).combat));

  // ── 指针停在倒下的人身上时无条件推进 ──
  const D = 'group:p5-act3';
  await call('campaign', fakeCtx(D), { action: 'start', title: '倒下', rule: 'coc7' });
  for (const [name, dex] of [['甲', 30], ['乙', 20], ['丙', 10]]) {
    await call('character', fakeCtx(D), { action: 'create', name, stats: { DEX: dex } });
  }
  await call('campaign', fakeCtx(D), { action: 'combat', sub: 'start' });
  // 直接改存档（不走工具）：**走工具的话这次调用本身就会推指针**，前提就没了。
  const killed = store.read(D);
  killed.characters.find((c) => c.name === '甲').hp = 0;
  store.write(killed);
  await call('roll', fakeCtx(D), { expr: '1d6', actor: '丙', reason: '别人做事' });
  ok('**指针停在倒下的人身上时无条件推进**（否则它会一直停在尸体上，直到谁想起来敲 next）',
    store.read(D).combat.turn === 1 && store.read(D).combat.round === 1, JSON.stringify(store.read(D).combat));
}

// ── 5n. 战斗（P5）：两份视野各认它，且玩家那份不泄漏 ────────────────────────
{
  const runtime = createRuntime();
  const commands = runtime.commandHandlers;
  const route = routeIn(commands);
  const K = 'group:p5-render';
  const as = (text, qq = '52001') => commands[route(text)]({
    chatKey: K, senderId: qq, text, media: [], replyToMessageId: null
  });
  await as('.trpg new 视野测试 coc7');
  // 一人一个 QQ 号（同 §5k）；DEX 各不相同 ⇒ 顺序**确定**（87 > 63 > 41），
  // 于是下面可以按名字断言，而且"战斗段里没有数值"这条才有判别力（属性段真的印着那三个数）。
  let qq = 52001;
  for (const [name, dex] of [['甲', 87], ['乙', 63], ['丙', 41]]) {
    await as(`.pc new ${name}`, String(qq));
    await as(`.st DEX ${dex}`, String(qq));
    qq += 1;
  }

  ok('**没在打时整段不出现**（不是印一句"当前没有战斗" —— 那句话每轮都进 system prompt 却不带信息）',
    !/—— 战斗（第/.test(runtime.prompt(K).body[2]));

  await as('.combat start');
  const dm = runtime.prompt(K).body[2];
  const order = new TrpgStore().read(K).combat.order;
  // ⚠️ **断言必须只落在战斗段里**：`DEX 87` 在属性段、在日志里都**本来就该出现**
  // （属性默认可见，`hidden: ['stats']` 才是藏它的手段）。整段搜数字只会永远命中。
  const blockOf = (text) => {
    const at = text.indexOf('—— 战斗（');
    if (at < 0) return '';
    const rest = text.slice(at);
    const end = rest.indexOf('\n—— ');
    return end < 0 ? rest : rest.slice(0, end);
  };
  ok('模型那份带战斗段：第几轮、按什么属性排、轮到谁、顺序',
    JSON.stringify(order) === JSON.stringify(['甲', '乙', '丙'])
    && /—— 战斗（第 1 轮，按 DEX 排的先攻）——/.test(dm)
    && dm.includes('轮到「甲」。') && blockOf(dm).includes('1. 甲'), dm.slice(-400));
  ok('模型那份的战斗段**不重复印先攻数值**（属性段已经印过了，再印一遍是白占前缀）',
    /DEX 87/.test(dm) && !/87/.test(blockOf(dm)), blockOf(dm));

  const shown = renderForPlayers(new TrpgStore().read(K));
  ok('玩家那份也有战斗段（顺序是公开的，谁先动在桌上藏不住），但**战斗段里一个数值都不印**',
    /—— 战斗（第 1 轮）——/.test(shown) && shown.includes('轮到「甲」。')
    && !/87|63|41/.test(blockOf(shown)), blockOf(shown));

  // ── 倒下的人标出来 ──
  const down = new TrpgStore().read(K);
  down.characters.find((c) => c.name === '乙').hp = 0;
  new TrpgStore().write(down);
  ok('倒下的人在玩家那份里标「（倒下）」（群友得看得出这个人不占回合了）',
    /乙（倒下）/.test(renderForPlayers(new TrpgStore().read(K))));

  // ── ⚠️ 当前行动者被藏起来时，"轮到「X」"那句也要跟着消失 ──
  //
  // 只滤名单、照印"轮到「X」"的话，等于用一个名字把刚藏起来的人说出来了 —— 而且**没有任何报错**。
  const hide = new TrpgStore().read(K);
  hide.characters.find((c) => c.name === '甲').discovered = false;
  new TrpgStore().write(hide);
  const masked = renderForPlayers(new TrpgStore().read(K));
  ok('**当前行动者还没被玩家见过时，"轮到「X」"那句整句不出现**（只滤名单等于用一个名字把他漏出去）',
    /—— 战斗（第 1 轮）——/.test(masked) && !masked.includes('轮到「甲」')
    && !masked.includes('甲'), masked);
  ok('对照组：模型那一份**照样**看得到他（藏的是玩家，不是 DM）',
    runtime.prompt(K).body[2].includes('轮到「甲」'));

  // ── 命令这条路：开打之后被藏起来的人**也不许**印名字（2026-10-19 修）──
  //
  // `startCombat` 建序时按 `discovered` 滤过一遍，但 DM 完全可以在开打之后把某人改成
  // `visible:false`。那时玩家视角（`.trpg status` → `combatLines`）会滤掉他，而这一族命令
  // 原先**照印** —— 同一份状态、两个地方两个答案，且没有任何报错。
  const afterHide = String(await as('.combat next'));
  ok('`.combat next` 与玩家视角同源：被藏起来的人不出现在"轮到"与顺序里',
    !afterHide.includes('甲') && /轮到「/.test(afterHide), afterHide);

  // 再把**剩下的人都藏起来**：这时"轮到「X」"与顺序都要**整句不出现**
  // （只滤名单、照印那一句，等于用一个名字把刚藏起来的人说出来）。
  const hideMore = new TrpgStore().read(K);
  for (const card of hideMore.characters) card.discovered = false;
  new TrpgStore().write(hideMore);
  const allHidden = String(await as('.combat next'));
  ok('所有参战者都被藏起来时，回执里一个名字都不出现（也不是印出一个空壳）',
    !allHidden.includes('轮到') && !/甲|乙|丙/.test(allHidden), allHidden);
}

// ── 5o. 战报的可见性（P6）：藏起来的东西不进战报 ─────────────────────────────
//
// 战报会被导出成一份文件**发进群**，所以它必须只含公开事件 —— 而 `campaign.log` 的 `state`
// 与 `scene` 两类里混着 DM 的记账：暗线旗标的名字、"玩家尚未见过"、`隐藏：pools/notes`。
// 判据落在**写那条日志的人**身上（`TrpgLogEntry.visible`），`mirrorLog` 据此挡下。
// 这一段钉的就是"哪几处标了、标得对不对" —— 漏一处不会有任何报错，只会把暗线发进群。
{
  const K = 'group:p6-journal';
  const runtime = createRuntime();
  const journal = new JournalStore();
  const ctx = () => fakeCtx(K);
  /** 战报的正文（把这一局的战报当成一整个字符串看）。 */
  const seen = () => journal.read(K).map((entry) => entry.text).join('\n');

  // `title` 是必填的（见 §5h 那条早退断言）—— 少了它 `start` 会回一句 err，于是这一段
  // 后面**每一条**都会"绿"（战报里什么都没有，负向断言自然成立）。夹具先把它给全。
  await runtime.handlers.campaign(ctx(), { action: 'start', title: '战报可见性' });
  ok('开局那条日志进战报（`beginCampaign` 那份镜像没漏）', /开团/.test(seen()), seen().slice(0, 200));

  await runtime.handlers.character(ctx(), { action: 'create', name: '阿飞', hpMax: 12 });
  ok('**公开的人物卡进战报**（这一条是下面那几条的对照）', /新建人物卡：阿飞/.test(seen()), seen());

  // ① 整张卡藏起来（"这个人玩家还没见过"）。
  await runtime.handlers.character(ctx(), { action: 'create', name: '线人', visible: false });
  ok('**"玩家尚未见过"的卡不进战报** —— 正文里那四个字本身就是一次泄漏',
    !seen().includes('线人'), seen());
  ok('对照：它**确实进了 `campaign.log`**（挡的是战报那一侧，不是整个日志）',
    (status(K)?.log ?? []).some((entry) => entry.text.includes('线人')));

  // ② 有隐藏字段的卡：建卡那条日志的正文里就写着 `隐藏：stats`。
  await runtime.handlers.character(ctx(), { action: 'create', name: '黑衣客', hidden: ['stats'] });
  ok('**带隐藏字段的卡，建卡那条也不进战报**（正文写着 `隐藏：stats`）',
    !seen().includes('黑衣客'), seen());

  // ③ 改一个**被藏起来**的字段。
  await runtime.handlers.character(ctx(), { action: 'update', name: '黑衣客', stats: { DEX: 87 } });
  ok('**改隐藏字段（`stats`）不进战报**（`DEX 87` 正是刚被藏起来的那个数）',
    !/DEX 87/.test(seen()), seen());

  // ④ 改一个**公开**字段 —— 同一张卡、同一个工具，差别只在 `hidden` 那一栏。
  await runtime.handlers.character(ctx(), { action: 'update', name: '阿飞', hpDelta: -3 });
  ok('对照：公开字段的变化照样进战报（判据是**逐字段**的，不是"这张卡动过就整条藏"）',
    /阿飞：HP 12→9/.test(seen()), seen());

  // ⑤ 暗线旗标：写它的那一刻与**删掉**它的那一刻都不进战报（删的那条正文里带着名字）。
  await runtime.handlers.campaign(ctx(), { action: 'flag', flags: { 真凶是医生: '是' }, visible: false });
  ok('**暗线旗标不进战报**（写的时候就不该公开）', !seen().includes('真凶是医生'), seen());
  ok('对照：暗线**确实写进了 `campaign.log`**（DM 得看得见它）',
    (status(K)?.log ?? []).some((entry) => entry.text.includes('真凶是医生'))
    && JSON.stringify(status(K)?.flags?.['真凶是医生']) === JSON.stringify({ value: '是', visible: false }),
    JSON.stringify(status(K)?.flags?.['真凶是医生']));

  await runtime.handlers.campaign(ctx(), { action: 'flag', flags: { 真凶是医生: '' } });
  ok('**删掉一条暗线时那条日志也不进战报**（`旗标-：真凶是医生` 把名字说出来了）',
    !seen().includes('真凶是医生'), seen());
  ok('对照：删的那条**确实写进了 `campaign.log`**',
    (status(K)?.log ?? []).some((entry) => entry.text.includes('旗标-：真凶是医生')),
    JSON.stringify((status(K)?.log ?? []).map((entry) => entry.text)));

  // ⑥ 公开旗标与公开场景照旧。
  await runtime.handlers.campaign(ctx(), { action: 'flag', flags: { 已拿到钥匙: '是' } });
  await runtime.handlers.campaign(ctx(), { action: 'scene', scene: '灯塔一层·门厅' });
  ok('对照：公开旗标与公开场景都进战报',
    /旗标：已拿到钥匙 = 是/.test(seen()) && /场景：灯塔一层·门厅/.test(seen()), seen());

  ok('**战报里没有任何一条带着 `visible: false`**（挡在写入那一侧，不是靠读的时候滤）',
    journal.read(K).length > 0 && journal.read(K).every((entry) => entry.visible !== false),
    JSON.stringify(journal.read(K).filter((entry) => entry.visible === false)));
}

// ── 5p. `.log export`（P6）：把这一局的战报发成一份群文件 ────────────────────
{
  const K = 'group:p6-export';
  const journal = new JournalStore();
  const sent = [];
  // **上传端口是递进去的**（生产里 `web/app.ts` 接 `SendQueue.sendFile`）—— 扩展只说
  // "给谁、叫什么名字、正文是什么"，落临时文件与 `upload_*_file` 都是宿主的事。
  const runtime = createRuntime({
    sendFile: async (chatKey, fileName, content) => { sent.push({ chatKey, fileName, content }); }
  });
  const say = (text) => runtime.commandHandlers[routeIn(runtime.commandHandlers)(text)](
    { chatKey: K, senderId: '61001', text, media: [], replyToMessageId: null });
  const ctx = () => fakeCtx(K);

  const empty = String(await say('.log export'));
  ok('还没有战报时 `.log export` 说清"从开跑之后才开始记"（不是发一份空文件出去）',
    /还没有战报/.test(empty), empty);
  ok('对照：那一次**一个文件都没发**', sent.length === 0);

  await runtime.handlers.campaign(ctx(), { action: 'start', title: '导出' });
  await runtime.handlers.campaign(ctx(), { action: 'scene', scene: '灯塔一层·门厅' });
  await runtime.handlers.character(ctx(), { action: 'create', name: '阿飞', hpMax: 12 });

  // ⚠️ 取最近一次发出去的正文时**一律走这个帮手**（`sent.at(-1)?.content ?? ''`）：
  // 夹具一旦失效（比如 `start` 少了 `title` 而回一句 err），裸下标会在这里抛 `TypeError`
  // —— 那会**中止整个套件**（后面的 §6–§9 一次都不跑），而终端上只显示"这个套件失败了"。
  // 取不到就返回空串，让断言**变红**而不是让套件消失。
  const file = () => sent.at(-1)?.content ?? '';
  const entries = journal.read(K);
  const receipt = String(await say('.log export'));
  ok('导出回执报出文件名与条数', /战报已导出：跑团战报-\d{8}-\d{4}\.md/.test(receipt)
    && receipt.includes(`${entries.length} 条`), receipt);
  ok('发出去的是**这一条会话**、而且是 `.md`',
    sent.length === 1 && sent[0].chatKey === K && sent[0].fileName.endsWith('.md'),
    JSON.stringify(sent.map((item) => [item.chatKey, item.fileName])));
  ok('**导出的正文与战报逐字一致**（每一条的正文都在文件里）',
    entries.length > 0 && entries.every((entry) => file().includes(entry.text)),
    file().slice(0, 300));
  ok('文件头写着这是哪条会话的战报（发给群友的那一份要能自证出处）',
    file().startsWith(`# 跑团战报 · ${K}`), file().slice(0, 80));
  ok('它是给人看的：正文里**没有**"给模型的话"（`用 campaign 的 action=…` 那种）',
    file().length > 0 && !/action=/.test(file()) && !/campaign/.test(file()));

  // ── append-only：再跑几轮，旧行逐字不变 ──
  const raw = () => fs.readFileSync(journal.file(K), 'utf8');
  const before = raw();
  await runtime.handlers.campaign(ctx(), { action: 'scene', scene: '灯塔二层·塔顶' });
  const after = raw();
  ok('**append-only：新的一轮只往后追加，前面的行逐字不变**',
    after.startsWith(before) && after.length > before.length, `${before.length} → ${after.length}`);

  // ── 发布边界：手改过的文件也要被挡住 ──
  //
  // 判据与写侧**同一条**（`visible !== false`），不是第二份逻辑：导出是这条链上**唯一一个
  // "把这份文件发出去"**的动作，所以它自己再挡一次。手写进去的那一行模拟"绕过 `mirrorLog`
  // 的写入点"，而 `read()` **必须把它带回来**（丢掉标记 = 这一道闸门形同不存在）。
  const hidden = { seq: 999, ts: Date.now(), kind: 'state', text: '暗线：真凶是医生', visible: false };
  fs.appendFileSync(journal.file(K), `${JSON.stringify(hidden)}\n`, 'utf8');
  ok('`read()` 把 `visible: false` **原样带回来**（丢掉它 = 导出那道闸门形同不存在）',
    journal.read(K).at(-1)?.visible === false, JSON.stringify(journal.read(K).at(-1)));
  const filtered = String(await say('.log export'));
  ok('**手改过的文件也挡得住**：那一条没进导出（导出是这条链上唯一的发布动作）',
    file().length > 0 && !file().includes('暗线：真凶是医生'), file().slice(-200));
  ok('对照：其余条目照常导出（挡的是那一条，不是整份文件）',
    filtered.includes(`${journal.read(K).filter((entry) => entry.visible !== false).length} 条`), filtered);
}

// ── 5q. 群友可见的文案里没有 Markdown 的 `**`（A5）──────────────────────────
//
// QQ 不认 Markdown：`**粗体**` 到了群里就是**两个星号**。文案里混进它，观感是"写得像文档、
// 发出去是乱码"，而它**不影响任何逻辑** —— 启动、聊天、掷骰全都照常，所以只有断言拦得住。
//
// 两层，缺一层都不够：
//   • **行为层**：把每一条命令都真敲一遍，逐个回执找 `**`。判据是"真的跑了一遍"，而不是
//     "我看了一眼源码" —— 文案可能来自拼接（`formatCheck` 那种），只扫字面量会漏。
//   • **源码层**：剥注释后扫 `commands/` 与 `render/`（用户可见文案的两个落点），配一条
//     **正对照**（同一个扫描在 `rules/dice.ts` 上必须找得到 `**` —— 那是乘方运算符），
//     否则扫描本身失灵时上面那条是空转的。
{
  const K = 'group:p2-md';
  const files = [];
  const runtime = createRuntime({
    // 两条投递口子都装上，好让 `.rh` 与 `.log export` 走**成功**那条路（回执形状不同）。
    sendPrivate: async () => {},
    sendFile: async (_key, fileName, content) => { files.push({ fileName, content }); }
  });
  const commands = runtime.commandHandlers;
  const route = routeIn(commands);
  const receipts = [];
  const say = async (text, qq = '20031') => {
    const key = route(text);
    if (typeof commands[key] !== 'function') { receipts.push(`${text} → （没有这条命令：${key}）`); return; }
    const reply = await commands[key]({ chatKey: K, senderId: qq, text, media: [], replyToMessageId: null });
    receipts.push(`${text} → ${String(reply)}`);
  };

  // 库里先有一份剧本，好让"列出剧本"这条路有内容可印（空列表与有列表是两段不同的文案）。
  saveScenarioText('灯塔', { format: 'md', text: 'title: 灯塔\n\n一层门厅。', chars: 16, truncated: false },
    new ScenarioStore());

  // 第一遍：**还没有局**。每一条走的都是各自的"做不了"话术 —— 那些同样进群。
  for (const text of [
    '.trpg', '.trpg status', '.trpg join', '.trpg start', '.trpg end', '.trpg mode', '.trpg scenario',
    '.trpg 乱写', '.trpg start 现成的', '.trpg scenario 灯塔',
    '.trpg check', '.trpg check 灯塔', '.trpg check 没有这份',
    '.pc', '.pc new 阿飞', '.pc roll', '.pc confirm', '.pc show', '.pc save',
    '.combat', '.combat start', '.combat next', '.combat end',
    '.log', '.log export',
    '.ra 侦查', '.rh 侦查', '.st 侦查 45', '.r 3d6'
  ]) await say(text);

  // 第二遍：**真的开一局**，把成功路也走一遍（局势卡、人物卡、先攻序都是群友可见的）。
  //
  // ⚠️ `.st` 要排在 `.pc roll` **之后**：掷一套属性是**整份替换** `stats` 的（COC 那 8 项），
  // 先设的 `侦查` 会被它冲掉 —— 那样 `.ra` / `.rh` 走的是"卡上没有这一项"那条路，
  // 而下面那条"`.rh` 真的发出去了"的对照会红（第一版就是这么红的）。
  for (const text of ['.trpg new 文案检查 coc7', '.trpg join', '.pc new 阿飞', '.st 侦查 45',
    '.pc roll', '.st 侦查 45', '.pc confirm', '.pc show', '.pc show 教授', '.trpg status']) await say(text);
  // 第二个人：让"还差谁没确认"与先攻序里**多个人**这两条文案都有内容。
  await say('.trpg join', '20032');
  await say('.pc new 教授', '20032');
  await say('.trpg start');                    // 教授还没确认 → 逐人报缺那段
  await say('.pc confirm', '20032');
  for (const text of ['.trpg start', '.pc show', '.pc show 教授', '.trpg status', '.combat start',
    '.combat next', '.combat end', '.log export', '.ra 侦查', '.rh 侦查',
    '.trpg mode 助手', '.trpg status', '.trpg mode DM', '.trpg end']) await say(text);

  const bad = receipts.filter((line) => line.includes('**'));
  ok('每一条命令的回执都不含 Markdown 的 `**`（成功与失败两条路都跑到了；QQ 不认它，群里看到的是两个星号）',
    bad.length === 0, bad.join('\n') || `${receipts.length} 条回执逐条扫过`);
  // 对照：这一遍**真的跑到了命令**。全是"没有这条命令"的话，上一条就是空转的。
  ok('对照：那些回执是命令真跑出来的（不是清一色的"没有这条命令"）',
    receipts.length >= 40 && receipts.every((line) => !line.includes('（没有这条命令：')),
    `${receipts.length} 条`);
  // 对照：两条投递路真的走到了（否则 `.rh` / `.log export` 只验了"没装通道"那一半）。
  ok('对照：`.rh` 与 `.log export` 走的是**成功**那条路（私聊发了、文件发了一份）',
    files.length >= 1 && receipts.some((line) => line.includes('.rh 侦查') && line.includes('已私聊发送')),
    `${files.length} 份文件`);

  // ── 源码层 ──
  //
  // 扫的是**群友可见文案的全部落点**：跑团自己的 `commands/` 与 `render/`，外加主流程那一条
  // —— `/能力` 的回执住在 `web/onebot/commands.ts`（同样是发进群的话）。那一处**实测漏过一次**：
  // `只接管**本群**` 就那么原样发进群里，而本段当时只扫 `extra/trpg/`，所以什么都没报。
  //
  // `rules/` 不扫 —— 那里的 `**` 是乘方运算符（下面那条正对照用的就是它）。
  // `scenario/parse.ts` 也不在范围内，理由与它无关：`stripComments()` 在那个文件上会**失步**
  // （`plain` 那行的正则字面量同时含 `"` 与 `'`，把它的状态机切进字符串模式），于是那一段
  // 文档注释剥不掉 —— 那是助手的已知边界，不是文案的问题。所以本段只覆盖这几个落点。
  const readTs = (rel) => fs.readFileSync(path.join(ROOT, 'src', rel), 'utf8');
  const hits = [];
  const scan = (rel) => {
    const raw = readTs(rel);
    // **成员集合取自剥注释的文本，行号取自原文**（同 `t-ports.mjs` 第 2 段那条判据）。
    // 不这么做的话报出来的行号是错的：`stripComments()` 的块注释分支**把注释里的换行一起丢掉**
    // （`/* … */` 那一段只是往前跳字符，不补换行），而 `web/onebot/commands.ts` 通篇是 JSDoc
    // —— 实测那一行真身在 376，按剥完的文本数出来是 **269**，差了 100 多行。
    const rawLines = raw.split('\n');
    for (const [index, line] of stripComments(raw).split('\n').entries()) {
      if (!line.includes('**')) continue;
      const found = rawLines.findIndex((item) => item.trim() === line.trim());
      hits.push(`${rel}:${(found >= 0 ? found : index) + 1}: ${line.trim()}`);
    }
  };
  for (const dir of ['commands', 'render']) {
    for (const name of fs.readdirSync(path.join(ROOT, 'src', 'extra', 'trpg', dir))) {
      if (name.endsWith('.ts')) scan(`extra/trpg/${dir}/${name}`);
    }
  }
  scan('web/onebot/commands.ts');
  ok('源码层：剥注释后，群友可见文案的每个落点都没有 `**`（跑团的 `commands/` + `render/`，以及主流程的 `web/onebot/commands.ts`）',
    hits.length === 0, hits.join('\n'));
  ok('正对照：同一个扫描在 `rules/dice.ts` 上找得到 `**`（乘方运算符）—— 它真的看得见',
    stripComments(readTs('extra/trpg/rules/dice.ts')).includes('**'));
}

// ── 5r. 规则集的**唯一取用口**与三处钩子（P7-d）───────────────────────────────
//
// 这一段证明三件事，每件都有一个"少一处就静默"的形状：
//   ① 六处消费点全走 `ruleSetFor`：**失败形状逐字不变**（前缀不同是刻意的，句身同一句）；
//   ② 三处钩子真的挂在行为上，而且**每一处都有负对照**；
//   ③ `beginCampaign` 在规则扩展坏时**拒绝开局，而且什么都没落盘**。
//
// ⚠️ 这里**不重测** P7-a/P7-b：抽取管线在 `t-trpg-extract.mjs`，`.trpg check` 的回执在 5g2 段。
{
  // `createRuntime()` 自己建五个 store（默认目录 = `<DATA_DIR>/trpg*`），且**不暴露它们** ——
  // 所以断言要用的存档/剧本/规则表必须由**同目录**的实例去写去读。文件级的 `ruleStore`
  // 指向的是 `DIR/rules`，**不是** `DIR/trpg/rules`，所以这里另起一套。
  const rtRules = new RuleStore();
  const rtScenarios = new ScenarioStore();
  const campStore = new TrpgStore();
  const rt = createRuntime();
  const rtPriv = createRuntime({ sendPrivate: async () => {} });
  const tell = (line, chatKey) => callIn(rt.commandHandlers)(line, chatKey, []);
  const tellPriv = (line, chatKey) => callIn(rtPriv.commandHandlers)(line, chatKey, []);
  const callRt = (name, ctx, args) => rt.handlers[name](ctx, args);

  // 坏表：`condition` 是个半截表达式，`compileRule` 会拒它。
  fs.mkdirSync(rtRules.dir, { recursive: true });
  fs.writeFileSync(path.join(rtRules.dir, 'rt-broken.json'),
    JSON.stringify({ name: '坏', levels: [{ name: 'a', label: 'A', success: true, condition: 'total >= ' }] }),
    'utf8');
  // ⚠️ **运行时取，不写死**：那句话由 `rule-store.ts` 拼（含表 id 与 `problems.join('；')`）。
  // 手抄一份进断言的话，改一次文案就红一片，而它想守的是"六处报的是同一句话"。
  const BROKEN = rtRules.read('rt-broken').message;
  ok('夹具：坏表读出来是 `ok:false` 且带一句话（下面九条断言全挂在它上面）',
    typeof BROKEN === 'string' && BROKEN.startsWith('规则表「rt-broken」有问题：'), BROKEN);
  campStore.write(emptyCampaign('group:971', { title: '坏表团', system: '', rule: 'rt-broken' }));
  const brokenCtx = () => fakeCtx('group:971');

  // ── ① 六处消费点：换成 `ruleSetFor` 之后失败形状逐字不变 ──
  const rollBroken = await callRt('roll', brokenCtx(), { expr: '1d100', target: 70, reason: '看雾' });
  ok('消费点 1（`roll` 工具）：基础表坏了 → `错误：` + 那句话',
    body(rollBroken) === `错误：${BROKEN}`, body(rollBroken));

  const combatBroken = await callRt('campaign', brokenCtx(), { action: 'combat', sub: 'start' });
  ok('消费点 2（`campaign` 工具的战斗分支）：同上',
    body(combatBroken) === `错误：${BROKEN}`, body(combatBroken));

  const cmdCombat = await tell('.combat start', 'group:971');
  ok('消费点 3（`.combat start`）：带自己的前缀 `规则表读不出来，排不了先攻：`',
    cmdCombat === `规则表读不出来，排不了先攻：${BROKEN}`, cmdCombat);

  const cardFixture = await callRt('character', brokenCtx(),
    { action: 'create', name: '阿飞', ownerId: '10001', stats: { 侦查: 45 }, hpMax: 10 });
  ok('夹具：坏表团里照样建得出卡（`character` 的建卡不碰规则集）',
    cardFixture.isError !== true, body(cardFixture));

  const pcRoll = await tell('.pc roll', 'group:971');
  ok('消费点 4（`.pc roll`）：裸的那句话，不带前缀',
    pcRoll === BROKEN, pcRoll);

  const raBroken = await tell('.ra 侦查', 'group:971');
  ok('消费点 5（`.ra`）：`DiceError` 抛出的那句话原样进群', raBroken === BROKEN, raBroken);

  const rhBroken = await tellPriv('.rh 侦查', 'group:971');
  ok('消费点 5b（`.rh`）：与 `.ra` 共用同一个 `judge`，所以也是同一句话', rhBroken === BROKEN, rhBroken);

  const newBroken = await tell('.trpg new 坏表新团 rt-broken', 'group:979');
  ok('消费点 6（`.trpg new` → `beginCampaign`）：`错误：` + 那句话',
    newBroken === `错误：${BROKEN}`, newBroken);

  const stripped = [rollBroken, combatBroken, cmdCombat, pcRoll, raBroken, rhBroken, newBroken]
    .map((item) => String(typeof item === 'string' ? item : item.content)
      .replace(/^错误：/, '').replace(/^规则表读不出来，排不了先攻：/, ''));
  ok('六处报的是**同一句话**（前缀不同是刻意的，句身逐字相同）—— 统一取用口的全部意义',
    new Set(stripped).size === 1 && stripped[0] === BROKEN, [...new Set(stripped)].join(' ｜ '));

  // ── 夹具：三份剧本（`write` 必须排在 `writeExtras` 之前 —— write 会清掉伴生）──
  const ext = (...mechanics) => ({ version: 1, mechanics });
  const mech = (over = {}) => ({
    type: 'check_modifier', note: '灯塔的浓雾',
    trigger: { op: 'scene', value: '灯塔' },
    effect: { handler: 'penalty_to_check', params: { value: 20 } },
    sourceQuote: '浓雾里看不远', ...over
  });
  const immune = (name) => ({
    type: 'conditional_immunity', note: `${name}不吃普通伤害`,
    trigger: { op: 'actor', value: name },
    effect: { handler: 'immune_to_damage', params: {} },
    sourceQuote: '刀枪不入'
  });
  const w1 = rtScenarios.write('规则模组', '---\ntitle: 规则模组\nscene: 灯塔\n---\n浓雾笼罩着灯塔。\n');
  const w2 = rtScenarios.writeExtras('规则模组', { ruleExt: ext(mech()) });
  const w3 = rtScenarios.write('免疫模组', '---\ntitle: 免疫模组\n---\n守夜人刀枪不入。\n');
  const w4 = rtScenarios.writeExtras('免疫模组', { ruleExt: ext(immune('守夜人')) });
  const w5 = rtScenarios.write('坏规则模组', '---\ntitle: 坏规则模组\n---\n一份写坏了的规则。\n');
  const w6 = rtScenarios.writeExtras('坏规则模组',
    { ruleExt: ext({ ...mech(), effect: { handler: 'reduce_damage', params: {} } }) });
  ok('夹具：三份剧本 + 三份伴生都写得进去（写不进去的话下面全是空转）',
    [w1, w2, w3, w4, w5, w6].every((item) => item.ok === true),
    JSON.stringify([w1, w2, w3, w4, w5, w6].map((item) => item.ok)));

  // ── ② 三处钩子 ──
  const newVisible = await tell('.trpg new 规则模组', 'group:972');
  ok('`.trpg new` 的回执**原样印进群**，所以机制段一个字都不许出现（机制名可能带暗线信息）',
    newVisible.includes('剧本「规则模组」已注入') && !newVisible.includes('这一场景下生效的规则'), newVisible);
  const snap972 = campStore.read('group:972');
  ok('对照：那一局存档里确实有 scene=灯塔 与冻结的 ruleExt —— 上一条不是空转',
    snap972?.scene === '灯塔' && snap972?.scenario?.ruleExt !== undefined,
    `${snap972?.scene} / ${snap972?.scenario?.ruleExt !== undefined}`);

  // ── ②b. 规则说明进提示词（P7-e 的端到端：`impl.prompt` → `renderBriefing`）──
  //
  // 4c 段那些是 `renderRuleNotes` 的单元。**接线**要单独钉：`impl.ts` 少算一次 `ruleSetFor`、
  // 或者把"没有战役"与"有战役但读不出来"合成一档，单元断言照样全绿，而模型什么都看不到
  // （或者反过来 —— 每一个还没开团的会话都拿到一句"规则扩展坏了"）。
  const plan972 = rt.prompt('group:972');
  ok('端到端：那一局的特殊规则真的进了 system prompt 的中间段',
    plan972.body.length === 3
    && plan972.body[1].includes('· 灯塔的浓雾（check_modifier / 场景：灯塔）'),
    plan972.body[1].slice(-300));
  ok('端到端：段序仍是"人格 → 清单/正文/结构/规则 → 状态"（新内容并进中间段，段数不变）',
    /【跑团主持人】/.test(plan972.body[0]) && /【剧本与规则】/.test(plan972.body[1])
    && /【当前跑团状态】/.test(plan972.body[2]),
    JSON.stringify(plan972.body.map((text) => text.slice(0, 16))));
  const plan998 = rt.prompt('group:998');
  ok('端到端：**没开团的会话一个字都不印**（三档一合并，这里就会冒出一句"规则扩展坏了"）',
    !plan998.body[1].includes('这一局的特殊规则'), plan998.body[1]);
  // 人格段说的是**收团**该敲什么。原先写的是 `/能力 卸载 trpg` —— 那是"这个群不跑团了"，
  // 不写摘要、不清存档，敲完 `.trpg` 命令也全没了。`.trpg end` 才是收团（P2 起就有）。
  // ⚠️ 判据取的是**那一行本身**（以「收团：」开头），不是整段里有没有出现过 `.trpg end` ——
  // 整段里别处也提它（下一行就在说两者不同），那样写的话把这一行改回去也不会红。
  const collectLine = plan972.body[0].split('\n').find((line) => line.startsWith('收团：')) ?? '';
  ok('人格段里收团指的是 `.trpg end`', collectLine.includes('.trpg end'), collectLine);
  ok('而且**不再**把卸载当成收团（两件事在提示词里必须分开说）',
    !/让他们敲 `\/能力 卸载 trpg`/.test(plan972.body[0]), plan972.body[0].slice(-260));

  const started973 = await callRt('campaign', fakeCtx('group:973'), { action: 'start', scenario: '规则模组' });
  ok('`campaign action=start`（模型那一侧）**要**报一遍这一场景压着哪些规则',
    body(started973).includes('这一场景下生效的规则')
    && body(started973).includes('· 灯塔的浓雾（check_modifier / 场景：灯塔）'), body(started973));
  const log973 = campStore.read('group:973')?.log.find((entry) => entry.text.startsWith('生效机制：'));
  ok('机制那条日志标 `visible: false`（不进玩家视角、不进战报）',
    log973?.visible === false, JSON.stringify(log973));

  const rolled973 = await callRt('roll', fakeCtx('group:973'), { expr: '1d100', target: 70, reason: '看雾' });
  ok('`roll` 钩子（正）：目标值真的被机制改了（70 − 20 = 50），而且明说了是谁改的',
    body(rolled973).includes('｜ 对 50 →')
    && body(rolled973).includes('这一局的规则改了目标值：灯塔的浓雾'), body(rolled973));

  await tell('.trpg new 规则模组', 'group:974');
  const setScene974 = await callRt('campaign', fakeCtx('group:974'), { action: 'scene', scene: '码头' });
  ok('夹具：场景换到「码头」之后，机制段**整段消失**（`sceneNotes` 无命中时返回空串）',
    body(setScene974) === '场景已更新：码头', body(setScene974));
  const rolled974 = await callRt('roll', fakeCtx('group:974'), { expr: '1d100', target: 70, reason: '看码头' });
  ok('`roll` 钩子（负对照）：同一个机制、场景换成「码头」之后目标值一点没动',
    body(rolled974).includes('｜ 对 70 →')
    && !body(rolled974).includes('这一局的规则改了目标值'), body(rolled974));

  const bare973 = await callRt('roll', fakeCtx('group:973'), { expr: '1d100', reason: '随便掷' });
  ok('确定性分界：没有 target 的裸掷骰**不参与**机制（它压根不是检定）',
    !body(bare973).includes('这一局的规则改了目标值') && !body(bare973).includes('对 '), body(bare973));

  // ── ②c. `roll` 的 `skill` 维度（2026-10-19 补）：两条路必须给同一个目标值 ──
  //
  // 这一段钉的是一个**实测过的分岔**：工具那一侧原先恒传空串 `skill`，于是挂在技能上的机制
  // **只在 `.ra` / `.rh` 那条路上生效** —— 同一张卡、同一个场景、同一个骰面，DM 掷出「成功」
  // 而玩家敲 `.ra` 掷出「失败」。三条断言缺一不可：正、负对照、以及**跨路相等**。
  const wSkill = rtScenarios.write('技能模组', '---\ntitle: 技能模组\n---\n黑暗里什么都看不清。\n');
  const wSkillExt = rtScenarios.writeExtras('技能模组', {
    ruleExt: ext(mech({ note: '', trigger: { op: 'skill', value: '侦查' } }))
  });
  ok('夹具：技能模组写得进去（写不进去的话下面三条全是空转）',
    wSkill.ok === true && wSkillExt.ok === true, JSON.stringify([wSkill.ok, wSkillExt.ok]));
  await callRt('campaign', fakeCtx('group:981'), { action: 'start', scenario: '技能模组' });
  await callRt('character', fakeCtx('group:981'),
    { action: 'create', name: '阿飞', ownerId: '10001', stats: { 侦查: 45 }, hpMax: 10 });
  const withSkill = await callRt('roll', fakeCtx('group:981'),
    { expr: '1d100', target: 45, actor: '阿飞', skill: '侦查' });
  const noSkill = await callRt('roll', fakeCtx('group:981'),
    { expr: '1d100', target: 45, actor: '阿飞', reason: '同一件事，只是没给技能' });
  const raSkill = await tell('.ra 侦查', 'group:981');
  ok('`roll` 填了 skill → 技能上的机制生效（45 − 20 = 25）',
    body(withSkill).includes('｜ 对 25 →') && body(withSkill).includes('技能：侦查'), body(withSkill));
  ok('负对照：同一个调用**不填** skill → 目标值一点没动（证明是**这个参数**在起作用）',
    body(noSkill).includes('｜ 对 45 →') && !body(noSkill).includes('这一局的规则改了目标值'),
    body(noSkill));
  // ⚠️ 漏填要说出来（2026-10-19）：不说的话回执与一次完整的技能检定**逐字同形**，
  // 模型没有任何线索可以自纠，而两条路判出的档可能不同。
  ok('漏填 skill 时**明说**（这是模型自纠的唯一线索）',
    body(noSkill).includes('没填 skill'), body(noSkill));
  ok('对照：填了 skill 就不提这句（否则它就成了每轮噪音）',
    !body(withSkill).includes('没填 skill'), body(withSkill));
  ok('那句提醒**不进日志** —— `.trpg status` 会把 roll / check 日志印给全群，元信息在那儿只是噪音',
    (status('group:981')?.log ?? []).every((entry) => !entry.text.includes('没填 skill')),
    JSON.stringify((status('group:981')?.log ?? []).map((entry) => entry.text)));
  ok('**两条路给出同一个目标值**（这才是要修的那件事）：`.ra 侦查` 与带 skill 的 roll 都是「对 25」',
    raSkill.includes('｜ 对 25 →') && body(withSkill).includes('｜ 对 25 →'),
    `${raSkill} ｜ ${body(withSkill)}`);

  // ── ②d. 暗线旗标的名字**不许**跟着检定回执进群（2026-10-19 补）──
  //
  // `describeCheckModifiers` 在机制没有 `note` 时退到触发条件，而触发条件可能是暗线旗标 ——
  // 实测过：一次 `.ra` 会把 `旗标：真凶是医生 = 是` 印在全群面前，并跟着那条日志进战报，
  // 再被 `.log export` 发一次。遮挡的判据必须是 `visible`，不是"凡旗标都遮"（那样 DM 与
  // 群友都看不到公开旗标，回执会变得没法对账）。
  const rtJournal = new JournalStore();
  const wSecret = rtScenarios.write('暗线模组',
    '---\ntitle: 暗线模组\nflags: {"真凶是医生":{"value":"是","visible":false},"灯塔已熄":"是"}\n---\n医生有问题。\n');
  const wSecretExt = rtScenarios.writeExtras('暗线模组', {
    ruleExt: ext(
      mech({ note: '', trigger: { op: 'flag', key: '真凶是医生', value: '是' } }),
      mech({ note: '', trigger: { op: 'flag', key: '灯塔已熄', value: '是' }, effect: { handler: 'penalty_to_check', params: { value: 5 } } })
    )
  });
  ok('夹具：暗线模组写得进去（一条挂暗线、一条挂公开旗标，两条都没有 note）',
    wSecret.ok === true && wSecretExt.ok === true, JSON.stringify([wSecret.ok, wSecretExt.ok]));
  await callRt('campaign', fakeCtx('group:982'), { action: 'start', scenario: '暗线模组' });
  await callRt('character', fakeCtx('group:982'),
    { action: 'create', name: '阿飞', ownerId: '10001', stats: { 侦查: 45 }, hpMax: 10 });
  const raSecret = await tell('.ra 侦查', 'group:982');
  ok('`.ra` 的回执**不许出现暗线旗标的名字**（它进群，还会跟着日志进战报）',
    !raSecret.includes('真凶是医生') && raSecret.includes('这一局的特殊规则'), raSecret);
  ok('负对照：公开旗标照旧指名（判据是那条旗标的 `visible`，不是"凡旗标都遮"）',
    raSecret.includes('旗标：灯塔已熄 = 是'), raSecret);
  const rollSecret = await callRt('roll', fakeCtx('group:982'),
    { expr: '1d100', target: 45, actor: '阿飞', skill: '侦查' });
  ok('对照：模型那一侧（`roll` 工具）**照旧看得到是哪一条** —— DM 得靠它把数对上',
    body(rollSecret).includes('旗标：真凶是医生 = 是'), body(rollSecret));
  const journal977 = rtJournal.read('group:982');
  ok('战报里也没有那个名字（`.ra` 那条日志跟着 `note` 一起写进去，两处共用同一个遮挡）',
    journal977.length > 0 && !journal977.some((entry) => entry.text.includes('真凶是医生')),
    JSON.stringify(journal977.map((entry) => entry.text)));
  // 与战报同源但**另一条出口**：`.trpg status` 直接把最近三条 `roll` / `check` 日志印给全群
  // （`PLAYER_LOG_KINDS`）。工具那条路的日志正文要是没遮，就是从这儿漏的。
  const status982 = await tell('.trpg status', 'group:982');
  ok('`.trpg status` 印给全群的那几行里也不许有暗线旗标名',
    !status982.includes('真凶是医生'), status982);

  // 钩子 B：`character` 的伤害闸门
  await callRt('campaign', fakeCtx('group:975'), { action: 'start', scenario: '免疫模组' });
  await callRt('character', fakeCtx('group:975'), { action: 'create', name: '守夜人', hpMax: 10 });
  const blocked975 = await callRt('character', fakeCtx('group:975'), { action: 'update', name: '守夜人', hpDelta: -3 });
  ok('`character` 伤害闸门（正）：免疫命中时**拒绝**这次改动，并说清是哪条机制挡的',
    body(blocked975).includes('「守夜人」这一下挨不着：守夜人不吃普通伤害（conditional_immunity / 角色：守夜人）')
    && body(blocked975).includes('这一局的规则挡掉了这次伤害'), body(blocked975));
  ok('闸门排在一切改动之前：被拒之后卡上的 HP 一点没动（也不落盘）',
    campStore.read('group:975')?.characters.find((card) => card.name === '守夜人')?.hp === 10,
    String(campStore.read('group:975')?.characters.find((card) => card.name === '守夜人')?.hp));

  await callRt('character', fakeCtx('group:975'), { action: 'create', name: '阿飞', hpMax: 10 });
  const hit975 = await callRt('character', fakeCtx('group:975'), { action: 'update', name: '阿飞', hpDelta: -3 });
  ok('`character` 伤害闸门（负对照）：没被机制护着的人照常扣血',
    hit975.isError !== true && body(hit975).includes('HP 7/10'), body(hit975));

  await callRt('character', fakeCtx('group:975'), { action: 'create', name: '教授', hpMax: 0, sanMax: 10 });
  const san975 = await callRt('character', fakeCtx('group:975'), { action: 'update', name: '教授', sanDelta: -5 });
  ok('边界：闸门只认 `hpDelta < 0` —— SAN 掉下去照常（免疫伤害不是免疫恐惧）',
    san975.isError !== true && body(san975).includes('SAN 5/10'), body(san975));

  // 钩子 C：`campaign` 的场景机制报告 + 降级分支（手改坏存档里冻结的 ruleExt）
  const rig = emptyCampaign('group:976', { title: '手改团', system: '', rule: 'generic' });
  rig.scene = '灯塔';
  rig.scenario = { id: 'rig', body: '', ruleExt: ext({ ...mech(), effect: { handler: 'reduce_damage', params: {} } }) };
  campStore.write(rig);
  const degraded = await callRt('campaign', fakeCtx('group:976'), { action: 'scene', scene: '灯塔' });
  ok('降级（手改了存档里冻结的 ruleExt）：场景照常换，但**明说规则集读不出来**',
    body(degraded).includes('场景已更新：灯塔')
    && body(degraded).includes('（这一局的规则集读不出来 —— 按基础规则表照常跑，但那些特殊机制都没生效）'),
    body(degraded));
  ok('对照：降级那一次**没有**写 `生效机制：` 日志（不能假装很太平）',
    !campStore.read('group:976')?.log.some((entry) => entry.text.startsWith('生效机制：')),
    JSON.stringify(campStore.read('group:976')?.log.map((entry) => entry.text)));

  // ── ③ 开局：坏扩展拒绝，且什么都没落盘 ──
  const refused = await callRt('campaign', fakeCtx('group:977'), { action: 'start', scenario: '坏规则模组' });
  ok('`beginCampaign` 在规则扩展坏时**拒绝开局**，并把是哪一条、错在哪说清',
    refused.isError === true && body(refused).includes('这份剧本的规则扩展有问题，开局停了：')
    && body(refused).includes('effect.handler 写的是「reduce_damage」'), body(refused));
  // 给**真文件名**：不点名的话管理员得自己猜该去改哪份文件，而 `.rule.json` 这个名字
  // 除了这里没有任何地方告诉过他。
  ok('拒绝时点名要改的那份文件（`data/trpg/scenarios/<剧本>.rule.json`）',
    body(refused).includes('改完 data/trpg/scenarios/坏规则模组.rule.json 再开一次。'), body(refused));
  ok('拒绝的文案里不含 Markdown 的 `**`（QQ 不认，星号会原样显示）',
    !body(refused).includes('**'), body(refused));
  ok('对照：被拒的那一局**什么都没落盘**（那道闸门排在 emptyCampaign 与任何一次 store.write 之前）',
    campStore.read('group:977') === null && !fs.existsSync(campStore.file('group:977')),
    String(campStore.read('group:977')));

  // **逐条**：两条问题各占一行 `· `，不是用 `；` 连成一句。
  // ⚠️ 这一条**需要两条问题的夹具**才判别得了 —— 上面那份只有一条，分不出"逐条"与"合并"。
  const w7 = rtScenarios.write('双坏规则模组', '---\ntitle: 双坏规则模组\n---\n两条都写坏了。\n');
  const w8 = rtScenarios.writeExtras('双坏规则模组', {
    ruleExt: ext(
      { ...mech(), effect: { handler: 'reduce_damage', params: {} } },
      { ...mech(), note: '没写触发条件', trigger: undefined }
    )
  });
  ok('夹具：两条问题的剧本写得进去（写不进去的话下面两条是空转）',
    w7.ok === true && w8.ok === true, JSON.stringify([w7.ok, w8.ok]));

  const refusedTwo = await callRt('campaign', fakeCtx('group:980'), { action: 'start', scenario: '双坏规则模组' });
  const refuseLines = body(refusedTwo).split('\n');
  const refuseBullets = refuseLines.filter((line) => line.startsWith('· '));
  ok('两条问题**各占一行**（`· ` 打头），不是 `；` 连成一句 —— 压成一句就再没人知道该改哪一条',
    refusedTwo.isError === true && refuseBullets.length === 2, body(refusedTwo));
  ok('那两行**逐字**是编译期写好的原文（这一层不重写它们：重写一份必然与 `rules/rule-set.ts` 漂移）',
    refuseBullets.some((line) => line.includes('第 1 条机制：effect.handler 写的是「reduce_damage」，我不认识它'))
    && refuseBullets.some((line) => line.includes('第 2 条机制（check_modifier）没写 trigger')), body(refusedTwo));
  ok('对照：被拒的那一局同样什么都没落盘（逐条这条路与单条那条走的是同一道闸门）',
    campStore.read('group:980') === null && !fs.existsSync(campStore.file('group:980')),
    String(campStore.read('group:980')));

  // 两条坏路的**形状对照**：判据是"此刻那个人能去改哪一份文件"。基础表那一头的分条能力住在
  // `rule-store.ts` 里（它已经把 `problems` 连成一句了），这里再拆一次就是第二份判据 ——
  // 而且六个消费点报的也正是那一句，改写它会变成"开局时说的"与"跑起来报的"不是同一句话。
  ok('对照：**基础表**坏掉那一路仍是一句话（`错误：…`），只有规则扩展那一路逐条摊开',
    newBroken === `错误：${BROKEN}` && !newBroken.includes('开局停了'), newBroken);

  const plain978 = await callRt('campaign', fakeCtx('group:978'), { action: 'start', title: '光板团' });
  ok('对照：没有规则扩展的一局，`campaign action=start` 一个字都不多说',
    plain978.isError !== true && !body(plain978).includes('这一场景下生效的规则'), body(plain978));
}

// ── 5s. 分幕（P8）：开局落在哪一幕、换场景怎么推进、两份渲染各印什么 ─────────────
//
// 三条判据各自"错了也不报错"：开局算错 → 整局停在第 1 幕；推进算错 → 永远不换幕
// （群里只觉得"分幕好像没做"）；渲染算错 → keeperNotes 直接漏给玩家。所以每条都要钉。
{
  const rt = createRuntime();
  const store = new TrpgStore();
  const scenarios = new ScenarioStore();
  const cmds = rt.commandHandlers;
  const call = (name, key, args) => rt.handlers[name](fakeCtx(key), args);
  const camp = (key) => store.read(key);
  const KEY = 'group:acts';

  const structWith = (acts) => ({
    summary: '',
    scenes: [{ name: '码头', summary: '', npcs: [], clues: [] },
      { name: '灯塔', summary: '', npcs: [], clues: [] }],
    npcs: [], clues: [], items: [], mechanics: [], warnings: [], acts
  });
  const ACTS = [
    { id: 'a1', name: '抵达', order: 1, goal: '把玩家送进灯塔', keeperNotes: '守夜人其实是凶手',
      entryCondition: null, exitCondition: { op: 'flag', key: '已入塔', value: '是' },
      scenes: ['码头'], visible: true },
    { id: 'a2', name: '对峙', order: 2, goal: '让玩家认出守夜人', keeperNotes: '他真的在撒谎',
      entryCondition: { op: 'flag', key: '已入塔', value: '是' }, exitCondition: null,
      scenes: ['灯塔'], visible: true },
    { id: 'a3', name: '真相', order: 3, goal: '', keeperNotes: '钥匙在灯芯里',
      entryCondition: null, exitCondition: null, scenes: [], visible: false }
  ];
  scenarios.write('分幕团', '---\ntitle: 分幕团\n---\n正文。');
  scenarios.writeExtras('分幕团', { struct: structWith(ACTS) });

  await call('campaign', KEY, { action: 'start', scenario: '分幕团' });
  ok('开局：有 acts 时 `currentAct` = 第一幕',
    camp(KEY)?.currentAct === 'a1', String(camp(KEY)?.currentAct));

  const SKEY = 'group:acts-scene';
  await call('campaign', SKEY, { action: 'start', scenario: '分幕团', scene: '灯塔' });
  ok('开局时场景属于第 2 幕 → 从第 2 幕起（不是死板地永远第一幕）',
    camp(SKEY)?.currentAct === 'a2', String(camp(SKEY)?.currentAct));

  const NKEY = 'group:acts-none';
  scenarios.write('无幕团', '---\ntitle: 无幕团\n---\n正文。');
  await call('campaign', NKEY, { action: 'start', scenario: '无幕团' });
  ok('没有 acts 的剧本 → `currentAct` 是空串（单幕模式，不报错）',
    camp(NKEY)?.currentAct === '', JSON.stringify(camp(NKEY)?.currentAct));

  // ── DM 那份（模型的状态段）──
  const dm = rt.prompt(KEY).body[2];
  ok('DM 状态段有阶段块：第几幕 / 幕名 / 目标 / 完成条件 / 下一幕',
    /—— 阶段（第 1 幕 \/ 共 3 幕）——/.test(dm) && /本幕：抵达/.test(dm)
    && /目标：把玩家送进灯塔/.test(dm) && /完成条件：旗标：已入塔 = 是/.test(dm)
    && /下一幕：对峙/.test(dm), dm.slice(0, 700));
  ok('DM 状态段带**本幕**的 keeperNotes（幕后信息只给 DM）',
    /幕后：守夜人其实是凶手/.test(dm), dm.slice(0, 700));
  ok('下一幕**只给名字**，不给它的 keeperNotes（说多了模型会提前演）',
    !/他真的在撒谎/.test(dm), dm.slice(0, 700));

  // ── 玩家那份 ──
  const pv = renderForPlayers(camp(KEY));
  ok('玩家视角：阶段 第 1 幕 / 共 2 幕（**只数可见幕**，暗线幕不进分母）',
    /阶段：第 1 幕 \/ 共 2 幕/.test(pv), pv.slice(0, 300));
  ok('玩家视角**不含** keeperNotes 与目标',
    !/守夜人其实是凶手/.test(pv) && !/把玩家送进灯塔/.test(pv), pv.slice(0, 400));

  // ── 自动推进 ──
  const toLighthouse = await call('campaign', KEY, { action: 'scene', scene: '灯塔' });
  ok('换到第 2 幕的场景 → 自动进入第 2 幕，回执明说（模型不必自己声明换幕）',
    camp(KEY)?.currentAct === 'a2' && /进入第 2 幕：对峙/.test(body(toLighthouse)), body(toLighthouse));
  await call('campaign', KEY, { action: 'scene', scene: '走廊' });
  ok('未知场景**保持当前幕**（DM 随手写过场不该把进度打回去）',
    camp(KEY)?.currentAct === 'a2', String(camp(KEY)?.currentAct));
  await call('campaign', KEY, { action: 'scene', scene: '码头' });
  ok('场景命中优先：回到第 1 幕的场景就切回第 1 幕',
    camp(KEY)?.currentAct === 'a1', String(camp(KEY)?.currentAct));

  const EKEY = 'group:acts-exit';
  await call('campaign', EKEY, { action: 'start', scenario: '分幕团' });
  await call('campaign', EKEY, { action: 'flag', flags: { 已入塔: '是' } });
  const exitStep = await call('campaign', EKEY, { action: 'scene', scene: '过渡场景' });
  ok('场景没命中、但当前幕的 `exitCondition` 成立 → 进入下一幕（不靠场景名）',
    camp(EKEY)?.currentAct === 'a2' && /进入第 2 幕/.test(body(exitStep)), body(exitStep));

  // ── 暗线幕：玩家整段不出现，DM 那份照常且带标记 ──
  const hidden = camp(KEY);
  hidden.currentAct = 'a3';
  store.write(hidden);
  ok('当前幕是暗线幕：玩家视角**整段不出现**（连"第几幕"都不印）',
    !/阶段：/.test(renderForPlayers(camp(KEY))), renderForPlayers(camp(KEY)).slice(0, 300));
  ok('对照：DM 那份照常显示并标 [暗线幕]',
    /\[暗线幕\]/.test(rt.prompt(KEY).body[2]), rt.prompt(KEY).body[2].slice(0, 700));

  // ── 没有 acts / 没有剧本 ──
  ok('没有 acts 的剧本：DM 那份印一句「本模组未分幕」',
    /本模组未分幕/.test(rt.prompt(NKEY).body[2]), rt.prompt(NKEY).body[2].slice(0, 500));
  ok('玩家那份**不印**那句（那是 DM 的信息）',
    !/本模组未分幕/.test(renderForPlayers(camp(NKEY))));
  const BKEY = 'group:acts-sandbox';
  await call('campaign', BKEY, { action: 'start', title: '沙盒' });
  ok('没有注入剧本的沙盒团：阶段段**整段不出现**（每轮一行"未分幕"只是噪音）',
    !/—— 阶段/.test(rt.prompt(BKEY).body[2]), rt.prompt(BKEY).body[2].slice(0, 400));

  // ── `.trpg check` 的管理员表面 ──
  const checked = String(await cmds['.trpg check']({
    chatKey: KEY, senderId: '1', text: '.trpg check 分幕团', media: [], replyToMessageId: null
  }));
  ok('`.trpg check` 列出幕名 / 序号 / 场景 / 完成条件',
    /第 1 幕「抵达」/.test(checked) && /完成条件：旗标：已入塔 = 是/.test(checked), checked);
  ok('`.trpg check` **不印** goal 与 keeperNotes（这条命令在群里敲）',
    !checked.includes('把玩家送进灯塔') && !checked.includes('守夜人其实是凶手'), checked);

  // ── 迁移与源级 ──
  ok('旧存档没有 `currentAct` → 读成空串（单幕模式，不报错）',
    normalizeCampaign({ title: '旧' }, 'group:legacy')?.currentAct === '');
  const playerSrc = stripComments(fs.readFileSync(path.join(ROOT, 'src/extra/trpg/render/players.ts'), 'utf8'));
  const cmdSrc = ['commands/verify.ts', 'commands/session.ts', 'commands/mode.ts', 'commands/combat.ts',
    'commands/check.ts', 'commands/scenario.ts', 'commands/log.ts', 'commands/character.ts']
    .map((rel) => stripComments(fs.readFileSync(path.join(ROOT, 'src/extra/trpg', rel), 'utf8'))).join('\n');
  ok('源级：玩家可见的落点（`render/players.ts` + `commands/`）里一次都不提 keeperNotes',
    !/keeperNotes/.test(playerSrc) && !/keeperNotes/.test(cmdSrc));
}

// ── 5t. 推进保证（P8-b）：计数、阈值、冷却、提示正文、切幕、onRunEnd 接线 ────────
//
// 这一段的判据分三层，缺一层就有东西看不见：
//   ① **纯逻辑**（`model/advance.ts`）：计数与 `dirty`、阈值覆盖、冷却、正文；
//   ② **接线**（`onRunEnd`）：超阈值落一条、冷却中不落、换指标立即落、与建议互斥；
//   ③ **命令**（`action=advance`）：条件校验与"还差什么"。
{
  const { ADVANCE_HINT_COOLDOWN, ADVANCE_THRESHOLDS } = await load('extra/trpg/model/limits.js');
  const {
    advanceHintText, advanceTo, hintAllowed, markHinted, pickHint, resetAdvance,
    stageAdvanceMode, stageHintText, thresholdsOf, tickAdvancement
  } = await load('extra/trpg/model/advance.js');
  const { actsOf, nextAct } = await load('extra/trpg/scenario/acts.js');
  const { compileRuleSet } = await load('extra/trpg/rules/rule-set.js');
  const { ChatStore } = await load('chat/store.js');
  const { buildPastState } = await load('agent/prompting/prompt-builder.js');

  const bare = () => emptyCampaign('group:adv', { title: 't', system: '', rule: 'generic' });
  const ctxOf = (over = {}) => ({ scene: '', flags: {}, actor: '', skill: '', ...over });
  const withActs = () => {
    const camp = bare();
    camp.scenario = {
      id: 'x', body: '',
      struct: { scenes: [], acts: [
        { id: 'a1', name: '抵达', order: 1, goal: '把玩家送进灯塔', keeperNotes: '守夜人其实是凶手',
          exitCondition: { op: 'flag', key: '已入塔', value: '是' }, scenes: ['码头'], visible: true },
        { id: 'a2', name: '对峙', order: 2, scenes: ['灯塔'], visible: true }
      ] }
    };
    camp.currentAct = 'a1';
    return camp;
  };

  // ── ① 纯逻辑 ──
  const c = bare();
  tickAdvancement(c);
  ok('一轮收尾：三个指标一起 +1',
    c.advancement.scene === 1 && c.advancement.flag === 1 && c.advancement.act === 1);
  resetAdvance(c, 'scene');
  ok('变更点：计数归零并置 `dirty`（否则本轮的收尾会把它记成 1）',
    c.advancement.scene === 0 && c.advancement.dirty?.scene === true);
  tickAdvancement(c);
  ok('变更那一轮收尾后仍然是 **0** —— 这就是 `dirty` 的全部意义',
    c.advancement.scene === 0 && c.advancement.flag === 2 && c.advancement.act === 2
    && c.advancement.dirty === undefined, JSON.stringify(c.advancement));

  ok('默认阈值 8 / 12 / 20，按指标独立',
    thresholdsOf(null).scene === ADVANCE_THRESHOLDS.scene
    && thresholdsOf(null).flag === 12 && thresholdsOf(null).act === 20);

  const overridden = compileRuleSet({ version: 1, mechanics: [
    { type: 'advancement_threshold', advance: { metric: 'scene', turns: 3 } }
  ] });
  ok('规则扩展可以覆盖某个指标的阈值（其余仍取默认）',
    overridden.ok && thresholdsOf(overridden.set).scene === 3 && thresholdsOf(overridden.set).flag === 12,
    JSON.stringify(overridden));

  const h = bare();
  h.advancement.scene = 7;
  ok('低于阈值 → 不提示', pickHint(h, null) === null);
  h.advancement.scene = 8;
  ok('到阈值 → 提示，并说出是哪个指标、几轮',
    pickHint(h, null)?.metric === 'scene' && pickHint(h, null)?.turns === 8);
  markHinted(h, 'scene');
  ok('冷却：刚提示过，同一指标 +2 轮内不再提示',
    pickHint(h, null) === null && !hintAllowed(h, 'scene'));
  h.advancement.flag = 12;
  ok('**换指标可以立即落**（冷却按指标分开记）', pickHint(h, null)?.metric === 'flag');
  h.advancement.scene = 8 + ADVANCE_HINT_COOLDOWN;
  ok('同一指标再过 ' + ADVANCE_HINT_COOLDOWN + ' 轮才允许再提示',
    hintAllowed(h, 'scene') && pickHint(h, null)?.metric === 'scene');

  const text = advanceHintText(withActs(), { metric: 'scene', turns: 9, threshold: 8 }, ctxOf());
  ok('提示正文说清：第几幕、几轮没变化、本幕目标、完成条件与是否满足',
    text.includes('第 1 幕「抵达」') && text.includes('已连续 9 轮没有场景变化')
    && text.includes('本幕目标：把玩家送进灯塔') && text.includes('未满足')
    && text.includes('不是命令'), text);
  ok('提示正文**不含** keeperNotes（幕后信息不进任何可能被念出来的文本）',
    !text.includes('守夜人其实是凶手'), text);
  ok('完成条件满足时说"已满足"',
    advanceHintText(withActs(), { metric: 'flag', turns: 13, threshold: 12 }, ctxOf({ flags: { 已入塔: '是' } }))
      .includes('已满足'));
  ok('没有分幕时只说"没有分幕"那一句（沙盒团同样会打转）',
    advanceHintText(bare(), { metric: 'scene', turns: 9, threshold: 8 }, ctxOf())
      .startsWith('当前没有分幕'));

  ok('`stage_advance` 没声明时返回 null（P8-a 的行为不变）', stageAdvanceMode(null) === null);
  ok('缺省是 hint',
    stageAdvanceMode(compileRuleSet({ version: 1, mechanics: [{ type: 'stage_advance' }] }).set) === 'hint');
  ok('显式 auto 才是 auto',
    stageAdvanceMode(compileRuleSet({
      version: 1, mechanics: [{ type: 'stage_advance', advance: { mode: 'auto' } }]
    }).set) === 'auto');

  const stageText = stageHintText(withActs(), ctxOf({ 已入塔: '是' }));
  ok('"完成条件已满足"的提示说出下一幕名字，但**不替 DM 切幕**',
    stageText.includes('已经满足') && stageText.includes('下一幕是「对峙」')
    && stageText.includes('由你决定'), stageText);

  const moved = withActs();
  advanceTo(moved, nextAct(actsOf(moved.scenario.struct), 'a1'));
  ok('`advanceTo`：改 currentAct、把 act 计数归零、落一条 `[state]` 日志',
    moved.currentAct === 'a2' && moved.advancement.act === 0
    && moved.log.some((entry) => entry.kind === 'state' && entry.text.includes('推进到第 2 幕')),
    JSON.stringify(moved.log));

  // ── ② onRunEnd 接线 ──
  const notes = [];
  const rt2 = createRuntime({ deliverNote: (key, note) => notes.push({ key, ...note }) });
  const scenarios2 = new ScenarioStore();
  const md = (title) => ['---', 'title: ' + title, '---', '正文。'].join(String.fromCharCode(10));
  scenarios2.write('推进团', md('推进团'));
  scenarios2.writeExtras('推进团', {
    struct: {
      scenes: [{ name: '码头', summary: '', npcs: [], clues: [] },
        { name: '灯塔', summary: '', npcs: [], clues: [] }],
      acts: [
        { id: 'a1', name: '抵达', order: 1, goal: '把玩家送进灯塔', keeperNotes: '幕后一句',
          exitCondition: { op: 'flag', key: '已入塔', value: '是' }, scenes: ['码头'], visible: true },
        { id: 'a2', name: '对峙', order: 2, scenes: ['灯塔'], visible: true }
      ]
    }
  });
  const R = 'group:adv-run';
  await rt2.handlers.campaign(fakeCtx(R), { action: 'start', scenario: '推进团', scene: '码头' });
  const human = [{ kind: undefined, text: '我推开门' }];
  const runEnd = (status = 'done', trigger = human, key = R) =>
    rt2.onRunEnd({ chatKey: key, status, sentCount: 1, trigger });
  const readR = () => new TrpgStore().read(R);
  const setMetric = (metric, value, key = R) => {
    const camp = new TrpgStore().read(key);
    camp.advancement[metric] = value;
    new TrpgStore().write(camp);
  };

  setMetric('scene', 8);
  notes.length = 0;
  await runEnd();
  ok('超阈值 → 落一条【推进提示】（`kind: advance`），正文说清几轮没变化',
    notes.length === 1 && notes[0].kind === 'advance' && notes[0].text.includes('已连续 9 轮没有场景变化'),
    JSON.stringify(notes));

  notes.length = 0;
  await runEnd();
  ok('冷却中 → 不落（`hinted` 落盘，重启也记得）', notes.length === 0, JSON.stringify(notes));

  setMetric('flag', 12);
  notes.length = 0;
  await runEnd();
  ok('**换指标立即落**', notes.length === 1 && notes[0].text.includes('剧情旗标'), JSON.stringify(notes));

  const beforeSkip = readR().advancement.scene;
  notes.length = 0;
  await runEnd('done', [{ kind: 'trpg-note', text: '机器条目' }]);
  ok('**非真人推动的运行不计轮、也不落提示**（否则提示自己喂大自己）',
    notes.length === 0 && readR().advancement.scene === beforeSkip, String(readR().advancement.scene));

  const beforeError = readR().advancement.scene;
  await runEnd('error');
  ok('报错的那一轮不计数（没有推进可言）', readR().advancement.scene === beforeError);

  notes.length = 0;
  await runEnd('noreply');
  ok('沉默的那一轮**只落建议**（这里模型调不通所以一条都没有），不落推进提示',
    notes.every((note) => note.kind !== 'advance'), JSON.stringify(notes));

  // ── ③ `campaign action=advance` ──
  const C = 'group:adv-cmd';
  await rt2.handlers.campaign(fakeCtx(C), { action: 'start', scenario: '推进团' });
  const denied = await rt2.handlers.campaign(fakeCtx(C), { action: 'advance' });
  ok('条件不满足 → 拒绝，并**逐条说出还差什么**',
    denied.isError === true && /还差/.test(body(denied)) && /旗标「已入塔」/.test(body(denied)), body(denied));
  await rt2.handlers.campaign(fakeCtx(C), { action: 'flag', flags: { 已入塔: '是' } });
  const advanced = await rt2.handlers.campaign(fakeCtx(C), { action: 'advance' });
  ok('条件满足 → 推进到下一幕，回执点名新幕',
    advanced.isError !== true && /已推进到第 2 幕「对峙」/.test(body(advanced))
    && new TrpgStore().read(C)?.currentAct === 'a2', body(advanced));
  const lastOne = await rt2.handlers.campaign(fakeCtx(C), { action: 'advance' });
  ok('已经是最后一幕 → 拒绝并说清',
    lastOne.isError === true && /最后一幕/.test(body(lastOne)), body(lastOne));

  const N = 'group:adv-none';
  scenarios2.write('无幕团2', md('无幕团2'));
  await rt2.handlers.campaign(fakeCtx(N), { action: 'start', scenario: '无幕团2' });
  const none = await rt2.handlers.campaign(fakeCtx(N), { action: 'advance' });
  ok('没有分幕 → 拒绝并让人直接叙事', none.isError === true && /没有分幕/.test(body(none)), body(none));

  // ── ④ stage_advance 的两个档 ──
  const stageStruct = {
    scenes: [{ name: '码头', summary: '', npcs: [], clues: [] }],
    acts: [
      { id: 'a1', name: '抵达', order: 1, exitCondition: { op: 'flag', key: '已入塔', value: '是' },
        scenes: ['码头'], visible: true },
      { id: 'a2', name: '对峙', order: 2, scenes: ['码头'], visible: true }
    ]
  };
  const AUTO = 'group:adv-auto';
  scenarios2.write('自动幕', md('自动幕'));
  scenarios2.writeExtras('自动幕', {
    struct: stageStruct,
    ruleExt: { version: 1, mechanics: [{ type: 'stage_advance', advance: { mode: 'auto' } }] }
  });
  await rt2.handlers.campaign(fakeCtx(AUTO), { action: 'start', scenario: '自动幕' });
  await rt2.handlers.campaign(fakeCtx(AUTO), { action: 'flag', flags: { 已入塔: '是' } });
  notes.length = 0;
  await runEnd('done', human, AUTO);
  const autoCamp = new TrpgStore().read(AUTO);
  ok('`stage_advance auto`：收尾时**自动**切到下一幕并落一条日志',
    autoCamp?.currentAct === 'a2'
    && autoCamp.log.some((entry) => entry.text.includes('推进到第 2 幕')),
    JSON.stringify(autoCamp?.log.slice(-2)));

  const HINT = 'group:adv-hint';
  scenarios2.write('提示幕', md('提示幕'));
  scenarios2.writeExtras('提示幕', {
    struct: stageStruct,
    ruleExt: { version: 1, mechanics: [{ type: 'stage_advance', advance: { mode: 'hint' } }] }
  });
  await rt2.handlers.campaign(fakeCtx(HINT), { action: 'start', scenario: '提示幕' });
  await rt2.handlers.campaign(fakeCtx(HINT), { action: 'flag', flags: { 已入塔: '是' } });
  notes.length = 0;
  await runEnd('done', human, HINT);
  ok('`stage_advance hint`（缺省）：**只落提示、不切幕**',
    new TrpgStore().read(HINT)?.currentAct === 'a1'
    && notes.length === 1 && notes[0].text.includes('已经满足'), JSON.stringify(notes));

  // ── ⑤ 标签与人格段 ──
  const chat = new ChatStore();
  chat.appendTrpgNote('group:adv-note', { noteKind: 'advance', text: '事实一句' });
  const past = buildPastState(chat, 'group:adv-note', { limit: 10 });
  ok('`formatEntry` 把 `advance` 子类型印成【推进提示】（与【行动建议】分开）',
    past.text.includes('【推进提示】'), past.text);
  const stored = chat.recent('group:adv-note', { limit: 1 })[0];
  ok('`appendTrpgNote` 的 senderName 也按子类型分（面板与摘要里看得见）',
    stored?.senderName === '推进提示', String(stored?.senderName));
  const persona = rt2.prompt('group:adv-persona').body[0];
  ok('人格段把三种回流标签分开说（压成一个模型就分不出该做什么）',
    ['【跑团笔记】', '【行动建议】', '【推进提示】'].every((label) => persona.includes(label)),
    persona.slice(-400));

  // ── ⑥ 源级：变更点与配额 ──
  const campSrc = stripComments(fs.readFileSync(path.join(ROOT, 'src/extra/trpg/tools/campaign.ts'), 'utf8'));
  ok('源级：四个变更点都走 `resetAdvance`，没人手写 `advancement.x = 0`（漏了 `dirty` 只会让提示晚一轮）',
    (campSrc.match(/resetAdvance\(campaign, 'scene'\)/g) ?? []).length === 1
    && (campSrc.match(/resetAdvance\(campaign, 'flag'\)/g) ?? []).length === 2
    && (campSrc.match(/resetAdvance\(campaign, 'act'\)/g) ?? []).length === 1
    && !/advancement\.\w+ = 0/.test(campSrc));
  ok('源级：`action=advance` 不占主行动配额（quota: false，同 combat）',
    /tool: 'campaign:advance'[\s\S]{0,160}?quota: false/.test(campSrc));
}

// ── 5u. 模型判定收团（P8-c）：结局校验、两种收团路径、战报与删除时机 ──────────
//
// 四条判据各自"错了也不报错"：未知 endingId 被放行 → 模型念一个不存在的结局；摘要里的
// 结局段来自模型的话 → 幻觉进了"代码算的"那一段；人敲与模型收团形状一样 → 两种语义混成
// 一种；存档删早了 → 模型这一轮念不完结局。
{
  const rt = createRuntime({ deliverNote: () => {} });
  const scenarios = new ScenarioStore();
  const md = (title) => ['---', 'title: ' + title, '---', '正文。'].join(String.fromCharCode(10));
  const call = (name, key, args) => rt.handlers[name](fakeCtx(key), args);
  const camp = (key) => new TrpgStore().read(key);
  const journal = new JournalStore();
  const cmds = rt.commandHandlers;
  // 键是 `<命令> <子命令>`（带空格），所以要取前两个词 —— 只取第一个会落到裸 `.trpg` 上。
  const say = (key, text) => {
    const words = text.split(' ');
    const handler = cmds[`${words[0]} ${words[1] ?? ''}`] ?? cmds[words[0]];
    return handler({ chatKey: key, senderId: '1', text, media: [], replyToMessageId: null });
  };

  scenarios.write('结局团', md('结局团'));
  scenarios.writeExtras('结局团', {
    struct: {
      scenes: [{ name: '码头', summary: '', npcs: [], clues: [] }],
      endings: [
        { id: 'e1', name: '远行', trigger: { op: 'flag', key: '灯塔熄灭', value: '是' },
          readAloud: '天亮时你们把灯重新点着了。', rewards: 'SAN +1D6',
          keeperNotes: '守塔人没有跟着离开' },
        { id: 'e2', name: '留守', trigger: { op: 'flag', key: '留下', value: '是' },
          readAloud: '你们决定留在灯塔。', rewards: '' }
      ]
    }
  });
  scenarios.write('无结局团', md('无结局团'));

  // ── ① 三种校验 ──
  const K = 'group:end-main';
  await call('campaign', K, { action: 'start', scenario: '结局团' });
  const unknown = await call('campaign', K, { action: 'end', endingId: '不存在的' });
  ok('未知 endingId → **拒绝**并列出真实的结局（硬约束：不许幻觉出剧本没有的结局）',
    unknown.isError === true && /没有叫「不存在的」的结局/.test(body(unknown))
    && /远行/.test(body(unknown)) && /留守/.test(body(unknown)), body(unknown));
  const unmet = await call('campaign', K, { action: 'end', endingId: '远行' });
  ok('触发条件不满足 → 拒绝，并**逐条**说清还差什么',
    unmet.isError === true && /还差/.test(body(unmet)) && /灯塔熄灭/.test(body(unmet)), body(unmet));
  const noReason = await call('campaign', K, { action: 'end' });
  ok('既没 endingId 也没 reason → 拒绝并说清两条路',
    noReason.isError === true && /endingId/.test(body(noReason)) && /reason/.test(body(noReason)),
    body(noReason));

  // 把触发旗标设成**暗线**：收团后它不该再出现在"没解开的事"里（那一条显然已经解开了）。
  await call('campaign', K, { action: 'flag', flags: { 灯塔熄灭: '是' }, visible: false });
  const ended = await call('campaign', K, { action: 'end', endingId: '远行' });
  ok('条件满足 → 收团；首句带「（结局：远行）」',
    ended.isError !== true && /（结局：远行）/.test(body(ended)), body(ended));
  ok('摘要里有一行「结局：远行（SAN +1D6）」—— 这一段**来自代码**（剧本快照），不是模型的话',
    /结局：远行（SAN \+1D6）/.test(body(ended)), body(ended));
  ok('回执把**宣读文本**给模型（它只在收团这一刻需要）',
    /天亮时你们把灯重新点着了/.test(body(ended)), body(ended));
  ok('回执**不给** keeperNotes（结局已经结束，再给只会诱使模型多说）',
    !/守塔人没有跟着离开/.test(body(ended)), body(ended));
  ok('"没解开的事"**排除结局 trigger 点到的旗标**（它显然已经解开了）',
    !/没解开的事/.test(body(ended)), body(ended));
  ok('`campaign.ended` 标记写下了（endingId + reason + 时间）',
    camp(K)?.ended?.endingId === 'e1' && typeof camp(K)?.ended?.at === 'number',
    JSON.stringify(camp(K)?.ended));

  // ── ② 战报与删除时机 ──
  ok('这一刻存档**还在**（删除发生在这一轮的收尾，好让模型把结局讲完）', camp(K) !== null);
  ok('战报里已经有 [结局] 那一条，且是最后一条',
    (() => {
      const entries = journal.read(K).filter((entry) => entry.visible !== false);
      const last = entries[entries.length - 1];
      return last?.kind === 'ending' && last.text === '结局：远行';
    })(), JSON.stringify(journal.read(K).slice(-2)));
  await rt.onRunEnd({ chatKey: K, status: 'done', sentCount: 1, trigger: [{ kind: undefined, text: 'x' }] });
  ok('收尾之后存档**真的没了**（工具里删会被 `withCampaign` 的写回复活）', camp(K) === null);
  ok('战报**留着**（收团不清战报）',
    journal.read(K).some((entry) => entry.kind === 'ending'));

  // ── ③ 自由结局 ──
  const F = 'group:end-free';
  await call('campaign', F, { action: 'start', scenario: '结局团' });
  const free = await call('campaign', F, { action: 'end', reason: '朋友们各自散了' });
  ok('给了 reason、没给 endingId → 自由结局；首句是「（自由结局）」',
    free.isError !== true && /（自由结局）/.test(body(free)), body(free));
  ok('摘要里那一段写的是 reason，并标「（自由结局）」',
    /结局：朋友们各自散了（自由结局）/.test(body(free)), body(free));
  ok('自由结局也进战报（战报要知道这一局为什么结束）',
    journal.read(F).some((entry) => entry.kind === 'ending' && entry.text.includes('朋友们各自散了')));

  const Z = 'group:end-noendings';
  await call('campaign', Z, { action: 'start', scenario: '无结局团' });
  const noEndings = await call('campaign', Z, { action: 'end', reason: '演不下去了' });
  ok('剧本**没有 endings** 时 `action=end` 仍可用，回执明说"本剧本没有预定义结局"',
    noEndings.isError !== true && /没有预定义结局/.test(body(noEndings)), body(noEndings));

  // ── ④ 人敲的 `.trpg end`（强制收团）──
  const H = 'group:end-human';
  await call('campaign', H, { action: 'start', scenario: '结局团' });
  const human = String(await say(H, '.trpg end'));
  ok('人敲的 `.trpg end`：剧本有 endings 时**末尾多一句**「这是强制收团」',
    /这是强制收团/.test(human), human);
  ok('而且**没有**结局段（那一段只属于模型触发）',
    !/结局：远行/.test(human) && !/（结局：/.test(human), human);
  ok('人敲的路径**不落** `[结局]` 条目',
    !journal.read(H).some((entry) => entry.kind === 'ending'), JSON.stringify(journal.read(H).map((e) => e.kind)));
  ok('人敲的路径**立刻**删存档', camp(H) === null);

  const H2 = 'group:end-human2';
  await call('campaign', H2, { action: 'start', scenario: '无结局团' });
  const human2 = String(await say(H2, '.trpg end'));
  ok('剧本没有 endings 时，人敲的回执**逐字不变**（不多那句话）',
    !/强制收团/.test(human2), human2);

  // ── ⑤ 进程中断留下的 ended 存档可以被新开局覆盖 ──
  const L = 'group:end-leftover';
  await call('campaign', L, { action: 'start', scenario: '结局团' });
  await call('campaign', L, { action: 'end', reason: '中断前那一次' });
  ok('夹具：那个会话此刻是"已收团但没删"的状态', camp(L)?.ended !== undefined);
  const fresh = await call('campaign', L, { action: 'start', title: '换个新团' });
  ok('**ended 的存档当成没有**：新开局能覆盖（否则这个会话永远开不了新团）',
    fresh.isError !== true && camp(L)?.title === '换个新团' && camp(L)?.ended === undefined,
    body(fresh));

  // ── ⑥ 提示词 ──
  const P = 'group:end-prompt';
  await call('campaign', P, { action: 'start', scenario: '结局团' });
  const briefing = rt.prompt(P).body[1];
  ok('briefing 里有结局清单（名字 + 触发 + 奖励）—— 模型要靠它"每轮检查"',
    /本剧本的结局/.test(briefing) && /远行 —— 旗标：灯塔熄灭 = 是（SAN \+1D6）/.test(briefing),
    briefing.slice(-400));
  ok('briefing **不含**宣读文本与幕后信息（前者只在收团回执里出现一次）',
    !/天亮时你们把灯重新点着了/.test(briefing) && !/守塔人没有跟着离开/.test(briefing));
  const persona = rt.prompt(P).body[0];
  ok('人格段有「什么时候该收团」，且明说"不确定时不要强行宣布"',
    /【什么时候该收团】/.test(persona) && /不确定的时候不要强行宣布/.test(persona),
    persona.slice(-500));

  // ── ⑦ 源级：两条路径不混 ──
  const sessSrc = stripComments(fs.readFileSync(path.join(ROOT, 'src/extra/trpg/model/session.ts'), 'utf8'));
  ok('源级：人敲的收团路径**不写** `[结局]` 日志（那一条只属于模型触发）',
    !/appendLog\([^)]*'ending'/.test(sessSrc));
  const toolSrc = stripComments(fs.readFileSync(path.join(ROOT, 'src/extra/trpg/tools/campaign.ts'), 'utf8'));
  ok('源级：`action=end` 不占主行动配额（quota: false，同 combat/advance）',
    /tool: 'campaign:end'[\s\S]{0,160}?quota: false/.test(toolSrc));
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
  ok('4 个工具 + 12 条命令声明（命令面统一到 `.`，子命令由 `subs` 展开）',
    entry.tools.length === 4 && (entry.commands ?? []).length === 12,
    `${entry.tools.length}/${(entry.commands ?? []).length}`);
  ok('声明就是那十二条，而且**每条裸命令都排在自己的子命令之后**（顺序即行为）',
    JSON.stringify((entry.commands ?? []).map((spec) => spec.names[0]))
    === JSON.stringify(['.trpg', '.trpg', '.pc', '.pc', '.combat', '.combat', '.log', '.log', '.ra', '.rh', '.st', '.r'])
    && JSON.stringify((entry.commands ?? [])[0].subs)
      === JSON.stringify(['new', 'join', 'status', 'start', 'end', 'mode', 'scenario', 'check'])
    && (entry.commands ?? [])[1].subs === undefined
    && JSON.stringify((entry.commands ?? [])[2].subs) === JSON.stringify(['new', 'roll', 'confirm', 'show', 'save'])
    && (entry.commands ?? [])[3].subs === undefined
    && JSON.stringify((entry.commands ?? [])[4].subs) === JSON.stringify(['start', 'next', 'end'])
    && (entry.commands ?? [])[5].subs === undefined
    && JSON.stringify((entry.commands ?? [])[6].subs) === JSON.stringify(['export'])
    && (entry.commands ?? [])[7].subs === undefined,
    JSON.stringify((entry.commands ?? []).map((spec) => [spec.names, spec.subs])));
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
  /** 兜底那次独立调用的用量（生产里由 `web/app.ts` 接到 `SessionRegistry.addExtraUsage`）。 */
  const suggestedUsage = [];
  const withSink = createRuntime({
    deliverNote: (chatKey, note) => sessions.push({ chatKey, ...note }),
    recordUsage: (recorded) => suggestedUsage.push(recorded)
  });
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
  // 这一次调用发生在 `finish()` 之后，用量走的是"只叠增量"的口子（2026-10-17 补的缺口）。
  ok('兜底那一次独立调用的用量**交宿主的 `recordUsage`**（不是只打一行日志）',
    suggestedUsage.length === 1 && suggestedUsage[0].promptTokens === 10
    && suggestedUsage[0].completionTokens === 5 && suggestedUsage[0].totalTokens === 15,
    JSON.stringify(suggestedUsage));

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
  // 记账认的是"这一次调用真的发生了"：⑦ 那次端点不可达（抛错、根本没有 usage）不记，
  // ① 与 ⑧ 两次成功各记一笔 —— 一共两笔。
  ok('用量只在调用真的发生时记一笔（端点不可达的那一次不记）',
    suggestedUsage.length === 2, JSON.stringify(suggestedUsage));

  // ⑨ **助手模式**：上面每一条都成立，但它整轮不说话是常态、而"给几个行动方向"在骰子助手的
  // 语境里毫无意义 —— 所以模式这一条要能**单独**把兜底挡掉（不然它会白烧一次调用，
  // 还把助手叫醒去说一堆它这个形态下不该说的话）。
  const assistantModes = new TrpgModeStore();
  seed('group:926');
  assistantModes.write('group:926', 'assistant');
  arm();
  await withSink.onRunEnd({ chatKey: 'group:926', status: 'noreply', sentCount: 0, trigger: [person] });
  ok('助手模式下**不跑兜底**（真人推动 + 沉默两个条件都成立也不跑）',
    sessions.length === 2, JSON.stringify(sessions.map((item) => item.chatKey)));

  // 对照：把同一个会话切回 DM，同样的一次必须**真的生成**（否则上一条是假绿）。
  assistantModes.write('group:926', 'dm');
  arm();
  await withSink.onRunEnd({ chatKey: 'group:926', status: 'noreply', sentCount: 0, trigger: [person] });
  ok('对照：切回 DM 之后同样的一次真的生成了（上一条才不是假绿）',
    sessions.length === 3 && sessions[2].chatKey === 'group:926', JSON.stringify(sessions.map((item) => item.chatKey)));
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

  // ── `refund`：`consume` 的逆操作（2026-10-19 加）──
  //
  // 它服务的是"报错的那一次不占额度"（`tools/shared.ts` 的 `spent` 那一格）。四条判据里
  // 后两条是**防坏账**的：多退一次不能让计数变成负数，退一个从没记过的人也不能抛。
  const paid = createLedger();
  consume(paid, '阿飞', '');
  refund(paid, '阿飞', '');
  ok('退回来的额度能再用（主行动那一格回到"没用过"）', consume(paid, '阿飞', '').ok === true);
  const paidExtra = createLedger();
  for (const source of ['multiattack', 'haste', 'time_stop']) consume(paidExtra, '酒保', source);
  refund(paidExtra, '酒保', 'time_stop');
  refund(paidExtra, '酒保', 'time_stop');   // 多退一次
  ok('额外行动同样退得掉，而且**多退一次不会变成负数**（退不掉就什么都不做）',
    consume(paidExtra, '酒保', 'time_stop').ok === true
    && consume(paidExtra, '酒保', '另一个来源').ok === false);
  ok('退一个从没记过的行动者不抛错，也不影响别人',
    (refund(paid, '查无此人', ''), consume(paid, '查无此人', '').ok === true
      && consume(paid, '阿飞', '').ok === false));
}

// ── 7a. 调用闸门：`.trpg scenario` 与 `.rh` 的暗骰叙事（2026-10-19 加）──────────
//
// 这两条命令是白名单群里**任何群友**都能敲的，而各自要发模型调用（一份模组最多 7 次、
// 一次暗骰 1 次）。其余重能力早就各有一本 `SlidingWindowBudget`，跑团原先一个都没有。
// 两段的判据不同：`.trpg scenario` 被拦下时**整条命令不做**，`.rh` 被拦下时**只省掉叙事**
// （点数照掷照发）—— 后者才是这条命令的正文。
{
  const { SlidingWindowBudget } = await load('media/call-budget.js');
  const { createScenarioCommand } = await load('extra/trpg/commands/scenario.js');
  const { takeNarrationBudget } = await load('extra/trpg/commands/check.js');

  const tight = new SlidingWindowBudget({ getLimits: () => ({ perChatPerHour: 1, perDay: 100 }) });
  const cmd = createScenarioCommand({
    scenarios: new ScenarioStore(), budget: tight, command: '.trpg scenario'
  });
  // 媒体里没有 `url` → `saveScenario` 会**在下载之前**早退，所以这条用例不碰网络。
  const file = [{ kind: 'file', name: '灯塔.md' }];
  const send = (chatKey, text, media = file) => cmd({ chatKey, senderId: '10001', text, media, replyToMessageId: null });
  ok('夹具：没有下载地址时走到那句可读的早退（下面两条断言才有判别力）',
    /协议端没给下载地址/.test(String(await send('group:budget', '.trpg scenario 灯塔'))));
  const blocked = String(await send('group:budget', '.trpg scenario 灯塔'));
  ok('`.trpg scenario` 的闸门：额度用完时**整条命令不做**，并说清过一会儿再来',
    /传剧本太频繁/.test(blocked) && /data\/trpg\/scenarios/.test(blocked), blocked);
  // 单位是**份**（敲了几次），不是"几次模型调用" —— 一次触发的成本在 0 / 1 / 7 之间浮动，
  // 而闸门排在下载之前、只知道"敲了一次"。这句话改回"5 次调用"就是回到了那个歧义。
  ok('限流说的是**份**（触发次数），不是"几次模型调用"',
    /最多 5 份/.test(blocked) && !/最多 5 次/.test(blocked), blocked);
  ok('闸门**按会话**算（另一个群照常放行）',
    /协议端没给下载地址/.test(String(await send('group:budget-2', '.trpg scenario 灯塔'))));
  ok('不带名字、也没引用文件时（列剧本库）根本不记账 —— 那一步一次模型调用都不发',
    /剧本库/.test(String(await send('group:budget', '.trpg scenario', []))));

  const tiny = new SlidingWindowBudget({ getLimits: () => ({ perChatPerHour: 1, perDay: 100 }) });
  ok('暗骰叙事的闸门（正）：还有额度 → 放行', takeNarrationBudget(tiny, 'group:b') === true);
  ok('暗骰叙事的闸门（负）：额度用完 → 返回 false（调用方据此**只省掉叙事**）',
    takeNarrationBudget(tiny, 'group:b') === false);
  ok('它同样按会话算（另一个群照常放行）', takeNarrationBudget(tiny, 'group:c') === true);
  ok('缺省那一本账（`undefined`）照常能用，不会抛',
    takeNarrationBudget(undefined, 'group:first-ever') === true);
}

// ── 7c. 战报的**跨局分界**与模式的 mtime 缓存（2026-10-19 加）──────────────────
//
// 两件都是"运维层"的毛病，各自的成因不同：
//   • 战报按**会话** append，而 `.trpg end` 只删存档、不清战报 —— 连开两局之后导出的文件里
//     两局混在一起，`seq` 还是每局从 1 重来的。判据是 `TrpgLogEntry.session`。
//   • `modes.json` 原先**每条入站消息读一遍**（`intercept` 问的第一件事就是它），
//     而"不缓存"那条理由（手改文件不生效）对 mtime 缓存不成立。
{
  const { mirrorLog } = await load('extra/trpg/model/campaign.js');
  const { renderJournal } = await load('extra/trpg/render/journal.js');
  const entry = (seq, text, session) => ({ seq, ts: 0, kind: 'roll', text, ...(session ? { session } : {}) });

  ok('单局导出**逐字不变**：分界行只在真有第二局时才出现',
    !/第 \d 局/.test(renderJournal('group:j', [entry(1, 'a', 's1'), entry(2, 'b', 's1')])));
  const two = renderJournal('group:j', [entry(1, 'a', 's1'), entry(1, 'c', 's2')]);
  ok('两局：在第二局那一条**之前**插一行分界（否则读的人只看到一串重复的序号）',
    /—— 第 2 局/.test(two) && two.indexOf('第 2 局') < two.indexOf('c'), two);
  ok('旧战报（一条 `session` 都没有）一条分界都不印 —— 与加这个功能之前逐字相同',
    !/第 \d 局/.test(renderJournal('group:j', [entry(1, 'a'), entry(2, 'b')])));

  const campaign = emptyCampaign('group:j2', { title: 't', system: '', rule: 'generic' });
  const seen = [];
  appendLog(campaign, 'roll', '一');
  mirrorLog(campaign, 1, { append: (key, item, session) => seen.push({ key, session }) });
  ok('镜像时把**这一局的 `sessionId`** 一起交给战报（缺了它，上面那条分界就没有判据）',
    seen.length === 1 && seen[0].session === campaign.sessionId && campaign.sessionId !== '',
    JSON.stringify(seen));

  const modes = new TrpgModeStore(path.join(DIR, 'modes-cache.json'));
  modes.write('group:x', 'assistant');
  ok('写完之后立刻读得到（同一秒内 rename 的 mtime 分辨率不够，所以写那一侧要显式作废缓存）',
    modes.read('group:x') === 'assistant');
  // 外部改文件（不经这个实例写）→ 签名（mtime + size）变 → 下一次读必须看到新的一版。
  // ⚠️ 显式把 mtime 推到未来：**只按 mtime 缓存时**这一条会间歇性红（同一 tick 内连写两次，
  // mtime 一样），而实现已经加上了 `size` 那一维；这里推 mtime 是让这条用例与"手改文件"
  // 这个场景本身一致（真手改不会卡在同一毫秒）。
  fs.writeFileSync(modes.file, JSON.stringify({ 'group:x': 'dm' }), 'utf8');
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(modes.file, future, future);
  ok('**手改了文件也读得到新的一版**（缓存按 mtime + size 失效，不是"读一次就永远记着"）',
    modes.read('group:x') === 'dm');
  ok('坏 JSON 与"没有这个文件"同一条路：给缺省模式，不抛',
    (fs.writeFileSync(modes.file, '{不是 JSON', 'utf8'),
    fs.utimesSync(modes.file, new Date(Date.now() + 9000), new Date(Date.now() + 9000)),
    modes.read('group:x') === 'dm'));
}

// ── 7b. 用量记账：**不在任何会话里**的那两次调用（E）────────────────────────
//
// 跑团有两次独立的 `chatCompletion`（兜底建议、暗骰叙事），它们发生在
// `SessionRegistry.finish()` **之后**，所以借不了会话那条记账路 —— 那条路
// （`#persist` → `#bumpTodayUsage`）对**已结束**的会话每次都会把整份 `usage` 再累加一遍，
// 拿它补记一次增量等于把那一整轮的账算两遍。宿主因此另开了一个"只叠增量"的入口
// （`SessionRegistry.addExtraUsage`），由组装根接在 `ExtraRuntimeDeps.recordUsage` 上。
//
// 上面 5i / 6 两段验的是**扩展那一半**（`recordUsage` 收到确切的那三个数），
// 这一节补的是**另一半**：它落进 `usage-today.json` 之后账对得上，以及组装根真的接上了。
{
  const { SessionRegistry } = await load('chat/sessions.js');
  const usageFile = path.join(DIR, 'usage-today.json');
  const readUsage = () => {
    try { return JSON.parse(fs.readFileSync(usageFile, 'utf8')); } catch { return null; }
  };
  const registry = new SessionRegistry(0);

  // 起点：先把这一刻的账读出来，后面一律按**增量**断言 —— 临时数据目录是整段共用的，
  // 拿绝对值断言会被"前面某段也记过账"干扰（这类"全局状态里恰好只有我一个"的前提
  // 在本仓库被踩过，见 AGENTS.md 的测试约定）。
  const start = readUsage();
  const base = start ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, runs: 0 };

  registry.addExtraUsage({ promptTokens: 11, completionTokens: 7, totalTokens: 18, cachedTokens: 3 });
  const first = readUsage();
  ok('独立调用的用量落进 `usage-today.json`（四个数一起叠）',
    first.promptTokens === base.promptTokens + 11 && first.completionTokens === base.completionTokens + 7
    && first.totalTokens === base.totalTokens + 18 && first.cachedTokens === base.cachedTokens + 3,
    JSON.stringify({ first, base }));
  ok('⚠️ 它**不动 `runs`** —— 那两次调用不是一次 agent 运行，算进去会让"每次花多少"失真',
    first.runs === (base.runs ?? 0), JSON.stringify({ runs: first.runs, base: base.runs }));

  // 读模型（面板与 `/api/usage` 走的就是它）与文件同源 —— 这个实例没有运行中的会话，
  // 所以两者必须逐字相等。
  const seen = registry.todayUsage(first.dayKey);
  ok('`todayUsage()` 看得到这笔账（读模型与写入点认的是同一个文件）',
    seen.promptTokens === first.promptTokens && seen.totalTokens === first.totalTokens
    && seen.runs === first.runs, JSON.stringify(seen));

  registry.addExtraUsage({ promptTokens: 1, completionTokens: 1, totalTokens: 2, cachedTokens: 0 });
  const second = readUsage();
  ok('第二次调用是**叠**上去的（不是覆盖，也不是把第一笔再写一遍）',
    second.totalTokens === first.totalTokens + 2 && second.runs === first.runs,
    JSON.stringify(second));

  // 四个数全是 0 = 这次调用没有用量可记（提供商没报 usage）。
  // ⚠️ 判据只能是"**盘上没多出东西**"：比内容看不出差别（写一次零增量内容一模一样），
  // 所以先把文件挪开、跑完再放回来 —— 文件不存在时"没写"与"写了"才是可分的。
  const saved = fs.existsSync(usageFile) ? fs.readFileSync(usageFile, 'utf8') : null;
  fs.unlinkSync(usageFile);
  registry.addExtraUsage({ promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0 });
  registry.addExtraUsage(null);
  ok('四个数全是 0（或压根没给）时**一次盘都不写**（零增量不该产生一条记录）',
    !fs.existsSync(usageFile));
  if (saved !== null) fs.writeFileSync(usageFile, saved, 'utf8');

  // 对照：**一次真实会话结束**照旧整份记账、`runs` 加一 —— 两条路共用的那个写入点
  // （`#addTodayUsage`）没有被这次重构改坏。少了这条，"共用一个写入点"就只剩注释在说。
  const session = registry.create({ chatKey: 'group:1', trigger: [] });
  session.usage = { promptTokens: 100, completionTokens: 50, totalTokens: 150, cachedTokens: 0, calls: 1 };
  registry.finish(session.id, 'done');
  const after = readUsage();
  ok('对照：会话结束照旧加 1 次 `runs` 并整份记账',
    after.runs === second.runs + 1 && after.totalTokens === second.totalTokens + 150,
    JSON.stringify(after));

  // ── 接线的源级断言 ──
  //
  // 上面那几条验的是入口本身，**验不到"组装根真的把它接上了"**：`web/app.ts` import 不了
  // （它要起整个 app，那正是第 9 段做的事，而第 9 段不碰用量）。所以这里扫源码文本，
  // 与「带副作用的入口文件只能靠文本断言守」是同一条（见 AGENTS.md 的测试约定）。
  const app = stripComments(fs.readFileSync(path.join(ROOT, 'src', 'web', 'app.ts'), 'utf8'));
  ok('组装根把扩展的 `recordUsage` 接到 `SessionRegistry.addExtraUsage`（只叠增量的那个入口）',
    /recordUsage:\s*\(usage\)\s*=>\s*sessions\.addExtraUsage\(usage\)/.test(app));
  ok('`recordUsage` 是**宿主的口子**（`extra/types.ts` 上的可选成员），扩展只说"记多少"',
    /recordUsage\?\(usage: ExtraUsage\)/.test(
      stripComments(fs.readFileSync(path.join(ROOT, 'src', 'extra', 'types.ts'), 'utf8'))));
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
  // **扫整个目录**，不钉单个文件：2026-10-16 那次分层重构把 `tools.ts` 拆成了五个文件，
  // 钉单文件会以"找不到这段代码"的形式**假红**（而它想守的性质其实完好）。
  // 扫目录还有一条额外的好处：将来新增的掷骰路径自动纳入，不必记得回来加文件名。
  const walk = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => (
    entry.isDirectory()
      ? walk(path.join(dir, entry.name))
      : (entry.name.endsWith('.ts') ? [path.join(dir, entry.name)] : [])
  ));
  const files = walk('src/extra/trpg');
  const body = (rel) => stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
  const all = files.map((rel) => body(rel));
  const outsideEntropy = files.filter((rel) => !rel.endsWith('entropy.ts')).map((rel) => body(rel)).join('\n');
  const rules = files.filter((rel) => rel.includes(`${path.sep}rules${path.sep}`)).map((rel) => body(rel)).join('\n');

  ok('跑团源码树里 `Math.random` **一处都没有**（随机源只有一个入口：`entropy.ts` 的 secureRng）',
    all.every((text) => !/Math\.random/.test(text)),
    files.filter((rel, i) => /Math\.random/.test(all[i])).join(' | '));
  ok('`node:crypto` 只在 entropy.ts 里出现（两个熵源迟早会漂移）',
    /node:crypto/.test(body('src/extra/trpg/entropy.ts')) && !/node:crypto/.test(outsideEntropy));
  ok('规则层是纯函数目录：里面一条相对 import 都没有指向 rules/ 之外，也没有 node: 内置',
    !/from\s*'\.\.\//.test(rules) && !/from\s*'node:/.test(rules));
  ok('闸门扫的是**整个目录**（不是钉死的几个文件名）—— 它至少覆盖 rules/ 下现有的五个文件',
    files.filter((rel) => rel.includes(`${path.sep}rules${path.sep}`)).length >= 5,
    String(files.length));

  // ── 两条接线的源级断言（P3）──
  //
  // 它们都没法在套件里从行为上验：`web/app.ts` import 不了（它要起整个 app），
  // 而 `sendPrivate` 那条链的终点是**真的给一个 QQ 号发私聊**。所以只能扫源码文本。
  // 这与「带副作用的入口文件只能靠文本断言守」是同一条（见 AGENTS.md 的测试约定）。
  const app = body('src/web/app.ts');
  ok('`web/app.ts` 真的把 `sendPrivate` 接上了，而且走的是**同一只 `SendQueue`**（`private:` 前缀）',
    /sendPrivate:/.test(app) && /private:\$\{/.test(app) && /sender\.sendTextBatch/.test(app));
  ok('`say` 的 `atUserId` 真的透传到 `sendTextBatch`（不传的话模型写了 @ 也点不到人）',
    /atUserId/.test(body('src/extra/trpg/tools/say.ts'))
    && /atUserId/.test(body('src/extra/trpg/spec.ts'))
    && /atUserId:/.test(body('src/extra/prompts.ts')));
  // `.trpg scenario` 那条命令要把宿主的 `recordUsage` 一路带到抽取管线 —— 而那段（下载 + 抽文本）
  // 在套件里跑不了（要真网络 + 真 Python），所以只能从源码文本上守"接上了"这一件事。
  // ⚠️ 2026-10-19 拆成"前半就地 / 后半交出去"之后，判据跟着变成**同一个 `deps` 对象交给两半**：
  // 只钉 `finishScenario(...)` 那一行的话，把 `openScenario` 那处漏掉（读字节那一步不记账）
  // 不会有任何报错。
  const scenarioSrc = body('src/extra/trpg/commands/scenario.ts');
  ok('`.trpg scenario` 把宿主的 `recordUsage` 透下去（否则抽取最多 6 次调用的成本没人记账）',
    // ⚠️ `[\s\S]` 而不是 `[^\n]`：那一行 2026-10-19 换成了多行写法（多了 `sendText`），
    // 用 `[^\n]` 的话它会以"找不到"的形式假红 —— 而它想守的接线其实完好。
    /'\.trpg scenario'[\s\S]{0,200}?recordUsage: deps\.recordUsage/.test(body('src/extra/trpg/commands/index.ts'))
    && /recordUsage \}/.test(scenarioSrc)
    && /openScenario\(input, deps\)/.test(scenarioSrc)
    && /finishScenario\(doc, shown, name, scenarios, deps\)/.test(scenarioSrc));
  // 抽取最多 90 秒，而命令是被 `ingest.ts` 的按会话串行链 await 的 —— 没有这个口子就只能
  // 就地跑完，那 90 秒里整个群的消息都排在后面。三条缺一不可：接口上有、组装根接了、
  // 命令层真的往下递了。
  ok('`sendText` 是宿主的口子，`web/app.ts` 接上了，命令层也真的递了下去（抽取不再堵住入站链）',
    /sendText\?\(/.test(body('src/extra/types.ts'))
    && /sendText: async \(chatKey/.test(app)
    && /sendText: deps\.sendText/.test(body('src/extra/trpg/commands/index.ts')));
  ok('`sendPrivate` 是**宿主的口子**（`extra/types.ts` 上的可选成员），扩展只说"给谁、说什么"',
    /sendPrivate\?\(/.test(body('src/extra/types.ts')));
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
    // 窗口容量与历史深度**故意配小**：下面要验「跑团挂载期间按会话把它们抬起来」
    // （见 `impl.ts` 的 `configPatch` 与 `CONTEXT_FLOOR`）。
    store: { contextSliderPos: 95, historyCount: 10, maxContextMessages: 20, promptContextMaxChars: 8000 },
    reply: { maxWaitMs: 0, maxPerMinute: 0 },
    // 两个群都绑给 trpg：701 走缺省的 DM，703 在下面切成助手（同一个扩展、两种形态）。
    extras: { enabled: { trpg: true }, override: { 'group:701': 'trpg', 'group:703': 'trpg' } }
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
  ok('**接管会话的工具表只剩跑团那 4 个**（内置那些全部让位）',
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

  // ── P5 的战斗：工具表与人格段都要真的到位 ──
  //
  // 工具 schema 是**每次请求前缀**的一部分，所以"参数里有没有 `combat` / `sub`"这件事
  // 只能在这里看（`spec.ts` 的声明与模型拿到的东西之间隔着 `buildToolDefs` 那一层）。
  const campaignTool = (taken?.tools ?? []).find((tool) => tool.function?.name === 'campaign');
  const params = campaignTool?.function?.parameters ?? {};
  ok('**`campaign` 的 `action` 枚举里有 `combat`**（工具表是模型唯一能看到"有这个能力"的地方）',
    (params.properties?.action?.enum ?? []).includes('combat'),
    JSON.stringify(params.properties?.action));
  ok('`sub` 在 `campaign` 的参数里、而且**不是必填**（`required` 不能按 action 分支 —— 只有 `action` 是必填）',
    'sub' in (params.properties ?? {}) && !(params.required ?? []).includes('sub'),
    JSON.stringify([Object.keys(params.properties ?? {}), params.required]));
  ok('跑团人格里真的有"打起来了"那一段（战斗规则不写进人格，模型就只能靠猜 —— 而顺序错了没有机制能发现）',
    /打起来了：/.test(systemText) && /action=combat/.test(systemText));

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

  // 第三个群：**同一个接管扩展，但切成助手模式** —— 这是"按会话换形态"在真 app 里的样子。
  //
  // 比上面那几条单元强的地方在于：这里的工具表与系统提示是经**完整注入链**
  // （`app.ts` → `Orchestrator` → `WakeScheduler` → `agent-runner`）走出来的，
  // 而不是直接读 `toolsFor()` 的返回值 —— "钩子接上了"与"钩子真的影响了模型看到的东西"
  // 是两件事，只有这一段能证明后者。
  new TrpgModeStore().write('group:703', 'assistant');
  const dice = await runOnce('group:703', '3d6', [{ content: '（测试：这一轮不说话）' }]);
  const diceTools = (dice?.tools ?? []).map((tool) => tool.function?.name);
  const diceSystem = String((dice?.messages ?? []).find((m) => m.role === 'system')?.content ?? '');
  ok('**助手模式（真 app）：模型只拿到 say 与 roll**（同一个扩展、另一个会话）',
    JSON.stringify([...diceTools].sort()) === JSON.stringify(['roll', 'say']), JSON.stringify(diceTools));
  ok('**助手模式（真 app）：system prompt 里**一份人格都没有** —— 只剩框架契约两段',
    !/【骰子助手】/.test(diceSystem) && !/【跑团主持人】/.test(diceSystem),
    diceSystem.slice(0, 120));
  ok('助手模式（真 app）：**这个群仍然被接管** —— 内置工具一个都没有（不是"退回主流程"）',
    !diceTools.includes('send_message') && !diceTools.includes('finish'), JSON.stringify(diceTools));
  ok('助手模式（真 app）：框架契约两段仍然在（那是运行契约，与当 DM 还是当骰子机器无关）'
    + '—— 所以"要发言必须调用 say"照旧，真要开口时它仍然知道怎么开口',
    /【安全规则/.test(diceSystem) && /【工作方式/.test(diceSystem) && /say/.test(diceSystem));
  ok('助手模式（真 app）：清单、剧本与状态一概不注入（那些的存在本身就在暗示"你可以叙事"）',
    !/【当前跑团状态】/.test(diceSystem) && !/【剧本与规则】/.test(diceSystem), diceSystem.slice(-200));

  // ── 配置覆盖：挂载期间「上下文宽度」**按会话**抬起来 ──
  //
  // 这是 `configPatch` 在真 app 里的样子，也是当初改**两个核心读取点**的理由：窗口容量
  // （`ContextWindowRegistry`）与历史深度（`WakeScheduler`）现在都读"这一轮那份配置"，
  // 而它们此前读的是全局那份 —— 全局读会让下面前两个断言里的第一个恒等于 20。
  //
  // ⚠️ **隔离那一条才是重点**：覆盖的寿命是一次运行、且按会话。少了它，一个跑团群会把
  // 所有群的窗口一起撑大 —— 而那正是 `configPatch` 与 `updateConfig` 的分界。
  const capOf = (key) => core.orchestrator.windows.stats(key)?.capacity;
  ok('接管群（DM）的窗口容量被抬到下限（全局配的是 20）', capOf('group:701') === 200, String(capOf('group:701')));
  ok('**没被接管的群一点没变**（覆盖不外溢到别的会话）', capOf('group:702') === 20, String(capOf('group:702')));
  ok('助手模式**不抬**（它压根不跑模型，抬了只是白占内存）', capOf('group:703') === 20, String(capOf('group:703')));

  // ── 响应档位：接管群**无视**全局档位（2026-10-19 加）──
  //
  // 判据是"玩家说的每一句话 DM 都看得见"。这里把全局滑条调到 0（1 档 = 只响应艾特），然后把
  // **同一句话**分别发给两个群：
  //   • group:701（被接管）—— 照样起一轮（扩展的 `configPatch` 把档位抬到 4 档）；
  //   • group:702（没被接管）—— 一条模型请求都不产生（对照组，证明上一条不是假绿）。
  //
  // ⚠️ 这一段钉的是**核心那一个读取点**：`WakeScheduler.#resolvePendingResponse` 读的必须是
  // `configFor(chatKey)` 而不是全局那份。少了它，`configPatch` 里那一行就是纯死配置 ——
  // 而症状只是"DM 偶尔不理人"，没有任何报错。
  updateConfig({ store: { contextSliderPos: 0 } });
  const runsAfter = async (key, text) => {
    await settle();
    const beforeCount = model.requests.length;
    const entry = core.store.appendIncoming(key, {
      mid: Date.now(), ts: Date.now(), senderId: '10001', senderName: '张三', text
    });
    core.orchestrator.onIncoming(key, entry);
    core.orchestrator.forceWake(key);
    await new Promise((resolve) => setTimeout(resolve, 300));
    return model.requests.length - beforeCount;
  };

  const plainRuns = await runsAfter('group:702', '我推开门');
  ok('**没被接管的群照常受档位约束**：1 档下那句普通的话一条请求都不产生（对照组）',
    plainRuns === 0, String(plainRuns));
  const dmRuns = await runsAfter('group:701', '我推开门');
  ok('**被接管的群无视全局档位**：同一句话照样起一轮（`configPatch` 把档位抬到 4 档）',
    dmRuns > 0, String(dmRuns));
  updateConfig({ store: { contextSliderPos: 95 } });

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

  // 历史深度是**另一个**核心读取点（`WakeScheduler`），所以单独钉一条。
  ok('接管群的**历史深度**也被抬了（会话记录里读得到，全局配的是 10）',
    finished?.historyLimit === 200, String(finished?.historyLimit));

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

  // ── 接口层：战报那一栏（列表 + 删除）──
  //
  // 路由自己 `new JournalStore()`（三个 store 都是**目录的薄视图**），所以这一段顺带把那个
  // 前提钉住：路由那一份读到的必须是扩展写进去的那批文件。错了的话面板会永远显示
  // "还没有任何战报"，而扩展那边一切正常 —— 两边都不会报错。
  const journalFile = new JournalStore();
  journalFile.append('group:901', { seq: 1, ts: Date.now(), kind: 'roll', text: '张三 掷骰：1d100 = 42' });
  const workshopRes = await fetch(`http://127.0.0.1:${port}/api/trpg/workshop`, { headers });
  const workshop = await workshopRes.json();
  const journalRow = (workshop.journals ?? []).find((item) => item.id === 'group_901');
  ok('GET /api/trpg/workshop 列出磁盘上的战报（面板那一份 store 与扩展读写的是同一批文件）',
    workshopRes.status === 200 && workshop.ok === true && journalRow?.entries === 1 && journalRow?.bytes > 0,
    JSON.stringify(workshop.journals));

  const delRes = await fetch(`http://127.0.0.1:${port}/api/trpg/journals/group_901`, { headers, method: 'DELETE' });
  ok('DELETE /api/trpg/journals/<id> 真的把那份战报删掉了',
    delRes.status === 200 && !fs.existsSync(journalFile.file('group:901')), String(delRes.status));
  const again = await fetch(`http://127.0.0.1:${port}/api/trpg/journals/group_901`, { headers, method: 'DELETE' });
  ok('再删一次是 404（报"成功"会让面板以为删掉了）—— 而 `remove()` 的返回值就是这条判据',
    again.status === 404, String(again.status));

  // ── 端到端：开局后，DM 的检定请求里目标值真的被机制改了（P7-d）──
  //
  // 这一段补的是**装配层**那一环：上面 5r 段验的是"`roll` 工具在给定的战役上算出正确的
  // 目标值"，而这里验的是"真 app 里跑一整轮之后，那个改过的数**真的送到了模型手里**"。
  //
  // ⚠️ **它能证明什么、不能证明什么，写清楚**：`web/app.ts` 对规则集**没有**新增任何装配
  // （它只是 `createRuntime()`，与 5r 段同一份实现），所以这里证明的是"工具结果一路穿过
  // 工具循环进了下一轮请求"，**不是**"模型会照那条机制叙事"。后者只有真机看得出来。
  //
  // 战役由**测试侧**的 `new TrpgStore()` 写盘：扩展那个实例与它读的是同一个文件
  // （`TrpgStore` 没有内存缓存，每次 `read()` 都从盘上重新归一化），所以这是有效的布置手段。
  const rigStore = new TrpgStore();
  const rigCamp = emptyCampaign('group:701', { title: '机制团', system: '', rule: 'generic' });
  rigCamp.scene = '灯塔';
  rigCamp.scenario = {
    id: 'rig', body: '',
    ruleExt: {
      version: 1,
      mechanics: [{
        type: 'check_modifier', note: '灯塔的浓雾',
        trigger: { op: 'scene', value: '灯塔' },
        effect: { handler: 'penalty_to_check', params: { value: 20 } },
        sourceQuote: '浓雾里看不远'
      }]
    }
  };
  rigStore.write(rigCamp);

  await settle();
  const mechMark = model.requests.length;
  model.script = [
    { tool_calls: [toolCall('roll', { expr: '1d100', target: 70, reason: '看雾' }, 'r7')] },
    { tool_calls: [toolCall('say', { text: '（测试）雾太浓，什么都看不清。' }, 's7')] },
    { content: null }
  ];
  const mechEntry = core.store.appendIncoming('group:701', {
    mid: Date.now(), ts: Date.now(), senderId: '10001', senderName: '张三', text: '我朝灯塔那边看'
  });
  core.orchestrator.onIncoming('group:701', mechEntry);
  core.orchestrator.forceWake('group:701');
  await settle();

  const mechRound = model.requests.slice(mechMark);
  const calledRoll = mechRound.some((req) => (req?.messages ?? []).some((msg) =>
    (msg.tool_calls ?? []).some((call) => call.function?.name === 'roll')));
  ok('夹具：这一轮模型真的调了 `roll`（不调的话下面两条都是空转的绿）',
    calledRoll, JSON.stringify(mechRound.length));
  // 工具结果是**下一轮请求**里的 `role: 'tool'` 消息 —— 把整轮摊平了找那句话。
  const mechTools = mechRound.flatMap((req) => req?.messages ?? [])
    .filter((msg) => msg.role === 'tool').map((msg) => String(msg.content ?? '')).join('\n');
  ok('真 app 端到端：目标值真的被这一局的机制改了（70 − 20 = 50），不是只改在工具那一层',
    /｜ 对 50 →/.test(mechTools), mechTools.slice(-400));
  ok('真 app 端到端：那句话也跟着进了模型看到的工具结果（不说的话模型只会觉得点数对不上）',
    mechTools.includes('这一局的规则改了目标值：灯塔的浓雾'), mechTools.slice(-400));

  await core.stop();

  await core.stop();
}

process.exit(done() ? 0 : 1);
