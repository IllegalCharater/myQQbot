// 长期任务的计时器句柄（S10+）：`app.start()` 起了什么、`app.stop()` 有没有真的收干净。
//
// 为什么需要它：S9 的 `LONG_TERM_TASKS` 是**声明**（"我能停"），`t-tasks.mjs` 只能核对
// 声明与入口名对不对得上——它证不了"调了 stop 之后定时器真的没了"。这一层只有拿到
// 计时器**句柄**才看得见，而句柄之间的差别恰恰是本阶段要修的东西：
//   • `price-feed` 的同 URL 早退 bug：清了旧定时器却不重建，小时级刷新永久停摆且静默；
//   • jmcomic 的 `runWorker` → `finally` → `scheduleNextWake()`：停之后队列会把自己排回来
//     （S10b 的 `if (!runtime) return` 就是为它加的，第 2 段真跑一次 worker 来钉）；
//   • onebot 的两处重连是**裸 setTimeout、句柄没存**：close() 停不掉它，connect()/reconnect()
//     也清不掉它——迟到的定时器会再建一个 socket 覆盖 `this.socket`（S10c 存句柄后修掉，
//     第 4 段用**同一个句柄**的 clearTimeout 来钉）；
//   • 配置刷新不看 snowluma 端点（S11b）：改完保存后实例还指着旧地址，要重启才生效——
//     第 5 段钉"改了要重连"，同时钉死"没真的变就**不许**重连"（否则保存一次设置断一次连接）。
//
// 手法：临时把 globalThis 上的计时器换成本地记录器（设计稿 §9.2 认可的"第 2 种补法"，
// 先例是 harness 的 `createDomSandbox` 在 vm 里覆写计时器）。**不改生产代码**——`dist/`
// 里 `setTimeout`/`setInterval`/`clearInterval` 编译成裸全局标识符（运行期查找），
// 所以在 `load()` 之后替换 `globalThis.*` 拦得住被测模块的调用（已实测，不是推断）。
//
// ⚠️ 三个坑，改本文件时别踩：
//   1. 假句柄必须是**带 `unref()` 的真值对象**——被测代码会调 `timer.unref?.()`，
//      句柄是 `undefined` 的话"这个任务会不会钉住进程"的判定会失真（下面有一条专门钉它）。
//   2. `withFakeTimers()` 必须 `try/finally` 恢复。被测模块是**模块级单例**，
//      漏恢复会把这个进程里后续用例的计时器全换成假的。
//   3. **不能只数"建了几次"**：`clearInterval` 之后没重建，与压根没清，在只数 `setInterval`
//      次数时长得一模一样——而前者正是 price-feed 那个 bug 的形态。所以下面同时断言
//      "还活着的句柄数"和"被清掉的句柄数"。
//
// 覆盖不到的（真机冒烟项，别假装这里管了）：重连的真实网络行为、退出时进程是否干净退出、
// jmcomic 在途下载被 stop 之后队列的实际状态。
//
// 另有一处**已知的守护空白**（S10b 实测确认，写下来免得以后误以为它管着）：
// `runWorker` 的 `while (runtime && ...)` 这道闸门删掉不会让任何套件变红。观察到它的差别需要
// 夹具里同时有"可跑的任务 A（在它的上传回调里停队列）"和"可跑的任务 B"，而那个 B 会留在模块
// 内存里过继给后面的真起 app 段（那时它就带着真 onebot 去上传了）。所以那道守卫只有注释在守。
import fs from 'node:fs';
import path from 'node:path';
import { checker, dataDir } from './lib/harness.mjs';
import { ROOT, load, stripComments } from './lib/src.mjs';

const DATA = dataDir('qqagent-timers-');
const { ok, done } = checker();

