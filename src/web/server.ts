// headless 入口：npm run server（= node dist/web/server.js，不带 Electron 窗口，浏览器访问控制台）
import { createApp } from './app.js';
import { createShutdown } from './runtime/shutdown.js';

// 跑的是 tsc 产物 dist/，行号和 src/ 对不上——开了源地图，堆栈里的行号才指回原始源码。
// 放在 import 之后：ESM 的 import 会被提升，写在前面也拦不住 app.js 先加载。
process.setSourceMapsEnabled?.(true);

process.on('unhandledRejection', (error) => console.error('[未处理异常]', error));
process.on('uncaughtException', (error) => console.error('[未捕获异常]', error));

const app = createApp();
app.start().catch((error) => {
  console.error('[启动失败]', error);
  process.exit(1);
});

// 关停编排在 `shutdown.ts`（纯逻辑，可单测；守护是 tests/t-lifecycle.mjs 第 1 段），
// 这里只负责把它接到 process 上。
//
// 两个信号各写一行、且都只走 `shutdown`，是有意的：这样"再加一个信号却自己 exit 掉"、
// 或"某个信号绕开幂等关停"都会被打红（套件逐行扫 `process.on('SIG…')`，要求同一行里出现
// `shutdown`）。SIGTERM 是 systemd / 容器 / taskkill 发的那个信号，缺了它只能靠 SIGINT。
const shutdown = createShutdown({
  stop: () => app.stop(),
  exit: (code) => process.exit(code),
  log: (...args) => console.log(...args),
  onError: (error) => console.error('[退出] 关停出错:', error)
});
process.on('SIGINT', () => { void shutdown('SIGINT'); });
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
