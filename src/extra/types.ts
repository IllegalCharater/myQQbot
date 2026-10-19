// 扩展（extra）的对外契约。
//
// 一个"扩展"可以提供三样东西：**模型工具**、**斜杠命令**、**system prompt 片段**；
// 外加一个可选的重资源生命周期。它**不**自带面板页（那是 `ui/` 的活）。
//
// ── 谁能触发装载 ──
//
// **模型没有任何装载入口。** 未装载的扩展，它的工具根本不在工具表里（模型连"有这个能力"
// 都看不到）；装载与卸载的唯一入口是主流程那条 `/能力` 命令 —— **入口是人**（群里还要求
// @ 机器人，那是"我是故意冲着机器人说的"唯一的信号）。
// 于是"命令的判据按 spec 静态（启用即可敲）、工具的表按装载状态（只含真正可用的）"
// 这条不对称是刻意的，别把它"顺手统一"掉。
// ⚠️ 但**认得出 ≠ 能用**：敲一个未装载扩展的命令不会把它拉起来，只会得到一句"先 /能力 加载"。
// 判据静态是为了**不静默**（否则消息会当普通消息进 LLM），不是为了隐式装载。
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
import type { ChatMessage, MediaEntry } from '../chat/types.js';

/** 模型可见的工具声明。**纯数据** —— 拿到它不需要加载任何实现。 */
export interface ExtraToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * 一条**机器条目**（回流）。扩展只说"这是一条什么、正文是什么"，怎么落库是宿主的事。
 *
 * ⚠️ 它与 `say` 那条路**完全不同**：这个不往群里发消息，它落的是一条**未读**条目、推窗口、
 * 让模型有机会自己开口（见 `chat/store.ts` 的 `appendAsyncResult` 与
 * `agent/context/response-policy.ts`）。扩展拿它当"把事实交回去"，不当"发言"用 ——
 * 发言只有扩展自己的 `sendTool` 一条路。
 */
export interface ExtraNote {
  /** 条目的子类型，渲染标签按它分（跑团用 `journal` / `suggest`）。 */
  kind: string;
  text: string;
}

/**
 * 一次**不属于任何会话**的模型调用的用量（跑团的兜底建议与暗骰叙事那两次独立调用）。
 *
 * 形状与 `llm` 的 `UsageTotals` 逐字段一致（调用方用 `addUsage(emptyUsage(), result.usage)`
 * 直接产出它，见 `llm/llm.ts`），宿主拿到手不必再转一道。**刻意不 import `llm` 的那个类型**：
 * 本文件只 import 下层**类型**，而这个形状只有四个数 —— 抄一份比多一条跨层依赖划算，
 * 且 `UsageTotals` 里多出来的 `calls` 与"记一次用量"无关。
 */
export interface ExtraUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
}

/** 组装根递给扩展的口子。扩展自己决定要不要用。 */
export interface ExtraRuntimeDeps {
  /**
   * 把一条机器条目送进会话（落存档 → 入窗 → 通知面板）。
   *
   * 由 `web/app.ts` 递进来，而不是扩展自己 `import` 那条链 —— 组装是 web 的活，
   * 而且这条链要碰 `ChatStore` 与 `Orchestrator`（`extra → agent` 是反向依赖）。
   * 缺省时什么都不做：测试与未接线的宿主不需要它。
   */
  deliverNote?(chatKey: string, note: ExtraNote): void;

  /**
   * **私聊投递**：把一句话发给某个 QQ 号（跑团的暗骰用它）。
   *
   * 与 `deliverNote` 同一条理由 —— 扩展只说"给谁、说什么"，怎么发是宿主的事：那条链要碰
   * `SendQueue`，而 `extra → web` 是反向依赖（`check-layers` 会拦），组装是 `web/` 的活。
   *
   * ⚠️ **缺省时调用方要自己判**（跑团的 `.rh` 就是先看它在不在再掷）—— 掷了却发不出去，
   * 等于把这次暗骰丢了，而群里只会看到一句"发不出去"。
   *
   * ⚠️ 它**绕过了扩展自己的会话**：目标可能是一个从没跟机器人说过话的私聊。那会在对方的
   * 私聊存档里留下一条 `我：…`（`SendQueue.appendSelf`）—— 那是刻意的（玩家能往回翻），
   * 代价是"从没聊过天的私聊"会出现在存档列表里。
   */
  sendPrivate?(targetUserId: string, text: string): Promise<void>;

