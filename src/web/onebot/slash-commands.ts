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
// `isSlashCommand()` 一处导出，ingest 与这里用的是同一张表。
//
// ── 命令的**解析**仍留在各自的领域模块里 ──
//
// `media/transcription/commands.ts` 的 `parseTranscriptionCommand`、
// `media/image-gen/commands.ts` 的 `parseDrawCommand`：那是各能力自己的语法与用法提示。
// 这里只管"认出是哪条命令、按什么顺序处理、回不回执"。
//
// ── 与注册层的两条禁令不冲突 ──
//
// 下边那张表存的是**函数引用**、运行期只按数组顺序 `for...of`，没有任何按键分发
// （与 `web/runtime/lifecycle.ts` 的装配清单同一形态）。命令名只是给日志与套件看的标签，
// 不参与分发。
import { parseTranscriptionCommand } from '../../media/transcription/index.js';
import { findReferenceImage, parseDrawCommand } from '../../media/image-gen/index.js';
import { errorMessage } from '../http/http.js';
import type { MediaEntry } from '../../chat/types.js';
import type { SendQueue } from '../../qq/sender.js';
import type { VideoTranscriptionQueue } from '../../media/transcription/index.js';
import type { ImageGenQueue } from '../../media/image-gen/index.js';

export interface SlashCommandInput {
  chatKey: string;
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

export interface SlashCommandDeps {
  transcription: Pick<VideoTranscriptionQueue, 'enqueue'>;
  imageGen: Pick<ImageGenQueue, 'enqueue'>;
  sender: Pick<SendQueue, 'sendTextBatch'>;
  log: (...args: unknown[]) => void;
}

interface SlashCommand {
  /** 命令词。**只用于日志**：分发靠下面那两条函数引用，不靠这个名字查表。 */
  name: string;
  /** 认命令：`/词` 后面跟空白或直接结束（`/画像` 不是 `/画`）。 */
  match(text: string): boolean;
  run(input: SlashCommandInput, deps: SlashCommandDeps): Promise<void>;
}

/**
 * 命令表。**加一条命令 = 加一行**。
 *
 * 顺序即行为（与装配清单同理）：两条命令的判据互不重叠，所以今天顺序无影响；但"先匹配到的先处理"
 * 是这张表的语义，将来若出现前缀重叠的命令（`/画` 与 `/画廊`），靠的就是这里的先后。
 */
const COMMANDS: readonly SlashCommand[] = [
  {
    name: 'transcribe',
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
  },
  {
    name: 'draw',
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
          replyToMessageId
        });
        // 回执里**不带任务号**：`/转写` 那句带它是因为那个任务是给敲命令的人看的进度凭据，
        // 而这里群友等的是一张图，一串 uuid 只会让人以为需要记住什么。
        return '在画了，稍等';
      });
    }
  }
];

/** 归一化后认命令。导出给 ingest：它要用**同一个判据**决定 `wakeEligible` 与要不要并入引用附件。 */
export function isSlashCommand(text: unknown): boolean {
  const value = String(text ?? '').trim();
  return COMMANDS.some((command) => command.match(value));
}

/**
 * 处理一条斜杠命令。**返回是否已接管**（`false` = 不是命令，调用方照常走 LLM 路径）。
 *
 * 返回布尔值而不是靠调用方先判一次：`isSlashCommand` 与这里用的是同一张表，所以两种用法
 * 都自洽，而"忘了判"只会变成一次无害的 `false`。
 */
export async function handleSlashCommand(
  input: SlashCommandInput, deps: SlashCommandDeps
): Promise<boolean> {
  const text = String(input.text ?? '').trim();
  const command = COMMANDS.find((item) => item.match(text));
  if (!command) return false;
  await command.run({ ...input, text }, deps);
  return true;
}

/**
 * 三条命令共用的外壳：跑命令体 → 成功发回执、失败把 `error.message` **原样**发回去。
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
