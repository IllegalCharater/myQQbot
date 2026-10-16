import { adminTools } from './admin-tools.js';
import { chatActionTools } from './chat-actions.js';
import { documentTools } from './document.js';
import { historyMediaTools } from './history-media.js';
import { hotSearchTools } from './hot-search.js';
import { imageGenTools } from './image-gen.js';
import { imageSourceTools } from './image-source.js';
import { memoryTools } from './memory-tools.js';
import { transcriptionTools } from './transcription.js';
import { webTools } from './web-tools.js';
import type { ToolDefinition } from '../shared/types.js';

export { detectMime, executeTool, toOpenAiTools } from './shared.js';

/** Canonical tool order is deliberately assembled in one place. */
export function buildToolDefs(extra: readonly ToolDefinition[] = []): ToolDefinition[] {
  const chat = chatActionTools();
  const history = historyMediaTools();
  const memory = memoryTools();
  const web = webTools();
  const admin = adminTools();

  return [
    ...chat,
    ...history,
    ...imageSourceTools(),
    // 读一份**群友发上来的文件**，紧挨着读消息媒体那几个（`reverse_image_source` 读图、
    // 这个读文档，两者都是"从某条消息里取一份内容交给模型"）。
    ...documentTools(),
    ...hotSearchTools(),
    ...transcriptionTools(),
    ...imageGenTools(),
    ...memory,
    admin[0],
    ...web,
    ...admin.slice(1),
    // 扩展（extra）的工具**永远追加在末尾**，且**默认参数是空数组** —— 两条都不是风格问题：
    //   • 内置工具的名字与顺序是硬约束（`tests/t-agent-structure.mjs` 逐字钉着 `buildToolDefs()` 的
    //     无参输出），扩展插进中间会把它打红，而那是**有意的**：内置顺序变了就该有人看一眼；
    //   • 默认空数组让 13 处既有无参调用逐字不变。扩展的 schema 由 `web/app.ts` 递进来
    //     （`extra` 层级比 `agent` 高，这里**不许**反向 import 它，连类型都不需要 —— 参数类型
    //     `ToolDefinition` 本来就是本层自己的）。
  ...extra
  ];
}
