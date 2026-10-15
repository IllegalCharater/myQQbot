// OneBot 接入侧 · 斜杠命令（确定性快路径，不经过 LLM）
//
// **所有** `/xxx` 命令的判定、解析、入队与即时回执都只在这个文件里。
//
// ── 为什么集中在一处 ──
//
// 一条命令的**判据**同时决定三件事，它们分居三处时必然漂移：
//   ① 要不要把**引用消息里的附件**并进 media（`/转写` 靠它取引用的视频、`/画` 靠它取参考图）；
//   ② 要不要把它落成**已读历史**（`wakeEligible:false`，命令结果不该占一次唤醒）；
//   ③ 这条消息归谁处理。
// 判据写两遍时（`/^\/画(?:\s|$)/` 与 `/^\/画/` 看着都对）不会有任何报错，表现只有两种：
// **命令没被认出来、消息进了 LLM**，或者**同一条消息被处理两次**。所以判据由
// `createSlashCommands()` 产出的那一份**同时**给 ingest 与这里用。
//
// ── 命令的**解析**仍留在各自的领域模块里 ──
//
// `media/transcription/commands.ts` 的 `parseTranscriptionCommand`、
// `media/image-gen/commands.ts` 的 `parseDrawCommand`：那是各能力自己的语法与用法提示。
// 这里只管"认出是哪条命令、按什么顺序处理、回不回执"。
//
// ── 扩展（extra）的命令 ──
//
// 扩展**不认识 web**（分层闸门），所以它按自己的形状声明命令（`ExtraCommandSpec` + 一个
// `run(input) → 回执文本`），由 `src/extra/runtime.ts` 的 `commandDefs()` 交出来、在
// `web/app.ts` 里喂给本工厂。**判据仍然是同一个来源**：`isSlashCommand` 与 `handleSlashCommand`
// 读的是同一个 provider，所以"判据只有一份"这条性质没有破。
//
// ── 与注册层的禁令不冲突 ──
//
// 下面那些表存的是**函数引用**、运行期只按数组顺序 `for...of`，没有任何按键分发
// （与 `web/runtime/lifecycle.ts` 的装配清单同一形态）。命令名只是给日志与套件看的标签，
// 不参与分发。
import { parseTranscriptionCommand } from '../../media/transcription/index.js';
import { findReferenceImage, parseDrawCommand } from '../../media/image-gen/index.js';
import { parseJmcomicCommand } from '../../media/jmcomic/index.js';
import { errorMessage } from '../http/http.js';
import type { MediaEntry } from '../../chat/types.js';
import type { SendQueue } from '../../qq/sender.js';
import type { VideoTranscriptionQueue } from '../../media/transcription/index.js';
import type { ImageGenQueue } from '../../media/image-gen/index.js';
import type { ExtraActionResult, ExtraListRow } from '../../extra/runtime.js';
import type { ExtraCommand } from '../../extra/types.js';

export interface SlashCommandInput {
  chatKey: string;
  /**
   * 发起这条命令的群友 QQ 号。
   *
   * 命令**不只是**"一个会话里的一次入队"：`/漫画` 的去重键是**请求者 + 漫画 ID**
   * （`commandKey(requesterId, comicId)`），少了它就会退化成"全群共用一个人的额度"，
   * 表现为甲刚下过、乙再下就被判成重复提交。
   */
  senderId: string;
  /**
   * **用户真正敲的那句话**。
   *
   * 不是展开合并转发之后的存档文本：那是两回事。转发了一条聊天记录、而转发内容里恰好以
   * `/画` 开头时，按后者判会把它变成一条真命令（ingest 的 `commandText` 就是为这条分的）。
   */
  text: string;
  /** 本条消息的媒体 + 它引用那条消息的媒体（后者由 ingest 在 append 之前并进来）。 */
  media: MediaEntry[];
  replyToMessageId: string | number | null;
}

/** `/漫画` 只需要这些：会话标识、请求者、漫画 ID。运行时依赖由装配根绑好。 */
export interface SlashCommandJmcomicInput {
  chatKey: string;
  kind: 'group' | 'private';
  chatId: string;
  requesterId: string;
  comicId: string;
}

