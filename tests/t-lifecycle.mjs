// 注册层的**执行侧**（S11）：进程关停路径、长期任务的装配清单、清单与描述表的对账。
//
// 为什么需要它：`t-tasks.mjs` 核对的是**声明**（"这个任务有启停入口"），`t-timers.mjs`
// 拿到句柄证明"停得掉"。缺的是"**谁按什么顺序把它们装起来**"——那是 `app.start()` /
// `app.stop()` 的职责，而它今天（S11c 之前）是六对硬编码调用，静默失效的方式很具体：
// 少一行、多一行、顺序颠倒，都不会有任何编译错误，只有行为变了。
//
// 分五段落地（本文件按步骤长）：
//   1. `web/runtime/shutdown.ts` 的关停编排 + `server.ts` 的信号接线（S11a）
//   2. `web/runtime/lifecycle.ts` 的清单 ⇄ `LONG_TERM_TASKS` 对账（S11c）
//   3. `app.start()` / `app.stop()` 真的走清单，且停止是逆序（S11c）
//   4. 死代码与空转事件不再回来（S11d）
//   5. electron 的 `before-quit` 真的等 `stop()`（S11e）
//
// ⚠️ 扫的是 `src/` 的**源码文本**，不是 dist：这些断言说的是"谁在调什么"，
// 与 t-ports.mjs / t-panel-wiring.mjs 同一路数。扫描前一律 `stripComments()`。
import fs from 'node:fs';
import path from 'node:path';
import { checker, dataDir } from './lib/harness.mjs';
import { ROOT, load, stripComments } from './lib/src.mjs';

dataDir('qqagent-lifecycle-');
const { ok, done } = checker();

// ── 1. 关停路径：只关停一次、重复信号强退、stop 抛错也要退（S11a）──
// `server.ts` 是带副作用的入口（import 即建 app、起服务），套件 import 不了它，
// 所以纯逻辑在 `web/runtime/shutdown.js`（这一段的**行为**断言），接线事实在文本上（后面的
// 两条）。Windows 下 SIGTERM 根本送不到子进程的处理器，行为级的信号测试不可靠。
const { createShutdown } = await load('web/runtime/shutdown.js');

const first = { stop: 0, exits: [], logs: [] };
const shutdown = createShutdown({
  stop: () => { first.stop++; },
  exit: (code) => { first.exits.push(code); },
  log: (...args) => { first.logs.push(args.join(' ')); }
});
await shutdown('SIGINT');
await shutdown('SIGINT');
await shutdown('SIGTERM');

ok('第一个信号关停一次', first.stop === 1, `stop 被调了 ${first.stop} 次`);
ok('重复信号走的是强退分支，不是再关停一遍（关停两次会把长期任务停两遍、server.close() 调两次）',
  first.stop === 1 && first.logs.filter((line) => line.includes('强制退出')).length === 2,
  `stop=${first.stop}，强退日志 ${first.logs.filter((line) => line.includes('强制退出')).length} 条`);
ok('退出码：优雅退出 0、之后每次强退 1',
  JSON.stringify(first.exits) === '[0,1,1]', `实际 ${JSON.stringify(first.exits)}`);

// stop() 挂住时，第二个信号必须**立即**强退 —— 这是逃生舱的全部意义。
// 这里故意不 await 第一次调用：它停在 `await stop()` 上，正是真实场景。
let release = null;
const hanging = { stop: 0, exits: [] };
const hangShutdown = createShutdown({
  stop: () => { hanging.stop++; return new Promise((resolve) => { release = resolve; }); },
  exit: (code) => hanging.exits.push(code),
  log: () => {}
});
void hangShutdown('SIGINT');
await hangShutdown('SIGTERM');
ok('关停还没跑完时来的信号立即强退（不等第一次跑完），且不重复关停',
  hanging.exits.length === 1 && hanging.exits[0] === 1 && hanging.stop === 1,
  `exits=${JSON.stringify(hanging.exits)} stop=${hanging.stop}`);
// 放掉挂住的那次：它会补一个 exit(0)。真实进程里 exit(1) 之后不会再有代码跑，
// 这里能看到第二个值纯粹是因为 exit 是假的 —— 所以只断言**第一个**。
release();

// stop() 抛错：老写法会变成 unhandledRejection（server.ts 那里只打日志、不退出），
// 于是进程挂住不退。
const failing = { exits: [], errors: [] };
const failShutdown = createShutdown({
  stop: () => { throw new Error('fixture: 关停失败'); },
  exit: (code) => { failing.exits.push(code); },
  log: () => {},
  onError: (error) => { failing.errors.push(error); }
});
await failShutdown('SIGTERM');
ok('stop() 抛错也要退出（交给 onError 报告，不落进 unhandledRejection）',
  failing.exits.length === 1 && failing.exits[0] === 0 && failing.errors.length === 1,
  `exits=${JSON.stringify(failing.exits)} errors=${failing.errors.length}`);

