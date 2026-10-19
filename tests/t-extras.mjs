// 扩展能力（`src/extra/`）的运行时：装载表、由它派生的三张表、以及"模型零装载入口"这条主约束。
//
// 这一层的价值全在"装载/卸载真的改变了什么"——而它**没有任何可观察的外部副作用**：
// 没有文件、没有网络、没有子进程（参考扩展 clock 只是一个纯函数工具）。所以本套件做三件事：
//   1. 用**假注册表**驱动 `createExtrasRuntime`，把"什么时候 load / 什么时候 dispose"逐条记下来
//      （同 `t-lifecycle.mjs` 的 spyDeps 手法：真实现拿不到的那些时刻，靠假依赖观察）；
//   2. 用**真注册表 + 真实现**跑一遍 `get_current_time`，证明声明与实现确实对得上；
//   3. 钉住这一轮最重要的那条取舍：**未装载的扩展，模型连它的工具都看不到**。
//
// ⚠️ 三处已知边界，别以为这里管着：
//   • **模块代码永远不会被卸载**（Node ESM 没有模块卸载）。本套件验的是"我们不再持有它 +
//     它自己的 dispose 被调了"，不是"内存降了"。
//   • 本套件用**自己的**假计时器（可推进），不是 `t-timers.mjs` 那套只记录不触发的 ——
//     TTL 卸载必须真的让计时器到点才验得出来。
//   • 真机上的加载耗时、模型实际怎么选工具，都覆盖不到（那是人工冒烟项）。
import fs from 'node:fs';
import path from 'node:path';
import { checker, dataDir } from './lib/harness.mjs';
import { ROOT, load, stripComments } from './lib/src.mjs';

dataDir('qqagent-extras-');
const { ok, done } = checker();

const { createExtrasRuntime } = await load('extra/runtime.js');
const { EXTRA_REGISTRY } = await load('extra/registry.js');
const { EXTRA_PROMPT_TEXT, EXTRA_PROMPT_SECTIONS, EXTRA_PROMPT_JOBS } = await load('extra/prompts.js');
const { buildToolDefs } = await load('agent/tools/index.js');

// ── 可推进的假计时器 ──────────────────────────────────────────────────────────
//
// 与 `t-timers.mjs` 那套的区别只有一个，但很关键：**这里能推进时间**。TTL 卸载的行为是
// "到点了做什么"，只记录句柄是验不出来的。句柄照旧要带 `unref()`（被测代码会调
// `timer.unref?.()`），而且必须把**原对象**记进集合——记拷贝的话 `unrefCalled` 永远停在 false。
function withFakeTimers(fn) {
  const real = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  let now = 0;
  let nextId = 1;
  const pending = new Map();
  const timers = {
    now: () => now,
    pending: () => [...pending.values()],
    count: () => pending.size,
    /** 推进 ms 毫秒，按到期时刻顺序触发；触发中新排定的计时器照常参与。 */
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...pending.values()].filter((h) => h.at <= target).sort((a, b) => a.at - b.at || a.id - b.id);
        if (!due.length) break;
        const handle = due[0];
        pending.delete(handle.id);
        now = handle.at;
        handle.fn();
      }
      now = target;
    },
    restore() {
      globalThis.setTimeout = real.setTimeout;
      globalThis.clearTimeout = real.clearTimeout;
    }
  };
  globalThis.setTimeout = (fn2, ms = 0) => {
    const handle = { id: nextId++, at: now + Math.max(0, Number(ms) || 0), fn: fn2, unrefCalled: false };
    handle.unref = () => { handle.unrefCalled = true; return handle; };
    pending.set(handle.id, handle);
    return handle;
  };
  globalThis.clearTimeout = (handle) => { if (handle && typeof handle.id === 'number') pending.delete(handle.id); };
  return Promise.resolve(fn(timers)).finally(() => timers.restore());
}

/** 让 `void this.#dispose(...)` 那类没有 promise 可等的收尾跑完。 */
async function flush(times = 8) {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setImmediate(resolve));
}

const DEFAULT_EXTRAS = { enabled: {}, idleUnloadMs: 600000, maxLoadsPerHour: 20 };
/** 本套件用的会话标识。**接管按会话隔离**，所以三张表都要带上它。 */
const G = 'group:1';

function makeRuntime(registry, extrasConfig, builtinToolNames = [], extraDeps = {}) {
  return createExtrasRuntime(registry, {
    getConfig: () => ({ extras: extrasConfig }),
    builtinToolNames,
    log: () => {},
    ...extraDeps
  });
}

/** 一条假工具声明（纯数据）。 */
const spec = (name) => ({ name, description: `${name} 的说明`, parameters: { type: 'object', properties: {}, required: [] } });
/** 一条假命令声明（纯数据，判据是纯函数）。 */
const cmd = (name) => ({ names: [name] });

/**
 * 一个可观察的假扩展：记录 load / dispose / 工具调用 / 命令调用四个计数。
 * `body` 可覆盖默认的执行体（用来造"在途不卸载"那种场景）。
 */
function makeFakeEntry(id, names, {
  defaultEnabled = true, mode = 'attach', commands = [], body = null, dispose = null, prompt = null,
  overrideTools = null, onRunEnd = null, toolsFor = null, configPatch = null, intercept = null
} = {}) {
  const counters = { load: 0, dispose: 0, run: 0, command: 0, runEnd: 0 };
  /** 宿主递给 `load()` 的口子 —— 扩展要拿它做"只有宿主才知道怎么做"的事。 */
  const seen = { deps: null };
  const entry = {
    id,
    title: id,
    displayDesc: `${id} 的说明`,
    mode,
    defaultEnabled,
    tools: names.map(spec),
    ...(commands.length ? { commands: commands.map(cmd) } : {}),
    ...(overrideTools ? { overrideTools } : {}),
    async load(deps) {
      counters.load += 1;
      seen.deps = deps ?? null;
      const handlers = {};
      for (const name of names) {
        handlers[name] = async (_ctx, args) => {
          counters.run += 1;
          if (body) return body(name, args);
          return { content: `${id}/${name} ok` };
        };
      }
      const commandHandlers = {};
      for (const name of commands) {
        commandHandlers[name] = async () => { counters.command += 1; return `${id} 的命令回执`; };
      }
      const rt = { handlers };
      if (commands.length) rt.commandHandlers = commandHandlers;
      if (prompt) rt.prompt = () => prompt;
      if (toolsFor) rt.toolsFor = toolsFor;
      if (configPatch) rt.configPatch = () => configPatch;
      if (intercept) rt.intercept = intercept;
      if (onRunEnd) rt.onRunEnd = (session) => { counters.runEnd += 1; return onRunEnd(session); };
      rt.dispose = dispose === null ? () => { counters.dispose += 1; } : dispose;
      return rt;
    }
  };
  return { entry, counters, seen };
}

// ── 1. 闸门 + **模型零装载入口** ────────────────────────────────────────────
//
// 这一段是本轮的核心。它钉的是一条**不会报错地坏掉**的性质：只要 `toolDefs()` 改成不看装载状态，
// 未装载扩展的工具就会重新出现在模型眼前 —— 功能上毫无异常，而"装载的控制权在人手里"这条
// 设计当场作废。
{
  const clock = EXTRA_REGISTRY.find((entry) => entry.id === 'clock');
  ok('真注册表里有 clock（参考扩展）', !!clock && clock.tools.length === 1);
  ok('clock 声明了一条斜杠命令', (clock.commands ?? []).length === 1);

  const off = makeRuntime(EXTRA_REGISTRY, { ...DEFAULT_EXTRAS, enabled: { clock: false } });
  ok('enabled 显式关掉 → 它的工具不进工具表',
    off.toolDefs(G).length === 0, `实际 ${off.toolDefs(G).length} 个`);

  const on = makeRuntime(EXTRA_REGISTRY, { ...DEFAULT_EXTRAS, enabled: { clock: true } });
  ok('**启用但未装载 → 工具仍然不在表里**（模型连"有这个能力"都看不到）',
    on.toolDefs(G).length === 0, JSON.stringify(on.toolDefs(G).map((d) => d.name)));
  ok('但命令敲得到（判据按 spec 静态，入口是人）',
    on.commandDefs(G).length === 1 && on.commandDefs(G)[0].names[0] === '/时间');

  // 配置里没写这个 id 时用扩展自己的 defaultEnabled —— 这是"加一个扩展不用改配置"的前提。
  const fallback = makeRuntime(EXTRA_REGISTRY, { ...DEFAULT_EXTRAS, enabled: {} });
  ok('配置里没写这个 id → 用 defaultEnabled 兜底（命令表它就在，工具表仍然不在）',
    fallback.commandDefs(G).length === (clock.defaultEnabled ? 1 : 0)
    && fallback.toolDefs(G).length === 0);
}

// ── 2. 装载/卸载：工具表随之增减 ─────────────────────────────────────────────
{
  const { entry, counters } = makeFakeEntry('lazy', ['lazy_tool'], { commands: ['/lazy'] });
  const runtime = makeRuntime([entry], DEFAULT_EXTRAS);
  ok('装载之前 toolDefs() 里没有它', runtime.toolDefs(G).length === 0);
  ok('装载之前 isLoaded 是 false', runtime.isLoaded('lazy') === false && counters.load === 0);

  const loaded = await runtime.load('lazy', 'test');
  ok('load() 成功并真的跑了一次 import()', loaded.ok === true && counters.load === 1, JSON.stringify(loaded));
  ok('装载之后工具进表了', runtime.toolDefs(G).map((d) => d.name).join() === 'lazy_tool');

  const again = await runtime.load('lazy');
  ok('重复装载被拒（不重复 import）', again.ok === false && counters.load === 1, JSON.stringify(again));

  const gone = await runtime.unload('lazy');
  ok('unload() 成功、调了 dispose、工具表空了',
    gone.ok === true && counters.dispose === 1 && runtime.toolDefs(G).length === 0, JSON.stringify(gone));
  const gone2 = await runtime.unload('lazy');
  ok('重复卸载被拒', gone2.ok === false, JSON.stringify(gone2));
  const unknown = await runtime.load('nope');
  ok('装载不存在的 id 被拒', unknown.ok === false && String(unknown.note).includes('没有这个扩展'));

  // 关闭的扩展不许装载 —— 否则"配置里关着"这个闸门就能被 `/能力` 绕过。
  const disabled = makeRuntime([entry], { ...DEFAULT_EXTRAS, enabled: { lazy: false } });
  const refused = await disabled.load('lazy');
  ok('配置里关着的扩展装载被拒（闸门绕不过去）', refused.ok === false && String(refused.note).includes('关闭'));
}

