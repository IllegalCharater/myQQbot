// 跑团剧本的**存储层**：目录、frontmatter 解析、归一化、列表、读取、删除。
//
// ── 一份剧本是什么 ──
//
// **结构化骨架 + 自由正文**：
//   • 骨架（标题 / 推荐规则 / 开局场景 / 预置旗标 / 预置人物卡）在开局时**落进这一局的状态**；
//   • 正文（世界观、主线、NPC 设定）随剧本一起**快照进这一局**，每轮注入 DM 的上下文。
// 两者都来自同一个 `.md` 文件，见下面的格式说明。
//
// ── 文件格式：`.md` + 极简 frontmatter ──
//
//     ---
//     title: 废弃灯塔
//     rule: coc7
//     scene: 午夜，码头
//     flags: {"灯塔已熄":"是","真凶是守塔人":{"value":"是","visible":false}}
//     characters: [{"name":"守塔人","visible":false,"hpMax":12}]
//     ---
//     这座灯塔三年前就废弃了……
//
// 三条取舍，都是刻意的：
//   • **不用真 YAML**（仓库零依赖，手写 YAML 解析器是自找麻烦）：只认**一行一个 `key: value`**，
//     其中 `flags` / `characters` 的值是一段 **JSON** —— 它们是数组/嵌套，塞进扁平 frontmatter
//     只会更难读。
//   • **不用纯 JSON**：正文要写多行，JSON 里得逐行转义 `\n`，人写不了。
//   • **frontmatter 可选**：没有就整份当正文（标题用文件名）。这条让"就贴一段设定"也能存。
//
// 未知的 key **忽略并记下来**（同 `normalizeCampaign` 的宽容取舍）：多打一个字不该让整份剧本报废。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../core/paths.js';
import { MAX_CHARACTERS, MAX_FLAGS, normalizeCharacter, normalizeFlag, safeFileName, text } from './state.js';
import { MAX_SCENARIO_CHARS } from './types.js';
import type { TrpgCharacter, TrpgFlag } from './types.js';

export const SCENARIOS_DIR = path.join(DATA_DIR, 'trpg', 'scenarios');

export interface ScenarioSkeleton {
  title: string;
  /** 推荐的规则表 id（空串 = 用开局时的默认）。 */
  rule: string;
  scene: string;
  flags: Record<string, TrpgFlag>;
  characters: TrpgCharacter[];
}

export interface TrpgScenario extends ScenarioSkeleton {
  id: string;
  body: string;
}

export interface ScenarioSummary {
  id: string;
  title: string;
  /** 正文多少字（面板上给人看的大小）。 */
  chars: number;
  savedAt: number;
  /** 这份剧本的问题（空数组 = 好）。**坏文件照样列出来**，否则管理员只看到"少了一个"。 */
  problems: string[];
}

export type ScenarioLookup =
  | { ok: true; scenario: TrpgScenario; ignored: string[] }
  | { ok: false; message: string };

const FRONTMATTER_START = /^-{3,}\s*$/;
const KNOWN_KEYS = new Set(['title', 'rule', 'scene', 'flags', 'characters']);

/**
 * 解析一份剧本文件。
 *
 * Raises（返回 `ok:false`）：frontmatter 里某一行没有冒号、某个 JSON 值解不开、正文超长 ——
 * 三种都**指出是哪里**（"第几行"或"哪个字段"），因为读它的人正在手改这个文件。
 */
