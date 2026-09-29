/**
 * 串行队列：**并发恒为 1**，超出的排成一列，列满则以 `QUEUE_FULL` 拒绝。
 *
 * ⚠️ 并发这里写死 1，是**故意的，不是还没调**。下游是单个 Python worker 子进程，它按
 * JSON Lines 串行处理 stdin；就算这里放并发，worker 侧也只会排队，唯一效果是让 Node 侧多
 * 攒几个在途请求、让"总任务超时"从发出时刻起算（于是排队时间吃掉远端预算）。真要提高总吞吐，
 * 正确做法是起多个 worker 进程并让队列按进程分派，而不是把这里改成 N。
 *
 * 顺带满足"单进程 worker 下并发别超过 3-5"这条要求：**1 ≤ 3**，且它不需要任何配置项去约束。
 *
 * 今天唯一的调用方是 `reverse-image-source-service.ts` 的 `#queue`，`maxWaiting` 由
 * `imageSource.maxQueueLength` 传入 —— 那是"等待列队长度"上限，与并发数无关。
 */
export class AsyncSingleQueue {
  #running = false;
  #pending: Array<() => void> = [];

  get waiting(): number { return this.#pending.length; }

  enqueue<T>(maxWaiting: number, task: () => Promise<T>): Promise<T> {
    if (this.#running && this.#pending.length >= maxWaiting) return Promise.reject(new Error('QUEUE_FULL'));
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        this.#running = true;
        void task().then(resolve, reject).finally(() => {
          const next = this.#pending.shift();
          if (next) next(); else this.#running = false;
        });
      };
      if (this.#running) this.#pending.push(run); else run();
    });
  }
}
