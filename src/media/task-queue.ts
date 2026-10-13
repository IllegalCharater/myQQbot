// **异步任务队列的机械部分**：单并发、有界注册表、状态与日志、关停语义。
//
// 三个能力（转写 / 漫画 / 出图）本来各写了一遍这些东西 —— 转写的 `queue.ts` 与出图的
// `queue.ts` 方法集几乎逐一对应（`#jobs`/`#pending`/`#drainPromise`/`#currentAbort`/
// `#schedule`/`#drain`/`start`/`stop`/`enqueue`/`get`/`#view`/`#setStatus`），
// 而漫画是同一套循环的另一种排程（按 `nextAttemptAt` 时间门控 + 任务持久化）。
// 这里收的是**只有一份写法才对**的那部分；**每个能力的阶段机、投递与回话话术都留在各自文件里**。
//
// ── 三条不变量（搬动时别丢）──
//
// 1. **恒为单并发**。下游是"挂着等几十秒的同步接口 / 单个串行处理 stdin 的 Python worker"，
//    放开并发只会让每一段都变慢，而"总任务超时"是从发出时刻起算的 —— 排队时间会吃掉真正
//    干活的预算。要提高吞吐应该限制入队速率或起多个 worker，而不是把 `#drain` 改成 N 个。
// 2. **关停要停得干净**：把还没开跑的交还宿主（宿主自己决定是标记终止还是留着下次恢复）、
//    abort 在途的那一次、并**等它真的收尾**（`whenIdle()`）。转写/出图把没跑完的判成
//    `SHUTDOWN` 失败；漫画**保留**它们（jobs.json 就是为重启恢复存在的）—— 所以"怎么处置"
//    是宿主的决定，核心只负责"交出来"。
// 3. **队列不自己持有计时器**。`setTimeout` 与句柄留在各能力手里（`LONG_TERM_TASKS.owner`
//    的语义是"实际持有这些计时器的模块"，`tests/t-tasks.mjs` 按它反查"文件里有没有调度调用"）。
//    核心只回答"现在有没有活、下一次该等多久"（`hasPending()` / `idleDelay()`）。
//
// ── 与"被禁的注册表"的区别 ──
//
// 这里是**静态装配**：钩子是构造时给的一组函数引用，运行期只有 `for...of` 与直接调用，
// 没有任何 `REGISTRY[动态键]` 形态（同 `web/runtime/lifecycle.ts` 的装配清单）。
import type { AppConfig } from '../core/config.js';

/** 队列任务的最小形状。各能力的 `InternalJob` / `JmJob` 都满足它。 */
export interface QueueJob {
  id: string;
  chatKey: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  /** 跑完时由核心（或宿主的 `onSuccess`）写上：这一趟花了多久。 */
  elapsedMs?: number;
}

export type SetTaskStatus<J extends QueueJob> = (status: string, extra?: Partial<J>) => void;