export function parseScenario(raw: unknown, id: string): ScenarioLookup {
  const source = String(raw ?? '').replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const lines = source.split('\n');

  let head: string[] = [];
  let body = source;
  // 允许正文之前有空行（编辑器与粘贴都会带上）。
  let start = 0;
  while (start < lines.length && !lines[start].trim()) start++;
  if (start < lines.length && FRONTMATTER_START.test(lines[start])) {
    let end = -1;
    for (let i = start + 1; i < lines.length; i++) {
      if (FRONTMATTER_START.test(lines[i])) { end = i; break; }
    }
    if (end < 0) {
      return { ok: false, message: `剧本「${id}」的 frontmatter 没有闭合 —— 开头那行 \`---\` 之后要再有\n一行 \`---\` 才算结束（${KNOWN_KEYS.size} 个可用字段：${[...KNOWN_KEYS].join(' / ')}）` };
    }
    head = lines.slice(start + 1, end);
    body = lines.slice(end + 1).join('\n');
  }

  const skeleton: ScenarioSkeleton = { title: '', rule: '', scene: '', flags: {}, characters: [] };
  const ignored: string[] = [];
  const problems: string[] = [];

  for (const [index, line] of head.entries()) {
    if (!line.trim()) continue;
    const at = index + 1;   // frontmatter 内的行号（不含开头那行 `---`）
    const colon = line.indexOf(':');
    if (colon < 0) {
      return { ok: false, message: `剧本「${id}」frontmatter 第 ${at} 行没有冒号：「${line.trim().slice(0, 40)}」—— 每一行都要写成 字段名: 值` };
    }
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (!KNOWN_KEYS.has(key)) { ignored.push(key); continue; }

    if (key === 'flags' || key === 'characters') {
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch (error) {
        return {
          ok: false,
          message: `剧本「${id}」的 ${key} 不是合法 JSON（第 ${at} 行）：${error instanceof Error ? error.message : String(error)}`
            + `—— 它要写成一行 JSON，比如 ${key === 'flags' ? '{"已拿到钥匙":"是"}' : '[{"name":"守塔人","hpMax":12}]'}`
        };
      }
      if (key === 'flags') {
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return { ok: false, message: `剧本「${id}」的 flags 要是一个对象（键是旗标名、值是字符串或 {value, visible}）` };
        }
        for (const [flagKey, flagValue] of Object.entries(parsed as Record<string, unknown>)) {
          const label = text(flagKey, 24);
          if (!label) continue;
          if (Object.keys(skeleton.flags).length >= MAX_FLAGS) {
            return { ok: false, message: `剧本「${id}」的旗标超过上限（${MAX_FLAGS} 条）—— 请删掉一些` };
          }
          skeleton.flags[label] = normalizeFlag(flagValue);
        }
      } else {
        if (!Array.isArray(parsed)) {
          return { ok: false, message: `剧本「${id}」的 characters 要是一个数组（每个元素是一张人物卡）` };
        }
        for (const item of parsed) {
          // ⚠️ 文件里写的是 `visible`（**与工具参数同一个词**），而 `TrpgCharacter` 上那个字段叫
          // `discovered`。所以这里必须做一次映射 —— 不做的话 `"visible": false` 会被
          // `normalizeCharacter` 当成"没写"，默认成 true，于是**藏了、没藏住，而且不报错**
          // （2026-10-16 写这一节时当场发现的）。
          const source = item && typeof item === 'object' && !Array.isArray(item)
            ? item as Record<string, unknown> : {};
          const card = normalizeCharacter(
            source.visible === undefined ? source : { ...source, discovered: source.visible !== false });
          if (!card) { problems.push('有一张人物卡没有名字，已跳过'); continue; }
          if (skeleton.characters.length >= MAX_CHARACTERS) {
            return { ok: false, message: `剧本「${id}」的人物卡超过上限（${MAX_CHARACTERS} 张）—— 请删掉一些` };
          }
          // 重名只留第一张：同名两张卡会让"改谁的血"变成运气（同 `normalizeCampaign`）。
          if (!skeleton.characters.some((existing) => existing.name === card.name)) skeleton.characters.push(card);
        }
      }
      continue;
    }

    // 标量字段：剥掉可选的外层引号（人在 frontmatter 里写 `title: "灯塔"` 很常见）。
    const plain = value.replace(/^["'“”]+|["'“”]+$/g, '').trim();
    if (key === 'title') skeleton.title = text(plain, 60);
    if (key === 'rule') skeleton.rule = text(plain, 64);
    if (key === 'scene') skeleton.scene = text(plain, 400);
  }

  const trimmed = body.trim();
  if (trimmed.length > MAX_SCENARIO_CHARS) {
    return {
      ok: false,
      message: `剧本「${id}」的正文太长了（${trimmed.length} 字，上限 ${MAX_SCENARIO_CHARS}）——`
        + '它每一轮都要进 DM 的上下文，所以只能这么长。把可以变成"事实"的部分挪进 flags / characters，剩下的删减。'
    };
  }

  return {
    ok: true,
    ignored: [...new Set([...ignored, ...problems])],
    scenario: {
      id,
      title: skeleton.title || id,   // 没写标题就用文件名 —— 它本来就是 id
      rule: skeleton.rule,
      scene: skeleton.scene,
      flags: skeleton.flags,
      characters: skeleton.characters,
      body: trimmed
    }
  };
}

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
    const wanted = safeFileName(id, 40);
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
    const wanted = safeFileName(id, 40);
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
    const wanted = safeFileName(id, 40);
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
