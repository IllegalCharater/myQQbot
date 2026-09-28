// 事件名与注入类型一致性：发射点必须引用 `core/events.js` 的常量，不许再写事件名字面量；
// 注入类型必须是 `AppEmit`，不许退回宽松形状。
//
// 为什么名字还要在文本层守：`AppEmit` 只约束**载荷**。事件名只要是词表里的合法值就能过——
// `this.emit('chat-update', key)` 和 `this.emit(EVENTS.chatUpdate, key)` 在编译器眼里完全一样。
// 所以"S3 把全部字面量换成常量"这件事得单独守（第 1 段），防它长回去。
//
// 第 5 段守的是 S6 换来的东西本身，第 6 段守 session-update 那条通道真的通电了，理由见各自的注释。
//
// 载荷一致性（每个事件的 payload 是否符合 AppEventMap）本身不需要本套件：S6 之后
// 注入类型是 `AppEmit`，写错载荷 `npm run typecheck` 直接报错。第 4 段留着是因为它
// 还多守一件编译期管不到的事——"字段集合不超出 SessionEndPayload"要靠真跑一轮才知道。
//
// ⚠️ 扫的是 `src/` 而不是 `dist/`：这条不变量说的是"源码里还写不写字面量"，而
// `dist/` 里还躺着 29 个旧扁平路径的陈旧产物（tsc 只写不删，见目录重排那次提交），
// 按目录 glob 会把它们一起扫进来，扫出一堆 src/ 里根本不存在的字面量。
// 静态结构类断言直接读 src/ 有先例：t-agent-structure.mjs 就是这么做的。
import fs from 'node:fs';
import path from 'node:path';
import {
  checker, dataDir, fakeModelServer, toolCall, readArchivedSession
} from './lib/harness.mjs';
import { ROOT, load } from './lib/src.mjs';

dataDir('qqagent-events-');
const { EVENTS } = await load('core/events.js');
// 第 6 段要用真投影函数：S7 的收益就是"这条通道终于通了"，光看载荷形状证不了它。
const { projectSse } = await load('web/event-projector.js');

const { ok, done } = checker();

// ── 扫 src/ 下的全部源码 ──
const SRC = path.join(ROOT, 'src');
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(?:ts|js)$/.test(e.name)) out.push(p);
  }
  return out;
}
const rel = (p) => path.relative(SRC, p).split(path.sep).join('/');

const literalSites = [];   // 发射点上的裸事件名
const constUse = {};       // EVENTS.<key> 被引用的次数（不算词表自己的定义处）
for (const f of walk(SRC)) {
  const file = rel(f);
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  lines.forEach((line, i) => {
    // 只认调用点：`emit('name'` / `emit?.('name'`。类型标注（如 vision-scan 的 ScanEmit
    // 里那个 `event: 'vision-scan'`）不匹配这个形状，不算发射点。
    for (const m of line.matchAll(/emit\??\.?\(\s*'([^']+)'/g)) {
      literalSites.push({ file, line: i + 1, name: m[1] });
    }
    if (file === 'core/events.ts') return;
    for (const m of line.matchAll(/EVENTS\.(\w+)/g)) constUse[m[1]] = (constUse[m[1]] || 0) + 1;
  });
}

const where = (s) => `${s.file}:${s.line} '${s.name}'`;

// ── 1. 发射点上不许有任何事件名字面量 ──
// S3 把 61 处里的 59 处换成常量，S4 拆掉剩下那两处 'status'，所以这里从 S4 起是 0。
// 这个数是"还没拆完"的计数，不是配额——再出现任何一处就是有人又在原地写字符串。
ok('发射点上没有任何事件名字面量',
  literalSites.length === 0,
  literalSites.length
    ? `${literalSites.map(where).join('、')} → 改用 EVENTS.*，并在 core/events.ts 登记`
    : '');

// ── 2. 词表里不许躺着永远发不出的名字 ──
// 反向的空转检查：有常量却没有任何发射点，说明要么生产者没接上、要么名字白写了。
const unused = Object.keys(EVENTS).filter((k) => !constUse[k]);
ok('EVENTS 里每个名字都有发射点',
  unused.length === 0,
  `${unused.join('、')} 在 src/ 里没有任何引用 → 要么接上生产者，要么从词表删掉`);

// ── 3. 值不许重复：两个名字共用一个字符串就是两个通道悄悄并成一个 ──
const values = Object.values(EVENTS);
ok('EVENTS 的值互不重复', new Set(values).size === values.length,
  values.filter((v, i) => values.indexOf(v) !== i).join('、'));

