// 跑团战斗状态的**领域模型**（P5）。
//
// ── 这一层做什么 ──
//
// 把"战斗"这件事接进存档：归一化（`normalizeCombat`）、开打（`startCombat`）、推进
// （`advanceCombat` / `advanceAfterActions`）、收场（`endCombat`），以及两个查询
// （`currentActor` / `immobileNames`）。
//
// **纯数据变换，不碰磁盘**（`model/` 那条闸门禁的正是 `node:fs` / `node:path`）——
// 读写一律由调用方经 `TrpgStore` 做。顺序的算术全在 `rules/combat.ts` 里，这里只负责
// "什么时候该推"与"状态长什么样"。
import { DEFAULT_INITIATIVE, advance, clampTurn, rollInitiative } from '../rules/combat.js';
import { MAX_COMBATANTS, MAX_COMBAT_ROUNDS, MAX_NAME_CHARS, clampInt, text } from './limits.js';
import type { InitiativeOrder } from '../rules/combat.js';
import type { DiceRng } from '../rules/dice.js';
import type { TrpgCampaign, TrpgCharacter, TrpgCombat } from '../types.js';

/**
 * 按名字找一张卡。
 *
 * ⚠️ **刻意不 import `model/campaign.ts` 的 `findCharacter`**：那个文件要 import 本文件的
 * `normalizeCombat`（`normalizeCampaign` 里那一行），反向再 import 回去就成环了。
 * 同 `media/jmcomic/runtime.ts` "为断环单开一层"那条 —— 三行的查询比一个环便宜。
 */
function findByName(campaign: TrpgCampaign, name: string): TrpgCharacter | null {
  return campaign.characters.find((item) => item.name === name) ?? null;
}

/**
 * 读卡上的先攻属性。**只认精确匹配**。
 *
 * 不做大小写归一、更不做模糊匹配：那会变成第二份判据，而它掩盖的恰恰是这里最该说出来的
 * 事实 —— "这张卡上没有 `DEX`"。`missing` 就是为它存在的；归一把它抹掉之后，DM 只会看到
 * 一群人先攻全是 0，而没有任何线索指向"你把属性名写成了 `dex`"。
 */
