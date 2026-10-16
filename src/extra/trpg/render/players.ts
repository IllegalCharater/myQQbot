// **给群友看的那一份**（从 `render.ts` 拆出，2026-10-16）。
//
// 与 `render/model.ts` 是**两份独立实现**，不是一个函数加开关 —— 理由写在那边。
// 这里的原则是：**隐藏的东西根本不出现**（不是印成 `???` —— 一条全是问号的旗标本身就是一次泄漏，
// 它告诉玩家"这里有事"）。这条与 TRPG-AI-DM 的 `to_player_journal` 一致：它也是直接 `continue`。
//
// 导出 `playerSections` 与 `logLine` 是给 `render/model.ts` 复用的：模型那份要印一段
// **「玩家已经知道的」**（它得知道玩家此刻的认知边界），用的就是同一份投影。
import { MAX_NOTES, MAX_PLAYERS, MAX_STATS_PER_CHARACTER } from '../model/limits.js';
import { currentActor, immobileNames } from '../model/combat.js';
import { formatInitiative } from './format.js';
import { playerOf } from '../model/session.js';
import type { TrpgCampaign, TrpgCharacter } from '../types.js';

/** 玩家那份的标题行。与模型那份分开：两边受众不同，形状也可以各自演进。 */
const PLAYER_HEADING = '【跑团笔记】';
/** `.pc show`（不带名字）那份的标题行 —— 它讲的是「你」，与全群那份不同。 */
const MINE_HEADING = '【我的跑团卡】';

/** 单条日志的渲染。序号要印出来 —— 模型与群友都靠它指代"第几条"。 */
export function logLine(entry: TrpgCampaign['log'][number]): string {
  return `#${entry.seq} [${entry.kind}] ${entry.text}`;
}

/**
 * 一张卡的一行摘要（玩家版）。隐藏字段印 `???`，没发现的人**整张不出现**（在上层筛掉）。
 *
 * **导出**是给 `.pc show <名字>` 用的：那一条要的是「这一张卡长什么样」，
 * 与全群那份必须逐字同形（否则同一个人在两个地方显示得不一样）。
 */
export function renderCharacterForPlayers(card: TrpgCharacter): string {
  const hidden = new Set(card.hidden);
  const pools: string[] = [];
  if (card.hpMax > 0) pools.push(hidden.has('pools') ? 'HP ???' : `HP ${card.hp}/${card.hpMax}`);
  if (card.sanMax > 0) pools.push(hidden.has('pools') ? 'SAN ???' : `SAN ${card.san}/${card.sanMax}`);
  // MP 跟着 `pools` 一起藏（它就是同一类东西：一条会被消耗的资源条）。
  if (card.mpMax > 0) pools.push(hidden.has('pools') ? 'MP ???' : `MP ${card.mp}/${card.mpMax}`);
  const who = card.ownerId ? `玩家 ${card.ownerId}` : 'NPC';
  // 派生值（DB / Build / MOV）**跟着 `stats` 一起藏**：它们是"属性那一类"的派生物，而在
  // COC 里 DB 直接决定这个人打得疼不疼 —— 藏属性却露 DB 等于没藏。
  const stats = hidden.has('stats')
    ? '属性/技能 ???'
    : [
      ...Object.entries(card.stats).slice(0, MAX_STATS_PER_CHARACTER).map(([key, value]) => `${key} ${value}`),
      ...(card.db ? [`DB ${card.db}`, card.build ? `Build ${card.build}` : '', card.mov ? `MOV ${card.mov}` : ''] : [])
    ].filter(Boolean).join('、');
  const notes = hidden.has('notes') ? '' : card.notes.slice(0, MAX_NOTES).join('；');
  return [
    `· ${card.name}（${who}）`,
    pools.join(' ｜ '),
    stats,
    notes ? `备注：${notes}` : ''
  ].filter(Boolean).join(' ｜ ');
}

