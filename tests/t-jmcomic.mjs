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
// ⚠️ 安全网：本套件不该产生任何真实下载。做法是在夹具 `config.json` 里把 `python.path` 写死成
// 一个**不存在的程序**：即使某个断言写错、队列真的跑起来去 spawn python，最多拿到
// "无法启动 Python（<那个不存在的程序>）"，走重试/失败分支，不联网、不碰真 data/。
//
// 这道网原先挂在**环境变量** `JMCOMIC_PYTHON`（早已废弃的别名）上，2026-09-29 别名正式删除后
// 改为挂在**配置**上。换完还顺带修掉一个脆弱性：旧写法必须显式保存/复原 `QQ_AGENT_PYTHON`，
// 否则本机恰好设了它（它优先级更高）就会顶掉安全网——在 A 机器绿、在 B 机器红，甚至真的联网下载。
// 现在安全网只依赖夹具自己写下的那份配置，而配置的优先级最高，谁也顶不掉。
//
// 另有两段守**解释器本身**（两个 Python 工具共用它，所以归这里）：
//   1b. `resolvePythonCommand` 报出的**来源层级**（各报自己的名字）；
//   1c. `core/python-probe.ts` 的探测与 `--self-check` 运行器 —— 那一段**一个真解释器都不启动**
//       （路径不存在时模块在 spawn 之前就返回；其余用例全部注入假 `spawn`），所以它不需要安全网。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { checker, dataDir } from './lib/harness.mjs';
import { BASE_URL, load } from './lib/src.mjs';

const DATA = dataDir('qqagent-jmcomic-');
const { ok, done } = checker();
// 安全网（见文件头）。必须写在 `load('media/jmcomic.js')` 之前：config.js 在加载时就把
// DATA_DIR 定死并读一次 config.json。
const NO_SUCH_PYTHON = path.join(DATA, 'no-such-python.exe');
fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify({ python: { path: NO_SUCH_PYTHON } }), 'utf8');

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
const { resolvePythonCommand } = await load('core/python-runtime.js');

