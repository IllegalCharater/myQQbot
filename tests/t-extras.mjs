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
const { EXTRA_PROMPT_TEXT, EXTRA_PROMPT_SECTIONS } = await load('extra/prompts.js');
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

function makeRuntime(registry, extrasConfig, builtinToolNames = []) {
  return createExtrasRuntime(registry, {
    getConfig: () => ({ extras: extrasConfig }),
    builtinToolNames,
    log: () => {}
  });
}

/** 一条假工具声明（纯数据）。 */
const spec = (name) => ({ name, description: `${name} 的说明`, parameters: { type: 'object', properties: {}, required: [] } });
/** 一条假命令声明（纯数据，判据是纯函数）。 */
const cmd = (name) => ({ name, match: (text) => String(text).startsWith(name) });

/**
 * 一个可观察的假扩展：记录 load / dispose / 工具调用 / 命令调用四个计数。
 * `body` 可覆盖默认的执行体（用来造"在途不卸载"那种场景）。
 */
function makeFakeEntry(id, names, {
  defaultEnabled = true, mode = 'attach', commands = [], body = null, dispose = null, prompt = null
} = {}) {
  const counters = { load: 0, dispose: 0, run: 0, command: 0 };
  const entry = {
    id,
    title: id,
    displayDesc: `${id} 的说明`,
    mode,
    defaultEnabled,
    tools: names.map(spec),
    ...(commands.length ? { commands: commands.map(cmd) } : {}),
    async load() {
      counters.load += 1;
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
      rt.dispose = dispose === null ? () => { counters.dispose += 1; } : dispose;
      return rt;
    }
  };
  return { entry, counters };
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
    off.toolDefs().length === 0, `实际 ${off.toolDefs().length} 个`);

  const on = makeRuntime(EXTRA_REGISTRY, { ...DEFAULT_EXTRAS, enabled: { clock: true } });
  ok('**启用但未装载 → 工具仍然不在表里**（模型连"有这个能力"都看不到）',
    on.toolDefs().length === 0, JSON.stringify(on.toolDefs().map((d) => d.name)));
  ok('但命令敲得到（判据按 spec 静态，入口是人）',
    on.commandDefs().length === 1 && on.commandDefs()[0].match('/时间 Asia/Tokyo'));

  // 配置里没写这个 id 时用扩展自己的 defaultEnabled —— 这是"加一个扩展不用改配置"的前提。
  const fallback = makeRuntime(EXTRA_REGISTRY, { ...DEFAULT_EXTRAS, enabled: {} });
  ok('配置里没写这个 id → 用 defaultEnabled 兜底（命令表它就在，工具表仍然不在）',
    fallback.commandDefs().length === (clock.defaultEnabled ? 1 : 0)
    && fallback.toolDefs().length === 0);
}

// ── 2. 装载/卸载：工具表随之增减 ─────────────────────────────────────────────
{
  const { entry, counters } = makeFakeEntry('lazy', ['lazy_tool'], { commands: ['/lazy'] });
  const runtime = makeRuntime([entry], DEFAULT_EXTRAS);
  ok('装载之前 toolDefs() 里没有它', runtime.toolDefs().length === 0);
  ok('装载之前 isLoaded 是 false', runtime.isLoaded('lazy') === false && counters.load === 0);

  const loaded = await runtime.load('lazy', 'test');
  ok('load() 成功并真的跑了一次 import()', loaded.ok === true && counters.load === 1, JSON.stringify(loaded));
  ok('装载之后工具进表了', runtime.toolDefs().map((d) => d.name).join() === 'lazy_tool');

  const again = await runtime.load('lazy');
  ok('重复装载被拒（不重复 import）', again.ok === false && counters.load === 1, JSON.stringify(again));

  const gone = await runtime.unload('lazy');
  ok('unload() 成功、调了 dispose、工具表空了',
    gone.ok === true && counters.dispose === 1 && runtime.toolDefs().length === 0, JSON.stringify(gone));
  const gone2 = await runtime.unload('lazy');
  ok('重复卸载被拒', gone2.ok === false, JSON.stringify(gone2));
  const unknown = await runtime.load('nope');
  ok('装载不存在的 id 被拒', unknown.ok === false && String(unknown.note).includes('没有这个扩展'));

  // 关闭的扩展不许装载 —— 否则"配置里关着"这个闸门就能被 `/能力` 绕过。
  const disabled = makeRuntime([entry], { ...DEFAULT_EXTRAS, enabled: { lazy: false } });
  const refused = await disabled.load('lazy');
  ok('配置里关着的扩展装载被拒（闸门绕不过去）', refused.ok === false && String(refused.note).includes('关闭'));
}

