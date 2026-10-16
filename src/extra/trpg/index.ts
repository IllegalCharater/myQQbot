// 跑团扩展的**桶文件**：只给 `web/` 路由与套件用。
//
// 扩展自己内部一律 import 具体文件（`./model/campaign.js` 这种），**不 import 桶** ——
// 桶只是"外部消费者不必知道内部怎么分"的那一层。判据与 `media/web-search/` 那条相同。
//
// ⚠️ 这里**逐个文件列**，不写目录形式的 `export *`（写成 `'./model'` 那种）：目录形式会在加
// 文件时静默扩大公开面，而"哪些东西是对外的"应当是有人明确写下来的一行。
// （注释里也别写出完整的 import 语句形态 —— `check-layers.mjs` 的正则会扫到它。）
//
// ⚠️ **`rules/` 不在这个桶里**：它是纯函数层，套件直接 import `extra/trpg/rules/*.js`
// 取内部的解析与求值（那是它存在的意义 —— 能脱离平台独立测试）。
// 只有 `resolveCheck` 这类被上层用到的入口才从桶里出去。

// ── 领域类型与声明 ──
export * from './types.js';
export * from './spec.js';

// ── 组装入口 ──
export { createRuntime } from './impl.js';

// ── 判据与状态机（纯）──
export * from './model/limits.js';
export * from './model/paths.js';
export * from './model/character.js';
export * from './model/campaign.js';
export * from './model/mode.js';
export * from './model/session.js';

// ── 落盘 ──
export * from './store/campaign-store.js';
export * from './store/mode-store.js';
export * from './store/rule-store.js';
export * from './store/scenario-store.js';
export * from './store/journal-store.js';

// ── 剧本格式 ──
export * from './scenario/parse.js';
export * from './scenario/save.js';
export * from './scenario/format.js';

// ── 展示 ──
export * from './render/model.js';
export * from './render/players.js';
export * from './render/status.js';
export * from './render/format.js';

// ── 命令与工具 ──
export * from './commands/shared.js';
export * from './commands/scenario.js';
export * from './tools/index.js';

// ── 兜底建议（一次独立模型调用）──
export * from './suggest.js';