// 解释器解析链。两个 Python 工具（漫画下载、搜图 worker）共用这一条，所以它归
// core/python-runtime.ts；这里验的是"两个入口的优先级 + 旧名字不再生效"。
//
// 夹具必须**显式管住两个环境变量**：本机可能恰好设了 QQ_AGENT_PYTHON，不管住就会出现
// "在 A 机器绿、在 B 机器红"—— 所以每一条断言都自己摆好它需要的那一组环境变量。
// `JMCOMIC_PYTHON` 只在一个地方出现：证明它**已经不再生效**。
const savedPythonEnv = { QQ_AGENT_PYTHON: process.env.QQ_AGENT_PYTHON, JMCOMIC_PYTHON: process.env.JMCOMIC_PYTHON };
const setPythonEnv = (name, value) => { if (value === undefined) delete process.env[name]; else process.env[name] = value; };
const CONFIGURED_PATH = path.join(DATA, 'configured-python.exe');
const ENV_PRIMARY = path.join(DATA, 'env-primary-python.exe');
try {
  setPythonEnv('QQ_AGENT_PYTHON', undefined);
  setPythonEnv('JMCOMIC_PYTHON', undefined);
  // ① 配置项优先于**一切**环境变量（所以两个变量都清空后再试）
  const byConfig = resolvePythonCommand({ python: { path: CONFIGURED_PATH } });
  ok('python.path 优先于环境变量，且不加 conda 前缀',
    byConfig.command === CONFIGURED_PATH && byConfig.prefix.length === 0, `拿到 ${byConfig.command}`);

  // ② 配置留空 → QQ_AGENT_PYTHON（它就是设置页清空时的取值 `''`）
  setPythonEnv('QQ_AGENT_PYTHON', ENV_PRIMARY);
  const byPrimary = resolvePythonCommand({ python: { path: '' } });
  ok('python.path 留空时回落到 QQ_AGENT_PYTHON',
    byPrimary.command === ENV_PRIMARY && byPrimary.prefix.length === 0, `拿到 ${byPrimary.command}`);

  // ③ 旧名 `JMCOMIC_PYTHON` 已于 2026-09-29 正式废弃删除：只设它必须**一路回落到平台默认**。
  // 这条是**反向**断言：它的存在就是为了在有人把那个别名加回来时变红 —— 废弃了却还生效，
  // 比没有它更糟（用户改了一个"看起来应该管用"的变量，然后什么也没发生）。
  setPythonEnv('QQ_AGENT_PYTHON', undefined);
  setPythonEnv('JMCOMIC_PYTHON', ENV_PRIMARY);
  const byLegacy = resolvePythonCommand({ python: { path: '' } });
  ok('已删除的旧环境变量 JMCOMIC_PYTHON 不再生效（只设它要回落到固定环境/conda，而不是拿它当解释器）',
    byLegacy.command !== ENV_PRIMARY && ['windows-direct', 'conda'].includes(byLegacy.source),
    `拿到 ${byLegacy.command} / ${byLegacy.source}`);

  // ④ 两个变量都在时以 QQ_AGENT_PYTHON 为准（旧名字不参与，这条确认它不会抢戏）
  setPythonEnv('QQ_AGENT_PYTHON', CONFIGURED_PATH);
  const byBoth = resolvePythonCommand({ python: {} });
  ok('两个环境变量都在时以 QQ_AGENT_PYTHON 为准',
    byBoth.command === CONFIGURED_PATH, `拿到 ${byBoth.command}`);

  // ⑤ 空白/非字符串的 path 都算"没配"，不能拿去 spawn
  setPythonEnv('QQ_AGENT_PYTHON', ENV_PRIMARY);
  const byBlank = resolvePythonCommand({ python: { path: '   ' } });
  const byWrongType = resolvePythonCommand({ python: { path: 42 } });
  ok('空白的 python.path 与非字符串的 python.path 都回落到下一级，而不是当成空路径去 spawn',
    byBlank.command === ENV_PRIMARY && byWrongType.command === ENV_PRIMARY,
    `空白→${byBlank.command} / 非字符串→${byWrongType.command}`);

  // ⑥ 默认配置里的 `python.path` 必须是空串。给它兜一个"看起来方便"的默认路径，会让**所有
  // 没配过的人**都被那个路径顶掉（环境变量、固定环境、conda 全轮不到），症状是"我这台机器
  // 明明能用，换台机器就一直说找不到解释器"。
  const byDefault = resolvePythonCommand(DEFAULT_CONFIG);
  ok('DEFAULT_CONFIG 的 python.path 是空串，真实配置才能正常回落到环境变量',
    byDefault.command === ENV_PRIMARY && byDefault.source === 'env-primary',
    `拿到 ${byDefault.command} / ${byDefault.source}`);
} finally {
  setPythonEnv('QQ_AGENT_PYTHON', savedPythonEnv.QQ_AGENT_PYTHON);
  setPythonEnv('JMCOMIC_PYTHON', savedPythonEnv.JMCOMIC_PYTHON);
}

// ── 1b. 解析来源：命中的是解析链的哪一级 ──
//
// 为什么单独断言它：解释器可能来自四条路中的任意一条，而**只有用户自己知道他填了哪个**。
// 搜图或漫画因为"环境里没装库"失败时，无论解释器是哪一个，报错文本完全一样；把来源报出来，
// "我明明填了路径"与"其实还在用 conda 回退"才分得开。设置页「测试解释器」显示的就是这个值。
try {
  setPythonEnv('QQ_AGENT_PYTHON', undefined);
  setPythonEnv('JMCOMIC_PYTHON', undefined);
  const srcConfig = resolvePythonCommand({ python: { path: CONFIGURED_PATH } }).source;
  setPythonEnv('QQ_AGENT_PYTHON', ENV_PRIMARY);
  const srcPrimary = resolvePythonCommand({ python: { path: '' } }).source;
  setPythonEnv('QQ_AGENT_PYTHON', undefined);
  const fallback = resolvePythonCommand({ python: { path: '' } });
  ok('前两级各自报出自己的来源（config / env-primary）',
    srcConfig === 'config' && srcPrimary === 'env-primary',
    `拿到 ${srcConfig} / ${srcPrimary} —— 全报同一个值时` +
    '「我填了路径但没生效」在面板上就看不出来了');
  // 末两级与平台有关：本机固定环境存在则直用（windows-direct），否则走 conda。
  // 断言写成"来源与 command 自洽"，这样在装了那个环境的机器与没装的机器上都成立。
  const isConda = fallback.command === 'conda.exe' || fallback.command === 'conda';
  ok('无配置无环境变量时，来源与 command 自洽（conda ↔ conda，否则 windows-direct）',
    fallback.source === (isConda ? 'conda' : 'windows-direct'),
    `拿到 ${fallback.source} / ${fallback.command}`);
} finally {
  setPythonEnv('QQ_AGENT_PYTHON', savedPythonEnv.QQ_AGENT_PYTHON);
  setPythonEnv('JMCOMIC_PYTHON', savedPythonEnv.JMCOMIC_PYTHON);
}

