// 参考扩展 `clock` 的**声明**（纯数据）。
//
// ⚠️ 本文件是 `registry.ts` **静态 import** 的那一份，所以它里面**一个字的重东西都不许有**：
// 没有子进程、没有大表、没有 `impl.js` 的 import。它是"工具表恒定"这条性质的承重墙 ——
// 一旦这里 import 了实现，"按需加载"当场作废（`tests/t-extras.mjs` 有一条源级断言钉它）。
//
// 这个扩展的职责是**把整条链跑起来并可观察**（首次调用才加载 → 空闲 dispose → 再调重载），
// 而不是提供什么了不起的能力。它刻意不引入任何外部依赖或数据文件。
import { EXTRA_PROMPT_TEXT } from '../prompts.js';
import type { ExtraSpec } from '../types.js';

export const clockSpec: ExtraSpec = {
  id: 'clock',
  title: '当前时间',
  // 写给**管理员**看的一句话（设置页那一条旁边的小字）。与下面 `tools[]` 里的 description
  // 不是一回事：那个是写给**模型**看的、只许取自 `EXTRA_PROMPT_TEXT`。见 types.ts 的说明。
  displayDesc: EXTRA_PROMPT_TEXT.get_current_time.displayDesc,
  defaultEnabled: true,
  tools: [
    {
      name: 'get_current_time',
      // 文案**只许引用** Catalog 里那张**扩展专用**的表（`EXTRA_PROMPT_TEXT`）：
      // 模型可见的固定指令的唯一落点仍然是 `core/prompt-catalog.ts`，而扩展那一块与内置工具
      // 分开管理（权威来源不同）。**不要在这里写文案、也不要抄一份** ——
      // `tests/t-extras.mjs` 有一条断言逐个比对本表与注册表里的 description。
      description: EXTRA_PROMPT_TEXT.get_current_time.description,
      parameters: {
        type: 'object',
        properties: {
          timeZone: { type: 'string', description: EXTRA_PROMPT_TEXT.get_current_time.timeZone }
        },
        required: []
      }
    }
  ],
  // 斜杠命令的**词形列表**（纯数据，静态可得）—— 启用之后群友就敲得到，**不必先装载**
  // （判据是静态的：`isCommandEntry` 同步、跑在入站热路径上）。但敲它**不会**把扩展拉起来：
  // 未加载时如实回一句"先 /能力 加载 clock"（2026-10-19 起，装载的唯一入口是人）。
  // 第一个是主命令词（也是 `commandHandlers` 的键），`/time` 是它的另一个叫法：
  // 分发层命中它之后会把开头那个词**换成 `/时间`** 再交给实现，所以 `impl.ts` 里只认一个词。
  commands: [
    {
      names: ['/时间', '/time'],
      // **群里要先 @ 机器人**（缺省值就是它，这里写出来是因为 `spec.ts` 是别人照抄的样板）：
      // `/时间` 是个通用小工具，谁都能随手敲一句 —— 那正是群里最吵的一类消息。
      // 对照见 `trpg/spec.ts`：跑团那族是 `false`（那个群此刻就在跑团，掷骰还要先 @ 没法玩）。
      requiresMention: true
    }
  ]
};
