// 漫画异步完成链路：Python 结果帧 → 上传 PDF → 完成 sink → 未读机器结果 → 强制唤醒。
//
// 这套夹具有意让假 Python **永远不发 close**。旧实现只在 close 时解析
// `__QQ_AGENT_RESULT__`，因此即使 PDF 已经生成、结果帧也已经 flush，任务仍会永久卡在
// downloading。现在与搜图 worker 一样，stdout 的完整帧一到就结算；再参考转写的 sink，
// 在 OneBot 确认上传后把结果回流给 Agent。
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { checker, dataDir } from './lib/harness.mjs';
import { load } from './lib/src.mjs';

const DATA = dataDir('qqagent-jmcomic-callback-');
const { ok, done } = checker();
const NOW = Date.now();
const CHAT_KEY = 'group:123';
const COMIC_ID = '1253981';
// 第二个任务专门走**终局失败**：`loadJobs()` 有 `if (loaded) return`（进程内只读一次盘），
// 所以"重写 jobs.json 再 init 一遍"读不进来 —— 两个任务必须写在初始夹具里、一次跑完。
const FAIL_CHAT = 'group:456';
const FAIL_ID = '7654321';
const JM_DIR = path.join(DATA, 'jmcomic');
const DOWNLOADS = path.join(DATA, 'downloads', 'jmcomic');
const PDF = path.join(DOWNLOADS, `${COMIC_ID}.pdf`);
const JOBS_FILE = path.join(JM_DIR, 'jobs.json');

fs.mkdirSync(JM_DIR, { recursive: true });
fs.mkdirSync(DOWNLOADS, { recursive: true });
fs.writeFileSync(PDF, Buffer.concat([Buffer.from('%PDF-1.4\n', 'ascii'), Buffer.alloc(1200, 0x20)]));
fs.writeFileSync(path.join(JM_DIR, 'cleanup-state.json'), JSON.stringify({ lastCleanupAt: NOW }), 'utf8');
fs.writeFileSync(JOBS_FILE, JSON.stringify({
  version: 1,
  jobs: [
    {
      id: 'jm_callback_fixture', key: `u:${COMIC_ID}`, comicId: COMIC_ID, requesterId: 'u',
      kind: 'group', chatId: '123', chatKey: CHAT_KEY, status: 'queued',
      downloadAttempts: 0, uploadAttempts: 0, pdfPath: '', lastError: '',
      nextAttemptAt: NOW - 1, createdAt: NOW - 1, updatedAt: NOW - 1
    },
    {
      // downloadAttempts=2 ⇒ 本次是第 3 次 ⇒ 超过 `DOWNLOAD_RETRY_MS`（3 档）的退避表，
      // **直接终局**，不必在测试里等 5/30/120 秒。
      id: 'jm_fail_fixture', key: `u:${FAIL_ID}`, comicId: FAIL_ID, requesterId: 'u',
      kind: 'group', chatId: '456', chatKey: FAIL_CHAT, status: 'queued',
      downloadAttempts: 2, uploadAttempts: 0, pdfPath: '', lastError: '',
      nextAttemptAt: NOW - 1, createdAt: NOW - 1, updatedAt: NOW - 1
    }
  ]
}, null, 2), 'utf8');

const { ChatStore, isPersonMessage, isSystemRecord } = await load('chat/store.js');
const { buildTriggerBlock } = await load('agent/prompting/prompt-builder.js');
const { evaluateWindowTrigger } = await load('agent/context/response-policy.js');
const jmcomic = await load('media/jmcomic/index.js');

const store = new ChatStore(0);
const calls = [];
/** 全部完成回调（成功一条 + 失败一条）。 */
const completions = [];
/** 只含成功那条（`status === 'sent'`），供成功路径的断言用。 */
const completed = [];
/** 收到 kill 的漫画 ID（按任务分开记：两个任务都会收掉各自的子进程）。 */
const killedFor = [];
/** 队列直接贴进群的全部文本（失败改回流之后它必须一直是空的）。 */
const groupTexts = [];
let closeEmitted = false;

const fakeSpawn = (_command, args) => {
  const comicId = String(args[args.length - 2]);
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => { killedFor.push(comicId); return true; };
  setImmediate(() => {
    if (comicId === FAIL_ID) {
      // 失败帧：`ok:false` + error 就是 Python 侧的报错契约（`settleFromResultFrame` 认它）。
      child.stdout.emit('data', Buffer.from(
        `__QQ_AGENT_RESULT__${JSON.stringify({ ok: false, error: '禁止下载：本子已被下架' })}\n`));
      return;
    }
    const frame = `__QQ_AGENT_RESULT__${JSON.stringify({ ok: true, comicId: COMIC_ID, pdfPath: PDF, cached: false })}\n`;
    // 故意拆在 JSON 中间：第一块解析失败不能误判任务失败，第二块补齐后才回调。
    const cut = Math.floor(frame.length / 2);
    child.stdout.emit('data', Buffer.from(frame.slice(0, cut)));
    child.stdout.emit('data', Buffer.from(frame.slice(cut)));
    // 不 emit('close')：这就是本回归要钉住的场景。
  });
  calls.push({ action: 'spawn', args });
  return child;
};

