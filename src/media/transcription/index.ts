// 视频 URL 转写：单并发队列 → SSRF 安全流式代理 → FFmpeg → 腾讯云录音文件识别极速版。
//
// 用户 URL 从不交给 shell，也不直接交给 FFmpeg。FFmpeg 只访问本机临时代理；代理对原始
// URL 与每次重定向逐跳校验、固定已校验 DNS 结果并流式转发，因此既不落完整视频，也不会
// 因 FFmpeg 自己跟随重定向而绕过 SSRF 防护。
//
// ── 文件划分（改动理由各不同，所以别合回去）──
//   · `types.ts`      共享类型（**不 import 本模块任何文件**，否则成环）
//   · `errors.ts`     错误类型 + "任意异常 → 可机检 code / 用户看得懂的那句话"
//   · `primitives.ts` 环境变量与整数钳制
//   · `config.ts`     配置解析与钳制
//   · `commands.ts`   `/转写` 解析 + 目标媒体定位（**只读、无副作用**）
//   · `media-proxy.ts` SSRF 安全的本机流式代理（FFmpeg 唯一看得到的地址）
//   · `extract.ts`    音轨提取（平台无关：解析交给 `media-source`）+ FFmpeg 探测
//   · `recognize.ts`  腾讯云极速版（签名 / 上传 / 响应解析）
//   · `queue.ts`      单并发状态机与两条投递路径
export * from './types.js';
export * from './errors.js';
export * from './config.js';
export * from './commands.js';
export * from './extract.js';
export * from './recognize.js';
export * from './queue.js';