// ── 2b. `toolsFor`：一个扩展按会话说"我此刻露哪些工具" ──────────────────────
//
// 跑团用它实现"助手模式只暴露骰子"（同一个扩展：一个群当骰子机器人、另一个群当 DM）。
// 这一段的每一条都对应一种**不会报错地坏掉**的形态：钩子没生效 → 模型看到它这个形态下
// 不该看到的工具；返回值没过筛 → 表里留着一个 `execute` 必报"未知工具"的入口；
// 钩子抛错 → 一整轮运行被打掉（而它只是想换个工具表）。
{
  const shaped = makeFakeEntry('shaped', ['say', 'campaign'], {
    toolsFor: (chatKey) => (chatKey === 'group:assistant' ? ['say'] : ['say', 'campaign'])
  });
  const plain = makeFakeEntry('plain', ['only']);
  const runtime = makeRuntime([shaped.entry, plain.entry], DEFAULT_EXTRAS);
  await runtime.load('shaped');
  await runtime.load('plain');

  const shown = (chatKey) => runtime.toolDefs(chatKey).filter((d) => d.name !== 'only').map((d) => d.name).join();
  ok('提供了 toolsFor 的扩展**按会话**取子集',
    shown('group:assistant') === 'say' && shown('group:dm') === 'say,campaign',
    `${shown('group:assistant')} / ${shown('group:dm')}`);
  ok('**同一个扩展在不同会话里可以露不同的表**（这正是它存在的理由）',
    shown('group:assistant') !== shown('group:dm'));
  ok('没提供 toolsFor 的扩展照旧出全部（钩子是纯增量的，不影响别人）',
    runtime.toolDefs('group:assistant').map((d) => d.name).includes('only')
    && runtime.toolDefs('group:dm').map((d) => d.name).includes('only'));
  await runtime.stop();
}

// 钩子返回没声明的名字：**滤掉并记日志**，不抛（这是运行期、在别人的一轮对话里被调的）。
{
  const logs = [];
  const ent = makeFakeEntry('typo', ['say'], { toolsFor: () => ['say', 'sya'] });
  const runtime = createExtrasRuntime([ent.entry], {
    getConfig: () => ({ extras: DEFAULT_EXTRAS }), builtinToolNames: [], log: (...args) => logs.push(args.join(' '))
  });
  await runtime.load('typo');
  ok('toolsFor 返回没声明的名字 → 被滤掉（不然模型会拿到一个 execute 必报"未知工具"的入口）',
    runtime.toolDefs(G).map((d) => d.name).join() === 'say',
    JSON.stringify(runtime.toolDefs(G).map((d) => d.name)));
  ok('并且把这件事记进日志（静默少一个工具是最难查的一类）',
    logs.some((line) => line.includes('sya')), JSON.stringify(logs));
  await runtime.stop();
}

// 钩子抛错：**回落成"全部工具"**，不是把这一轮打掉。方向也是安全的那一侧
// （退回这个钩子不存在之前的行为，而不是变成"一个工具都没有"）。
//
// ⚠️ 夹具必须让**空会话那次调用成功**（装载时会拿 `''` 探一次，那边抛了就直接拒绝装载）——
// 要测的是"运行期某个真实会话上抛了"这条，两者是不同的分支。
{
  const logs = [];
  const ent = makeFakeEntry('boom', ['say', 'campaign'], {
    toolsFor: (chatKey) => { if (chatKey) throw new Error('我算不出来'); return ['say', 'campaign']; }
  });
  const runtime = createExtrasRuntime([ent.entry], {
    getConfig: () => ({ extras: DEFAULT_EXTRAS }), builtinToolNames: [], log: (...args) => logs.push(args.join(' '))
  });
  await runtime.load('boom');
  ok('toolsFor 抛错 → 本会话按"全部工具"处理（不是空表，也不是把运行打掉）',
    runtime.toolDefs(G).length === 2, JSON.stringify(runtime.toolDefs(G).map((d) => d.name)));
  ok('并且记日志（否则"这个群怎么忽然多出两个工具"没有任何线索）',
    logs.some((line) => line.includes('我算不出来')), JSON.stringify(logs));
  await runtime.stop();
}

// 装载期**空着会话调一次**：抛了就等于拒绝装载（同 `prompt` 那条）。
// 症状是"这个扩展装不上"，而它与工具表毫无关系 —— 那是最难查的一类因果错位。
{
  const ent = makeFakeEntry('badhook', ['say'], {
    toolsFor: (chatKey) => { if (!chatKey) throw new Error('必须要会话'); return ['say']; }
  });
  const runtime = makeRuntime([ent.entry], DEFAULT_EXTRAS);
  const result = await runtime.load('badhook');
  ok('toolsFor 对空会话抛错 → 拒绝装载（判据与 prompt 一致）',
    result.ok === false && /toolsFor\(\) 抛错/.test(result.note), JSON.stringify(result));

  const wrongShape = makeFakeEntry('badshape', ['say'], { toolsFor: () => 'say' });
  const rt2 = makeRuntime([wrongShape.entry], DEFAULT_EXTRAS);
  const r2 = await rt2.load('badshape');
  ok('toolsFor 返回的不是数组 → 也拒绝装载（形状错了不该等到运行期才发现）',
    r2.ok === false && /必须返回一个工具名数组/.test(r2.note), JSON.stringify(r2));
}

// ── 3. 命令**不再**触发装载（2026-10-19，用户要求）─────────────────────────────
//
// 判据仍然是静态的（`commandDefs` 按**已启用**算），所以未加载时命令照旧**认得出** ——
// 这是刻意的：命令若干脆不在表里，那条消息会静默地进 LLM，群里什么提示都没有。
// 但敲它**不会**把扩展拉起来，而是抛出一句可执行的下一步。
{
  const { entry, counters } = makeFakeEntry('viacmd', ['t'], { commands: ['/go'] });
  const runtime = makeRuntime([entry], DEFAULT_EXTRAS);
  const command = runtime.commandDefs(G)[0];
  ok('命令在扩展**未装载**时就敲得到（判据是静态的，不然消息会静默进 LLM）',
    !!command && counters.load === 0);

  let refusal = '';
  try {
    await command.run({ chatKey: 'group:1', senderId: '5', text: '/go', media: [], replyToMessageId: null });
  } catch (error) { refusal = String(error?.message ?? error); }
  ok('★ 敲命令**不再**把扩展拉起来，而是抛一句"先 /能力 加载"（由命令外壳原样发进群）',
    counters.load === 0 && counters.command === 0 && refusal.includes('/能力 加载 viacmd'),
    `${refusal} / load=${counters.load} command=${counters.command}`);
  ok('未装载时工具表里仍然没有它', runtime.toolDefs(G).length === 0);

  // 对照：显式装载之后，同一条命令照常跑得通 —— 没有这一条，上面那两条可能只是"命令彻底坏了"。
  await runtime.load('viacmd');
  const receipt = await command.run({ chatKey: 'group:1', senderId: '5', text: '/go', media: [], replyToMessageId: null });
  ok('对照：显式 `/能力 加载` 之后同一条命令照常跑通（回执就是实现给的那句）',
    receipt === 'viacmd 的命令回执' && counters.command === 1, `${receipt} / command=${counters.command}`);
  ok('对照：装载之后工具表里也有它了', runtime.toolDefs(G).length === 1);
  await runtime.stop();
}

// ── 3b. `commandDefs()` 必须把 `requiresMention` 原样交出去 ─────────────────────
//
// 它**重新构造**命令对象（不是把 spec 原样递出去），所以少写一行就会被静默丢掉 ——
// 表现是"扩展声明了免 @，群里却怎么敲都不是命令"，而声明看起来完全正确。
// 探针实测抓到过一次：把那一行删掉，**其余全部套件照绿**（t-commands 是手写 spec 直接
// 交给适配器的，根本走不到 `commandDefs`），所以这条断言不能省。
{
  const entry = {
    id: 'mention', title: 'mention', displayDesc: 'x', mode: 'attach', defaultEnabled: true,
    tools: [],
    commands: [
      { names: ['/免'], requiresMention: false },
      { names: ['/带子命令'], subs: ['go'], requiresMention: false },
      { names: ['/默认'] }
    ],
    async load() {
      const keys = ['/免', '/带子命令 go', '/默认'];
      return { handlers: {}, commandHandlers: Object.fromEntries(keys.map((k) => [k, async () => k])) };
    }
  };
  const runtime = makeRuntime([entry], DEFAULT_EXTRAS);
  const defs = runtime.commandDefs(G);
  const of = (name) => defs.find((c) => c.names[0] === name);
  ok('声明的 `requiresMention: false` 一路交到命令表（普通命令）',
    of('/免')?.requiresMention === false, JSON.stringify(defs.map((c) => [c.names[0], c.requiresMention])));
  ok('子命令展开出来的那几条同样带上声明（否则 `.trpg new` 与 `.trpg` 的 @ 要求会不一样）',
    of('/带子命令 go')?.requiresMention === false,
    JSON.stringify(defs.map((c) => [c.names[0], c.requiresMention])));
  ok('没声明的保持缺省（`true` = 群里要 @）',
    of('/默认')?.requiresMention === true,
    JSON.stringify(defs.map((c) => [c.names[0], c.requiresMention])));
  await runtime.stop();
}

// ── 4. TTL：空闲到点真的 dispose；在途不卸载 ─────────────────────────────────
await withFakeTimers(async (timers) => {
  const { entry, counters } = makeFakeEntry('ttl', ['ttl_tool']);
  const runtime = makeRuntime([entry], { ...DEFAULT_EXTRAS, idleUnloadMs: 5000 });
  await runtime.load('ttl', 'test');
  ok('装载之后有一个空闲计时器', timers.count() === 1, `实际 ${timers.count()} 个`);
  ok('空闲计时器 unref 了（不该把进程钉住）', timers.pending()[0]?.unrefCalled === true);

  timers.advance(4999);
  await flush();
  ok('未到空闲上限时不卸载', counters.dispose === 0 && runtime.isLoaded('ttl'));

  timers.advance(1);
  await flush();
  ok('到点调了 dispose 并从装载表里删掉', counters.dispose === 1 && !runtime.isLoaded('ttl'));
  ok('卸载之后工具表里也没了', runtime.toolDefs(G).length === 0);

  await runtime.load('ttl', 'test');
  ok('卸载之后再装载会重新 import（不是拿旧的）', counters.load === 2);

  // **每次执行都刷新空闲窗口**（滑动窗口，不是从装载时刻起算的固定租期）。
  const tool = runtime.toolDefs(G)[0];
  timers.advance(4000);
  await tool.execute({}, {});
  timers.advance(4000);
  await flush();
  ok('执行会把空闲窗口往后推（滑动，而非固定租期）', counters.dispose === 1, `dispose=${counters.dispose}`);
  timers.advance(1000);
  await flush();
  ok('从最后一次执行起算满一个窗口才卸载', counters.dispose === 2, `dispose=${counters.dispose}`);

  await runtime.stop();
});

