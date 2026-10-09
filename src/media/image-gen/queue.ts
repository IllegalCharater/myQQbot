// 图像生成队列：单并发状态机。
//
// ── 为什么恒为单并发 ──
//
// 与转写同一条判断：出图是"挂着等几十秒"的同步请求，下游按张计费；放开并发只会让几张图
// 一起变慢，而"总任务超时"是从发出时刻起算的 —— 排队时间会把真正干活的预算吃掉。
// 要提高吞吐应该限制入队速率，而不是把 `#drain` 改成 N 个。
//
// ── 两条投递路径 ──
//
// `job.mode` 是**唯一**分岔点（见 `types.ts` 的 `InternalJob.mode`）：两条路都**由队列自己
// 把图发进群**（图片就是交付物，模型没法"说"出一张图），差别只在发完要不要回流一次唤醒
// 让模型补一句话。这与 jmcomic 的 PDF 上传是同一个分工。
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../../core/config.js';
import { SlidingWindowBudget } from '../call-budget.js';
import { resolveImageGenConfig } from './config.js';
import { generateImage } from './client.js';
import { ImageGenError, safeErrorCode, safeErrorDetail, userError } from './errors.js';
import { downloadImageToFile, fetchReferenceImage } from './image-io.js';
import type {
  DeliveryMode, EffectiveConfig, FailureStage, ImageArtifact, ImageGenJobView, ImageGenSender,
  ImageGenStatus, ImageResultSink, InternalJob, QueueDeps, QueueOperations
} from './types.js';

/** 失败阶段 → 群里那句话里的中文标签。阶段码本身仍然单独进日志（`errorCode`）。 */
const STAGE_LABELS: Record<FailureStage, string> = {
  validation: '参数',
  fetching: '取参考图',
  generating: '画图',
  downloading: '下载图片',
  uploading: '发送'
};

export class ImageGenQueue {
  #sender: ImageGenSender;
  #getConfig: () => AppConfig;
  #log: (...args: unknown[]) => void;
  #operations: QueueOperations;
  #deliverImageResult: ImageResultSink | null;
  #budget: SlidingWindowBudget;
  #jobs = new Map<string, InternalJob>();
  #pending: InternalJob[] = [];
  #wake: ReturnType<typeof setTimeout> | null = null;
  #drainPromise: Promise<void> | null = null;
  #currentAbort: AbortController | null = null;
  #started = false;
  #stopping = false;