export interface SlashCommandDeps {
  transcription: Pick<VideoTranscriptionQueue, 'enqueue'>;
  imageGen: Pick<ImageGenQueue, 'enqueue'>;
  /** 漫画下载：端口只暴露"入队"，`onebot/sender/store` 由装配根在绑定处补齐。 */
  jmcomic: { enqueue(input: SlashCommandJmcomicInput): { position?: number } };
  /**
   * `/能力` 的**唯一口子**：列表 + 装载 + 卸载（同 `/漫画` 只拿 `enqueue`）。
   *
   * 可选：测试里的部分字面量不必跟着补。缺了 `/能力` 会如实回一句"扩展能力不可用"，
   * 不会假装成功。
   */
  extras?: {
    list(): ExtraListRow[];
    load(id: string, reason?: string): Promise<ExtraActionResult>;
    unload(id: string): Promise<ExtraActionResult>;
  };
  sender: Pick<SendQueue, 'sendTextBatch'>;
  log: (...args: unknown[]) => void;
}

interface SlashCommand {
  /**
   * **命令词本身**（如 `/转写`、`/能力`、扩展声明的 `/时间`）。
   *
   * 两份用途：日志标签（失败时那句 `[/转写] task=… code=…`），以及**别名规范化**的目标 ——
   * 命中别名时把它换成这个名字再交给 `run`。所以它必须是**真的能敲的那个词**，
   * 不能只是一个内部标识（曾经内置命令写的是 `'transcribe'` 这类标签，别名一接上就规范成了
   * `transcribe …`，解析器认不出来）。
   */
  name: string;
  /**
   * 可选的**别名**（另一批命令词）。判定规矩与 `name` 一样：词后面跟空白或直接结束。
   *
   * 命中别名时，分发层会把开头那个词**换成 `name`** 再交给 `run` —— 于是每个命令的解析器
   * 只需要认识自己那一个词（`/时间` 的解析不必知道有人用 `/time` 叫它）。
   * 判据见 `matchesCommand` / `canonicalize`。
   */
  aliases?: readonly string[];
  /** 认命令：`/词` 后面跟空白或直接结束（`/画像` 不是 `/画`）。 */
  match(text: string): boolean;
  run(input: SlashCommandInput, deps: SlashCommandDeps): Promise<void>;
}

/**
 * 扩展命令的**来源**。是 provider 而不是数组：接管模式会在运行期改变谁在里面。
 *
 * `ExtraCommand` 的定义在 `extra/types.ts` 里，**只有那一份** —— `web → extra` 是允许的方向
 * （check-layers），所以这里直接 import 它，而不是再抄一遍形状：抄一遍的话"两边漂移了"
 * 只能靠人核对，import 之后**编译器就会报**。
 *
 * ⚠️ `ExtraCommand` 与下面那个 `SlashCommand` 是**两个不同的职责，别合并**：那一个是**命令骨架**
 * （发回执、错误话术、失败不抛），这一个是**业务实现**（只返回一句话，不碰 sender）。
 * `adaptExtraCommand()` 就是把后者套进前者的那一层。
 */
export interface SlashCommandExtraSource {
  /** 接管中 = 主命令（除 `/能力`）让位。 */
  override: boolean;
  commands: readonly ExtraCommand[];
}

const NO_EXTRAS: SlashCommandExtraSource = { override: false, commands: [] };

// ── 主流程命令 ──

const transcribeCommand: SlashCommand = {
  name: '/转写',
  // `[视频]` 那个分支不是笔误：消息是 `/转写` + 一个视频段时，通用文本化会渲染成
  // `/转写[视频]`，不带这个分支就认不出命令。
  match: (text) => /^\/转写(?:\s|\[视频\]|$)/u.test(text),
  async run({ chatKey, text, media, replyToMessageId }, { transcription, sender, log }) {
    await runCommand('transcribe', { sender, log }, chatKey, replyToMessageId, async () => {
      const url = parseTranscriptionCommand(text, media);
      if (!url) return null;
      const job = transcription.enqueue({ chatKey, url, replyToMessageId });
      return `已开始处理（任务 ${job.id.slice(0, 8)}）`;
    });
  }
};

