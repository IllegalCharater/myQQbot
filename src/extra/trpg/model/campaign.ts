// 战役本身的**归一化与就地变更**（从 `state.ts` 拆出，2026-10-16）。
//
// 两条纪律：
//   • **归一化是"文件里的东西能不能信"的唯一判据** —— 读坏文件、旧版本文件、手改过的文件
//     全都走 `normalizeCampaign`；
//   • **变更函数就地改、调用方负责落盘**（`appendLog` / `findCharacter`）—— 这一层不碰磁盘，
//     于是它能在不建任何临时目录的前提下被测。写盘在 `store/campaign-store.ts`。
import { MAX_SCENARIO_CHARS } from '../types.js';
import {
  MAX_CHARACTERS, MAX_FLAGS, MAX_FLAG_VALUE_CHARS, MAX_LOG_CHARS, MAX_LOG_STORED, MAX_NAME_CHARS,
  MAX_PLAYERS, MAX_RULE_CHARS, MAX_SCENE_CHARS, MAX_SYSTEM_CHARS, MAX_TITLE_CHARS, clampInt, text
} from './limits.js';
import { normalizeCharacter } from './character.js';
import type { TrpgCampaign, TrpgCharacter, TrpgFlag, TrpgLogEntry, TrpgScenarioRef } from '../types.js';

function normalizeLogEntry(raw: unknown): TrpgLogEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const body = text(source.text, MAX_LOG_CHARS);
  if (!body) return null;
  return {
    seq: clampInt(source.seq, 0, Number.MAX_SAFE_INTEGER, 0),
    ts: clampInt(source.ts, 0, Number.MAX_SAFE_INTEGER, 0),
    kind: text(source.kind, 16) || 'note',
    text: body
  };
}

/**
 * 把任意输入归一整场战役。**读坏文件、旧版本文件、手改过的文件都会走这里**，
 * 所以它是"文件里的东西能不能信"的唯一判据。
 */
export function normalizeCampaign(raw: unknown, chatKey: string): TrpgCampaign | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const now = Date.now();

  const characters: TrpgCharacter[] = [];
  if (Array.isArray(source.characters)) {
    for (const item of source.characters) {
      if (characters.length >= MAX_CHARACTERS) break;
      const card = normalizeCharacter(item);
      // 重名的只留第一张。同名两张卡会让"改谁的血"变成运气，而工具是按名字找卡的。
      if (card && !characters.some((c) => c.name === card.name)) characters.push(card);
    }
  }

  const flags: Record<string, TrpgFlag> = {};
  const rawFlags = source.flags;
  if (rawFlags && typeof rawFlags === 'object' && !Array.isArray(rawFlags)) {
    for (const [key, value] of Object.entries(rawFlags as Record<string, unknown>)) {
      if (Object.keys(flags).length >= MAX_FLAGS) break;
      const label = text(key, MAX_NAME_CHARS);
      if (!label) continue;
      flags[label] = normalizeFlag(value);
    }
  }

  const log: TrpgLogEntry[] = [];
  if (Array.isArray(source.log)) {
    for (const item of source.log) {
      const entry = normalizeLogEntry(item);
      if (entry) log.push(entry);
    }
  }
  // 留档只留最近 MAX_LOG_STORED 条。**序号不回退**：下面 seq 取最大值 + 1。
  const trimmed = log.slice(-MAX_LOG_STORED);
  const maxSeq = trimmed.reduce((max, entry) => Math.max(max, entry.seq), 0);

  return {
    chatKey,
    // ⚠️ **迁移**：没有 `status` 字段的存档一律读成 `active` —— 升级不该把正在进行的团退回
    // "等人建卡"那一档（那会让 DM 的每一次工具调用都被状态机拦下）。同 `normalizeFlag`
    // 对旧 `flags` 形状的取舍：缺省取"更宽"的那一边。
    status: source.status === 'preparing' ? 'preparing' : 'active',
    sessionId: text(source.sessionId, 32),
    players: normalizePlayers(source.players),
    title: text(source.title, MAX_TITLE_CHARS),
    system: text(source.system, MAX_SYSTEM_CHARS),
    rule: text(source.rule, MAX_RULE_CHARS),
    scene: text(source.scene, MAX_SCENE_CHARS),
    scenario: normalizeScenario(source.scenario),
    flags,
    characters,
    log: trimmed,
    seq: Math.max(clampInt(source.seq, 1, Number.MAX_SAFE_INTEGER, 1), maxSeq + 1),
    createdAt: clampInt(source.createdAt, 0, Number.MAX_SAFE_INTEGER, now),
    updatedAt: clampInt(source.updatedAt, 0, Number.MAX_SAFE_INTEGER, now)
  };
}

/**
 * 一条旗标归一化，**含旧形状的迁移**。
 *
 * 旧存档里 `flags` 是 `Record<string, string>`（值是裸字符串）。那份数据一律读成
 * "玩家可见"：升级不该让已开团的群丢掉旗标，也不该把原本公开的事实一夜之间变成暗线 ——
 * 把某条改成暗线是一个**显式动作**（`action=flag` 带 `visible=false`），不是升级的副作用。
 * 同 `jmcomic.pythonPath` 与 `bookmarkFirst` 那两处迁移的取舍。
 */
export function normalizeFlag(raw: unknown): TrpgFlag {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const entry = raw as Record<string, unknown>;
    return {
      value: text(entry.value, MAX_FLAG_VALUE_CHARS),
      visible: entry.visible !== false
    };
  }
  return { value: text(raw, MAX_FLAG_VALUE_CHARS), visible: true };
}

