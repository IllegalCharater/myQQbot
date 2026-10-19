// 扩展的**运行时**：装载表 + 由它派生出来的三张表（工具 / 命令 / 提示词计划）。
//
// ── 谁能装载 ──
//
// **模型一个入口都没有。** 装载与卸载只由主流程那条 `/能力` 命令调 `load()` / `unload()`
// （群里还要 @ 机器人，见 `web/onebot/commands.ts`），以及配置 `extras.override` 在 `start()`
// 时播种。**敲扩展自己的命令不会把它拉起来**（2026-10-19 起）：未装载的扩展，命令照旧认得出，
// 但回一句"先 /能力 加载"。工具路径同样不允许隐式装载 —— 未装载的扩展，它的工具根本不在
// 工具表里（见 `toolDefs()`），所以模型连"有这个能力"都看不到。
//
// ── 三张表各自的筛选条件（别把它们"顺手统一"掉）──
//
// **三张表都按会话算**（`chatKey` 参数）：附加模式的那部分是全局的，而**接管按会话隔离** ——
// 同一个进程里 A 群可以让位而 B 群照常。这是全仓库唯一"按会话不同"的地方。
//
//   • `toolDefs(chatKey)`    —— 接管中：**只有接管者**的；否则：**已装载**的附加扩展。
//     模型的入口只该看到"此刻真正可用的能力"。
//   • `commandDefs(chatKey)` —— 接管中：**只有接管者**的；否则：**已启用**的附加扩展
//     （**接管模式的命令不外泄**：别的会话敲不到它）。判据按 spec 静态（`isCommandEntry`
//     同步、跑在入站热路径上，问不了异步的装载表），但**执行时不装载** —— 未加载就如实拒绝。
//     这条"认得出但用不了"是有意的：命令若干脆不在表里，消息会静默地进 LLM，那比一句
//     "先 /能力 加载"难查得多。
//   • `promptPlan(chatKey)`  —— 接管中：它的 body；否则：已装载附加扩展的 append/override。
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
import { mergeConfigPatch } from '../core/config.js';
import type { AppConfig } from '../core/config.js';
import type { PromptPlan } from '../core/prompt-catalog.js';
import type { ToolArguments, ToolContext, ToolDefinition, ToolResult } from '../agent/shared/types.js';
import type {
  ExtraCommand, ExtraCommandInput, ExtraCommandSpec, ExtraConfigPatch, ExtraEntry, ExtraInterceptResult,
  ExtraMode, ExtraRuntime, ExtraRuntimeDeps, ExtraRunEnd, ExtraSpec
} from './types.js';

/**
 * 组装根递给运行时的那一份。**它同时是递给扩展实现的那一份**（`ExtraRuntimeDeps`）——
 * 扩展的 `load(deps)` 收到的就是这个对象，所以那三个口子对扩展也是可见的。
 *
 * 多出来的三样是**运行时自己**要的，扩展不该用它们（`getConfig` 会让扩展绕过自己的配置项、
 * `builtinToolNames` 是装载期的名字对账、`log` 只是让扩展能往宿主日志里写一行）。
 */
export interface ExtrasDeps extends ExtraRuntimeDeps {
  /**
   * 每次现读：`enabled` / `idleUnloadMs` / `maxLoadsPerHour` **三样都是保存后立即生效**
   * （`isExtraEnabled` 在每个判据点上现读，没有任何一处把它快照进字段）。
   * 真正要重启的只有 `extras.override` —— 那份绑定只在 `start()` 时播种。
   */
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
  /**
   * 这一格是**附加模式装载**（`/能力 加载`）拉起来的吗？
   *
   * 接管模式的实现**不由它自己的计时器管**：它的生命是它那些会话绑定的并集 ——
   * 最后一个绑定到期就释放。两种模式的释放时机因此不同，用一个字段分开记。
   */
  attach: boolean;
}

/** 一个会话的接管绑定。 */
interface OverrideBinding {
  /** 接管的扩展 id。 */
  id: string;
  /** 生命时间到点的句柄（`idleUnloadMs === 0` 时为 null = 永不自动交还）。 */
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
  /** 正被它接管的会话（接管是**按会话**的，所以是列表不是一个布尔值）。 */
  overrides: string[];
}

export interface ExtraActionResult { ok: boolean; note: string }

/**
 * 一条命令声明 → **它的 `commandHandlers` 键**（见 `ExtraCommandSpec.subs`）。
 *
 *   • 不带 `subs`：键就是 `names[0]`（别名不占键，它们是同一条命令的其它叫法）；
 *   • 带 `subs`：键是 `<names[0]> <子命令>` 那些串 —— **声明自己不占 `names[0]`**。
 *
 * 只有一处实现：`validateRegistry` 的查重、`checkRuntimeShape` 的两方向对账、以及
 * `commandDefs()` 的产出全都调它。分开写的话，"声明与实现对不上"这件事会在三个地方
 * 各有一套判据，而它们漂移的表现是装载期报错互相矛盾。
 */
function expandCommandKeys(spec: ExtraCommandSpec): string[] {
  const main = String(spec.names?.[0] ?? '');
  const subs = (spec.subs ?? []).map((sub) => String(sub ?? '').trim()).filter(Boolean);
  return subs.length ? subs.map((sub) => `${main} ${sub}`) : [main];
}

/**
 * 一条命令声明 → **所有可能匹配到一条消息的词**（查重用的就是它）。
 *
 * ⚠️ 它与 `expandCommandKeys` **不是一回事，别合并**：
 *   • 键只有 `names[0]` 那一个（别名在同一条命令内部被规范化掉了）；
 *   • 而**别名同样占命名空间** —— 甲的 `/天气` 与乙的 `['/查天气', '/天气']` 撞了，
 *     表现是"先匹配到的先处理"，两个作者都以为自己的那个会被执行。
 * 带 `subs` 时**别名也各自展开**（`.trpg new` 与 `.跑团 new` 都算），所以下面用 `names` 全量。
 */