  /**
   * **发一份文件进会话**（跑团的 `.log export` 用它）。
   *
   * 与前两个口子同一条理由：扩展只说"发什么"（文件名 + 正文），怎么发是宿主的事 ——
   * 那条链要碰 `SendQueue` 与 OneBot 的 `upload_group_file`，而 `extra → web` 是反向依赖。
   *
   * `chatKey` 是会话键（`group:123` / `private:456`），宿主据此决定传群文件还是私聊文件 ——
   * 扩展**不该**知道协议端有这两个不同的动作。
   *
   * ⚠️ **缺省时调用方要自己判**（`.log export` 就是先看它在不在）：发不出去时假装成功，
   * 群友会一直等一个永远不来的文件。
   */
  sendFile?(chatKey: string, fileName: string, content: string): Promise<void>;

  /**
   * **往会话里发一句话**（跑团的 `.trpg scenario` 用它把"抽完了"的回执补上）。
   *
   * 与 `deliverNote` 的区别是**收件人**：`deliverNote` 是给**模型**的一条机器条目（会落存档、
   * 入窗、唤醒一次运行），而这个只是**发给群里的一句话**（群友看到，模型不因此被叫醒）。
   * 两者都会落一条 `我：…` 的存档 —— 那是"机器人说过什么"的记账，与唤醒无关。
   *
   * ⚠️ **它是"命令的回执可以不只一条"这条路的唯一出口**：`CommandHandler` 的返回值只够
   * 回一句，而 `.trpg scenario` 要在**开始做**和**做完了**各说一句 —— 中间那段（抽取管线）
   * 最长 90 秒，占住的是整个会话的入站处理链（`ingest.ts` 的 `enqueueIngest` 按会话串行）。
   *
   * ⚠️ **缺省时调用方必须退回同步路径**（`.trpg scenario` 就是先看它在不在）：没有它就没法
   * 事后补一句话，异步化只会让群友永远等不到回执。
   */
  sendText?(chatKey: string, text: string): Promise<void>;

  /**
   * **记一次不在任何会话里的模型调用用量**（跑团的兜底建议与暗骰叙事）。
   *
   * 那两次调用都发生在 `SessionRegistry.finish()` **之后**（一条挂在收尾回调上、一条在命令回执
   * 里），所以它们借不了"会话"这条记账路：那条路（`#persist` → `#bumpTodayUsage`）对**已结束**
   * 的会话每次都会把整份 `usage` 再累加一遍，拿它补记一次增量等于把那一整轮的账算两遍。
   * 宿主接的是 `SessionRegistry.addExtraUsage`（只叠增量、**不动 `runs`** —— 这两次不是一次
   * agent 运行，算进去会让面板上的"每次花多少"失真）。
   *
   * ⚠️ **缺省时调用方照常干活**（与其余口子同一条）：记不上是账面的小缺口，不该让一次暗骰
   * 或一次兜底建议失败。跑团因此只在拿到口子时才上报。
   */
  recordUsage?(usage: ExtraUsage): void;
}

/**
 * 一次运行结束时的快照。扩展的 `onRunEnd` 收它。
 *
 * **手上有哪些事实**就是这四样，够跑团那句"这一轮 DM 一句话没说、而且是被真人推动的"用，
 * 也刻意不更多 —— 一个能看穿整条会话的钩子会诱使人拿它去做本来该进 `runAgent` 的事。
 */
export interface ExtraRunEnd {
  chatKey: string;
  /** 收尾状态：`done` / `noreply` / `error` / `aborted`。 */
  status: string;
  /** 这一轮真的发出去几条（`recordSent` 那本账的条数，`media/` 与面板读的也是它）。 */
  sentCount: number;
  /** 触发这一轮的消息（判断"这一轮是不是由真人推动的"要用它）。 */
  trigger: readonly ChatMessage[];
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
 * ⚠️ 判据必须放在这里、而不是实现里：`isCommandEntry()` 是同步的、且在入站热路径上被调
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

