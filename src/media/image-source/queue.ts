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
