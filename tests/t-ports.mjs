// Orchestrator 的跨模块端口（S8）：`web/` 与 Electron 只依赖 `AgentControlPort`，不依赖具体类。
//
// 为什么这套件必须存在，而不是"类型都写了，编译器管得住"：
//   - `implements AgentControlPort` 是**唯一**把类和端口绑在一起的东西，而
//     **删掉它不报任何错**——`web/types.ts` 那边照样通过（真的 Orchestrator 结构上
//     仍然满足接口），端口就这样静默退化成一份没人校验的注释。实证见 §9.5 第 12 项
//     的证伪 E-正。第 1 段用文本扫描钉住这一行。
//   - "端口里躺着 web 根本不用、或 web 在用却没写进端口"编译器只管得住一半
//     （用非端口成员 → 报错；端口里有死成员 → 不报错）。第 2 段两边对账，把死成员
//     和"把 agent 内部方法（scheduleWake / wake）塞进端口"一起挡掉。
//   - S10d 删掉 Orchestrator 的兜底事件总线之后，`emit` 成了必填依赖。`src/` 侧由
//     `tsc` 拦，`tests/` 侧（`.mjs` 不在 tsconfig 里）只能靠第 1c 段的文本扫描。
//
// ⚠️ 扫的是 `src/web/` 与 `electron/` 的**源码文本**，不是 dist——这条不变量说的是
// "谁在调什么"，是接线事实，和 t-panel-wiring.mjs 的跨边界比对同一路数（那边比的是
// UI 订阅的事件名，这边比的是 web 调用的方法名）。
import fs from 'node:fs';
import path from 'node:path';
import { checker, dataDir } from './lib/harness.mjs';
import { ROOT, load, stripComments } from './lib/src.mjs';

dataDir('qqagent-ports-');
const { ok, done } = checker();

// 端口的成员清单。**手工登记是有意的**：端口是"允许被跨模块调到的东西"的正面约定，
// 集合本身就是它的内容。往端口加成员时同步加到这里（这是个有意的动作，不是噪音）。
const PORT_METHODS = [
  'onIncoming', 'forceWake', 'markChatSeen', 'chatState', 'reloadWindow', 'drainBacklogAfterResume',
  'compactChat', 'consolidateMemoryForChat', 'getChatName',
  'startProactiveLoop', 'stopProactiveLoop', 'startCompactLoop', 'stopCompactLoop',
  'setPaused', 'abortAll', 'statusSummary'
];
const PORT_STATE = ['paused', 'pauseReason', 'compacting', 'consolidating'];
const PORT_ALL = [...PORT_METHODS, ...PORT_STATE].sort();

// ── 1. 类声明上必须挂着 implements（删掉不报错，只能靠文本守）──
const orcSrc = fs.readFileSync(path.join(ROOT, 'src/agent/runtime/orchestrator.ts'), 'utf8');
ok('Orchestrator 的声明行带 implements AgentControlPort',
  /export class Orchestrator implements AgentControlPort\b/.test(orcSrc),
  '删掉 implements 不会报任何错，端口会静默退化成一份没人校验的注释 → 加回去');