// ── 1c. 探测 / 自检模块（`core/python-probe.ts`）──
//
// ⚠️ 这一段**一个真解释器都不启动**：要么路径不存在（模块会在 spawn 之前就返回），要么
// `deps.spawn` 是假实现。夹具配置里那道安全网（不存在的 python.path）保护的是漫画队列，
// 管不到这里 —— 所以夹具的每一条都必须自己保证不 spawn 真程序（这才是"能不能在 CI/任何机器上跑"的前提）。
const { probePython, runSelfCheck } = await load('core/python-probe.js');
const { PIC_IMAGE_SEARCH_SCRIPT } = await load('core/python-runtime.js');
const MISSING = path.join(DATA, 'definitely-missing-python.exe');
// 一个**存在但不可执行**的空文件：只用来骗过"这个路径下有没有文件"那道检查。
// 所有用到它的用例都注入了假 `spawn`，所以它永远不会被真的执行。
const EXISTING_PYTHON = path.join(DATA, 'fake-python.exe');
fs.writeFileSync(EXISTING_PYTHON, '');

/**
 * 假子进程。`on('data')` 的事件**在注册时就排定**、`on('close'|'error')` 也是 ——
 * 排定顺序即注册顺序，所以 data 一定先于 close 到达（真实 spawn 也是这个顺序）。
 * 写成"构造时立刻排定"会让 close 抢在模块注册 data 之前触发，stdout 恒为空、
 * 于是"解析回答"的断言永远看不到东西（假绿）。
 */
function fakeChild({ stdout = '', stderr = '', code = 0, close = true, error = null }) {
  const handlers = {};
  const child = {
    killed: false,
    stdout: { on: (event, fn) => { if (event === 'data' && stdout) setImmediate(() => fn(stdout)); } },
    stderr: { on: (event, fn) => { if (event === 'data' && stderr) setImmediate(() => fn(stderr)); } },
    on: (event, fn) => {
      (handlers[event] ||= []).push(fn);
      if (event === 'close' && close) setImmediate(() => fn(code));
      if (event === 'error' && error) setImmediate(() => fn(error));
    },
    kill: () => { child.killed = true; }
  };
  return child;
}
/** 记录调用并按脚本回答。`spec` 可以是对象或返回对象的函数。 */
function fakeSpawn(spec) {
  const seen = [];
  const fn = (command, args, options) => {
    seen.push({ command, args: [...args], options });
    const child = fakeChild(typeof spec === 'function' ? spec() : spec);
    child.seen = seen[seen.length - 1];
    return child;
  };
  fn.seen = seen;
  return fn;
}

// ① 路径不存在：**连 spawn 都不该发生**（填错路径是最常见的错，也是最该被一眼看出的错）
{
  let spawnCalls = 0;
  const report = await probePython({ python: { path: MISSING } }, { spawn: () => { spawnCalls++; throw new Error('不该来到这里'); } });
  ok('python.path 指向不存在的文件时不启子进程，直接说"这个路径下没有文件"，并报出来源',
    report.ok === false && report.exists === false && report.source === 'config' && spawnCalls === 0 &&
    String(report.error).includes('没有文件'),
    `拿到 ${JSON.stringify(report)} / spawn 次数 ${spawnCalls}`);
}

// ② 正常回答：解释器自报家门 + 两个库的版本（未装为 null）
{
  const spawnFn = fakeSpawn({
    stdout: '{"exe": "C:/py/python.exe", "version": "3.11.3", "deps": {"PicImageSearch": "4.2.0", "jmcomic": null}}\n'
  });
  const report = await probePython({ python: { path: EXISTING_PYTHON } }, { spawn: spawnFn });
  const args = spawnFn.seen[0].args;
  ok('探测脚本经 `-c` 传入，且问的正是两个工具各自的导入名',
    args[args.length - 2] === '-c' && args[args.length - 1].includes('PicImageSearch') && args[args.length - 1].includes('jmcomic'),
    `拿到 ${JSON.stringify(args.slice(-2))}`);
  ok('解析出解释器版本与两个库的状态（未安装为 null，不是编一个版本号）',
    report.ok === true && report.interpreter?.version === '3.11.3' &&
    report.interpreter?.deps?.PicImageSearch === '4.2.0' && report.interpreter?.deps?.jmcomic === null,
    `拿到 ${JSON.stringify(report.interpreter)}`);
}