function readInitiative(card: TrpgCharacter, key: string): number | null {
  const value = card.stats[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * 这个人还动得了吗。
 *
 * ⚠️ **HP 上限为 0 的卡不算"倒下"**：`character` 的 `hpMax` 那一栏明写着"没有 HP 概念的规则
 * 就给 0"，而那种卡上 `hp` 恒为 0。把它读成"倒下了"会让那套规则下的**整张顺序表当场全灭**
 * （`startCombat` 一个人都排不出来，`immobileNames` 把所有人算成动不了）——
 * 而症状只是"这个群打不起来"，没有任何线索指向 HP。
 */
function isMobile(card: TrpgCharacter): boolean {
  return card.hpMax <= 0 || card.hp > 0;
}

/**
 * 归一化一场战斗。读不到东西一律给 `null`（= 没在打）。
 *
 * **顺序为空就是 `null`，不是"一场空的战斗"** —— 后者是一个没人能产生的状态，
 * 而它会在渲染与推进两边各长出一条分支（"有战斗但没人"要印什么？推进到哪？）。
 * 与 `TrpgStore.read` 对"读不到返回 `null` 而不是空对象"是同一条判据。
 */
export function normalizeCombat(raw: unknown): TrpgCombat | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;
  const seen = new Set<string>();
  const order: string[] = [];
  for (const item of Array.isArray(source.order) ? source.order : []) {
    const name = text(item, MAX_NAME_CHARS);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    order.push(name);
    if (order.length >= MAX_COMBATANTS) break;
  }
  if (!order.length) return null;
  const missing: string[] = [];
  for (const item of Array.isArray(source.missing) ? source.missing : []) {
    const name = text(item, MAX_NAME_CHARS);
    // 只留**真在顺序里**的名字：手改过的存档可能留着一个已经退场的人，
    // 而渲染会把 `missing` 念出来 —— 念一个不在场的人名是一次凭空泄漏。
    if (name && seen.has(name) && !missing.includes(name)) missing.push(name);
  }
  return {
    key: text(source.key, MAX_NAME_CHARS) || DEFAULT_INITIATIVE,
    order,
    turn: clampTurn(source.turn, order.length),
    round: clampInt(source.round, 1, MAX_COMBAT_ROUNDS, 1),
    missing
  };
}

/** 此刻轮到谁。没有战斗 / 顺序为空时给空串。 */
export function currentActor(combat: TrpgCombat | null): string {
  if (!combat || !combat.order.length) return '';
  return combat.order[clampTurn(combat.turn, combat.order.length)] ?? '';
}

/**
 * 顺序里**已经动不了**的人：卡被删了，或者 HP 掉到 0 了。
 *
 * 判据是"顺序里的人现在什么样"而不是"顺序里记着什么" —— 战斗状态里只有名字，
 * 状态一律回人物卡上现读（`types.ts` 的 `TrpgCombat` 那段注释）。所以 DM 刚把一个人打趴，
 * 下一次推进就会自动跳过它，**不需要任何一处额外记账**。
 */
export function immobileNames(campaign: TrpgCampaign, combat: TrpgCombat | null): Set<string> {
  const gone = new Set<string>();
  if (!combat) return gone;
  for (const name of combat.order) {
    const card = findByName(campaign, name);
    if (!card || !isMobile(card)) gone.add(name);
  }
  return gone;
}

/**
 * 指针往前推一格（跳过动不了的人）。返回"有没有动"。
 *
 * 唯一会返回 `false` 的情形是**没有战斗**：只要顺序非空，`advance` 至少会绕一圈、
 * `round` 因此必然变化。所以那个布尔值不是"推成功了没有"，而是"本来有没有得推"。
 */
export function advanceCombat(campaign: TrpgCampaign): boolean {
  const combat = campaign.combat;
  if (!combat) return false;
  const next = advance(
    combat.order,
    { turn: combat.turn, round: combat.round },
    immobileNames(campaign, combat)
  );
  const moved = next.turn !== combat.turn || next.round !== combat.round;
  combat.turn = next.turn;
  combat.round = next.round;
  return moved;
}

/**
 * **一次工具调用收尾时**，按"谁动了"推进指针。返回"有没有推"。
 *
 * 判据是**按名字匹配**（`actors` 里有当前行动者）而**不是"这一轮有人做过事"**：
 * 后者会在极常见的"玩家掷一次骰、DM 接着给敌人记伤害"里**连推两格** ——
 * 那两件事属于同一个人的同一个回合。名字匹配只在"轮到的那个人真的动了"时才推。
 *
 * ⚠️ **指针停在动不了的人身上时无条件推进**：那是"倒下的人不占回合"这条规则的另一半 ——
 * `rules/combat.ts` 的 `advance` 会跳过他们，但**没人替它决定什么时候跳**。少了这一条，
 * 指针会一直停在尸体上，直到谁想起来敲一次 `.combat next`。
 */
export function advanceAfterActions(campaign: TrpgCampaign, actors: readonly string[]): boolean {
  const combat = campaign.combat;
  if (!combat) return false;
  const current = currentActor(combat);
  if (!current) return false;
  if (!immobileNames(campaign, combat).has(current) && !actors.includes(current)) return false;
  return advanceCombat(campaign);
}

/** 收场：把战斗从存档里摘掉。返回"本来有没有在打"（收场回执要按它分两种说法）。 */
export function endCombat(campaign: TrpgCampaign): boolean {
  if (!campaign.combat) return false;
  campaign.combat = null;
  return true;
}

/**
 * 开打：按规则表声明的属性排先攻，落进 `campaign.combat`。
 *
 * **参战者是"玩家已经见过、还站着的"那些卡**（`discovered && isMobile`），上限
 * `MAX_COMBATANTS`。三条理由：
 *   • 顺序是**公开的**（要发进群、进玩家笔记），所以幕后 NPC 不能进去 —— 那是泄漏；
 *   • 已经倒下的人不该占一个回合位（同 `advance` 的 `skip`，这里干脆不排）；
 *   • **不做"参战名单"参数**（有意的范围收缩）：DM 用 `character` 的 `visible` 就能决定
 *     谁在场上，再加一个名单参数就是同一件事的第二份判据。
 *
 * **再 `start` 一次 = 重排**（不拒绝）：那是中途加人的唯一办法（有人来晚了、有人被 NPC 拉进
 * 战斗）。拒绝会让 DM 卡住。回执必须把这件事说出来，否则 DM 会以为自己的第二次调用没生效。
 *
 * 返回掷出来的那份顺序（含 `scores`，回执要用），**调用方从 `campaign.combat` 读指针**。
 * 一个人都排不出来时返回 `null`，并把 `combat` 清成 `null` —— 一次失败的开打不该留着
 * 上一场的指针。
 */
export function startCombat(
  campaign: TrpgCampaign,
  options: { key: string; rng: DiceRng }
): InitiativeOrder | null {
  const combatants = campaign.characters
    .filter((card) => card.discovered && isMobile(card))
    .slice(0, MAX_COMBATANTS)
    .map((card) => ({ name: card.name, initiative: readInitiative(card, options.key), hp: card.hp }));
  const rolled = rollInitiative(combatants, options.rng);
  if (!rolled.order.length) {
    campaign.combat = null;
    return null;
  }
  campaign.combat = {
    key: options.key,
    order: rolled.order,
    turn: 0,
    round: 1,
    missing: rolled.missing
  };
  return rolled;
}
