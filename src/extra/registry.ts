// 扩展的**静态注册表**。
//
// 形态与 `web/runtime/lifecycle.ts` 的装配清单同一类：存的是**函数引用**、运行期只按数组顺序
// `for...of`，没有任何按键分发（`EXTRA_REGISTRY[动态键]` / `.find(` / `.get(` 一个都没有）。
// `id` 只是给配置、日志与设置页用的标签，不参与分发。
//
// ── 加一个扩展 = 建一个目录 + 加一行 ──
//
//   src/extra/<x>/spec.ts   纯数据（工具声明 + id/title/description/defaultEnabled），**重东西一个字都不许有**
//   src/extra/<x>/impl.ts   `export function createRuntime(): ExtraRuntime`，重东西全在这里
//
// 然后在本文件加一行：展开那个 spec，`load` 写成一个返回动态 import 的函数引用
// —— 写法就照下面 clock 那一行（说明符指到该目录下的 impl.js）。
//
// ⚠️ **`load` 里的说明符必须是字面量**。这不是风格问题：写成变量会让 tsc 看不见它、
// `check-layers.mjs` 扫不到它、`scripts/build-desktop.mjs` 的 src⇄dist 对账也覆盖不到它 ——
// 症状是"某个扩展没被搬进包"，而"某个模块没被搬进包"正是打包脚本存在的唯一理由。
// 本文件也因此**只静态 import 各扩展的 `spec.ts`**，`impl.ts` 永远走动态 import。
//
// ⚠️ 另一条不变量：**改本文件（增删扩展）要重启才生效**。工具表是请求前缀的一部分，
// 运行期增删会打散提示词缓存；设置页那个开关（`extras.enabled`）同理。
import { clockSpec } from './clock/spec.js';
import { trpgSpec } from './trpg/spec.js';
import type { ExtraEntry } from './types.js';

export const EXTRA_REGISTRY: readonly ExtraEntry[] = [
  {
    ...clockSpec,
    load: () => import('./clock/impl.js').then((m) => m.createRuntime())
  },
  {
    // **顺序是语义**：`/能力` 的列表、以及套件里"命令表第 0 条是谁"都按注册表顺序。
    // 新扩展加在末尾（clock 是参考实现，一直在最前）。
    ...trpgSpec,
    load: () => import('./trpg/impl.js').then((m) => m.createRuntime())
  }
];

