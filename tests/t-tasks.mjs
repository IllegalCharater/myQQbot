// 长期任务描述符表（S9）：`src/web/tasks.ts` 的 `LONG_TERM_TASKS`。
//
// 这张表的价值全在"它说的和现实是不是一回事"。所以本套件不检查表自身的形状，而是拿表里的
// 每一条声明**去现实里核对**：
//   1. 6 行齐全，id 集合固定（手工登记，同 t-ports 的 PORT_METHODS 模式）；
//   2. 每行 owner 文件真实存在，且里面确实有调度调用（防"表里躺着一个不存在的任务"）；
//   3. **[反向] 局部计时器不在表内** —— 这是设计稿 §6.1 分界线的守护，也是本套件最重要的一段：
//      最容易犯的错就是把 LLM 超时、重试退避、单次扫图 flush 这些也算成"长期任务"收进表，
//      那样表就从"清点"退化成"什么都往里塞"；
//   4. 开关路径能在真实配置里取到值，且类型与声明相符；
//   5. `conformance` 与启停入口的实际能力相符（含三条实名断言：有没有 `stopPriceFeed`、
//      有没有 `stopJmcomicQueue`、onebot 的重连句柄有没有存 —— 设计稿 §9.3 点名的例子，
//      S10+ 每收下一个任务就翻成正向，而不是把断言删掉）；
//   6. 表里写的启停入口名字，能在真对象/真模块上解析到；
//   7. 表是**纯数据**：`tasks.ts` 自身不调度、不启动任何东西，`src/` 里也没人拿它做分发。
import fs from 'node:fs';
import path from 'node:path';
import { checker, dataDir } from './lib/harness.mjs';
import { ROOT, load, stripComments } from './lib/src.mjs';

dataDir('qqagent-tasks-');
const { ok, done } = checker();

const { LONG_TERM_TASKS } = await load('web/tasks.js');
const { getConfig } = await load('core/config.js');

// 手工登记的 id 清单。表里加一个任务是个**有意的动作**，必须同步登记到这里。
const EXPECTED_IDS = [
  'proactive.bubble', 'compact.sweep', 'price.feed',
  'jmcomic.cleanup', 'jmcomic.worker', 'onebot.reconnect'
];

// 只含局部计时器的文件（附录 B 里那 17 处的宿主）。它们**不许**作为任何一行的 owner——
// 这是"局部计时器不在表内"的可机检形态。
const LOCALTIMER_ONLY_FILES = [
  'src/core/util.ts',                     // delay() 助手
  'src/core/config.ts',                   // scheduleConfigSave（死代码，附录 C）
  'src/llm/llm.ts',                       // 重试退避 / 请求超时
  'src/llm/providers.ts',                 // 供应商请求超时 ×2
  'src/llm/vision-scan.ts',               // 扫图进度 flush（每 2s）
  'src/media/safe-fetch.ts',              // DNS 解析超时
  'src/web/app.ts',                       // socket 超时 / 启动期端口轮询
  'src/web/routes/chats.ts',              // getChatName 3s 兜底
  'src/agent/runtime/wake-scheduler.ts',  // 唤醒防抖 / 等待窗口 / 限速等待
  'electron/main.js'                      // 窗口加载前 2s 延时
];

const ids = LONG_TERM_TASKS.map((t) => t.id).sort();
ok('任务表恰好是这 6 个 id（不多不少）',
  ids.length === EXPECTED_IDS.length && ids.every((id, i) => id === [...EXPECTED_IDS].sort()[i]),
  `表里是 ${ids.join('、')}；清单是 ${[...EXPECTED_IDS].sort().join('、')}`);

ok('每行都写了 label 与 note（这张表的价值就在 note 说清了"为什么只能是这个 conformance"）',
  LONG_TERM_TASKS.every((t) => (t.label ?? '').length > 0 && (t.note ?? '').length > 0),
  LONG_TERM_TASKS.filter((t) => !(t.label ?? '').length || !(t.note ?? '').length).map((t) => t.id).join('、'));

