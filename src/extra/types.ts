// 扩展（extra）的对外契约。
//
// 一个"扩展"可以提供三样东西：**模型工具**、**斜杠命令**、**system prompt 片段**；
// 外加一个可选的重资源生命周期。它**不**自带面板页（那是 `ui/` 的活）。
//
// ── 谁能触发装载 ──
//
// **模型没有任何装载入口。** 未装载的扩展，它的工具根本不在工具表里（模型连"有这个能力"
// 都看不到）；装载与卸载的唯一入口是主流程那条 `/能力` 命令 —— **入口是人**。
// 于是"命令的判据按 spec 静态（启用即可敲）、工具的表按装载状态（只含真正可用的）"
// 这条不对称是刻意的，别把它"顺手统一"掉。
//
// ── 为什么声明与实现要分开 ──
//
// 模型要能调用一个工具，它的 name / description / parameters 就必须**在工具表里**，而工具表是
// 每次请求前缀的一部分。若这三样得靠加载实现才能拿到，那就等于每次请求都得把全部扩展加载起来，
// "按需加载"当场作废。所以：
//   • `spec.ts`（每个扩展目录一个）—— **纯数据**，注册表静态 import 它，重东西一个字都不许进；
//   • `impl.ts` —— 实现，永远走 `import()`，被那条命令（或第一次调用）装载时才执行。
//
// 代价是"声明与实现分居两处"（这套设计唯一的真实漂移点），守护是装载时的名字集合校验：
// 两个方向都对上才算数（见 `ExtraRuntime.handlers` 的说明）。
//
// ⚠️ 本文件**不 import 本模块的任何文件**（同 `media/transcription/types.ts` 的规矩）：它被
// types/registry/runtime 与每个扩展同时依赖，反向依赖就成环。这里只 import 下层类型
// （`agent/shared/types.js` 与 `chat/types.js` 都 ≤ extra 的 4，向下依赖合法，且都是 `import type`）。
import type { ToolArguments, ToolContext, ToolResult } from '../agent/shared/types.js';
import type { MediaEntry } from '../chat/types.js';

/** 模型可见的工具声明。**纯数据** —— 拿到它不需要加载任何实现。 */
export interface ExtraToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * 扩展的两种形态。
 *
 * - `attach`（默认）：把能力**加到**主流程上。工具在装载后进工具表，命令在启用后即可敲
 *   （判定按 spec 静态、执行时装载），提示词按段名追加/覆盖。
 * - `override`：**接管**主流程的模型侧三样 —— 工具表、斜杠命令、system prompt 整体换成它的。
 *   框架契约两段（安全规则 + 工具协议）强制保留（见 `SYSTEM_FRAMEWORK_SECTIONS`）。
 *   存档、上下文窗口、记忆与后台长期任务照常。
 */
export type ExtraMode = 'attach' | 'override';

/**
 * 斜杠命令的**声明**（纯数据，静态可得）。
 *
 * ⚠️ 判据必须放在这里、而不是实现里：`isSlashCommand()` 是同步的、且在入站热路径上被调
 * （决定这条消息要不要落成已读历史、要不要并入引用附件）—— 它不可能去问一个异步的装载表。
 * 判据静态 + 执行时装载，这条矛盾就没了。
 */
export interface ExtraCommandSpec {
  /**
   * **所有命令词。第一个是主命令词**（`names[0]`）。
   *
   * - 判定：任何一个词打头都算这条命令（词后面跟空白或直接结束，`/时间戳` 不是 `/时间`）；
   * - 规范化：命中非首位的词时，分发层把它**换成 `names[0]`** 再交给处理函数 ——
   *   于是解析只需要认识一个词；
   * - **`commandHandlers` 的键就是 `names[0]`**（装载时两个方向对账）；
   * - 首位那个同时是日志标签。
   *
   * 一个词列不出来的形态（比如内置 `/转写` 那个由文本化产生的 `/转写[视频]`）
   * 也是往这个数组里加一条 —— **没有第二种判据**。
   */
  names: readonly string[];
}

