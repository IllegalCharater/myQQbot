// 会话记录里的"读图信息"：调用读图工具之后，把模型看完图说了什么回填到那条记录上。
//
// 这条路径以前没有任何套件守（都是靠真机跑才发现的），所以要真起一个假模型端点、
// 真下载一张图、真跑一轮 orchestrator。假图床和假模型端点在 lib/harness.mjs 里。
import { load } from './lib/src.mjs';
import {
  checker, dataDir, fakeImageServer, fakeModelServer, toolCall, readArchivedSession
} from './lib/harness.mjs';

dataDir();
const { ChatStore } = await load('store.js');
const { SessionRegistry } = await load('sessions.js');
const { SendQueue } = await load('sender.js');
const { Orchestrator } = await load('orchestrator.js');
const { updateConfig } = await load('config.js');

const { ok, done } = checker();

const image = await fakeImageServer();                      // /ok.png 有图，其余一律 404
const model = await fakeModelServer({ model: 'stub-vision' });
const base = image.base;

updateConfig({
  api: { baseUrl: model.url, model: 'stub-vision', maxRounds: 8 },
  allowAllWhenEmpty: true, allow: { groups: [], private: [] },
  persona: { botName: '小鲸鱼', selfNickname: '小鲸鱼' },
  store: { contextTier: 4, allCount: 80, maxContextMessages: 0 },
  security: { allowPrivateImageHosts: true },
  reply: { maxWaitMs: 0, maxPerMinute: 0 }
});

const memory = { formatForPrompt: () => '', members: () => [], consolidationState: () => ({ counts: { memberImpression: 0 }, members: [], lastConsolidatedAt: 0 }), listChats: () => [] };
const stickers = { sync: async () => ({ entries: [] }) };
const onebot = { selfId: '999', selfNickname: '小鲸鱼', connected: true,
  sendText: async () => ({ message_id: 1 }), sendSticker: async () => ({ message_id: 2 }),
  sendPoke: async () => ({}), getGroupInfo: async () => ({ group_name: '测试群' }), call: async () => ({}) };

const boot = (key) => {
  const store = new ChatStore(0);
  const sessions = new SessionRegistry(0);
  const sender = new SendQueue({ onebot, store });
  const env = { key, store, sessions, sender, ended: [] };
  env.orc = new Orchestrator({ store, memory, stickers, sender, sessions, onebot,
    emit: (t, p) => { if (t === 'session-end') env.ended.push(p); } });
  return env;
};

// 等这次运行彻底结束，返回留档后的会话对象（拿它的 messages 看记录）。
// finish() 会把会话移出 current、几毫秒就结束的轮次会整个错过 —— 两个坑都在
// readArchivedSession 里处理了。
const waitDone = (env) => readArchivedSession(env.sessions, env.ended);


// ═══ 1. 读图 → 模型的话回填到那条"已注入"记录上 ═══
console.log('=== 1. 读图后模型说了什么，记在会话记录里 ===');
{
  model.script = [
    { tool_calls: [toolCall('get_message_images', { messageId: 42 }, 'c1')] },                 // 看图
    { content: '这是一只橘猫趴在键盘上，旁边还有半杯奶茶。', tool_calls: [toolCall('send_message', { messages: ['好可爱'] }, 'c2')] },
    { content: '说完了。', tool_calls: [toolCall('finish', { summary: '接个梗' }, 'c3')] }
  ];
  model.requests = [];
  const env = boot('group:123');
  env.store.appendIncoming(env.key, { mid: 41, ts: Date.now(), senderId: '555', senderName: '张三', text: '在吗' });
  env.store.appendIncoming(env.key, { mid: 42, ts: Date.now() + 10, senderId: '555', senderName: '张三', text: '[图片]', media: [{ kind: 'image', url: `${base}/ok.png` }] });
  env.orc.scheduleWake(env.key, 0);
  const s = await waitDone(env);
  ok('这次运行真的跑起来了', !!s, '压根没会话');
  if (!s) console.log('   DEBUG 没等到 session-end =', env.ended.length, '| 模型请求数 =', model.requests.length, '| 脚本剩余 =', model.script.length);

  if (s) {
    const calls = s.messages.filter((m) => m.toolCall);
    const readCall = calls.find((m) => m.toolCall.name === 'get_message_images');
    ok('读图工具成功取到了图（不再是 detectMime is not defined）',
      !!readCall && !readCall.toolCall.isError, readCall ? JSON.stringify(readCall.toolCall.result).slice(0, 160) : '没有这次调用');
    ok('读图结果里是"图片内容"而不是错误', !!readCall && String(readCall.toolCall.result).includes('图片内容'), readCall?.toolCall.result);

    const imgRec = s.messages.find((m) => m.toolImages);
    ok('记录里有那条"图片已注入"', !!imgRec, JSON.stringify(s.messages.map((m) => Object.keys(m))));
    ok('注入的条数是 1', imgRec?.toolImages?.count === 1);
    ok('★ 回填了模型的读图结论', imgRec?.toolImages?.reply?.text?.includes('橘猫') === true,
      JSON.stringify(imgRec?.toolImages?.reply));
    ok('★ 同一轮还调用了 send_message（带人话摘要能用的 args）',
      imgRec?.toolImages?.reply?.calls?.[0]?.name === 'send_message'
      && imgRec?.toolImages?.reply?.calls?.[0]?.args?.messages?.[0] === '好可爱',
      JSON.stringify(imgRec?.toolImages?.reply?.calls));
    // 标记：那段话已经在卡片里显示了，ui 不能再单独冒一个"思考"气泡
    const dup = s.messages.filter((m) => m.role === 'assistant' && typeof m.content === 'string' && m.content.includes('橘猫'));
    ok('★ 那段话只出现一次，且带 imageReply 标记（ui 会跳过它）',
      dup.length === 1 && dup[0].imageReply === true, JSON.stringify(dup.map((m) => ({ imageReply: m.imageReply }))));
    // 图片确实作为图像输入发给了模型
    const withImage = model.requests.find((r) => JSON.stringify(r?.messages || []).includes('data:image/png;base64'));
    ok('图片真的作为 data URL 发给了模型', !!withImage, `收到 ${model.requests.length} 次请求`);
    ok('发给模型的消息里没有混进 imageReply 这个给 ui 看的字段',
      !JSON.stringify(model.requests).includes('imageReply'));
  }
  env.orc.abortAll();
}

