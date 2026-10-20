// 入站摄取的**过滤层**：谁的消息会被存进存档、谁会唤醒一次运行。
//
// 这一套件的存在理由是一条真机反馈（2026-10-20）：**私聊里 bot 的每条消息都入库两次** ——
// 一条是 `SendQueue.sendTextBatch` 的 `appendSelf`（`我：…`），另一条是 OneBot 的
// `message_sent` 回显被当成普通入站消息又存了一遍（`self:false`，发送者是 bot 自己）。
// 更糟的是后一条 `wakeEligible: true`，会**再唤起一轮运行**（跑团开跑前 = DM 自己接自己的话）。
//
// 根因是过滤顺序：`event.user_id ?? sender.user_id` ——
//   · **群聊** message_sent 的 `user_id` 是 self_id（挡得住）；
//   · **私聊** message_sent 的 `user_id` 是**对方**，只有 `sender.user_id` 才是自己（挡不住）。
// 所以这组断言两头都要钉：自己发的必须一条都不留，别人说的必须一条不少。
import { checker, dataDir } from './lib/harness.mjs';
import { load } from './lib/src.mjs';

dataDir('qqagent-ingest-');
const { ok, done } = checker();

const { createIngest } = await load('web/onebot/ingest.js');
const { createCommandDispatcher } = await load('web/onebot/commands.js');
const { ChatStore } = await load('chat/store.js');
const { DEFAULT_CONFIG } = await load('core/config.js');

/** bot 自己的 QQ。 */
const SELF = '9';
const cfg = { ...structuredClone(DEFAULT_CONFIG), allowAllWhenEmpty: true };
const TX = (text) => ({ type: 'text', data: { text } });

let messageId = 1;

/**
 * 一套独立的 ingest + 存档。
 *
 * ⚠️ 每个用例用**自己的 store 与会话号**：`new ChatStore()` 会从磁盘重载（临时目录整个套件共用），
 * 同一个会话号会让后面的用例读到前面留下的消息。
 */
function makeIngest() {
  const store = new ChatStore();
  const forwarded = [];
  const sent = [];
  const ingest = createIngest({
    onebot: { selfId: SELF },
    store,
    sender: { sendTextBatch: async (...args) => { sent.push(args); return {}; } },
    orchestrator: { onIncoming: (...args) => forwarded.push(args) },
    transcription: { enqueue: () => ({ id: 'x' }) },
    imageGen: { enqueue: () => ({ id: 'x' }) },
    jmcomic: { enqueue: () => ({ position: 1 }) },
    commands: createCommandDispatcher(),
    extras: { intercept: () => null },
    emit: () => {},
    getConfig: () => cfg,
    log: () => {}
  });
  return { ingest, store, forwarded, sent };
}

/**
 * 一条 OneBot 消息事件。
 *
 * `user_id` 的语义是**这条会话的对端**：群里是发消息的人，私聊里是对方（所以私聊 message_sent
 * 里它也是对方，不是自己）—— 那正是这个 bug 的形状，夹具必须能造出来。
 * `sender.user_id` 才是"谁发的"。
 */
const event = ({ postType, kind, chatId, senderId, text }) => ({
  post_type: postType,
  message_type: kind,
  ...(kind === 'group' ? { group_id: chatId, user_id: senderId } : { user_id: chatId }),
  self_id: SELF,
  message_id: messageId++,
  sender: { user_id: senderId, nickname: senderId === SELF ? '小鲸鱼' : '群友' },
  message: [TX(text)]
});

