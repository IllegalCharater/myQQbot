// 跑团状态的**展示层**：把状态渲染成给人/给模型看的文本。
//
// 两个消费者、两份输出，**别合并**：
//   • `renderForModel(campaign)` —— 拼进 system prompt 的 body（模型读它来知道"现在是什么局面"）；
//   • `renderStatusCard(campaign)` —— `/跑团` 命令的回执（群友读它，所以不要任何给模型的指令）。
//
// ── 为什么这份渲染是"易变段"，必须排在 body 末尾 ──
//
// `prompt(chatKey)` 返回的 body 会被拼在框架契约两段之后。跑团的**人格**是稳定的（写在
// `extra/prompts.ts`），而**状态**每轮都在变（日志一条条涨）。所以调用方把人格放前面、状态放后面
// —— 于是同一场团连着跑几轮时，system prompt 的公共前缀能命中到状态段之前，只有尾巴作废。
// 反过来（状态在前）会让每一轮的**整段**系统提示都失效。这条与 user prompt 的"稳定度降序"
// 是同一条纪律。
import {
  MAX_LOG_RENDER, MAX_NOTES, MAX_STATS_PER_CHARACTER
} from './state.js';
import type { CheckResult } from './rules/check.js';
import type { DiceRoll } from './rules/dice.js';
import type { TrpgCampaign, TrpgCharacter } from './types.js';

/**
 * 整段渲染的字符预算。
 *
 * 上限（`state.ts`）已经逐项夹过了，但**逐项合规不等于总和合规**：30 张卡 × 30 个属性、
 * 14 条 × 600 字的日志，加起来能到八千多字，而这份文本每轮都要进 system prompt。
 * 所以这里还有一道总闸门，超了就**从最老的日志开始丢**（最近发生的事对模型最有价值）。
 */
const MAX_RENDER_CHARS = 6000;

/** 状态段的标题行。给模型的那份用它分段，改它等于改提示词形状。 */
const MODEL_HEADING = '【当前跑团状态】';

function characterLine(card: TrpgCharacter): string {
  const pools: string[] = [];
  // HP / SAN 只在"这个概念真的存在"时才印：sanMax 为 0 表示这张卡没有理智值
  // （通用骰子那条路上很多系统没有 SAN），印一个 `SAN 0/0` 只会让模型困惑。
  if (card.hpMax > 0) pools.push(`HP ${card.hp}/${card.hpMax}`);
  if (card.sanMax > 0) pools.push(`SAN ${card.san}/${card.sanMax}`);
  const stats = Object.entries(card.stats).slice(0, MAX_STATS_PER_CHARACTER)
    .map(([key, value]) => `${key} ${value}`);
  const who = card.ownerId ? `玩家 ${card.ownerId}` : 'NPC';
  const notes = card.notes.slice(0, MAX_NOTES);
  return [
    `· ${card.name}（${who}）`,
    pools.join(' ｜ '),
    stats.length ? stats.join('、') : '',
    notes.length ? `备注：${notes.join('；')}` : ''
  ].filter(Boolean).join(' ｜ ');
}

/** 单条日志的渲染。序号要印出来 —— 模型与群友都靠它指代"第几条"。 */
function logLine(entry: TrpgCampaign['log'][number]): string {
  return `#${entry.seq} [${entry.kind}] ${entry.text}`;
}

/**
 * 给**模型**看的完整状态（拼进 system prompt）。
 *
 * 没有战役时返回一段"还没有开局"的提示 —— 那是**唯一**在这里出现的指令性文字，因为它天生是
 * 条件性的（其余"你该怎么当 DM"的规则全在 `extra/prompts.ts` 的稳定段里）。
 */