// ── 2. owner 文件必须真实存在且真的在调度 ──
// 只看"文件存在"不够：那样删掉 timer 只留文件也能绿。要求文件里至少有一处
// `setInterval(` / `setTimeout(`（排除 `ReturnType<typeof setTimeout>` 这类纯类型行）。
const schedulesIn = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
  .split(/\r?\n/)
  .filter((line) => /set(?:Interval|Timeout)\(/.test(line) && !/ReturnType<typeof setTimeout>/.test(line))
  .length;

const ownerProblems = LONG_TERM_TASKS.filter((t) =>
  !fs.existsSync(path.join(ROOT, t.owner)) || schedulesIn(t.owner) === 0);
ok('每行的 owner 文件都存在，且文件里确实有调度调用',
  ownerProblems.length === 0,
  ownerProblems.map((t) => `${t.id} → ${t.owner}${
    fs.existsSync(path.join(ROOT, t.owner)) ? '（文件在，但没有任何 setInterval/setTimeout 调用）' : '（文件不存在）'}`).join('；'));

// ── 3. 反向断言：局部计时器不在表内 ──
// 两个方向：① 设计稿点名排除的 `wake.debounce` 不在；② 纯局部计时器的宿主文件不是任何一行的 owner。
const ownerSet = new Set(LONG_TERM_TASKS.map((t) => t.owner));
const wakeIds = ids.filter((id) => /^wake\./.test(id));
const strayOwners = LOCALTIMER_ONLY_FILES.filter((f) => ownerSet.has(f));
ok('局部计时器不在表内（没有 wake.* 的 id，纯局部计时器的宿主也不作为 owner）',
  wakeIds.length === 0 && strayOwners.length === 0,
  [
    wakeIds.length ? `表里出现了唤醒防抖这类局部计时器的 id：${wakeIds.join('、')}（它是每会话的防抖，按 §6.1 分界线属于局部计时器）` : '',
    strayOwners.length ? `这些文件只含局部计时器，却成了任务 owner：${strayOwners.join('、')}` : ''
  ].filter(Boolean).join('；'));

// ── 4. 开关路径要能在真实配置里取到，且类型与声明相符 ──
const cfg = getConfig();
const resolvePath = (p) => p.split('.').reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), cfg);
const badEnable = LONG_TERM_TASKS.filter((t) => {
  if (!t.enabledBy) return false;
  const v = resolvePath(t.enabledBy.path);
  if (v === undefined) return true;
  return t.enabledBy.kind === 'boolean' ? typeof v !== 'boolean' : typeof v !== 'string';
});
ok('每行的 enabledBy 路径在真实配置里存在，且类型符合声明的 kind',
  badEnable.length === 0,
  badEnable.map((t) => `${t.id} → ${t.enabledBy.path}（${t.enabledBy.kind}）`).join('、'));

// ── 5. conformance 与实际能力相符 ──
// 规则见 tasks.ts 顶部的注释。`partial` 有两种成因：没有 stop，或 stop 在但取消不掉等待中的那一次。
const conformanceProblems = LONG_TERM_TASKS.filter((t) => {
  if (t.conformance === 'full') return !(t.start && t.stop && t.stopCancelsPending);
  if (t.conformance === 'partial') return !((t.start && !t.stop) || (t.stop && !t.stopCancelsPending));
  return Boolean(t.start);  // none ⇒ 连 start 都没有
});
ok('conformance 与启停入口相符（full 齐全 / partial 缺一样 / none 连入口都没有）',
  conformanceProblems.length === 0,
  conformanceProblems.map((t) => `${t.id} 标着 ${t.conformance}，但 start=${t.start ? '有' : '无'}、stop=${t.stop ? '有' : '无'}、stopCancelsPending=${t.stopCancelsPending}`).join('；'));

// 两条实名断言：设计稿 §9.3 点名的例子。**双向的**——S10+ 每收下一个任务就翻成正向。
// 之所以留成独立的实名断言（而不是并进第 6 段）：第 6 段只检查"表里写了的名字能解析到"，
// 把表里那一行的 stop 删掉它就跟着不查了；这两条不问表，直接钉住**能力本身在不在**。
const priceFeed = await load('llm/price-feed.js');
const jmcomic = await load('media/jmcomic.js');
ok('price.feed 标 full 是真的：price-feed 有 stopPriceFeed 导出（S10a 接管）',
  typeof priceFeed.stopPriceFeed === 'function',
  '导出被删掉的话表里的 full 就是谎话 → app.stop() 接线也会跟着断');
ok('两个 jmcomic 任务已能接管：jmcomic 有 initializeJmcomicQueue / stopJmcomicQueue 导出（S10b）',
  typeof jmcomic.initializeJmcomicQueue === 'function' && typeof jmcomic.stopJmcomicQueue === 'function',
  'stopJmcomicQueue 被删掉的话表里的 full/partial 就是谎话 → app.stop() 接线也会跟着断');