/**
 * 命令处理函数的入参。与 `web/onebot/slash-commands.ts` 的 `SlashCommandInput` **同形但独立**：
 * 扩展不认识 web（分层闸门），两边靠 web 侧那个适配器在**编译期**对账。
 */
export interface ExtraCommandInput {
  chatKey: string;
  /** 发起命令的群友 QQ 号。 */
  senderId: string;
  /** 用户真正敲的那句话（不是展开合并转发之后的存档文本）。 */
  text: string;
  /** 本条消息的媒体 + 它引用那条的媒体。 */
  media: readonly MediaEntry[];
  replyToMessageId: string | number | null;
}

/**
 * 返回回执文本；`null` = 不吭声；**抛出的中文文案由 web 侧原样发进群**
 * （解析层抛的本来就是给群友看的可执行提示，换成"命令执行失败"会把它丢掉）。
 */
export type ExtraCommandHandler = (input: ExtraCommandInput) => Promise<string | null>;

/**
 * 扩展交出来的**一条命令**：声明 + 处理函数。`ExtrasRuntime.commandDefs()` 交出来的就是它。
 *
 * ⚠️ 它上面那个 `ExtraCommandHandler` / `ExtraCommandInput` 与 web 侧的 `SlashCommand` /
 * `SlashCommandInput` **是两个不同的东西，别合并**：
 *   • 本类型是**业务实现** —— 只返回一句回执文本，**不碰 sender**（扩展拿不到 `SendQueue`）；
 *   • web 侧那个 `SlashCommand` 是**命令骨架** —— 回执的发送、`error.message` 原样进群、
 *     发送失败不抛，三条都在它的 `runCommand` 外壳里。
 * `web/onebot/slash-commands.ts` 的 `adaptExtraCommand()` 就是把前者套进后者的那一层。
 *
 * 而**这一份类型本身只有一处**：web 侧的 `ExtraCommand` 直接 import 它
 * （`web → extra` 是允许的方向），所以"两边的形状漂移了"是**编译错误**，而不是要靠人核对。
 */
export interface ExtraCommand extends ExtraCommandSpec {
  run: ExtraCommandHandler;
}

/**
 * 这个扩展要往 system prompt 里加什么。
 *
 * ⚠️ 文案本身必须写在 `src/extra/prompts.ts`（扩展的提示词目录）——模型可见的固定指令
 * 只许住在提示词目录里，`spec.ts` 只引用、不抄写。
 */
export interface ExtraPromptContribution {
  /** **接管模式**：system prompt 主体，数组顺序即段序，排在框架契约两段之后。 */
  body?: readonly string[];
  /** **附加模式**：追加到末尾的段落。 */
  append?: readonly string[];
  /**
   * **附加模式**：按段名替换内置段落（空串 = 抹掉该段）。
   * 键必须是 `SYSTEM_SECTION_IDS` 里的一个，且**不能是框架契约段** —— 违反就**拒绝装载**。
   * 判据是"覆盖一个不存在的段落不会有任何报错，表现是'配了、什么都没发生'"。
   */
  override?: Readonly<Record<string, string>>;
}