export function renderForModel(campaign: TrpgCampaign | null): string {
  if (!campaign) {
    return `${MODEL_HEADING}\n这个会话还没有开局。先跟群友确认要跑什么，再用 campaign_start 建立这场团，`
      + `然后用 character_create 把玩家和主要 NPC 的卡建起来。在那之前不要凭空宣布任何状态。`;
  }

  const head = [
    MODEL_HEADING,
    `战役：${campaign.title}${campaign.system ? `（规则：${campaign.system}）` : ''}`,
    `场景：${campaign.scene || '（还没定）'}`
  ];
  const tail: string[] = [];

  if (campaign.characters.length) {
    tail.push('—— 角色 ——', ...campaign.characters.map(characterLine));
  } else {
    tail.push('—— 角色 ——', '（还没有建立任何人物卡）');
  }

  const flags = Object.entries(campaign.flags);
  tail.push('—— 剧情旗标 ——', ...(flags.length
    ? flags.map(([key, value]) => `· ${key} = ${value}`)
    : ['（暂无）']));

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

/**
 * 给**群友**看的状态卡（`/跑团` 的回执）。
 *
 * 与上面那一份的差别不只是长短：这里**不该出现任何给模型的话**（"用 campaign_start"之类），
 * 因为读它的是人。这条命令是零 LLM 成本的快路径，回执就是它的全部价值。
 */
export function renderStatusCard(campaign: TrpgCampaign | null): string {
  if (!campaign) {
    return '这个群还没有开团。\n先在群里敲 `/能力 加载 trpg` 进入跑团模式，然后让 DM 开局。';
  }
  const lines = [`《${campaign.title}》${campaign.system ? `（${campaign.system}）` : ''}`];
  if (campaign.scene) lines.push(`场景：${campaign.scene}`);
  lines.push('');
  if (campaign.characters.length) {
    lines.push(...campaign.characters.map(characterLine));
  } else {
    lines.push('（还没有人物卡）');
  }
  const flags = Object.entries(campaign.flags);
  if (flags.length) {
    lines.push('', ...flags.map(([key, value]) => `· ${key} = ${value}`));
  }
  const recent = campaign.log.slice(-3);
  if (recent.length) lines.push('', '最近：', ...recent.map(logLine));
  return lines.join('\n').slice(0, 2000);
}

// ── 掷骰 / 检定结果的展示 ────────────────────────────────────────────────────
//
// 这两份文本是**模型唯一能看到的骰子真相**（`roll_dice` / `skill_check` 的工具结果），
// 也是 `/掷骰` 命令发给群友的那句话。所以两条纪律：
//   ① **每一颗骰子都印出来** —— "4d6kh3 → 14" 是不可复核的，玩家会问"我掷了哪四颗"；
//   ② 判据是**字段在不在**，不是值是否为零（同 `image-source/result-formatter.ts` 的规矩）：
//      `modifier === 0` 照样不印 `+0`，而 `kh` 真的丢了骰子才印"丢掉哪几颗"。

/** `4d6kh3 → 6+3+5 = 14（掷出 1,6,3,5，丢掉 1 颗；骰子和 14）`。 */
export function formatRoll(roll: DiceRoll): string {
  const keptSum = roll.kept.reduce((total, value) => total + value, 0);
  const mod = roll.modifier ? ` ${roll.modifier > 0 ? '+' : '-'}${Math.abs(roll.modifier)}` : '';
  let line = `${roll.expr} → ${roll.kept.join('+')}${mod} = ${roll.total}`;
  // 被丢弃的骰子要说出来，否则 `4d6kh3` 与 `3d6` 在结果上分不出来。
  if (roll.dropped > 0) {
    line += `（掷出 ${roll.dice.join(',')}，丢掉 ${roll.dropped} 颗；骰子和 ${keptSum}）`;
  }
  return line;
}

/** `1d100 对 50 → 30（成功，差 20）；骰面 30`。 */
export function formatCheck(result: CheckResult): string {
  const grade = GRADE_LABEL[result.grade] ?? result.grade;
  const gap = result.margin === 0 ? '正好' : (result.margin > 0 ? `超出 ${result.margin}` : `差 ${-result.margin}`);
  return `${formatRoll(result.roll)} ｜ 对 ${result.target} → ${result.success ? '成功' : '失败'}（${grade}，${gap}）`;
}

/** 已知档位的中文名。**认不出来就原样印**（`CheckJudge` 可以返回自己的档位字符串）。 */
const GRADE_LABEL: Record<string, string> = {
  critical: '大成功',
  success: '普通成功',
  failure: '失败',
  fumble: '大失败'
};
