// 跑团规则表的**存储层**：目录、内置种子、列表、读取 + 按 mtime 缓存、删除。
//
// ── 为什么它与 `rules/` 分开 ──
//
// `rules/` 是**纯函数目录**（`scripts/check-layers.mjs` 机检：相对 import 不许离开该目录、
// 非相对 import 一律禁止，连 `node:` 都不许），而这里要读文件。这与"真熵源住在 `entropy.ts`、
// 由调用方注入"是同一条纪律：**要 I/O 的东西不许进那个目录**。
//
// ── 两个权威，各自说清 ──
//
//   • **id 就是文件名**（去掉 `.json`）。文件里那个 `id` 字段会被覆盖 —— 两份权威必然漂移，
//     而漂移的表现是"命令里敲 A、实际用的是 B"。
//   • **文件是运行期的事实来源**；`BUILTIN_RULE_FILES` 只是**种子**（首次用时补齐缺失的文件，
//     已存在的一律不动）。唯一的例外是 `generic`：它在代码里额外留一份**最终兜底**
//     （`GENERIC_RULE`），否则"删掉一个文件"就能让整个扩展没法做检定。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../../core/paths.js';
import { BUILTIN_RULE_FILES, compileRule, verifyRule } from '../rules/check.js';
import { GENERIC_RULE } from '../rules/check.js';
import { MAX_RULE_CHARS } from '../model/limits.js';
import { safeFileName } from '../model/paths.js';
import type { CheckRule, RuleFile } from '../rules/check.js';

export const RULES_DIR = path.join(DATA_DIR, 'trpg', 'rules');

export interface RuleSummary {
  id: string;
  name: string;
  description: string;
  /** 是不是内置种子之一（可以删 —— 但删了 `generic` 会走代码里那份兜底）。 */
  builtin: boolean;
  /** 这份规则表的问题（空数组 = 好）。**坏文件照样列出来**：跳过它只会让管理员看到"少了一个"。 */
  problems: string[];
}

/**
 * 取一张规则表的结果。
 *
 * `note` 非空 = **回落了**（引用的表不存在），那句话要原样写进回执 —— 静默回落正是本仓库
 * 最忌讳的那类故障（"填了、看着生效、实际用的是别的"）。
 * `ok: false` = 表**本身坏了**：这时不回落，把问题原样报上去让人去修。
 */
export type RuleLookup =
  | { ok: true; rule: CheckRule; note: string }
  | { ok: false; message: string };

interface Loaded {
  mtimeMs: number;
  /** 文件不存在（与"文件坏了"是两件事，调用方的处理完全不同）。 */
  missing: boolean;
  rule: CheckRule | null;
  problems: string[];
}

export class RuleStore {
  readonly dir: string;
  /** 首次用到规则时把内置的补齐到目录里（懒执行 —— 构造对象图不该写盘）。 */
  #seeded = false;
  /** `id → 编译结果`，按 `mtimeMs` 失效。穷举校验一万次闭包调用不该每次掷骰都跑。 */
  #cache = new Map<string, Loaded>();

  constructor(dir: string = RULES_DIR) {
    this.dir = dir;
  }

  file(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  /** 把缺失的内置规则表写进目录。**已存在的一律不动**（升级不该覆盖管理员改过的表）。 */
  ensureBuiltins(): void {
    if (this.#seeded) return;
    this.#seeded = true;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      for (const [id, file] of Object.entries(BUILTIN_RULE_FILES)) {
        const target = this.file(id);
        if (fs.existsSync(target)) continue;
        fs.writeFileSync(target, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
      }
    } catch {
      // 数据目录只读之类：种子写不进去不该让扩展装载失败 —— 后面读不到文件时会走代码里那份兜底。
    }
  }

  /** 目录里此刻有哪些规则表。坏文件也列出来，并把问题带上。 */
  list(): RuleSummary[] {
    this.ensureBuiltins();
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.dir).filter((name) => name.toLowerCase().endsWith('.json')).sort();
    } catch {
      return [];
    }
    const out: RuleSummary[] = [];
    for (const name of names) {
      const id = name.slice(0, -'.json'.length);
      if (!safeFileName(id, MAX_RULE_CHARS)) continue;
      const loaded = this.#load(id);
      const file = loaded.rule ?? this.#rawOf(id);
      out.push({
        id,
        name: file?.name || id,
        description: file?.description || '',
        builtin: id in BUILTIN_RULE_FILES,
        problems: loaded.problems
      });
    }
    return out;
  }

  /**
   * 取一张规则表。
   *
   * ⚠️ **坏了就拒绝，不静默回落**：管理员写的条件漏了兜底等级、顺序排错、表达式写错 ——
   * 这些都必须说出来。代价是那个会话的**检定**暂时不可用（`/掷骰` 不受影响，它压根不用规则表），
   * 换来的是"配置错误当场可见"。
   */
  read(id: unknown): RuleLookup {
    this.ensureBuiltins();
    const wanted = safeFileName(id, MAX_RULE_CHARS);
    if (!wanted) return { ok: true, rule: GENERIC_RULE, note: '' };

    const loaded = this.#load(wanted);
    if (loaded.rule) return { ok: true, rule: loaded.rule, note: '' };
    if (loaded.missing) {
      return {
        ok: true,
        rule: GENERIC_RULE,
        note: `这一局指定的规则表「${wanted}」不存在，已经按 generic（掷高为佳）判 ——`
          + '要改就重开一局（开局时用 rule 指定），或让管理员把那张表放回去'
      };
    }
    return { ok: false, message: `规则表「${wanted}」有问题：${loaded.problems.join('；')}` };
  }

  /** 删掉一张规则表。返回是否真的删了东西。 */
  remove(id: unknown): boolean {
    const wanted = safeFileName(id, MAX_RULE_CHARS);
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

  /** 读 + 解析 + 编译 + 穷举校验，按 mtime 缓存。 */
  #load(id: string): Loaded {
    const file = this.file(id);
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(file).mtimeMs;
    } catch {
      this.#cache.delete(id);
      return { mtimeMs: 0, missing: true, rule: null, problems: [] };
    }

    const cached = this.#cache.get(id);
    if (cached && cached.mtimeMs === mtimeMs) return cached;

    const loaded = this.#compile(file, id, mtimeMs);
    this.#cache.set(id, loaded);
    return loaded;
  }

  #compile(file: string, id: string, mtimeMs: number): Loaded {
    let raw: RuleFile;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8')) as RuleFile;
    } catch (error) {
      return {
        mtimeMs, missing: false, rule: null,
        problems: [`这个文件不是合法的 JSON：${error instanceof Error ? error.message : String(error)}`]
      };
    }
    try {
      // **id 以文件名为准**（见文件头）。
      const rule = compileRule({ ...raw, id });
      const problems = verifyRule(rule);
      return problems.length
        ? { mtimeMs, missing: false, rule: null, problems }
        : { mtimeMs, missing: false, rule, problems: [] };
    } catch (error) {
      return {
        mtimeMs, missing: false, rule: null,
        problems: [error instanceof Error ? error.message : String(error)]
      };
    }
  }

  /** 只为了在"编译失败"时还能从坏文件里捞出 name/description 给人看。 */
  #rawOf(id: string): RuleFile | null {
    try {
      return JSON.parse(fs.readFileSync(this.file(id), 'utf8')) as RuleFile;
    } catch {
      return null;
    }
  }
}
