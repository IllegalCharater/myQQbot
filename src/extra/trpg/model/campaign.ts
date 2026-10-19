// 战役本身的**归一化与就地变更**（从 `state.ts` 拆出，2026-10-16）。
//
// 两条纪律：
//   • **归一化是"文件里的东西能不能信"的唯一判据** —— 读坏文件、旧版本文件、手改过的文件
//     全都走 `normalizeCampaign`；
//   • **变更函数就地改、调用方负责落盘**（`appendLog` / `findCharacter`）—— 这一层不碰磁盘，
//     于是它能在不建任何临时目录的前提下被测。写盘在 `store/campaign-store.ts`。
import { MAX_SCENARIO_CHARS } from '../types.js';
import {
  MAX_ACT_NAME_CHARS, MAX_CHARACTERS, MAX_ENDING_KEEPER_CHARS, MAX_ENDING_NAME_CHARS,
  MAX_FLAGS, MAX_FLAG_VALUE_CHARS, MAX_LOG_CHARS, MAX_LOG_STORED, MAX_NAME_CHARS,
  MAX_PLAYERS, MAX_RULE_CHARS, MAX_SCENARIO_ID_CHARS, MAX_SCENE_CHARS, MAX_STRUCT_BYTES,
  MAX_SYSTEM_CHARS, MAX_TITLE_CHARS, clampInt, text
} from './limits.js';
import { normalizeCharacter } from './character.js';
import { normalizeCombat } from './combat.js';
import { ADVANCEMENT_METRICS } from '../types.js';
import type { TrpgEnded } from '../types.js';
import type { AdvancementMetric, TrpgAdvancement, TrpgCampaign, TrpgCharacter, TrpgFlag, TrpgLogEntry, TrpgScenarioRef } from '../types.js';

function normalizeLogEntry(raw: unknown): TrpgLogEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const body = text(source.text, MAX_LOG_CHARS);
  if (!body) return null;
  const entry: TrpgLogEntry = {
    seq: clampInt(source.seq, 0, Number.MAX_SAFE_INTEGER, 0),
    ts: clampInt(source.ts, 0, Number.MAX_SAFE_INTEGER, 0),
    kind: text(source.kind, 16) || 'note',
    text: body
  };
  // 缺省 `true`（**不写这个键**）—— 旧存档里本来就没有它，读成"可见"才与写它之前的行为一致。
  // 判据是 `=== false` 而不是"真不真"：手改过的文件写 `visible: 0` 不该变成"藏起来"。
  if (source.visible === false) entry.visible = false;
  return entry;
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
  const endedRef = normalizeEnded(source.ended);
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
    // 分幕（P8）：**只做类型/长度**，不校验"这一幕在不在" —— 那是 `scenario/extract/schema.ts`
    // 的活，而 `model/` 不认识 acts。缺字段（旧存档）读成 `''` = 单幕模式。
    currentAct: text(source.currentAct, MAX_ACT_NAME_CHARS),
    scenario: normalizeScenario(source.scenario),
    flags,
    characters,
    // ⚠️ **迁移取"少做一件事"的那一边**：旧存档没有 `combat`，读成 `null`（= 没在打）。
    // 不会拦住任何既有玩法，也不会凭空造出一场谁都没开始的战斗。
    combat: normalizeCombat(source.combat),
    // 旧存档没有这一栏 → 三项 0（不报错：推进度是旁路度量，缺了不影响任何玩法）。
    advancement: normalizeAdvancement(source.advancement),
    // 模型收团的标记（P8-c）。缺省不写这个键 —— 人敲的 `.trpg end` 与还在跑的团都没有它。
    ...(endedRef ? { ended: endedRef } : {}),
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
/**
 * 伴生结构 / 规则扩展的**读路径**（P7-a）。
 *
 * 三条：
 *   • **只收普通对象**：数组与标量一律丢掉 —— 它们的解释权在 `parseStruct` / `compileRuleSet`，
 *     而"形状根本不对"这一档那两个函数都会拒绝，留着只会让每一处消费点都多一句"先判一下"。
 *   • **按序列化字节夹**：它是随存档进提示词的东西，一份手改过的大对象能让每一轮多背几十 KB
 *     （同 `MAX_STRUCT_BYTES` 那条理由）。夹不住（成环、`BigInt` 之类序列化会抛）也丢掉 ——
 *     读路径不许抛。
 *   • **丢掉不报错**：读路径比写路径宽，一个被改坏的伴生字段不该让**整局**读不出来。
 */
function extrasField(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  try {
    if (JSON.stringify(raw).length > MAX_STRUCT_BYTES) return null;
  } catch {
    return null;
  }
  return raw as Record<string, unknown>;
}