// 在途保护：卸载一个正在干活的扩展 = 抽掉它的子进程 / 连接。
await withFakeTimers(async (timers) => {
  let release = null;
  const { entry, counters } = makeFakeEntry('inflight', ['slow_tool'], {
    body: () => new Promise((resolve) => { release = () => resolve({ content: 'done' }); })
  });
  const runtime = makeRuntime([entry], { ...DEFAULT_EXTRAS, idleUnloadMs: 1000 });
  await runtime.load('inflight', 'test');
  const pendingCall = runtime.toolDefs(G)[0].execute({}, {});
  await flush();
  ok('调用还在飞', counters.run === 1 && typeof release === 'function');

  timers.advance(5000);
  await flush();
  ok('在途时不卸载（只是把计时器往后推）', counters.dispose === 0, `dispose=${counters.dispose}`);
  const refused = await runtime.unload('inflight');
  ok('在途时 `/能力 卸载` 也被拒（不抽掉正在干活的东西）', refused.ok === false, JSON.stringify(refused));

  release();
  await pendingCall;
  await flush();
  timers.advance(1000);
  await flush();
  ok('调用结束、空闲满一个窗口之后才卸载', counters.dispose === 1, `dispose=${counters.dispose}`);

  await runtime.stop();
});

// ── 5. stop()：清计时器、dispose 全部、幂等、且不被卡住的 dispose 挂死 ───────
await withFakeTimers(async (timers) => {
  const a = makeFakeEntry('a', ['a_tool']);
  const b = makeFakeEntry('b', ['b_tool']);
  const runtime = makeRuntime([a.entry, b.entry], { ...DEFAULT_EXTRAS, idleUnloadMs: 60000 });
  await runtime.load('a');
  await runtime.load('b');
  ok('两个扩展各有一个空闲计时器', timers.count() === 2, `实际 ${timers.count()} 个`);

  await runtime.stop();
  ok('stop() 清掉了全部空闲计时器', timers.count() === 0, `还剩 ${timers.count()} 个`);
  ok('stop() 把已装载的扩展都 dispose 了', a.counters.dispose === 1 && b.counters.dispose === 1,
    `a=${a.counters.dispose} b=${b.counters.dispose}`);

  await runtime.stop();
  ok('stop() 幂等（第二次不会再 dispose 一遍）', a.counters.dispose === 1 && b.counters.dispose === 1);

  // dispose 卡住：stop() 必须在等待上限内返回，而不是把 stopLifecycle 挂死。
  const stuck = makeFakeEntry('stuck', ['stuck_tool'], { dispose: () => new Promise(() => {}) });
  const runtime2 = makeRuntime([stuck.entry], DEFAULT_EXTRAS);
  await runtime2.load('stuck');
  const stopping = runtime2.stop();
  await flush(2);
  timers.advance(3000);       // 等待上限
  await stopping;
  ok('dispose 卡住时 stop() 仍按等待上限返回（不挂死关停）', true);
});

// ── 6. 注册表自检：重名是"扩展静默失效"的成因，必须在装配期就炸 ──────────────
{
  const throws = (fn) => { try { fn(); return null; } catch (error) { return String(error.message); } };

  const dupId = throws(() => makeRuntime([makeFakeEntry('same', ['t1']).entry, makeFakeEntry('same', ['t2']).entry], DEFAULT_EXTRAS));
  ok('id 重复 → 构造函数抛错', !!dupId && dupId.includes('id 重复'), String(dupId));

  const dupTool = throws(() => makeRuntime([makeFakeEntry('x', ['same_tool']).entry, makeFakeEntry('y', ['same_tool']).entry], DEFAULT_EXTRAS));
  ok('工具名跨扩展重复 → 构造函数抛错', !!dupTool && dupTool.includes('重名'), String(dupTool));

  const dupCmd = throws(() => makeRuntime([
    makeFakeEntry('c1', [], { commands: ['/重复'] }).entry,
    makeFakeEntry('c2', [], { commands: ['/重复'] }).entry
  ], DEFAULT_EXTRAS));
  ok('命令词跨扩展重复 → 构造函数抛错', !!dupCmd && dupCmd.includes('重复'), String(dupCmd));

  // **所有词形共用一个命名空间**（自己内部、跨扩展都一样）：重了的话"先匹配到的先处理"
  // 会静默地决定谁赢，而两个命令的作者都以为自己的那个会被执行。
  const aliasClash = throws(() => makeRuntime([
    makeFakeEntry('a1', [], { commands: ['/天气'] }).entry,
    { ...makeFakeEntry('a2', [], { commands: ['/查天气'] }).entry, commands: [{ names: ['/查天气', '/天气'] }] }
  ], DEFAULT_EXTRAS));
  ok('词形与别的扩展的主命令词重复 → 构造函数抛错',
    !!aliasClash && aliasClash.includes('重复'), String(aliasClash));

  const aliasSelfClash = throws(() => makeRuntime([
    { ...makeFakeEntry('a3', [], { commands: ['/x'] }).entry, commands: [{ names: ['/x', '/x'] }] }
  ], DEFAULT_EXTRAS));
  ok('同一个命令里词形重复 → 构造函数抛错',
    !!aliasSelfClash && aliasSelfClash.includes('重复'), String(aliasSelfClash));

  const badAlias = throws(() => makeRuntime([
    { ...makeFakeEntry('a4', [], { commands: ['/x'] }).entry, commands: [{ names: ['/x', 'time'] }] }
  ], DEFAULT_EXTRAS));
  ok('词形不带合法前缀（`/` 或 `.`）→ 构造函数抛错',
    !!badAlias && badAlias.includes('必须以 / 或 . 开头'), String(badAlias));

  const spaceAlias = throws(() => makeRuntime([
    { ...makeFakeEntry('a5', [], { commands: ['/x'] }).entry, commands: [{ names: ['/x', '/两 个字'] }] }
  ], DEFAULT_EXTRAS));
  ok('词形含空白 → 构造函数抛错', !!spaceAlias && spaceAlias.includes('不能含空白'), String(spaceAlias));

  // 与内置工具重名最阴：`defs.find()` 取的是**内置那个**，扩展从此静默失效。
  const clash = throws(() => makeRuntime([makeFakeEntry('z', ['send_message']).entry], DEFAULT_EXTRAS, ['send_message']));
  ok('工具名与内置工具重名 → 构造函数抛错', !!clash && clash.includes('内置工具重名'), String(clash));

  const emptyToolDesc = throws(() => makeRuntime([{
    id: 'blank', title: 'blank', displayDesc: 'blank 的说明', defaultEnabled: true,
    tools: [{ name: 'blank_tool', description: '', parameters: {} }],
    async load() { return { handlers: { blank_tool: async () => ({ content: 'x' }) } }; }
  }], DEFAULT_EXTRAS));
  ok('工具 description 为空 → 构造函数抛错（应当取自 extra/prompts.ts）',
    !!emptyToolDesc && emptyToolDesc.includes('description 是空的'), String(emptyToolDesc));

  // 扩展自己的那一句（给人看的）也是必填：空的话设置页只剩一个光秃秃的开关。
  const emptyDisplay = throws(() => makeRuntime([{
    id: 'nodoc', title: 'nodoc', displayDesc: '', defaultEnabled: true,
    tools: [spec('nodoc_tool')],
    async load() { return { handlers: { nodoc_tool: async () => ({ content: 'x' }) } }; }
  }], DEFAULT_EXTRAS));
  ok('扩展的 displayDesc 为空 → 构造函数抛错（设置页那一行会没有说明）',
    !!emptyDisplay && emptyDisplay.includes('displayDesc 是空的'), String(emptyDisplay));

  const badMode = throws(() => makeRuntime([makeFakeEntry('m', ['t'], { mode: 'takeover' }).entry], DEFAULT_EXTRAS));
  ok('mode 写了不认识的值 → 构造函数抛错', !!badMode && badMode.includes('mode 只能是'), String(badMode));

  const badMatch = throws(() => makeRuntime([{
    id: 'badcmd', title: 'badcmd', displayDesc: 'x', defaultEnabled: true,
    tools: [], commands: [{ names: [] }],
    async load() { return { handlers: {} }; }
  }], DEFAULT_EXTRAS));
  ok('命令没写 names（或空数组）→ 构造函数抛错', !!badMatch && badMatch.includes('没写 names'), String(badMatch));
}

// ── 7. 声明 ⇄ 实现对账（这套设计唯一的真实漂移点）────────────────────────────
//
// 两处都查：spec 里写了、实现里没有 → 调得到却执行不了；反过来 → 死代码。
// 对不上就**拒绝装载**，不是缓存一个坏 runtime 然后每次调用都报错。
{
  const mismatch = {
    id: 'mismatch', title: 'mismatch', displayDesc: 'x', defaultEnabled: true,
    tools: [spec('declared_only'), spec('also_missing')],
    async load() { return { handlers: { declared_only: async () => ({ content: 'ok' }) } }; }
  };
  const runtime = makeRuntime([mismatch], DEFAULT_EXTRAS);
  const result = await runtime.load('mismatch');
  ok('工具：声明了却没实现 → 拒绝装载', result.ok === false && String(result.note).includes('没有实现'), JSON.stringify(result));
  ok('被拒之后没有留在装载表里（下次还能再试）', !runtime.isLoaded('mismatch') && runtime.toolDefs(G).length === 0);

  const extraImpl = {
    id: 'extra_impl', title: 'extra_impl', displayDesc: 'x', defaultEnabled: true,
    tools: [spec('only_one')],
    async load() { return { handlers: { only_one: async () => ({ content: 'ok' }), surprise: async () => ({ content: '?' }) } }; }
  };
  const r2 = makeRuntime([extraImpl], DEFAULT_EXTRAS);
  const result2 = await r2.load('extra_impl');
  ok('工具：实现了却没声明 → 拒绝装载', result2.ok === false && String(result2.note).includes('没有声明'), JSON.stringify(result2));

  const cmdMismatch = {
    id: 'cmdm', title: 'cmdm', displayDesc: 'x', defaultEnabled: true,
    tools: [], commands: [cmd('/有声明')],
    async load() { return { handlers: {} }; }
  };
  const r3 = makeRuntime([cmdMismatch], DEFAULT_EXTRAS);
  const result3 = await r3.load('cmdm');
  ok('命令：声明了却没实现 → 拒绝装载',
    result3.ok === false && String(result3.note).includes('命令声明了却没有实现'), JSON.stringify(result3));
}

