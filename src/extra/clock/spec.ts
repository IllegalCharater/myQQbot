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
  // 斜杠命令的**词形列表**（纯数据，静态可得）—— 启用之后群友就敲得到，**不必先装载**：
  // 敲它才会把这个扩展拉起来（"装载的入口是人"那条取舍）。
  // 第一个是主命令词（也是 `commandHandlers` 的键），`/time` 是它的另一个叫法：
  // 分发层命中它之后会把开头那个词**换成 `/时间`** 再交给实现，所以 `impl.ts` 里只认一个词。
  commands: [
    {
      names: ['/时间', '/time']
    }
  ]
};