// ═══ 4. session-end 的载荷：四种形状收敛到 SessionEndPayload（S5）═══
//
// 为什么要有这一段：S5 之前四个发射点各发各的（其中 agent-runner 那个把条数发成
// `sent: number`，而 SSE 投影里的 `sent` 是**数组**——同名异物）。改完之后
// 「四个形状都符合一个接口」这句话需要证据，于是这里真起一个 Orchestrator 跑出真实载荷来断言。
//
// S6 之后编译器也能管到发射点了，为什么这段还留着：`AppEmit` 只能证明"符合
// `SessionEndPayload` 的**已声明**字段"，证明不了"没有多塞字段"——多余属性检查
// 不适用于变量与展开，而下面那条 `ALLOWED_KEYS` 断言是真能看到运行时键名的。
//
// 覆盖到 done / noreply / aborted 三种；error（要触发重试）与 discarded
// （依赖档位判定说"不响应"）跑起来不稳，改为靠 S5 落地时的编译期探测覆盖——
// 见 docs/global-registry-design.md §8.2 的 S5 行。
const { ChatStore } = await load('chat/store.js');
const { SessionRegistry } = await load('chat/sessions.js');
const { SendQueue } = await load('qq/sender.js');
const { Orchestrator } = await load('agent/runtime/orchestrator.js');
const { updateConfig } = await load('core/config.js');

const model = await fakeModelServer({ model: 'stub-events' });
updateConfig({
  api: { baseUrl: model.url, model: 'stub-events', maxRounds: 8 },
  allowAllWhenEmpty: true, allow: { groups: [], private: [] },
  persona: { botName: '小鲸鱼', selfNickname: '小鲸鱼' },
  store: { contextSliderPos: 95, historyCount: 80, maxContextMessages: 0 },
  reply: { maxWaitMs: 0, maxPerMinute: 0 }
});

const memory = { formatForPrompt: () => '', members: () => [], consolidationState: () => ({ counts: { memberImpression: 0 }, members: [], lastConsolidatedAt: 0 }), listChats: () => [] };
const stickers = { sync: async () => ({ entries: [] }) };
const onebot = { selfId: '999', selfNickname: '小鲸鱼', connected: true,
  sendText: async () => ({ message_id: 1 }), sendSticker: async () => ({ message_id: 2 }),
  sendPoke: async () => ({}), getGroupInfo: async () => ({ group_name: '测试群' }), call: async () => ({}) };

const endedAll = [];   // 三个场景的载荷汇到一起，下面的通用不变量一次过审
const updatesAll = []; // 同上，session-update 的载荷（第 6 段）
const framesAll = [];  // 每条 session-update 在 **emit 当刻** 的真投影结果
const boot = (key) => {
  const store = new ChatStore(0);
  const sessions = new SessionRegistry(0);
  const sender = new SendQueue({ onebot, store });
  const env = { key, store, sessions, sender, ended: [], updates: [] };
  env.orc = new Orchestrator({ store, memory, stickers, sender, sessions, onebot,
    emit: (t, p) => {
      if (t === EVENTS.sessionEnd) { env.ended.push(p); endedAll.push(p); }
      if (t === EVENTS.sessionUpdate) {
        env.updates.push(p);
        updatesAll.push(p);
        // 在 emit 当刻投影，而不是跑完之后——跑完会话已 finish，虽然 peek 还能回读
        // 落盘文件，但那验不出"会话活着时这条通道也通"。
        framesAll.push({ env: key, frame: projectSse(t, p, { sessions }) });
      }
    } });
  return env;
};
const say = (env, text, mid) => env.store.appendIncoming(env.key,
  { mid, ts: Date.now() + mid, senderId: '555', senderName: '张三', text });

// 场景一：模型发了话 → done，且条数落在 sentCount 上
model.script = [
  { tool_calls: [toolCall('send_message', { messages: ['在的'] }, 'c1')] },
  { content: '说完了。', tool_calls: [toolCall('finish', { summary: '打招呼' }, 'c2')] }
];
const env1 = boot('group:201');
say(env1, '在吗', 1);
env1.orc.scheduleWake(env1.key, 0);
const s1 = await readArchivedSession(env1.sessions, env1.ended);
const e1 = env1.ended[env1.ended.length - 1];
ok('跑完一轮确实发了 session-end', !!s1 && !!e1);
ok('发了话 → status=done', e1?.status === 'done', JSON.stringify(e1));
ok('条数在 sentCount 上，且是数字', e1?.sentCount === 1, `sentCount=${JSON.stringify(e1?.sentCount)}`);
ok('载荷里已经没有旧的 sent 键（它与投影里的 sent 数组同名异物）',
  !!e1 && !('sent' in e1), Object.keys(e1 || {}).join('、'));

