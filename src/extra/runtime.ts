// 扩展的**运行时**：装载表 + 由它派生出来的三张表（工具 / 命令 / 提示词计划）。
//
// ── 谁能装载 ──
//
// **模型一个入口都没有。** 装载与卸载只由主流程那条 `/能力` 命令调 `load()` / `unload()`；
// 敲扩展自己的命令也能把它拉起来（入口同样是人）。工具路径**不允许**隐式装载 ——
// 未装载的扩展，它的工具根本不在工具表里（见 `toolDefs()`），所以模型连"有这个能力"都看不到。
//
// ── 三张表各自的筛选条件（别把它们"顺手统一"掉）──
//
//   • `toolDefs()`    —— 附加模式：**已装载**的扩展；接管模式：**只有接管者**的。
//     模型的入口只该看到"此刻真正可用的能力"。
//   • `commandDefs()` —— 附加模式：**已启用**的扩展；接管模式：**只有接管者**的。
//     命令的入口是人（判据按 spec 静态，敲得到），执行时才把扩展拉起来。
//   • `promptPlan()`  —— 只算**已装载**扩展的贡献（"随装载状态变化"那条取舍的落点）。
//
// ── 与仓库两条禁令的关系（写下来免得下一个人以为禁令被推翻了）──
//
// ① **工具分发本来就是被允许的字符串键分发**（`defs.find(d => d.name === name)`，与 OneBot `call`、
//    HTTP 路由同属"外部契约"）。这里没有新增分发机制，只是那个数组的成员会随装载状态增减。
// ② **这不是运行时注册表**：注册表是 `registry.ts` 的静态数组（函数引用 + 只 `for...of`），
//    本文件不做任何按键分发，也不接受运行期注册 —— 没有 `register(id, fn)` 这种口子。
//    本文件里的 `Map<id, slot>` 是**装载表**，不是分发表：它只被 `load`/`unload`/`#run*` 读写，
//    键来自注册表里已有的 id，从不参与"决定调谁"。
//
// ── 卸载的真相（别指望它省内存）──
//
// Node ESM **没有模块卸载**，`import()` 的缓存永驻：`dispose()` 之后那份代码仍在内存里。
// 卸载能回收的只有两样：扩展自己持有的重资源（子进程 / socket / 定时器 / 大缓存），
// 以及我们持有的那个引用。**所以没有 `dispose()` 的扩展，空闲卸载等于什么都没做。**
import { SlidingWindowBudget } from '../media/call-budget.js';
import { SYSTEM_FRAMEWORK_SECTIONS, SYSTEM_SECTION_IDS } from '../core/prompt-catalog.js';
import type { AppConfig } from '../core/config.js';
import type { PromptPlan } from '../core/prompt-catalog.js';
import type { ToolArguments, ToolContext, ToolDefinition, ToolResult } from '../agent/shared/types.js';
import type {
  ExtraCommand, ExtraCommandInput, ExtraEntry, ExtraMode, ExtraRuntime, ExtraSpec
} from './types.js';

export interface ExtrasDeps {
  /** 每次现读（`idleUnloadMs` / `maxLoadsPerHour` 改完即时生效；`enabled` 例外，见 registry.ts）。 */
  getConfig(): AppConfig;
  /**
   * 内置工具名，用来查重。由 `web/app.ts` 递 `buildToolDefs()` 的名字 —— 本文件不许 import
   * `agent/tools/index.js`（那会让 extra 反向依赖 agent 的实现；类型从 `agent/shared/types.js` 取
   * 是合法的向下依赖，**值**不是）。
   */
  builtinToolNames: readonly string[];
  log(...args: unknown[]): void;
}

/** 一次 `dispose()` 的等待上限：一个卡住的扩展不该把 `stopLifecycle` 挂死。 */
const DISPOSE_TIMEOUT_MS = 3000;

/** 装载表里的一格。 */
interface LoadedSlot {
  rt: ExtraRuntime;
  /** 在途调用数。**大于 0 时绝不 dispose** —— 那是"任务跑一半被抽掉子进程"的成因。 */
  inFlight: number;
  timer: ReturnType<typeof setTimeout> | null;
}

/** 一次可能被拒的执行。装载被拒、扩展没装载都会走到 `ok:false`。 */
type Attempt<T> = { ok: true; value: T } | { ok: false; reason: string };