  constructor({ sender, getConfig, log = console.log, operations = {}, deliverImageResult = null }: QueueDeps) {
    this.#sender = sender;
    this.#getConfig = getConfig;
    this.#log = log;
    this.#operations = operations;
    this.#deliverImageResult = deliverImageResult;
    // 成本闸门。**两条入口共用**（`generate_image` 工具与 `/画` 命令都走 enqueue），
    // 所以它挂在这里而不是工具层 —— 这与 `/转写` 的取舍刻意不同：出图按张计费，
    // 而 `/画` 是群里任何人都能敲的，命令路径不设闸门等于开一个可被刷的开支口子。
    // 限额每次现读配置（改完设置即时生效），与 webBudget / 转写同一写法。
    this.#budget = new SlidingWindowBudget({
      getLimits: () => {
        const cfg = resolveImageGenConfig(this.#getConfig());
        return { perChatPerHour: cfg.maxCallsPerChatPerHour, perDay: cfg.maxCallsPerDay };
      }
    });
  }

  async start(): Promise<void> {
    this.#stopping = false;
    this.#started = true;
    if (this.#pending.length) this.#schedule();
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#wake) clearTimeout(this.#wake);
    this.#wake = null;
    // 还没开跑的直接判失败并说清是关停 —— 留着它们会随着进程消失而静默丢失。
    for (const job of this.#pending.splice(0)) {
      this.#setStatus(job, 'failed', { failedStage: 'validation', errorCode: 'SHUTDOWN' });
    }
    this.#currentAbort?.abort();
    // 等在跑的那一次收尾（它会自己清临时目录），并把 rejected 吞掉：
    // stop 的语义是"停干净"，不是"把上一次的失败再抛一遍"。
    await this.#drainPromise?.catch(() => {});
    this.#started = false;
  }

  /**
   * 入队。
   *
   * 校验顺序是刻意的：**所有零成本的拒绝都排在记账之前**（未启用/缺 Key/描述为空或超长/
   * 地址无效），被拒的那一次不占额度、也不建任务。与 `reverse_image_source` 的
   * "先解析出目标 → 占额度 → 才建任务"同一条。
   */
  enqueue({ chatKey, prompt, imageUrl = '', replyToMessageId = null, mode = 'standalone' }: {
    chatKey: string;
    prompt: unknown;
    /** 图生图（I2I）的参考图地址；留空 = 纯文生图。 */
    imageUrl?: unknown;
    replyToMessageId?: string | number | null;
    /**
     * 投递方式，默认 `standalone`（见 `InternalJob.mode`）。
     *
     * **可选是刻意的**：`tests/` 是 `.mjs`，`tsc` 看不见它们，必填字段只会逼着每个夹具
     * 改一遍 —— 而"为了让夹具变绿"顺手填错值，恰恰是两条路径最容易被搅在一起的方式。
     */
    mode?: DeliveryMode;
  }): ImageGenJobView {
    if (!this.#started) throw new ImageGenError('validation', 'NOT_STARTED', '画图服务尚未启动');
    if (this.#stopping) throw new ImageGenError('validation', 'STOPPING', '画图服务正在关闭');
    const config = resolveImageGenConfig(this.#getConfig());
    if (!config.enabled) throw new ImageGenError('validation', 'DISABLED', '图像生成未启用');
    requireApiConfig(config);
    const text = String(prompt ?? '').trim();
    if (!text) throw new ImageGenError('validation', 'MISSING_PROMPT', '缺少画面描述');
    if (text.length > config.maxPromptChars) {
      throw new ImageGenError('validation', 'PROMPT_TOO_LONG',
        `描述太长了（最多 ${config.maxPromptChars} 字），说短一点再来`);
    }
    try {
      this.#budget.take(chatKey);
    } catch (error) {
      if (error instanceof Error && error.message === 'RATE_LIMITED') {
        throw new ImageGenError('validation', 'RATE_LIMITED',
          `画图太频繁了（每群每小时最多 ${config.maxCallsPerChatPerHour} 次，全部会话每天 ${config.maxCallsPerDay} 次），稍后再试`);
      }
      throw error;
    }
    const now = Date.now();
    const job: InternalJob = {
      id: randomUUID(),
      chatKey,
      prompt: text,
      referenceUrl: String(imageUrl ?? '').trim(),
      replyToMessageId,
      // 归一化只在这一处：投递侧永远拿到确定值，不需要自己兜 undefined。
      mode: mode === 'assisted' ? 'assisted' : 'standalone',
      status: 'queued',
      createdAt: now,
      updatedAt: now
    };
    this.#jobs.set(job.id, job);
    this.#pending.push(job);
    // 有界保留最近 100 条：任务视图是给"刚派上那几条"看的，无上限会随运行时长涨。
    while (this.#jobs.size > 100) this.#jobs.delete(this.#jobs.keys().next().value as string);
    this.#log(`[image-gen] task=${job.id}`);
    this.#schedule();
    return this.#view(job);
  }

  get(taskId: string): ImageGenJobView | null {
    const job = this.#jobs.get(taskId);
    return job ? this.#view(job) : null;
  }

  /** 对外视图：**不含 `prompt` 与 `referenceUrl`**（用户内容不进读模型/接口）。 */
  #view(job: InternalJob): ImageGenJobView {
    const { id, chatKey, status, failedStage, createdAt, updatedAt, imageBytes, elapsedMs, errorCode } = job;
    return { id, chatKey, status, failedStage, createdAt, updatedAt, imageBytes, elapsedMs, errorCode };
  }

  #setStatus(job: InternalJob, status: ImageGenStatus, extra: Partial<InternalJob> = {}): void {
    Object.assign(job, extra, { status, updatedAt: Date.now() });
    const fields = [`[image-gen] task=${job.id}`];
    // 失败阶段必须进日志：它决定"该往哪儿看"，而群里那句话是给群友看的（不带阶段码时更是如此）。
    if (job.failedStage) fields.push(`stage=${job.failedStage}`);
    if (job.imageBytes != null) fields.push(`bytes=${job.imageBytes}`);
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
        const config = resolveImageGenConfig(this.#getConfig());
        // 临时目录归**队列**所有：`runTask` 返回的是文件，它必须活到投递之后，
        // 所以不能在 `runTask` 自己的 finally 里删（与转写那条链路的关键差别）。
        const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qq-agent-image-gen-')).catch(() => '');
        try {
          if (!workDir) throw new ImageGenError('validation', 'TEMP_DIR_FAILED', '临时目录创建失败');
          const run = this.#operations.runTask
            || ((target, signal, setStatus, current, dir) => this.#runProduction(target, signal, setStatus, current, dir));
          const artifact = await run(
            job, controller.signal, (status, extra) => this.#setStatus(job, status, extra), config, workDir
          );
          // 即使关停与远端响应同时发生，也不得交付迟到结果。
          if (controller.signal.aborted || this.#stopping) {
            throw new ImageGenError('uploading', 'CANCELLED', '画图任务已取消');
          }
          this.#setStatus(job, 'uploading');
          const deliver = this.#operations.deliver
            || ((target, result, current) => this.#deliver(target, result, current));
          await deliver(job, artifact, config);
          this.#setStatus(job, 'done', { elapsedMs: Date.now() - startedAt, imageBytes: artifact.bytes });
        } catch (error) {
          const safe = userError(error);
          // 未分类的内部异常（不是我们自己抛的那种）必须把**原始信息**留到日志里：
          // 此时码只说得出 `Error`，而"到底哪一步、什么原因"只有它知道。
          // 细节先洗过（去 URL 与本机路径）——日志里不许出现这两样。
          if (!(error instanceof ImageGenError)) {
            this.#log(`[image-gen] task=${job.id} detail=${safeErrorDetail(error)}`);
          }
          this.#setStatus(job, 'failed', {
            failedStage: safe.stage, errorCode: safe.code, elapsedMs: Date.now() - startedAt
          });
          // 关停途中不发失败文案：那是我们主动取消的，不是任务真的失败。
          if (!this.#stopping) {
            // 上传阶段**单独一套说法**：图确实已经画好了，说成"画图失败"是撒谎 ——
            // 实测过一次：协议端其实正在传那张图，只是响应回来得慢，于是群里先收到
            // 一句"画图失败"、紧接着又收到那张图（见 onebot.ts 的 SEGMENT_UPLOAD_TIMEOUT_MS）。
            const text = safe.stage === 'uploading'
              ? `图已经画好了，但没能发到群里：${safe.userMessage}`
              : `画图失败（${STAGE_LABELS[safe.stage] || safe.stage}）：${safe.userMessage}`;
            await this.#sender.sendTextBatch(job.chatKey, text, {
              replyToMessageId: job.replyToMessageId
            }).catch((sendError) => {
              this.#log(`[image-gen] task=${job.id} code=${safeErrorCode(sendError)}`);
            });
          }
        } finally {
          if (workDir) await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
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

  /** 默认的生产实现：取参考图（可选）→ 出图 → 下载到本机临时文件。 */
  async #runProduction(
    job: Readonly<InternalJob>, signal: AbortSignal,
    setStatus: (status: ImageGenStatus, extra?: Partial<InternalJob>) => void,
    config: EffectiveConfig, workDir: string
  ): Promise<ImageArtifact> {
    const filePath = path.join(workDir, `${job.id}.png`);
    let imageDataUrl = '';
    if (job.referenceUrl) {
      setStatus('fetching');
      imageDataUrl = await fetchReferenceImage(job.referenceUrl, config.maxRefImageBytes, signal);
    }
    setStatus('generating');
    const imageUrl = await generateImage(config, { prompt: job.prompt, imageDataUrl }, signal);
    setStatus('downloading');
    const bytes = await downloadImageToFile(imageUrl, config.maxDownloadBytes, signal, filePath);
    // `remoteUrl` 只在投递被明确拒绝时用作兜底（见 `#deliver`），不写进对外视图。
    return { filePath, bytes, remoteUrl: imageUrl };
  }

  /**
   * 投递：**先由队列自己把图发进群**，再决定要不要回流。
   *
   * 图片就是交付物，模型没法"说"出一张图 —— 所以上传是确定性的（与 jmcomic 的 PDF 同理）：
   * 走 `sender.sendImage` 意味着它受限频约束、也会在存档里留下 `我：[图片]`。
   * 回流只负责把"已经发过了"这个事实交给模型，让它补一句话。
   */
  async #deliver(job: Readonly<InternalJob>, artifact: ImageArtifact, _config: EffectiveConfig): Promise<void> {
    await this.#send(job, artifact.filePath, artifact);
    if (job.mode !== 'assisted') return;

    const sink = this.#deliverImageResult;
    if (!sink) {
      // 没有回流端口就没人告诉模型 —— 不能无声无息，留一条日志说明结果没落地。
      this.#log(`[image-gen] task=${job.id} code=NO_DELIVER_SINK`);
      return;
    }
    try {
      // `count` 恒为 1：一次任务产出一张图（`n` 固定为 1，见 client.ts）。将来放开多图时，
      // 这个数字要跟着 artifact 走，而不是再写一个字面量。
      await sink({
        chatKey: job.chatKey, prompt: job.prompt, count: 1, replyToMessageId: job.replyToMessageId
      });
    } catch {
      // 只记固定错误码，不记异常正文：日志里不得出现 prompt 或图片地址。
      this.#log(`[image-gen] task=${job.id} code=DELIVER_FAILED`);
    }
  }

  /**
   * 真正把图发出去，失败一律归到 `uploading` 阶段。
   *
   * **本机路径是"协议端认不认"这件事唯一没法在本机验证的地方**（同 stickers 那条），
   * 所以留一步兜底：协议端**明确拒绝**（错误里带 `retcode=`）时，用接口给的结果图链接重发一次。
   * 判据与 stickers 一致 —— **只在明确拒绝时**退回，超时那类错误说不清消息到底发出去没有，
   * 重发就可能是刷屏，不冒这个险。
   */
  async #send(job: Readonly<InternalJob>, file: string, artifact: ImageArtifact): Promise<void> {
    try {
      await this.#sender.sendImage(job.chatKey, file, { replyToMessageId: job.replyToMessageId });
      return;
    } catch (error) {
      const message = safeErrorDetail(error);
      if (!artifact.remoteUrl || file !== artifact.filePath || !/retcode=/.test(message)) {
        throw uploadFailure(error);
      }
      this.#log(`[image-gen] task=${job.id} code=LOCAL_PATH_REFUSED`);
    }
    try {
      await this.#sender.sendImage(job.chatKey, artifact.remoteUrl as string, {
        replyToMessageId: job.replyToMessageId
      });
    } catch (error) {
      throw uploadFailure(error);
    }
  }
}

