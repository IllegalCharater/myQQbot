import { isRecord } from './json-parse.js';

export interface InlineToolCall {
  name: string;
  args: Record<string, unknown>;
}

export function parseInlineToolCalls(text: unknown): InlineToolCall[] {
  const calls: InlineToolCall[] = [];
  const blockPattern = /<tool_call\b[^>]*>([\s\S]*?)<\/tool_call>/gi;
  let match: RegExpExecArray | null;
  while ((match = blockPattern.exec(String(text || ''))) !== null) {
    const block = match[1].trim();
    if (!block) continue;
    const call = parseInlineBlock(block);
    if (call) calls.push(call);
  }
  return calls;
}

function parseInlineBlock(block: string): InlineToolCall | null {
  const jsonMatch = block.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed: unknown = JSON.parse(jsonMatch[0]);
      const object = isRecord(parsed) ? parsed : {};
      const name = object.name || object.function || object.tool;
      const args = object.arguments || object.parameters || object.args || object.input || {};
      if (name) return { name: String(name), args: isRecord(args) ? args : {} };
    } catch { /* continue with XML form */ }
  }

  const functionMatch = block.match(/<function\s*=\s*([^>]+)>/i);
  let name = functionMatch ? functionMatch[1].trim().replace(/^["']|["']$/g, '') : '';
  const args: Record<string, unknown> = {};
  const parameterPattern = /<parameter\s*=\s*([^>]+)>([\s\S]*?)<\/parameter>/gi;
  let parameterMatch: RegExpExecArray | null;
  while ((parameterMatch = parameterPattern.exec(block)) !== null) {
    const key = parameterMatch[1].trim().replace(/^["']|["']$/g, '');
    let value: unknown = parameterMatch[2].trim();
    try { value = JSON.parse(String(value)); } catch { /* retain text */ }
    args[key] = value;
  }
  if (name && functionMatch) return { name, args };

  const lines = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!name && lines.length >= 2 && /^[a-zA-Z_][\w.-]*$/.test(lines[0])) {
    name = lines[0];
    try {
      const parsed: unknown = JSON.parse(lines.slice(1).join('\n'));
      if (isRecord(parsed)) return { name, args: parsed };
    } catch { /* ignore */ }
  }
  return null;
}