export interface ExtraListRow {
  id: string;
  title: string;
  displayDesc: string;
  mode: ExtraMode;
  enabled: boolean;
  loaded: boolean;
}

export interface ExtraActionResult { ok: boolean; note: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 某个扩展此刻是否启用：配置里**显式**写明的优先，否则用它自己的 `defaultEnabled`。
 *
 * **唯一实现**。三处判的是同一件事：`toolDefs()`（模型看到什么）、`commandDefs()`（群友敲得到什么）、
 * `GET /api/extras`（面板显示什么）。各写一份的话，漂移的表现是"面板上明明开着、模型那边其实没有"
 * —— 两边都不报错，也没有人会去比对两处源码。
 *
 * ⚠️ 它**只**回答"启不启用"，不回答"装没装"：装载是**运行期状态**，由 `/能力` 命令改（见 `isLoaded`）。
 */
export function isExtraEnabled(entry: ExtraSpec, config: AppConfig): boolean {
  return config.extras?.enabled?.[entry.id] ?? entry.defaultEnabled;
}

/**
 * 注册表自检。**在构造函数里做**（不是 `start()`）：一个重名的工具会让 `defs.find()` 取到别人那个、
 * 扩展静默失效，而那种错误只可能来自 `src/` 里的代码，不是用户配置 —— 所以应当**尽早、响亮地**炸。
 *
 * 返回问题清单（空数组 = 没问题）。不抛错是为了让调用方决定怎么处理，也便于套件逐条断言。
 */
export function validateRegistry(
  registry: readonly ExtraEntry[],
  builtinToolNames: readonly string[]
): string[] {
  const problems: string[] = [];
  const builtin = new Set(builtinToolNames);
  const seenIds = new Set<string>();
  const seenTools = new Map<string, string>();      // 工具名 -> 先占它的扩展 id
  const seenCommands = new Map<string, string>();   // 命令名 -> 先占它的扩展 id

  for (const entry of registry) {
    const id = String(entry.id ?? '');
    if (!id) { problems.push('有一行扩展的 id 是空的'); continue; }
    if (seenIds.has(id)) problems.push(`扩展 id 重复：${id}`);
    seenIds.add(id);
    if (!String(entry.title ?? '').trim()) problems.push(`${id}: title 是空的（设置页会显示成空白）`);
    // displayDesc 是**给人看的那一句话**（不是模型看到的工具描述，见 types.ts）。
    // 空的后果是设置页那一行只剩一个光秃秃的开关，管理员看不出这个扩展是干什么的。
    if (!String(entry.displayDesc ?? '').trim()) {
      problems.push(`${id}: displayDesc 是空的（设置页那一行会没有说明，管理员看不出它是干什么的）`);
    }
    if (entry.mode !== undefined && entry.mode !== 'attach' && entry.mode !== 'override') {
      problems.push(`${id}: mode 只能是 'attach' 或 'override'，实际是 ${String(entry.mode)}`);
    }

    for (const spec of entry.tools ?? []) {
      const name = String(spec.name ?? '');
      if (!name) { problems.push(`${id}: 有一个工具没写 name`); continue; }
      if (builtin.has(name)) {
        problems.push(`${id}: 工具名 ${name} 与内置工具重名 —— defs.find() 会取到内置那个，这个扩展会静默失效`);
      }
      const owner = seenTools.get(name);
      if (owner) problems.push(`${id}: 工具名 ${name} 与扩展 ${owner} 重名`);
      else seenTools.set(name, id);
      if (!String(spec.description ?? '').trim()) {
        problems.push(`${id}.${name}: description 是空的（应当取自 extra/prompts.ts）`);
      }
      if (!isRecord(spec.parameters)) problems.push(`${id}.${name}: parameters 不是对象`);
    }

    for (const spec of entry.commands ?? []) {
      const name = String(spec.name ?? '');
      if (!name) { problems.push(`${id}: 有一个命令没写 name`); continue; }
      if (typeof spec.match !== 'function') problems.push(`${id}.${name}: match 不是函数`);
      // 命令词与别名不许重复（**跨扩展也要查**）：重了的话"先匹配到的先处理"会静默地
      // 决定谁赢，而两个命令的作者都以为自己的那个会被执行。
      for (const word of [name, ...(spec.aliases ?? [])]) {
        const text = String(word ?? '');
        if (!text.startsWith('/')) {
          problems.push(`${id}.${name}: 命令词「${text}」必须带斜杠开头（别名也一样）`);
          continue;
        }
        if (/\s/.test(text)) problems.push(`${id}.${name}: 命令词「${text}」不能含空白`);
        const owner = seenCommands.get(text);
        if (owner) problems.push(`${id}: 命令词/别名 ${text} 与 ${owner} 重复`);
        else seenCommands.set(text, id);
      }
    }
  }
  return problems;
}

/**
 * 声明 ⇄ 实现对账。**这是"声明与实现分居两处"唯一的真实漂移点**：`spec.ts` 里写了 `get_weather`
 * 而 `impl.ts` 的 `handlers` 里没有它，两边都不会报错，表现是"模型调得到、一调就报错"。
 * 所以装载时**两个方向都查**，对不上就拒绝装载。
 *
 * 能做这个检查的前提是 `ExtraRuntime.handlers` / `commandHandlers` 是"名字 → 函数"的映射
 * （见 types.ts 的说明）—— 名字集合必须可枚举，否则这句校验只能退化成"凭声明相信它"。
 */
export function checkRuntimeShape(entry: ExtraEntry, rt: ExtraRuntime): string | null {
  if (!isRecord(rt?.handlers)) return '没有导出 handlers（工具名 → 执行函数的映射）';
  const declaredTools = entry.tools.map((spec) => spec.name);
  const missingTools = declaredTools.filter((name) => typeof rt.handlers[name] !== 'function');
  if (missingTools.length) return `声明了却没有实现：${missingTools.join('、')}`;
  const undeclaredTools = Object.keys(rt.handlers).filter((name) => !declaredTools.includes(name));
  if (undeclaredTools.length) return `实现了却没有声明：${undeclaredTools.join('、')}`;

  // 命令同一套两个方向。没声明命令时 `commandHandlers` 允许缺席。
  const declaredCommands = (entry.commands ?? []).map((spec) => spec.name);
  const commandHandlers = isRecord(rt.commandHandlers) ? rt.commandHandlers : {};
  const missingCommands = declaredCommands.filter((name) => typeof commandHandlers[name] !== 'function');
  if (missingCommands.length) return `命令声明了却没有实现：${missingCommands.join('、')}`;
  const undeclaredCommands = Object.keys(commandHandlers).filter((name) => !declaredCommands.includes(name));
  if (undeclaredCommands.length) return `命令实现了却没有声明：${undeclaredCommands.join('、')}`;

  // 提示词覆盖的段名：**覆盖一个不存在的段落不会有任何报错**，表现是"配了、什么都没发生"，
  // 所以在这里拦下来（框架契约段也不许动，见 SYSTEM_FRAMEWORK_SECTIONS）。
  let contribution;
  try {
    contribution = rt.prompt?.();
  } catch (error) {
    return `prompt() 抛错：${errorMessage(error)}`;
  }
  const badSections = Object.keys(contribution?.override ?? {}).filter((id) => (
    !(SYSTEM_SECTION_IDS as readonly string[]).includes(id)
    || SYSTEM_FRAMEWORK_SECTIONS.includes(id as typeof SYSTEM_FRAMEWORK_SECTIONS[number])
  ));
  if (badSections.length) {
    return `prompt 覆盖了不存在或不允许覆盖的段落：${badSections.join('、')}` +
      `（可用：${SYSTEM_SECTION_IDS.filter((id) => !SYSTEM_FRAMEWORK_SECTIONS.includes(id)).join('、')}）`;
  }
  return null;
}

export class ExtrasRuntime {
  readonly #registry: readonly ExtraEntry[];
  readonly #entries = new Map<string, ExtraEntry>();
  readonly #loaded = new Map<string, LoadedSlot>();
  readonly #deps: ExtrasDeps;
  /**
   * 装载闸门。**实例级字段、跨调用累积**（同 `agent/tools/shared.ts` 的 `webBudget`）：
   * 放进装载路径里每次新建就等于没有闸门。
   *
   * 键是**扩展 id**而不是 chatKey —— 这道闸门防的是"反复起停同一个子进程"，
   * 那是一个**速率**问题，与是哪个群在问无关。`SlidingWindowBudget` 的两个窗口里，
   * 全局每天那一档按小时上限线性外推（24×）：只有一个旋钮，因为它只回答一个问题。
   */
  readonly #budget: SlidingWindowBudget;