  /**
   * **子命令**（2026-10-16 加）。声明期的糖：由 `runtime.ts` 展开成 `<names[0]> <sub>` 这些
   * **普通命令词**，此后没有任何地方知道"子命令"这个概念。
   *
   * 判据是"词形仍然只有一个落点"：不展开的话，每个子命令要么各自写一条 `names`
   * （`names: ['.trpg new']` —— 那也可以，只是清单变长），要么在 `run` 里自己切第一个词
   * （那就多出**第二份**判定，而两份判据漂移的症状是"命令认出来了、参数解析不出来"）。
   *
   * 展开的产物是 `{ names: ['<命令> <子命令>'] }`，所以：
   *   • `commandHandlers` 的键是 `'.trpg new'` 这样**带空格**的串（装载期两个方向对账）；
   *   • 判定沿用既有的边界规则 —— `词` 后面跟空白就算命中，而 `'<命令> <子命令>'` 里的空白
   *     正好是那个边界，所以 `.trpg new 灯塔` 落到 `.trpg new` 上、`rest` 是 `' 灯塔'`；
   *   • **不带 `subs` 的声明就是一条普通命令**（`names[0]` 自己当键）。
   *
   * ⚠️ **裸命令要单独声明一条**（`{ names: ['.trpg'] }` 排在带 subs 的那条**之后**）：
   * 带 subs 的声明**只产出子命令**，自己不占 `names[0]`。靠后的裸命令因此成了"一个子命令
   * 都没匹配上"的兜底（回用法提示）。顺序即行为 —— 反过来的话裸命令会先命中，
   * 所有子命令全被它吃掉。
   */
  subs?: readonly string[];

  /**
   * **群里敲这条命令要不要先 @ 机器人**（2026-10-19 加）。缺省 `true`。
   *
   * 主流程那几条（`/转写` `/画` `/漫画` `/能力`）**一律要 @**（那条规则在 `web/onebot/commands.ts`，
   * 与扩展无关）；扩展这一侧则是**每个扩展自己决定** —— 因为"该不该 @ "取决于这个命令在群里是什么角色：
   *   • `clock` 的 `/时间` 是个通用小工具，谁都能随手敲一句 —— 那正是群里最吵的一种消息，**要 @**；
   *   • `trpg` 那族（`.trpg` / `.pc` / `.r` / `.combat` …）只在**它已经接管的那个会话**里存在，
   *     而那个群此刻就是在跑团：掷个骰子还要先 @ 一下没法玩，**不要 @**。
   *
   * ⚠️ **缺省是 `true`（要 @）而不是 `false`**：默认值挑的是"更安静"的那一侧 —— 忘了声明的表现是
   * "群里敲它没反应"（作者一试就发现），而不是"群里谁都能触发它"（安静地吵，没人会去查）。
   *
   * ⚠️ 判据只作用于**群聊**：私聊没有 @ 这回事，那里恒不生效。
   */
  requiresMention?: boolean;
}

/**
 * 命令处理函数的入参。与 `web/onebot/commands.ts` 的 `CommandInput` **同形但独立**：
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
 * **拦下一条消息**的结果。`null`（钩子本身返回 null）= 不管这条，照常走模型。
 */
export interface ExtraInterceptResult {
  /**
   * 回给群里的话。不写 / `null` = **不吭声**（只拦下、不发言）—— 屏蔽、去重这类事要的就是这个。
   *
   * ⚠️ 这句话由**宿主**发（`SendQueue`），扩展碰不到 sender —— 与命令回执同一条分工：
   * 扩展只说"回什么"，"怎么发出去"是 web 侧那层外壳的事。
   */
  reply?: string | null;
}

/**
 * 一个**配置补丁**：形状与 `data/config.json` 相同，深合并到"这一轮运行读的那份配置"上。
 *
 * ⚠️ 它**不改全局、不落盘**（`core/config.ts` 的 `mergeConfigPatch`）：改全局的那条路只有
 * `updateConfig` 一条。这决定了两件事：① 一次覆盖的寿命就是一次运行，**不写进用户的配置文件**；
 * ② 同一时刻并行的两个会话各看到自己那份，互不干扰。
 */
export type ExtraConfigPatch = Record<string, unknown>;

