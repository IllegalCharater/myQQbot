// 模块级可变状态：绑定在活着的 app 上的运行时，以及"任务表是否已经从磁盘装载过"。
//
// 单独一个文件是为了**打破环**：三个阶段要用 `runtime`，而注册表的钩子要用三个阶段；
// 把这份可变状态放在任何一边都会成环。它只有两个字段，谁都能安全地 import。
//
// 读写走存取器而不是导出可变绑定：ESM 的 import 是只读的，跨模块改不了。

import type { JmRuntime } from './types.js';

const state: { runtime: JmRuntime | null; loaded: boolean } = { runtime: null, loaded: false };

/** 绑定/解绑运行时（`initJmcomicQueue` / `stopJmcomicQueue` 各调一次）。 */
export function setRuntime(next: JmRuntime | null): void { state.runtime = next; }

/**
 * 当前运行时；`null` = 队列没挂在活着的 app 上。
 *
 * 它同时是"**停之后就不要再取活**"的那道闸门（见 `queue.ts` 的 `next` 钩子）与
 * 各处 `runtime?.` 可选链的来源。
 */
export function getRuntime(): JmRuntime | null { return state.runtime; }

/** 任务表是否已经从 `jobs.json` 读过（没读过之前不许落盘，否则会用空表覆盖真文件）。 */
export function isLoaded(): boolean { return state.loaded; }
export function markLoaded(): void { state.loaded = true; }
