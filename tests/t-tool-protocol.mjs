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
  const protocol = String(PROMPT_CATALOG.system.toolProtocol());
  ok('system prompt 里有"搜到之后先问用户、不要自己挑一本下载"这条规则',
    protocol.includes('search_jmcomic') && protocol.includes('不要自己挑一本下载') &&
    protocol.includes('不要编造 ID'), protocol.slice(-200));
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
