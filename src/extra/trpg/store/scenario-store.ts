// 剧本库的**落盘与列举**（从 `scenario.ts` 拆出，2026-10-16）。
//
// 目录、mtime 缓存、列表、读取、写入、删除都在这里；**判据在 `scenario/parse.ts`**。
//
// ⚠️ 缓存是按 **mtime** 的，不是"读一次就永远记着"：`prompt()` 每轮都会问一次清单，
// 不能每轮重解所有文件；而"改了文件不重启也生效"这条承诺的唯一凭据就是这个比较
// （`t-trpg-rules.mjs` 里那条"改了之后读到新的一版"是它的守护）。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../../core/paths.js';
import { safeFileName } from '../model/paths.js';
import { parseScenario } from '../scenario/parse.js';
import type { ScenarioLookup, ScenarioSummary } from '../scenario/parse.js';

export const SCENARIOS_DIR = path.join(DATA_DIR, 'trpg', 'scenarios');

interface CacheEntry { mtimeMs: number; lookup: ScenarioLookup }

export class ScenarioStore {
  readonly dir: string;
  #cache = new Map<string, CacheEntry>();

  constructor(dir: string = SCENARIOS_DIR) {
    this.dir = dir;
  }

  file(id: string): string {
    return path.join(this.dir, `${id}.md`);
  }

  /** 目录里此刻有哪些剧本。**坏文件也列出来**，并把问题带上。 */
  list(): ScenarioSummary[] {
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.dir).filter((name) => name.toLowerCase().endsWith('.md')).sort();
    } catch {
      return [];
    }
    const out: ScenarioSummary[] = [];
    for (const name of names) {
      const id = name.slice(0, -'.md'.length);
      if (!safeFileName(id)) continue;
      const stat = this.#stat(id);
      if (!stat) continue;
      const lookup = this.#load(id, stat.mtimeMs);
      out.push(lookup.ok
        ? { id, title: lookup.scenario.title, chars: lookup.scenario.body.length, savedAt: stat.mtimeMs, problems: [] }
        : { id, title: id, chars: 0, savedAt: stat.mtimeMs, problems: [lookup.message] });
    }
    return out;
  }

  /** 读一份剧本。坏文件**拒绝**（不拿一个空壳顶上 —— 那会变成"开局了但什么都没注入"）。 */
  read(id: unknown): ScenarioLookup {
    const wanted = safeFileName(id);
    if (!wanted) return { ok: false, message: '剧本名不能是空的' };
    const stat = this.#stat(wanted);
    if (!stat) {
      const known = this.list().map((item) => item.id);
      return { ok: false, message: `没有叫「${wanted}」的剧本。现在有：${known.join('、') || '（一个都没有）'}` };
    }
    return this.#load(wanted, stat.mtimeMs);
  }

  /** 写一份剧本（名字即 id）。`raw` 是文件全文（含 frontmatter）。 */
  write(id: unknown, raw: unknown): ScenarioLookup {
    const wanted = safeFileName(id);
    if (!wanted) return { ok: false, message: '剧本名不能是空的（也不能只有路径分隔符或点）' };
    const parsed = parseScenario(raw, wanted);
    if (!parsed.ok) return parsed;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const target = this.file(wanted);
      const tmp = `${target}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, String(raw ?? ''), 'utf8');
      fs.renameSync(tmp, target);
    } catch (error) {
      return { ok: false, message: `写不进剧本目录：${error instanceof Error ? error.message : String(error)}` };
    }
    this.#cache.delete(wanted);
    return parsed;
  }

  remove(id: unknown): boolean {
    const wanted = safeFileName(id);
    if (!wanted) return false;
    this.#cache.delete(wanted);
    try {
      fs.rmSync(this.file(wanted));
      return true;
    } catch {
      return false;   // 本来就没有
    }
  }

  // ── 内部 ──

  #stat(id: string): { mtimeMs: number } | null {
    try {
      return { mtimeMs: fs.statSync(this.file(id)).mtimeMs };
    } catch {
      return null;
    }
  }

  /** 读 + 解析，按 mtime 缓存（`prompt()` 每轮都会问一次清单，不能每轮重解所有文件）。 */
  #load(id: string, mtimeMs: number): ScenarioLookup {
    const cached = this.#cache.get(id);
    if (cached && cached.mtimeMs === mtimeMs) return cached.lookup;
    let lookup: ScenarioLookup;
    try {
      lookup = parseScenario(fs.readFileSync(this.file(id), 'utf8'), id);
    } catch (error) {
      lookup = { ok: false, message: `读不到剧本「${id}」：${error instanceof Error ? error.message : String(error)}` };
    }
    this.#cache.set(id, { mtimeMs, lookup });
    return lookup;
  }
}