// jmcomic 夹具：**必须在本文件第一次 `initJmcomicQueue()` 之前写盘**（下面第 2、3 段都会调它）。
// 两条设计，缺一不可：
//   • 状态是 pending（`downloaded`）：`cleanupDownloadCacheIfDue` 只在整个队列空闲时才清空
//     下载目录、`jobs = []` 并重新写盘，所以没有这个待办的话首跑清理会把夹具连同 jobs.json
//     一起抹掉（它第一件事就是 `fs.rmSync(DOWNLOAD_DIR)`）。
//   • `nextAttemptAt` 在**刚过去**（可跑）：第 2 段要靠它让 worker 真的进到 `uploadStage`
//     的 `onebot.call` 那里，才能模拟"上传途中被停"。跑完那一轮后它自己会被挪到 30s 之后，
//     于是第 3 段（真起 app）拿到的是一个**不可跑**的待核验任务，不会去碰真 onebot。
// 全局只加载一次 jobs（模块内 `loaded` 标志），所以三段共用同一个任务，顺序不能换。
const JM_DIR = path.join(DATA, 'jmcomic');
const JM_DOWNLOADS = path.join(DATA, 'downloads', 'jmcomic');
fs.mkdirSync(JM_DIR, { recursive: true });
fs.mkdirSync(JM_DOWNLOADS, { recursive: true });
const JM_PDF = path.join(JM_DOWNLOADS, 'fixture.pdf');
// 1024 字节起、且以 %PDF- 开头 —— 缺一样 `validatePdf` 都会把任务打回 queued，
// 那样 worker 会从上传阶段掉回下载阶段去 spawn python。
fs.writeFileSync(JM_PDF, Buffer.concat([Buffer.from('%PDF-1.4\n', 'ascii'), Buffer.alloc(1200, 0x20)]));
fs.writeFileSync(path.join(JM_DIR, 'jobs.json'), JSON.stringify({
  version: 1,
  jobs: [{
    id: 'jm_fixture', key: 't:1', comicId: '1', requesterId: 't', kind: 'private',
    chatId: '1', chatKey: 'private:1', status: 'downloaded',
    downloadAttempts: 1, uploadAttempts: 0, pdfPath: JM_PDF, lastError: '',
    nextAttemptAt: Date.now() - 1000, createdAt: Date.now(), updatedAt: Date.now()
  }]
}, null, 2), 'utf8');