// ── 1b. 上面那份清单是从接口**手工转写**的，必须核对回去 ──
// 没有这一段的话，"往端口加一个 web 根本不用、也没人实现的成员"会**全绿地溜过去**
// （实证见 §9.5 第 12 项证伪 B：接口 + 名录 + 实现三处都补齐，`tsc` 与整套 t-ports
// 都绿）。清单本身是"允许被跨模块调到的东西"的正面约定，它必须等于接口的实际成员。
const portSrc = fs.readFileSync(path.join(ROOT, 'src/agent/runtime/control-port.ts'), 'utf8');
const ifaceBody = portSrc.match(/export interface AgentControlPort \{([\s\S]*?)\r?\n\}/)?.[1] ?? '';
const ifaceMethods = [];
const ifaceState = [];
for (const raw of ifaceBody.split(/\r?\n/)) {
  // 只认**成员行**：两空格缩进。四空格的是多行签名的续行（如
  // `consolidateMemoryForChat(` 下面的 `options?: …`），会被误读成成员名。
  if (!/^ {2}\S/.test(raw)) continue;
  const line = raw.replace(/\/\/.*$/, '').trim();
  let m;
  if ((m = line.match(/^readonly\s+([A-Za-z_$][\w$]*)\s*:/))) ifaceState.push(m[1]);
  else if ((m = line.match(/^([A-Za-z_$][\w$]*)\??\s*[(:]/))) ifaceMethods.push(m[1]);
}
const diffSets = (iface, list) => {
  const onlyIface = iface.filter((n) => !list.includes(n));
  const onlyList = list.filter((n) => !iface.includes(n));
  return [
    onlyIface.length ? `接口有、清单没有：${onlyIface.join('、')}` : '',
    onlyList.length ? `清单有、接口没有：${onlyList.join('、')}` : ''
  ].filter(Boolean).join('；');
};
ok('接口里声明的方法与下面这份清单完全一致（新增成员是个有意的动作，必须同步登记）',
  ifaceMethods.length === PORT_METHODS.length && diffSets(ifaceMethods, PORT_METHODS) === '',
  `解析出 ${ifaceMethods.length} 个方法：${ifaceMethods.join('、')}${diffSets(ifaceMethods, PORT_METHODS) ? `；${diffSets(ifaceMethods, PORT_METHODS)}` : ''}`);
ok('接口里声明的只读状态字段与清单完全一致',
  ifaceState.length === PORT_STATE.length && diffSets(ifaceState, PORT_STATE) === '',
  `解析出 ${ifaceState.length} 个状态字段：${ifaceState.join('、')}${diffSets(ifaceState, PORT_STATE) ? `；${diffSets(ifaceState, PORT_STATE)}` : ''}`);

// ── 1c. S10d：Orchestrator 不再兜底建事件总线，`emit` 在全仓都是必填 ──
// 删除兜底（`typeof emit === 'function' ? emit : createEventBus().emit`）本身谁都不报错，
// 它只是把"忘了传"的后果从**静默拿到一条空总线**变成**静默拿到 undefined**（调用时才炸）。
// 所以这里有两条断言，缺一不可：
//   ① 源码文本：`orchestrator.ts` 不再引用 `createEventBus`（总线本体仍在 `core/util.ts`，
//      `app.ts` 照旧用它 —— 路线图明令不替换总线，S10d 删的只是这一处兜底）。
//   ② 扫 `tests/`：**每一个** `new Orchestrator(` 的实参对象里都得有 `emit`。
//      `tsconfig.json` 把 `tests/` 排除在外，`.mjs` 永远不受 `tsc` 管，而实测 8 个漏传点里
//      只有 1 个（t-panel，它真走到 emit）会当场变红 —— 另外 7 个是纯静默失效。
//      `src/` 侧不用扫：`OrchestratorDependencies.emit` 是必填，漏了直接编译不过。
const orcNoFallback = !stripComments(orcSrc).includes('createEventBus');
ok('orchestrator.ts 不再引用 createEventBus（S10d 删掉了兜底总线）',
  orcNoFallback,
  '兜底一回来，"忘了传 emit"的调用点就又能静默拿到一条只有自己的空总线 → 删掉它');

// 逐个 `new Orchestrator(` 取它的实参对象：从实参的 `{` 起做花括号配对（跳过字符串字面量，
// 因为对象里有 `'测试群'` 这类文本，虽然今天没带花括号，但别让断言依赖这个巧合）。
// 锚点是 `new Orchestrator(\s*{` —— 每个真实调用点都直接传对象字面量，而本文件里那几处
// 提到这几个字的**字符串**（`indexOf('new Orchestrator(')`、断言标签）后面跟的不是 `{`，
// 于是自然不会把自己算进去（第一版用裸的 indexOf 扫，t-ports.mjs 自己报了 3 处假阳性）。
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
const TESTS = path.join(ROOT, 'tests');
const orchestratorSites = [];
for (const f of fs.readdirSync(TESTS).filter((n) => n.endsWith('.mjs'))) {
  const src = stripComments(fs.readFileSync(path.join(TESTS, f), 'utf8'));
  for (const m of src.matchAll(/new Orchestrator\(\s*\{/g)) {
    orchestratorSites.push({ file: f, args: argObjectOf(src, m.index + m[0].length - 1) });
  }
}
const sitesWithoutEmit = orchestratorSites.filter((s) => !/\bemit\s*:/.test(s.args));
ok('tests/ 里每个 new Orchestrator(...) 都传了 emit（.mjs 不受 tsc 管，只能文本扫）',
  orchestratorSites.length >= 8 && sitesWithoutEmit.length === 0,
  `扫到 ${orchestratorSites.length} 处，其中没传 emit 的：${sitesWithoutEmit.map((s) => s.file).join('、') || '无'} → 补上 emit: () => {}（本套件的用例不验事件）`);

// ── 2. 端口成员 ⇄ 跨模块实际调用，两个方向都要对得上 ──
// 正向（web 调了端口没有的）编译器已经拦住了；这里补的是反向——端口里的死成员，
// 以及"把 agent 内部方法也写进端口"这种把端口做成第二个类定义的做法。
const SCAN_DIRS = [path.join(ROOT, 'src', 'web'), path.join(ROOT, 'electron')];
function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(?:ts|js)$/.test(e.name)) out.push(p);
  }
  return out;
}
const used = new Set();
const usedAt = new Map();
// `orchestrator.` 既可能是成员访问，也可能是**模块路径**——`src/web/app.ts:23` 那行
// `from '../agent/runtime/orchestrator.js'` 就会被裸正则读成"web 在调 orchestrator.js"。
// 两道排除：路径里的那一段前面必定是 `/`（成员访问不会），且后缀是模块扩展名。
const MODULE_EXT = new Set(['js', 'ts', 'mjs', 'cjs', 'json', 'jsx', 'tsx']);
const PORT_CALL = /(^|[^\w/$])orchestrator\.([A-Za-z_$][\w$]*)/g;