// 场景二：模型什么都没发就收尾 → noreply，条数为 0
model.script = [{ content: '不说了。', tool_calls: [toolCall('finish', { summary: '沉默' }, 'c3')] }];
const env2 = boot('group:202');
say(env2, '在吗', 2);
env2.orc.scheduleWake(env2.key, 0);
await readArchivedSession(env2.sessions, env2.ended);
const e2 = env2.ended[env2.ended.length - 1];
ok('没发话 → status=noreply 且 sentCount=0',
  e2?.status === 'noreply' && e2?.sentCount === 0, JSON.stringify(e2));

// 场景三：等待中的会话被 abortAll 中止 → 走 #finishWaiting（S5 收窄了它的 status 参数）
const env3 = boot('group:203');
say(env3, '在吗', 3);
env3.orc.scheduleWake(env3.key);      // 默认有防抖窗口 → 建出 waiting 会话
env3.orc.abortAll();
const e3 = env3.ended[env3.ended.length - 1];
ok('#finishWaiting 发出 status=aborted', e3?.status === 'aborted', JSON.stringify(e3));

// ── 通用不变量：不管哪种形状，载荷都得像 SessionEndPayload ──
const SHAPES = ['done', 'noreply', 'error', 'aborted', 'discarded'];
// 与 src/core/events.ts 的 SessionEndPayload 逐字段对应；多一个键就是有人偷偷加了字段
const ALLOWED_KEYS = ['sessionId', 'chatKey', 'status', 'error', 'sentCount', 'finishReason', 'usage', 'discarded'];
ok('三种形状都跑到了', endedAll.length >= 3, `只收到 ${endedAll.length} 条`);
ok('每条都有 sessionId（readArchivedSession 就靠它取留档会话）',
  endedAll.every((p) => typeof p.sessionId === 'string' && p.sessionId),
  JSON.stringify(endedAll.map((p) => p.sessionId)));
ok('每条都有 chatKey 且是字符串', endedAll.every((p) => typeof p.chatKey === 'string'),
  JSON.stringify(endedAll.map((p) => p.chatKey)));
ok('status 全部落在 SessionEndStatus 的五个字面量里',
  endedAll.every((p) => SHAPES.includes(p.status)),
  JSON.stringify(endedAll.map((p) => p.status)));
ok('没有 SessionEndPayload 之外的字段',
  endedAll.every((p) => Object.keys(p).every((k) => ALLOWED_KEYS.includes(k))),
  JSON.stringify([...new Set(endedAll.flatMap((p) => Object.keys(p)).filter((k) => !ALLOWED_KEYS.includes(k)))]));
ok('sentCount 出现时一定是数字', endedAll.every((p) => !('sentCount' in p) || typeof p.sentCount === 'number'),
  JSON.stringify(endedAll.map((p) => p.sentCount)));

// ═══ 5. 注入类型必须一直是 AppEmit（S6）═══
//
// S6 把 7 处 `(event: string, payload?: unknown) => unknown` 换成 `AppEmit`，全部生产者
// 从此受编译期检查。这个收益有个软肋：**退回宽松形状不会报任何错**——把某个注入点改回
// `(event: string, payload?: unknown) => unknown`，它后面所有发射点就重新变成不检查，
// 而 `npm run typecheck` 照样全绿、跑起来也照样对。跟 S4 那个"改名只改一端"同属
// **静默失效**：唯一的信号只有这条断言。所以在这里钉住。
//
// 为什么不用"正则匹配注入声明"来检：声明与**值表达式**长得太像。`emit: (type, payload) => …`
// 既可能是接口字段声明、也可能是传给构造器的对象字面量属性；`? emit : (` 这种三元冒号
// 也会被误判（第一版就踩了，扫出一串假阳性）。所以改成两条不会误判的检查。

// 5a. 宽松形状绝迹。旧写法一定会写出 `payload: unknown` 或 `payload?: unknown`——
//     这是它唯一的、可靠的指纹，且不可能出现在别处。
const looseInject = [];
for (const f of walk(SRC)) {
  const file = rel(f);
  // core/util.ts 的 createEventBus() 是总线**本体**、不是注入点，路线图明令不替换它
  // （§4.3），所以它那句 `emit(type: string, payload: unknown)` 保持原样是对的。
  if (file === 'core/util.ts') continue;
  fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
    if (!/\bemit\b/.test(line)) return;
    if (/payload\??:\s*unknown/.test(line)) looseInject.push(`${file}:${i + 1} ${line.trim()}`);
  });
}
ok('src/ 里没有任何 emit 注入点还写着宽松的 payload: unknown',
  looseInject.length === 0,
  `${looseInject.join('、')} → 改成 AppEmit（core/events.ts），否则这个注入点后面的发射点会静默失去检查`);