// 接线事实（文本）：两个信号、同一个幂等关停。
// 逐行扫而不是全文 includes：全文扫描放得过"再加一个自己 exit 的旁路处理器"。
const serverSrc = stripComments(fs.readFileSync(path.join(ROOT, 'src/web/server.ts'), 'utf8'));
const signalLines = serverSrc.split(/\r?\n/).filter((line) => /process\.on\(\s*'SIG[A-Z]+'/.test(line));
const signalNames = signalLines.map((line) => (line.match(/'SIG[A-Z]+'/) || [''])[0]).sort();
ok('headless 入口同时注册 SIGINT 与 SIGTERM',
  signalNames.join(',') === "'SIGINT','SIGTERM'",
  `实际注册了 ${signalNames.join(',') || '（一个都没有）'}` +
  ' —— SIGTERM 是 systemd / 容器 / taskkill 发的那个信号');
ok('每个信号都只走同一个幂等关停（没有自己 exit 的旁路处理器）',
  signalLines.length > 0 && signalLines.every((line) => line.includes('shutdown')),
  signalLines.filter((line) => !line.includes('shutdown')).join(' | ') || '（没有任何信号注册行）');

// ── 2. 装配清单与描述表对账：id 一个不多一个不少，且 import 不启动任何东西（S11c）──
// 这一段的立场与 t-tasks 的 `EXPECTED_IDS` 相同：**手工登记一份清单，然后拿现实去核对**。
// 对账必须做在这里而不是 `src/` 里：`lifecycle.ts` 不许 import `tasks.ts`（`t-tasks.mjs`
// 有一条"src/ 除定义处外无人引用 LONG_TERM_TASKS"的断言），所以两边各写一份 id 字面量，
// 由本段负责它们一致。

/**
 * 在假计时器下跑一段代码，返回它期间**建了几个计时器**。
 *
 * 比 `t-timers.mjs` 的 `withFakeTimers()` 简陋得多（那个要数活动句柄、被清句柄与 unref），
 * 这里只需要回答一个是非题："import 这个模块会不会顺手启动什么"。所以不往那边加参数——
 * 那会把"给测试凿参数"的坏习惯搬进一个已经很讲究的夹具里。
 */
async function timersCreatedDuring(fn) {
  const real = {
    setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval,
    setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout
  };
  let created = 0;
  const make = () => { created++; return { unref() { return this; } }; };
  globalThis.setInterval = make; globalThis.clearInterval = () => {};
  globalThis.setTimeout = make; globalThis.clearTimeout = () => {};
  try {
    await fn();
    return created;
  } finally {
    Object.assign(globalThis, real);
  }
}

// 先做纯度那一条：`load()` 有模块缓存，第二次 import 不会重新执行模块体，
// 所以必须在这一段里**第一次**加载它，否则测的是"已经加载过的模块再 import 一次"。
let lifecycle = null;
const createdOnImport = await timersCreatedDuring(async () => { lifecycle = await load('web/runtime/lifecycle.js'); });
const { LIFECYCLE, startLifecycle, stopLifecycle } = lifecycle;

ok('import lifecycle.js 不启动任何东西（零计时器）',
  createdOnImport === 0,
  `import 期间建了 ${createdOnImport} 个计时器 —— 清单必须是纯编排，启动只能由 app.start() 触发`);

ok('LIFECYCLE 是有序数组，每条 entry 的 start/stop 都是**函数引用**（不是名字）',
  Array.isArray(LIFECYCLE) && LIFECYCLE.length > 0
  && LIFECYCLE.every((e) => Array.isArray(e.ids) && e.ids.length > 0
    && e.ids.every((id) => typeof id === 'string' && id.length > 0)
    && typeof e.enabled === 'function' && typeof e.start === 'function' && typeof e.stop === 'function'),
  '存名字的话套件只能自己解析自己；存函数引用才谈得上"运行期直接调用"');

const { LONG_TERM_TASKS } = await load('web/runtime/tasks.js');
const manifestIds = LIFECYCLE.flatMap((e) => e.ids);
const taskIds = LONG_TERM_TASKS.map((task) => task.id);
const sameIdSet = [...manifestIds].sort().join(',') === [...taskIds].sort().join(',');
ok('清单覆盖的 id 与 LONG_TERM_TASKS 完全一致（无遗漏、无多余）',
  sameIdSet,
  `清单=[${[...manifestIds].sort().join(',')}] 描述表=[${[...taskIds].sort().join(',')}]` +
  ' —— 两边都得改才算数：往 tasks.ts 加一行而没给清单加 entry，新任务永远不会被启动');
ok('每个 id 恰好被一条 entry 覆盖（无重复）',
  new Set(manifestIds).size === manifestIds.length,
  `清单里有重复 id：[${manifestIds.filter((id, i) => manifestIds.indexOf(id) !== i).join(',')}]` +
  ' —— 重复意味着同一次 initialize 被调两遍');

// enabled 闸门与描述表的 `enabledBy` 行为等价：两条布尔任务跟着真配置翻转，
// 其余四条恒真（它们的判定在各模块内部，见 lifecycle.ts 的 ALWAYS 注释）。
const { getConfig, updateConfig } = await load('core/config.js');
const entryFor = (id) => LIFECYCLE.find((e) => e.ids.includes(id));
const restore = getConfig();
const previous = {
  proactive: restore.proactive?.enabled === true,
  compact: restore.compact?.enabled === true
};
updateConfig({ proactive: { enabled: true }, compact: { enabled: false } });
const cfgA = getConfig();
updateConfig({ proactive: { enabled: false }, compact: { enabled: true } });
const cfgB = getConfig();
ok('proactive.bubble / compact.sweep 的 enabled 跟着真配置的点分路径翻转',
  entryFor('proactive.bubble').enabled(cfgA) === true && entryFor('compact.sweep').enabled(cfgA) === false
  && entryFor('proactive.bubble').enabled(cfgB) === false && entryFor('compact.sweep').enabled(cfgB) === true,
  `proactive=${entryFor('proactive.bubble').enabled(cfgA)}/${entryFor('proactive.bubble').enabled(cfgB)} ` +
  `compact=${entryFor('compact.sweep').enabled(cfgA)}/${entryFor('compact.sweep').enabled(cfgB)}`);
const alwaysIds = ['onebot.reconnect', 'price.feed', 'jmcomic.cleanup', 'transcription.worker'];
ok('其余四条恒真（开关留在入口内部：转写入口自行校验 enabled/config，jmcomic 无配置依赖）',
  alwaysIds.every((id) => entryFor(id).enabled(cfgA) === true && entryFor(id).enabled(cfgB) === true),
  alwaysIds.filter((id) => entryFor(id).enabled(cfgA) !== true).join(',') || '（都恒真）');
updateConfig({ proactive: { enabled: previous.proactive }, compact: { enabled: previous.compact } });

// 清单不许 import 那张描述表：对账是套件的职责，不是运行期的职责。
const lifecycleSrc = stripComments(fs.readFileSync(path.join(ROOT, 'src/web/runtime/lifecycle.ts'), 'utf8'));
ok('lifecycle.ts 不 import tasks.ts（id 两边各写一份，一致性由本套件的对账负责）',
  !/tasks\.js/.test(lifecycleSrc),
  '一旦 import 了，运行期就多了一条"读表才知道装什么"的间接层，而那正是被禁的注册表形态');

// ── 3. 接线：app.start() / app.stop() 真的走清单，停止是逆序（S11c）──
// 两件事分开守，理由同 S10a：
//   • **顺序**是纯逻辑，用假 deps 逐条观察（五个 entry 全部经由 deps 调用，见 lifecycle.ts 的
//     设计说明——哪怕代价是 deps 拿的是整个 onebot 实例）；
//   • **接线**是"app 里到底调没调 startLifecycle"，模块级测试证明不了，只能扫函数体文本。

// 期望序列是**手写的**，不从 LIFECYCLE 推——从清单推等于自己验自己（t-tasks 的 EXPECTED_IDS 同理）。
const EXPECTED_ENTRY_IDS = [
  ['onebot.reconnect'],
  ['proactive.bubble'],
  ['compact.sweep'],
  ['price.feed'],
  ['jmcomic.cleanup', 'jmcomic.worker'],
  ['transcription.worker']
];
ok('清单的 entry 顺序与 id 归属（手工登记：**改这里的顺序就是改行为**）',
  JSON.stringify(LIFECYCLE.map((e) => e.ids)) === JSON.stringify(EXPECTED_ENTRY_IDS),
  `实际 ${JSON.stringify(LIFECYCLE.map((e) => e.ids))}`);
ok('手工登记的序列长度与清单一致（新增 entry 必须同步登记，否则新任务永远不会被顺序断言覆盖）',
  EXPECTED_ENTRY_IDS.length === LIFECYCLE.length,
  `清单 ${LIFECYCLE.length} 条、登记 ${EXPECTED_ENTRY_IDS.length} 条`);

const EXPECTED_START = ['onebot.connect', 'proactive.start', 'compact.start', 'priceFeed.init', 'jmcomic.init', 'transcription.start'];
const EXPECTED_STOP = ['transcription.stop', 'jmcomic.stop', 'priceFeed.stop', 'compact.stop', 'proactive.stop', 'onebot.close'];

function spyDeps(config, seq) {
  return {
    getConfig: () => config,
    onebot: { connect: () => seq.push('onebot.connect'), close: () => seq.push('onebot.close') },
    orchestrator: {
      startProactiveLoop: () => seq.push('proactive.start'),
      stopProactiveLoop: () => seq.push('proactive.stop'),
      startCompactLoop: () => seq.push('compact.start'),
      stopCompactLoop: () => seq.push('compact.stop')
    },
    sender: {},
    store: {},
    priceFeed: { init: (url) => seq.push(`priceFeed.init${url ? '' : '(空 URL)'}`), stop: () => seq.push('priceFeed.stop') },
    // 属性名必须与 `LifecycleDeps` 逐字一致。这里踩过一次：S11c 交付时写的是
    // `initialize`（真函数 `initJmcomicQueue` 的旧名 `initializeJmcomicQueue` 更容易顺手写出来），
    // 与 `LifecycleDeps.jmcomic.init` 对不上 → 运行期抛 `deps.jmcomic.init is not a function`，
    // **一个未捕获异常会中止整个套件**，本行之后的每一条断言（顺序、逆序、闸门、所有接线
    // 与无按键分发的文本扫描）一条都没跑过，而人看到的只是一个 TypeError。
    // 下面那条"spy ⇄ lifecycle.ts 结构对账"就是为这类静默中止加的：它把运行期崩溃
    // 变成一条普通的红。标号与属性名统一用 `jmcomic.init`，与 `priceFeed.init` 同形。
    jmcomic: { init: () => seq.push('jmcomic.init'), stop: () => seq.push('jmcomic.stop') },
    transcription: { start: () => seq.push('transcription.start'), stop: () => seq.push('transcription.stop') }
  };
}

// ── spy deps ⇄ lifecycle.ts 真正读的字段：**结构对账，先于行为断言** ──
//
// 为什么值得单列一条：`.mjs` 不受 `tsc` 管（`tsconfig.json` 排除 `tests/`），而 `LifecycleDeps`
// 是个纯结构接口，所以"spy 的属性名写错一个字母"**编译器永远看不见**——它在运行期表现为
// `deps.jmcomic.init is not a function`，一个未捕获异常会**中止整个套件**：本行之后的每一条
// 断言（顺序、逆序、闸门、所有接线与无按键分发的文本扫描）**一条都没跑过**，而人看到的只是
// 一个 TypeError。S11c 交付时这里就写成了 `initialize`（真函数名是 `initJmcomicQueue`，
// 顺手写错），于是那批断言当时并没有真的绿过。这条断言把这类"静默中止"变成一条普通的红。
//
// 覆盖两个方向：`deps.<a>.<b>(` 的每个方法都必须在 spy 上存在且是函数；`deps.<a>` 的每个
// 名字都必须在 spy 上有值（漏了 `sender` 这种纯值依赖同样是运行期才炸）。
const lifeSrc = stripComments(fs.readFileSync(path.join(ROOT, 'src/web/runtime/lifecycle.ts'), 'utf8'));
const spyProbe = spyDeps({}, []);
const depNames = [...new Set([...lifeSrc.matchAll(/\bdeps\.(\w+)/g)].map((m) => m[1]))].sort();
const depMethods = [...new Set([...lifeSrc.matchAll(/\bdeps\.(\w+)\.(\w+)\s*\(/g)].map((m) => `${m[1]}.${m[2]}`))].sort();
const missingNames = depNames.filter((name) => spyProbe[name] === undefined || spyProbe[name] === null);
const missingMethods = depMethods.filter((pair) => {
  const [obj, method] = pair.split('.');
  return typeof spyProbe[obj]?.[method] !== 'function';
});
ok('spy deps 与 lifecycle.ts 真正读的 `deps.*` 逐一对得上（写错属性名只会中止套件，不会报错）',
  depNames.length >= 7 && depMethods.length >= 8 && missingNames.length === 0 && missingMethods.length === 0,
  [
    depNames.length >= 7 ? '' : `只从 lifecycle.ts 扫到 ${depNames.length} 个 deps.*（锚点失效了？）`,
    depMethods.length >= 8 ? '' : `只扫到 ${depMethods.length} 个 deps.<a>.<b>( 调用（锚点失效了？）`,
    missingNames.length ? `spy 上缺这些 deps 字段：${missingNames.join('、')}` : '',
    missingMethods.length ? `spy 上缺这些方法：${missingMethods.join('、')}` : ''
  ].filter(Boolean).join('；'));

const allOn = { proactive: { enabled: true }, compact: { enabled: true }, api: { priceRemoteUrl: 'http://x/p.json' } };
const seq = [];
await startLifecycle(spyDeps(allOn, seq));
ok('startLifecycle 按清单顺序启动（connect → 冒泡 → 压缩 → 价格表 → jmcomic → 转写）',
  JSON.stringify(seq) === JSON.stringify(EXPECTED_START),
  `实际 ${JSON.stringify(seq)}`);
ok('全开时每一条 entry 都真的被调用（不是"顺序对但漏了谁"）',
  seq.length === LIFECYCLE.length, `${seq.length} 次调用 / ${LIFECYCLE.length} 条 entry`);

const seqStop = [];
await stopLifecycle(spyDeps(allOn, seqStop));
ok('stopLifecycle 按清单**逆序**拆除',
  JSON.stringify(seqStop) === JSON.stringify(EXPECTED_STOP),
  `实际 ${JSON.stringify(seqStop)} —— 正序拆除会让 onebot.close() 早于 jmcomic / 价格表`);
ok('onebot.close() 是逆序里最后一个（"停长期任务排在 onebot.close() 之前"从此是结构性质）',
  seqStop.at(-1) === 'onebot.close',
  `最后一个是 ${seqStop.at(-1)} —— 在途的 QQ 上传要靠传输层活着`);

const seqOff = [];
await startLifecycle(spyDeps({ proactive: { enabled: false }, compact: { enabled: false }, api: {} }, seqOff));
ok('闸门关着的那两条不进启动序列，恒真的四条照常',
  JSON.stringify(seqOff) === JSON.stringify(['onebot.connect', 'priceFeed.init(空 URL)', 'jmcomic.init', 'transcription.start']),
  `实际 ${JSON.stringify(seqOff)}`);

// 接线事实（文本）。函数体按 `\n  }` 收尾切：start/stop 都嵌在 createApp 里，本体缩进更深。
function sliceFn(src, header) {
  const at = src.indexOf(header);
  if (at < 0) return '';
  const open = src.indexOf('{', at);
  const end = src.indexOf('\n  }', open);
  return end < 0 ? src.slice(open) : src.slice(open, end + 4);
}
const appSrc = stripComments(fs.readFileSync(path.join(ROOT, 'src/web/app.ts'), 'utf8'));
const startBody = sliceFn(appSrc, 'async function start()');
const stopBody = sliceFn(appSrc, 'async function stop()');
const depsBody = sliceFn(appSrc, 'function lifecycleDeps()');
const HAND_WIRED = /(initJmcomicQueue|stopJmcomicQueue|startProactiveLoop|stopProactiveLoop|startCompactLoop|stopCompactLoop|initPriceFeed|stopPriceFeed)\(/;

ok('app.start() 走的是清单（体内出现 startLifecycle），且不再硬编码任何一个任务入口',
  startBody.includes('startLifecycle(') && !HAND_WIRED.test(startBody),
  startBody.includes('startLifecycle(') ? 'start() 里还有硬编码的任务调用：' + (startBody.match(HAND_WIRED) || [''])[0] : 'start() 里没有 startLifecycle(');
ok('app.stop() 走的是清单（体内出现 stopLifecycle），且不再硬编码任何一个任务入口',
  stopBody.includes('stopLifecycle(') && !HAND_WIRED.test(stopBody),
  stopBody.includes('stopLifecycle(') ? 'stop() 里还有硬编码的任务调用：' + (stopBody.match(HAND_WIRED) || [''])[0] : 'stop() 里没有 stopLifecycle(');
// `app.ts` 递进去的函数名**从描述表里取**，不写死：这样它钉住的是"app.ts 与 tasks.ts 对同一批
// 入口用同一个名字"，而不是"app.ts 里有这几个字面量"。写死的话，一次改名（比如
// `initializeJmcomicQueue` → `initJmcomicQueue`）只改一头，这条断言自己也得跟着改，
// 而它本来该负责把这种不一致指出来。结构性名字（`getConfig`/`onebot`/`orchestrator`/`sender`/`store`）
// 不在任务表里，照旧写死。
const moduleEntryNames = (owner) => LONG_TERM_TASKS
  .filter((t) => t.owner.endsWith(`${owner}.ts`))
  .flatMap((t) => [t.start?.name, t.stop?.name])
  .filter((name) => typeof name === 'string');
const DEPS_NAMES = [
  ...moduleEntryNames('price-feed'),
  ...moduleEntryNames('jmcomic'),
  'getConfig', 'onebot', 'orchestrator', 'transcription'
];
const missingDeps = [...new Set(DEPS_NAMES)].filter((name) => !new RegExp(`\\b${name}\\b`).test(depsBody));
ok('deps 里递的是真模块，且用的是描述表里的名字（假 deps 的模块级测试证明不了这一点）',
  DEPS_NAMES.length >= 7 && missingDeps.length === 0,
  [
    DEPS_NAMES.length >= 7 ? '' : `只从 LONG_TERM_TASKS 推出 ${DEPS_NAMES.length} 个入口名（owner 锚点失效了？）`,
    missingDeps.length ? `lifecycleDeps() 的实参里少了：${missingDeps.join(' / ')}` : ''
  ].filter(Boolean).join('；'));

// 清单 vs 被禁的注册表：这是两者之间**唯一**的机检边界。
const srcFiles = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.ts$/.test(entry.name)) srcFiles.push(full);
  }
})(path.join(ROOT, 'src'));
const lifeLines = [];
const helperLines = [];
for (const file of srcFiles) {
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  for (const [i, line] of stripComments(fs.readFileSync(file, 'utf8')).split(/\r?\n/).entries()) {
    if (line.includes('LIFECYCLE')) lifeLines.push({ rel, line });
    if (/\b(startLifecycle|stopLifecycle)\b/.test(line)) helperLines.push(rel);
  }
}
ok('`LIFECYCLE` 只在 lifecycle.ts 里被提到（app.ts 只经 startLifecycle/stopLifecycle 触达，不点表名）',
  new Set(lifeLines.map((hit) => hit.rel)).size === 1 && lifeLines[0]?.rel === 'src/web/runtime/lifecycle.ts',
  `出现在 [${[...new Set(lifeLines.map((hit) => hit.rel))].sort().join(', ')}]`);