/**
 * 扩展交出来的**一条命令**：声明 + 处理函数。`ExtrasRuntime.commandDefs()` 交出来的就是它。
 *
 * ⚠️ 它上面那个 `ExtraCommandHandler` / `ExtraCommandInput` 与 web 侧的 `CommandEntry` /
 * `CommandInput` **是两个不同的东西，别合并**：
 *   • 本类型是**业务实现** —— 只返回一句回执文本，**不碰 sender**（扩展拿不到 `SendQueue`）；
 *   • web 侧那个 `CommandEntry` 是**命令骨架** —— 回执的发送、`error.message` 原样进群、
 *     发送失败不抛，三条都在它的 `runCommand` 外壳里。
 * `web/onebot/commands.ts` 的 `adaptExtraCommand()` 就是把前者套进后者的那一层。
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
   * **这个会话此刻能用的工具名**。不写这个方法 = `spec.tools` 全部。
   *
   * ── 为什么需要它 ──
   *
   * 接管是**按会话**的，而同一个扩展在不同会话里可能是不同的形态 —— 跑团就是那个例子：
   * 一个群当骰子助手、另一个群当 DM。工具表是从 `spec.tools` 静态拼出来的，没有这个钩子的话，
   * "助手模式只暴露骰子"就只能靠提示词求模型别去调那些工具 —— 而它们**还占着每轮的请求前缀**，
   * 也仍然是可以被调用的。这个钩子让"仅能"变成结构上的事实。
   *
   * ── 三条边界 ──
   *
   *   • **只能返回 `spec.tools` 里声明过的名字**。多出来的会被 `toolDefs()` 滤掉并记日志 ——
   *     不是抛错，因为装载期已经校验过"声明 ⇄ 实现"，这里多出来的只可能是拼错的字符串。
   *   • **必须收下 `chatKey` 且必须是全函数**（任何输入都不许抛），理由与 `prompt` 逐字相同：
   *     装载时 `checkRuntimeShape` 会**空着会话调它一次**，抛了就等于拒绝装载，
   *     而症状会表现成"这个扩展装不上"，与工具表毫无关系。
   *   • **它让工具表按会话变化**（同 `toolDefs(chatKey)` 那条）：切换形态会打散一次提示词缓存。
   *     频次由人控制（群里敲一条命令），这正是这条设计换来的东西。
   */
  toolsFor?(chatKey: string): readonly string[];
  /**
   * **这条消息你要不要自己接**。返回 `null` = 不管，照常落未读、走模型。
   *
   * ── 它解决的是什么 ──
   *
   * 斜杠命令已经是一条"确定性快路径"，但它要求群友**先敲斜杠**。而这个钩子让"纯工具能力"
   * 越过模型回复：一个骰子机器人可以直接认下 `3d6+2` 并当场回话，**一整轮模型调用都不发生**。
   * 没有它的话，这类消息只能靠模型去判"这看起来是个骰子表达式"再调工具 —— 慢、要花钱，
   * 而且**受响应档位约束**（把参与度调低的群里，连 `3d6` 都不会理）。
   *
   * ── 四条边界 ──
   *
   *   • **收的是与命令相同的入参**（`ExtraCommandInput`）—— 它们本来就是同一件事：一条入站消息
   *     加上它的媒体。`text` 是**用户真正敲的那句**（不是展开合并转发之后的存档文本）。
   *   • **必须是同步的**：它跑在**每一条**入站消息上，不只那几条命令。一个会 `await` 的实现
   *     会把整条入站链拖慢，而它自己看不出慢在哪里；要干慢活就交给后台队列（像 `/画` 那样）。
   *   • **必须是全函数**：抛错会被吞掉并记日志（宿主替你兜住，不会污染入站回调），但那条消息
   *     会照常走模型 —— 也就是"你本想接的没接上"，只在日志里留一行。
   *   • **只有这个会话里可用的扩展会被问到**（与工具表同一套判据）：附加模式要 `/能力 加载`
   *     过，接管模式要那个会话正在被它接管。
   *
   * ── 拦下之后 ──
   *
   * 消息**照常存档、照常上面板**，但落成**已读**历史（与斜杠命令逐字同形）：模型以后在
   * 【过去状态】里读得到，**这一轮不惊动它**。这条是"Hook 只负责接、不负责抹"的落点 ——
   * 不落档会让面板与存档从此不一致，落成未读则当场与"越过模型"自相矛盾。
   */
  intercept?(input: ExtraCommandInput): ExtraInterceptResult | null;
  /**
   * **这一轮运行要叠上的配置补丁**（见 `ExtraConfigPatch`）。
   *
   * 作用域是"**这个会话的这一次模型运行**"：`agent-runner` 在开头算一份
   * `configFor(chatKey)` 交下去，那一轮读到的每一处配置都是叠过之后的 —— 而**全局那份不受影响**，
   * 也不落盘。所以接管 A 群的扩展**不会**顺手改掉 B 群的行为（那正是"全局叠加"会有的外溢）。
   *
   * ⚠️ 与 `prompt` / `toolsFor` 一样**必须收 `chatKey` 且必须是全函数**：装载时会空着会话调一次
   * （只验"返回的是不是对象"），抛了就等于拒绝装载，而症状会表现成"这个扩展装不上"。
   *
   * ⚠️ **它管不到整条链路**，只管"这一轮运行读的那些"。入站白名单、发送限频、面板显示读到的
   * 仍然是全局那份配置 —— 那些不在"一次运行"的范围内。
   *
   * ⚠️ **上下文窗口容量、历史深度与响应档位都曾经也管不到**，三样都是靠**改读取点**才管得到的
   * （2026-10-16 前两项、2026-10-19 第三项）：分别读在 `Orchestrator` 建窗口时、`wake-scheduler`
   * 算历史深度时、以及 `wake-scheduler` 判"要不要惊动模型"时。**想往这张单子上加一项，办法是
   * 改那个读取点**，不是在这里加一句话 —— 读取点没改，这一侧的补丁就是纯粹的死配置，
   * 而症状是"配了、看着生效、实际用的是别的"。
   */
  configPatch?(chatKey: string): ExtraConfigPatch;
  /**
   * 这个扩展此刻要往 system prompt 里加/改什么。
   *
   * **同步、无副作用**（每次运行开头被调一次，见 `PromptPlan` 的说明）。**装载后才有、卸载即消失**
   * —— 这是"扩展的提示词随装载状态变化"那条取舍的唯一落点。没提供就什么也不加。
   *
   * ⚠️ **必须收下 `chatKey` 且必须是全函数**（任何输入都不许抛）。两个理由：
   *   • 没有 `chatKey` 就做不了"按会话渲染"——接管是按会话的，一个扩展完全可能同时接管
   *     好几个群，各自的内容不一样（跑团的状态卡就是最典型的例子）；
   *   • 装载时（`checkRuntimeShape`）会**空着会话调它一次**来做段落名对账，
   *     所以 `chatKey === ''` 必须能返回一份合法的贡献，而不是抛错。
   */
  prompt?(chatKey: string): ExtraPromptContribution;
  /**
   * 一次 agent 运行结束了（收尾点是 `chat/sessions.ts` 的 `SessionRegistry.finish`）。
   *
   * **同步或异步都行，抛错会被吞掉并记日志** —— 它是运行收尾路径上的旁路，不该有能力
   * 影响主流程。缺省 = 这个扩展不关心。
   *
   * ⚠️ **它不是一个"每轮都被调用"的钩子**：只在**这个扩展正在接管 `chatKey`** 时才会被调到
   * （见 `runtime.ts` 的 `runEnded`）。附加模式的扩展没有"这一轮"的概念。
   */
  onRunEnd?(session: ExtraRunEnd): void | Promise<void>;
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
  /**
   * **这个扩展的存活时间（毫秒）** —— 装载之后多久自动放掉（2026-10-19 加）。
   *
   * 它是**扩展自己的知识**，所以声明在实现这一侧：一个骰子机器人该常驻，
   * 一个要起子进程的重能力该闲着就收；而"多久算久"取决于这个扩展干什么，
   * 不取决于管理员的全局口味。设置页那个数只在**这里没写**的时候兜底
   * （`extras.idleUnloadMs`）—— 写了就以这里为准，配置改不动它。
   *
   * 取值：
   *   • **缺省（不写）** = 用配置 `extras.idleUnloadMs` 兜底；
   *   • **`0`** = 不限，永不自动放掉（只能 `/能力 卸载`、关开关、或进程退出）；
   *   • 正数 = 那么久之后自动放掉。
   *
   * ⚠️ **两种模式都读它，但计法不同**（那是**模式**的性质，不是这个数的性质）：
   *   • **附加**：**滑动**的空闲窗口 —— 每次执行都往后推（"多久没人用"）；
   *   • **接管**：**从建立接管那一刻起算的固定租期** —— 中途用得多也不续期（"这个人做的接管动作什么时候失效"）。
   *   所以同一个数在两种模式下观感完全不同，接管模式尤其要小心（跑团就是靠声明 `0` 才不会被中途踢回主流程）。
   *
   * ⚠️ 它是**纯数据**，只许写数字：`validateRegistry` 在装配期拒绝非有限数（写坏了会静默变成"永不释放"
   * 或"立刻释放"，两种都难查）。
   */
  lifetimeMs?: number;
  /**
   * **接管模式专用**：框架契约段要引用的工具名。
   *
   * ── 为什么非有这个字段不可 ──
   *
   * `security` 与 `toolProtocol` 两段在**任何模式下都强制保留**（`SYSTEM_FRAMEWORK_SECTIONS`），
   * 而 `toolProtocol` 第 2 条要写一句"要发言必须调用 X"。接管会话里**内置工具整体让位**
   * （`web/app.ts` 只把接管者的工具拼进表），所以那个默认的 X（`send_message`）**不在表里** ——
   * 模型照着提示词一调就拿到"未知工具"，然后按它自己的经验重试，每次发言白烧一轮。
   *
   * 主流程的工具名是参数（`PROMPT_CATALOG.system.toolProtocol({ sendTool, finishTool })`），
   * 接管者在这里声明自己那两个工具叫什么，`ExtrasRuntime.promptPlan()` 把它带进提示词。
   *
   * ⚠️ **`mode: 'override'` 的扩展必须写 `sendTool`**：装载时校验，缺了直接拒绝装载。
   * 判据不是"风格"——"接管了一个不会说话的东西"是必然故障，而症状安静（模型输出一串
   * 思考文本、群里什么都没有）。`finishTool` 可选，写 `null` 表示本扩展没有收尾工具，
   * 框架段第 5 条就不提它（提一个不存在的名字比不提更坏）。
   *
   * 非接管模式**不许**写这个字段（写了也没有任何地方读它，只会让下一个人以为它生效了）。
   */
  overrideTools?: {
    /** 发言工具名。**接管模式必填**，且必须是本扩展 `tools` 里的一个名字。 */
    sendTool?: string;
    /** 收尾工具名；`null` = 没有，框架段不提它。缺省 `finish`。同样必须是本扩展的工具。 */
    finishTool?: string | null;
  };
  /** 配置里没写这个 id 时的默认开关。 */
  defaultEnabled: boolean;
  tools: readonly ExtraToolSpec[];
  /** 斜杠命令的声明（判据静态可得，见 `ExtraCommandSpec`）。缺省 = 这个扩展没有命令。 */
  commands?: readonly ExtraCommandSpec[];
}

/** 注册表的一行：spec + 一个懒加载入口。 */
export interface ExtraEntry extends ExtraSpec {
  /**
   * 懒加载入口。**收下宿主的口子**（`ExtraRuntimeDeps`）—— 扩展拿到它才能在运行期做
   * "宿主才知道怎么做"的事（比如把一条回流条目送进会话）。扩展不用它就忽略参数。
   *
   * 为什么是参数而不是让扩展自己 import：那条链要碰 `ChatStore` 与 `Orchestrator`
   * （`extra → agent` 是反向依赖，`check-layers` 会拦），而且组装是 `web/` 的活。
   *
   * ⚠️ 说明符**必须是字面量**（形如 `import('./clock/impl.js')`，写成变量就不行）—— 那才是
   * tsc 与打包脚本都看得见、且能随包发出去的东西。写成动态路径会让 tsc 看不见它、
   * `check-layers.mjs` 扫不到它、`scripts/build-desktop.mjs` 的 src⇄dist 对账也覆盖不到它，
   * 症状是"某个扩展没被搬进包"，而这正是打包脚本存在的唯一理由。`tests/t-extras.mjs`
   * 有一条源级断言钉这条。
   */
  load(deps: ExtraRuntimeDeps): Promise<ExtraRuntime>;
}
