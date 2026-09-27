import { selectTools } from './shared.js';
import type { ToolDefinition } from '../shared/types.js';

const NAMES = ['get_recent_messages', 'read_forward', 'read_group_notice', 'get_active_members', 'get_message_detail', 'get_message_images'] as const;

export function historyMediaTools(all: ToolDefinition[]): ToolDefinition[] {
  return selectTools(all, NAMES);
}
