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
// ⚠️ **只记公开事件**。这一条有两个来源，都不是在这里判的：
//   • 私密叙事与暗骰的结果**压根不进 `campaign.log`**（决策 7），所以 `mirrorLog` 也带不进来；
//   • 藏在 `campaign.log` 正文里的事实（"玩家尚未见过"、`隐藏：pools/notes`、暗线旗标的名字）
//     由**写那条日志的人**标 `visible: false`（`TrpgLogEntry.visible`），`mirrorLog` 据此挡下。
//
// **不在这里再筛一遍** —— 再筛一遍就是第二份判据，迟早与第一份漂移（`render/journal.ts`
// 文件头那句是同一条）。这里只做一件事：把标记**原样带回来**（`read()` 丢掉 `visible`
// 就等于把刚挡住的那些重新放行 —— 而这个洞不会有任何报错）。
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
   * ⚠️ `visible: false` 要**原样带回来**（判据与 `normalizeLogEntry` 逐字相同：只认 `=== false`）。
   * 丢掉它的话，被 `mirrorLog` 挡下的那些条目会在**读取这一侧**重新变成"可见"——
   * 而 `.log export` 正是从这条路取数的，于是整条筛选机制静默失效。
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
      const entry: TrpgLogEntry = {
        seq: clampInt(source.seq, 0, Number.MAX_SAFE_INTEGER, 0),
        ts: clampInt(source.ts, 0, Number.MAX_SAFE_INTEGER, 0),
        kind: text(source.kind, 16) || 'note',
        text: body
      };
      if (source.visible === false) entry.visible = false;
      out.push(entry);
    }
    return out;
  }

  /**
   * 列出磁盘上真实存在的战报（面板用）。
   *
   * 判据与 `ScenarioStore.list` / `RuleStore.list` 同源：**列出来的，磁盘上一定真的有**
   * （扫目录，不拿任何名单补行 —— 补行会让面板出现"从没打过任何东西"的幽灵条目）。
   *
   * `id` 就是文件名去掉 `.jsonl` 的那一段，也就是 `safeName(chatKey)`；它经
   * `commands/log.ts` 的 `.log export` 与面板删除路由**原样**用回去（`safeName` 幂等，
   * 所以往返不丢字符）。
   */
  list(): Array<{ id: string; entries: number; bytes: number; updatedAt: number }> {
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return [];   // 目录还不存在 = 一份战报都没有
    }
    const out: Array<{ id: string; entries: number; bytes: number; updatedAt: number }> = [];
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const full = path.join(this.dir, name);
      try {
        const stat = fs.statSync(full);
        if (!stat.isFile()) continue;
        // 条数按**非空行**数：一行一条，与 `read()` 的判据同形（不解析 JSON 也能给一个诚实的数）。
        const entries = fs.readFileSync(full, 'utf8').split('\n').filter((line) => line.trim()).length;
        out.push({ id: name.slice(0, -'.jsonl'.length), entries, bytes: stat.size, updatedAt: stat.mtimeMs });
      } catch { /* 读不到/正被删：跳过它 */ }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * 删掉一份战报。返回**是不是真的删掉了一份** —— 面板要靠它区分"删了"与"本来就没有"
   * （同 `ScenarioStore.remove` / `RuleStore.remove`）。
   *
   * 参数收的是 `list()` 给的那个 id（`safeName(chatKey)`），`safeName` 幂等，所以往返不丢字符。
   * 反过来说：`id` 里就算混进 `/` 或 `..`，`safeName` 也会把它清成一个落在数据目录里的名字。
   */
  remove(chatKey: string): boolean {
    const file = this.file(chatKey);
    if (!fs.existsSync(file)) return false;
    try {
      fs.rmSync(file);
      return true;
    } catch {
      return false;
    }
  }
}