const drawCommand: SlashCommand = {
  name: '/画',
  match: (text) => /^\/画(?:\s|$)/u.test(text),
  async run({ chatKey, text, media, replyToMessageId }, { imageGen, sender, log }) {
    await runCommand('draw', { sender, log }, chatKey, replyToMessageId, async () => {
      const prompt = parseDrawCommand(text);
      if (!prompt) return null;
      imageGen.enqueue({
        chatKey,
        prompt,
        // 本条消息或它引用的那条里的第一张图 → 图生图；没有就是纯文字画图。
        imageUrl: findReferenceImage(media),
        replyToMessageId,
        // **与工具路径同一个 mode**（用户明确要求"两边行为统一"）：群友敲 `/画` 与让模型画
        // 出来的是同一件事，图发出去之后总得有人知道 —— 模型补一句「喏」也好、静默也好，
        // 那是它的判断。代价是每条命令多一次 LLM 运行（按次计费），
        // 与 `/转写` 那个"命令路径零 LLM 成本"的取舍**刻意不同**。
        mode: 'assisted'
      });
      // 回执里**不带任务号**：`/转写` 那句带它是因为那个任务是给敲命令的人看的进度凭据，
      // 而这里群友等的是一张图，一串 uuid 只会让人以为需要记住什么。
      return '在画了，稍等';
    });
  }
};

const jmcomicCommand: SlashCommand = {
  name: '/漫画',
  // `/漫画 12345`：只做"下载"这一件事 —— **搜索仍只由模型用 search_jmcomic 做**
  // （那是刻意的两条路：搜索廉价可反复，下载要拉全本、导出 PDF、传群文件且不可撤销）。
  // 敲命令的人已经明确给出了 ID，等于自己走完了"先搜、再挑、再确认"那道人工闸门。
  match: (text) => /^\/漫画(?:\s|$)/u.test(text),
  async run({ chatKey, text, senderId, replyToMessageId }, { jmcomic, sender, log }) {
    await runCommand('jmcomic', { sender, log }, chatKey, replyToMessageId, async () => {
      const comicId = parseJmcomicCommand(text);
      if (!comicId) return null;
      const [kind, chatId] = String(chatKey).split(':');
      // 去重键是**请求者 + 漫画 ID**，所以 senderId 必须一路传下去。
      // 回执同样不带队列位置/任务号：那些数字对敲命令的人没有任何用处。
      jmcomic.enqueue({
        chatKey,
        kind: kind === 'private' ? 'private' : 'group',
        chatId,
        requesterId: senderId,
        comicId
      });
      return '在下了，等下把 PDF 发上来';
    });
  }
};

/**
 * `/能力` —— **加载/卸载额外能力的唯一入口，也是模型一个入口都没有的那条路径**。
 *
 * 它**属于主流程**，因此接管模式下它**不让位**：接管者要交还主流程，只能靠这条命令，
 * 把它一起换掉就是死锁（装得上、卸不掉）。
 *
 * 权限与其它内置命令一致（白名单会话里可敲），另外受 `extras.maxLoadsPerHour` 约束 ——
 * 装载一个重扩展（比如要起 Python 子进程的）是真实的资源动作，不是闲聊。
 *
 * ⚠️ **它必须是斜杠命令，不能是工具**：这一轮的设计就是"装载的控制权在人手里"。
 * 给模型一个装载工具等于把这条边界拆掉。
 */
const capabilitiesCommand: SlashCommand = {
  name: '/能力',
  // 别名只是"另一个叫法"，语义完全一样（命中别名时会被规范回主命令词再解析）。
  aliases: ['/扩展'],
  match: (text) => /^\/能力(?:\s|$)/u.test(text),
  async run({ chatKey, text, replyToMessageId }, { extras, sender, log }) {
    await runCommand('capabilities', { sender, log }, chatKey, replyToMessageId, async () => {
      if (!extras) return '扩展能力不可用（这一侧没有装上扩展运行时）';
      const match = /^\/能力(?:\s+(\S+))?(?:\s+(\S+))?/u.exec(text.trim());
      const action = match?.[1] ?? '';
      const id = match?.[2] ?? '';
      if (!action) return renderCapabilityList(extras.list());
      if (action !== '加载' && action !== '卸载') {
        return '用法：/能力（看列表）、/能力 加载 <id>、/能力 卸载 <id>';
      }
      if (!id) return `用法：/能力 ${action} <扩展 id>（id 见 /能力 列表）`;
      const result = action === '加载' ? await extras.load(id) : await extras.unload(id);
      return `${result.ok ? '✅' : '⚠️'} ${result.note}`;
    });
  }
};