// ── 3. 命令触发装载（入口是人） ───────────────────────────────────────────────
{
  const { entry, counters } = makeFakeEntry('viacmd', ['t'], { commands: ['/go'] });
  const runtime = makeRuntime([entry], DEFAULT_EXTRAS);
  const command = runtime.commandDefs()[0];
  ok('命令在扩展**未装载**时就敲得到', !!command && counters.load === 0);

  const receipt = await command.run({ chatKey: 'group:1', senderId: '5', text: '/go', media: [], replyToMessageId: null });
  ok('敲命令把扩展拉起来了（装载入口是人，不是模型）',
    receipt === 'viacmd 的命令回执' && counters.load === 1 && counters.command === 1,
    `${receipt} / load=${counters.load}`);
  ok('命令跑完之后工具表里也有它了', runtime.toolDefs().length === 1);
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
  ok('卸载之后工具表里也没了', runtime.toolDefs().length === 0);

  await runtime.load('ttl', 'test');
  ok('卸载之后再装载会重新 import（不是拿旧的）', counters.load === 2);

  // **每次执行都刷新空闲窗口**（滑动窗口，不是从装载时刻起算的固定租期）。
  const tool = runtime.toolDefs()[0];
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
  const pendingCall = runtime.toolDefs()[0].execute({}, {});
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
  ok('命令名跨扩展重复 → 构造函数抛错', !!dupCmd && dupCmd.includes('命令词/别名'), String(dupCmd));

  // 别名与主命令词**共用一个命名空间**：重了的话"先匹配到的先处理"会静默地决定谁赢，
  // 而两个命令的作者都以为自己的那个会被执行。
  const aliasClash = throws(() => makeRuntime([
    makeFakeEntry('a1', [], { commands: ['/天气'] }).entry,
    { ...makeFakeEntry('a2', [], { commands: ['/查天气'] }).entry, commands: [{ name: '/查天气', aliases: ['/天气'], match: () => true }] }
  ], DEFAULT_EXTRAS));
  ok('别名与别的扩展的主命令词重复 → 构造函数抛错',
    !!aliasClash && aliasClash.includes('命令词/别名'), String(aliasClash));

  const aliasSelfClash = throws(() => makeRuntime([
    { ...makeFakeEntry('a3', [], { commands: ['/x'] }).entry, commands: [{ name: '/x', aliases: ['/x'], match: () => true }] }
  ], DEFAULT_EXTRAS));
  ok('别名与自己的主命令词重复 → 构造函数抛错',
    !!aliasSelfClash && aliasSelfClash.includes('命令词/别名'), String(aliasSelfClash));

  const badAlias = throws(() => makeRuntime([
    { ...makeFakeEntry('a4', [], { commands: ['/x'] }).entry, commands: [{ name: '/x', aliases: ['time'], match: () => true }] }
  ], DEFAULT_EXTRAS));
  ok('别名不带斜杠开头 → 构造函数抛错', !!badAlias && badAlias.includes('必须带斜杠'), String(badAlias));

  const spaceAlias = throws(() => makeRuntime([
    { ...makeFakeEntry('a5', [], { commands: ['/x'] }).entry, commands: [{ name: '/x', aliases: ['/两 个字'], match: () => true }] }
  ], DEFAULT_EXTRAS));
  ok('别名含空白 → 构造函数抛错', !!spaceAlias && spaceAlias.includes('不能含空白'), String(spaceAlias));

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
    tools: [], commands: [{ name: '/x', match: 'not-a-function' }],
    async load() { return { handlers: {} }; }
  }], DEFAULT_EXTRAS));
  ok('命令的 match 不是函数 → 构造函数抛错', !!badMatch && badMatch.includes('match 不是函数'), String(badMatch));
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
  ok('被拒之后没有留在装载表里（下次还能再试）', !runtime.isLoaded('mismatch') && runtime.toolDefs().length === 0);

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
}