/**
 * 上传阶段失败 → 一条 `ImageGenError`。
 *
 * 为什么要单独归一次：`SendQueue` 抛的是**裸 Error**，不包的话它会一路穿到 `#drain` 的兜底文案，
 * 群里就会看到"画图失败（画图）：画图失败（Error），稍后再试"——**阶段和原因一起丢了**
 * （真机实测踩到过）。三类来源分开说：
 *   · 限频（"发送频率超限（每分钟最多 80 条），请等一会再发"）与 OneBot 的 `retcode=NNN wording`
 *     —— 本来就是写给人看的，原样透传；
 *   · **超时**（`AbortSignal.timeout` 抛的是 `DOMException.name === 'TimeoutError'`，
 *     见 `qq/onebot.ts` 的 `call`）—— 这是唯一"消息可能已经发出去了"的一种，文案必须留余地，
 *     不能像 retcode 那样断言失败；
 *   · 其余（网络层错误可能带主机名或本机路径）只给可机检的码，细节留给日志。
 */
function uploadFailure(error: unknown): ImageGenError {
  const code = safeErrorCode(error);
  const message = safeErrorDetail(error);
  if (/发送频率超限|retcode=\d+/.test(message)) return new ImageGenError('uploading', code, message);
  if (code === 'TimeoutError' || /timed?\s?out/i.test(message)) {
    return new ImageGenError('uploading', 'SEND_TIMEOUT', '上传超时了（图可能已经在群里，也可能没发出去）');
  }
  return new ImageGenError('uploading', code, `发送图片失败（${code}）`);
}

/** 缺 Key / 地址不可用都要在**建任务之前**拦住，并把下一步说清楚。 */
function requireApiConfig(config: EffectiveConfig): void {
  if (!config.apiKey) {
    throw new ImageGenError('validation', 'CONFIG_MISSING',
      '图像生成未配置：请在设置页填写百炼 API Key（或设置环境变量 DASHSCOPE_API_KEY）');
  }
  try {
    const url = new URL(config.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('protocol');
  } catch {
    throw new ImageGenError('validation', 'INVALID_BASE_URL', '画图接口地址无效，请在设置页检查');
  }
}