/**
 * 玩家视角的那几段（不含标题与日志）。
 *
 * **隐藏的东西在这里根本不出现**，不是印成 `???` —— 一条全是问号的旗标只会让笔记变成噪音，
 * 而它的存在本身就是一次泄漏（"这里有事"）。这条与 TRPG-AI-DM 的 `to_player_journal`
 * 一致：它也是直接 `continue`，不是投影成占位符（占位符只出现在它别的视图里）。
 */
export function playerSections(campaign: TrpgCampaign): string[] {
  const lines: string[] = [];
  const seen = campaign.characters.filter((card) => card.discovered);
  if (seen.length) lines.push(...seen.map(renderCharacterForPlayers));
  else if (campaign.characters.length) lines.push('（还没有见过任何人）');
  else lines.push('（还没有人物卡）');

  const flags = Object.entries(campaign.flags).filter(([, flag]) => flag.visible && flag.value);
  if (flags.length) lines.push(...flags.map(([key, flag]) => `· ${key} = ${flag.value}`));
  return lines;
}

/**
 * 战斗那一段（P5）。没有战斗、或者**参战者全都还没被玩家见过**时返回空数组（这一段整个不出现）。
 *
 * ⚠️ **两条过滤，缺一都是泄漏**：
 *   ① **顺序按 `discovered` 过滤** —— 先攻序是公开的，但"这个人存在"仍然可以是秘密
 *      （`startCombat` 排的时候已经滤过一遍，而 DM 事后完全可能把某人改回隐藏）；
 *   ② **轮到谁那句要跟着一起滤** —— 当前行动者若不在过滤后的名单里，那一句就不出现。
 *      只滤名单、照印"轮到「X」"的话，等于用一个名字把刚藏起来的人说出来了，
 *      而且**没有任何报错**（那正是 `render/model.ts` 与这里必须是两份实现的原因）。
 *
 * 不印先攻数值：那个数就是卡上的属性，而 `hidden: ['stats']` 存在的理由正是藏属性
 * （同 `commands/combat.ts` 那段）。
 *
 * `alsoVisible` 是给 `renderForPlayer` 用的：**你自己的卡无条件可见**（那条规则见那个函数），
 * 所以轮到你自己时不该因为卡上标着"玩家尚未见过"而被这段过滤掉。
 */
export function combatLines(campaign: TrpgCampaign, alsoVisible?: ReadonlySet<string>): string[] {
  const combat = campaign.combat;
  if (!combat) return [];
  const seen = new Set(campaign.characters.filter((card) => card.discovered).map((card) => card.name));
  for (const name of alsoVisible ?? []) seen.add(name);
  const order = combat.order.filter((name) => seen.has(name));
  if (!order.length) return [];
  const lines = [`—— 战斗（第 ${combat.round} 轮）——`];
  const current = currentActor(combat);
  if (order.includes(current)) lines.push(`轮到「${current}」。`);
  lines.push(formatInitiative(order, { gone: immobileNames(campaign, combat) }));
  return lines;
}

/**
 * 玩家视角里**能出现**的日志类型。
 *
 * ⚠️ 这是一处**真实的泄漏**，不是洁癖：`state` / `scene` 那两类是 DM 的记账
 * （`新建人物卡：线人…`、`旗标：真凶是医生 = 是（暗线）`、`隐藏：pools/notes`），
 * 它们的正文里**混着隐藏卡与暗线的名字**。整段印给群友就等于把刚藏好的东西又说了一遍，
 * 而且**没有任何报错** —— 只有"把日志整段喂给玩家视角"这条断言能抓住它。
 *
 * 只放"群里本来就看得见的东西"：掷骰与检定（`/掷骰` 与工具掷出的点数本来就发在群里，
 * 玩家想回看自己掷了什么也是跑团里最常见的需求）。叙事（`narration`）不进这里 ——
 * 它等于群里的聊天记录，印一遍是重复。
 */
