// 转写队列：单并发状态机。
//
// ── 为什么恒为单并发 ──
//
// 下游是 FFmpeg + 一次几十 MB 的上传，放开并发只会让每一段都变慢（带宽与 CPU 互相抢），
// 而"总任务超时"是从发出时刻起算的 —— 排队时间会把真正干活的预算吃掉。要提高吞吐应
// 限制入队速率，而不是把 `#drain` 改成 N 个。
//
// ── 两条投递路径 ──
//
// `job.mode` 是**唯一**分岔点（见 `types.ts` 的 `InternalJob.mode`）：`standalone` 自己
// 往群里贴文本；`assisted` 交给注入的回流端口，由模型自己决定说什么。
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../../core/config.js';
import { resolveTranscriptionConfig } from './config.js';
import { normalizeTranscriptionUrl } from './commands.js';
import { checkFfmpegBinary, extractAudio } from './extract.js';
import { requireCloudConfig, recognizeFlash } from './recognize.js';
import { safeErrorCode, TranscriptionError, userError } from './errors.js';
import type {
  DeliveryMode, EffectiveConfig, InternalJob, QueueDeps, QueueOperations,
  TranscriptionJobView, TranscriptionSender, TranscriptionStatus, TranscriptSink, OneBotFileClient
} from './types.js';

export class VideoTranscriptionQueue {
  #sender: TranscriptionSender;
  #onebot: OneBotFileClient;
  #getConfig: () => AppConfig;
  #log: (...args: unknown[]) => void;
  #operations: QueueOperations;
  #deliverTranscript: TranscriptSink | null;
  #jobs = new Map<string, InternalJob>();
  #pending: InternalJob[] = [];
  #wake: ReturnType<typeof setTimeout> | null = null;
  #drainPromise: Promise<void> | null = null;
  #currentAbort: AbortController | null = null;
  #started = false;
  #stopping = false;
  #ffmpegError = '';

  constructor({ sender, onebot, getConfig, log = console.log, operations = {}, deliverTranscript = null }: QueueDeps) {
    this.#sender = sender;
    this.#onebot = onebot;
    this.#getConfig = getConfig;
    this.#log = log;
    this.#operations = operations;
    this.#deliverTranscript = deliverTranscript;
  }