// ── 7b. 子命令（`subs`）：声明期的糖，展开成普通命令词 ────────────────────────
//
// 判据是"词形仍然只有一个落点"：展开在 `runtime.ts` 里做**一次**，此后没有任何地方知道
// "子命令"这个概念（见 `ExtraCommandSpec.subs`）。三件事都要钉：产出的是**展开后的词**、
// 装载期对账按展开后的**键集合**、以及查重也按它 —— 两个扩展各写一个 `.x new`
// 正是最该被拦住的那种撞名。
{
  /** 手写的假扩展：`commands`（可带 subs）与 `commandHandlers` 的键由用例自己给。 */
  const makeSubEntry = (id, commands, keys) => ({
    id, title: id, displayDesc: `${id} 的说明`, mode: 'attach', defaultEnabled: true, tools: [],
    commands,
    async load() {
      const commandHandlers = {};
      for (const key of keys) commandHandlers[key] = async () => `${id} 的 ${key} 回执`;
      return { handlers: {}, commandHandlers };
    }
  });

  const subCommands = [{ names: ['.x'], subs: ['new', 'join'] }, { names: ['.x'] }];
  const rt = makeRuntime([makeSubEntry('sub', subCommands, ['.x new', '.x join', '.x'])], DEFAULT_EXTRAS);
  const loaded = await rt.load('sub');
  ok('带 subs 的声明**装载得过**：键就是展开出来的那三个（`.x new` / `.x join` / 裸 `.x`）',
    loaded.ok === true, JSON.stringify(loaded));

  const defs = rt.commandDefs('group:1');
  ok('`commandDefs()` 产出的是**展开后的普通命令词**（此后没人知道"子命令"这个概念）',
    JSON.stringify(defs.map((c) => c.names[0])) === JSON.stringify(['.x new', '.x join', '.x']),
    JSON.stringify(defs.map((c) => c.names)));
  ok('裸 `.x` **排在最后**（顺序即行为）—— 它不该把 `.x new` 吃掉',
    defs[defs.length - 1].names[0] === '.x');
  const receipt = await defs[0].run({
    chatKey: 'group:1', senderId: '1', text: '.x new 甲', media: [], replyToMessageId: null
  });
  ok('展开出来的命令调到的是**那个子命令的 handler**（不是主命令那个）',
    receipt === 'sub 的 .x new 回执', String(receipt));

  // 两个方向的对账都按展开后的集合。
  const missing = makeRuntime([makeSubEntry('sub2', subCommands, ['.x new', '.x'])], DEFAULT_EXTRAS);
  const missResult = await missing.load('sub2');
  ok('声明了 `.x join` 却没实现 → 拒绝装载（对账按**展开后的键**）',
    missResult.ok === false && String(missResult.note).includes('命令声明了却没有实现'), JSON.stringify(missResult));

  const surplus = makeRuntime(
    [makeSubEntry('sub3', [{ names: ['.x'], subs: ['new'] }], ['.x new', '.x 多余的'])], DEFAULT_EXTRAS
  );
  const surplusResult = await surplus.load('sub3');
  ok('实现了 `.x 多余的` 却没声明 → 拒绝装载',
    surplusResult.ok === false && String(surplusResult.note).includes('命令实现了却没有声明'),
    JSON.stringify(surplusResult));

  // 构造期自检抛错 —— `throws` 那个帮手是**别的块**里的（块作用域），这里自己兜一个。
  let subClash = null;
  try {
    makeRuntime([
      makeSubEntry('c1', [{ names: ['.x'], subs: ['new'] }], ['.x new']),
      makeSubEntry('c2', [{ names: ['.x'], subs: ['new'] }], ['.x new'])
    ], DEFAULT_EXTRAS);
  } catch (error) { subClash = String(error?.message ?? error); }
  ok('两个扩展各写一个 `.x new` → 构造函数抛错（查重查的是**展开后**的串）',
    !!subClash && subClash.includes('重复'), String(subClash));
}

// ── 8. 提示词覆盖的段名：覆盖一个不存在的段落不会有任何报错，必须拦在装载时 ────
{
  const unknownSection = makeFakeEntry('badsec', ['t'], { prompt: { override: { 不存在的段: 'x' } } });
  const runtime = makeRuntime([unknownSection.entry], DEFAULT_EXTRAS);
  const result = await runtime.load('badsec');
  ok('override 了不存在的段名 → 拒绝装载', result.ok === false && String(result.note).includes('不存在'), JSON.stringify(result));

  // 框架契约两段（安全规则 + 工具调用协议）不是"功能"，是运行契约 —— 扩展动不了它们。
  for (const section of ['security', 'toolProtocol']) {
    const ent = makeFakeEntry(`frame_${section}`, ['t'], { prompt: { override: { [section]: '我说了算' } } });
    const rt = makeRuntime([ent.entry], DEFAULT_EXTRAS);
    const r = await rt.load(ent.entry.id);
    ok(`override 框架契约段 ${section} → 拒绝装载`, r.ok === false && String(r.note).includes('不允许覆盖'), JSON.stringify(r));
  }

  const legal = makeFakeEntry('goodsec', ['t'], { prompt: { override: { stickerRules: '不要发表情。' } } });
  const rt = makeRuntime([legal.entry], DEFAULT_EXTRAS);
  ok('override 一个合法段名 → 装载通过', (await rt.load('goodsec')).ok === true);

  // `capabilityProtocol`（主流程那几个能力的用法）**不是**框架契约段 —— 它可以被覆盖。
  // 这条是"拆段"那件事留下的判据：拆出去的段若被顺手也列进框架契约，接管者就甩不掉它。
  const cap = makeFakeEntry('capseg', ['t'], { prompt: { override: { capabilityProtocol: '本模式没有那些工具。' } } });
  const capRt = makeRuntime([cap.entry], DEFAULT_EXTRAS);
  ok('capabilityProtocol 不是框架契约段 → 可以被覆盖',
    (await capRt.load('capseg')).ok === true);
}

// ── 8b. overrideTools：框架契约段要引用的工具名 ──────────────────────────────
//
// `toolProtocol`（框架契约，接管时强制保留）第 2 条要写"要发言必须调用 X"，而接管会话里
// 内置工具整体让位 —— 缺省那个 `send_message` 不在表里。所以接管扩展**必须**声明自己那个
// 名字，而声明必须是**真的**。三条都拦在装配期（构造函数抛错），因为它们的症状都是安静的：
// 缺了 → 模型调一次拿到"未知工具"再重试，群里迟一轮才见到话；写错 → 同一个症状。
{
  const problemsOf = (entry) => {
    try { makeRuntime([entry], DEFAULT_EXTRAS); return ''; }
    catch (error) { return String(error.message); }
  };

  const noSend = makeFakeEntry('ovA', ['say'], { mode: 'override' });
  ok('接管模式没声明 overrideTools.sendTool → 装配期就拒（默认会写成 send_message，而它不在表里）',
    /必须声明 overrideTools\.sendTool/.test(problemsOf(noSend.entry)), problemsOf(noSend.entry));

  const wrongName = makeFakeEntry('ovB', ['say'], { mode: 'override', overrideTools: { sendTool: 'speak' } });
  ok('overrideTools.sendTool 写了一个本扩展没有的工具名 → 拒（框架段会照着它写，模型一调就报未知工具）',
    /overrideTools\.sendTool 写的是「speak」/.test(problemsOf(wrongName.entry)), problemsOf(wrongName.entry));

  const wrongFinish = makeFakeEntry('ovC', ['say'], {
    mode: 'override', overrideTools: { sendTool: 'say', finishTool: 'wrap_up' }
  });
  ok('overrideTools.finishTool 同样要真的存在', /overrideTools\.finishTool/.test(problemsOf(wrongFinish.entry)),
    problemsOf(wrongFinish.entry));

  const attachWith = makeFakeEntry('atD', ['t'], { overrideTools: { sendTool: 't' } });
  ok('附加模式写了 overrideTools → 拒（没有任何地方读它，只会让人以为它生效了）',
    /overrideTools 只有接管模式/.test(problemsOf(attachWith.entry)), problemsOf(attachWith.entry));

  const good = makeFakeEntry('ovE', ['say', 'wrap'], {
    mode: 'override', overrideTools: { sendTool: 'say', finishTool: 'wrap' }, body: ['【你是 DM】']
  });
  const rtGood = makeRuntime([good.entry], DEFAULT_EXTRAS);
  ok('声明齐全（两个名字都在 tools 里）→ 通过自检', rtGood.list().some((row) => row.id === 'ovE'));

  // 计划要把它**带出去** —— 否则上面那一整套校验只是自我感动（校验了却没人用）。
  await rtGood.load('ovE', 'test', G);
  const plan = rtGood.promptPlan(G);
  ok('promptPlan 在接管时带出 sendTool / finishTool（框架契约段靠它俩才写得对）',
    plan.mode === 'override' && plan.sendTool === 'say' && plan.finishTool === 'wrap', JSON.stringify(plan));

  // `finishTool: null` 是**合法**取值（本扩展没有收尾工具），不能被当成"没声明"而误拦。
  const noFinish = makeFakeEntry('ovF', ['say'], {
    mode: 'override', overrideTools: { sendTool: 'say', finishTool: null }
  });
  const rtNoFinish = makeRuntime([noFinish.entry], DEFAULT_EXTRAS);
  await rtNoFinish.load('ovF', 'test', G);
  ok('finishTool 显式写 null → 通过自检，且计划里如实带出 null（框架段不提收尾工具）',
    rtNoFinish.promptPlan(G).finishTool === null, JSON.stringify(rtNoFinish.promptPlan(G)));
}

// ── 9. 提示词计划随装载状态变化（"动态"那条取舍的唯一判据）────────────────────
{
  const { entry } = makeFakeEntry('talk', ['t'], { prompt: { append: ['【提醒】记住我很啰嗦。'] } });
  const runtime = makeRuntime([entry], DEFAULT_EXTRAS);
  ok('未装载 → 计划里没有它的贡献',
    JSON.stringify(runtime.promptPlan(G)) === JSON.stringify({ mode: 'attach', append: [], override: {} }),
    JSON.stringify(runtime.promptPlan(G)));

  await runtime.load('talk');
  ok('装载后 → 追加段落出现在计划里',
    runtime.promptPlan(G).mode === 'attach' && runtime.promptPlan(G).append.includes('【提醒】记住我很啰嗦。'),
    JSON.stringify(runtime.promptPlan(G)));

  await runtime.unload('talk');
  ok('卸载后 → 贡献又消失（这就是"随装载状态变化"）',
    runtime.promptPlan(G).append.length === 0, JSON.stringify(runtime.promptPlan(G)));
}

