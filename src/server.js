// headless 入口：npm run server（= node dist/server.js，不带 Electron 窗口，浏览器访问控制台）
import { createApp } from './app.js';

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

process.on('SIGINT', async () => {
  console.log('退出中…');
  await app.stop();
  process.exit(0);
});