// ⚠️ **成员集合必须从剥掉注释的文本里取**，否则一句注释就能把"某处调用被删掉了"
// 伪装成"还在用"。这不是假想的：S11 之后的 web 模块整理把入站摄取搬进
// `web/onebot/ingest.ts` 时，该文件头部注释里写了 `` `orchestrator.onIncoming` ``
// （纯文档），当时本段扫的是原文，于是"把 `orchestrator` 改名成 `orc`"这个探针
// **全绿** —— 端口唯一的 `onIncoming` 调用点已经消失，报告却说"一一对应"。
// 同 `t-events.mjs` / `t-tasks.mjs` 的文本断言：剥注释才是对断言意图的忠实实现。
// 行号仍从原文取（`stripComments` 会把多行块注释的换行吃掉，按它数行会漂），
// 于是报错既能指准位置，又不会把注释里的提及当成调用。
for (const f of SCAN_DIRS.flatMap((d) => walk(d))) {
  const rel = path.relative(ROOT, f).split(path.sep).join('/');
  const raw = fs.readFileSync(f, 'utf8');
  for (const line of stripComments(raw).split('\n')) {
    for (const m of line.matchAll(PORT_CALL)) {
      if (!MODULE_EXT.has(m[2])) used.add(m[2]);
    }
  }
  raw.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(PORT_CALL)) {
      const name = m[2];
      if (MODULE_EXT.has(name)) continue;
      // 只在"这个名字确实被真实代码用过"时才记位置，这样一条纯注释不会成为它的证据。
      if (used.has(name) && !usedAt.has(name)) usedAt.set(name, `${rel}:${i + 1}`);
    }
  });
}
const usedSorted = [...used].sort();
const deadInPort = PORT_ALL.filter((n) => !used.has(n));
const usedNotInPort = usedSorted.filter((n) => !PORT_ALL.includes(n));
ok('端口成员与跨模块实际调用的名字一一对应（没有死成员，也没有漏网的越界调用）',
  deadInPort.length === 0 && usedNotInPort.length === 0,
  [
    deadInPort.length ? `端口里躺着没人用的：${deadInPort.join('、')} → 要么删掉，要么它本来就该留在 agent 内部` : '',
    usedNotInPort.length ? `跨模块在调但端口没写：${usedNotInPort.map((n) => `${n}（${usedAt.get(n)}）`).join('、')}` : ''
  ].filter(Boolean).join('；'));

// ── 3. 端口描述的是真东西：真起一个 Orchestrator，逐个成员核对 ──
const { ChatStore } = await load('chat/store.js');
const { SessionRegistry } = await load('chat/sessions.js');
const { SendQueue } = await load('qq/sender.js');
const { Orchestrator } = await load('agent/runtime/orchestrator.js');
const { METHOD_CATALOG } = await load('agent/runtime/control-port.js');

