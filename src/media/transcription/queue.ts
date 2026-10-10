// 转写队列：单并发状态机。
//
// ── 与出图/漫画共用的东西在 `media/task-queue.ts` ──
//
// 注册表、串行排空、中止与关停语义、"跑完/失败"的判定全在那边（三个能力同形）；
// 这里只留**这条路自己的**：FFmpeg 探测、临时目录、音轨提取与云端识别、投递与回流、失败话术。
// 计时器（下面那个 `#wake`）**刻意留在本文件**：`LONG_TERM_TASKS.owner` 的语义是
// "实际持有这些计时器的模块"，`tests/t-tasks.mjs` 按它反查"文件里有没有调度调用"。
//
// ── 为什么恒为单并发 ──
//
// 下游是 FFmpeg + 一次几十 MB 的上传，放开并发只会让每一段都变慢（带宽与 CPU 互相抢），
// 而"总任务超时"是从发出时刻起算的 —— 排队时间会把真正干活的预算吃掉。要提高吞吐应
// 限制入队速率，而不是把排空改成 N 个。
//
// ── 两条投递路径 ──
//
// `job.mode` 是**唯一**分岔点（见 `types.ts` 的 `InternalJob.mode`）：`standalone` 自己
// 往群里贴文本；`assisted` 交给注入的回流端口，由模型自己决定说什么。
//
// **成功与失败都走这条分岔**（2026-10-10 统一，与出图/漫画同形）：assisted 下失败也交给
// 回流端口（`status:'failed'`），由模型自己给群友一句交代。只有"确定没人接"时才退回
// `standalone` 的行为 —— 缺端口（`NO_DELIVER_SINK`）或端口抛错（`DELIVER_FAILED`）。
// 那种退回在成功与失败两条路上都要做：静默丢弃等于群友什么都等不到，而模型也不知道
// 有这条结果（`#deliverAssisted` / `#reportFailure` 的返回值就是给调用方判这个的）。
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../../core/config.js';
import { SlidingWindowBudget } from '../call-budget.js';
import { TaskQueue } from '../task-queue.js';
import type { SetTaskStatus } from '../task-queue.js';
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
  #queue: TaskQueue<InternalJob, EffectiveConfig>;
  #wake: ReturnType<typeof setTimeout> | null = null;
  #started = false;
  #stopping = false;
  #ffmpegError = '';
  /**
   * 成本闸门。**两条入口共用**（`transcribe_video` 工具与 `/转写` 命令都走 `enqueue`），
   * 所以它挂在这里而不是工具层 —— 见 `enqueue` 里那段说明。
   * 限额每次现读配置（改完设置即时生效），与 `webBudget` / 出图同一写法。
   */
  #budget: SlidingWindowBudget;

  constructor({ sender, onebot, getConfig, log = console.log, operations = {}, deliverTranscript = null }: QueueDeps) {
    this.#sender = sender;
    this.#onebot = onebot;
    this.#getConfig = getConfig;
    this.#log = log;
    this.#operations = operations;
    this.#deliverTranscript = deliverTranscript;
    this.#budget = new SlidingWindowBudget({
      getLimits: () => {
        const cfg = resolveTranscriptionConfig(this.#getConfig());
        return { perChatPerHour: cfg.maxCallsPerChatPerHour, perDay: cfg.maxCallsPerDay };
      }
    });
    this.#queue = new TaskQueue<InternalJob, EffectiveConfig>({
      getConfig: this.#getConfig,
      log: this.#log,
      resolveConfig: resolveTranscriptionConfig,
      execute: (job, signal, setStatus, config) => this.#execute(job, signal, setStatus, config),
      onError: (job, error, elapsedMs) => this.#fail(job, error, elapsedMs),
      onChange: (job) => this.#logStatus(job),
      // 对外视图：**不含 `sourceUrl`**（用户给的 URL 不该出现在读模型/接口里）。
      projectView: ({ id, chatKey, status, failedStage, createdAt, updatedAt, audioBytes, elapsedMs, errorCode }) =>
        ({ id, chatKey, status, failedStage, createdAt, updatedAt, audioBytes, elapsedMs, errorCode }),
      limit: 100
    });
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
    if (this.#queue.hasPending()) this.#schedule();
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#wake) clearTimeout(this.#wake);
    this.#wake = null;
    // 还没开跑的直接判失败并说清是关停 —— 留着它们会随着进程消失而静默丢失。
    // （出图同样这么处置；漫画**不**，它的任务要活过重启。）
    for (const job of this.#queue.takePending()) {
      this.#queue.setStatus(job, 'failed', { failedStage: 'extracting', errorCode: 'SHUTDOWN' });
    }
    this.#queue.abortInFlight();
    // 等在跑的那一次收尾（它会自己清理临时目录）：stop 的语义是"停干净"，
    // 不是"把上一次的失败再抛一遍"（核心不会把这次关停报成失败）。
    await this.#queue.whenIdle().catch(() => {});
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
    // ── 成本闸门 ──
    // ⚠️ 它**曾经在工具层**（`agent/tools/transcription.ts`），于是 `/转写` 命令路径不受限。
    // 2026-10-10 统一到队列，与出图同形，理由有两条：
    //   ① `/转写` 是群里任何人都能敲的，而转写按次向腾讯云计费 —— 命令路径不设闸门
    //      等于开一个可被刷的开支口子（出图当初就是这么定的）；
    //   ② 放进 `enqueue` 后两条入口**自动共用同一本账**，也避免了"工具先扣一次、
    //      队列再扣一次"的双记。**这是有意的行为变更**（旧文档写的"命令不受限"已作废）。
    // 闸门排在所有**零成本校验之后**：被拒的那一次不该占额度，也不该建任务。
    try {
      this.#budget.take(chatKey);
    } catch (error) {
      if (error instanceof Error && error.message === 'RATE_LIMITED') {
        throw new TranscriptionError('validation', 'RATE_LIMITED',
          `本群转写太频繁（每小时最多 ${config.maxCallsPerChatPerHour} 次、全部会话每天 ${config.maxCallsPerDay} 次），稍后再试`);
      }
      throw error;
    }
    const now = Date.now();
    const job: InternalJob = {
      id: randomUUID(), chatKey, sourceUrl, replyToMessageId,
      // 归一化只在这一处：投递侧永远拿到确定值，不需要自己兜 undefined。
      mode: mode === 'assisted' ? 'assisted' : 'standalone',
      status: 'queued', createdAt: now, updatedAt: now
    };
    // 有界保留最近 100 条由核心管（只挤**已结束**的：任务视图是给"刚派上那几条"看的）。
    this.#queue.add(job);
    this.#log(`[transcribe] task=${job.id}`);
    this.#schedule();
    return this.#queue.view(job) as unknown as TranscriptionJobView;
  }

  get(taskId: string): TranscriptionJobView | null {
    const job = this.#queue.get(taskId);
    return job ? this.#queue.view(job) as unknown as TranscriptionJobView : null;
  }

  /** 状态一变就记一行（与旧实现逐字同形：只有任务号时不打，免得入队刷两行）。 */
  #logStatus(job: InternalJob): void {
    const fields = [`[transcribe] task=${job.id}`];
    if (job.audioBytes != null) fields.push(`bytes=${job.audioBytes}`);
    if (job.elapsedMs != null) fields.push(`elapsedMs=${job.elapsedMs}`);
    if (job.errorCode) fields.push(`code=${job.errorCode}`);
    if (fields.length > 1) this.#log(fields.join(' '));
  }

  /**
   * 排一个 0ms 的唤醒，把"入队"与"开工"解耦（入队不阻塞在 `await` 上）。
   *
   * 计时器**归本文件持有**（见文件头）：`LONG_TERM_TASKS.owner` 要指到实际调度的那一层。
   * 延迟由核心给（`idleDelay()`）：转写/出图永远是 0（有活就干），漫画那里是"最早的重试时刻"。
   */
  #schedule(): void {
    if (this.#wake || this.#queue.draining || this.#stopping) return;
    const delay = this.#queue.idleDelay();
    if (delay === null) return;
    this.#wake = setTimeout(() => {
      this.#wake = null;
      void this.#queue.drain(() => this.#stopping).finally(() => this.#schedule());
    }, delay);
  }

  /**
   * 一个任务的**整件事**：干活 → 投递。
   *
   * 两个操作的注入点**逐字保留**（套件靠它们假造一次完整的提取/识别/投递）。
   */
  async #execute(
    job: InternalJob, signal: AbortSignal,
    setStatus: SetTaskStatus<InternalJob>, config: EffectiveConfig
  ): Promise<void> {
    const run = this.#operations.runTask
      || ((target, sig, status, current) => this.#runProduction(target, sig, status, current));
    const result = await run(job, signal, setStatus, config);
    // 关停与远端响应可能同时发生：不得交付迟到结果。
    if (signal.aborted || this.#stopping) {
      throw new TranscriptionError('extracting', 'CANCELLED', '转写任务已取消');
    }
    const deliver = this.#operations.deliver
      || ((target, text, current) => this.#deliver(target, text, current));
    await deliver(job, result, config);
  }

  /**
   * 失败收尾。核心**关停时也照样调它**（那是"这个任务确实没跑成"，状态必须记），
   * 而"要不要发那句话"是这里看的 —— 关停途中不发失败文案：那是我们主动取消的。
   *
   * 谁开口与出图那条同一条规矩（见文件头的「两条投递路径」）：assisted 下先交给回流端口，
   * **由模型自己交代**；只有没人接（缺端口 / 端口抛错）才退回往群里贴一句。
   * `standalone`（`/转写` 命令路径）压根没有模型，照旧直接贴。
   */
  async #fail(job: InternalJob, error: unknown, elapsedMs: number): Promise<void> {
    const safe = userError(error);
    this.#queue.setStatus(job, 'failed', {
      failedStage: safe.stage, errorCode: safe.code, elapsedMs
    });
    if (this.#stopping) return;
    if (job.mode === 'assisted' && await this.#reportFailure(job, safe)) return;
    await this.#sender.sendTextBatch(job.chatKey, `转写失败（${safe.stage}）：${safe.userMessage}`, {
      replyToMessageId: job.replyToMessageId
    }).catch((sendError) => {
      this.#log(`[transcribe] task=${job.id} code=${safeErrorCode(sendError)}`);
    });
  }

  /**
   * 失败也走**同一条回流通道**告诉模型（与出图/漫画同形，2026-10-10 统一）。
   *
   * 为什么必须回流而不是队列代它开口：这条路上模型只调了一次工具就结束本轮，随后那次运行
   * 才是它说话的地方。队列代说，它就会以为"群里已经说过了"而不再开口 —— 症状看起来是
   * "任务没有正常结束"，其实是**任务被代发伪装成了已收尾**（这条在转写上实测过）。
   *
   * 返回 `true` = 已经有人接了（模型会在下一次运行里开口）；`false` = 没人接，
   * 调用方退回贴文案。**两条退路都要如实说清**：缺端口（`NO_DELIVER_SINK`）与端口抛错
   * （`DELIVER_FAILED`）—— 静默丢弃会让群友什么都等不到。
   */
  async #reportFailure(job: Readonly<InternalJob>, safe: TranscriptionError): Promise<boolean> {
    const sink = this.#deliverTranscript;
    if (!sink) {
      this.#log(`[transcribe] task=${job.id} code=NO_DELIVER_SINK`);
      return false;
    }
    try {
      await sink({
        chatKey: job.chatKey,
        status: 'failed',
        text: '',
        truncated: false,
        chars: 0,
        reason: safe.userMessage,
        replyToMessageId: job.replyToMessageId
      });
      return true;
    } catch {
      // 只记固定错误码，不记异常正文：日志里不得出现 URL 或识别文本。
      this.#log(`[transcribe] task=${job.id} code=DELIVER_FAILED`);
      return false;
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
    //
    // `limit` 的取值两条路共用。这本来是 **QQ 单条消息**的上限，assisted 下同时当作
    // **条目正文**的上限：好处是"群里人看到的"与"模型看到的"是同一段文本、与文件上传
    // 阈值也自然一致。代价要知道：【本次唤醒】是保护区、**永不裁剪**，所以一条 3500 字的
    // 条目约占 `store.promptContextMaxChars`（默认 32000）的 11%，极端情况下会挤掉
    // 表情/摘要/记忆/已读历史。有界、可接受，故不另开配置项。
    const limit = Math.max(200, config.resultMaxChars - prefix.length - 20);

    // 两条路的**唯一**分岔点。job.mode 在 enqueue 里已归一化，这里不需要兜底。
    if (job.mode !== 'assisted') {
      await this.#speakResult(job, text, prefix, limit);
      return;
    }

    // Array.from 与 slice 同一口径：按码点算，代理对不会被劈成两半。
    const chars = Array.from(text).length;
    const truncated = chars > limit;
    // 超长时**先**把全文作为文件发给群里 —— 模型只会念开头那一段，群里那份完整的得另给。
    // 失败只记日志、不当成任务失败（结果本身还在）。
    const fullFileOk = truncated ? await this.#uploadText(job, text) : true;
    const head = Array.from(text).slice(0, limit).join('');
    if (await this.#deliverAssisted(job, { text: head, truncated, chars })) return;
    // 没人接（缺端口 / 端口抛错）→ 退回 standalone 的投递行为，否则群友什么都等不到。
    // ⚠️ 全文文件上面已经发过一次了（`fullFileOk` 就是那次的结果）：**不许再发**，
    // 否则群里会出现两份全文；补救文案照旧按那次的结果说。
    await this.#speakResult(job, text, prefix, limit, fullFileOk);
  }

  /**
   * standalone 的投递行为：截断段 + 超长时的全文文件 + 上传失败时的补救文案。
   * `/转写` 命令那条路的顺序与文案**逐字保留**（它没有模型，全靠这几句）。
   *
   * `fullFileOk` 传 `null` 表示"还没发过，这一步来发"；assisted 退回时文件已经发过了，
   * 传那次的结果 —— 不能重发（群里会出现两份全文）。
   */
  async #speakResult(
    job: Readonly<InternalJob>, text: string, prefix: string, limit: number, fullFileOk: boolean | null = null
  ): Promise<void> {
    // 判据用**码点**（与 assisted 那条同一口径）：UTF-16 长度会把一个 emoji 数成两个字符，
    // 于是同一个 limit 在两条路上分岔。行为与旧实现只在这一点上不同，且是往对的方向。
    if (Array.from(text).length <= limit) {
      await this.#sender.sendTextBatch(job.chatKey, prefix + text, { replyToMessageId: job.replyToMessageId });
      return;
    }
    await this.#sender.sendTextBatch(
      job.chatKey,
      `${prefix}${Array.from(text).slice(0, limit).join('')}\n\n文本过长，已截断；完整内容将作为 UTF-8 文本文件发送。`,
      { replyToMessageId: job.replyToMessageId }
    );
    const ok = fullFileOk === null ? await this.#uploadText(job, text) : fullFileOk;
    if (!ok) {
      await this.#sender.sendTextBatch(job.chatKey, '完整文本文件发送失败；上方为截断结果。').catch(() => {});
    }
  }

  /**
   * 模型自主路径的投递：把结果交给回流端口，由它落成一条存档条目并唤醒 Agent，
   * **由模型自己决定说什么**。队列不往群里贴任何文本 —— 模型稍后自己会开口，
   * 再贴一段转写就是重复发言。
   *
   * 返回 `true` = 已经有人接了这个结果。
   *
   * ⚠️ **全程不抛**。调用方把异常一律当成"转写失败"，那会同时把任务记成 failed
   * 并往群里发一条莫须有的「转写失败」——而结果其实已经拿到了，只是没送出去。
   * ⚠️ 缺端口 / 端口抛错时**不静默**：返回 `false` 让调用方退回贴文本 ——
   * "只有确定有人接的时候才闭嘴"（与出图那条同一条规矩；静默丢弃的后果是群友
   * 什么都等不到，而模型压根不知道有这条结果）。
   */
  async #deliverAssisted(
    job: Readonly<InternalJob>, { text, truncated, chars }: { text: string; truncated: boolean; chars: number }
  ): Promise<boolean> {
    const sink = this.#deliverTranscript;
    if (!sink) {
      this.#log(`[transcribe] task=${job.id} code=NO_DELIVER_SINK`);
      return false;
    }
    try {
      await sink({
        chatKey: job.chatKey,
        status: 'sent',
        text,
        truncated,
        chars,
        reason: '',
        replyToMessageId: job.replyToMessageId
      });
      return true;
    } catch {
      // 只记固定错误码，不记异常正文：日志里不得出现 URL 或识别文本。
      this.#log(`[transcribe] task=${job.id} code=DELIVER_FAILED`);
      return false;
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
