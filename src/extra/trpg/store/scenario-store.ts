// 剧本库的**落盘与列举**（从 `scenario.ts` 拆出，2026-10-16）。
//
// 目录、mtime 缓存、列表、读取、写入、删除都在这里；**判据在 `scenario/parse.ts`**。
//
// ⚠️ 缓存是按 **mtime** 的，不是"读一次就永远记着"：`prompt()` 每轮都会问一次清单，
// 不能每轮重解所有文件；而"改了文件不重启也生效"这条承诺的唯一凭据就是这个比较
// （`t-trpg-rules.mjs` 里那条"改了之后读到新的一版"是它的守护）。
//
// ── 一个剧本是四个东西（P7-a）──
//
//     <id>.md           正文（含 frontmatter）—— **唯一决定"这个剧本存不存在"的文件**
//     <id>.struct.json  抽取出来的剧情结构（有独立预算，不占正文字数）
//     <id>.rule.json    抽取出来的规则扩展（P7-c 起产出）
//     <id>.raw/         原文切片（保底：正文压缩过、结构可能抽漏，原文得留一份人可读的）
//
// 四条边界：
//   • **`.md` 是唯一的权威**：`list()` 只扫 `.md`，所以三个伴生天然被排除（`.json` 后缀不匹配，
//     `raw/` 是子目录而 `readdirSync` 不递归）。**不用给列表加"排除伴生"的判据** ——
//     那种判据漏一条就会让 `.struct.json` 冒充成一个剧本。
//   • **伴生坏了不掀翻剧本**（`extrasProblems`，与 `problems` 分开）：一份好好的 `.md` 不该
//     因为旁路文件被手改坏就开不了局。反过来也不行 —— `.md` 坏了整个剧本就是坏的。
//   • **重写 `.md` 会清掉伴生**：它们描述的是**上一份**正文，留着比没有更坏 ——
//     DM 会拿着一份与手上模组对不上的结构，而群里没人看得出来。
//   • **伴生文件都是可选的**：大多数剧本（手写的 `.md`）一个都没有，这是正常状态，
//     不是"缺了什么"。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../../core/paths.js';
import { safeFileName } from '../model/paths.js';
import { parseScenario } from '../scenario/parse.js';
import type { ScenarioExtras, ScenarioLookup, ScenarioSummary } from '../scenario/parse.js';

export const SCENARIOS_DIR = path.join(DATA_DIR, 'trpg', 'scenarios');

interface CacheEntry { signature: string; lookup: ScenarioLookup }

/** `writeExtras` 的入参。三个字段都是"给了才动"，`undefined` = 不碰对应的那个文件。 */
export interface ScenarioExtrasInput {
  struct?: unknown;
  ruleExt?: unknown;
  /**
   * 原文切片，按顺序落成 `00.md` / `01.md`…**整个目录先清后写**。
   *
   * 给空数组 = 把 `raw/` 清空（重传一份更短的文件时该发生的事）。
   */
  raw?: readonly { heading: string; text: string }[];
}

export type ExtrasWriteResult = { ok: true } | { ok: false; message: string };

export class ScenarioStore {
  readonly dir: string;
  #cache = new Map<string, CacheEntry>();

  constructor(dir: string = SCENARIOS_DIR) {
    this.dir = dir;
  }

  file(id: string): string {
    return path.join(this.dir, `${id}.md`);
  }

  /** 抽取出来的剧情结构。名字与 `file()` 同形（`.md` ⇄ `.struct.json`），一眼看得出是一对。 */
  structFile(id: string): string {
    return path.join(this.dir, `${id}.struct.json`);
  }

  /** 抽取出来的规则扩展（P7-c 起产出）。 */
  ruleFile(id: string): string {
    return path.join(this.dir, `${id}.rule.json`);
  }

  /** 原文切片目录。 */
  rawDir(id: string): string {
    return path.join(this.dir, `${id}.raw`);
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
        ? {
          id,
          title: lookup.scenario.title,
          chars: lookup.scenario.body.length,
          savedAt: stat.mtimeMs,
          problems: [],
          hasStruct: lookup.scenario.struct !== undefined,
          rawParts: lookup.scenario.rawParts ?? 0
        }
        : {
          id,
          title: id,
          chars: 0,
          savedAt: stat.mtimeMs,
          problems: [lookup.message],
          hasStruct: false,
          rawParts: 0
        });
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