const store = new ChatStore(0);
const sessions = new SessionRegistry(0);
const memory = { formatForPrompt: () => '', members: () => [], listChats: () => [] };
const stickers = { sync: async () => ({ entries: [] }) };
const onebot = { selfId: '999', selfNickname: '小鲸鱼', connected: true,
  sendText: async () => ({ message_id: 1 }), sendSticker: async () => ({ message_id: 2 }),
  sendPoke: async () => ({}), getGroupInfo: async () => ({ group_name: '测试群' }), call: async () => ({}) };
// S10d 起 emit 必填（见第 1c 段）。
const orc = new Orchestrator({ store, memory, stickers, sender: new SendQueue({ onebot, store }), sessions, onebot, emit: () => {} });

const missingMethods = PORT_METHODS.filter((n) => typeof orc[n] !== 'function');
ok('端口里的 16 个方法在真实例上都是函数',
  missingMethods.length === 0,
  `不是函数的：${missingMethods.map((n) => `${n}(${typeof orc[n]})`).join('、')}`);

// 状态字段的**类型**也要核：`paused` 写成非 boolean、两个 Set 换成数组都会让 web 侧
// 的 `.has()`/`.add()` 在运行期炸，而类型层只要类型对得上就看不出来。
const stateShape = [
  ['paused', typeof orc.paused === 'boolean'],
  ['pauseReason', orc.pauseReason === null || typeof orc.pauseReason === 'string'],
  ['compacting', orc.compacting instanceof Set],
  ['consolidating', orc.consolidating instanceof Set]
];
ok('端口的 4 个只读状态字段在真实例上形状正确（两个集合必须是 Set，web 要 .has/.add）',
  stateShape.every(([, good]) => good),
  stateShape.filter(([, good]) => !good).map(([n]) => n).join('、'));

// ── 4. 方法名录：键不多不少，owner 指向真实存在的文件 ──
const catalogKeys = Object.keys(METHOD_CATALOG).sort();
const missingInCatalog = PORT_METHODS.filter((n) => !catalogKeys.includes(n));
const extraInCatalog = catalogKeys.filter((n) => !PORT_METHODS.includes(n));
// 编译期已由 `satisfies Record<AgentControlMethod, …>` 挡了一层（实测四个方向都会报错，
// 见 §9.5 第 12 项）；这条运行时断言补的是"表里写的 owner 是不是真的"——
// 编译期只能保证它是 string。
const badOwners = catalogKeys.filter((k) => !fs.existsSync(path.join(ROOT, METHOD_CATALOG[k].owner)));
ok('METHOD_CATALOG 的键与端口的 16 个方法完全一致',
  missingInCatalog.length === 0 && extraInCatalog.length === 0,
  [missingInCatalog.length ? `漏了：${missingInCatalog.join('、')}` : '',
    extraInCatalog.length ? `多了：${extraInCatalog.join('、')}` : ''].filter(Boolean).join('；'));
ok('每个 owner 都指向仓库里真实存在的文件',
  badOwners.length === 0,
  badOwners.map((k) => `${k} → ${METHOD_CATALOG[k].owner}`).join('、'));

// ── 5. 名录只作文档：它绝不是一张可以按名字调用的分发表 ──
// 定向扫 `src/`：除定义处外，任何文件引用 METHOD_CATALOG 都意味着它开始参与运行时
// 逻辑了（路线图禁止的字符串式注册）。`tests/` 不在扫描范围内——本套件自己就要读它。
//
// **剥掉注释再扫**：断言要的是"代码里没有引用"，而注释里提一嘴（比如指向隔壁那张表）
// 不参与任何逻辑。不剥的话这个误报当场就出现过一次，见 src.mjs 的 stripComments。
const SRC = path.join(ROOT, 'src');
const catalogRefs = walk(SRC)
  .map((f) => path.relative(SRC, f).split(path.sep).join('/'))
  .filter((f) => f !== 'agent/runtime/control-port.ts')
  .filter((f) => stripComments(fs.readFileSync(path.join(SRC, f), 'utf8')).includes('METHOD_CATALOG'));
ok('除定义处外 src/ 没有任何文件引用 METHOD_CATALOG（它只作文档与测试引用）',
  catalogRefs.length === 0,
  `${catalogRefs.join('、')} → 名录一旦参与分发就变成了路线图禁止的字符串式注册表`);

process.exit(done() ? 0 : 1);