ok('没有按键分发：不存在 `LIFECYCLE[动态键]` / `.find(` / `.filter(` / `.get(`',
  lifeLines.every((hit) => !/LIFECYCLE\s*\[/.test(hit.line)
    && !/LIFECYCLE[^\n]*\.\s*(find|filter|get)\s*\(/.test(hit.line)),
  lifeLines.filter((hit) => /LIFECYCLE\s*\[/.test(hit.line) || /LIFECYCLE[^\n]*\.\s*(find|filter|get)\s*\(/.test(hit.line))
    .map((hit) => `${hit.rel}: ${hit.line.trim()}`).join(' | '));
ok('遍历函数只在定义处与 app.ts 出现（新增调用点必须是有意动作）',
  [...new Set(helperLines)].sort().join(',') === 'src/web/app.ts,src/web/runtime/lifecycle.ts',
  `出现在 [${[...new Set(helperLines)].sort().join(', ')}]`);

// ═══ 4. 死代码与空转事件收口（S11d）═══
//
// 这一节盯的三样东西有一个共同点：**删掉它们不会有任何行为差异**。所以
// **没有任何一条行为断言能守住它们**——删早了、加回来了，跑全套件都是绿的。
//
//   • `scheduleConfigSave` / `saveTimers`：零调用者。它唯一的"出现"是文档清单里的
//     一行注释（`t-tasks.mjs` 的 `LOCALTIMER_ONLY_FILES`），而那条注释随之删掉了。
//   • `AgentEventMap` / `AgentPhase`：被 `AppEventMap` 取代后留下的空壳，全仓无引用。
//   • `vision-scan` 事件：5 个发射点、**零消费者**。面板的扫描状态读的是 HTTP ——
//     `/api/vision/results` 的 `visionData.scanning`，不是事件。
//
// 没有行为断言 ⇒ 它们能静默长回来。这正是本节存在的唯一理由。
//
// 反过来，本节**不能**写成"grep 这几个词"的粗暴版本，有个真实的坑：
// `web/routes/providers.ts` 里那个 `const visionScan = { running: false }` 是**活的**——
// `/api/vision/results` 的 `scanning` 标志读它、`/api/vision/scan` 用它做并发闸门，
// UI 侧 `ui/js/views/settings/index.js` 消费那个标志。所以下面扫的是 `EVENTS.visionScan`
// 与字面事件名，**不是**标识符 `visionScan`；另有一条**正向**断言钉住那个本地对象还在，
// 防的正是"照着 grep 结果一把删干净"。
//
// 文本一律先 `stripComments()`：`core/events.ts` 的注释里就写着 `AgentEventMap`
// （那是把它当反面教材讲），不剥注释会让这道断言打红自己的文档。
const srcText = new Map();
for (const file of srcFiles) {
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  srcText.set(rel, stripComments(fs.readFileSync(file, 'utf8')));
}
const filesMatching = (re) => [...srcText.entries()].filter(([, text]) => re.test(text)).map(([rel]) => rel);

const DEAD_SYMBOLS = [
  ['scheduleConfigSave', /\bscheduleConfigSave\b/],
  ['saveTimers', /\bsaveTimers\b/],
  ['AgentEventMap', /\bAgentEventMap\b/],
  ['AgentPhase', /\bAgentPhase\b/],
  ['VisionScanPayload', /\bVisionScanPayload\b/],
  ['EVENTS.visionScan', /EVENTS\.visionScan\b/],
  ["字面事件名 'vision-scan'", /['"]vision-scan['"]/]
];
const revived = DEAD_SYMBOLS
  .map(([name, re]) => ({ name, files: filesMatching(re) }))
  .filter((hit) => hit.files.length > 0);
ok('S11d 删掉的死符号与空转事件在 src/ 已绝迹（词表、载荷、发射点、依赖项一处不剩）',
  revived.length === 0,
  revived.map((hit) => `${hit.name} 又出现在 ${hit.files.join('、')}`).join('；'));

// `core/config.ts` 从 S11d 起是**纯同步**模块。这条比"没有 scheduleConfigSave"更强：
// 它就是"把 scheduleConfigSave 加回来"这个证伪探针的直接靶子——只要有人重新引入任何计时器，它红。
ok('core/config.ts 里没有任何计时器（它是纯同步模块，防抖保存已删）',
  !/set(?:Interval|Timeout)\(/.test(srcText.get('src/core/config.ts') ?? ''),
  'config.ts 里出现了 setTimeout/setInterval → 那是被删掉的 scheduleConfigSave 或其变体回来了');

// 注入点：`emit` 是一个整体概念，所以断言"这个文件里再也没有 emit"，比逐个点更耐改。
// 三个文件今天都真的零 `emit`（实测），所以用 `\bemit\b` 不会误伤。
const NO_EMIT_FILES = [
  'src/llm/vision-scan.ts',              // 两个发射点 + `emit?` 参数
  'src/web/routes/providers.ts',         // 三条发射点 + `emit:` 传参
  'src/agent/maintenance/memory-consolidator.ts'  // 声明了却从未使用的 `emit: AppEmit` 依赖
];
const stillEmitting = NO_EMIT_FILES.filter((rel) => /\bemit\b/.test(srcText.get(rel) ?? ''));
ok('S11d 摘掉的三个 emit 点再无残留（vision-scan.ts / providers.ts / memory-consolidator.ts）',
  stillEmitting.length === 0,
  `${stillEmitting.join('、')} 里仍有 emit → 单独摘一个发射点不会有任何报错，靠这条守`);

// `new MemoryConsolidator({…})` 的实参：照 `t-ports.mjs` 第 1c 段的手法解析实参对象。
// 为什么不用"全文扫 `emit`"：那样只看得到"这个文件里还有没有 emit"，看不到它挂在**哪个**依赖
// 上——`emit` 加回 `Orchestrator` 自己身上（那里是合法的必填依赖）不该打红这一条。
function argObjectOf(src, open) {
  let depth = 0;
  let quote = '';
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return src.slice(open, i + 1);
  }
  return '';
}
const orcText = srcText.get('src/agent/runtime/orchestrator.ts') ?? '';
const consolidatorArg = orcText.match(/new MemoryConsolidator\(\s*\{/)
  ? argObjectOf(orcText, orcText.search(/new MemoryConsolidator\(\s*\{/) + orcText.match(/new MemoryConsolidator\(\s*\{/)[0].length - 1)
  : '';
ok('orchestrator 构造 MemoryConsolidator 时不再传 emit（它声明了却从未用过）',
  consolidatorArg !== '' && !/\bemit\s*:/.test(consolidatorArg),
  consolidatorArg === '' ? 'orchestrator.ts 里找不到 new MemoryConsolidator({…})' : `实参里还有 emit：${consolidatorArg.replace(/\s+/g, ' ').slice(0, 120)}`);

// **正向**断言：那个本地对象是活的，别跟着事件一起删。删了 `/api/vision/results` 的
// `scanning` 会永远停在初始值，而**没有任何断言会红**（HTTP 层没有覆盖这个字段的用例）。
// 实测（剥离注释后）它在 providers.ts 里出现 4 次：/results 读、/scan 闸门读、启动写、finally 写。
const providersText = srcText.get('src/web/routes/providers.ts') ?? '';
ok('/api/vision/scan 的并发闸门仍是最初那个本地对象（S11d 删的是事件，不是它）',
  /const\s+visionScan\s*=\s*\{\s*running:\s*false\s*\}/.test(providersText)
  && (providersText.match(/visionScan\.running/g) ?? []).length >= 4,
  `声明在？${/const\s+visionScan\s*=/.test(providersText)}；使用 ${(providersText.match(/visionScan\.running/g) ?? []).length} 处（应 ≥4）`);

// ═══ 5. electron 的 before-quit 真的等 stop()（S11e）═══
//
// `electron/main.js` 是带副作用的入口（import 即抢单实例锁、建窗口、装托盘），在 Node
// 里 import 不了，所以只能扫源码文本——与 §1 对 `server.ts` 的做法同一路数。
//
// 这一段盯的不是风格，而是**会把进程挂住或直接切断的两件事**：
//   • S11e 之前这里是 `try { core?.stop(); } catch {}`——同步、不 await，Electron 不等
//     它就开始拆窗口与进程，关停半路夭折（在途的 QQ 上传、内存里的整理结果被切断）。
//   • 改成 `preventDefault()` 拦住退出之后，**"等完自己再退一次"就成了停不下来的那一半**：
//     不调 `app.quit()`，应用会永远停在那里不退。而这条路径没有任何套件跑得起来
//     （要真起 Electron），所以只有文本断言能守。
//   • 第二次 `app.quit()` 会再次进这个处理器，缺 `stopping` 守卫就会 `preventDefault`
//     拦下自己 → 死循环。同样只有文本看得见。
const electronText = stripComments(fs.readFileSync(path.join(ROOT, 'electron/main.js'), 'utf8'));
const bqAt = electronText.indexOf("app.on('before-quit'");
const bqBody = bqAt < 0 ? '' : argObjectOf(electronText, electronText.indexOf('{', bqAt));
const at = (needle) => bqBody.indexOf(needle);
const noBody = 'electron/main.js 里找不到 app.on(\'before-quit\', …) 的函数体';

ok('electron 的 before-quit 处理器找得到，且会拦下这次退出（不 preventDefault 就等于没等）',
  bqBody !== '' && at('event.preventDefault(') >= 0,
  bqBody === '' ? noBody : '体内没有 event.preventDefault( → Electron 照旧立刻拆进程');

ok('quitting 在拦截之前置位（退出期间关窗不能缩托盘，否则退出被挂住）',
  bqBody !== '' && at('quitting = true') >= 0 && at('quitting = true') < at('event.preventDefault('),
  bqBody === '' ? noBody : `quitting = true 在 ${at('quitting = true')}、preventDefault 在 ${at('event.preventDefault(')}（前者必须在前）`);

ok('第二次进入 before-quit 直接放行（缺这条守卫会 preventDefault 拦下自己 → 死循环）',
  /if\s*\(\s*stopping\s*\)\s*return\s*;/.test(bqBody) && bqBody.search(/if\s*\(\s*stopping\s*\)\s*return\s*;/) < at('event.preventDefault('),
  bqBody === '' ? noBody : '没有 `if (stopping) return;`（或它排在 preventDefault 之后）');

ok('关停走 promise 链（同步抛错也逃不出这个处理器）',
  at('Promise.resolve(') >= 0 && at('core.stop()') >= 0,
  bqBody === '' ? noBody : `Promise.resolve( 在 ${at('Promise.resolve(')}、core.stop() 在 ${at('core.stop()')}`);

ok('关停抛错时只记日志、不阻断退出（.catch 存在）',
  at('.catch(') >= 0,
  bqBody === '' ? noBody : '没有 .catch( → stop() 抛错会变成 unhandled rejection');

const finallyAt = at('.finally(');
ok('等完 stop() 之后自己再 quit 一次（否则应用会永远停在那里不退）',
  finallyAt >= 0 && bqBody.indexOf('app.quit()', finallyAt) >= 0,
  bqBody === '' ? noBody : `.finally( 在 ${finallyAt}、其后 ${bqBody.indexOf('app.quit()', finallyAt) >= 0 ? '有' : '没有'} app.quit()`);

process.exit(done() ? 0 : 1);