  /**
   * 写一份剧本（名字即 id）。`raw` 是文件全文（含 frontmatter）。
   *
   * ⚠️ **顺手清掉伴生文件**（见文件头那条）：`saveScenario` 的顺序是"先写 `.md`、再写伴生"，
   * 所以它写伴生那一步在清空之后 —— 顺序反过来的话第一次上传的产物会被自己清掉。
   */
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
    this.#dropExtras(wanted);
    this.#cache.delete(wanted);
    return parsed;
  }

  /**
   * 写伴生文件（抽取管线的产物）。
   *
   * **调用方负责保证 `.md` 已经写好了** —— 这个函数不看 `.md`，也不做任何格式校验：
   * 它写的是"我们自己抽出来的东西"，形状由 `schema.ts` 的 `coerceStruct` 在更早那一步定死。
   *
   * 失败**不影响剧本本身**（`.md` 已经落好了），所以调用方拿到 `ok:false` 时该做的是
   * "如实说伴生没写进去"，而不是回滚。
   */
  writeExtras(id: unknown, extras: ScenarioExtrasInput): ExtrasWriteResult {
    const wanted = safeFileName(id);
    if (!wanted) return { ok: false, message: '剧本名不能是空的' };
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      if (extras.struct !== undefined) this.#writeJson(this.structFile(wanted), extras.struct);
      if (extras.ruleExt !== undefined) this.#writeJson(this.ruleFile(wanted), extras.ruleExt);
      if (extras.raw) {
        const dir = this.rawDir(wanted);
        fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(dir, { recursive: true });
        extras.raw.forEach((part, index) => {
          const head = String(part.heading ?? '').trim();
          const body = String(part.text ?? '');
          fs.writeFileSync(path.join(dir, `${String(index).padStart(2, '0')}.md`), head ? `# ${head}\n\n${body}` : body, 'utf8');
        });
      }
    } catch (error) {
      return { ok: false, message: `写不进伴生文件：${error instanceof Error ? error.message : String(error)}` };
    }
    this.#cache.delete(wanted);
    return { ok: true };
  }

  /** 删一份剧本，**连伴生一起删**（只删 `.md` 的话结构文件会变成孤儿，而它从此没人认得出来）。 */
  remove(id: unknown): boolean {
    const wanted = safeFileName(id);
    if (!wanted) return false;
    this.#cache.delete(wanted);
    const had = fs.existsSync(this.file(wanted));
    try {
      fs.rmSync(this.file(wanted));
    } catch {
      // 本来就没有 —— 伴生仍要清（可能是一次写了一半的产物）。
    }
    this.#dropExtras(wanted);
    return had;
  }

  // ── 内部 ──

  #stat(id: string): { mtimeMs: number } | null {
    try {
      return { mtimeMs: fs.statSync(this.file(id)).mtimeMs };
    } catch {
      return null;
    }
  }

  #mtime(file: string): number {
    try {
      return fs.statSync(file).mtimeMs;
    } catch {
      return 0;   // 没有这个伴生是**正常**的
    }
  }

  /** `raw/` 下有几片。只数 `.md` —— 人往那个目录里丢个 `notes.txt` 不该让计数漂。 */
  #rawCount(id: string): number {
    try {
      return fs.readdirSync(this.rawDir(id)).filter((name) => name.toLowerCase().endsWith('.md')).length;
    } catch {
      return 0;
    }
  }

  /**
   * 缓存签名。
   *
   * ⚠️ **必须是四个文件的合成签名，不能只看 `.md` 的 mtime**：`.trpg check` 的回执教人手改
   * `struct.json` 再核对一次，而手改伴生**不动 `.md`** —— 只看 `.md` 的话第二次读到的还是
   * 第一次那份缓存，表现是"改了没反应"，而那条承诺（"改了文件不重启也生效"）是本文件开头
   * 写着的两条缓存理由之一。
   *
   * `raw/` 那一维用**片数**而不是 mtime：目录的 mtime 会被"读"以外的事改（编辑器、同步盘），
   * 而片数才是它真正影响下游的东西（`rawParts` 计数与 `.trpg check` 的统计）。
   */
  #signature(id: string, mtimeMs: number): string {
    return `${mtimeMs}|${this.#mtime(this.structFile(id))}|${this.#mtime(this.ruleFile(id))}|${this.#rawCount(id)}`;
  }

  /** 读 + 解析 + 挂伴生，按合成签名缓存。 */
  #load(id: string, mtimeMs: number): ScenarioLookup {
    const signature = this.#signature(id, mtimeMs);
    const cached = this.#cache.get(id);
    if (cached && cached.signature === signature) return cached.lookup;
    let lookup: ScenarioLookup;
    try {
      lookup = parseScenario(fs.readFileSync(this.file(id), 'utf8'), id);
    } catch (error) {
      lookup = { ok: false, message: `读不到剧本「${id}」：${error instanceof Error ? error.message : String(error)}` };
    }
    if (lookup.ok) lookup = { ...lookup, scenario: { ...lookup.scenario, ...this.#extras(id) } };
    this.#cache.set(id, { signature, lookup });
    return lookup;
  }

  /**
   * 读伴生文件。**解不开的只记一笔，不抛**（见文件头：伴生坏了不掀翻剧本）。
   *
   * 两个 `JSON.parse` 各写一遍是因为**报错要指名道姓**（哪个文件、坏在哪）——
   * 抽成一个循环会让文案退化成"伴生文件坏了"，而人手上要改的是其中一个。
   */
  #extras(id: string): ScenarioExtras {
    const problems: string[] = [];
    const struct = this.#readJson(this.structFile(id), '剧情结构', problems);
    const ruleExt = this.#readJson(this.ruleFile(id), '规则扩展', problems);
    return {
      ...(struct === undefined ? {} : { struct }),
      ...(ruleExt === undefined ? {} : { ruleExt }),
      rawParts: this.#rawCount(id),
      ...(problems.length ? { extrasProblems: problems } : {})
    };
  }

  #readJson(file: string, label: string, problems: string[]): unknown {
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      return undefined;   // 没有这个伴生 —— 绝大多数剧本都是这样，不是错误
    }
    try {
      return JSON.parse(raw);
    } catch (error) {
      problems.push(`${label}文件（${path.basename(file)}）解不开：${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  #writeJson(target: string, value: unknown): void {
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 1), 'utf8');
    fs.renameSync(tmp, target);
  }

  #dropExtras(id: string): void {
    fs.rmSync(this.structFile(id), { force: true });
    fs.rmSync(this.ruleFile(id), { force: true });
    fs.rmSync(this.rawDir(id), { recursive: true, force: true });
  }
}