export interface TaskQueueOptions<J extends QueueJob, C> {
  getConfig(): AppConfig;
  log?(...args: unknown[]): void;
  /** 每个任务开始时现读一次生效配置（各能力自己的 resolve + 钳制）。 */
  resolveConfig(config: AppConfig): C;
  /**
   * 干完**整件事**：干活 → 投递 → 回流。核心不插手阶段机 ——
   * 转写要多一步 FFmpeg、出图要临时目录与上传兜底、漫画有三阶段与重试，
   * 把它们塞进统一的 run/deliver 形状只会把差异挤进更多钩子里。
   * `signal` 中止时应当尽快抛（关停路径）。
   */
  execute(job: J, signal: AbortSignal, setStatus: SetTaskStatus<J>, config: C): Promise<void>;
  /**
   * 失败收尾：置终局状态、决定要不要回流/贴文案。核心只负责判"这个任务失败了"并给出耗时。
   *
   * ⚠️ **核心关停时也照样调它** —— "关停途中不汇报"是**宿主**的事（它才知道自己是不是在关停），
   * 而且两件事必须分开：**状态总要记下来**（那个任务确实没跑成），只有"要不要发一句话/回流"
   * 才看 `stopping`。把它们合成一个 `if` 的后果是任务永远停在 `queued`（实测踩到）。
   */
  onError(job: J, error: unknown, elapsedMs: number): Promise<void> | void;
  /**
   * `execute` 正常返回之后。**缺省 = 置 `done` + 记 `elapsedMs`**。
   *
   * 漫画**必须**自己给：它的 `execute` 只是**一个阶段**，正常返回可能意味着"回去排队
   * 等下一次重试"（`status: 'queued'` + `nextAttemptAt`），绝不能被记成完成。
   */
  onSuccess?(job: J, elapsedMs: number): void;
  /**
   * 任务被改动之后（新增 / 状态变更 / 跑完 / 失败）——宿主在这里**打日志、落盘、记账**。
   * 核心刻意不自己拼日志：每个能力的字段不同（`bytes` / `stage` / `code`…），
   * 也知道哪些字段不该进日志（URL、画面描述）。
   */
  onChange?(job: J): void;
  /**
   * 下一个该跑的；返回 `undefined` = 现在没得跑（可能还有在等的）。
   * 缺省 = 第一个 `status === 'queued'` 的；漫画用它做 `nextAttemptAt` 门控
   * （**并且在那里表达"已停就不再取活"**，见该处注释）。
   */
  next?(jobs: readonly J[]): J | undefined;
  /**
   * 若现在没得跑，多久之后再来一次（毫秒）；`null` = 不用来。
   * 缺省 = 还有 `queued` 就 0、否则 null；漫画用它排"最早的那个重试时刻"。
   */
  nextDelay?(jobs: readonly J[]): number | null;
  /** 对外视图（各能力去掉自己的敏感字段，如 URL / prompt）。 */
  projectView(job: J): Record<string, unknown>;
  /** 注册表上限（**只对已结束的任务生效**，跑着的永远不会被挤掉）。缺省不限。 */
  limit?: number;
}

export class TaskQueue<J extends QueueJob, C = unknown> {
  readonly #opts: TaskQueueOptions<J, C>;
  #jobs = new Map<string, J>();
  #running: Promise<void> | null = null;
  #currentAbort: AbortController | null = null;
  /**
   * 正在执行的那一个的 id。
   *
   * 它**不算"排队中"** —— 这条语义是从旧实现照搬的（那里 `#pending.shift()` 一取就把任务
   * 移出了待跑列表），少了它，`takePending()` 会把**正在跑的那个也交出去**，
   * 关停时它就被判成 `SHUTDOWN`，而不是等它收尾后按"取消"处理。
   */
  #activeId: string | null = null;

  constructor(opts: TaskQueueOptions<J, C>) {
    this.#opts = opts;
  }

  /** 登记一个新任务（由宿主的 `enqueue` 在**全部零成本校验通过之后**调用）。 */
  add(job: J): void {
    this.#jobs.set(job.id, job);
    this.#evict();
    this.#opts.onChange?.(job);
  }

  get(id: string): J | undefined {
    return this.#jobs.get(id);
  }