/** 让被测模块里那些不返回句柄的 async 流程跑完（`void runWorker()` 拿不到 promise）。 */
async function flush(times = 12) {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * 把进程级计时器换成记录器跑一段代码，结束后原样恢复。`fn` 可以是 async。
 *
 * 记录器给的句柄是普通对象 `{ kind, fn, ms, id, unref() }`（见坑 1），不是真 Timeout——
 * 所以这些段只能验"句柄的增减与归属"，不能验"到点真的会跑"（那要真时间，本套件不干）。
 *
 * `opts.fetch === false` 时不动 `globalThis.fetch`（给真起 app 的那一段用：那段里
 * 除了价格表还有别的网络路径，拦住整条 fetch 会顺带改掉被测应用的启动行为）。
 */
async function withFakeTimers(fn, { fetch: stubFetch = true } = {}) {
  const real = {
    setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval,
    setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
    fetch: globalThis.fetch
  };
  let nextId = 1;
  const mkHandle = (kind, fn2, ms) => {
    // 句柄本身带着元数据，且**原对象**进数组——不能 push 一个 `{...h}` 拷贝：
    // 那样 `unref()` 改的是原对象，而断言读到的拷贝永远停在 push 那一刻的 false。
    const h = { kind, fn: fn2, ms, id: nextId++, unrefCalled: false };
    h.unref = () => { h.unrefCalled = true; return h; };
    return h;
  };
  const t = {
    intervals: [],       // 建过的 interval 句柄，按建立顺序
    timeouts: [],        // 建过的 timeout 句柄，按建立顺序
    clearedIntervals: new Set(),   // 被 clearInterval 过的句柄 id
    clearedTimeouts: new Set(),    // 被 clearTimeout 过的句柄 id
    /** 建过、且没被清掉的 interval —— "现在真正活着的那几个"。 */
    active: () => t.intervals.filter((h) => !t.clearedIntervals.has(h.id)),
    activeTimeouts: () => t.timeouts.filter((h) => !t.clearedTimeouts.has(h.id))
  };
  globalThis.setInterval = (fn2, ms) => { const h = mkHandle('interval', fn2, ms); t.intervals.push(h); return h; };
  globalThis.clearInterval = (h) => { if (h && typeof h.id === 'number') t.clearedIntervals.add(h.id); };
  globalThis.setTimeout = (fn2, ms) => { const h = mkHandle('timeout', fn2, ms); t.timeouts.push(h); return h; };
  globalThis.clearTimeout = (h) => { if (h && typeof h.id === 'number') t.clearedTimeouts.add(h.id); };
  // fetch 也一起拦住：这些段只关心句柄，不关心网络。让它当次就失败，与真实断网同构
  // （`refreshPriceFeed` 内部全 catch），否则"确定性"断言会退化成依赖网络。
  if (stubFetch) globalThis.fetch = async () => { throw new Error('t-timers：本套件不联网'); };
  try {
    return await fn(t);
  } finally {
    Object.assign(globalThis, real);
  }
}

// ── 1. price-feed：同 URL 第二次调用不许把刷新弄停（S10a 修的 bug）──
const priceFeed = await load('llm/price-feed.js');
const FEED_URL = 'http://127.0.0.1:1/prices.json';

await withFakeTimers((t) => {
  priceFeed.initPriceFeed(FEED_URL);
  ok('initPriceFeed 起了一个 setInterval（不是 setTimeout）',
    t.intervals.length === 1 && t.timeouts.length === 0,
    `interval=${t.intervals.length} timeout=${t.timeouts.length}`);
  ok('检查周期就是模块头部写的"每小时一次"',
    t.intervals[0].ms === 3600 * 1000,
    `实际 ${t.intervals[0].ms}ms —— 改周期要同时改 price-feed.ts 的设计说明`);

  // 配置保存（applyConfigPatch → initPriceFeed）会带着**同一个 URL** 再调一次。
  // 这条就是那个 bug 的回归钉子：先清后判的话，这里会看到 0 个活着的句柄。
  priceFeed.initPriceFeed(FEED_URL);
  ok('同 URL 再调一次后，刷新定时器仍然活着（早退 bug 的回归钉子）',
    t.active().length === 1 && t.clearedIntervals.size === 0,
    `活动 interval ${t.active().length} 个、被清 ${t.clearedIntervals.size} 个` +
    ' —— 清了不重建 = 小时级刷新永久停摆，且状态页上看不出来');

  // 换 URL：旧的必须清掉，新的必须建起来（"能换 URL"是 S9 就声称的能力）
  priceFeed.initPriceFeed('http://127.0.0.1:1/other.json');
  ok('换 URL：旧句柄被清掉、恰好一个新句柄活着',
    t.active().length === 1 && t.clearedIntervals.size === 1,
    `活动 ${t.active().length} 个、被清 ${t.clearedIntervals.size} 个`);

  ok('新建的定时器调了 unref()（价格表不该把进程钉住）',
    t.intervals.at(-1)?.unrefCalled === true,
    '句柄必须是带 unref() 的真值对象，否则这条会假绿（见文件头坑 1）');

  priceFeed.stopPriceFeed();
  ok('stopPriceFeed 清掉定时器', t.active().length === 0, `还剩 ${t.active().length} 个`);
  const stopped = priceFeed.priceFeedStatus();
  ok('stopPriceFeed 只把 enabled 置假，url 与最后一次快照留着（面板不至于空白）',
    stopped.enabled === false && stopped.url === 'http://127.0.0.1:1/other.json',
    `enabled=${stopped.enabled} url=${stopped.url}`);

  const clearedBefore = t.clearedIntervals.size;
  priceFeed.stopPriceFeed();
  ok('stopPriceFeed 幂等：第二次不再产生 clearInterval，也不会误清别人',
    t.active().length === 0 && t.clearedIntervals.size === clearedBefore,
    `被清 ${t.clearedIntervals.size} 个（上一次是 ${clearedBefore}）`);

  priceFeed.initPriceFeed(FEED_URL);
  ok('stop 之后还能再 init —— 这就是"可重复 start"', t.active().length === 1,
    `活动 ${t.active().length} 个`);

  priceFeed.initPriceFeed('');
  const blank = priceFeed.priceFeedStatus();
  ok('空 URL 等价于停止：清定时器 + 清 url + enabled=false',
    t.active().length === 0 && blank.url === '' && blank.enabled === false,
    `活动 ${t.active().length} 个、url="${blank.url}"、enabled=${blank.enabled}`);
});

// ── 2. jmcomic：停得掉，而且不会把自己复活（S10b）──
// 这一段要证明的核心是 `scheduleNextWake()` 开头那句 `if (!runtime) return`：
// `runWorker` 的 `finally` 会无条件调它，所以"下载途中停队列"时，它本来会**立刻排一个新
// wake timer 把队列自己拉回来**——stop 就成了摆设。这条路径只有真跑一次 worker 才走得到。
const jmcomic = await load('media/jmcomic/index.js');

await withFakeTimers(async (t) => {
  // 停队列**正发生在 worker 在途时**：fake 的 onebot.call 一被调到就停队列，再抛错。
  // 抛错会进入 upload_uncertain（任务留在 pending、nextAttemptAt 挪到 30s 后），
  // 于是后面还能拿它当"有待办"的夹具。
  //
  // 注意这一段**不能**用 `t.active()` 断句柄数：stub 是同步被调到的，所以 stopJmcomicQueue
  // 就在 `initJmcomicQueue` 返回之前把那个 interval 清掉了。这里要钉的是"有没有排
  // 新的 timeout"，用"建过几个"来数才对。
  const stopDuringUpload = {
    onebot: { call: () => { jmcomic.stopJmcomicQueue(); throw new Error('t-timers：模拟上传途中停队列'); } },
    sender: {}, store: {}
  };
  jmcomic.initJmcomicQueue(stopDuringUpload);
  ok('initJmcomicQueue 起了缓存清理 interval',
    t.intervals.length === 1, `建了 ${t.intervals.length} 个 interval`);

  await flush();
  ok('worker 收尾时队列已被停 → scheduleNextWake 不再排新 wake（不会自我复活）',
    t.timeouts.length === 0, `排了 ${t.timeouts.length} 个 timeout` +
    ' —— 排了就是 runWorker 的 finally 把队列自己拉回来了，stop 形同虚设');
  ok('worker 跑完这一轮后，缓存清理 interval 已被 stopJmcomicQueue 清掉',
    t.active().length === 0, `还剩 ${t.active().length} 个`);

  // 停之后重新 init：任务还在（stop 不清 jobs），所以 wake timer 会重新排出来。
  // 这条同时是"stop 没把用户的下载任务丢掉"的行为证据 —— jobs 真被清了的话，
  // scheduleNextWake 捞不到待办，这里就一个 timeout 都不会有。
  // （上一轮上传结果未知已把 nextAttemptAt 挪到 30s 后，所以此刻它不可跑、不会碰 onebot。）
  jmcomic.initJmcomicQueue({ onebot: {}, sender: {}, store: {} });
  await flush();
  ok('重新 init：jobs 没被 stop 清掉（wake timer 为那个待办重新排了出来）',
    t.active().length === 1 && t.activeTimeouts().length === 1,
    `interval=${t.active().length} timeout=${t.activeTimeouts().length}` +
    ' —— 没有 timeout 就说明待办在内存里被清了（队列是持久化的，不该被停清空）');
  ok('缓存清理周期就是模块头部的"每小时检查一次"',
    t.intervals.at(-1).ms === 3600 * 1000, `实际 ${t.intervals.at(-1).ms}ms`);

  jmcomic.stopJmcomicQueue();
  ok('stopJmcomicQueue 把两个句柄都清掉（interval + wake timer）',
    t.active().length === 0 && t.activeTimeouts().length === 0,
    `还剩 interval ${t.active().length} 个、timeout ${t.activeTimeouts().length} 个`);

  const intervalsBefore = t.intervals.length;
  jmcomic.stopJmcomicQueue();
  ok('stopJmcomicQueue 幂等：第二次不再产生 clear，也不会误清别人',
    t.active().length === 0 && t.intervals.length === intervalsBefore,
    `被清 ${t.clearedIntervals.size} 个`);
});

// ── 3. 接线：app.start() 真的起了它们、app.stop() 真的停了它们 ──
// 上一段只证明"模块有能力停"，证明不了"app 里接上了"——这正是 S7 的教训
// （形状对 ≠ 接线通：两边各自合法、合起来不通，而且编译器和静态断言都看不见）。
// 所以这里真起一个应用（同 t-smoke 的做法），只数句柄。
//
// 这一段是"启动点在 start()"这条决定的守护：把 initPriceFeed / initJmcomicQueue
// 搬回 createApp() 或某个构造函数的话，`before` 就不会是 0，第 ① 条会红。
const { createApp } = await load('web/app.js');

await withFakeTimers(async (t) => {
  const app = createApp({ log: () => {} });
  // 构造对象图不该起任何长期任务（价格表 S10a 搬走、jmcomic S10b 搬走）。
  ok('createApp() 期间一个长期 timer 都没起（副作用已全部搬到 start()）',
    t.active().length === 0,
    `构造期间建了 ${t.active().length} 个 interval —— 说明还有任务靠模块/构造函数副作用启动`);

  app.updateConfig({ api: { priceRemoteUrl: FEED_URL } });
  const port = await app.start();
  ok('app.start() 起了价格表 + jmcomic 缓存清理两个 interval',
    t.active().length === 2,
    `活动 interval ${t.active().length} 个（期望 2）` +
    ' —— 少一个就说明某个 init 没接进 start()；（wake timer 是 timeout，不在此列）');

  await app.stop();
  ok('app.stop() 把长期 timer 收干净（两个 stop 都接上了）',
    t.active().length === 0,
    `活动 interval ${t.active().length} 个 —— 没归零说明 app.stop() 里 stopPriceFeed() 或 stopJmcomicQueue() 没接上`);
  ok('app.stop() 用掉的确实是真端口（不是没起来就断言）',
    Number.isInteger(port) && port > 0, `port=${port}`);
}, { fetch: false });

// ── 4. onebot 重连：停得掉，且不会漏掉一个 socket（S10c）──
// 这一段要证明的是：重连的 setTimeout 句柄被存了下来，所以 close() 取消得掉"已排定但尚未触发
// 的那一次"。S10c 之前那两处是**裸 setTimeout、句柄没存**，于是有两个后果：
//   ① close() 停不掉它 —— 那个定时器还活着，白白钉住事件循环最多 RECONNECT_MIN_MS；
//   ② connect()/reconnect() 也清不掉它 —— 迟到的定时器会再进 #connectLoop 建第二个 WebSocket
//      覆盖 this.socket，而调用方刚作废的那个旧 socket 从此再也没人关（连接泄漏）。
// 这里用**同一个句柄**的 clearTimeout 来钉，直接读 `clearedTimeouts`：不能用状态事件计数
// （close() 并不产生状态事件，靠它测不出取消）。
//
// 诱导手法：`new WebSocket` 对非法 URL **同步抛 SyntaxError**（`ws` 包的行为，已实测），
// 所以 `#connectLoop` 的 catch 分支能被确定性地走到，不需要网络、不需要真实时间。
// 但**只有这一个手法不够**：`close()` 那一条可以这么验，`connect()`/`reconnect()` 那两条不行
// （构造一直抛错的话，新排定会顺手清掉旧句柄，被测的取消删不删都一样——见下面第 ② 段的注释）。
const { OneBotClient } = await load('qq/onebot.js');

await withFakeTimers(async (t) => {
  const client = new OneBotClient({ wsUrl: 'bad' });

  await client.connect();
  ok('重连排定被记录成一个 setTimeout（catch 分支走 #scheduleReconnect）',
    t.timeouts.length === 1 && t.intervals.length === 0,
    `timeout=${t.timeouts.length} interval=${t.intervals.length}`);
  ok('重连间隔就是模块头部的 RECONNECT_MIN_MS',
    t.timeouts[0].ms === 3000, `实际 ${t.timeouts[0].ms}ms`);
  ok('重连定时器刻意不 unref（有重连待办时钉住进程是对的，S10c 的决定）',
    t.timeouts[0].unrefCalled === false, 'unref 会让进程在等重连期间可退出');

  // ① close()：用**同一个句柄**取消掉待触发的那一次。
  const stale = t.timeouts.at(-1);
  client.close();
  ok('close() 取消掉待触发的重连 —— 句柄被存下来才做得到',
    t.clearedTimeouts.has(stale.id) === true && t.activeTimeouts().length === 0,
    `被清 ${t.clearedTimeouts.size} 个、还剩 ${t.activeTimeouts().length} 个` +
    ' —— 没清说明 close() 只置了 #closedByUs，那个定时器仍会白钉住事件循环');

  // 第二道闸门：就算那个已作废的句柄**迟到触发**（直接调它的回调模拟到点），也不该建新连接。
  const beforeStaleFire = t.timeouts.length;
  stale.fn();
  ok('#closedByUs 第二道闸门：close() 之后迟到的重连不再建 socket、也不再排新 wake',
    t.timeouts.length === beforeStaleFire,
    `又多排了 ${t.timeouts.length - beforeStaleFire} 个 —— 说明早退没了，close() 之后还能自己接回来`);

  // ② connect() / reconnect()：修的是"重复连接泄漏"那一半。
  //
  // ⚠️ 这一段必须让**新的 socket 真的建得出来**，否则测不出东西：构造抛错时
  //    `#connectLoop` 会再排定一次，而 `#scheduleReconnect` 是"先清旧再存新"——
  //    新的排定顺手就把旧的清掉了，被测的那一行删不删都一样（**探针实测到过这个假绿**：
  //    只用非法 URL 的话，删掉 connect()/reconnect() 里的取消仍然全绿）。
  //    所以这里换成一个构造函数不抛的地址：`new WebSocket` 不同步建连，socket 对象立刻就有，
  //    不依赖联网成功。（同时断言 `client.socket !== null` 给这条夹具兜底——
  //    哪天这个地址也开始同步抛错，那条断言会先红，而不是让本段悄悄退化成假绿。）
  const OK_URL = 'ws://127.0.0.1:9';
  await client.connect(); // 此时 wsUrl 还是 'bad' → 走 catch → 排定
  const staleByConnect = t.timeouts.at(-1);
  client.wsUrl = OK_URL;
  await client.connect();
  ok('connect() 撤掉上一次遗留的重连排定（否则迟到的那次会建出第二个 socket）',
    t.clearedTimeouts.has(staleByConnect.id) === true
    && t.activeTimeouts().length === 0 && client.socket !== null,
    `被清 ${t.clearedTimeouts.size} 个、还剩 ${t.activeTimeouts().length} 个、socket=${client.socket ? '有' : '无'}` +
    ' —— 没撤掉的话：新连接已建好，旧句柄到点再建一个覆盖 this.socket，先前那个永不关闭');

  client.wsUrl = 'bad';
  await client.connect(); // 再排一次定（构造又抛；上面那个活着的 socket 不受影响）
  const staleByReconnect = t.timeouts.at(-1);
  client.wsUrl = OK_URL;
  await client.reconnect();
  ok('reconnect() 同样撤掉待触发的重连（本函数已经在作废旧 socket，不能漏掉定时器这一半）',
    t.clearedTimeouts.has(staleByReconnect.id) === true
    && t.activeTimeouts().length === 0 && client.socket !== null,
    `被清 ${t.clearedTimeouts.size} 个、还剩 ${t.activeTimeouts().length} 个、socket=${client.socket ? '有' : '无'}`);

  // ③ 第二处排定点：socket 的 `close` 事件（真实断线走的就是这条路）。
  //    手动 emit 一次把这个处理器同步跑一遍 —— 只测 catch 分支的话，这一处完全可以是裸
  //    setTimeout（**探针实测**：把它换回裸 setTimeout，本套件其余断言全绿，只有 t-tasks
  //    那条文本扫描红）。加上这条，"两处排定都必须存句柄"才真的被行为断言管住。
  const live = client.socket;
  live.emit('close');
  const fromCloseEvent = t.timeouts.at(-1);
  ok('socket 的 close 事件触发的重连也走 #scheduleReconnect（存了句柄才取消得掉）',
    fromCloseEvent.id !== staleByReconnect.id && t.activeTimeouts().length === 1,
    `新排定 ${fromCloseEvent.id === staleByReconnect.id ? '没发生' : '发生了'}、` +
    `活动 timeout ${t.activeTimeouts().length} 个 —— 这一处退回裸 setTimeout 时，句柄没人存`);

  client.close();
  ok('close() 之后归零，不留任何待触发的重连（含 close 事件那条路上排出来的）',
    t.clearedTimeouts.has(fromCloseEvent.id) === true && t.activeTimeouts().length === 0,
    `被清 ${t.clearedTimeouts.size} 个、还剩 ${t.activeTimeouts().length} 个`);
});

// ── 5. 改端点配置触发重连，且"没真的变就不重连"（S11b）──
// 缺口：`applyConfigPatch` 以前完全不看 snowluma 的地址与令牌，用户改完保存之后实例
// 还指着旧地址，必须重启应用才生效（设计稿 §7.3 记的那一行）。补法是 `applyEndpoint`
// **比较后**返回"到底变了没有"，调用方据此决定重连 —— 所以这一段有两个方向，缺一不可：
//   ① 改了 → 必须重连（缺了它，那个缺口还在）；
//   ② 没改 → **不许**重连。只测 ① 的话，一个"无条件 reconnect()"的实现也能全绿，
//      而它的后果很具体：每保存一次设置就断一次 WebSocket，面板状态灯乱闪、在收的事件丢帧。
// 判据是 `app.onebot.socket` 的**身份**：`reconnect()` 会先置空再建新的，所以身份变了就是重连了。
// （`t-timers` 的既有一课：只数"建了几个"分不清"清了没重建"与"压根没清"；身份比较没有这个问题。）
await withFakeTimers(async (t) => {
  const app = createApp({ log: () => {} });
  await app.start();
  const before = app.onebot.socket;
  ok('前置：start() 之后实例上有一个真 socket（否则下面的身份比较无从谈起）',
    before !== null && before !== undefined,
    `socket=${before ? '有' : '无'}`);

  // ① 同值：把当前的四个端点原样再写一遍（httpUrl 故意多带一个尾斜杠）。
  //    尾斜杠那一下同时是**归一化**的接线证据：归一化只写在构造函数里的话，
  //    这里会被判成变更 → 断连，而用户什么都没改。
  const cfg = app.getConfig();
  app.applyConfigPatch({
    snowluma: {
      wsUrl: cfg.snowluma.wsUrl,
      httpUrl: `${cfg.snowluma.httpUrl}/`,
      accessToken: cfg.snowluma.accessToken,
      httpAccessToken: cfg.snowluma.httpAccessToken
    }
  });
  ok('端点没真的变 → 不重连（socket 身份不变，尾斜杠差异也不算变更）',
    app.onebot.socket === before,
    app.onebot.socket === before ? '' : 'socket 被换掉了 —— 保存一次没动端点的设置就断了一次连接');

  // ② 改了 wsUrl：必须重连，而且新 socket 得真的建出来（区分"清了没重建"与"没清"）。
  app.applyConfigPatch({ snowluma: { wsUrl: 'ws://127.0.0.1:3002' } });
  ok('改了 wsUrl → 立刻重连（新 socket 身份不同且非空）',
    app.onebot.socket !== before && app.onebot.socket !== null,
    `socket=${app.onebot.socket ? '有' : '无'}、身份${app.onebot.socket === before ? '未变' : '已变'}`);

  await app.stop();
}, { fetch: false });

// 能力级：`applyEndpoint` 的比较规则（直接构造，不经过 app）。
await withFakeTimers(() => {
  const ep = new OneBotClient({ wsUrl: 'ws://127.0.0.1:3001', httpUrl: 'http://127.0.0.1:3000', accessToken: 'tok' });
  // 构造之后先记下"初始值"，不要在这里写死归一化后的字面量：写死的话，构造函数的归一化
  // 一旦被撤掉，下面那条"没给的字段保持不动"会跟着红 —— **红得对但理由不对**
  // （它管的是"undefined 不落成清空"，不是"构造函数会去尾斜杠"）。证伪探针 P3 实测踩到过。
  const initial = { httpUrl: ep.httpUrl, accessToken: ep.accessToken, httpToken: ep.httpToken };
  ok('applyEndpoint({}) → false：一个字段都没给，就什么都没变', ep.applyEndpoint({}) === false);
  ok('httpUrl 尾斜杠不算变更（与构造函数同一份归一化）',
    ep.applyEndpoint({ httpUrl: `${initial.httpUrl}/` }) === false && ep.httpUrl === initial.httpUrl,
    `httpUrl="${ep.httpUrl}"`);
  ok('改了字段 → true，且字段真的改到实例上',
    ep.applyEndpoint({ wsUrl: 'ws://127.0.0.1:3002' }) === true && ep.wsUrl === 'ws://127.0.0.1:3002',
    `wsUrl="${ep.wsUrl}"`);
  // 比较基准取**紧接着这一次调用之前**的值：拿构造时的值当基准的话，上面那条尾斜杠断言
  // 会先把 httpUrl 改掉，于是这条会为"别人的改动"变红（探针 P3 实测踩到）。
  const beforeUndefined = { httpUrl: ep.httpUrl, accessToken: ep.accessToken, httpToken: ep.httpToken };
  ep.applyEndpoint({ wsUrl: 'ws://127.0.0.1:3003' });
  ok('没给的字段保持不动（undefined = 保持不变，不是"清空"）',
    ep.httpUrl === beforeUndefined.httpUrl && ep.accessToken === beforeUndefined.accessToken
    && ep.httpToken === beforeUndefined.httpToken,
    `httpUrl="${ep.httpUrl}" accessToken="${ep.accessToken}" httpToken="${ep.httpToken}"`);
  ok('空令牌是真的清空（构造函数对令牌也是 String(v || \'\')，留空 = 免鉴权）',
    ep.applyEndpoint({ httpToken: '' }) === true && ep.httpToken === '',
    `httpToken="${ep.httpToken}"`);
  ok('applyEndpoint 只改字段，不自己重连（重连是调用方的决策：app.ts 比较后调，start() 只补 URL）',
    ep.socket === null,
    'socket 被建出来了 —— 说明 applyEndpoint 内部接了 reconnect/connect');
});

// 接线事实（文本）：能力级测试证明不了 `applyConfigPatch` 里接了它 —— S10a 的教训
// （模块级段只证明"有能力"，证明不了"接上了"）。切出函数体再扫，避免把全文里
// 别处的 applyEndpoint（start() 里那一处）算成证据。
const appSrc = stripComments(fs.readFileSync(path.join(ROOT, 'src/web/app.ts'), 'utf8'));
const patchBody = (appSrc.match(/function applyConfigPatch\(patch: unknown\) \{[\s\S]*?\n  \}/) || [''])[0];
ok('applyConfigPatch 的接线：体内同时出现 applyEndpoint 与 reconnect',
  patchBody.includes('applyEndpoint') && patchBody.includes('reconnect'),
  patchBody ? `函数体里 ${patchBody.includes('applyEndpoint') ? '有' : '没有'} applyEndpoint、` +
    `${patchBody.includes('reconnect') ? '有' : '没有'} reconnect` : '没切出 applyConfigPatch 函数体（锚点失效）');
ok('两个 URL 字段不再有直接赋值（端点只有一个写入口：applyEndpoint）',
  !/onebot\.(wsUrl|httpUrl)\s*=/.test(appSrc),
  (appSrc.match(/.*onebot\.(wsUrl|httpUrl)\s*=.*/g) || []).join(' | ') +
  ' —— 绕过 applyEndpoint 直接赋值就绕过了归一化，于是"同值"会被判成变更');

process.exit(done() ? 0 : 1);