const PLAYER_LOG_KINDS = new Set(['roll', 'check']);

/**
 * 给**群友**看的跑团笔记。
 *
 * 与给模型那份的差别不只是长短与过滤：这里**不该出现任何给模型的话**（"用 campaign 的
 * action=start"之类），因为读它的是人。这条命令是零 LLM 成本的快路径，回执就是它的全部价值。
 */
export function renderForPlayers(campaign: TrpgCampaign | null): string {
  if (!campaign) {
    return '这个群还没有开团。\n先在群里敲 `/能力 加载 trpg` 进入跑团模式，然后让 DM 开局。';
  }
  const lines = [`${PLAYER_HEADING}《${campaign.title}》${campaign.system ? `（${campaign.system}）` : ''}`];
  // `preparing` 要显眼地说出来 —— 那是唯一一个"还开不了跑"的状态，而群友需要知道自己在等什么。
  if (campaign.status === 'preparing') {
    lines.push(`状态：**准备中**（${campaign.players.length}/${MAX_PLAYERS} 人已加入）`
      + '—— 都建卡并确认之后敲 `.trpg start` 开跑');
  }
  if (campaign.scene) lines.push(`场景：${campaign.scene}`);
  lines.push('', ...playerSections(campaign));
  const battle = combatLines(campaign);
  if (battle.length) lines.push('', ...battle);
  const recent = campaign.log.filter((entry) => PLAYER_LOG_KINDS.has(entry.kind)).slice(-3);
  if (recent.length) lines.push('', '最近的掷骰 / 检定：', ...recent.map(logLine));
  return lines.join('\n');
}

/**
 * **按人**渲染：这一位玩家自己看到的东西（`.pc show` 不带名字时就是它）。
 *
 * 与 `renderForPlayers`（全群视角）的差别只有一个：它把"你的卡"单独拎到最前面 ——
 * 那是玩家最常要看的一行，而在全群视角里它混在一堆人中间。
 *
 * ⚠️ **你自己的卡无条件显示**，不看 `discovered` —— "玩家还没见过这个人"是给 **NPC** 用的
 * 标记，而这张卡的 `ownerId` 就是你。但 `hidden` 字段对你**照样藏**：那是 DM 故意不让你
 * 知道的事（"你其实已经中毒了"），在这一层放行就等于把那份设计作废。
 */
export function renderForPlayer(campaign: TrpgCampaign, qq: unknown): string {
  const id = String(qq ?? '');
  const mine = playerOf(campaign, id);
  const lines = [`${MINE_HEADING}《${campaign.title}》${campaign.system ? `（${campaign.system}）` : ''}`];
  if (campaign.scene) lines.push(`场景：${campaign.scene}`);

  lines.push('', '—— 你的角色 ——');
  if (!mine) {
    lines.push(id ? '你还没有人物卡 —— 敲 `.pc new <角色名>` 建一张。' : '（拿不到你的 QQ 号，这条命令要在群里直接敲）');
  } else {
    lines.push(renderCharacterForPlayers(mine));
    if (!mine.confirmed) lines.push('（**还没确认** —— 敲 `.pc confirm`；全员确认之后 `.trpg start` 才开得了团）');
  }

  const others = campaign.characters.filter((card) => card !== mine && card.discovered);
  lines.push('', '—— 场上的人 ——', ...(others.length ? others.map(renderCharacterForPlayers) : ['（还没有别人）']));

  // 战斗那一段（`alsoVisible` 是你自己 —— 见 `combatLines`）。
  const battle = combatLines(campaign, new Set(mine ? [mine.name] : []));
  if (battle.length) lines.push('', ...battle);

  const flags = Object.entries(campaign.flags).filter(([, flag]) => flag.visible && flag.value);
  if (flags.length) lines.push('', '—— 你知道的事 ——', ...flags.map(([key, flag]) => `· ${key} = ${flag.value}`));
  return lines.join('\n');
}