  /** 全部任务（插入顺序）。漫画用它做去重与持久化 —— 那份数组就是事实源。 */
  all(): J[] {
    return [...this.#jobs.values()];
  }

  /**
   * 整体清空登记表（**只清记录，不动磁盘**）。漫画的定时缓存清理用它 ——
   * 它会连下载目录与任务日志一起删，留着记录只会指向已经不存在的东西。
   *
   * 调用方自己保证"现在没有在跑的任务"（漫画那里由 `draining` / `hasPending()` 把关）。
   */
  clear(): void {
    this.#jobs.clear();
    this.#activeId = null;
  }

  view(job: J): Record<string, unknown> {
    return this.#opts.projectView(job);
  }

  /** 改状态 + 通知宿主（**三个能力的状态迁移都只经这里**，所以"改了没通知"不可能发生）。 */
  setStatus(job: J, status: string, extra: Partial<J> = {}): void {
    Object.assign(job, extra, { status, updatedAt: Date.now() });
    this.#opts.onChange?.(job);
  }

  /** 还有没有"排队中、尚未开跑"的任务（**不含正在跑的那一个**）。 */
  hasPending(): boolean {
    return this.#waiting().length > 0;
  }

  /** 取走所有还没开跑的任务（关停路径）。**怎么处置由宿主决定**（标记终止 / 留待恢复）。 */
  takePending(): J[] {
    return this.#waiting();
  }

  #waiting(): J[] {
    return [...this.#jobs.values()].filter((job) => job.status === 'queued' && job.id !== this.#activeId);
  }

  abortInFlight(): void {
    this.#currentAbort?.abort();
  }

  get draining(): boolean {
    return this.#running !== null;
  }

  /**
   * 排空：串行跑完所有可跑的。**重入安全** —— 已经在跑时返回同一个 promise。
   *
   * `isStopping()` 每次取活前调用：为真就立刻停手（关停时不该再开新的任务）。
   */
  drain(isStopping: () => boolean = () => false): Promise<void> {
    if (this.#running) return this.#running;
    this.#running = (async () => {
      while (!isStopping()) {
        const job = this.#pick();
        if (!job) break;
        await this.#step(job, isStopping);
      }
    })().finally(() => { this.#running = null; });
    return this.#running;
  }

  /** 在跑的那一次收尾后就 resolve（没有在跑时立即 resolve）。关停路径用它等干净。 */
  whenIdle(): Promise<void> {
    return this.#running ?? Promise.resolve();
  }

  /** 队列里还有待办时，宿主该在多久之后再来一次；`null` = 不用来。 */
  idleDelay(): number | null {
    const jobs = this.all();
    if (this.#activeId) return null;   // 正跑着：跑完由宿主的 finally 再排，不必另排
    if (this.#opts.nextDelay) return this.#opts.nextDelay(jobs);
    return jobs.some((job) => job.status === 'queued') ? 0 : null;
  }

  #pick(): J | undefined {
    // 把"正在跑的那一个"从候选里摘掉：否则 `next` 可能把它再挑一次（旧实现靠 `shift()`
    // 天然避免，这里必须显式）。
    const jobs = this.all().filter((job) => job.id !== this.#activeId);
    return this.#opts.next ? this.#opts.next(jobs) : jobs.find((job) => job.status === 'queued');
  }

  async #step(job: J, isStopping: () => boolean): Promise<void> {
    const startedAt = Date.now();
    const controller = new AbortController();
    this.#currentAbort = controller;
    this.#activeId = job.id;
    const config = this.#opts.resolveConfig(this.#opts.getConfig());
    try {
      await this.#opts.execute(job, controller.signal, (status, extra) => this.setStatus(job, status, extra), config);
      // 关停与远端响应可能同时发生：**不能**把迟到结果当成功。
      if (controller.signal.aborted || isStopping()) throw new Error('CANCELLED');
      const elapsedMs = Date.now() - startedAt;
      if (this.#opts.onSuccess) this.#opts.onSuccess(job, elapsedMs);
      else this.setStatus(job, 'done', { elapsedMs } as Partial<J>);
    } catch (error) {
      // 一律交给宿主：**状态总要记**（这个任务确实没跑成），而"要不要发一句话/回流"
      // 由宿主看自己的 stopping 决定。
      await this.#opts.onError(job, error, Date.now() - startedAt);
    } finally {
      this.#currentAbort = null;
      this.#activeId = null;
    }
  }

  /** 只有**已结束**的任务会被挤掉：跑着/排队的被挤掉等于静默丢活。 */
  #evict(): void {
    const limit = Number(this.#opts.limit);
    if (!Number.isFinite(limit) || limit <= 0) return;
    while (this.#jobs.size > limit) {
      const oldest = [...this.#jobs.values()].find((job) => job.status !== 'queued');
      if (!oldest) return;
      this.#jobs.delete(oldest.id);
    }
  }
}
