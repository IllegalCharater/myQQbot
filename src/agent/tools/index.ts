import { adminTools } from './admin-tools.js';
import { chatActionTools } from './chat-actions.js';
import { historyMediaTools } from './history-media.js';
import { imageSourceTools } from './image-source.js';
import { memoryTools } from './memory-tools.js';
import { buildAllToolDefs } from './shared.js';
import { webTools } from './web-tools.js';
import type { ToolDefinition } from '../shared/types.js';

export { detectMime, executeTool, toOpenAiTools } from './shared.js';

/** Canonical tool order is deliberately assembled in one place. */
export function buildToolDefs(): ToolDefinition[] {
  const all = buildAllToolDefs();
  const chat = chatActionTools(all);
  const history = historyMediaTools(all);
  const memory = memoryTools(all);
  const web = webTools(all);
  const admin = adminTools(all);

  return [
    ...chat,
    ...history,
    ...imageSourceTools(),
    ...memory,
    admin[0],
    ...web,
    ...admin.slice(1)
  ];
}
