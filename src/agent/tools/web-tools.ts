import { selectTools } from './shared.js';
import type { ToolDefinition } from '../shared/types.js';

const NAMES = ['web_search', 'web_fetch'] as const;

export function webTools(all: ToolDefinition[]): ToolDefinition[] {
  return selectTools(all, NAMES);
}