function commandWords(spec: ExtraCommandSpec): string[] {
  const names = (spec.names ?? []).map((name) => String(name ?? ''));
  const subs = (spec.subs ?? []).map((sub) => String(sub ?? '').trim()).filter(Boolean);
  return subs.length ? names.flatMap((name) => subs.map((sub) => `${name} ${sub}`)) : names;
}

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

    // ── lifetimeMs：存活时间（可选）──
    //
    // 只拦"写坏了"这一种：`0` 与正数都是合法值，而**不写**才是"用配置兜底"。
    // 写坏了（`'600'`、`NaN`、负数）不会有任何报错，表现是"永不释放"或"立刻释放" ——
    // 两种都只在真机上才看得出来，所以在这里当场拒绝。
    if (entry.lifetimeMs !== undefined) {
      const value = entry.lifetimeMs;
      // **必须是 number**：类型上它已经是 `number`，所以这条拦的是 JS 侧的注册表 / 手改过的 spec
      // （`'600000'`、`null`、`true` 都能被 `Number()` 悄悄转成数，而 `null` 会变成 0 = 永不释放）。
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        problems.push(`${id}: lifetimeMs 必须是 >= 0 的数字（毫秒），实际是 ${String(value)}；`
          + `不写 = 用配置 extras.idleUnloadMs 兜底，0 = 永不自动释放`);
      }
    }

    // ── overrideTools：框架契约段要引用的工具名 ──
    //
    // 这三条拦的都是**不会报错地坏掉**的形态：
    //   • 缺 sendTool —— 框架段会照着默认的 `send_message` 写，而接管会话里那个工具不在表里。
    //     症状是模型调一次、拿一句"未知工具"、再重试一次，群里才见到话。
    //   • 名字写错 —— 与 `checkRuntimeShape` 拦的是同一类东西（声明与实现分居两处）。
    //   • 非接管模式写它 —— 没有任何地方读，纯属让下一个人以为它生效了。
    const overrideTools = entry.overrideTools;
    if (entry.mode === 'override') {
      const sendTool = String(overrideTools?.sendTool ?? '').trim();
      if (!sendTool) {
        problems.push(`${id}: 接管模式必须声明 overrideTools.sendTool —— 框架契约段要照着它写`
          + `「要发言必须调用 X」，不声明就会写成 send_message，而那个工具在接管会话里不在表里`);
      }
      const own = new Set((entry.tools ?? []).map((tool) => String(tool.name ?? '')));
      for (const [field, value] of [['sendTool', sendTool], ['finishTool', overrideTools?.finishTool]] as const) {
        if (value === undefined || value === null || value === '') continue;
        if (!own.has(String(value))) {
          problems.push(`${id}: overrideTools.${field} 写的是「${String(value)}」，`
            + `但这个扩展没有这个工具 —— 框架契约段会照着它写，模型一调就报"未知工具"`);
        }
      }
    } else if (overrideTools !== undefined) {
      problems.push(`${id}: overrideTools 只有接管模式（mode: 'override'）用得上，`
        + `它在附加模式下没有任何地方读`);
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
      const names = spec.names ?? [];
      if (!Array.isArray(names) || !names.length) {
        problems.push(`${id}: 有一条命令没写 names（第一个是主命令词）`);
        continue;
      }
      const subs = spec.subs ?? [];
      if (!Array.isArray(subs)) {
        problems.push(`${id}.${names[0]}: subs 必须是一个数组（或者干脆不写）`);
        continue;
      }
      // ⚠️ **前缀**：主流程命令是 `/`，跑团这一族的扩展用 `.`（OneDice 的手感）。
      // 放松这一条是有意的：判据是"这个前缀在本仓库里已经被占用了"，而不是具体哪一个字符。
      for (const word of names) {
        const text = String(word ?? '');
        if (!text.startsWith('/') && !text.startsWith('.')) {
          problems.push(`${id}.${names[0]}: 命令词「${text}」必须以 / 或 . 开头`);
          continue;
        }
        if (/\s/.test(text)) problems.push(`${id}.${names[0]}: 命令词「${text}」不能含空白`);
      }
      for (const sub of subs) {
        const word = String(sub ?? '').trim();
        if (!word) { problems.push(`${id}.${names[0]}: subs 里有一个空的子命令词`); continue; }
        if (/\s/.test(word)) problems.push(`${id}.${names[0]}: 子命令词「${word}」不能含空白`);
      }
      // 命令词**共用一个命名空间**（同一个扩展内、跨扩展都一样）：重了的话"先匹配到的先处理"
      // 会静默地决定谁赢，而两个命令的作者都以为自己的那个会被执行。
      //
      // ⚠️ 查重查的是**展开后**的词（`expandCommandKeys`）：带 `subs` 的声明自己不占 `names[0]`，
      // 真正会被匹配的是 `<命令> <子命令>` 那些串 —— 拿原始 `names` 查会漏掉它们，
      // 而两个扩展各写一个 `.trpg new` 正是最该被拦住的那种撞名。
      for (const text of commandWords(spec)) {
        const owner = seenCommands.get(text);
        if (owner) problems.push(`${id}: 命令词 ${text} 与 ${owner} 重复`);
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
  const declaredCommands = (entry.commands ?? []).flatMap(expandCommandKeys);
  const commandHandlers = isRecord(rt.commandHandlers) ? rt.commandHandlers : {};
  const missingCommands = declaredCommands.filter((name) => typeof commandHandlers[name] !== 'function');
  if (missingCommands.length) return `命令声明了却没有实现：${missingCommands.join('、')}`;
  const undeclaredCommands = Object.keys(commandHandlers).filter((name) => !declaredCommands.includes(name));
  if (undeclaredCommands.length) return `命令实现了却没有声明：${undeclaredCommands.join('、')}`;

  // 提示词覆盖的段名：**覆盖一个不存在的段落不会有任何报错**，表现是"配了、什么都没发生"，
  // 所以在这里拦下来（框架契约段也不许动，见 SYSTEM_FRAMEWORK_SECTIONS）。
  let contribution;
  try {
    // 空着会话调一次：这里只做**段落名对账**，不看正文。所以扩展的 `prompt()` 必须是全函数
    // ——`chatKey === ''` 也要给出一份合法的贡献（跑团那种"按会话渲染"的实现要能应付空会话）。
    contribution = rt.prompt?.('');
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

  // `toolsFor` 也**空着会话调一次**，理由与上面那句逐字相同：它抛了就等于拒绝装载，
  // 而症状会表现成"这个扩展装不上"。
  // ⚠️ 这里**只查"不抛 + 是数组"**，不查名字对不对：那是按会话的，装载期只拿得到 `''`，
  // 而真正的过滤与记日志在 `#allowedTools` 里（运行期每个会话各查一次）。
  let allowed;
  try {
    allowed = rt.toolsFor?.('');
  } catch (error) {
    return `toolsFor() 抛错：${errorMessage(error)}`;
  }
  if (allowed !== undefined && !Array.isArray(allowed)) {
    return 'toolsFor() 必须返回一个工具名数组（或者干脆不写这个方法，表示"这个会话不限"）';
  }

  // `configPatch` 同样**空着会话调一次**，理由与上面两条逐字相同。
  // ⚠️ 这里**只查"不抛 + 是对象或空"**：补丁里写了什么由 `mergeConfigPatch` 走一遍归一化兜住
  // （它是全仓库唯一一处把配置掐回合法形状的地方），装载期不必再验一遍字段。
  let patch;
  try {
    patch = rt.configPatch?.('');
  } catch (error) {
    return `configPatch() 抛错：${errorMessage(error)}`;
  }
  if (patch !== undefined && patch !== null && !isRecord(patch)) {
    return 'configPatch() 必须返回一个配置补丁对象（或者干脆不写这个方法）';
  }

  // `intercept` 是**每一条入站消息**都会走的钩子，所以这里只查它是不是函数 ——
  // **刻意不空跑一次**：那是按消息走的判断，拿一个假消息去调它既可能误触发副作用，
  // 又证明不了什么（真正的兜底是 `intercept()` 里的 try/catch，见那边的说明）。
  if (rt.intercept !== undefined && typeof rt.intercept !== 'function') {
    return 'intercept 必须是函数（或者干脆不写这个方法）';
  }
  return null;
}

export class ExtrasRuntime {
  readonly #registry: readonly ExtraEntry[];
  readonly #entries = new Map<string, ExtraEntry>();
  readonly #loaded = new Map<string, LoadedSlot>();
  /**
   * **接管绑定：会话 → 谁来接管**。这是全仓库唯一"按会话隔离"的东西。
   *
   * 两个来源：① `extras.runtime.start()` 从配置 `extras.override` 播种（静态、重启生效）；
   * ② 群里敲 `@我 /能力 加载 <接管扩展>` 在**当前会话**建一条（内存，不落盘；群里必须 @ 机器人）。
   * 目标是让"A 群换了副脑子、B 群照常"可以表达 —— 附加模式的扩展则是全局的。
   */
  readonly #overrides = new Map<string, OverrideBinding>();
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
   * **按会话算**：接管是唯一按会话隔离的东西 —— 被接管的那个会话只剩接管者的工具，
   * 别的会话照常。调用方（`web/app.ts`）按 `isOverridden(chatKey)` 决定要不要把内置那部分拼进来。
   *
   * ⚠️ 表随装载/接管变化 ⇒ 工具表是请求前缀的一部分，装卸各打散一次提示词缓存。
   * 但两者都由**人**触发（频次很低），这正是这条设计换来的东西。
   */
  toolDefs(chatKey: string): ToolDefinition[] {
    const config = this.#deps.getConfig();
    const out: ToolDefinition[] = [];
    for (const entry of this.#activeEntries(chatKey)) {
      if (!isExtraEnabled(entry, config)) continue;
      // 形态按会话定（跑团：一个群当骰子助手、另一个群当 DM）。`null` = 这个扩展不限，
      // 表就是 `spec.tools` 的全部。
      const allowed = this.#allowedTools(entry, chatKey);
      for (const spec of entry.tools) {
        if (allowed && !allowed.has(spec.name)) continue;
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
   * 这个会话敲得到的扩展命令。判据来自 spec（**启用即可敲，不必先装载**）——
   * 但**敲了不会把扩展拉起来**：未加载时 `#runCommand` 如实回一句"先 /能力 加载"。
   *
   * **为什么这里按"已启用"而 `toolDefs()` 按"已装载"** —— 两个入口的人不同：命令的入口是**人**，
   * 工具的入口是**模型**。人有权决定要用什么，模型只该看到此刻可用的东西。别把这条不对称统一掉。
   *
   * ⚠️ 这条不对称**不等于**"敲命令就能用"（2026-10-19 起）：认得出是为了**不静默**（消息落成
   * 已读、回一句可执行的下一步），而不是为了隐式装载。
   *
   * 被接管的会话只有接管者的命令（**外加永远在的 `/能力`**，那在命令层拼，不在这里）。
   */
  commandDefs(chatKey: string): ExtraCommand[] {
    const override = this.#overrideEntry(chatKey);
    const config = this.#deps.getConfig();
    const out: ExtraCommand[] = [];
    for (const entry of this.#registry) {
      if (!isExtraEnabled(entry, config)) continue;
      if (override) {
        if (entry.id !== override.id) continue;          // 接管中：只有接管者的
      } else if (entry.mode === 'override') {
        // **接管模式的命令不在这里出现**：它只属于被它接管的那些会话。
        // 漏了这一条的话，B 会话也敲得到 `/接管命令`，而它一执行就会撞上"接管要指定会话"
        // —— 一条永远失败的提示，还让群友以为那个能力在这个群里可用。
        continue;
      }
      for (const spec of entry.commands ?? []) {
        const subs = (spec.subs ?? []).map((sub) => String(sub ?? '').trim()).filter(Boolean);
        if (!subs.length) {
          // 普通命令：**别名一起带上**（`names` 整份给出去），规范化交给命令层 ——
          // 每个解析器只需要认识主词（见 `canonicalize`）。
          out.push({
            names: spec.names,
            // ⚠️ **必须带上**：`commandDefs` 是**重新构造**命令对象的（不是把 spec 原样递出去），
            // 漏了它，扩展声明的 `requiresMention: false` 会被静默丢掉 —— 表现是"跑团那族
            // 群里不 @ 就敲不动"，而声明看起来完全正确。探针实测抓到过一次。
            requiresMention: spec.requiresMention !== false,
            run: (input) => this.#runCommand(entry.id, spec.names[0], input)
          });
          continue;
        }
        // 带 `subs` 的声明：**每条子命令各是一条普通命令**，此后没有任何地方知道
        // "子命令"这个概念（见 `ExtraCommandSpec.subs`）。键取主命令词那种拼法，
        // 所以别名 `'.跑团 new'` 与 `'.trpg new'` 落到**同一个** handler 上。
        const canonical = String(spec.names[0] ?? '');
        for (const name of spec.names) {
          for (const sub of subs) {
            out.push({
              names: [`${name} ${sub}`],
              // 同上面那条：展开出来的子命令也要带上声明，否则 `.trpg new` 与 `.trpg` 的
              // @ 要求会不一样（一个免 @、一个要 @）—— 那种不一致没人查得出来。
              requiresMention: spec.requiresMention !== false,
              run: (input) => this.#runCommand(entry.id, `${canonical} ${sub}`, input)
            });
          }
        }
      }
    }
    return out;
  }

  /**
   * 扩展对 system prompt 的贡献计划。**只算已装载扩展的** —— 这条就是"随装载状态变化"的落点：
   * 装载后出现、卸载后消失。它不改"一次运行内不变"这条性质（`runAgent` 开头拼一次，
   * 之后整个工具循环都用它），所以真实语义是"**装载后，下一次运行开始生效**"。
   */
  promptPlan(chatKey: string): PromptPlan {
    const override = this.#overrideEntry(chatKey);
    if (override) {
      const slot = this.#loaded.get(override.id);
      const body = readContribution(slot?.rt, this.#deps, chatKey)?.body ?? [];
      return {
        mode: 'override',
        body: body.map(String).filter((text) => text.trim()),
        // 框架契约段（永远保留）要照这两个名字写「要发言必须调用 X」。缺省是内置那两个，
        // 而接管会话里它们**不在表里** —— 所以 `validateRegistry` 强制接管扩展声明 `sendTool`。
        sendTool: override.overrideTools?.sendTool,
        finishTool: override.overrideTools?.finishTool
      };
    }
    const append: string[] = [];
    const merged: Record<string, string> = {};
    for (const entry of this.#activeEntries(chatKey)) {
      const slot = this.#loaded.get(entry.id);
      const contribution = readContribution(slot?.rt, this.#deps, chatKey);
      if (!contribution) continue;
      const id = entry.id;
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

  /**
   * **这条消息有没有扩展要自己接**（见 `ExtraRuntime.intercept`）。返回 `null` = 谁都不要，
   * 照常落未读、走模型。
   *
   * 判据与工具表同一套（`#activeEntries`）：接管会话里只有接管者会被问到，附加模式问的是
   * "这个会话里已装载的那些"。顺序即优先级 —— 取**第一个**说"我要"的，后面的不再问。
   *
   * ⚠️ **它跑在每一条入站消息上**，所以这里的容错是必须的：钩子抛错只记一行日志、当它没接，
   * 绝不让异常穿进入站回调（那会把 OneBot 的 WS 消息处理打成未处理异常）。
   */
  intercept(chatKey: string, input: ExtraCommandInput): ExtraInterceptResult | null {
    for (const entry of this.#activeEntries(chatKey)) {
      const hook = this.#loaded.get(entry.id)?.rt.intercept;
      if (typeof hook !== 'function') continue;
      try {
        const result = hook(input);
        if (result) return result;
      } catch (error) {
        this.#deps.log(`[extras] ${entry.id} 的 intercept 抛错（这条消息照常走模型）：${errorMessage(error)}`);
      }
    }
    return null;
  }

  /**
   * **这个会话这一轮运行读到的配置**：全局那份，叠上本会话里可用的各扩展的补丁。
   *
   * ⚠️ **不改全局、不落盘**（`mergeConfigPatch`）：改全局只有 `updateConfig` 一条路。
   * 于是"接管 A 群的扩展"不会顺手改掉 B 群的行为，并行的两个会话也各看各的。
   *
   * 作用域就是**一次运行**：`agent-runner` 开头调一次、把结果交下去，那一轮读到的每一处
   * （模型、轮数、温度、各能力开关、提示词里的预算与档位）都是叠过之后的。**入站白名单、
   * 发送限频、面板显示读到的仍是全局那份** —— 那些不在"一次运行"的范围内。
   *
   * ⚠️ **窗口容量、历史深度、响应档位也曾经在那张单子上**，三样都是靠**改读取点**才搬过来的
   * （见 `ExtraRuntime.configPatch` 那条注释）。**调用方多一处**（例如 `wake-scheduler` 判档位时）
   * 就是把覆盖面扩大一格，而漏改一处的症状永远是"配了、看着生效、实际用的是别的"。
   *
   * ⚠️ **它不自动装载**（`readConfigPatch` 拿的是 `#loaded` 里那一份）：扩展还没被拉起来时，
   * 这里返回的就是全局那份。装载的入口只有 `/能力 加载` 与 `start()` 的播种（工具调用与命令
   * 都不再隐式装载），所以"这个群今天第一条消息"有可能还没叠上补丁 —— 这条既有的行为不是本
   * 函数引入的，但它决定了"补丁什么时候开始生效"。
   */
  configFor(chatKey: string): AppConfig {
    let merged = this.#deps.getConfig();
    for (const entry of this.#activeEntries(chatKey)) {
      const patch = readConfigPatch(this.#loaded.get(entry.id)?.rt, this.#deps, chatKey);
      if (!patch) continue;
      merged = mergeConfigPatch(merged, patch);
    }
    return merged;
  }

  /**
   * 一次 agent 运行结束了 → 通知**正在接管这个会话**的那个扩展。
   *
   * 判据用 `#overrideEntry`（与 `toolDefs` / `promptPlan` 同一处）：它同时管三件事 ——
   * 这个会话有没有被接管、那个扩展此刻还装不装、以及它还**能不能用**（`extras.enabled` 是
   * 每次现读的）。"关掉扩展但不重启"会造出一个会话看似被接管、实则一个工具都没有的状态，
   * 那种时候不该再往它身上挂钩子。
   *
   * **`autoLoad: false`**：一次运行结束不是装载的理由 —— 附加模式与会话没被接管的扩展都不该
   * 因为"有人跑完一轮"而把实现拉起来。
   *
   * **不抛错**：它是收尾路径上的旁路。失败只记一行日志，主流程照常走完。
   */
  runEnded(session: ExtraRunEnd): void {
    const override = this.#overrideEntry(session.chatKey);
    if (!override) return;
    void this.#withExtra(override.id, async (rt) => {
      if (typeof rt.onRunEnd === 'function') await rt.onRunEnd(session);
    }).catch((error: unknown) => {
      this.#deps.log(`[extras] ${override.id} 的 onRunEnd 失败：${errorMessage(error)}`);
    });
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
      loaded: this.#loaded.has(entry.id),
      // 接管是**按会话**的，所以这里列出"哪些会话正被它接管"，而不是一个布尔值。
      // 只列**真的在接管**的那些（`#overrideEntry` 会滤掉"绑定还在但扩展已被关掉"的会话），
      // 否则 `/能力` 会显示"接管中：group:1"，而那个群其实已经退回主流程了。
      overrides: [...this.#overrides.entries()]
        .filter(([chatKey, binding]) => binding.id === entry.id && this.#overrideEntry(chatKey) !== null)
        .map(([chatKey]) => chatKey)
    }));
  }

  isLoaded(id: string): boolean {
    return this.#loaded.has(id);
  }

  /**
   * **这个会话**是否处于接管模式。
   *
   * 主流程的工具表 / 命令表 / 提示词都按它决定让不让位 —— **但 `/能力` 永远留着**，它是解除接管的
   * 唯一入口（见 `commands.ts` 的 `OVERRIDE_KEPT_COMMANDS`）。少了它，让一个会话被接管之后
   * 就再没有任何办法交还。
   */
  isOverridden(chatKey: string): boolean {
    return this.#overrideEntry(chatKey) !== null;
  }

  /** `/能力` 列表用：当前所有接管绑定（配置播种的 + 群里临时建立的）。 */
  overrideBindings(): Array<{ chatKey: string; extraId: string; fromConfig: boolean }> {
    const configured = this.#deps.getConfig().extras?.override ?? {};
    return [...this.#overrides.entries()].map(([chatKey, binding]) => ({
      chatKey, extraId: binding.id, fromConfig: configured[chatKey] === binding.id
    }));
  }

  // ── 装载/卸载（**只有那条 `/能力` 命令调它们**，外加 `start()` 按配置播种接管绑定）──

  /**
   * 装载一个扩展。**模型侧没有调用者** —— 这是这套设计的核心。
   *
   * 两种模式的生命周期不同：
   *   • **附加**（`chatKey` 与它无关）：全局装载，空闲 `idleUnloadMs` 后自动卸载。
   *   • **接管**：**按会话**。`/能力 加载 <接管扩展>` 在哪个会话敲，就只接管那个会话
   *     （内存绑定，不落盘；重启后回到配置 `extras.override` 里写的那一份）。
   *     生命时间同样是 `idleUnloadMs`，到点**该会话交还主流程**。
   *
   * **接管是唯一按会话隔离的东西** —— 所以"A 群换了副脑子、B 群照常"是可以表达的。
   */
  async load(id: string, reason = 'command', chatKey = ''): Promise<ExtraActionResult> {
    const entry = this.#entries.get(id);
    if (!entry) return { ok: false, note: `没有这个扩展：${id}` };
    if (!isExtraEnabled(entry, this.#deps.getConfig())) {
      return { ok: false, note: `「${entry.title}」在设置里是关闭的：先去设置页把它打开（保存即生效，不用重启）` };
    }
    if (entry.mode === 'override') return this.#bindOverride(entry, chatKey, reason);
    if (this.#loaded.has(id)) return { ok: false, note: `「${entry.title}」已经加载过了` };
    const refusal = this.#takeLoadBudget(id);
    if (refusal) return { ok: false, note: refusal };
    const loaded = await this.#loadImpl(entry, true);
    if (!loaded.ok) return loaded;
    return { ok: true, note: `已加载「${entry.title}」` };
  }

  /**
   * 卸载。
   *   • 附加：全局卸载实现。
   *   • 接管：**解除这个会话的接管**（其他会话若也绑着它，实现留着）。
   */
  async unload(id: string, chatKey = ''): Promise<ExtraActionResult> {
    const entry = this.#entries.get(id);
    if (!entry) return { ok: false, note: `没有这个扩展：${id}` };
    if (entry.mode === 'override') {
      const binding = this.#overrides.get(chatKey);
      if (!binding || binding.id !== id) return { ok: false, note: `这个会话当前没有由「${entry.title}」接管` };
      if (binding.timer) { clearTimeout(binding.timer); binding.timer = null; }
      this.#overrides.delete(chatKey);
      this.#deps.log(`[extras] ${chatKey} 交还主流程（手动卸载 ${id}）`);
      await this.#releaseIfUnused(id);
      return { ok: true, note: `已解除「${entry.title}」对这个会话的接管` };
    }
    const slot = this.#loaded.get(id);
    if (!slot) return { ok: false, note: `「${entry.title}」当前没有加载` };
    if (slot.inFlight > 0) return { ok: false, note: `「${entry.title}」正在执行中，等它跑完再卸载` };
    this.#loaded.delete(id);
    if (slot.timer) { clearTimeout(slot.timer); slot.timer = null; }
    await this.#dispose(slot.rt, id);
    this.#deps.log(`[extras] 已卸载 ${id}`);
    return { ok: true, note: `已卸载「${entry.title}」` };
  }

  /**
   * 装配清单的 start：清空装载表，然后按配置 `extras.override` **播种接管绑定**。
   *
   * 播种要真的把实现拉起来（否则那个会话只会退回主流程，而用户写的配置看起来生效了 ——
   * 这是本仓库最忌讳的那类故障）。加载失败只记日志、不抛：一个扩展坏了不该把整个
   * `app.start()` 掀翻（同 `initPicImageSearch` 的先例），那一轮该会话退回主流程并留下日志。
   *
   * `start()` 因此是 **async**：`LifecycleDeps.extras.start` 允许返回 Promise，清单会 await 它。
   */
  async start(): Promise<void> {
    for (const [, slot] of this.#loaded) {
      if (slot.timer) { clearTimeout(slot.timer); slot.timer = null; }
    }
    for (const [, binding] of this.#overrides) {
      if (binding.timer) { clearTimeout(binding.timer); binding.timer = null; }
    }
    this.#loaded.clear();
    this.#overrides.clear();

    for (const [chatKey, extraId] of Object.entries(this.#deps.getConfig().extras?.override ?? {})) {
      const entry = this.#entries.get(extraId);
      if (!entry) { this.#deps.log(`[extras] 配置里 ${chatKey} 绑了不存在的扩展 ${extraId}，忽略`); continue; }
      if (entry.mode !== 'override') {
        this.#deps.log(`[extras] 配置里 ${chatKey} 绑了「${entry.title}」，但它不是接管模式，忽略`);
        continue;
      }
      if (!isExtraEnabled(entry, this.#deps.getConfig())) {
        this.#deps.log(`[extras] 配置里 ${chatKey} 绑了「${entry.title}」，但它在设置里是关闭的，忽略`);
        continue;
      }
      const result = await this.#bindOverride(entry, chatKey, 'config');
      if (!result.ok) this.#deps.log(`[extras] ${chatKey} 的接管未生效：${result.note}`);
    }
  }

  /**
   * 关停：清掉全部空闲计时器与接管绑定，并逐个 `dispose()` 已装载的扩展。
   *
   * 逆序拆清单时这条排最后 ⇒ 它**第一个**被收掉，不会拖着 OneBot 传输层一起等。
   * 幂等：第二次调用看到的是空表。**在途调用不做特殊处理** —— 走到这里说明
   * `abortAll()` 已经跑完，不会再有新的模型轮次。
   */
  async stop(): Promise<void> {
    const slots = [...this.#loaded.entries()];
    this.#loaded.clear();
    for (const [, binding] of this.#overrides) {
      if (binding.timer) { clearTimeout(binding.timer); binding.timer = null; }
    }
    this.#overrides.clear();
    await Promise.all(slots.map(([id, slot]) => {
      if (slot.timer) { clearTimeout(slot.timer); slot.timer = null; }
      return this.#dispose(slot.rt, id);
    }));
  }

  // ── 内部 ──

  /** 把实现拉起来（真正的 `import()` + 名字对账）。`attach` 决定它由谁的生命周期管。 */
  async #loadImpl(entry: ExtraEntry, attach: boolean): Promise<ExtraActionResult> {
    let rt: ExtraRuntime;
    try {
      rt = await entry.load(this.#deps);
    } catch (error) {
      return { ok: false, note: `「${entry.title}」加载失败：${errorMessage(error)}` };
    }
    const problem = checkRuntimeShape(entry, rt);
    if (problem) {
      void this.#dispose(rt, entry.id);
      return { ok: false, note: `「${entry.title}」不可用（${problem}）` };
    }
    const slot: LoadedSlot = { rt, inFlight: 0, timer: null, attach };
    this.#loaded.set(entry.id, slot);
    this.#deps.log(`[extras] 已加载 ${entry.id}${attach ? '' : '（接管用）'}`);
    // 它会在每次运行时悄悄改掉那一轮读到的配置 —— 那件事**不该只在代码里看得出来**，
    // 所以在装载时说一句（只在装载时，不刷屏）。判断"这个群为什么行为和设置里不一样"时，
    // 这一行是日志里唯一的线索。
    if (typeof rt.configPatch === 'function') {
      this.#deps.log(`[extras] 注意：${entry.id} 会覆盖运行期配置（每次模型运行前叠一层，不落盘）`);
    }
    if (attach) this.#armIdleTimer(entry.id, slot);
    return { ok: true, note: '' };
  }

  /** 建立/刷新一个会话的接管绑定。同一个会话同时只允许一个接管者。 */
  async #bindOverride(entry: ExtraEntry, chatKey: string, reason: string): Promise<ExtraActionResult> {
    if (!chatKey) {
      return { ok: false, note: `「${entry.title}」是接管模式，要指定会话（在群里敲 /能力 加载 就会用当前会话）` };
    }
    const current = this.#overrides.get(chatKey);
    if (current?.id === entry.id) return { ok: false, note: `这个会话已经由「${entry.title}」接管了` };
    if (current) {
      const other = this.#entries.get(current.id);
      return {
        ok: false,
        note: `这个会话当前由「${other?.title ?? current.id}」接管，先解除它：/能力 卸载 ${current.id}`
      };
    }
    if (!this.#loaded.has(entry.id)) {
      const refusal = this.#takeLoadBudget(entry.id);
      if (refusal) return { ok: false, note: refusal };
      const loaded = await this.#loadImpl(entry, false);
      if (!loaded.ok) return loaded;
    }
    const binding: OverrideBinding = { id: entry.id, timer: null };
    this.#overrides.set(chatKey, binding);
    this.#armBindingTimer(entry, chatKey, binding);
    this.#deps.log(`[extras] ${chatKey} 由 ${entry.id} 接管（${reason}）`);
    return { ok: true, note: `「${entry.title}」已接管这个会话（下一轮运行生效）` };
  }

  /**
   * 这个扩展的存活时间（毫秒，`0` = 不限）。
   *
   * **声明优先、配置兜底**（2026-10-19）：`spec.lifetimeMs` 是扩展自己的知识（骰子机器人该常驻、
   * 要起子进程的重能力该闲着就收），只在**没写**的时候才落回设置页那个 `extras.idleUnloadMs`。
   * 写了就以声明为准 —— 配置改不动它。
   *
   * ⚠️ **两种模式的计法不同，但读的是同一个数**（那是**模式**的性质，不是这个数的性质）：
   *   • **附加**：滑动窗口 —— `#withExtra` 每次执行都重起（"多久没人用"）；
   *   • **接管**：从建立绑定那一刻起算的固定租期，执行不续期（"这个人做的接管动作什么时候失效"）。
   *
   * ⚠️ **别再让接管去读另一个配置项**：曾经它与附加共用一个数（默认 10 分钟），后果是一局跑团
   * 玩到一半、那个群自己变回普通群友，群里没有任何提示。现在跑团声明 `lifetimeMs: 0` 就彻底免疫。
   */
  #lifetimeMs(entry: ExtraEntry): number {
    const declared = entry.lifetimeMs;
    if (declared !== undefined) return Math.max(0, Math.trunc(Number(declared)) || 0);
    return Math.max(0, Math.trunc(Number(this.#deps.getConfig().extras?.idleUnloadMs)) || 0);
  }

  #armBindingTimer(entry: ExtraEntry, chatKey: string, binding: OverrideBinding): void {
    const ms = this.#lifetimeMs(entry);
    if (ms <= 0) return;
    binding.timer = setTimeout(() => this.#onBindingExpired(chatKey, binding), ms);
    binding.timer.unref?.();
  }

  /**
   * 接管到点 ⇒ **这个会话交还主流程**。
   *
   * 与附加模式的区别只在"释放的是什么"：附加释放实现，接管释放**这个会话的绑定**
   * （实现由别的绑定或附加装载继续养着，最后一个绑定走掉时才 dispose）。
   */
  #onBindingExpired(chatKey: string, binding: OverrideBinding): void {
    binding.timer = null;
    if (this.#overrides.get(chatKey) !== binding) return;   // 已经被 unload/stop 换掉了
    this.#overrides.delete(chatKey);
    this.#deps.log(`[extras] ${chatKey} 的接管到期，交还主流程`);
    void this.#releaseIfUnused(binding.id);
  }

  /** 没人用了就释放实现（附加装载的那份由它自己的空闲计时器管）。 */
  async #releaseIfUnused(id: string): Promise<void> {
    const slot = this.#loaded.get(id);
    if (!slot || slot.attach) return;
    if ([...this.#overrides.values()].some((binding) => binding.id === id)) return;
    // 在途就先留着：`#withExtra` 出账时会再判一次（那时已经没人用了才收）。
    if (slot.inFlight > 0) return;
    this.#loaded.delete(id);
    await this.#dispose(slot.rt, id);
  }

  /**
   * 这个会话的接管者（`mode: 'override'` 且**已装载**、且**此刻仍然启用**的那个）。
   *
   * 三种情况下返回 `null`，三种都是"**这个会话退回主流程**"：
   *   • 没有绑定；
   *   • 绑定指向的实现没装载起来（比如配置播种时加载失败）；
   *   • **扩展在设置里被关掉了**。
   *
   * ⚠️ 第三条是实打实踩出来的：`extras.enabled` 的判据 `isExtraEnabled` 是**每次现读**的
   * （开关保存后立即生效，不用重启），于是"把这个扩展关掉"会造出一个
   * **静默的坏状态**：会话仍被算作接管（`app.ts` 因此不拼内置工具），而扩展的工具被
   * `toolDefs()` 的启用闸门滤掉 ⇒ 模型手里**一个工具都没有**，却还拿着一份"接管"的
   * 系统提示。表现是**那个群彻底不说话了，日志里一条线索都没有**。
   * 判据由"装没装"扩成"装没装且还能不能用"，这个会话就干净地退回主流程了。
   * （绑定本身留着：重新打开开关，接管就回来。）
   */
  #overrideEntry(chatKey: string): ExtraEntry | null {
    const binding = this.#overrides.get(chatKey);
    if (!binding) return null;
    if (!this.#loaded.has(binding.id)) return null;
    const entry = this.#entries.get(binding.id) ?? null;
    if (entry && !isExtraEnabled(entry, this.#deps.getConfig())) return null;
    return entry;
  }

  /** 这个会话里可用的扩展：接管时只有接管者，否则是**附加装载**的那些。 */
  #activeEntries(chatKey: string): ExtraEntry[] {
    const override = this.#overrideEntry(chatKey);
    if (override) return [override];
    return this.#registry.filter((entry) => this.#loaded.get(entry.id)?.attach === true);
  }

  /**
   * 这个会话允许的工具名。`null` = 不限（扩展没提供 `toolsFor`，或它抛了）。
   *
   * 两件事都只记日志、不抛：这是在**运行期**、在别人的一轮运行里被调的，抛出去会把
   * 一整轮对话打掉，而"某一次取工具名失败"远不该有那个代价。回落方向也是安全的那一侧
   * （退回全部工具 = 退化成这个钩子不存在之前的行为）。
   */
  #allowedTools(entry: ExtraEntry, chatKey: string): Set<string> | null {
    const rt = this.#loaded.get(entry.id)?.rt;
    if (!rt || typeof rt.toolsFor !== 'function') return null;
    let names: readonly string[];
    try {
      names = rt.toolsFor(chatKey) ?? [];
    } catch (error) {
      this.#deps.log(`[extras] ${entry.id} 的 toolsFor 抛错，本会话按"全部工具"处理：${errorMessage(error)}`);
      return null;
    }
    // 只认声明过的名字：多出来的只可能是拼错的字符串，放进去会让模型看到一个
    // `execute` 一定报"未知工具"的入口。
    const declared = new Set(entry.tools.map((spec) => spec.name));
    const unknown = names.filter((name) => !declared.has(String(name)));
    if (unknown.length) {
      this.#deps.log(`[extras] ${entry.id} 的 toolsFor 返回了没声明的工具名：${unknown.join('、')}（已忽略）`);
    }
    return new Set(names.map(String).filter((name) => declared.has(name)));
  }

  /**
   * 两条执行路径共用的机械：**取已装载的实现** → 计入在途 → 执行 → 出账并重新起表。
   *
   * ⚠️ **它不装载**（2026-10-19 起，参数 `autoLoad` 与 `chatKey` 一并删掉了）。装载的唯一入口是
   * `/能力 加载 <id>` 与配置 `extras.override` 的播种 —— 用户要求"未显式加载时不许靠命令把它
   * 拉起来"。两个调用点（工具 / 命令）都只可能在**已经装载**的前提下走到这里：工具表按已装载
   * 算，命令的拒绝发生在下面那句 `ok:false` 上。真到了 `!slot` 那一格，说明是"运行开始时装着、
   * 跑到一半被空闲卸载了"那种竞态，如实拒绝即可。
   */
  async #withExtra<T>(id: string, use: (rt: ExtraRuntime) => Promise<T>): Promise<Attempt<T>> {
    const entry = this.#entries.get(id);
    if (!entry) return { ok: false, reason: `扩展 ${id} 未注册` };
    const slot = this.#loaded.get(id);
    if (!slot) return { ok: false, reason: `「${entry.title}」当前没有加载：先敲 /能力 加载 ${id}（群里要先 @ 我）` };
    // 有活干就先把空闲计时器撤掉：TTL 是**滑动**的空闲窗口，不是从装载时刻起算的固定租期。
    if (slot.timer) { clearTimeout(slot.timer); slot.timer = null; }
    slot.inFlight += 1;
    try {
      return { ok: true, value: await use(slot.rt) };
    } finally {
      slot.inFlight -= 1;
      if (this.#loaded.get(id) === slot && slot.inFlight === 0) {
        // 只有"还挂在表里的那一格"才重新起表：期间可能被 unload()/stop() 收掉、也可能已到点卸载。
        // 接管用的实现**不起空闲计时器**（它的生命由会话绑定管），但要在这里补判一次
        // "绑定是不是都已经走光了" —— 否则在途期间到期的那个会话会把实现漏在内存里。
        if (slot.attach) this.#armIdleTimer(id, slot);
        else void this.#releaseIfUnused(id);
      }
    }
  }

  async #runTool(id: string, name: string, ctx: ToolContext, args: ToolArguments): Promise<ToolResult> {
    const attempt = await this.#withExtra(id, async (rt) => {
      const handler = rt.handlers[name];
      if (typeof handler !== 'function') throw new Error(`扩展「${id}」没有工具「${name}」`);
      return handler(ctx, args);
    });
    if (attempt.ok) return attempt.value;
    return { content: `错误：${attempt.reason}`, isError: true };
  }

  /**
   * 命令路径。**不装载**（2026-10-19 用户要求）：未显式加载的扩展，敲它自己的命令**不会**
   * 把它拉起来，而是抛出 `#withExtra` 那句"先 /能力 加载"。
   *
   * 判据仍然是"这条命令属于哪个扩展"（命令表按**已启用**算，见 `commandDefs`），所以消息
   * 照常被认作命令、落成已读、不惊动模型 —— 群友拿到的是一句**可执行的下一步**，而不是
   * 静默地进 LLM（那正是这一层最要避免的表现）。
   *
   * 失败**抛出** —— `web/onebot/commands.ts` 的外壳会把 `error.message` 原样发进群。
   */
  async #runCommand(id: string, name: string, input: ExtraCommandInput): Promise<string | null> {
    const attempt = await this.#withExtra(id, async (rt) => {
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

  /**
   * 附加装载的空闲计时器。**只有附加模式走这里** —— 接管模式的生命是它那些会话绑定的并集
   * （见 `#armBindingTimer`），给接管者也 arm 一个的话，它会因为"没人用过"而把自己的
   * 接管悄悄撤掉，而那正是我们要避免的"群友看到 bot 的人格突然改了"。
   */
  #armIdleTimer(id: string, slot: LoadedSlot): void {
    // 0 = 常驻不卸载（与仓库"0 = 不限"的惯例一致）。
    const entry = this.#entries.get(id);
    if (!entry) return;
    const ms = this.#lifetimeMs(entry);
    if (ms <= 0) return;
    slot.timer = setTimeout(() => this.#onIdle(id, slot), ms);
    // 别让一个空闲计时器把进程钉住 —— 与 price-feed / 历史压缩巡检同一条姿态。
    slot.timer.unref?.();
  }

  #onIdle(id: string, slot: LoadedSlot): void {
    slot.timer = null;
    if (this.#loaded.get(id) !== slot) return;                     // 已经被 unload()/stop() 换掉了
    if (slot.inFlight > 0) { this.#armIdleTimer(id, slot); return; }  // 在途，推迟到下次空闲
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
function readContribution(rt: ExtraRuntime | undefined, deps: ExtrasDeps, chatKey: string) {
  if (!rt || typeof rt.prompt !== 'function') return null;
  try {
    return rt.prompt(chatKey) ?? null;
  } catch (error) {
    deps.log(`[extras] prompt() 抛错，本轮忽略它的提示词贡献：${errorMessage(error)}`);
    return null;
  }
}

/**
 * 读一次扩展的配置补丁，任何异常都吞掉。
 *
 * 与 `readContribution` 同一条理由：它只是"这一轮多几条不同的设置"，一个写坏的补丁不该
 * 把整轮运行掀翻。返回 `null` = 这一轮不叠（与"叠一个空对象"等价，但省一次深合并）。
 */
function readConfigPatch(rt: ExtraRuntime | undefined, deps: ExtrasDeps, chatKey: string): ExtraConfigPatch | null {
  if (!rt || typeof rt.configPatch !== 'function') return null;
  try {
    const patch = rt.configPatch(chatKey);
    return patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : null;
  } catch (error) {
    deps.log(`[extras] configPatch() 抛错，本轮忽略它的配置覆盖：${errorMessage(error)}`);
    return null;
  }
}

/** 工厂。与 `createSnowlumaController` / `createIngest` / `createConsole` 同形。 */
export function createExtrasRuntime(registry: readonly ExtraEntry[], deps: ExtrasDeps): ExtrasRuntime {
  return new ExtrasRuntime(registry, deps);
}