/**
 * 推进度的归一化（P8-b）。**读路径永远比写路径宽**：坏值一律夹回，缺字段给 0。
 *
 * `dirty` / `hinted` 是**可选的**：两者都为空时不写这两个键，于是"没有推进度"的存档
 * 与"刚开一局"的存档逐字同形。
 */
/**
 * 收团标记的归一化（P8-c）。**读路径比写路径宽**：形状不对就当没有（不会让整局读不出来）。
 *
 * `endingId` 允许是空串（自由结局）；`reason` 同理。`at` 取不到就给 0 —— 它只用于展示。
 */
function normalizeEnded(raw: unknown): TrpgEnded | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  return {
    endingId: text(source.endingId, MAX_ENDING_NAME_CHARS),
    reason: text(source.reason, MAX_ENDING_KEEPER_CHARS),
    at: clampInt(source.at, 0, Number.MAX_SAFE_INTEGER, 0)
  };
}

function normalizeAdvancement(raw: unknown): TrpgAdvancement {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown> : {};
  const out: TrpgAdvancement = {
    scene: clampInt(source.scene, 0, Number.MAX_SAFE_INTEGER, 0),
    flag: clampInt(source.flag, 0, Number.MAX_SAFE_INTEGER, 0),
    act: clampInt(source.act, 0, Number.MAX_SAFE_INTEGER, 0)
  };
  const dirty = source.dirty;
  if (dirty && typeof dirty === 'object' && !Array.isArray(dirty)) {
    const kept: Partial<Record<AdvancementMetric, true>> = {};
    for (const metric of ADVANCEMENT_METRICS) {
      if ((dirty as Record<string, unknown>)[metric] === true) kept[metric] = true;
    }
    if (Object.keys(kept).length) out.dirty = kept;
  }
  const hinted = source.hinted;
  if (hinted && typeof hinted === 'object' && !Array.isArray(hinted)) {
    const kept: Partial<Record<AdvancementMetric, number>> = {};
    for (const metric of ADVANCEMENT_METRICS) {
      const value = (hinted as Record<string, unknown>)[metric];
      if (value === undefined) continue;
      kept[metric] = clampInt(value, 0, Number.MAX_SAFE_INTEGER, 0);
    }
    if (Object.keys(kept).length) out.hinted = kept;
  }
  return out;
}

function normalizeScenario(raw: unknown): TrpgScenarioRef {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { id: '', body: '' };
  const source = raw as Record<string, unknown>;
  const struct = extrasField(source.struct);
  const ruleExt = extrasField(source.ruleExt);
  return {
    id: text(source.id, MAX_SCENARIO_ID_CHARS),
    body: text(source.body, MAX_SCENARIO_CHARS),
    ...(struct ? { struct } : {}),
    ...(ruleExt ? { ruleExt } : {})
  };
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
    currentAct: '',
    scenario: { id: '', body: '' },
    flags: {},
    characters: [],
    combat: null,
    advancement: { scene: 0, flag: 0, act: 0 },
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
 *
 * `visible = false` 表示"这一条不能进给玩家看的战报"（见 `TrpgLogEntry.visible`）。
 * **由调用方判**：写这条日志的人此刻手里正好有"这张卡藏了没有、这条旗标是不是暗线"，
 * 而 `mirrorLog` 与导出路径都判不出来。
 */
export function appendLog(campaign: TrpgCampaign, kind: string, body: string, visible = true): TrpgLogEntry | null {
  const line = text(body, MAX_LOG_CHARS);
  if (!line) return null;
  const entry: TrpgLogEntry = { seq: campaign.seq, ts: Date.now(), kind: text(kind, 16) || 'note', text: line };
  if (!visible) entry.visible = false;
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
  /**
   * `sessionId` 是"这一条属于哪一局"（见 `TrpgLogEntry.session`）。
   * **可选**：旧调用点与套件里的普通对象字面量不必认识它。
   */
  append(chatKey: string, entry: TrpgLogEntry, sessionId?: string): void;
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
 *
 * ⚠️ **`visible === false` 的那些不进战报**（见 `TrpgLogEntry.visible`）：战报会被导出成文件
 * 发进群，而藏起来的卡与暗线在 `campaign.log` 的正文里是写着名字的。**写入侧这一道是主判据**；
 * 导出路径（`commands/log.ts`）在"把这份文件发出去"那一刻**按同一条判据再查一遍** —— 那不是
 * 第二份逻辑，而是同一条判据在发布边界上的重放，挡的是"手改过的战报文件"与"将来某个绕过
 * `mirrorLog` 的写入点"。两处对 `visible === false` 的判断必须逐字一致。
 */
export function mirrorLog(campaign: TrpgCampaign, fromSeq: number, journal: JournalPort | null): void {
  if (!journal) return;
  for (const entry of campaign.log) {
    if (entry.seq >= fromSeq && entry.visible !== false) {
      journal.append(campaign.chatKey, entry, campaign.sessionId);
    }
  }
}