  async start(): Promise<void> {
    this.#stopping = false;
    this.#ffmpegError = '';
    const config = resolveTranscriptionConfig(this.#getConfig());
    try {
      await (this.#operations.checkFfmpeg || checkFfmpegBinary)(config.ffmpegPath);
    } catch {
      // 探测失败**不抛**：抛出去会掀翻 `app.start()`，而 FFmpeg 缺失只影响这一个能力。
      // 记在 `#ffmpegError` 上，等真的有人要用时再明确拒绝并说清原因。
      this.#ffmpegError = 'FFMPEG_UNAVAILABLE';
      this.#log('[transcribe] code=FFMPEG_UNAVAILABLE');
    }
    this.#started = true;
    if (this.#pending.length) this.#schedule();
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#wake) clearTimeout(this.#wake);
    this.#wake = null;
    // 还没开跑的直接判失败并说清是关停 —— 留着它们会随着进程消失而静默丢失。
    for (const job of this.#pending.splice(0)) {
      this.#setStatus(job, 'failed', { failedStage: 'extracting', errorCode: 'SHUTDOWN' });
    }
    this.#currentAbort?.abort();
    // 等在跑的那一次收尾（它会自己清理临时目录），并把 rejected 吞掉：
    // stop 的语义是"停干净"，不是"把上一次的失败再抛一遍"。
    await this.#drainPromise?.catch(() => {});
    this.#started = false;
  }

  enqueue({ chatKey, url, replyToMessageId = null, mode = 'standalone' }: {
    chatKey: string;
    url: unknown;
    replyToMessageId?: string | number | null;
    /**
     * 投递方式，默认 `standalone`（见 `InternalJob.mode`）。
     *
     * **可选是刻意的**：`tests/` 是 `.mjs`，`tsc` 看不见它们，必填字段只会逼着每个夹具
     * 改一遍 —— 而"为了让夹具变绿"顺手填错值，恰恰是两条路径最容易被搅在一起的方式。
     * 留默认值，既有的 `enqueue({ chatKey, url })` 就继续跑在 standalone 上，
     * 那正是它最需要的回归网。
     */
    mode?: DeliveryMode;
  }): TranscriptionJobView {
    if (!this.#started) throw new TranscriptionError('validation', 'NOT_STARTED', '转写服务尚未启动');
    if (this.#stopping) throw new TranscriptionError('validation', 'STOPPING', '转写服务正在关闭');
    if (this.#ffmpegError) throw new TranscriptionError('validation', this.#ffmpegError, '转写不可用：未检测到 FFmpeg');
    const config = resolveTranscriptionConfig(this.#getConfig());
    if (!config.enabled) throw new TranscriptionError('validation', 'DISABLED', '转写服务未启用');
    requireCloudConfig(config);
    const sourceUrl = normalizeTranscriptionUrl(url);
    const now = Date.now();
    const job: InternalJob = {
      id: randomUUID(), chatKey, sourceUrl, replyToMessageId,
      // 归一化只在这一处：投递侧永远拿到确定值，不需要自己兜 undefined。
      mode: mode === 'assisted' ? 'assisted' : 'standalone',
      status: 'queued', createdAt: now, updatedAt: now
    };
    this.#jobs.set(job.id, job);
    this.#pending.push(job);
    // 有界保留最近 100 条：任务视图是给"刚派上那几条"看的，无上限会随运行时长涨。
    while (this.#jobs.size > 100) this.#jobs.delete(this.#jobs.keys().next().value as string);
    this.#log(`[transcribe] task=${job.id}`);
    this.#schedule();
    return this.#view(job);
  }

  get(taskId: string): TranscriptionJobView | null {
    const job = this.#jobs.get(taskId);
    return job ? this.#view(job) : null;
  }

  /** 对外视图：**不含 `sourceUrl`**（用户给的 URL 不该出现在读模型/接口里）。 */
  #view(job: InternalJob): TranscriptionJobView {
    const { id, chatKey, status, failedStage, createdAt, updatedAt, audioBytes, elapsedMs, errorCode } = job;
    return { id, chatKey, status, failedStage, createdAt, updatedAt, audioBytes, elapsedMs, errorCode };
  }

  #setStatus(job: InternalJob, status: TranscriptionStatus, extra: Partial<InternalJob> = {}): void {
    Object.assign(job, extra, { status, updatedAt: Date.now() });
    const fields = [`[transcribe] task=${job.id}`];
    if (job.audioBytes != null) fields.push(`bytes=${job.audioBytes}`);
    if (job.elapsedMs != null) fields.push(`elapsedMs=${job.elapsedMs}`);
    if (job.errorCode) fields.push(`code=${job.errorCode}`);
    if (fields.length > 1) this.#log(fields.join(' '));
  }

  /** 排一个 0ms 的唤醒，把 `enqueue` 与 `#drain` 解耦（入队不阻塞在 `await` 上）。 */
  #schedule(): void {
    if (this.#wake || this.#drainPromise || this.#stopping) return;
    this.#wake = setTimeout(() => {
      this.#wake = null;
      void this.#drain();
    }, 0);
  }

  async #drain(): Promise<void> {
    if (this.#drainPromise || this.#stopping) return;
    this.#drainPromise = (async () => {
      while (!this.#stopping) {
        const job = this.#pending.shift();
        if (!job) break;
        const startedAt = Date.now();
        const controller = new AbortController();
        this.#currentAbort = controller;
        const config = resolveTranscriptionConfig(this.#getConfig());
        try {
          const run = this.#operations.runTask || ((target, signal, setStatus, current) =>
            this.#runProduction(target, signal, setStatus, current));
          const result = await run(job, controller.signal, (status, extra) => this.#setStatus(job, status, extra), config);
          // 即使关停与远端响应同时发生，也不得交付迟到结果。
          if (controller.signal.aborted || this.#stopping) {
            throw new TranscriptionError('extracting', 'CANCELLED', '转写任务已取消');
          }
          const deliver = this.#operations.deliver || ((target, text, current) => this.#deliver(target, text, current));
          await deliver(job, result, config);
          this.#setStatus(job, 'done', { elapsedMs: Date.now() - startedAt });
        } catch (error) {
          const safe = userError(error);
          this.#setStatus(job, 'failed', {
            failedStage: safe.stage, errorCode: safe.code, elapsedMs: Date.now() - startedAt
          });
          // 关停途中不发失败文案：那是我们主动取消的，不是任务真的失败。
          if (!this.#stopping) {
            await this.#sender.sendTextBatch(job.chatKey, `转写失败（${safe.stage}）：${safe.userMessage}`, {
              replyToMessageId: job.replyToMessageId
            }).catch((sendError) => {
              this.#log(`[transcribe] task=${job.id} code=${safeErrorCode(sendError)}`);
            });
          }
        } finally {
          this.#currentAbort = null;
        }
      }
    })();
    try {
      await this.#drainPromise;
    } finally {
      this.#drainPromise = null;
      // 排空期间可能又入队了；`#stopping` 时不再排（否则 stop 永远等不到"没有下次"）。
      if (this.#pending.length && !this.#stopping) this.#schedule();
    }
  }

  /** 默认的生产实现：临时目录 → 提取音轨 → 云端识别。临时目录**无论如何**都要删。 */
  async #runProduction(
    job: Readonly<InternalJob>, signal: AbortSignal,
    setStatus: (status: TranscriptionStatus, extra?: Partial<InternalJob>) => void,
    config: EffectiveConfig
  ): Promise<string> {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qq-agent-transcription-'));
    const audioPath = path.join(tempDir, `${job.id}.mp3`);
    try {
      setStatus('extracting');
      const extracted = await extractAudio(job.sourceUrl, audioPath, config, signal);
      setStatus('extracting', { audioBytes: extracted.bytes });
      return await recognizeFlash(audioPath, config, signal, setStatus);
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async #deliver(job: Readonly<InternalJob>, result: string, config: EffectiveConfig): Promise<void> {
    const text = result || '（未识别到有效语音）';
    const prefix = '转写结果：\n';
    // 留 20 字余量：`sendTextBatch` 会自己再拼回复前缀，贴边会被它顶出去。
    const limit = Math.max(200, config.resultMaxChars - prefix.length - 20);

    // 两条路的**唯一**分岔点。job.mode 在 enqueue 里已归一化，这里不需要兜底。
    if (job.mode === 'assisted') {
      await this.#deliverAssisted(job, text, limit);
      return;
    }

    if (text.length <= limit) {
      await this.#sender.sendTextBatch(job.chatKey, prefix + text, { replyToMessageId: job.replyToMessageId });
      return;
    }

    await this.#sender.sendTextBatch(
      job.chatKey,
      `${prefix}${Array.from(text).slice(0, limit).join('')}\n\n文本过长，已截断；完整内容将作为 UTF-8 文本文件发送。`,
      { replyToMessageId: job.replyToMessageId }
    );
    if (!await this.#uploadText(job, text)) {
      await this.#sender.sendTextBatch(job.chatKey, '完整文本文件发送失败；上方为截断结果。').catch(() => {});
    }
  }