// ③ 回退两级：command 不是绝对路径（conda）或指向固定环境，解析链的前缀必须原样带上
{
  const spawnFn = fakeSpawn({ stdout: '{"exe": "x", "version": "3.9.0", "deps": {}}\n' });
  let report;
  try {
    setPythonEnv('QQ_AGENT_PYTHON', undefined);
    report = await probePython({ python: { path: '' } }, { spawn: spawnFn });
  } finally {
    setPythonEnv('QQ_AGENT_PYTHON', savedPythonEnv.QQ_AGENT_PYTHON);
  }
  const levels = ['windows-direct', 'conda'];
  const isConda = report.command === 'conda.exe' || report.command === 'conda';
  ok('回退两级：conda 形态的 exists 是 null（不是路径，无从判），固定环境形态是 true（能走这一支就因为文件在），且 prefix 原样转发',
    levels.includes(report.source) && report.exists === (isConda ? null : true) &&
    report.prefix.join(' ') === spawnFn.seen[0].args.slice(0, report.prefix.length).join(' '),
    `拿到 ${JSON.stringify({ source: report.source, command: report.command, exists: report.exists, prefix: report.prefix })}`);
}

// ④⑤⑥ 三条坏路径：回答不是 JSON、非零退出、超时。**都要有话说**，不能只回一个 ok:false
{
  const notJson = await probePython({ python: { path: EXISTING_PYTHON } },
    { spawn: fakeSpawn({ stdout: 'hello there\n' }) });
  ok('解释器没给出可识别的回答时，把它的原文带回来（而不是只说"失败"）',
    notJson.ok === false && String(notJson.error).includes('hello there'), `拿到 ${JSON.stringify(notJson.error)}`);

  const badExit = await probePython({ python: { path: EXISTING_PYTHON } },
    { spawn: fakeSpawn({ code: 2, stderr: 'syntax error\n' }) });
  ok('非零退出时报出退出码与 stderr',
    badExit.ok === false && String(badExit.error).includes('2') && String(badExit.error).includes('syntax error'),
    `拿到 ${JSON.stringify(badExit.error)}`);

  const spawnFn = fakeSpawn(() => ({ close: false }));
  const hung = await probePython({ python: { path: EXISTING_PYTHON } }, { spawn: spawnFn, timeoutMs: 50 });
  ok('迟迟不退出时到点终止并 kill 子进程（否则「测试解释器」会把页面转圈到用户放弃）',
    hung.ok === false && hung.interpreter === null && String(hung.error).includes('没有回应'),
    `拿到 ${JSON.stringify(hung)}`);
}

// ⑦⑧⑨ 自检：跑的是 worker 的 --self-check，输出取 stderr 原文
{
  const spawnFn = fakeSpawn({ stderr: 'PicImageSearch 4.2.0\nengines: ...\n' });
  const report = await runSelfCheck({ python: { path: EXISTING_PYTHON } }, { spawn: spawnFn });
  const args = spawnFn.seen[0].args;
  ok('自检参数 = <解释器> [前缀] <worker 脚本> --self-check（脚本路径来自 core/python-runtime）',
    report.command === EXISTING_PYTHON &&
    args.join('|') === [...report.prefix, PIC_IMAGE_SEARCH_SCRIPT, '--self-check'].join('|'),
    `拿到 command=${report.command} / args=${JSON.stringify(args)}`);
  ok('自检通过时 ok=true，且输出取的是 stderr 原文（self_check 全打在 stderr）',
    report.ok === true && report.exitCode === 0 && report.output.includes('PicImageSearch 4.2.0'),
    `拿到 ${JSON.stringify(report)}`);

  const failed = await runSelfCheck({ python: { path: EXISTING_PYTHON } },
    { spawn: fakeSpawn({ code: 2, stderr: 'no module named picimagesearch' }) });
  ok('库缺失（退出码 2）时 ok=false，退出码与 stderr 都留在 output 里（原文要能贴回去对表）',
    failed.ok === false && failed.exitCode === 2 &&
    failed.output.includes('退出码：2') && failed.output.includes('no module named picimagesearch'),
    `拿到 ${JSON.stringify({ ok: failed.ok, exitCode: failed.exitCode, output: failed.output })}`);

  const long = await runSelfCheck({ python: { path: EXISTING_PYTHON } },
    { spawn: fakeSpawn({ stderr: `HEAD-MARKER${'x'.repeat(25_000)}TAIL-MARKER` }) });
  ok('超长输出会截断（保留开头）并注明被截断，不会把整段塞进 HTTP 响应',
    long.output.includes('HEAD-MARKER') && !long.output.includes('TAIL-MARKER') && long.output.includes('已截断'),
    `输出 ${long.output.length} 字`);
}

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