// ── 9. 提示词计划随装载状态变化（"动态"那条取舍的唯一判据）────────────────────
{
  const { entry } = makeFakeEntry('talk', ['t'], { prompt: { append: ['【提醒】记住我很啰嗦。'] } });
  const runtime = makeRuntime([entry], DEFAULT_EXTRAS);
  ok('未装载 → 计划里没有它的贡献',
    JSON.stringify(runtime.promptPlan()) === JSON.stringify({ mode: 'attach', append: [], override: {} }),
    JSON.stringify(runtime.promptPlan()));

  await runtime.load('talk');
  ok('装载后 → 追加段落出现在计划里',
    runtime.promptPlan().mode === 'attach' && runtime.promptPlan().append.includes('【提醒】记住我很啰嗦。'),
    JSON.stringify(runtime.promptPlan()));

  await runtime.unload('talk');
  ok('卸载后 → 贡献又消失（这就是"随装载状态变化"）',
    runtime.promptPlan().append.length === 0, JSON.stringify(runtime.promptPlan()));
}

// ── 10. 接管模式 ────────────────────────────────────────────────────────────
{
  const attach = makeFakeEntry('atta', ['attach_tool'], { commands: ['/atta'] });
  const over = makeFakeEntry('over', ['over_tool'], { mode: 'override', commands: ['/over'], prompt: { body: ['你是另一个东西。'] } });
  const runtime = makeRuntime([attach.entry, over.entry], DEFAULT_EXTRAS);

  await runtime.load('atta');
  ok('接管之前：附加扩展的工具在表里、isOverridden 为假',
    runtime.toolDefs().map((d) => d.name).join() === 'attach_tool' && runtime.isOverridden() === false);

  const loaded = await runtime.load('over');
  ok('装载接管扩展 = 接管生效（不需要额外参数）',
    loaded.ok === true && runtime.isOverridden() === true && String(loaded.note).includes('接管'), JSON.stringify(loaded));

  ok('接管后工具表**只剩接管者的**（附加扩展的工具也让位）',
    runtime.toolDefs().map((d) => d.name).join() === 'over_tool',
    JSON.stringify(runtime.toolDefs().map((d) => d.name)));
  ok('接管后命令表也只剩接管者的',
    runtime.commandDefs().map((c) => c.name).join() === '/over',
    JSON.stringify(runtime.commandDefs().map((c) => c.name)));
  ok('接管后提示词计划是 override 形态，正文来自它',
    runtime.promptPlan().mode === 'override' && runtime.promptPlan().body.join() === '你是另一个东西。',
    JSON.stringify(runtime.promptPlan()));

  // 同一时刻只允许一个接管者。
  const over2 = makeFakeEntry('over2', ['over2_tool'], { mode: 'override' });
  const runtime2 = makeRuntime([over.entry, over2.entry], DEFAULT_EXTRAS);
  await runtime2.load('over');
  const second = await runtime2.load('over2');
  ok('已经有一个接管者时，第二个接管装载被拒（并告诉你怎么解）',
    second.ok === false && String(second.note).includes('先卸载它'), JSON.stringify(second));

  const back = await runtime.unload('over');
  ok('卸载接管者 = 主流程交还（工具表回到附加扩展）',
    back.ok === true && runtime.isOverridden() === false
    && runtime.toolDefs().map((d) => d.name).join() === 'attach_tool', JSON.stringify(back));
}

