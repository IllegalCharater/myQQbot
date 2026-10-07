// 读环境变量与整数钳制：配置解析与命令解析都要用的小助手。
//
// 单开一个文件是因为它们被**两处互不相关**的地方用（`config.ts` 的配置钳制、
// `effects` 那侧的上限），挂在哪一边都会让另一边反向引用。

export function envString(name: string): string {
  return String(process.env[name] || '').trim();
}

/** 读一个整数配置：非法值回落 `fallback`，否则钳进 `[min, max]`。 */
export function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback;
}
