import { adminTools } from './admin-tools.js';
import { chatActionTools } from './chat-actions.js';
import { historyMediaTools } from './history-media.js';
import { hotSearchTools } from './hot-search.js';
import { imageSourceTools } from './image-source.js';
import { memoryTools } from './memory-tools.js';
import { transcriptionTools } from './transcription.js';
import { webTools } from './web-tools.js';
import type { ToolDefinition } from '../shared/types.js';

export { detectMime, executeTool, toOpenAiTools } from './shared.js';

/** Canonical tool order is deliberately assembled in one place. */
export function buildToolDefs(): ToolDefinition[] {
  const chat = chatActionTools();
  const history = historyMediaTools();
  const memory = memoryTools();
  const web = webTools();
  const admin = adminTools();

  return [
    ...chat,
    ...history,
    ...imageSourceTools(),
    ...hotSearchTools(),
    ...transcriptionTools(),
    ...memory,
    admin[0],
    ...web,
    ...admin.slice(1)
  ];
}