// 接管者**不被空闲卸载**：它是明确的状态切换，静默变回去会让群友看到 bot 的人格与能力
// 突然改了，而没有任何人做过什么。要交还只能用 `/能力 卸载`。
await withFakeTimers(async (timers) => {
  const over = makeFakeEntry('pin', ['pin_tool'], { mode: 'override' });
  const normal = makeFakeEntry('normal', ['normal_tool']);
  const runtime = makeRuntime([over.entry, normal.entry], { ...DEFAULT_EXTRAS, idleUnloadMs: 1000 });
  await runtime.load('pin');
  await runtime.load('normal');
  ok('接管者不 arm 空闲计时器（只有附加扩展那一个）', timers.count() === 1, `实际 ${timers.count()} 个`);

  timers.advance(60000);
  await flush();
  ok('推进一整个窗口：附加扩展被卸载了，接管者还在',
    over.counters.dispose === 0 && normal.counters.dispose === 1 && runtime.isOverridden() === true,
    `over=${over.counters.dispose} normal=${normal.counters.dispose}`);

  await runtime.unload('pin');
  ok('`/能力 卸载` 才把接管者收掉', over.counters.dispose === 1 && runtime.isOverridden() === false);
  await runtime.stop();
});

// ── 11. 真实现跑一遍：声明与实现确实对得上，工具与命令都真的能算 ──────────────
{
  const runtime = makeRuntime(EXTRA_REGISTRY, { ...DEFAULT_EXTRAS, enabled: { clock: true } });
  ok('未装载时工具表是空的', runtime.toolDefs().length === 0);

  // 命令路径：装起来 + 真的算一次。
  const receipt = await runtime.commandDefs()[0].run({
    chatKey: 'group:1', senderId: '5', text: '/时间 UTC', media: [], replyToMessageId: null
  });
  ok('真扩展：敲 `/时间 UTC` 把它装载起来并真的算了', String(receipt).includes('UTC'), String(receipt));
  ok('装载后工具进表', runtime.toolDefs().map((d) => d.name).join() === 'get_current_time');
  ok('别名随 spec 一路交到命令表（分发层靠它认 `/time`）',
    (runtime.commandDefs()[0].aliases ?? []).includes('/time'),
    JSON.stringify(runtime.commandDefs()[0].aliases));

  const tool = runtime.toolDefs()[0];
  const bad = await tool.execute({}, { timeZone: 'Not/AZone' });
  ok('时区填错返回可读错误而不是乱算', bad.isError === true && String(bad.content).includes('不认识的时区'), String(bad.content));
  const dflt = await tool.execute({}, {});
  ok('不填时区用默认时区', !dflt.isError && String(dflt.content).includes('Asia/Shanghai'), String(dflt.content));

  ok('真扩展的提示词计划里有那一段追加', runtime.promptPlan().append.length === 1, JSON.stringify(runtime.promptPlan()));
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
  ok('registry.ts 每个 load 都是「函数引用 + 字面量说明符」（写成变量就搬不进包）',
    loadLines.length > 0 && loadLines.every((line) => /load\s*:\s*\(\)\s*=>\s*import\(\s*'\.\/[^']+\.js'\s*\)/.test(line)),
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

  // "core 能 import extra"之所以不成环，全靠 `extra/prompts.ts` 自己不 import 任何东西。
  const promptsSrc = stripComments(fs.readFileSync(path.join(ROOT, 'src/extra/prompts.ts'), 'utf8'));
  ok('extra/prompts.ts 是叶子模块：里面没有任何相对 import（那条例外的全部依据）',
    !/^\s*import\b[^\n]*['"]\./m.test(promptsSrc),
    '加了一条 import 就可能成环 —— 先读那个文件顶部的说明');
}

process.exit(done() ? 0 : 1);
