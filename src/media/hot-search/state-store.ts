import fs from 'node:fs';
import path from 'node:path';
import type { HotSearchState } from './types.js';

const EMPTY_STATE: HotSearchState = {
  status: 'idle',
  deliveredGroupIds: [],
  itemCount: 0,
  targetCount: 0
};

function normalizeState(value: unknown): HotSearchState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return structuredClone(EMPTY_STATE);
  const raw = value as Record<string, unknown>;
  const allowed = new Set(['idle', 'success', 'failed', 'running', 'skipped']);
  const dateKey = (input: unknown) => typeof input === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input) ? input : undefined;
  const isoTime = (input: unknown) => typeof input === 'string' && Number.isFinite(new Date(input).getTime()) ? input : undefined;
  return {
    lastSuccessDate: dateKey(raw.lastSuccessDate),
    deliveryDate: dateKey(raw.deliveryDate),
    deliveredGroupIds: Array.isArray(raw.deliveredGroupIds) ? raw.deliveredGroupIds.map(String).filter((id) => /^\d+$/.test(id)) : [],
    status: allowed.has(String(raw.status)) ? raw.status as HotSearchState['status'] : 'idle',
    trigger: raw.trigger === 'scheduled' || raw.trigger === 'manual' || raw.trigger === 'preview' ? raw.trigger : undefined,
    updatedAt: isoTime(raw.updatedAt),
    itemCount: Math.max(0, Math.round(Number(raw.itemCount) || 0)),
    targetCount: Math.max(0, Math.round(Number(raw.targetCount) || 0)),
    error: typeof raw.error === 'string' ? raw.error.slice(0, 240) : undefined,
    authMode: raw.authMode === 'api-key' ? 'api-key' : raw.authMode === 'anonymous' ? 'anonymous' : undefined
  };
}

export class HotSearchStateStore {
  readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  read(): HotSearchState {
    try { return normalizeState(JSON.parse(fs.readFileSync(this.file, 'utf8'))); }
    catch { return structuredClone(EMPTY_STATE); }
  }

  write(state: HotSearchState): HotSearchState {
    const safe = normalizeState(state);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(safe, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
    return safe;
  }
}