// ── 1. 自己发的消息：一条都不许留 ────────────────────────────────────────────
{
  const { ingest, store, forwarded } = makeIngest();
  // **私聊 message_sent**：`user_id` 是对方(201)、`sender.user_id` 是 bot —— 旧写法在这里漏掉。
  await ingest.handle(event({ postType: 'message_sent', kind: 'private', chatId: 201, senderId: SELF, text: 'bot 在私聊说的话' }));
  ok('★ 私聊 `message_sent` 不入档（`user_id` 是对方，只有 `sender.user_id` 才是自己）',
    store.recent('private:201', { limit: 10 }).length === 0,
    JSON.stringify(store.recent('private:201', { limit: 10 }).map((m) => [m.senderName, m.text])));
  ok('★ 而且**不唤醒** —— 旧写法会把这条当成别人说的话，再跑一轮模型',
    forwarded.length === 0, String(forwarded.length));
}
{
  const { ingest, store, forwarded } = makeIngest();
  // 群聊 message_sent：`user_id` 就是 self_id。这条以前就挡得住，留着防回潮。
  await ingest.handle(event({ postType: 'message_sent', kind: 'group', chatId: 301, senderId: SELF, text: 'bot 在群里说的话' }));
  ok('对照：群聊 `message_sent` 同样不入档、不唤醒（这条以前就是对的）',
    store.recent('group:301', { limit: 10 }).length === 0 && forwarded.length === 0,
    JSON.stringify({ n: store.recent('group:301', { limit: 10 }).length, forwarded: forwarded.length }));
}
{
  const { ingest, store, forwarded } = makeIngest();
  // 某些协议端会把自消息也发成 `message`：`sender.user_id` 仍是自己。
  await ingest.handle(event({ postType: 'message', kind: 'private', chatId: 202, senderId: SELF, text: '被回显成 message 的自消息' }));
  ok('对照：自消息走 `message` 通道时也不入档（判据看 `sender.user_id`，不看 `user_id`）',
    store.recent('private:202', { limit: 10 }).length === 0 && forwarded.length === 0,
    JSON.stringify({ n: store.recent('private:202', { limit: 10 }).length, forwarded: forwarded.length }));
}

// ── 2. 别人说的消息：一条都不能少（修过头就会变成"bot 听不见人说话"）──────────
{
  const { ingest, store, forwarded } = makeIngest();
  await ingest.handle(event({ postType: 'message', kind: 'private', chatId: 203, senderId: '203', text: '用户说的话' }));
  const rows = store.recent('private:203', { limit: 10 });
  ok('对照：私聊里用户的消息照常入库一次、唤醒一次',
    rows.length === 1 && rows[0].text === '用户说的话' && rows[0].self === false
    && forwarded.length === 1 && forwarded[0][0] === 'private:203',
    JSON.stringify({ rows: rows.map((m) => [m.senderName, m.text]), forwarded: forwarded.length }));
}
{
  const { ingest, store, forwarded } = makeIngest();
  await ingest.handle(event({ postType: 'message', kind: 'group', chatId: 302, senderId: '302', text: '群友说的话' }));
  ok('对照：群里成员的消息照常入库一次、唤醒一次',
    store.recent('group:302', { limit: 10 }).length === 1 && forwarded.length === 1,
    JSON.stringify({ n: store.recent('group:302', { limit: 10 }).length, forwarded: forwarded.length }));
}

// ── 3. 端到端复现：一回合里 bot 说完话，存档只能多**一条**（`我：…`）──────────
{
  const { ingest, store } = makeIngest();
  // 用户先说一句 → 入档（1）
  await ingest.handle(event({ postType: 'message', kind: 'private', chatId: 204, senderId: '204', text: '你好' }));
  // bot 回一句：SendQueue 会 appendSelf（这里手工模拟它，等价于那条路径）
  store.appendSelf('private:204', { text: '你好呀', ts: Date.now(), mid: 9001 });
  // 协议端把这句话回显成 message_sent —— 旧写法会在这里多存一条
  await ingest.handle(event({ postType: 'message_sent', kind: 'private', chatId: 204, senderId: SELF, text: '你好呀' }));
  const rows = store.recent('private:204', { limit: 10 });
  ok('★ 一回合的存档正好两条：用户一句 + `我：…` 一句（回显不再多出第三条）',
    rows.length === 2 && rows[0].text === '你好' && rows[1].self === true && rows[1].text === '你好呀',
    JSON.stringify(rows.map((m) => [m.self ? 'self' : m.senderName, m.text])));
}

process.exit(done() ? 0 : 1);
