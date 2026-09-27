import { selectTools } from './shared.js';
import type { ToolDefinition } from '../shared/types.js';

const NAMES = ['send_message', 'send_sticker', 'list_stickers', 'get_sticker_image', 'sticker_note', 'collect_sticker', 'send_poke'] as const;

export function chatActionTools(all: ToolDefinition[]): ToolDefinition[] {
  return selectTools(all, NAMES);
}
