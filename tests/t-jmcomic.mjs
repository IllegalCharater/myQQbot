// 漫画队列的去重（按「请求者 QQ + 漫画 ID」）与**完成后的记录留存**。
//
// 为什么需要它：`enqueueJmcomicDownload` 的两道闸门（在途 pending / 10 分钟窗口）都以模块内的
// `jobs` 为数据源。上传成功后原本会立刻把这条记录从 `jobs` 里摘掉，于是两条闸门对
// **下载成功过**的漫画一起失效：用户拿到 PDF 后立刻再要一次，会命中 Python 的本地缓存、
// 马上重复上传一次 PDF，可以反复刷 —— 而"10 分钟防重复"看起来还写在那儿。
// 这一步只有**真跑一次上传收尾**才看得见（记录有没有被摘掉是运行期事实，文本断言看不见）。
//
// 本套件三段：
//   1. 真跑一次上传（假 onebot + 假 PDF），钉"完成后记录仍在 jobs.json 里、且不会被再跑一遍"；
//   2. 完成后同一用户再提交 → 拒；换个用户提交同一漫画 → 不拒（去重是**按人**算的）；
//   3. 窗口的计时起点是**上传完成时刻**，不是创建时刻 —— 一次耗时超过窗口的下载，
//      只看 createdAt 的话在上传完成的当刻就已经"过期"，防重形同虚设。
//
// ⚠️ 安全网：本套件不该产生任何真实下载。即使某个断言写错、队列真的跑起来去 spawn python，
// `JMCOMIC_PYTHON` 指向一个不存在的程序，最多拿到 "无法启动 my_bot Python"（走重试/失败分支，
// 不联网、不碰真 data/）。改这里时别把这个环境变量删掉。
import fs from 'node:fs';
import path from 'node:path';
import { checker, dataDir } from './lib/harness.mjs';
import { load } from './lib/src.mjs';

const DATA = dataDir('qqagent-jmcomic-');
const { ok, done } = checker();
process.env.JMCOMIC_PYTHON = path.join(DATA, 'no-such-python.exe');

const NOW = Date.now();
const JM_DIR = path.join(DATA, 'jmcomic');
const JM_DOWNLOADS = path.join(DATA, 'downloads', 'jmcomic');
const LOG_DIR = path.join(JM_DIR, 'logs');
const JOBS_FILE = path.join(JM_DIR, 'jobs.json');

fs.mkdirSync(JM_DIR, { recursive: true });
fs.mkdirSync(JM_DOWNLOADS, { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });
// 1024 字节起、且以 %PDF- 开头 —— 缺一样 `validatePdf` 会把任务打回 queued，
// 那样 worker 会掉回下载阶段去 spawn python（本套件只想跑上传这一半）。
const JM_PDF = path.join(JM_DOWNLOADS, 'fixture.pdf');
fs.writeFileSync(JM_PDF, Buffer.concat([Buffer.from('%PDF-1.4\n', 'ascii'), Buffer.alloc(1200, 0x20)]));
// 已完成任务的日志文件：完成后应当只剩记录、没有日志（cleanupCompletedJob 的另一半职责）。
fs.writeFileSync(path.join(LOG_DIR, 'jm_fixture_upload.log'), 'fixture log', 'utf8');

// `initJmcomicQueue` 里 `cleanupDownloadCacheIfDue()` 的第一件事是看距上次清理够不够 24 小时，
// 不够就直接返回。不写这个文件的话它读出来是 0，首跑就会把下载目录、日志目录和 `jobs` 一起清空。
fs.writeFileSync(path.join(JM_DIR, 'cleanup-state.json'), JSON.stringify({ lastCleanupAt: NOW }), 'utf8');

// 夹具顺序不能换：模块是单例，`jobs.json` 只在这一个进程里加载一次（`loaded` 标志）。
const fixture = [
  {
    id: 'jm_fixture_upload', key: 'u2:222', comicId: '222', requesterId: 'u2', kind: 'private',
    chatId: '1', chatKey: 'private:1', status: 'downloaded',
    downloadAttempts: 1, uploadAttempts: 0, pdfPath: JM_PDF, lastError: '',
    nextAttemptAt: NOW - 1000, createdAt: NOW - 1000, updatedAt: NOW - 1000
  },
  {
    id: 'jm_fixture_done', key: 'u1:111', comicId: '111', requesterId: 'u1', kind: 'private',
    chatId: '1', chatKey: 'private:1', status: 'completed',
    downloadAttempts: 1, uploadAttempts: 1, pdfPath: '', lastError: '',
    // createdAt 早就出了 10 分钟窗口，uploadedAt 还在窗口内 —— 第 3 段要靠这组差值分辨
    // "窗口从创建时刻算"还是"从完成时刻算"。
    nextAttemptAt: null, createdAt: NOW - 90 * 60_000, updatedAt: NOW - 60_000, uploadedAt: NOW - 60_000
  }
];
fs.writeFileSync(JOBS_FILE, JSON.stringify({ version: 1, jobs: fixture }, null, 2), 'utf8');