// ── 10. 接管模式：**按会话隔离**，且同样受生命时间约束 ──────────────────────
//
// 这一段的两个性质都**不会报错地坏掉**：接管偷偷变成全局的，表现只是"B 群也忽然变了个人"；
// 生命时间对附加生效、对继承不生效，表现只是"接管永远不撒手"。所以逐条钉。
{
  const attach = makeFakeEntry('atta', ['attach_tool'], { commands: ['/atta'] });
  const over = makeFakeEntry('over', ['over_tool'], {
    mode: 'override', overrideTools: { sendTool: 'over_tool' },
    commands: ['/over'], prompt: { body: ['你是另一个东西。'] }
  });
  const runtime = makeRuntime([attach.entry, over.entry], DEFAULT_EXTRAS);
  const A = 'group:100';
  const B = 'group:200';

  await runtime.load('atta');
  ok('接管之前：附加扩展的工具在表里、isOverridden 为假',
    runtime.toolDefs(A).map((d) => d.name).join() === 'attach_tool' && runtime.isOverridden(A) === false);

  ok('接管模式的扩展不带会话装载 → 被拒（它按会话隔离，必须指定）',
    (await runtime.load('over')).ok === false);

  const loaded = await runtime.load('over', 'test', A);
  ok('在 A 会话装载接管扩展 = **只有 A 会话**被它接管',
    loaded.ok === true && runtime.isOverridden(A) === true && String(loaded.note).includes('接管'), JSON.stringify(loaded));

  ok('B 会话照常（附加扩展的工具还在）',
    runtime.isOverridden(B) === false
    && runtime.toolDefs(B).map((d) => d.name).join() === 'attach_tool',
    JSON.stringify(runtime.toolDefs(B).map((d) => d.name)));
  ok('A 会话的工具表只剩接管者的（附加扩展也让位）',
    runtime.toolDefs(A).map((d) => d.name).join() === 'over_tool',
    JSON.stringify(runtime.toolDefs(A).map((d) => d.name)));
  ok('A 会话的命令表只剩接管者的',
    runtime.commandDefs(A).map((c) => c.names[0]).join() === '/over',
    JSON.stringify(runtime.commandDefs(A).map((c) => c.names[0])));
  ok('B 会话的命令表照常（附加扩展的命令还在）',
    runtime.commandDefs(B).map((c) => c.names[0]).join() === '/atta',
    JSON.stringify(runtime.commandDefs(B).map((c) => c.names[0])));
  ok('A 会话的提示词计划是 override 形态，正文来自它',
    runtime.promptPlan(A).mode === 'override' && runtime.promptPlan(A).body.join() === '你是另一个东西。',
    JSON.stringify(runtime.promptPlan(A)));
  ok('B 会话的提示词计划照常是 attach 形态',
    runtime.promptPlan(B).mode === 'attach', JSON.stringify(runtime.promptPlan(B)));

  // 同一个会话同时只允许一个接管者；**不同会话互不相干**。
  const over2 = makeFakeEntry('over2', ['over2_tool'], {
    mode: 'override', overrideTools: { sendTool: 'over2_tool' }
  });
  const runtime2 = makeRuntime([over.entry, over2.entry], DEFAULT_EXTRAS);
  await runtime2.load('over', 'test', A);
  const clash2 = await runtime2.load('over2', 'test', A);
  ok('同一个会话已经有接管者时，第二个接管被拒（并告诉你怎么解）',
    clash2.ok === false && String(clash2.note).includes('先解除它'), JSON.stringify(clash2));
  ok('换个会话就能接管（两个会话各自一份，互不相干）',
    (await runtime2.load('over2', 'test', B)).ok === true && runtime2.isOverridden(B) === true);

  const back = await runtime.unload('over', A);
  ok('解除接管 = 那个会话交还主流程（工具表回到附加扩展）',
    back.ok === true && runtime.isOverridden(A) === false
    && runtime.toolDefs(A).map((d) => d.name).join() === 'attach_tool', JSON.stringify(back));
}

// ── 10b. 运行期把扩展关掉：接管必须**干净地退回主流程** ─────────────────────
//
// `extras.enabled` 在设置页写着"改完要重启"，但判据 `isExtraEnabled` 是**每次现读**的 ——
// 于是"关掉、不重启"这条路上有个静默的坏状态：会话仍被算作接管（`app.ts` 因此不拼内置工具），
// 而扩展的工具被启用闸门滤掉 ⇒ 模型手里**一个工具都没有**，却还拿着一份"接管"的系统提示。
// 表现是**那个群彻底不说话了，日志里一条线索都没有**。这一段的每一条都在钉它。
{
  const over = makeFakeEntry('live', ['live_tool'], {
    mode: 'override', overrideTools: { sendTool: 'live_tool' }
  });
  // `getConfig` 回的是同一个 `extrasConfig` 引用，所以直接改它 = 模拟设置页保存。
  const config = { ...DEFAULT_EXTRAS, enabled: { live: true } };
  const runtime = makeRuntime([over.entry], config);
  await runtime.load('live', 'test', G);

  ok('接管生效时：工具在表里、isOverridden 为真',
    runtime.isOverridden(G) === true
    && runtime.toolDefs(G).map((d) => d.name).join() === 'live_tool');

  config.enabled.live = false;   // 设置页保存 —— 但没重启

  ok('**关掉之后那个会话退出接管**（而不是"接管人格 + 零工具"）',
    runtime.isOverridden(G) === false, String(runtime.isOverridden(G)));
  ok('工具表不再只剩接管者那一个（调用方会照常拼上内置那部分）',
    runtime.toolDefs(G).length === 0, JSON.stringify(runtime.toolDefs(G).map((d) => d.name)));
  ok('提示词计划退成 attach（系统提示回到主人格）',
    runtime.promptPlan(G).mode === 'attach', JSON.stringify(runtime.promptPlan(G)));
  ok('命令表也交还（不让被关掉的扩展还占着命令词）',
    runtime.commandDefs(G).length === 0, JSON.stringify(runtime.commandDefs(G).map((c) => c.names)));
  ok('`/能力` 的列表如实反映：不再说它在接管这个群',
    (runtime.list().find((row) => row.id === 'live')?.overrides ?? ['x']).length === 0,
    JSON.stringify(runtime.list()));

  config.enabled.live = true;    // 重新打开
  ok('重新打开开关，接管就回来（绑定一直留着，不用重新加载）',
    runtime.isOverridden(G) === true
    && runtime.toolDefs(G).map((d) => d.name).join() === 'live_tool');
  await runtime.stop();
}

// 生命时间：**两种模式都受它约束**（配置里同一个数）。到点后附加的卸载实现、接管的交还主流程。
await withFakeTimers(async (timers) => {
  const over = makeFakeEntry('ttl_ov', ['ov_tool'], {
    mode: 'override', overrideTools: { sendTool: 'ov_tool' }
  });
  const normal = makeFakeEntry('ttl_at', ['at_tool']);
  const runtime = makeRuntime([over.entry, normal.entry], { ...DEFAULT_EXTRAS, idleUnloadMs: 1000 });
  await runtime.load('ttl_ov', 'test', G);
  await runtime.load('ttl_at');
  ok('接管绑定与附加装载各有一个计时器', timers.count() === 2, `实际 ${timers.count()} 个`);

  timers.advance(1000);
  await flush();
  ok('到点：附加的**卸载实现**、接管的**交还主流程**（两种模式都受生命时间约束）',
    normal.counters.dispose === 1 && runtime.isOverridden(G) === false && over.counters.dispose === 1,
    `over=${over.counters.dispose} normal=${normal.counters.dispose}`);
  await runtime.stop();
});

// 两个会话绑同一个接管扩展：实现只装载一次，其中一个到期时另一个照旧。
await withFakeTimers(async (timers) => {
  const over = makeFakeEntry('shared', ['shared_tool'], {
    mode: 'override', overrideTools: { sendTool: 'shared_tool' }
  });
  const runtime = makeRuntime([over.entry], { ...DEFAULT_EXTRAS, idleUnloadMs: 1000 });
  await runtime.load('shared', 'test', 'group:1');
  await runtime.load('shared', 'test', 'group:2');
  ok('两个会话绑同一个接管扩展：实现只 import 一次', over.counters.load === 1, `load=${over.counters.load}`);
  ok('两个会话都被接管', runtime.isOverridden('group:1') && runtime.isOverridden('group:2'));

  timers.advance(1000);
  await flush();
  ok('两个绑定一起到期 → 都交还主流程，实现也释放掉',
    !runtime.isOverridden('group:1') && !runtime.isOverridden('group:2') && over.counters.dispose === 1,
    `dispose=${over.counters.dispose}`);
  await runtime.stop();
});

// ── 11. 真实现跑一遍：声明与实现确实对得上，工具与命令都真的能算 ──────────────
{
  const runtime = makeRuntime(EXTRA_REGISTRY, { ...DEFAULT_EXTRAS, enabled: { clock: true } });
  ok('未装载时工具表是空的', runtime.toolDefs(G).length === 0);

  // 命令路径：**先显式装载**（命令不再隐式装载，见第 3 段），再真的算一次。
  const refused = await runtime.commandDefs(G)[0].run({
    chatKey: 'group:1', senderId: '5', text: '/时间 UTC', media: [], replyToMessageId: null
  }).then(() => '').catch((error) => String(error?.message ?? error));
  ok('真扩展：未装载时敲 `/时间` 只得到"先 /能力 加载"（不再把它拉起来）',
    refused.includes('/能力 加载 clock'), refused);

  await runtime.load('clock');
  const receipt = await runtime.commandDefs(G)[0].run({
    chatKey: 'group:1', senderId: '5', text: '/时间 UTC', media: [], replyToMessageId: null
  });
  ok('真扩展：显式装载之后敲 `/时间 UTC` 真的算了', String(receipt).includes('UTC'), String(receipt));
  ok('装载后工具进表', runtime.toolDefs(G).map((d) => d.name).join() === 'get_current_time');
  ok('词形列表随 spec 一路交到命令表（分发层靠它认 `/time`）',
    (runtime.commandDefs(G)[0].names ?? []).includes('/time'),
    JSON.stringify(runtime.commandDefs(G)[0].names));

  const tool = runtime.toolDefs(G)[0];
  const bad = await tool.execute({}, { timeZone: 'Not/AZone' });
  ok('时区填错返回可读错误而不是乱算', bad.isError === true && String(bad.content).includes('不认识的时区'), String(bad.content));
  const dflt = await tool.execute({}, {});
  ok('不填时区用默认时区', !dflt.isError && String(dflt.content).includes('Asia/Shanghai'), String(dflt.content));

  ok('真扩展的提示词计划里有那一段追加', runtime.promptPlan(G).append.length === 1, JSON.stringify(runtime.promptPlan(G)));
  await runtime.stop();
}