const BUILTIN_COMMANDS: readonly SlashCommand[] = [transcribeCommand, drawCommand, jmcomicCommand, capabilitiesCommand];

/**
 * 接管模式下仍然保留的主流程命令 —— **只有 `/能力`**。
 *
 * 其余三条（`/转写` `/画` `/漫画`）是主流程的**功能**，接管时整体让位；`/能力` 不是功能，
 * 是"把主流程换回来"的开关。少了它，管理员装上一个接管扩展之后再没有任何办法卸掉它。
 */
const OVERRIDE_KEPT_COMMANDS: readonly SlashCommand[] = [capabilitiesCommand];

export interface SlashCommands {
  /** 归一化后认命令。导出给 ingest：它要用**同一个判据**决定 `wakeEligible` 与要不要并入引用附件。 */
  isSlashCommand(text: unknown): boolean;
  /** 处理一条斜杠命令。**返回是否已接管**（`false` = 不是命令，调用方照常走 LLM 路径）。 */
  handleSlashCommand(input: SlashCommandInput, deps: SlashCommandDeps): Promise<boolean>;
}

/**
 * `词` 后面跟**空白或直接结束** —— 别名与主判据共用同一条规矩（`/画像` 不是 `/画`）。
 *
 * 中文没有分词，这条判据是"前缀 + 边界"能做到的极限；再放宽（比如 `includes`）会把
 * `/画廊今天开了吗` 认成 `/画` 命令。
 */
function startsWithWord(text: string, word: string): boolean {
  if (!word || !text.startsWith(word)) return false;
  const rest = text.slice(word.length);
  return rest === '' || /^\s/u.test(rest);
}

/**
 * 一条命令认不认这句话：主判据 `match` **或**任一别名。
 *
 * ⚠️ `isSlashCommand` 与 `handleSlashCommand` 必须都走这一个函数 —— 分成两份时的表现是
 * "命令没被认出来、消息进了 LLM"或"同一条消息被处理两次"，两种都不报错。
 */
function matchesCommand(command: SlashCommand, text: string): boolean {
  if (command.match(text)) return true;
  return (command.aliases ?? []).some((alias) => startsWithWord(text, alias));
}

/**
 * 命中别名时，把开头那个词换成**主命令词**再交给 `run`。
 *
 * 不做这一步的话，每个命令的解析器都得自己认识全部别名 —— 内置命令的解析散在 `media/` 下各能力的
 * commands.ts 里，扩展的在 `impl.ts` 里，加一个别名要改三处，而漏改的表现是
 * "命令被认出来了、但解析不出参数"（`/time` 交给只认 `^/时间` 的解析器 → 返回用法提示）。
 */
function canonicalize(command: SlashCommand, text: string): string {
  for (const alias of command.aliases ?? []) {
    if (startsWithWord(text, alias)) return command.name + text.slice(alias.length);
  }
  return text;
}

/**
 * 把扩展贡献的命令套上**与内置命令同一只外壳**（`runCommand`）：回执发送、"抛出的中文原样进群"、
 * 发送失败不抛 —— 那三条是三条内置命令共用的一份，扩展不必再写一遍，行为也就不会漂移。
 *
 * 这个函数同时是**形状的编译期检查**：`ExtraCommandInput` 与 `SlashCommandInput` 一旦漂移，
 * 这里就编译不过（这正是"两份形状必然漂移"的机检形态）。
 */
function adaptExtraCommand(command: ExtraCommand): SlashCommand {
  return {
    name: command.name,
    aliases: command.aliases,
    match: command.match,
    run: (input, deps) => runCommand(
      command.name, deps, input.chatKey, input.replyToMessageId, () => command.run(input)
    )
  };
}

