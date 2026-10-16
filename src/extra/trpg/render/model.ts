// **给模型看的那一份**跑团状态（从 `render.ts` 拆出，2026-10-16）。
//
// ── 为什么与"给玩家那份"是两份独立实现 ──
//
// 共用的写法（"一份 + 一个开关参数"）会让两边逐渐漂移，而漂移的表现是
// **"DM 以为藏住了、玩家其实看得见"** —— 没有任何报错。同型的先例是引用预览的
// `formatReplyPrefix` 与面板的 `replyPrefixHtml`（也是两份实现 + 断言钉同形）。
//
//   • `render/model.ts`（本文件）—— **全量**：隐藏信息照印，但逐项标注 `[暗线]` / `[对玩家隐藏: …]`，
//     让模型知道哪些不能直接说出口；
//   • `render/players.ts` —— 隐藏的东西在那里**根本不出现**。
//
// ── 为什么这份渲染是"易变段"，必须排在 body 末尾 ──
//
// `prompt(chatKey)` 返回的 body 会被拼在框架契约两段之后。跑团的**人格**是稳定的（写在
// `extra/prompts.ts`），而**状态**每轮都在变（日志一条条涨）。所以调用方把人格放前面、状态放后面
// —— 于是同一场团连着跑几轮时，system prompt 的公共前缀能命中到状态段之前，只有尾巴作废。
// 反过来（状态在前）会让每一轮的**整段**系统提示都失效。这条与 user prompt 的"稳定度降序"
// 是同一条纪律。
import { MAX_LOG_RENDER, MAX_NOTES, MAX_STATS_PER_CHARACTER } from '../model/limits.js';
import { logLine, playerSections } from './players.js';
import type { TrpgCampaign, TrpgCharacter } from '../types.js';

/**
 * 整段渲染的字符预算。
 *
 * 上限（`model/limits.ts`）已经逐项夹过了，但**逐项合规不等于总和合规**：30 张卡 × 30 个属性、
 * 14 条 × 600 字的日志，加起来能到八千多字，而这份文本每轮都要进 system prompt。
 * 所以这里还有一道总闸门，超了就**从最老的日志开始丢**（最近发生的事对模型最有价值）。
 */
const MAX_RENDER_CHARS = 6000;

/** 状态段的标题行。给模型的那份用它分段，改它等于改提示词形状。 */
const MODEL_HEADING = '【当前跑团状态】';

const HIDDEN_MARK = '[暗线]';

/**
 * 一张卡的一行摘要（DM 版）。
 *
 * 隐藏信息**照印**，但标出来 —— 模型是 DM，它必须知道"这个人其实是谁"，
 * 也必须在开口前知道"这件事玩家还不知道"。
 */
function modelCharacterLine(card: TrpgCharacter): string {
  const pools: string[] = [];
  // HP / SAN 只在"这个概念真的存在"时才印：sanMax 为 0 表示这张卡没有理智值
  // （通用骰子那条路上很多系统没有 SAN），印一个 `SAN 0/0` 只会让模型困惑。
  if (card.hpMax > 0) pools.push(`HP ${card.hp}/${card.hpMax}`);
  if (card.sanMax > 0) pools.push(`SAN ${card.san}/${card.sanMax}`);
  // MP 与 HP/SAN 同一条判据：`mpMax` 为 0 = 这套规则没有这个概念，不印。
  if (card.mpMax > 0) pools.push(`MP ${card.mp}/${card.mpMax}`);
  const stats = Object.entries(card.stats).slice(0, MAX_STATS_PER_CHARACTER)
    .map(([key, value]) => `${key} ${value}`);
  // 派生值（DB / Build / MOV，P4 起）。**判据用 `db` 这条字符串**：COC7 里 `Build 0` 是一个
  // 合法取值（STR+SIZ 落在 85–124），所以 `build === 0` 分不出"算出来是 0"与"没算过" ——
  // 而这三项来自同一次派生，`db === ''` 就精确等于"从没算过"。
  if (card.db) {
    const extras = [`DB ${card.db}`, card.build ? `Build ${card.build}` : '', card.mov ? `MOV ${card.mov}` : ''];
    stats.push(...extras.filter(Boolean));
  }
  const who = card.ownerId ? `玩家 ${card.ownerId}` : 'NPC';
  const notes = card.notes.slice(0, MAX_NOTES);
  // 隐藏字段计数（照 TRPG-AI-DM 的 `隐藏字段:N`）：一个数字，把"该谨慎说话"
  // 变成可读的量化信号，比让模型自己去读那张可见度表省事得多。
  const marks: string[] = [];
  if (!card.discovered) marks.push('[玩家尚未见过]');
  if (card.hidden.length) marks.push(`[对玩家隐藏: ${card.hidden.join('/')}]`);
  return [
    `· ${card.name}（${who}）`,
    pools.join(' ｜ '),
    stats.length ? stats.join('、') : '',
    notes.length ? `备注：${notes.join('；')}` : '',
    marks.length ? `⚠ ${marks.join('；')}` : ''
  ].filter(Boolean).join(' ｜ ');
}

/**
 * 给**模型**看的完整状态（拼进 system prompt）。
 *
 * 没有战役时返回一段"还没有开局"的提示 —— 那是**唯一**在这里出现的指令性文字，因为它天生是
 * 条件性的（其余"你该怎么当 DM"的规则全在 `extra/prompts.ts` 的稳定段里）。
 */
export function renderForModel(campaign: TrpgCampaign | null): string {
  if (!campaign) {
    return `${MODEL_HEADING}\n这个会话还没有开局。先跟群友确认要跑什么，再用 campaign 的 action=start `
      + `建立这场团，然后用 character 的 action=create 把玩家和主要 NPC 的卡建起来。在那之前不要凭空宣布任何状态。`;
  }

  const head = [
    MODEL_HEADING,
    `战役：${campaign.title}${campaign.system ? `（规则：${campaign.system}）` : ''}`,
    `检定规则表：${campaign.rule || 'generic'}`,
    `场景：${campaign.scene || '（还没定）'}`
  ];
  const tail: string[] = [];

  if (campaign.characters.length) {
    tail.push('—— 角色 ——', ...campaign.characters.map(modelCharacterLine));
  } else {
    tail.push('—— 角色 ——', '（还没有建立任何人物卡）');
  }

  const flags = Object.entries(campaign.flags);
  tail.push('—— 剧情旗标 ——', ...(flags.length
    ? flags.map(([key, flag]) => `· ${key} = ${flag.value || '（空）'}`
      + (flag.visible ? '' : ` ${HIDDEN_MARK}（玩家还不知道，但你必须持续推进它）`))
    : ['（暂无）']));

  tail.push('—— 玩家已经知道的（他们的笔记就是这些）——', ...playerSections(campaign));

  // 日志**从最新往回取**，取到装不下为止 —— 最近发生的事最值得给模型看。
  const budget = MAX_RENDER_CHARS - head.join('\n').length - tail.join('\n').length;
  const picked: string[] = [];
  let used = 0;
  for (let i = campaign.log.length - 1; i >= 0 && picked.length < MAX_LOG_RENDER; i--) {
    const line = logLine(campaign.log[i]);
    if (used + line.length > budget) break;
    used += line.length;
    picked.unshift(line);
  }
  const dropped = campaign.log.length - picked.length;
  if (dropped > 0) picked.unshift(`（更早的 ${dropped} 条已省略）`);
  tail.push('—— 最近发生（新在下）——', ...(picked.length ? picked : ['（还没有任何记录）']));

  return [...head, ...tail].join('\n');
}