// 第三条实名断言（S10c）：`onebot.reconnect` 标 full 的**能力**是"重连定时器的句柄被存下来了"。
// 这一条只能靠文本扫描：句柄是私有的（`#reconnectTimer`），对象外面看不见；
// 而 `t-timers.mjs` 第 4 段虽然真验了"用同一个句柄取消得掉"，却验不了
// "别处又长出一处裸 setTimeout" —— 那一处的排定没有任何人能取消，full 会静默退化成 partial。
const onebotSrc = stripComments(fs.readFileSync(path.join(ROOT, 'src/qq/onebot.ts'), 'utf8'));
const reconnectSchedules = onebotSrc.split(/\r?\n/)
  .filter((line) => /setTimeout\(/.test(line) && !/ReturnType<typeof setTimeout>/.test(line));
ok('onebot 的重连调度只有一处，且句柄被存进 #reconnectTimer（S10c 接管）',
  reconnectSchedules.length === 1 && onebotSrc.includes('#reconnectTimer = setTimeout'),
  `找到 ${reconnectSchedules.length} 处 setTimeout 调度` +
  ' —— 再长出第二处裸 setTimeout 的话它排定的重连没人取消得掉，close() 就重新变成 partial');

// ── 6. 表里写的入口名字，在真对象/真模块上解析得到 ──
// 用原型而不是构造函数：给 `Orchestrator` 造实例会牵动它整棵依赖树（历史上还会顺带
// 拉起 jmcomic 队列），而这里要验的只是"名字存在"。造实例去验名字，等于用副作用验副作用。
// （S10b 已经把 jmcomic 队列移出构造函数，但"用原型"这条仍然成立：本段不需要实例。）
const { Orchestrator } = await load('agent/runtime/orchestrator.js');
const { OneBotClient } = await load('qq/onebot.js');
const RESOLVERS = {
  Orchestrator: () => Orchestrator.prototype,
  OneBotClient: () => OneBotClient.prototype,
  'price-feed': () => priceFeed,
  jmcomic: () => jmcomic
};
const unresolved = [];
for (const t of LONG_TERM_TASKS) {
  for (const [which, entry] of [['start', t.start], ['stop', t.stop]]) {
    if (!entry) continue;
    if (!RESOLVERS[entry.on]) { unresolved.push(`${t.id}.${which}: 未知的 on=${entry.on}`); continue; }
    if (typeof RESOLVERS[entry.on]()[entry.name] !== 'function') {
      unresolved.push(`${t.id}.${which}: ${entry.on}.${entry.name} 不是函数`);
    }
  }
}
ok('表里写的每个启停入口都能在真对象/真模块上解析到',
  unresolved.length === 0,
  unresolved.join('；'));

// ── 7. 表是纯数据 ──
// 两条：① 表自己不调度、不启动任何东西（否则"import 一张表"就成了新的副作用源）；
//        ② `src/` 里除定义处外没有任何文件引用它（否则它开始参与运行时逻辑了）。
// 两处都**剥掉注释再扫**：这张表的注释里就要写"绝不包装 setTimeout / setInterval 全局"
// 这类反模式说明，不剥的话注释本身会把断言打红（`stripComments` 的注释里记了同类误报）。
const tasksSrc = stripComments(fs.readFileSync(path.join(ROOT, 'src/web/tasks.ts'), 'utf8'));
const starters = [
  ['setInterval(', /setInterval\(/], ['setTimeout(', /setTimeout\(/],
  ['initPriceFeed(', /initPriceFeed\(/], ['initializeJmcomicQueue(', /initializeJmcomicQueue\(/]
].filter(([, re]) => re.test(tasksSrc)).map(([label]) => label);
ok('tasks.ts 自身是纯数据：不调度、也不启动任何任务',
  starters.length === 0,
  `里出现了 ${starters.join('、')} → 表一旦自己启动东西，import 它就变成新的副作用源`);

const SRC = path.join(ROOT, 'src');
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}
const referenced = walk(SRC)
  .map((f) => path.relative(SRC, f).split(path.sep).join('/'))
  .filter((f) => f !== 'web/tasks.ts')
  .filter((f) => stripComments(fs.readFileSync(path.join(SRC, f), 'utf8')).includes('LONG_TERM_TASKS'));
ok('除定义处外 src/ 没有任何文件引用 LONG_TERM_TASKS（它只作文档与测试引用）',
  referenced.length === 0,
  `${referenced.join('、')} → 表一旦参与分发，就变成了路线图禁止的字符串式注册表`);

process.exit(done() ? 0 : 1);