// ── 12. 工具接点：buildToolDefs 的默认行为逐字不变 ───────────────────────────
{
  const builtin = buildToolDefs();
  const extraNames = EXTRA_REGISTRY.flatMap((entry) => entry.tools.map((tool) => tool.name));
  ok('buildToolDefs() 无参输出里**没有**任何扩展工具（否则 13 处无参调用全被污染）',
    extraNames.every((name) => !builtin.some((def) => def.name === name)),
    `混进了：${extraNames.filter((name) => builtin.some((def) => def.name === name)).join('、')}`);

  const withExtra = buildToolDefs([{ name: 'zz_extra', description: 'x', parameters: {}, execute: async () => ({ content: '' }) }]);
  ok('扩展工具追加在内置之后，内置部分逐字不变',
    withExtra.length === builtin.length + 1
    && withExtra.at(-1).name === 'zz_extra'
    && JSON.stringify(withExtra.slice(0, builtin.length).map((d) => d.name)) === JSON.stringify(builtin.map((d) => d.name)));
}

// ── 13. 源级断言：懒加载是真的（这两条不报错，整套设计就退化成"启动时全加载"）──
{
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const registrySrc = stripComments(read('src/extra/registry.ts'));
  const loadLines = registrySrc.split(/\r?\n/).filter((line) => /\bload\s*:/.test(line));
  // 判据是"**函数引用** + **字面量说明符**"这两件事，所以参数列表允许有内容（`(deps)`）：
  // 扩展可以收下宿主的口子（`ExtraRuntimeDeps`），而那不影响"说明符是字面量"这条 ——
  // 后者才是这条断言存在的理由（写成变量就搬不进包）。
  ok('registry.ts 每个 load 都是「函数引用 + 字面量说明符」（写成变量就搬不进包）',
    loadLines.length > 0 && loadLines.every((line) => /load\s*:\s*\([^)]*\)\s*=>\s*import\(\s*'\.\/[^']+\.js'\s*\)/.test(line)),
    loadLines.join(' | '));
  ok('registry.ts 不静态 import 任何扩展实现',
    !/^\s*import\b[^\n]*impl\.js/m.test(registrySrc));

  const runtimeSrc = stripComments(read('src/extra/runtime.ts'));
  ok('runtime.ts 不静态 import 任何扩展实现，也不 import 注册表',
    !/^\s*import\b[^\n]*impl\.js/m.test(runtimeSrc) && !/from\s*'\.\/registry\.js'/.test(runtimeSrc));

  // spec.ts 是静态 import 的那一份，它自己也不许碰实现。
  for (const entry of EXTRA_REGISTRY) {
    const specRel = `src/extra/${entry.id}/spec.ts`;
    ok(`${specRel} 不 import 实现（它是"声明静态"的承重墙）`,
      !/^\s*import\b[^\n]*impl\.js/m.test(stripComments(read(specRel))));
  }
}

