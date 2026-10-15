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
}

model.close();
process.exit(done() ? 0 : 1);
