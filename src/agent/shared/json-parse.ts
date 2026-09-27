export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function safeParse(text: unknown): unknown {
  try {
    return typeof text === 'string' ? JSON.parse(text) : text;
  } catch {
    return { raw: String(text).slice(0, 500) };
  }
}

export function extractJsonObject(raw: unknown): Record<string, unknown> | null {
  const text = String(raw ?? '').trim();
  if (!text) return null;

  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch { /* continue */ }

  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates: string[] = [];
  if (fence) candidates.push(fence[1].trim());

  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));

  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (isRecord(parsed)) return parsed;
    } catch { /* continue */ }

    try {
      const fixed = candidate
        .replace(/,\s*([}\]])/g, '$1')
        .replace(/'/g, '"');
      const parsed: unknown = JSON.parse(fixed);
      if (isRecord(parsed)) return parsed;
    } catch { /* continue */ }

    const arrayMatch = candidate.match(/"impressions"\s*:\s*\[([\s\S]*?)\]\s*[,}]?/);
    if (arrayMatch) {
      try {
        const items: unknown = JSON.parse(`[${arrayMatch[1].replace(/,\s*$/, '')}]`);
        if (Array.isArray(items)) return { impressions: items };
      } catch { /* continue */ }
    }
  }
  return null;
}