// 5b. 正向：S6 动过的注入点必须一直标着 AppEmit。用**精确文件集合**而不是"文件数 ≥ N"——
//     这条断言的意义就是钉住"哪几处受编译期检查"，集合是它的内容，不是巧合。
//     真新增了注入点时，请把这个文件加进下面的清单（这是有意的动作，不是噪音）。
//
// 判定"这个文件还算受检查"要看**同一行**上有没有 emit 与 AppEmit：只查"文件里提没提
// AppEmit"是不够的——把 `emit: AppEmit;` 改成 `emit: (...args: any[]) => void;` 后，
// 上面那行 import type 还留着 AppEmit，文件照样"提到"它（第一版就漏掉了这种改法）。
const TYPED_FILES = [
  'agent/maintenance/history-compactor.ts',
  'agent/maintenance/memory-consolidator.ts',
  'agent/runtime/agent-runner.ts',
  'agent/runtime/orchestrator.ts',
  'agent/runtime/wake-scheduler.ts',
  'agent/shared/types.ts',
  'llm/vision-scan.ts',
  'web/app.ts',
  'web/types.ts'
];
const usingAppEmit = walk(SRC)
  .filter((f) => rel(f) !== 'core/events.ts')          // 定义处不拿它自己检自己
  .filter((f) => fs.readFileSync(f, 'utf8').split('\n')
    .some((line) => /\bemit\b/.test(line) && line.includes('AppEmit')))
  .map(rel)
  .sort();
const expected = [...TYPED_FILES].sort();
const missing = expected.filter((f) => !usingAppEmit.includes(f));
const extra = usingAppEmit.filter((f) => !expected.includes(f));
ok('受编译期检查的注入点清单没有少也没有多（每处都标着 AppEmit）',
  missing.length === 0 && extra.length === 0,
  [
    missing.length ? `少了（注入点不再标 AppEmit）：${missing.join('、')}` : '',
    extra.length ? `多了（新注入点请登记进 TYPED_FILES）：${extra.join('、')}` : ''
  ].filter(Boolean).join('；'));

// ═══ 6. session-update 的通道真的通了（S7）═══
//
// S7 是**激活**一条通道，不是无害的载荷统一：它自初始提交起就没通过电——12 个发射点发
// 裸字符串，而投影入口要 `isRecord(payload) && payload.sessionId`，UI 又在 `!data.sessionId`
// 时早退，三方从未对齐（设计文档 §3.4 三、§10 待定 2）。所以只断言"载荷是对象"是不够的：
// 那只证明形状，证不了**通道通了**。这里把载荷喂给**真投影函数**，断言吐出来的是富帧。
//
// 谁把发射点退回裸串、或把投影入口条件改回去，这条断言立刻变红（帧退化成 `data: "sess-x"`）。
// 而 `npm run typecheck` 只管得住前者、管不住后者——退化的那次修改在编译器眼里完全合法。
//
// 投影在 **emit 当刻**做（见 boot），不是跑完之后：会话 finish 后 `peek` 还能回读落盘文件，
// 那样验不出"会话活着时这条通道也通"。
ok('session-update 真的发出来了', updatesAll.length > 0, `只收到 ${updatesAll.length} 条`);
ok('载荷一律是对象且带非空 sessionId（不是裸字符串）',
  updatesAll.every((p) => p && typeof p === 'object' && typeof p.sessionId === 'string' && p.sessionId),
  JSON.stringify(updatesAll.slice(0, 3)));
ok('瘦事件：除 sessionId 之外不塞别的（富字段归投影现读，不许搬进 agent）',
  updatesAll.every((p) => Object.keys(p).length === 1),
  JSON.stringify([...new Set(updatesAll.flatMap((p) => Object.keys(p)))]));

const rich = (frame) => {
  const m = /^event: session-update\ndata: (.+)\n\n$/.exec(frame);
  if (!m) return null;
  const body = JSON.parse(m[1]);
  return body && typeof body === 'object' && 'messages' in body && 'status' in body ? body : null;
};
const badFrames = framesAll.filter((f) => !rich(f.frame));
ok('每一条都投影成了富帧——这就是"通道通电"的定义',
  framesAll.length > 0 && badFrames.length === 0,
  `${badFrames.length}/${framesAll.length} 条退化：${JSON.stringify(badFrames.slice(0, 2))}`);
ok('富帧带的是这个会话的真实字段，不是空壳',
  framesAll.some((f) => rich(f.frame)?.chatKey === 'group:201'),
  JSON.stringify(framesAll.slice(0, 3).map((f) => rich(f.frame)?.chatKey)));

process.exit(done() ? 0 : 1);
