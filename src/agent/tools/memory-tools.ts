import { selectTools } from './shared.js';
import type { ToolDefinition } from '../shared/types.js';

const NAMES = ['memory_append', 'memory_query', 'memory_remove'] as const;

export function memoryTools(all: ToolDefinition[]): ToolDefinition[] {
  return selectTools(all, NAMES);
}