// ── 4. 旧配置迁移：jmcomic.pythonPath → python.path ──
//
// 为什么这条必须存在：README 一直教用户手改 config.json 写 `jmcomic.pythonPath`。
// 字段搬到顶层时若只是"删掉"，那批配置会**静默失效** —— 解释器回落成默认探测链，
// 用户看到的是"漫画下载突然要 conda 了"，而没有任何地方提示他重填。
// 迁移写在 `normalizeConfigShape` 里，且**必须显式 `delete` 旧键**：updateConfig 走的是
// `deepMerge(getConfig(), patch)`，它只加键不删键，不删就会永远留在 config.json 里。
//
// 只能在**子进程**里验：`loadConfig` 读的是模块加载期就定死的 DATA_DIR，而本套件自己的
// DATA 早已被上面的用例写满了配置；模块也有 `currentConfig` 缓存。开一个干净的
// QQ_AGENT_DATA_DIR 重跑一次是最省事、也最贴近"用户机器上真发生什么"的做法。
const MIGRATE_DIR = fs.mkdtempSync(path.join(DATA, 'migrate-'));
fs.writeFileSync(path.join(MIGRATE_DIR, 'config.json'), JSON.stringify({
  jmcomic: { pythonPath: '  D:\\probe python\\python.exe  ' },
  api: { model: 'probe-model' }
}), 'utf8');
const migrateProbe = [
  'const cfg = await import(process.env.PROBE_URL);',
  'const base = cfg.getConfig();',
  'const loadedPath = base.python?.path;',
  "const legacyGoneInMemory = !('jmcomic' in base);",
  'cfg.updateConfig({});',
  "const disk = JSON.parse((await import('node:fs')).readFileSync(process.env.PROBE_FILE, 'utf8'));",
  "console.log(JSON.stringify({ loadedPath, legacyGoneInMemory, diskPath: disk.python?.path, legacyGoneOnDisk: !('jmcomic' in disk) }));"
].join('\n');
const probeOut = execFileSync(process.execPath, ['--input-type=module', '-e', migrateProbe], {
  env: {
    ...process.env,
    QQ_AGENT_DATA_DIR: MIGRATE_DIR,
    PROBE_URL: BASE_URL + 'core/config.js',
    PROBE_FILE: path.join(MIGRATE_DIR, 'config.json')
  },
  encoding: 'utf8'
});
const migrated = JSON.parse(probeOut.trim().split('\n').pop());
ok('旧的 jmcomic.pythonPath 被搬到 python.path（trim 过），并在内存里删掉了旧键',
  migrated.loadedPath === 'D:\\probe python\\python.exe' && migrated.legacyGoneInMemory,
  `拿到 ${JSON.stringify(migrated)}`);
ok('迁移会落盘：保存一次后 config.json 里没有 jmcomic、python.path 仍是原值',
  migrated.diskPath === 'D:\\probe python\\python.exe' && migrated.legacyGoneOnDisk,
  `拿到 ${JSON.stringify(migrated)} —— 不落盘的话旧键会永远留在用户的 config.json 里`);

// ── 5. 安全网自证 ──
//
// 这是整套夹具里**唯一**能证明"安全网真的生效"的证据。安全网失效时，第 3 位用户那条任务会真的
// 去下载漫画 —— 而**下载成功**在断言里与"压根没跑"长得一模一样（都是没有 lastError），
// 所以必须正向钉住"它是因为解释器不存在而失败的"。
const waitForFailedJob = async () => {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const job = savedJobs().find((item) => item.requesterId === 'u3');
    if (job && job.lastError) return job;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return savedJobs().find((item) => item.requesterId === 'u3') || null;
};
const safetyJob = await waitForFailedJob();
ok('安全网真的兜住了：那条真被排上队的任务失败于"无法启动 Python（不存在的解释器）"，而不是联网下载',
  !!safetyJob && String(safetyJob.lastError).includes('无法启动 Python'),
  `拿到 ${JSON.stringify(safetyJob && { status: safetyJob.status, lastError: safetyJob.lastError })}`);

process.exit(done() ? 0 : 1);