// ═══ 2. 模型还没来得及开口（注入图片后这一轮就结束了）→ 不编内容 ═══
console.log('\n=== 2. 注入图片后没有下一轮：不编"模型说了什么" ===');
{
  updateConfig({ api: { baseUrl: model.url, model: 'stub-vision', maxRounds: 1 } });
  model.script = [{ tool_calls: [toolCall('get_message_images', { messageId: 52 }, 'c1')] }];
  const env = boot('group:124');
  env.store.appendIncoming(env.key, { mid: 52, ts: Date.now(), senderId: '555', senderName: '张三', text: '[图片]', media: [{ kind: 'image', url: `${base}/ok.png` }] });
  env.orc.scheduleWake(env.key, 0);
  const s = await waitDone(env);
  const imgRec = s?.messages.find((m) => m.toolImages);
  ok('图片还是注入了（记录不丢）', !!imgRec, JSON.stringify(s?.messages?.map((m) => Object.keys(m))));
  ok('★ 没有 reply —— 模型没开口就不编一句话出来', imgRec?.toolImages?.reply === undefined, JSON.stringify(imgRec?.toolImages));
  env.orc.abortAll();
}

// ═══ 3. 取图失败时：错误如实记在工具卡上，不该冒出一句"读图结论" ═══
console.log('\n=== 3. 取图失败（图床 404）→ 如实报错，没有注入也没有读图结论 ===');
{
  updateConfig({ api: { baseUrl: model.url, model: 'stub-vision', maxRounds: 8 } });
  model.script = [
    { tool_calls: [toolCall('get_message_images', { messageId: 62 }, 'c1')] },
    { content: '图取不到，告知对方看不见。', tool_calls: [toolCall('send_message', { messages: ['图裂了 看不见'] }, 'c2')] },
    { tool_calls: [toolCall('finish', { summary: '看不到图' }, 'c3')] }
  ];
  const env = boot('group:125');
  env.store.appendIncoming(env.key, { mid: 62, ts: Date.now(), senderId: '555', senderName: '张三', text: '[图片]', media: [{ kind: 'image', url: `${base}/missing.png` }] });
  env.orc.scheduleWake(env.key, 0);
  const s = await waitDone(env);
  const readCall = s?.messages.find((m) => m.toolCall?.name === 'get_message_images');
  ok('工具如实回了错误', readCall?.toolCall?.isError === true, readCall?.toolCall?.result);
  ok('★ 没有注入记录（没图可注入）', !s?.messages.some((m) => m.toolImages));
  ok('★ 模型这轮的话仍单独显示（不是读图轮，不该被吞掉）',
    s?.messages.some((m) => m.role === 'assistant' && !m.imageReply && String(m.content || '').includes('看不见')),
    JSON.stringify(s?.messages.filter((m) => m.role === 'assistant').map((m) => ({ c: m.content, r: m.imageReply }))));
  env.orc.abortAll();
}

model.close();
image.close();
process.exit(done() ? 0 : 1);
