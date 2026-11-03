// 工具协议纠正：模型执行查询/读图等工具后，若把普通 content 误当成 QQ 回复，
// 编排层只提醒一次“必须用发送工具”；不代发原文，也不强迫模型一定回复。
import {
  checker, dataDir, fakeModelServer, toolCall, readArchivedSession
} from './lib/harness.mjs';
import { load } from './lib/src.mjs';

dataDir('qqagent-tool-protocol-');
const { ChatStore } = await load('chat/store.js');
const { SessionRegistry } = await load('chat/sessions.js');
const { SendQueue } = await load('qq/sender.js');
const { Orchestrator } = await load('agent/runtime/orchestrator.js');
const { PROMPT_CATALOG } = await load('core/prompt-catalog.js');
const { EVENTS } = await load('core/events.js');
const { updateConfig } = await load('core/config.js');

const { ok, done } = checker();
const model = await fakeModelServer({ model: 'stub-tool-protocol' });

// ── 漫画搜索与下载的边界 ──
//
// 这是用户明确要求的分界：**搜索只搜索，不自动下载**。所以除了 schema，还要正面钉住
// "搜索这条路上没有下载代码" —— 光断言描述文字说了什么是不够的（文字可以留着、代码却接上了）。
{
  const fsMod = await import('node:fs');
  const pathMod = await import('node:path');
  const { buildToolDefs } = await load('agent/tools/index.js');
  const tools = buildToolDefs();
  const searchTool = tools.find((tool) => tool.name === 'search_jmcomic');
  ok('search_jmcomic 工具存在', !!searchTool, tools.map((tool) => tool.name).join('、'));
  ok('search_jmcomic 只要求 query，mode/orderBy/limit 都是可选（能用手写 tag:xxx 的简写）',
    JSON.stringify(searchTool.parameters.required) === '["query"]' &&
    ['keyword', 'tag', 'author', 'work', 'actor'].every((m) => searchTool.parameters.properties.mode.enum.includes(m)) &&
    searchTool.parameters.properties.limit.maximum === 40,
    JSON.stringify(searchTool.parameters));
  ok('search_jmcomic 的 description 明说不会下载',
    String(searchTool.description).includes('不会下载任何东西'), String(searchTool.description));

  const root = pathMod.resolve(import.meta.dirname, '..');
  const body = fsMod.readFileSync(pathMod.join(root, 'src/agent/tools/admin-tools.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  const searchBody = body.slice(body.indexOf("name: 'search_jmcomic'"), body.indexOf("name: 'download_jmcomic'"));
  ok('search_jmcomic 的执行体里没有下载调用（搜索绝不入队）',
    searchBody.includes('searchJmcomic(') && !searchBody.includes('enqueueJmcomicDownload'),
    `执行体长度 ${searchBody.length}`);

  // Catalog 里这一项是**函数**（拼好再返回字符串），不是常量字符串。
  //
  // ⚠️ 规则住在 `capabilityProtocol`，**不是** `toolProtocol`：2026-10-15 把"某个能力的用法"
  // 从框架契约段里拆了出来（接管模式下那些能力多半压根不在，留着就是让模型去调不存在的工具）。
  // 这条断言原先读 `toolProtocol()`，拆段之后必须跟着走 —— 否则它会以"找不到这段文字"的
  // 形式假红，而它想守的性质（这条规则确实进了 system prompt）其实完好。
  const protocol = String(PROMPT_CATALOG.system.capabilityProtocol());
  ok('system prompt 里有"搜到之后先问用户、不要自己挑一本下载"这条规则',
    protocol.includes('search_jmcomic') && protocol.includes('不要自己挑一本下载') &&
    protocol.includes('不要编造 ID'), protocol.slice(-200));
}

// ── 会话账本：`recordSent` 是唯一的写入口 ───────────────────────────────────
//
// 这本账不是日志，是四处判定的输入（收尾 done/noreply、协议纠正的 sentExternalAction 与
// 触发条件、session-end 的 sentCount）。**接管扩展自己写发言工具时必须调它**，
// 漏了的表现是"说了话却被记成 noreply、而且模型被追着再发一次"，两样都不报错。
// 所以这里正面钉住"它真的记账 + 真的发事件"，作为那条契约的守护。
{
  const { recordSent, sentTextEntries } = await load('agent/tools/shared.js');
  const events = [];
  const ctx = {
    session: { id: 'sess-1', sent: [] },
    emit: (type, payload) => events.push([type, payload])
  };

  // 没记任何东西时不该发事件：一次"什么都没发出去"的调用不该让面板白刷一轮。
  recordSent(ctx, []);
  ok('没记任何条目时不发事件', ctx.session.sent.length === 0 && events.length === 0);

  const entries = sentTextEntries({ sent: [{ text: '好', at: '12:00:00', messageId: 7 }] });
  ok('sentTextEntries 把传输层的宽松形状收成账本条目（text 一定是字符串）',
    Array.isArray(entries) && entries.length === 1 && entries[0].type === 'text'
    && entries[0].text === '好' && entries[0].at === '12:00:00', JSON.stringify(entries));

  recordSent(ctx, entries);
  ok('recordSent 把条目推进会话账本',
    ctx.session.sent.length === 1 && ctx.session.sent[0].text === '好', JSON.stringify(ctx.session.sent));
  ok('recordSent 同时发一次 session-update（面板要看到这条）',
    events.length === 1 && events[0][0] === EVENTS.sessionUpdate
    && events[0][1]?.sessionId === 'sess-1', JSON.stringify(events));

  // 传输层给不出 at 时不该写成字符串 "undefined" —— 那会变成一条看着像时间的脏数据。
  const noAt = sentTextEntries({ sent: [{ text: '嗯' }] });
  ok('缺 at 的条目留空而不是 "undefined"', noAt[0].at === undefined, JSON.stringify(noAt));
}

// ── 引用目标校验：`checkReplyTarget` ─────────────────────────────────────────
//
// **实测反馈**：模型读图之后填了一个**根本不存在的** `replyToMessageId: "1852997901"`，
// 而发送层原先只做格式校验（`/^-?[1-9]\d*$/`），于是它被静默接受、还回了 `{"sent":1,…}`
// —— 模型得到的反馈是"我引用对了"。根因是**"模型可以引用的 id"与"系统会校验的 id"
// 从来不是同一个集合**。这一段把那条判据的三种结局（放行 / 本轮触发批放行 / 拦下）
// 各自钉死，免得日后被"顺手简化"掉其中一支。
{
  const { checkReplyTarget } = await load('agent/tools/shared.js');
  const ctx = {
    chatKey: 'group:1',
    // 本轮触发批：存档里已经找不到、但模型**这一轮确实看见过**的那条
    triggerEntries: [{ mid: '900' }],
    store: {
      findByMid: (_key, mid) => (String(mid) === '800' ? { mid: '800' } : null),
      recent: () => [{ mid: '800' }, { mid: '900' }]
    }
  };
  ok('没填 replyToMessageId 时闸门不参与（undefined / null / 空串都放行）',
    checkReplyTarget(ctx, undefined) === null && checkReplyTarget(ctx, null) === null
    && checkReplyTarget(ctx, '') === null && checkReplyTarget(ctx, '   ') === null);
  ok('存档里有这条 → 放行', checkReplyTarget(ctx, '800') === null);
  ok('数字与字符串是同一条消息', checkReplyTarget(ctx, 800) === null);
  // 存档可能因容量裁剪、面板删除而丢掉一条模型确实看见过的消息 —— 那种情况下
  // 拿实时存档去判会把**对的**引用误判成错的，所以本轮触发批要优先。
  ok('存档里没了、但本轮触发批里还在 → 仍然放行', checkReplyTarget(ctx, '900') === null);
  const bad = checkReplyTarget(ctx, '1852997901');
  ok('查不到 → 返回一句可纠正的失败（带原文 id 与真实可见的 id）',
    typeof bad === 'string' && bad.includes('1852997901') && bad.includes('不存在')
    && bad.includes('最近可见') && bad.includes('800') && bad.includes('900'), String(bad));
  ok('拦下时不写成"已发送"之类的话（模型据此才知道这条没出去）',
    typeof bad === 'string' && !bad.includes('已发送'), String(bad));
}
updateConfig({
  // 两轮刚好只够“调用工具 → 错误地返回普通文本”；纠正仍应获得独立的第三轮。
  api: { baseUrl: model.url, model: 'stub-tool-protocol', maxRounds: 2 },
  allowAllWhenEmpty: true, allow: { groups: [], private: [] },
  persona: { botName: '小鲸鱼', selfNickname: '小鲸鱼' },
  store: { contextSliderPos: 95, historyCount: 80, maxContextMessages: 0 },
  reply: { maxWaitMs: 0, maxPerMinute: 0 }
});

const memory = {
  formatForPrompt: () => '', members: () => [],
  consolidationState: () => ({ counts: { memberImpression: 0 }, members: [], lastConsolidatedAt: 0 }),
  listChats: () => []
};
const stickers = { sync: async () => ({ entries: [] }) };
let nextMessageId = 1;
const onebot = {
  selfId: '999', selfNickname: '小鲸鱼', connected: true,
  sendText: async () => ({ message_id: nextMessageId++ }),
  sendSticker: async () => ({ message_id: nextMessageId++ }),
  sendPoke: async () => ({}),
  getGroupInfo: async () => ({ group_name: '测试群' }),
  call: async () => ({})
};

const boot = (key) => {
  const store = new ChatStore(0);
  const sessions = new SessionRegistry(0);
  const sender = new SendQueue({ onebot, store });
  const env = { key, store, sessions, sender, ended: [] };
  env.orc = new Orchestrator({
    store, memory, stickers, sender, sessions, onebot,
    emit: (type, payload) => {
      if (type === EVENTS.sessionEnd) env.ended.push(payload);
    }
  });
  return env;
};

async function runScenario(key, script) {
  model.script = script;
  model.requests = [];
  const env = boot(key);
  env.store.appendIncoming(key, {
    mid: Date.now(), ts: Date.now(), senderId: '555', senderName: '张三', text: '@小鲸鱼 看一下'
  });
  env.orc.scheduleWake(key, 0);
  const session = await readArchivedSession(env.sessions, env.ended);
  await env.orc.abortAll();
  return { session, requests: [...model.requests] };
}

const correction = PROMPT_CATALOG.user.toolProtocolCorrection;
const correctionCount = (request) => (request?.messages || [])
  .filter((message) => message?.role === 'user' && message?.content === correction).length;

console.log('=== 1. 查询工具后只返回文本 → 纠正一次，再由模型发送 ===');
{
  const { session, requests } = await runScenario('group:301', [
    { tool_calls: [toolCall('get_recent_messages', { limit: 5 }, 'q1')] },
    { content: '查完了，应该告诉他最近没什么。' },
    { tool_calls: [toolCall('send_message', { messages: ['最近没啥'] }, 's1')] }
  ]);
  ok('maxRounds=2 时仍获得一次独立纠正轮', requests.length === 3, `请求数=${requests.length}`);
  ok('纠正只在第三轮出现且只插入一份',
    correctionCount(requests[0]) === 0 && correctionCount(requests[1]) === 0 && correctionCount(requests[2]) === 1,
    JSON.stringify(requests.map(correctionCount)));
  ok('纠正后的发送工具正常执行，会话记为 done',
    session?.status === 'done' && session?.sent?.some((item) => item.text === '最近没啥'),
    JSON.stringify({ status: session?.status, sent: session?.sent }));
  // 面板上的「这条没有发到 QQ」靠这个标记；没有它就只能靠"这一轮有没有工具调用"去猜。
  const droppedAfterTool = (session?.messages || []).find((m) => m.role === 'assistant' && m.droppedText === true);
  ok('工具后那段未发送的正文带 droppedText 标记',
    !!droppedAfterTool && String(droppedAfterTool.content || '').includes('查完了'),
    JSON.stringify(droppedAfterTool));
}

console.log('\n=== 2. 纠正后模型选择 finish → 允许保持沉默 ===');
{
  const { session, requests } = await runScenario('group:302', [
    { tool_calls: [toolCall('get_recent_messages', { limit: 5 }, 'q2')] },
    { content: '看完了，但没有必要接话。' },
    { tool_calls: [toolCall('finish', { summary: '无需回复' }, 'f2')] }
  ]);
  ok('选择沉默时同样只调用三轮', requests.length === 3, `请求数=${requests.length}`);
  ok('模型可在纠正后明确保持沉默',
    session?.status === 'noreply' && session?.finishReason === '无需回复' && session?.sent?.length === 0,
    JSON.stringify({ status: session?.status, finishReason: session?.finishReason, sent: session?.sent }));
}

console.log('\n=== 3. 模型再次只返回文本 → 不重复纠正，不形成循环 ===');
{
  const { session, requests } = await runScenario('group:303', [
    { tool_calls: [toolCall('get_recent_messages', { limit: 5 }, 'q3')] },
    { content: '第一段未发送文本。' },
    { content: '仍然不调用发送工具。' },
    { content: '这条不应该被请求到。' }
  ]);
  ok('纠正后的第二次普通文本直接结束，不请求第四轮', requests.length === 3, `请求数=${requests.length}`);
  ok('整个上下文始终只有一份纠正', correctionCount(requests[2]) === 1,
    `纠正数=${correctionCount(requests[2])}`);
  ok('未发送任何内容时仍为 noreply', session?.status === 'noreply' && session?.sent?.length === 0,
    JSON.stringify({ status: session?.status, sent: session?.sent }));
}

console.log('\n=== 4. 从未调用工具的普通文本 → 保持既有行为 ===');
{
  const { session, requests } = await runScenario('group:304', [
    { content: '普通思考文本，不发送。' },
    { content: '这条不应该被请求到。' }
  ]);
  ok('没有先执行工具就不会触发纠正', requests.length === 1 && correctionCount(requests[0]) === 0,
    `请求数=${requests.length}`);
  ok('既有普通文本沉默语义不变', session?.status === 'noreply' && session?.sent?.length === 0,
    JSON.stringify({ status: session?.status, sent: session?.sent }));
  // 这一条正是"群里什么都没收到、面板上却有一段话"的情形：标记必须有，且**不能**回流给模型。
  const droppedFirstRound = (session?.messages || []).filter((m) => m.role === 'assistant' && m.droppedText === true);
  ok('首轮纯文本结束也带 droppedText 标记',
    droppedFirstRound.length === 1 && String(droppedFirstRound[0].content || '').includes('普通思考文本'),
    JSON.stringify(droppedFirstRound));
  ok('droppedText 只给面板看，不会回到模型请求里',
    !JSON.stringify(requests).includes('droppedText'));
}

console.log('\n=== 5. 引用不存在的 id → 整条不发，并把真实可见的 id 回给模型 ===');
{
  // 端到端跑一遍真实发送路径：上一段的单元断言证明判据对，这一段证明它**真的接在
  // send_message 上**，而且拦下时那句话里带着 midHint 的「最近可见」清单。
  const key = 'group:305';
  const incomingMid = 7001;
  const env = boot(key);
  env.store.appendIncoming(key, {
    mid: incomingMid, ts: Date.now(), senderId: '555', senderName: '张三', text: '@小鲸鱼 看一下'
  });
  model.script = [
    {
      tool_calls: [
        // 就是实测里那个编出来的 id
        toolCall('send_message', { messages: '我引错了', replyToMessageId: '1852997901' }, 'r1'),
        toolCall('send_message', { messages: '这次引对了', replyToMessageId: String(incomingMid) }, 'r2')
      ]
    },
    { tool_calls: [toolCall('finish', { summary: '完成' }, 'f5')] }
  ];
  model.requests = [];
  env.orc.scheduleWake(key, 0);
  const session = await readArchivedSession(env.sessions, env.ended);
  await env.orc.abortAll();

  const calls = (session?.messages || [])
    .filter((m) => m.toolCall?.name === 'send_message')
    .map((m) => m.toolCall);
  ok('两次 send_message 都执行了（拦下的是那一次，不是整轮）',
    calls.length === 2, JSON.stringify(calls.map((c) => c.result)));
  ok('引用不存在的 id → 返回 isError，并说清"这条没发出去"',
    calls[0]?.isError === true && String(calls[0].result).includes('1852997901')
    && String(calls[0].result).includes('不存在') && String(calls[0].result).includes('没发出去'),
    String(calls[0]?.result));
  // 这条是本次改动的**收益**本身：midHint 的「最近可见」此前只出现在读工具的失败路径上，
  // 发送路径上从来没有过 —— 模型填错之后拿不到任何真实 id，只能继续编。
  ok('拦下时把真实可见的 id 一并回给模型（发送路径上第一次出现 midHint）',
    String(calls[0]?.result).includes('最近可见') && String(calls[0]?.result).includes(String(incomingMid)),
    String(calls[0]?.result));
  ok('引对的那次照常发出，且账本只记这一条',
    calls[1]?.isError !== true && session?.sent?.length === 1 && session.sent[0].text === '这次引对了',
    JSON.stringify({ second: calls[1], sent: session?.sent }));
  ok('被拦下的那条一个字都没进群', !(session?.sent || []).some((item) => item.text === '我引错了'),
    JSON.stringify(session?.sent));
  ok('会话仍记为 done（真的发出去的那条算数）', session?.status === 'done', String(session?.status));
}

model.close();
process.exit(done() ? 0 : 1);
