// 战报的**落盘**（2026-10-16 加，决策 6）。
//
// ── 为什么另开一份，而不是把 `campaign.log` 存久一点 ──
//
// `campaign.log` 是**每轮都要进 system prompt** 的东西，所以它有一个 60 条的环形上限
// （`MAX_LOG_STORED`）—— 那个数不是洁癖，是成本。而"这一局打过什么"要给**人**看，
// 要求的是完整，与提示词预算完全无关。两个需求挤在一个数组上，只能二选一。
// 所以：`campaign.log` 保持 60 条的环形缓冲，战报另开一份 **append-only** 的 jsonl。
//
// ── 形状 ──
//
// `data/trpg/journal/<会话>.jsonl`，一行一条 `{ seq, ts, kind, text }`（就是 `TrpgLogEntry`）。
// 选 jsonl 而不是一个大 JSON 数组，是因为它**只能追加**：写到一半断电，坏的是最后一行，
// 前面每一行都还在 —— 而"整份重写"在断电时会把整个战报变成半截。
//
// ⚠️ **只记公开事件**：私密叙事与暗骰的结果**压根不进 `campaign.log`**（决策 7），
// 所以 `mirrorLog` 也就带不进这里。这是这条通道能直接当"给玩家看的战报"的原因 ——
// 不必在这里再筛一遍（再筛一遍就是第二份判据，迟早与第一份漂移）。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../../core/paths.js';
import { safeName } from '../model/paths.js';
import { clampInt, text } from '../model/limits.js';
import { MAX_LOG_CHARS } from '../model/limits.js';
import type { TrpgLogEntry } from '../types.js';

export const JOURNAL_DIR = path.join(DATA_DIR, 'trpg', 'journal');

export class JournalStore {
  readonly dir: string;

  constructor(dir: string = JOURNAL_DIR) {
    this.dir = dir;
  }

  file(chatKey: string): string {
    return path.join(this.dir, `${safeName(chatKey)}.jsonl`);
  }

  /**
   * 追加一条。**永不抛**：战报是旁路（主流程已经把这一局的日志写进存档了），
   * 一次写盘失败不该让群友那次操作看起来失败。
   */
  append(chatKey: string, entry: TrpgLogEntry): void {
    if (!chatKey) return;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.appendFileSync(this.file(chatKey), `${JSON.stringify(entry)}\n`, 'utf8');
    } catch { /* 旁路：磁盘满/权限不够都不该掀翻主流程 */ }
  }

  /**
   * 读回整份战报。坏行**跳过**（append-only 的代价是最后一行可能是半截），
   * 返回的顺序就是写入顺序。
   *
   * 读取与渲染的其余部分（导出成 `.txt`/`.md`、面板列表）在 P6 —— 这一版只给它一个
   * 能在不建真图解的前提下断言"写了什么"的入口。
   */
  read(chatKey: string): TrpgLogEntry[] {
    let raw = '';
    try {
      raw = fs.readFileSync(this.file(chatKey), 'utf8');
    } catch {
      return [];   // 还没有战报（这一局没打过任何东西）
    }
    const out: TrpgLogEntry[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;   // 半截行（断电/并发）—— 跳过它，前面的每一条都还在
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      const source = parsed as Record<string, unknown>;
      const body = text(source.text, MAX_LOG_CHARS);
      if (!body) continue;
      out.push({
        seq: clampInt(source.seq, 0, Number.MAX_SAFE_INTEGER, 0),
        ts: clampInt(source.ts, 0, Number.MAX_SAFE_INTEGER, 0),
        kind: text(source.kind, 16) || 'note',
        text: body
      });
    }
    return out;
  }

  remove(chatKey: string): void {
    try { fs.rmSync(this.file(chatKey)); } catch { /* 本来就没有 */ }
  }
}