  /**
   * 模型自主路径的投递：把结果交给回流端口，由它落成一条存档条目并唤醒 Agent，
   * **由模型自己决定说什么**。队列不往群里贴任何文本 —— 模型稍后会自己开口，
   * 再贴一段转写就是重复发言。
   *
   * 超长时仍然上传全文文件：条目正文只留开头（`resultMaxChars`），群里那份完整的
   * 得另给。上传失败只记日志，不当成任务失败。
   *
   * ⚠️ **全程不抛**。调用方 `#drain` 把异常一律当成"转写失败"，那会同时把任务记成
   * failed 并往群里发一条莫须有的「转写失败」——而结果其实已经拿到了，只是没送出去。
   *
   * `limit` 的取值沿用了 standalone 的口径（`resultMaxChars`）。这本来是 **QQ 单条消息**
   * 的上限，这里同时当作**条目正文**的上限：好处是"群里人看到的"与"模型看到的"是同一段
   * 文本、与文件上传阈值也自然一致。代价要知道：【本次唤醒】是保护区、**永不裁剪**，
   * 所以一条 3500 字的条目约占 `store.promptContextMaxChars`（默认 32000）的 11%，
   * 极端情况下会挤掉表情/摘要/记忆/已读历史。有界、可接受，故不另开配置项。
   */
  async #deliverAssisted(job: Readonly<InternalJob>, text: string, limit: number): Promise<void> {
    // Array.from 与 slice 同一口径：按码点算，代理对不会被劈成两半。
    const chars = Array.from(text).length;
    const truncated = chars > limit;
    if (truncated) await this.#uploadText(job, text);

    const sink = this.#deliverTranscript;
    if (!sink) {
      // 没有回流端口就什么都发不出去 —— 不能无声无息，留一条日志说明结果没落地。
      this.#log(`[transcribe] task=${job.id} code=NO_DELIVER_SINK`);
      return;
    }
    try {
      await sink({
        chatKey: job.chatKey,
        text: Array.from(text).slice(0, limit).join(''),
        truncated,
        chars,
        replyToMessageId: job.replyToMessageId
      });
    } catch {
      // 只记固定错误码，不记异常正文：日志里不得出现 URL 或识别文本。
      this.#log(`[transcribe] task=${job.id} code=DELIVER_FAILED`);
    }
  }

  /**
   * 把完整文本作为文件上传到原会话。返回是否成功；失败只记日志、不抛。
   *
   * 临时代理目录的创建也放进 try：`mkdtemp` 自己失败时不该把任务判成失败
   * （standalone 路径下宁可只发一句"文件发送失败"）。
   */
  async #uploadText(job: Readonly<InternalJob>, text: string): Promise<boolean> {
    let tempDir = '';
    try {
      tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qq-agent-transcript-'));
      const filePath = path.join(tempDir, `transcription-${job.id}.txt`);
      await fsp.writeFile(filePath, text, 'utf8');
      const [kind, id] = job.chatKey.split(':');
      const params = kind === 'group'
        ? { group_id: Number(id), file: filePath, name: path.basename(filePath) }
        : { user_id: Number(id), file: filePath, name: path.basename(filePath) };
      await this.#onebot.call(kind === 'group' ? 'upload_group_file' : 'upload_private_file', params, 120_000);
      return true;
    } catch (error) {
      this.#log(`[transcribe] task=${job.id} code=${safeErrorCode(error)}`);
      return false;
    } finally {
      if (tempDir) await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