/** 加载之后才有的东西。 */
export interface ExtraRuntime {
  /**
   * 工具名 → 执行函数。**名字集合必须与同一扩展 `spec.tools` 的 `name` 集合逐个对上**
   * （两个方向都查：少一个 = 模型调得到却执行不了；多一个 = 死代码）。装载时校验，
   * 对不上就**拒绝装载并记日志**，不是静默返回错误。
   *
   * 为什么是"名字 → 函数"的映射、而不是单个 `execute(name, …)`：**只有这样名字集合才真的可枚举**。
   * 写成 `execute` 的话，运行时无法在不真的执行一次的前提下知道实现认哪些名字，
   * 那句"装载时校验"就只能退化成"凭声明相信它"—— 而声明与实现分居两处正是这套设计唯一的漂移点。
   * 这里的查表**不是**被禁的"字符串式业务注册表"：它是扩展自己实现的内部细节，
   * 键来自 `spec.tools`（注册表静态数据），不参与任何跨模块分发。
   */
  handlers: Readonly<Record<string, (ctx: ToolContext, args: ToolArguments) => Promise<ToolResult>>>;
  /** 命令名 → 处理函数。**与 `spec.commands` 的名字集合逐个对上**（同上）。 */
  commandHandlers?: Readonly<Record<string, ExtraCommandHandler>>;
  /**
   * 这个扩展此刻要往 system prompt 里加/改什么。
   *
   * **同步、无副作用**（每次运行开头被调一次）。**装载后才有、卸载即消失** —— 这是
   * "扩展的提示词随装载状态变化"那条取舍的唯一落点。没提供就什么也不加。
   */
  prompt?(): ExtraPromptContribution;
  /**
   * 释放这个扩展自己持有的重资源（子进程 / socket / 定时器 / 大缓存）。
   *
   * ⚠️ **没有 `dispose()` 的扩展，空闲卸载等于什么都没做**：Node ESM 没有模块卸载，
   * `import()` 的缓存永驻，卸载能回收的只有"扩展自己持有的东西" + 我们持有的那个引用。
   * 所以真正值得写扩展的人记住的一句话是：**你的重资源要在 `dispose()` 里放掉**。
   *
   * 必须幂等，且应当能在几秒内返回（运行时给每次 dispose 一个等待上限，卡住不会挂死关停）。
   */
  dispose?(): void | Promise<void>;
}

/** 注册表里的一行**去掉加载入口**的部分：纯数据，静态可得。 */
export interface ExtraSpec {
  /** 稳定标识，配置里按它开关。点分小写，如 `'clock'`。 */
  id: string;
  /** 设置页显示名。 */
  title: string;
  /**
   * **给人看的一句话说明**（设置页那一条切换旁边的小字）。
   *
   * ⚠️ 它**不是**模型看到的那段工具描述 —— 后者在下面 `ExtraToolSpec.description` 里，
   * 而且只许取自 `core/prompt-catalog.ts` 的 `EXTRA_PROMPT_TEXT`。两者受众不同，所以是两份文案：
   * 这里写给**管理员**看（"这功能是干什么的"），那里写给**模型**看（"什么时候该调它、传什么"）。
   * UI 文案本来就不属于提示词目录，所以这一条写在扩展自己的 spec 里是对的。
   *
   * 写一句就够（设置页那一行很窄）。它**不参与**任何模型可见的东西。
   */
  displayDesc: string;
  /** 形态。缺省 `attach`（加到主流程上）；`override` = 装载后接管主流程的模型侧三样。 */
  mode?: ExtraMode;
  /** 配置里没写这个 id 时的默认开关。 */
  defaultEnabled: boolean;
  tools: readonly ExtraToolSpec[];
  /** 斜杠命令的声明（判据静态可得，见 `ExtraCommandSpec`）。缺省 = 这个扩展没有命令。 */
  commands?: readonly ExtraCommandSpec[];
}

/** 注册表的一行：spec + 一个懒加载入口。 */
export interface ExtraEntry extends ExtraSpec {
  /**
   * 懒加载入口。
   *
   * ⚠️ 说明符**必须是字面量**（形如 `import('./clock/impl.js')`，写成变量就不行）—— 那才是
   * tsc 与打包脚本都看得见、且能随包发出去的东西。写成动态路径会让 tsc 看不见它、
   * `check-layers.mjs` 扫不到它、`scripts/build-desktop.mjs` 的 src⇄dist 对账也覆盖不到它，
   * 症状是"某个扩展没被搬进包"，而这正是打包脚本存在的唯一理由。`tests/t-extras.mjs`
   * 有一条源级断言钉这条。
   */
  load(): Promise<ExtraRuntime>;
}
