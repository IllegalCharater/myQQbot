// 进程退出路径上的关停编排（S11a）。
//
// 为什么单独一个模块：`server.ts` 是**带副作用的入口**（import 即建 app、起服务、装信号
// 处理器），套件没法 import 它来验行为；而"连按两次 Ctrl-C 会不会关停两次"这种事恰恰只有
// 真跑一遍才看得见。所以把纯逻辑挪到这里（先例是 S1 抽 `web/event-projector.ts`），
// `server.ts` 只留"把 process 接上"的那几行。守护在 `tests/t-lifecycle.mjs` 第 1 段。
//
// 语义三条（都有断言）：
//   1. **只关停一次。** `shuttingDown` 在 `await` **之前**置位，所以关停还没跑完时再来的
//      信号也不会重入——重复关停会把长期任务停两遍、把 `server.close()` 调两次。
//   2. **重复信号是催命符。** 第二个及以后的信号立即 `exit(1)`。没有这一条的话，`stop()`
//      一旦挂住（在途上传、SSE 长连接、某个模块级单例都可能）除了杀进程没有别的出路，
//      而无头入口正是"反复按 Ctrl-C"的场景。
//   3. **`stop()` 抛错也要退。** 老写法 `await app.stop()` 抛错会落到 `server.ts` 的
//      `unhandledRejection` 上，那里只 `console.error`、**不退出** —— 进程就此挂住。
//      这里 catch 下来交给 `onError` 报告，然后照常退出。
//
// 覆盖不到的（真机冒烟项，别假装这里管了）：信号真的送达时进程是否干净退出、
// SSE 长连接会不会拖住 `server.close()`（后者不 await、也不跟踪在途连接）。
// Windows 下 `process.on('SIGTERM')` 事实上收不到信号（没有真正的信号机制），
// 所以那条分支只能靠文本断言 + 真机确认。

export interface ShutdownDeps {
  /** 完整关停。抛错会被 `onError` 收下，然后照常退出。 */
  stop(): Promise<void> | void;
  exit(code: number): void;
  log(...args: unknown[]): void;
  onError?(error: unknown): void;
}

/**
 * 造一个信号处理器。返回的函数**可以安全地重复调用**：
 * 第一次走完整关停（`stop()` → `exit(0)`），之后每次立即 `exit(1)`。
 */
export function createShutdown(deps: ShutdownDeps): (signal: string) => Promise<void> {
  let shuttingDown = false;
  return async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) {
      deps.log(`再次收到 ${signal}，强制退出`);
      deps.exit(1);
      return;
    }
    shuttingDown = true;
    deps.log(`收到 ${signal}，退出中…`);
    try {
      await deps.stop();
    } catch (error) {
      deps.onError?.(error);
    }
    deps.exit(0);
  };
}
