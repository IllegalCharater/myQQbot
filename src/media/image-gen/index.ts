// 图像生成：入队 → 单并发出图（百炼 · 千问 Qwen-Image 同步接口）→ 下载结果 → 发进群 → 回流入窗。
//
// ── 文件划分（改动理由各不同，所以别合回去）──
//   · `types.ts`     共享类型（**不 import 本模块任何文件**，否则成环）
//   · `errors.ts`    错误类型 + "任意异常 → 可机检 code / 用户看得懂的那句话"
//   · `config.ts`    配置解析、钳制与两处归一化（接口地址、尺寸分隔符）
//   · `commands.ts`  `/画` 解析 + 参考图定位（**只读、无副作用**）
//   · `image-io.ts`  两条取图路径：进来的参考图、出去的结果图（SSRF 校验 + 大小上限）
//   · `client.ts`    百炼同步接口（请求体拼装是纯函数，**两层提示词就在这里合并**）
//   · `queue.ts`     单并发状态机、成本闸门与两条投递路径
export * from './types.js';
export * from './errors.js';
export * from './config.js';
export * from './commands.js';
export * from './image-io.js';
export * from './client.js';
export * from './queue.js';
