import { selectTools } from './shared.js';
import type { ToolDefinition } from '../shared/types.js';

const NAMES = ['report_feedback', 'download_jmcomic', 'finish'] as const;

export function adminTools(all: ToolDefinition[]): ToolDefinition[] {
  return selectTools(all, NAMES);
}