const onebot = {
  call: async (action, params, timeoutMs) => {
    calls.push({ action, params, timeoutMs });
    return { file_id: 'uploaded-file-id' };
  }
};

jmcomic.initJmcomicQueue({
  onebot,
  sender: { sendTextBatch: async (_chatKey, text) => { groupTexts.push(String(text)); return {}; } },
  store,
  spawnProcess: fakeSpawn,
  onCompleted: (input) => {
    completions.push(input);
    if (input.status !== 'failed') completed.push(input);
    store.appendJmcomicResult(input.chatKey, {
      comicId: input.comicId, cached: input.cached, status: input.status, reason: input.reason
    });
  }
});

try {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && completions.length < 2) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  const saved = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8')).jobs[0];
  const upload = calls.find((call) => call.action === 'upload_group_file');
  ok('stdout 结果帧一到就进入上传，不依赖 Python close 事件',
    closeEmitted === false && !!upload && saved?.status === 'completed',
    JSON.stringify({ closeEmitted, actions: calls.map((call) => call.action), status: saved?.status }));
  ok('完整结果帧到达后主动收掉可能残留后台线程的 Python 进程',
    killedFor.filter((id) => id === COMIC_ID).length === 1, `kills=${JSON.stringify(killedFor)}`);
  ok('上传参数仍指向当前群、最终 PDF 与 30 分钟超时',
    upload?.params?.group_id === 123 && upload?.params?.file === PDF
    && upload?.params?.name === `${COMIC_ID}.pdf` && upload?.timeoutMs === 30 * 60_000,
    JSON.stringify(upload));
  ok('OneBot 确认上传后完成 sink 只收到一次结构化事实',
    // 按漫画 ID 定位到**这一个**任务：夹具里还有一条走终局失败的，别把它的回调算进来。
    completed.filter((item) => item.comicId === COMIC_ID).length === 1
    && completed[0].chatKey === CHAT_KEY
    && completed[0].comicId === COMIC_ID && completed[0].source === 'response'
    && completed[0].fileId === 'uploaded-file-id' && completed[0].status === 'sent',
    JSON.stringify(completions));

  const result = store.recent(CHAT_KEY, { limit: 10 }).find((entry) => entry.kind === 'jmcomic-result');
  ok('完成 sink 落成未读、非 self、不可引用的漫画结果条目',
    result?.read === false && result?.self === false && result?.mid === null
    && result?.senderId === '' && result?.senderName === '漫画下载',
    JSON.stringify(result));
  ok('漫画结果要进窗口，但不算某个群友的发言',
    !isSystemRecord(result) && !isPersonMessage(result));

  const block = buildTriggerBlock([result], { selfNickname: '小鲸鱼' });
  ok('提示词把回调渲染成【漫画下载结果】，不冒充群友',
    block.includes('【漫画下载结果】') && block.includes(COMIC_ID)
    && !block.slice(0, block.indexOf('【漫画下载结果】')).includes('：'), block);
  const decision = evaluateWindowTrigger({
    entries: [result], identity: { selfNickname: '小鲸鱼' },
    policy: { responseTier: 1, randomPercent: 0, keywords: [] }, roll: 99
  });
  ok('最低响应档位也不会静默吞掉漫画完成回调',
    decision.shouldRespond === true && decision.responseTier === 0 && decision.reason === '漫画下载结果',
    JSON.stringify(decision));
} finally {
  jmcomic.stopJmcomicQueue();
}

// ── 失败也走同一条回流通道（2026-10-10 统一）─────────────────────────
//
// 修之前：失败由队列**直接往群里贴**一句 ❌/🚫（`sendStatus`），模型不知道发生过什么，
// 而它才是刚对群友说过"我去下了"的那个人。现在终局失败走同一个 sink，由模型自己交代。
// ⚠️ **这套夹具此前一条都没断言过那些文案**（实测 grep 过）—— 也就是说这个行为变更
// 原处在守护空白里，改错了不会有任何套件报警。这一段就是补上的那一道。
{
  const failResult = completions.find((item) => item.comicId === FAIL_ID);
  ok('下载终局失败：走回流端口、带上失败原因，**群里一个字都不发**',
    completions.length === 2 && failResult?.status === 'failed'
    && String(failResult.reason).includes('禁止下载') && groupTexts.length === 0,
    `${JSON.stringify(completions)} / 群文本 ${JSON.stringify(groupTexts)}`);
  const failed = store.recent(FAIL_CHAT, { limit: 10 }).find((entry) => entry.kind === 'jmcomic-result');
  ok('失败条目照样未读、可进窗口，正文说清"没下成"并带上原因',
    failed?.read === false && failed?.text.includes('没下成') && failed?.text.includes('禁止下载'),
    JSON.stringify(failed?.text));
  ok('失败用【漫画下载失败】标签（与成功分开：模型据此决定"交代一句"还是"顺口补一句"）',
    buildTriggerBlock([failed], { selfNickname: '小鲸鱼' }).includes('【漫画下载失败】'));
  ok('失败条目同样能唤醒模型（最低档位下也是）',
    evaluateWindowTrigger({
      entries: [failed], identity: { selfNickname: '小鲸鱼' },
      policy: { responseTier: 1, randomPercent: 0, keywords: [] }, roll: 99
    }).shouldRespond === true);
}


process.exit(done() ? 0 : 1);