  constructor(registry: readonly ExtraEntry[], deps: ExtrasDeps) {
    const problems = validateRegistry(registry, deps.builtinToolNames);
    if (problems.length) {
      throw new Error(`扩展注册表有问题：\n  - ${problems.join('\n  - ')}`);
    }
    this.#registry = registry;
    this.#deps = deps;
    for (const entry of registry) this.#entries.set(entry.id, entry);
    this.#budget = new SlidingWindowBudget({
      getLimits: () => {
        const perHour = Math.max(1, Math.trunc(Number(deps.getConfig().extras?.maxLoadsPerHour)) || 20);
        return { perChatPerHour: perHour, perDay: perHour * 24 };
      }
    });
  }

  // ── 三张表（都由"当前模式 + 装载表"派生）──

  /**
   * 模型可见的工具表。**未装载的扩展，工具不在表里** —— 这是"禁止模型自行加载"那条取舍的落点：
   * 模型的入口只该看到此刻真正可用的能力，它连"有这么个能力"都看不到，更没有"调用即加载"这条路。
   *
   * ⚠️ 表随装载状态变化 ⇒ 工具表是请求前缀的一部分，装载/卸载各打散一次提示词缓存。
   * 但装载由**人**通过 `/能力` 触发（频次很低），这正是这条设计换来的东西。
   */
  toolDefs(): ToolDefinition[] {
    const override = this.#overrideEntry();
    const config = this.#deps.getConfig();
    const out: ToolDefinition[] = [];
    for (const entry of this.#registry) {
      if (override && entry.id !== override.id) continue;       // 接管中：只有接管者的
      if (!override && !this.#loaded.has(entry.id)) continue;   // 附加：只含已装载的
      if (!isExtraEnabled(entry, config)) continue;
      for (const spec of entry.tools) {
        out.push({
          name: spec.name,
          description: spec.description,
          parameters: spec.parameters,
          execute: (ctx, args) => this.#runTool(entry.id, spec.name, ctx, args)
        });
      }
    }
    return out;
  }

  /**
   * 群友敲得到的扩展命令。判据来自 spec（**启用即可敲，不必先装载**），执行时才把扩展拉起来。
   *
   * **为什么这里按"已启用"而 `toolDefs()` 按"已装载"** —— 两个入口的人不同：命令的入口是**人**，
   * 工具的入口是**模型**。人有权决定要用什么，模型只该看到此刻可用的东西。别把这条不对称统一掉。
   */
  commandDefs(): ExtraCommand[] {
    const override = this.#overrideEntry();
    const config = this.#deps.getConfig();
    const out: ExtraCommand[] = [];
    for (const entry of this.#registry) {
      if (override && entry.id !== override.id) continue;
      if (!isExtraEnabled(entry, config)) continue;
      for (const spec of entry.commands ?? []) {
        out.push({
          name: spec.name,
          aliases: spec.aliases,
          match: spec.match,
          run: (input) => this.#runCommand(entry.id, spec.name, input)
        });
      }
    }
    return out;
  }

  /**
   * 扩展对 system prompt 的贡献计划。**只算已装载扩展的** —— 这条就是"随装载状态变化"的落点：
   * 装载后出现、卸载后消失。它不改"一次运行内不变"这条性质（`runAgent` 开头拼一次，
   * 之后整个工具循环都用它），所以真实语义是"**装载后，下一次运行开始生效**"。
   */
  promptPlan(): PromptPlan {
    const override = this.#overrideEntry();
    if (override) {
      const slot = this.#loaded.get(override.id);
      const body = readContribution(slot?.rt, this.#deps)?.body ?? [];
      return { mode: 'override', body: body.map(String).filter((text) => text.trim()) };
    }
    const append: string[] = [];
    const merged: Record<string, string> = {};
    for (const [id, slot] of this.#loaded) {
      const contribution = readContribution(slot.rt, this.#deps);
      if (!contribution) continue;
      for (const text of contribution.append ?? []) {
        const value = String(text);
        if (value.trim()) append.push(value);
      }
      for (const [section, text] of Object.entries(contribution.override ?? {})) {
        // 装载时已经拒过一遍（见 `checkRuntimeShape`），这里是第二道 —— 因为"覆盖了一个不存在
        // 或不允许覆盖的段落"不会有任何报错，表现只是"配了、什么都没发生"。
        if (!(SYSTEM_SECTION_IDS as readonly string[]).includes(section)) continue;
        if (SYSTEM_FRAMEWORK_SECTIONS.includes(section as typeof SYSTEM_FRAMEWORK_SECTIONS[number])) continue;
        if (section in merged) this.#deps.log(`[extras] ${id} 覆盖了 ${section}，但已被更早装载的扩展写过，取后者`);
        merged[section] = text == null ? '' : String(text);
      }
    }
    return { mode: 'attach', append, override: merged };
  }

  /** 给 `/能力` 与 `GET /api/extras` 看的注册表投影。 */
  list(): ExtraListRow[] {
    const config = this.#deps.getConfig();
    return this.#registry.map((entry) => ({
      id: entry.id,
      title: entry.title,
      displayDesc: entry.displayDesc,
      mode: entry.mode ?? 'attach',
      enabled: isExtraEnabled(entry, config),
      loaded: this.#loaded.has(entry.id)
    }));
  }

  isLoaded(id: string): boolean {
    return this.#loaded.has(id);
  }

  /**
   * 是否处于接管模式（有一个 `mode: 'override'` 的扩展装着）。
   *
   * 主流程的命令表按它决定让不让位 —— **但 `/能力` 永远留着**，它是卸载接管者的唯一入口
   * （见 `slash-commands.ts` 的 `OVERRIDE_KEPT_COMMANDS`）。少了它，装上一个接管扩展之后
   * 就再没有任何办法卸掉它。
   */
  isOverridden(): boolean {
    return this.#overrideEntry() !== null;
  }

  // ── 装载/卸载（**只有那条 `/能力` 命令与扩展自己的命令调它们**）──

  /**
   * 装载一个扩展。**模型侧没有调用者** —— 这是这一轮设计的核心。
   *
   * 装载一个 `mode: 'override'` 的扩展 = 它随即接管（不需要额外参数）。
   * 同一时刻只允许一个接管者：已经有一个在接管时，第二次接管被拒。
   */
  async load(id: string, reason = 'command'): Promise<ExtraActionResult> {
    const entry = this.#entries.get(id);
    if (!entry) return { ok: false, note: `没有这个扩展：${id}` };
    if (this.#loaded.has(id)) return { ok: false, note: `「${entry.title}」已经加载过了` };
    if (!isExtraEnabled(entry, this.#deps.getConfig())) {
      return { ok: false, note: `「${entry.title}」在设置里是关闭的，先把它打开（改完要重启）` };
    }
    if (entry.mode === 'override') {
      const current = this.#overrideEntry();
      if (current) return { ok: false, note: `当前由「${current.title}」接管，先卸载它：/能力 卸载 ${current.id}` };
    }
    const refusal = this.#takeLoadBudget(id);
    if (refusal) return { ok: false, note: refusal };

    let rt: ExtraRuntime;
    try {
      rt = await entry.load();
    } catch (error) {
      return { ok: false, note: `「${entry.title}」加载失败：${errorMessage(error)}` };
    }
    const problem = checkRuntimeShape(entry, rt);
    if (problem) {
      void this.#dispose(rt, id);
      return { ok: false, note: `「${entry.title}」不可用（${problem}）` };
    }
    const slot: LoadedSlot = { rt, inFlight: 0, timer: null };
    this.#loaded.set(id, slot);
    this.#deps.log(`[extras] 已加载 ${id}（${reason}）`);
    // 接管者不 arm 计时器 ⇒ 常驻不卸载，见 `#armTimer`。
    this.#armTimer(id, slot);
    return {
      ok: true,
      note: entry.mode === 'override'
        ? `已加载「${entry.title}」，从现在起由它接管（下一轮运行生效）`
        : `已加载「${entry.title}」`
    };
  }

  /** 卸载。接管者被卸载 = 主流程立刻交还（下一轮运行生效）。 */
  async unload(id: string): Promise<ExtraActionResult> {
    const entry = this.#entries.get(id);
    if (!entry) return { ok: false, note: `没有这个扩展：${id}` };
    const slot = this.#loaded.get(id);
    if (!slot) return { ok: false, note: `「${entry.title}」当前没有加载` };
    if (slot.inFlight > 0) return { ok: false, note: `「${entry.title}」正在执行中，等它跑完再卸载` };
    this.#loaded.delete(id);
    if (slot.timer) { clearTimeout(slot.timer); slot.timer = null; }
    await this.#dispose(slot.rt, id);
    this.#deps.log(`[extras] 已卸载 ${id}`);
    return {
      ok: true,
      note: entry.mode === 'override' ? `已卸载「${entry.title}」，主流程交还` : `已卸载「${entry.title}」`
    };
  }

  /**
   * 装配清单的 start。**它不预加载任何东西**（装载的入口是人，不是启动），
   * 只做一件真实的事：把装载状态清干净 —— 于是 `app.stop()` 之后再 `app.start()`，
   * 拿到的是一张空的装载表，而不是上一轮遗留的槽位。
   *
   * 注册表自检在构造函数里（见 `validateRegistry` 的说明），所以这里不重复。
   */
  start(): void {
    for (const [, slot] of this.#loaded) {
      if (slot.timer) { clearTimeout(slot.timer); slot.timer = null; }
    }
    this.#loaded.clear();
  }

  /**
   * 关停：清掉全部空闲计时器，并逐个 `dispose()` 已装载的扩展。
   *
   * 逆序拆清单时这条排最后 ⇒ 它**第一个**被收掉，不会拖着 OneBot 传输层一起等。
   * 幂等：第二次调用看到的是空表。**在途调用不做特殊处理** —— 走到这里说明
   * `abortAll()` 已经跑完，不会再有新的模型轮次。
   */
  async stop(): Promise<void> {
    const slots = [...this.#loaded.entries()];
    this.#loaded.clear();
    await Promise.all(slots.map(([id, slot]) => {
      if (slot.timer) { clearTimeout(slot.timer); slot.timer = null; }
      return this.#dispose(slot.rt, id);
    }));
  }

  // ── 内部 ──

  /**
   * 当前接管者（`mode: 'override'` 且**已装载**的那个）。**最多一个** —— 第二个接管者的装载
   * 在 `load()` 里就被拒了，所以这里 `for...of` 拿到第一个就是它。
   */
  #overrideEntry(): ExtraEntry | null {
    for (const id of this.#loaded.keys()) {
      const entry = this.#entries.get(id);
      if (entry?.mode === 'override') return entry;
    }
    return null;
  }

  /**
   * 两条执行路径共用的机械：确保已装载 → 计入在途 → 执行 → 出账并重新起表。
   *
   * `autoLoad` 是"这次执行能不能把扩展拉起来"：**只有命令路径为真**（入口是人），
   * 工具路径为假（未装载的扩展工具根本不在表里；这里为假是**第二道**，
   * 防的是"运行开始时装着、跑到一半被空闲卸载了"那种竞态）。
   */
  async #withExtra<T>(id: string, autoLoad: boolean, use: (rt: ExtraRuntime) => Promise<T>): Promise<Attempt<T>> {
    const entry = this.#entries.get(id);
    if (!entry) return { ok: false, reason: `扩展 ${id} 未注册` };
    let slot = this.#loaded.get(id);
    if (!slot) {
      if (!autoLoad) return { ok: false, reason: `「${entry.title}」当前没有加载，让群友先 /能力 加载 ${id}` };
      const result = await this.load(id, 'command');
      if (!result.ok) return { ok: false, reason: result.note };
      slot = this.#loaded.get(id);
      if (!slot) return { ok: false, reason: `「${entry.title}」装载失败` };
    }
    // 有活干就先把空闲计时器撤掉：TTL 是**滑动**的空闲窗口，不是从装载时刻起算的固定租期。
    if (slot.timer) { clearTimeout(slot.timer); slot.timer = null; }
    slot.inFlight += 1;
    try {
      return { ok: true, value: await use(slot.rt) };
    } finally {
      slot.inFlight -= 1;
      // 只有"还挂在表里的那一格"才重新起表：期间可能被 unload()/stop() 收掉、也可能已到点卸载。
      if (this.#loaded.get(id) === slot && slot.inFlight === 0) this.#armTimer(id, slot);
    }
  }

  async #runTool(id: string, name: string, ctx: ToolContext, args: ToolArguments): Promise<ToolResult> {
    const attempt = await this.#withExtra(id, false, async (rt) => {
      const handler = rt.handlers[name];
      if (typeof handler !== 'function') throw new Error(`扩展「${id}」没有工具「${name}」`);
      return handler(ctx, args);
    });
    if (attempt.ok) return attempt.value;
    return { content: `错误：${attempt.reason}`, isError: true };
  }

  /**
   * 命令路径。**装载在这里发生**（入口是人），失败**抛出** —— `web/onebot/slash-commands.ts`
   * 的外壳会把 `error.message` 原样发进群，那正是我们想要的（可执行的下一步）。
   */
  async #runCommand(id: string, name: string, input: ExtraCommandInput): Promise<string | null> {
    const attempt = await this.#withExtra(id, true, async (rt) => {
      const handler = rt.commandHandlers?.[name];
      if (typeof handler !== 'function') throw new Error(`扩展「${id}」没有命令「${name}」`);
      return handler(input);
    });
    if (!attempt.ok) throw new Error(attempt.reason);
    return attempt.value;
  }

  /** 领一次装载额度；超限返回一句话，未超限返回 null。**排在真正 load 之前**。 */
  #takeLoadBudget(id: string): string | null {
    try {
      this.#budget.take(id);
      return null;
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'RATE_LIMITED') throw error;
      const limit = Math.max(1, Math.trunc(Number(this.#deps.getConfig().extras?.maxLoadsPerHour)) || 20);
      return `「${id}」装载太频繁（每小时最多 ${limit} 次），稍后再试`;
    }
  }

  #armTimer(id: string, slot: LoadedSlot): void {
    const entry = this.#entries.get(id);
    // **接管者常驻**：它是一次明确的状态切换，静默变回去会让群友看到 bot 的人格与能力突然改了，
    // 而没有任何人做过什么。要交还只能用 `/能力 卸载`。
    if (entry?.mode === 'override') return;
    // 0 = 常驻不卸载（与仓库"0 = 不限"的惯例一致）。
    const ms = Math.max(0, Math.trunc(Number(this.#deps.getConfig().extras?.idleUnloadMs)) || 0);
    if (ms <= 0) return;
    slot.timer = setTimeout(() => this.#onIdle(id, slot), ms);
    // 别让一个空闲计时器把进程钉住 —— 与 price-feed / 历史压缩巡检同一条姿态。
    slot.timer.unref?.();
  }

  #onIdle(id: string, slot: LoadedSlot): void {
    slot.timer = null;
    if (this.#loaded.get(id) !== slot) return;                     // 已经被 unload()/stop() 换掉了
    if (slot.inFlight > 0) { this.#armTimer(id, slot); return; }    // 在途，推迟到下次空闲
    this.#loaded.delete(id);
    this.#deps.log(`[extras] 空闲卸载 ${id}`);
    void this.#dispose(slot.rt, id);
  }

  /**
   * 调 `dispose()` 并等它落地。**同步 dispose 不建计时器** —— 只有返回 thenable 时才起一个
   * 上限计时器，所以常见路径上不会多出一个句柄。
   */
  async #dispose(rt: ExtraRuntime, id: string): Promise<void> {
    try {
      const result = rt.dispose?.();
      if (!result || typeof (result as Promise<void>).then !== 'function') return;
      await Promise.race([
        result,
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, DISPOSE_TIMEOUT_MS);
          timer.unref?.();
        })
      ]);
    } catch (error) {
      // 卸载失败只记日志：它发生在关停路径或空闲时刻，抛出去会打断别人。
      this.#deps.log(`[extras] ${id} 卸载失败：${errorMessage(error)}`);
    }
  }
}

/** 读一次扩展的提示词贡献，任何异常都吞掉（它只是"加不加一段话"，不该掀翻整轮运行）。 */
function readContribution(rt: ExtraRuntime | undefined, deps: ExtrasDeps) {
  if (!rt || typeof rt.prompt !== 'function') return null;
  try {
    return rt.prompt() ?? null;
  } catch (error) {
    deps.log(`[extras] prompt() 抛错，本轮忽略它的提示词贡献：${errorMessage(error)}`);
    return null;
  }
}

/** 工厂。与 `createSnowlumaController` / `createIngest` / `createConsole` 同形。 */
export function createExtrasRuntime(registry: readonly ExtraEntry[], deps: ExtrasDeps): ExtrasRuntime {
  return new ExtrasRuntime(registry, deps);
}