/** 让被测模块里那些不返回句柄的 async 流程跑完（`void runWorker()` 拿不到 promise）。 */
async function flush(times = 12) {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setImmediate(resolve));
}

const calls = [];
const fakeRuntime = {
  onebot: { call: async (action, params) => { calls.push({ action, params }); return {}; } },
  sender: { sendTextBatch: async () => ({}) },
  store: { appendSelf: () => ({}) }
};
const ctxFor = (requesterId) => ({ ...fakeRuntime, requesterId, kind: 'private', chatId: '1', chatKey: 'private:1' });
/** 提交一次：`{ result }` 或 `{ message }`（被拒时）。 */
function submit(requesterId, comicId) {
  try {
    return { result: jmcomic.enqueueJmcomicDownload(ctxFor(requesterId), comicId), message: null };
  } catch (error) {
    return { result: null, message: error.message };
  }
}
const savedJobs = () => JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8')).jobs;

// ── 1. 真跑一次上传：完成后记录必须留在 jobs.json 里 ──
const jmcomic = await load('media/jmcomic.js');
const { DEFAULT_CONFIG } = await load('core/config.js');
const configuredPython = structuredClone(DEFAULT_CONFIG);
configuredPython.jmcomic.pythonPath = path.join(DATA, 'configured-python.exe');
const configuredCommand = jmcomic.resolveJmcomicPythonCommand(configuredPython);
const fallbackCommand = jmcomic.resolveJmcomicPythonCommand(DEFAULT_CONFIG);
ok('Python 解释器优先读取 jmcomic.pythonPath，空值保持原有环境变量回退',
  configuredCommand.command === configuredPython.jmcomic.pythonPath
  && configuredCommand.prefix.length === 0
  && fallbackCommand.command === process.env.JMCOMIC_PYTHON
  && fallbackCommand.prefix.length === 0);
jmcomic.initJmcomicQueue(fakeRuntime);
await flush();

ok('夹具任务真的走完了上传（假 onebot 收到 upload_private_file）',
  calls.length === 1 && calls[0].action === 'upload_private_file',
  `收到 ${calls.length} 次调用：${calls.map((call) => call.action).join('、') || '（无）'}`);

const afterUpload = savedJobs();
const uploaded = afterUpload.find((job) => job.id === 'jm_fixture_upload');
ok('上传成功后**记录仍在** jobs.json 里（去重靠它，摘了就等于对成功的漫画不设防）',
  !!uploaded,
  `盘上是 ${afterUpload.map((job) => `${job.id}:${job.status}`).join('、') || '（空）'}` +
  ' —— 记录被摘掉时，同一用户可以立刻再提交一次、命中缓存后马上重复上传一份 PDF');
ok('那条记录是 completed，不是还挂在待办里', uploaded?.status === 'completed', `实际 ${uploaded?.status}`);
ok('completed 不会被 worker 再跑一遍（isPending 不含它）',
  calls.length === 1,
  `假 onebot 被调了 ${calls.length} 次 —— 比 1 多就是把已完成的任务又上传了一遍`);
ok('已完成任务的日志文件被删掉：留记录、不留日志',
  !fs.existsSync(path.join(LOG_DIR, 'jm_fixture_upload.log')),
  '日志还在 —— cleanupCompletedJob 里"删日志"这一半没生效');

// ── 2. 完成后仍然按（请求者 QQ + 漫画 ID）去重 ──
const sameUser = submit('u2', '222');
ok('刚上传完的漫画：同一用户再提交被拒（这条就是本次改动要的行为）',
  sameUser.message !== null && sameUser.message.includes('不能重复提交'), `实际：${sameUser.message}`);

const otherUser = submit('u3', '222');
ok('换个用户提交同一漫画不被拒 —— key 是 `请求者:漫画ID`，漫画相同也该各算各的',
  otherUser.message === null && otherUser.result?.comicId === '222',
  `实际：${otherUser.message ?? JSON.stringify(otherUser.result)}`);

// ── 3. 窗口的计时起点是完成时刻 ──
const repeatedDone = submit('u1', '111');
ok('createdAt 已过 90 分钟、uploadedAt 才 1 分钟的记录仍然拦得住（窗口从完成时刻算）',
  repeatedDone.message !== null && repeatedDone.message.includes('不能重复提交'),
  `实际：${repeatedDone.message} —— 只看 createdAt 的话，一次耗时超过窗口的下载` +
  '在上传完成的当刻就已经"过期"，防重形同虚设');

await flush();
const finalJobs = savedJobs();
ok('被拒的两次提交没有留下任何记录，但两条 completed 记录都还在（上一步换人那条除外）',
  finalJobs.length === fixture.length + 1 &&
  finalJobs.filter((job) => job.status === 'completed').length === 2,
  `盘上 ${finalJobs.map((job) => `${job.id}:${job.status}`).join('、')}`);

process.exit(done() ? 0 : 1);
