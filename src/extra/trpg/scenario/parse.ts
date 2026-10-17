// 剧本格式的**解析与判据**（从 `scenario.ts` 拆出，2026-10-16）。纯函数，不碰磁盘。
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
import { MAX_CHARACTERS, MAX_FLAGS, MAX_RULE_CHARS, MAX_SCENE_CHARS, MAX_TITLE_CHARS, text } from '../model/limits.js';
import { normalizeCharacter } from '../model/character.js';
import { normalizeFlag } from '../model/campaign.js';
import { MAX_SCENARIO_CHARS } from '../types.js';
import type { TrpgCharacter, TrpgFlag } from '../types.js';

/**
 * 下载剧本文件时的大小上限。
 *
 * 一份 4000 字的中文剧本在 UTF-8 里约 12KB，256KB 已经很宽 —— 这个数的用途是"别让人传一个
 * 200MB 的东西把内存塞满"，不是限制正文（正文由 `MAX_SCENARIO_CHARS` 管）。
 */
export const MAX_SCENARIO_BYTES = 256 * 1024;

export interface ScenarioSkeleton {
  title: string;
  /** 推荐的规则表 id（空串 = 用开局时的默认）。 */
  rule: string;
  scene: string;
  flags: Record<string, TrpgFlag>;
  characters: TrpgCharacter[];
}

/**
 * 一份剧本的**伴生文件**（P7-a）。
 *
 * 抽取管线的产物与 `.md` 分开存：正文只留"世界观 + 主线"的压缩版（`MAX_SCENARIO_CHARS`
 * 那条上限是成本不是洁癖），细节进 `struct`、原文进 `raw/`（保底，人可读）。
 *
 * ⚠️ 两个 `unknown` 字段的类型定义**不在这里**，也不在 `types.ts` 里（那个文件不许 import
 * 本模块的任何东西）。它们的**唯一解释处**是 `scenario/extract/schema.ts` 的 `parseStruct`
 * 与 `rules/rule-set.ts` 的 `compileRuleSet`（都是"收 `unknown` 出类型"）。
 * 在这里写一份形状必然与那两处漂移，而漂移的表现是"写的时候按 A 写、读的时候按 B 读"。
 */
export interface ScenarioExtras {
  /** `<id>.struct.json` 的内容（`JSON.parse` 的产物，原样）。 */
  struct?: unknown;
  /** `<id>.rule.json` 的内容（原样）。P7-c 起才产出。 */
  ruleExt?: unknown;
  /** `<id>.raw/` 下有几片原文切片。 */
  rawParts?: number;
  /**
   * 伴生文件读不动时的说明（空数组 = 都好）。
   *
   * ⚠️ **与 `problems` 分开**：`problems` 说的是"这份剧本本身不能用"（`usableScenarios` 按它
   * 过滤），而一个坏掉的 `struct.json` 不该让一份好好的 `.md` 变得不能开局 —— 那等于因为
   * 一个旁路文件丢了整局。它的去向是回执与 `.trpg check`，**不是**过滤。
   */
  extrasProblems?: string[];
}

export interface TrpgScenario extends ScenarioSkeleton, ScenarioExtras {
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
  /** 有没有抽取产物（`<id>.struct.json` 在不在且解得开）。`.trpg check` 与回执按它分流。 */
  hasStruct: boolean;
  /** `<id>.raw/` 下有几片原文切片。 */
  rawParts: number;
}

export type ScenarioLookup =
  | { ok: true; scenario: TrpgScenario; ignored: string[] }
  | { ok: false; message: string };

const FRONTMATTER_START = /^-{3,}\s*$/;
const KNOWN_KEYS = new Set(['title', 'rule', 'scene', 'flags', 'characters']);

/**
 * 解析一份剧本文件。
 *
 * 失败（返回 `ok:false`）：frontmatter 里某一行没有冒号、某个 JSON 值解不开、正文超长 ——
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
    // ⚠️ 上限一律取 `model/limits.ts` 的具名常量，**不写字面量**：这三个数在别处（`beginCampaign`
    // 落进状态时、`state.ts` 归一化时）也各用一次，写死的话"剧本里的标题能有多长"与"存档里的
    // 标题能有多长"会各按各的算，而表现只是某个字段被悄悄截短。
    const plain = value.replace(/^["'“”]+|["'“”]+$/g, '').trim();
    if (key === 'title') skeleton.title = text(plain, MAX_TITLE_CHARS);
    if (key === 'rule') skeleton.rule = text(plain, MAX_RULE_CHARS);
    if (key === 'scene') skeleton.scene = text(plain, MAX_SCENE_CHARS);
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

/**
 * 这份文本是不是**规定的剧本格式** —— 开头有一个 frontmatter 块，且整份能解析。
 *
 * ⚠️ 它**不等于** `parseScenario(...).ok`：那一个对**没有 frontmatter** 的文本也成功
 * （整份当正文、标题取文件名）。那是给手写 `.md` 留的宽容口子，不是"格式匹配成功"。
 *
 * `/剧本` 拿它决定要不要让模型整理一遍（见 `scenario/format.ts`）。两类都算
 * "不是规定格式"：**裸正文**（没 frontmatter），或**有 frontmatter 但解析报错**
 * （JSON 写坏、正文超长…）—— 后一类模型同样修得了。
 */
export function isFormattedScenario(raw: unknown, id = 'scenario'): boolean {
  const source = String(raw ?? '').replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const lines = source.split('\n');
  let start = 0;
  while (start < lines.length && !lines[start].trim()) start++;
  // 只看"开头有没有那一行" —— 闭合那一步交给 parseScenario（它自己会报"没有闭合"）。
  if (start >= lines.length || !FRONTMATTER_START.test(lines[start])) return false;
  return parseScenario(source, id).ok;
}