/**
 * 建一套命令分发器。
 *
 * @param source 每次调用现读一次（**扩展命令与接管状态都会在运行期变**）。
 * @param extras `/能力` 用的三个口子。在这里收下（而不是每回都让调用方塞进 `deps`），
 *   是为了让 `createIngest` 那一侧不必认识扩展 —— 它只管把命令交给分发器。
 *
 * 顺序即行为（与装配清单同理）：主流程命令在前、扩展命令在后 —— 所以**扩展永远遮蔽不了内置**
 * （某个扩展声明了 `/画`，那条匹配永远轮不到它，是死代码而不是覆盖）。
 */
export function createSlashCommands(
  source: () => SlashCommandExtraSource = () => NO_EXTRAS,
  extras?: SlashCommandDeps['extras']
): SlashCommands {
  const tableFor = (): ReadonlyArray<SlashCommand> => {
    const current = source();
    const builtin = current.override ? OVERRIDE_KEPT_COMMANDS : BUILTIN_COMMANDS;
    return [...builtin, ...current.commands.map(adaptExtraCommand)];
  };

  return {
    isSlashCommand(text) {
      const value = String(text ?? '').trim();
      return tableFor().some((command) => matchesCommand(command, value));
    },
    async handleSlashCommand(input, deps) {
      const text = String(input.text ?? '').trim();
      const command = tableFor().find((item) => matchesCommand(item, text));
      if (!command) return false;
      // 走的是**别名**的话，把开头那个词规范回主命令词：解析器只认识一个词。
      await command.run({ ...input, text: canonicalize(command, text) }, { ...deps, extras });
      return true;
    }
  };
}

/** `/能力` 无子命令时的列表。写得紧凑些：它是发到群里的。 */
function renderCapabilityList(rows: ExtraListRow[]): string {
  if (!rows.length) return '这个版本没有注册任何扩展。';
  const line = (row: ExtraListRow) => {
    const state = row.loaded
      ? (row.mode === 'override' ? '✅ 接管中' : '✅ 已加载')
      : (row.enabled ? '○ 未加载' : '✖ 设置里关着');
    const tip = row.loaded ? '' : `　→ /能力 加载 ${row.id}`;
    return `- ${row.title}（${row.id}）${state}${tip}`;
  };
  return [
    '扩展能力（✅ 已加载 / ○ 可用但未加载 / ✖ 停用）：',
    ...rows.map(line),
    '',
    '用法：/能力 加载 <id>、/能力 卸载 <id>'
  ].join('\n');
}

/**
 * 所有命令共用的外壳：跑命令体 → 成功发回执、失败把 `error.message` **原样**发回去。
 *
 * 原样发是有意的：解析层抛的本来就是中文用户文案（`/画` 的用法提示、`/转写` 的
 * "无法访问链接：仅支持 http/https"…），换成一句"命令执行失败"会把这些**可执行的提示**
 * 全丢掉，而群里那位是唯一能照着改的人。
 *
 * 命令体返回 `null` = 不吭声（例如 `/转写` 在消息里找不到可转写的链接时，解析层已经抛了
 * 用法提示；返回空串才是"没什么可说的"）。
 *
 * 回执发送失败只记日志、不再抛：这是接入链路上的收尾动作，抛出去会把 OneBot 的入站回调
 * 打成一条未处理异常，而消息本身已经落档了。
 */
async function runCommand(
  tag: string,
  { sender, log }: Pick<SlashCommandDeps, 'sender' | 'log'>,
  chatKey: string,
  replyToMessageId: string | number | null,
  body: () => Promise<string | null>
): Promise<void> {
  try {
    const receipt = await body();
    if (receipt) await sender.sendTextBatch(chatKey, receipt, { replyToMessageId });
  } catch (error) {
    await sender.sendTextBatch(chatKey, errorMessage(error) || '命令执行失败', { replyToMessageId })
      .catch(() => log(`[${tag}] task=unassigned code=ONEBOT_SEND_FAILED`));
  }
}