// ── 14. 提示词目录：扩展的文案只有一处，且两个方向都对上 ─────────────────────
{
  const registryTools = EXTRA_REGISTRY.flatMap((entry) => entry.tools);
  const registryIds = EXTRA_REGISTRY.map((entry) => entry.id);

  const notFromCatalog = registryTools.filter((tool) => EXTRA_PROMPT_TEXT[tool.name]?.description !== tool.description);
  ok('每个扩展工具的 description 都逐字取自 EXTRA_PROMPT_TEXT（不许在 spec 里自己写一份）',
    notFromCatalog.length === 0, notFromCatalog.map((tool) => tool.name).join('、'));

  const badDisplay = EXTRA_REGISTRY.filter((entry) => EXTRA_PROMPT_TEXT[entry.tools[0]?.name]?.displayDesc !== entry.displayDesc);
  ok('每个扩展的 displayDesc 也取自那张表（设置页那一行与文案同源）',
    badDisplay.length === 0, badDisplay.map((entry) => entry.id).join('、'));

  // ⚠️ 这条**是双向的**：少一个 = 加了扩展忘了写文案；多一个 = 删了扩展忘删文案。
  const declared = Object.keys(EXTRA_PROMPT_TEXT).sort();
  const expected = registryTools.map((tool) => tool.name).sort();
  ok('EXTRA_PROMPT_TEXT 的键集合与注册表的工具名逐个对上',
    declared.length > 0 && JSON.stringify(declared) === JSON.stringify(expected),
    `表里 ${declared.join('、')}；注册表 ${expected.join('、')}`);

  const sectionKeys = Object.keys(EXTRA_PROMPT_SECTIONS).sort();
  ok('EXTRA_PROMPT_SECTIONS 的键集合与注册表的扩展 id 逐个对上',
    sectionKeys.length > 0 && JSON.stringify(sectionKeys) === JSON.stringify([...registryIds].sort()),
    `表里 ${sectionKeys.join('、')}；注册表 ${[...registryIds].sort().join('、')}`);

  // 第三张表：扩展**自己发起的一次模型调用**的指令（不是工具说明、也不是常驻段落）。
  //
  // ⚠️ 对账方向与上面两张表**不同**：这里只查**子集**，不查相等。判据是"一个扩展需不需要
  // 一次性任务"是它自己的事（`clock` 就没有），要求每个扩展都占一行只会逼人填个空对象；
  // 而真正要防的是反过来的那种：扩展改名/搬走之后，它那份任务文案**静静留在表里没人用**。
  const jobKeys = Object.keys(EXTRA_PROMPT_JOBS).sort();
  const orphanJobs = jobKeys.filter((id) => !registryIds.includes(id));
  ok('EXTRA_PROMPT_JOBS 的键都是注册表里真的有的扩展（没有孤儿文案）',
    jobKeys.length > 0 && orphanJobs.length === 0,
    `表里 ${jobKeys.join('、')}；孤儿 ${orphanJobs.join('、')}`);
  ok('每个任务文案都有 system 与 user，且 user 是函数（动态部分由调用方传，不写死字面量）',
    Object.values(EXTRA_PROMPT_JOBS).every((jobs) => Object.values(jobs).every(
      (job) => typeof job.system === 'string' && job.system.length > 0 && typeof job.user === 'function')));

  // "core 能 import extra"之所以不成环，全靠 `extra/prompts.ts` 自己不 import 任何东西。
  const promptsSrc = stripComments(fs.readFileSync(path.join(ROOT, 'src/extra/prompts.ts'), 'utf8'));
  ok('extra/prompts.ts 是叶子模块：里面没有任何相对 import（那条例外的全部依据）',
    !/^\s*import\b[^\n]*['"]\./m.test(promptsSrc),
    '加了一条 import 就可能成环 —— 先读那个文件顶部的说明');
}

// ── 15. 配置：接管绑定是**静态数据**，启动时按它播种 ────────────────────────
//
// 绑定写在 `data/config.json` 的 `extras.override`（会话 → 扩展 id），改完重启生效。
// 群里敲 `/能力 加载` 建的那一份**不落盘**，重启后回到配置里写的这一份。
{
  const { updateConfig, getConfig } = await load('core/config.js');
  const next = updateConfig({
    extras: {
      override: {
        'group:123': 'clock',
        'private:456': 'clock',
        '不是会话键': 'clock',      // 丢：键必须形如 group:/private:
        'group:789': '   ',         // 丢：空值
        'group:999': 'clock'
      }
    }
  });
  ok('接管绑定只留形如 group:/private: 的键与非空值（脏值静默丢，不报错）',
    JSON.stringify(next.extras.override) === JSON.stringify({
      'group:123': 'clock', 'private:456': 'clock', 'group:999': 'clock'
    }), JSON.stringify(next.extras.override));
  ok('它落进 getConfig()（静态数据，重启后还在）', getConfig().extras.override['group:123'] === 'clock');
}

// start() 按配置播种：**要真的把实现拉起来**，否则那个会话只会静默退回主流程，
// 而用户写的配置看起来生效了 —— 本仓库最忌讳的那类故障。
{
  const ov = makeFakeEntry('seeded', ['seeded_tool'], {
    mode: 'override', overrideTools: { sendTool: 'seeded_tool' }
  });
  const runtime = makeRuntime([ov.entry], { ...DEFAULT_EXTRAS, override: { 'group:5': 'seeded' } });
  await runtime.start();
  ok('start() 把配置里的接管播种下去，并真的装载了实现',
    runtime.isOverridden('group:5') === true && ov.counters.load === 1, `load=${ov.counters.load}`);
  ok('没绑的会话不受影响', runtime.isOverridden('group:6') === false);
  await runtime.stop();

  // 写错的绑定只记日志、不抛：一个扩展坏了不该把 app.start() 掀翻（同 initPicImageSearch 的先例）。
  const attachOnly = makeFakeEntry('attach_only', ['t']);
  const bad1 = makeRuntime([attachOnly.entry], { ...DEFAULT_EXTRAS, override: { 'group:5': 'attach_only' } });
  await bad1.start();
  ok('配置里绑了一个**非接管模式**的扩展 → 忽略（不抛、不生效）',
    bad1.isOverridden('group:5') === false);
  const bad2 = makeRuntime([ov.entry], { ...DEFAULT_EXTRAS, override: { 'group:5': '不存在' } });
  await bad2.start();
  ok('配置里绑了不存在的扩展 → 忽略（不抛）', bad2.isOverridden('group:5') === false);
}

// ── 16. 运行结束钩子：只有**正在接管那个会话**的扩展才收得到 ─────────────────
//
// 它存在的理由：跑团的"兜底建议"要挂在"一次 agent 运行结束了"这个时刻上，而那件事只有
// `chat/sessions.ts` 的 `finish()` 知道（`chat` 不能 import `extra`，所以走组装根的回调）。
//
// 判据复用 `#overrideEntry`（与 `toolDefs` / `promptPlan` 同一处）：它同时管"这个会话有没有
// 被接管"、"那个扩展此刻还装不装"、"它还**能不能用**"。**附加模式的扩展没有"这一轮"的概念**，
// 没绑这个会话的接管者也一样 —— 把钩子发给他们，症状是"某个扩展忽然开始对不属于它的回合做反应"。
{
  const run = { chatKey: 'group:n1', status: 'noreply', sentCount: 0, trigger: [] };

  // 附加模式（默认 attach）：收不到 —— 它不接管任何会话。
  let attachHit = 0;
  const attach = makeFakeEntry('re_attach', ['t'], { onRunEnd: () => { attachHit += 1; } });
  const rt1 = makeRuntime([attach.entry], { ...DEFAULT_EXTRAS, enabled: { re_attach: true } });
  await rt1.load('re_attach');
  rt1.runEnded(run);
  await flush();
  ok('**附加模式的扩展收不到 onRunEnd**（它没有"这一轮"）',
    attachHit === 0 && attach.counters.runEnd === 0);

  // 接管模式，但绑的是**别的**会话：也收不到。
  let otherHit = 0;
  const other = makeFakeEntry('re_other', ['say'], {
    mode: 'override', overrideTools: { sendTool: 'say' }, onRunEnd: () => { otherHit += 1; }
  });
  const rt2 = makeRuntime([other.entry], { ...DEFAULT_EXTRAS, enabled: { re_other: true } });
  await rt2.load('re_other', 'test', 'group:elsewhere');
  rt2.runEnded(run);
  await flush();
  ok('接管了**别的**会话的扩展收不到这个会话的 onRunEnd（接管是按会话隔离的）', otherHit === 0);

  // 接管了这个会话：收得到，且拿到的是这次收尾的快照本身。
  let got = null;
  const mine = makeFakeEntry('re_mine', ['say'], {
    mode: 'override',
    overrideTools: { sendTool: 'say' },
    onRunEnd: (session) => { got = session; }
  });
  const rt3 = makeRuntime([mine.entry], { ...DEFAULT_EXTRAS, enabled: { re_mine: true } });
  await rt3.load('re_mine', 'test', run.chatKey);
  rt3.runEnded(run);
  await flush();
  ok('接管了这个会话的扩展收到 onRunEnd，拿到的是这次收尾的快照',
    mine.counters.runEnd === 1 && got === run, JSON.stringify(got));

  // 扩展被关掉（**不重启**）之后立即不再收 —— 与 `toolDefs` / `promptPlan` 同一个判据，
  // 也避免了"扩展已经停用、钩子还在往它身上打"那种静默的坏状态。
  //
  // ⚠️ `defaultEnabled: false` 是必须的：`isExtraEnabled` 在 `enabled` 里查不到时**回落到
  // `defaultEnabled`**，所以"把 enabled 清空"对一个默认开的扩展等于什么都没做（第一版就是这么
  // 假绿的：关掉之后钩子照跑）。
  const live = { ...DEFAULT_EXTRAS, enabled: { re_off: true } };
  let offHit = 0;
  const toggled = makeFakeEntry('re_off', ['say'], {
    defaultEnabled: false,
    mode: 'override', overrideTools: { sendTool: 'say' }, onRunEnd: () => { offHit += 1; }
  });
  const rt4 = createExtrasRuntime([toggled.entry], {
    getConfig: () => ({ extras: live }), builtinToolNames: [], log: () => {}
  });
  await rt4.load('re_off', 'test', run.chatKey);
  rt4.runEnded(run);
  await flush();
  ok('开着的时候收得到（对照：不是一直都不收）', offHit === 1, String(offHit));
  live.enabled = {};
  rt4.runEnded(run);
  await flush();
  ok('**关掉扩展之后立即收不到**（不重启也生效，判据是现读的 enabled）', offHit === 1, String(offHit));

  // 实现没有 onRunEnd：静默跳过，不抛也不报错（附加模式与 clock 就是这样）。
  const noHook = makeFakeEntry('re_none', ['say'], { mode: 'override', overrideTools: { sendTool: 'say' } });
  const rt5 = makeRuntime([noHook.entry], { ...DEFAULT_EXTRAS, enabled: { re_none: true } });
  await rt5.load('re_none', 'test', run.chatKey);
  let threw = false;
  try { rt5.runEnded(run); await flush(); } catch { threw = true; }
  ok('实现没有 onRunEnd 时静默跳过（不抛、不报错）', threw === false);

  // 钩子抛错**不该掀翻收尾**（它是旁路：会话已经落盘、索引已经更新）。
  const boom = makeFakeEntry('re_boom', ['say'], {
    mode: 'override',
    overrideTools: { sendTool: 'say' },
    onRunEnd: () => { throw new Error('钩子炸了'); }
  });
  const rt6 = makeRuntime([boom.entry], { ...DEFAULT_EXTRAS, enabled: { re_boom: true } });
  await rt6.load('re_boom', 'test', run.chatKey);
  let boomThrew = false;
  try { rt6.runEnded(run); await flush(); } catch { boomThrew = true; }
  ok('onRunEnd 抛错只记日志，不往上抛（`SessionRegistry.finish` 还等着返回呢）', boomThrew === false);

  // `load(deps)` 收得到宿主的口子 —— 扩展要靠它做"只有宿主才知道怎么做"的事
  // （跑团的 `deliverNote` 就是那条：把机器条目送进会话）。
  ok('扩展的 load(deps) 收得到宿主的口子（否则扩展只能自己 import 那条链，而那是反向依赖）',
    mine.seen.deps?.deliverNote === undefined || typeof mine.seen.deps?.deliverNote === 'function',
    JSON.stringify(Object.keys(mine.seen.deps ?? {})));
  const sent = [];
  const sink = makeFakeEntry('re_sink', ['t']);
  const rt7 = makeRuntime([sink.entry], { ...DEFAULT_EXTRAS, enabled: { re_sink: true } }, [],
    { deliverNote: (chatKey, note) => sent.push({ chatKey, ...note }) });
  await rt7.load('re_sink');
  sink.seen.deps.deliverNote('group:n2', { kind: 'journal', text: '知道了' });
  ok('那个口子真的是组装根递进来的那一个（能一路调回去）',
    sent.length === 1 && sent[0].chatKey === 'group:n2' && sent[0].text === '知道了',
    JSON.stringify(sent));
}

// ── 17. 运行期配置覆盖：只叠在**这一轮运行**上 ─────────────────────────────
//
// 这一段的判据全部是"不报错地坏掉"那类：补丁没生效 = 模型按旧配置跑；补丁落到了全局 =
// **别的会话**跟着变（接管是会话级的，而 config 不是）。所以逐条钉，尤其是"全局没被改"。
//
// ⚠️ 这里**用真配置**（`getConfig()`）建运行时，而不是套件别处那个 `makeRuntime` ——
// 那个喂的是只有 `extras` 一栏的极简假配置，而本段要断言的正是"全局那份一个字没动"。
{
  const { getConfig } = await load('core/config.js');
  const withRealConfig = (registry) => createExtrasRuntime(registry, {
    getConfig, builtinToolNames: [], log: () => {}
  });
  // 基线：用 `extras.idleUnloadMs` 当观测点 —— 它在全局配置里、且有归一化钳制（上限 24h）。
  const baseIdle = getConfig().extras.idleUnloadMs;
  const baseRounds = getConfig().api.maxRounds;

  const patcher = makeFakeEntry('patcher', ['t'], {
    configPatch: { api: { maxRounds: 42 }, extras: { idleUnloadMs: 999999999 } }
  });
  const runtime = withRealConfig([patcher.entry]);

  ok('未装载时 configFor 就是全局那份', runtime.configFor(G).api.maxRounds === baseRounds);
  await runtime.load('patcher');
  const patched = runtime.configFor(G);
  ok('装载后 configFor 叠上了补丁', patched.api.maxRounds === 42);
  ok('补丁照样走归一化（超上限的值被掐回 24h）',
    patched.extras.idleUnloadMs === 24 * 60 * 60 * 1000, String(patched.extras.idleUnloadMs));
  ok('**全局那份一个字没动**（不落盘、不外溢到别的地方）',
    getConfig().api.maxRounds === baseRounds && getConfig().extras.idleUnloadMs === baseIdle,
    JSON.stringify({ maxRounds: getConfig().api.maxRounds, idle: getConfig().extras.idleUnloadMs }));
  ok('同一份补丁对别的会话也生效（它是**装载**出来的，不是按会话绑的）',
    runtime.configFor('group:other').api.maxRounds === 42);

  await runtime.unload('patcher');
  ok('卸载即撤销', runtime.configFor(G).api.maxRounds === baseRounds);
  await runtime.stop();
}

// 接管模式下**只有接管者的补丁**（与工具表 / 命令表 / 提示词同一套判据）。
{
  const { getConfig } = await load('core/config.js');
  const withRealConfig = (registry) => createExtrasRuntime(registry, {
    getConfig, builtinToolNames: [], log: () => {}
  });
  const attach = makeFakeEntry('cfg_at', ['at_tool'], { configPatch: { api: { maxRounds: 11 } } });
  const over = makeFakeEntry('cfg_ov', ['ov_tool'], {
    mode: 'override', overrideTools: { sendTool: 'ov_tool' }, configPatch: { api: { maxRounds: 99 } }
  });
  const runtime = withRealConfig([attach.entry, over.entry]);
  const A = 'group:700';
  await runtime.load('cfg_at');
  ok('附加扩展的补丁生效', runtime.configFor(A).api.maxRounds === 11);
  await runtime.load('cfg_ov', 'test', A);
  ok('接管之后只剩接管者的补丁（附加那个让位）', runtime.configFor(A).api.maxRounds === 99,
    String(runtime.configFor(A).api.maxRounds));
  ok('**别的会话**不受接管影响（那边仍是附加扩展那份）',
    runtime.configFor('group:701').api.maxRounds === 11,
    String(runtime.configFor('group:701').api.maxRounds));
  await runtime.stop();
}

// 装载期对账：写坏的 `configPatch` 拒绝装载（否则症状是"这个扩展装不上"，与配置毫无关系）。
{
  {
    const runtime = makeRuntime([{
      id: 'badpatch2', title: 'badpatch2', displayDesc: 'x', defaultEnabled: true,
      tools: [], async load() { return { handlers: {}, configPatch: () => '不是对象' }; }
    }], DEFAULT_EXTRAS);
    const result = await runtime.load('badpatch2');
    ok('configPatch 返回非对象 → 拒绝装载', result.ok === false && String(result.note).includes('补丁对象'), JSON.stringify(result));
  }
  {
    const runtime = makeRuntime([{
      id: 'throwpatch', title: 'throwpatch', displayDesc: 'x', defaultEnabled: true,
      tools: [], async load() { return { handlers: {}, configPatch: () => { throw new Error('炸'); } }; }
    }], DEFAULT_EXTRAS);
    const result = await runtime.load('throwpatch');
    ok('configPatch 抛错 → 拒绝装载（空会话那次调用就炸了）',
      result.ok === false && String(result.note).includes('configPatch() 抛错'), JSON.stringify(result));
  }
  {
    const runtime = makeRuntime([{
      id: 'badintercept', title: 'badintercept', displayDesc: 'x', defaultEnabled: true,
      tools: [], async load() { return { handlers: {}, intercept: '不是函数' }; }
    }], DEFAULT_EXTRAS);
    const result = await runtime.load('badintercept');
    ok('intercept 不是函数 → 拒绝装载', result.ok === false && String(result.note).includes('intercept 必须是函数'), JSON.stringify(result));
  }
}

// ── 18. 拦消息：纯工具能力越过模型回复 ──────────────────────────────────────
const inbound = (text = '3d6') => ({
  chatKey: G, senderId: '5', text, media: [], replyToMessageId: 7
});
{
  const first = makeFakeEntry('ic1', ['t'], { intercept: () => ({ reply: '第一个' }) });
  const second = makeFakeEntry('ic2', ['ic2_tool'], { intercept: () => ({ reply: '第二个' }) });
  const runtime = makeRuntime([first.entry, second.entry], DEFAULT_EXTRAS);
  ok('未装载的扩展不会被问到', runtime.intercept(G, inbound()) === null);

  await runtime.load('ic1');
  ok('第一个说"我要"的赢（顺序即优先级）', runtime.intercept(G, inbound())?.reply === '第一个');
  await runtime.load('ic2');
  ok('后装载的抢不走（仍是注册表里靠前的那个）', runtime.intercept(G, inbound())?.reply === '第一个');
  await runtime.unload('ic1');
  ok('它卸载之后轮到下一个', runtime.intercept(G, inbound())?.reply === '第二个');

  const silent = makeFakeEntry('ic3', ['t'], { intercept: () => ({}) });
  const r3 = makeRuntime([silent.entry], DEFAULT_EXTRAS);
  await r3.load('ic3');
  const swallowed = r3.intercept(G, inbound());
  ok('返回空对象 = 拦下但**不吭声**（屏蔽 / 去重要的就是这个）',
    swallowed !== null && (swallowed.reply ?? null) === null, JSON.stringify(swallowed));

  const boom = makeFakeEntry('ic4', ['t'], { intercept: () => { throw new Error('炸'); } });
  const r4 = makeRuntime([boom.entry], DEFAULT_EXTRAS);
  await r4.load('ic4');
  ok('钩子抛错被吞掉、当它没接（绝不把异常打进接入链）', r4.intercept(G, inbound()) === null);

  const pass = makeFakeEntry('ic5', ['t'], { intercept: () => null });
  const r5 = makeRuntime([pass.entry], DEFAULT_EXTRAS);
  await r5.load('ic5');
  ok('返回 null = 不管这条（照常走模型）', r5.intercept(G, inbound()) === null);

  // 接管会话里**只有接管者**会被问到。
  const ov = makeFakeEntry('ic_ov', ['ov_tool'], { mode: 'override', overrideTools: { sendTool: 'ov_tool' }, intercept: () => ({ reply: '接管者' }) });
  const r6 = makeRuntime([first.entry, ov.entry], DEFAULT_EXTRAS);
  await r6.load('ic1');
  await r6.load('ic_ov', 'test', 'group:800');
  ok('接管会话里问的是接管者', r6.intercept('group:800', inbound())?.reply === '接管者');
  ok('别的会话问的还是附加那个', r6.intercept(G, inbound())?.reply === '第一个');
}

// ingest 端到端：拦下的消息**不惊动模型**，但照常存档、照常上面板。
{
  const { createIngest } = await load('web/onebot/ingest.js');
  const { createCommandDispatcher } = await load('web/onebot/commands.js');
  const { ChatStore } = await load('chat/store.js');
  const { DEFAULT_CONFIG } = await load('core/config.js');

  const store = new ChatStore();
  const sent = [];
  const forwarded = [];
  const cfgNow = { ...structuredClone(DEFAULT_CONFIG), allowAllWhenEmpty: true };
  const ingest = createIngest({
    onebot: { selfId: '9' },
    store,
    sender: { sendTextBatch: async (...args) => { sent.push(args); return {}; } },
    orchestrator: { onIncoming: (...args) => { forwarded.push(args); } },
    transcription: { enqueue: () => { throw new Error('不该入队'); } },
    imageGen: { enqueue: () => { throw new Error('不该入队'); } },
    jmcomic: { enqueue: () => { throw new Error('不该入队'); } },
    // 带上 `/能力` 的口子：下面要验群里 @ 闸门的**接线**，而没有口子时那一支会先返回
    // "扩展能力不可用"，两种情形长得一样（等于没验）。
    commands: createCommandDispatcher(() => ({ override: false, commands: [] }), {
      list: () => [],
      load: async (id) => ({ ok: true, note: `已加载「${id}」` }),
      unload: async (id) => ({ ok: true, note: `已卸载「${id}」` })
    }),
    // 只接 `3d6` 这一条；其余一律不管。
    extras: { intercept: (_chatKey, input) => (input.text.trim() === '3d6' ? { reply: '🎲 12' } : null) },
    emit: () => {},
    getConfig: () => cfgNow,
    log: () => {}
  });
  const groupId = 900001;
  const message = (text, id) => ({
    post_type: 'message', message_type: 'group', group_id: groupId, user_id: 5,
    message_id: id, sender: { user_id: 5, nickname: '甲' },
    message: [{ type: 'text', data: { text } }]
  });

  await ingest.handle(message('3d6', 1001));
  ok('拦下的消息**不惊动模型**（`onIncoming` 一次都没被调）', forwarded.length === 0, String(forwarded.length));
  ok('回执由**宿主**发进群（扩展碰不到 sender）',
    sent.length === 1 && String(sent[0][1]) === '🎲 12', JSON.stringify(sent));
  const archived = store.recent(`group:${groupId}`, { limit: 5 });
  ok('消息照常存档，且落成**已读**历史（与斜杠命令逐字同形）',
    archived.some((m) => String(m.text) === '3d6' && m.read === true),
    JSON.stringify(archived.map((m) => [m.text, m.read])));

  // 对照：不被拦的消息照常交给编排器 —— 没有这一条，上面那些"没被调"可能是假绿。
  await ingest.handle(message('3d6 是什么意思', 1002));
  ok('对照：不被拦的消息照常交给编排器', forwarded.length === 1, String(forwarded.length));
  ok('对照：同一条消息仍然**未读**（照常参与响应判定）',
    store.recent(`group:${groupId}`, { limit: 5 }).find((m) => String(m.text) === '3d6 是什么意思')?.read === false);

  // `@机器人 3d6` 同样要走到拦截里：命令判定用的那份文本掐掉了开头的 @（见 ingest 的
  // `stripLeadingSelfMentions`），拦截读的是同一份 —— 少了这条，`@bot 3d6` 会被当成普通
  // 消息交给模型，而扩展**永远等不到它**（与斜杠命令那条是同一个病）。
  const sentBefore = sent.length;
  await ingest.handle({
    post_type: 'message', message_type: 'group', group_id: groupId, user_id: 5,
    message_id: 1003, sender: { user_id: 5, nickname: '甲' },
    message: [{ type: 'at', data: { qq: '9' } }, { type: 'text', data: { text: ' 3d6' } }]
  });
  ok('★ `@机器人 3d6` 照样走到扩展拦截（拦截读的是掐掉 @ 的那份文本）',
    sent.length === sentBefore + 1 && String(sent.at(-1)[1]) === '🎲 12' && forwarded.length === 1,
    JSON.stringify({ sent: sent.length, forwarded: forwarded.length }));

  // `mentionedSelf` 的接线：群里 `/能力 加载` 的 @ 判据读的是它，而**文本里看不出 @ 过**
  // （开头那串 @ 已经被掐掉了）。这两条一起证明 ingest 真的从**原始段**算出来并递下去了 ——
  // 只钉其中一条都会漏掉"恒为 false"（那样群里 @ 了也照样被拒）或"恒为 true"（等于没做）。
  await ingest.handle({
    post_type: 'message', message_type: 'group', group_id: groupId, user_id: 5,
    message_id: 1004, sender: { user_id: 5, nickname: '甲' },
    message: [{ type: 'at', data: { qq: '9' } }, { type: 'text', data: { text: ' /能力 加载 x' } }]
  });
  ok('★ 群里 `@机器人 /能力 加载 x` 过了 @ 闸门（真的调到了装载口子）',
    String(sent.at(-1)[1]).includes('已加载'), String(sent.at(-1)[1]));

  const beforeNoAt = { sent: sent.length, forwarded: forwarded.length };
  await ingest.handle({
    post_type: 'message', message_type: 'group', group_id: groupId, user_id: 5,
    message_id: 1005, sender: { user_id: 5, nickname: '甲' },
    message: [{ type: 'text', data: { text: '/能力 加载 x' } }]
  });
  // 没 @ = **压根不是命令**（用户要的"完全不管"）：不回执，照普通消息交给编排器。
  ok('对照：同一句话没 @ 就**不是命令**（无回执，照常交给编排器）',
    sent.length === beforeNoAt.sent && forwarded.length === beforeNoAt.forwarded + 1,
    JSON.stringify({ sent: sent.length, forwarded: forwarded.length }));
}

// ── 19. 源级断言：两个新挂点在运行链路上真的接上了 ───────────────────────────
//
// 这两条守的是**接线**，不是行为：`agent-runner` 忘记用 `host.configFor`（覆盖压根不生效）、
// 或者用了却没把 `config` 交给提示词拼装（**只生效一半** —— 预算/档位那一半还是全局的）。
// 两者都零报错，而后者尤其像"覆盖生效了"。
{
  const agentSrc = fs.readFileSync(path.join(ROOT, 'src/agent/runtime/agent-runner.ts'), 'utf8');
  ok('agent-runner 用 `host.configFor`（而不是自己读全局），且只算一次',
    /const cfg = host\.configFor \? host\.configFor\(chatKey\) : getConfig\(\);/.test(agentSrc));
  ok('agent-runner 把那份 cfg 交给 system / user prompt 两处（漏一处就是"只生效一半"）',
    /config: cfg,\s*\n\s*persona: cfg\.persona,/.test(agentSrc) && /config: cfg,/.test(agentSrc));

  const appSrc = fs.readFileSync(path.join(ROOT, 'src/web/app.ts'), 'utf8');
  ok('组装根把 `extras.configFor` 递给 Orchestrator',
    /configFor: \(chatKey\) => extras\.configFor\(chatKey\)/.test(appSrc));
  ok('组装根把 `extras.intercept` 递给 ingest（只给这一个方法）',
    /extras: \{ intercept: \(chatKey, input\) => extras\.intercept\(chatKey, input\) \}/.test(appSrc));

  const ingestSrc = stripComments(fs.readFileSync(path.join(ROOT, 'src/web/onebot/ingest.ts'), 'utf8'));
  ok('ingest 在**落档之前**问拦截（否则 wakeEligible 只能按"不是命令"来定）',
    ingestSrc.indexOf('extras.intercept(') < ingestSrc.indexOf('store.appendIncoming('));
  ok('ingest 把拦下也计入 `wakeEligible: false`（与斜杠命令同一处判据）',
    /wakeEligible: !slashCommand && !intercepted/.test(ingestSrc));
}

process.exit(done() ? 0 : 1);