/**
 * 玩家名单归一化：只留**数字 QQ 号**、去重、按上限截断。
 *
 * 判据与 `TrpgCharacter.ownerId` 逐字相同（`/^\d+$/`）—— 两处都认同一件事："玩家就是 QQ 号"。
 * 不是数字的键一律丢掉：名单会一路进提示词，而一个 `''` 或 `'张三'` 会让"谁还没建卡"
 * 这条判据永远算不出结果（见 `canActivate`）。
 */
function normalizePlayers(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    const qq = String(item ?? '');
    if (!/^\d+$/.test(qq)) continue;
    if (out.includes(qq)) continue;
    if (out.length >= MAX_PLAYERS) break;
    out.push(qq);
  }
  return out;
}

/**
 * 存档里那份剧本快照的归一化。
 *
 * `body` 的截断上限用的是 `MAX_SCENARIO_CHARS`：写入侧（`scenario/parse.ts`）**超限就拒绝**，
 * 所以这里的截断只对"手改过的存档"生效 —— 读路径永远要比写路径宽，否则一个被改坏的字段
 * 会让整局读不出来。
 */
function normalizeScenario(raw: unknown): TrpgScenarioRef {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { id: '', body: '' };
  const source = raw as Record<string, unknown>;
  return { id: text(source.id, 40), body: text(source.body, MAX_SCENARIO_CHARS) };
}

/** 开一场新团。不落盘 —— 由调用方决定什么时候写。 */
export function emptyCampaign(
  chatKey: string,
  { title, system, rule }: { title: string; system: string; rule: string }
): TrpgCampaign {
  const now = Date.now();
  return {
    chatKey,
    // 新的一局默认 **`active`**：这是"DM 说开就开"那条路（工具 `campaign action=start`）。
    // 人从 `.trpg new` 走的那条会把 status 显式设成 `preparing`（见 `model/session.ts`）。
    status: 'active',
    // `base36` 的时间戳就是这一局的身份 —— 不必全局唯一（存档本来就一个会话一个文件），
    // 只要"换一局就换一个"（重新开局会重新生成）。
    sessionId: now.toString(36),
    players: [],
    title: text(title, MAX_TITLE_CHARS) || '未命名',
    system: text(system, MAX_SYSTEM_CHARS),
    rule: text(rule, MAX_RULE_CHARS),
    scene: '',
    scenario: { id: '', body: '' },
    flags: {},
    characters: [],
    log: [],
    seq: 1,
    createdAt: now,
    updatedAt: now
  };
}

// ── 变更（就地改，调用方负责 write）─────────────────────────────────────────

/**
 * 追加一条日志并推进序号。**所有会改变状态的动作都要经过它** —— 这是"发生了什么都记得下来"
 * 的唯一入口，也是渲染层给模型看的"最近发生"。
 */
export function appendLog(campaign: TrpgCampaign, kind: string, body: string): TrpgLogEntry | null {
  const line = text(body, MAX_LOG_CHARS);
  if (!line) return null;
  const entry: TrpgLogEntry = { seq: campaign.seq, ts: Date.now(), kind: text(kind, 16) || 'note', text: line };
  campaign.seq += 1;
  campaign.log.push(entry);
  if (campaign.log.length > MAX_LOG_STORED) campaign.log.splice(0, campaign.log.length - MAX_LOG_STORED);
  campaign.updatedAt = Date.now();
  return entry;
}

/** 按名字找卡。名字是唯一的键（`normalizeCampaign` 保证不重名）。 */
export function findCharacter(campaign: TrpgCampaign, name: unknown): TrpgCharacter | null {
  const wanted = text(name, MAX_NAME_CHARS);
  if (!wanted) return null;
  return campaign.characters.find((card) => card.name === wanted) ?? null;
}

/**
 * 战报的写入端口（`store/journal-store.ts` 实现它）。
 *
 * **为什么是个端口而不是直接 import**：`model/` 不许碰 I/O（`check-layers.mjs` 有一条闸门）。
 * 这一层只说"这一条日志要进战报"，怎么落盘是 `store/` 的事 —— 与 `TrpgStore` / `RuleStore`
 * 由调用方递进来是同一手法。
 *
 * ⚠️ 它是**结构性**的（只有这一个方法），所以套件可以传一个普通对象字面量进来。
 */
export interface JournalPort {
  append(chatKey: string, entry: TrpgLogEntry): void;
}

/**
 * 把 `campaign.log` 里 **seq ≥ fromSeq** 的那些送进战报。
 *
 * ⚠️ **必须在 `store.write(campaign)` 之后调，而且要传"改动之前"的 seq**：这条判据的语义是
 * "只记**真的落盘了**的日志"。写在 `appendLog` 那一刻的话，一次被后面那句 `return err(...)`
 * 撤销的动作会**在战报里留下一条**（而存档里没有）。现状是每个动作的 `appendLog` 都恰好
 * 是最后一步，所以两者看不出差别 —— 但那是巧合，不是契约。
 *
 * 序号单调递增（截断旧日志不会让它回退），所以 `seq >= fromSeq` 精确等于"这次新加的"。
 */
export function mirrorLog(campaign: TrpgCampaign, fromSeq: number, journal: JournalPort | null): void {
  if (!journal) return;
  for (const entry of campaign.log) {
    if (entry.seq >= fromSeq) journal.append(campaign.chatKey, entry);
  }
}
