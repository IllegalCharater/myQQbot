// 跑团状态的**展示层**：把状态渲染成给人/给模型看的文本。
//
// ── 三份输出，**别合并** ──
//
//   • `renderForModel(campaign)`   —— 拼进 system prompt 的 body（模型读它来知道"现在是什么局面"）。
//     **全量**：隐藏信息照印，但逐项标注，让模型知道哪些不能直接说出口。
//   • `renderForPlayers(campaign)` —— 玩家视角。隐藏的东西在这里**根本不出现**。
//   • `renderStatusCard(campaign)` —— `/跑团` 的命令回执，就是 `renderForPlayers` 加一层长度上限。
//
// **为什么是两份独立的函数、而不是"一份 + 一个开关参数"**：共用的写法会让两边逐渐漂移，
// 而漂移的表现是"DM 以为藏住了、玩家其实看得见"—— 没有任何报错。本仓库对同型问题
// （引用预览的 `formatReplyPrefix` 与面板的 `replyPrefixHtml`）也是两份实现 + 断言钉同形。
//
// ── 为什么这份渲染是"易变段"，必须排在 body 末尾 ──
//
// `prompt(chatKey)` 返回的 body 会被拼在框架契约两段之后。跑团的**人格**是稳定的（写在
// `extra/prompts.ts`），而**状态**每轮都在变（日志一条条涨）。所以调用方把人格放前面、状态放后面
// —— 于是同一场团连着跑几轮时，system prompt 的公共前缀能命中到状态段之前，只有尾巴作废。
// 反过来（状态在前）会让每一轮的**整段**系统提示都失效。这条与 user prompt 的"稳定度降序"
// 是同一条纪律。
import { MAX_LOG_RENDER, MAX_NOTES, MAX_STATS_PER_CHARACTER } from './state.js';
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
/** 玩家那份的标题行。与上面那个分开：两边受众不同，形状也可以各自演进。 */
const PLAYER_HEADING = '【跑团笔记】';

const HIDDEN_MARK = '[暗线]';

// ── 给模型看的那一份 ─────────────────────────────────────────────────────────

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
  const stats = Object.entries(card.stats).slice(0, MAX_STATS_PER_CHARACTER)
    .map(([key, value]) => `${key} ${value}`);
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

// ── 给群友看的那一份 ─────────────────────────────────────────────────────────

/** 一张卡的一行摘要（玩家版）。隐藏字段印 `???`，没发现的人**整张不出现**（在上层筛掉）。 */
function playerCharacterLine(card: TrpgCharacter): string {
  const hidden = new Set(card.hidden);
  const pools: string[] = [];
  if (card.hpMax > 0) pools.push(hidden.has('pools') ? 'HP ???' : `HP ${card.hp}/${card.hpMax}`);
  if (card.sanMax > 0) pools.push(hidden.has('pools') ? 'SAN ???' : `SAN ${card.san}/${card.sanMax}`);
  const who = card.ownerId ? `玩家 ${card.ownerId}` : 'NPC';
  const stats = hidden.has('stats')
    ? '属性/技能 ???'
    : Object.entries(card.stats).slice(0, MAX_STATS_PER_CHARACTER).map(([key, value]) => `${key} ${value}`).join('、');
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
function playerSections(campaign: TrpgCampaign): string[] {
  const lines: string[] = [];
  const seen = campaign.characters.filter((card) => card.discovered);
  if (seen.length) lines.push(...seen.map(playerCharacterLine));
  else if (campaign.characters.length) lines.push('（还没有见过任何人）');
  else lines.push('（还没有人物卡）');

  const flags = Object.entries(campaign.flags).filter(([, flag]) => flag.visible && flag.value);
  if (flags.length) lines.push(...flags.map(([key, flag]) => `· ${key} = ${flag.value}`));
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
  if (campaign.scene) lines.push(`场景：${campaign.scene}`);
  lines.push('', ...playerSections(campaign));
  const recent = campaign.log.filter((entry) => PLAYER_LOG_KINDS.has(entry.kind)).slice(-3);
  if (recent.length) lines.push('', '最近的掷骰 / 检定：', ...recent.map(logLine));
  return lines.join('\n');
}

/** `/跑团` 的回执：玩家视角 + 长度上限（命令回执不该长到刷屏）。 */
export function renderStatusCard(campaign: TrpgCampaign | null): string {
  return renderForPlayers(campaign).slice(0, 2000);
}

/** 单条日志的渲染。序号要印出来 —— 模型与群友都靠它指代"第几条"。 */
function logLine(entry: TrpgCampaign['log'][number]): string {
  return `#${entry.seq} [${entry.kind}] ${entry.text}`;
}

// ── 掷骰 / 检定结果的展示 ────────────────────────────────────────────────────
//
// 这两份文本是**模型唯一能看到的骰子真相**（`roll` 工具的结果），也是 `/掷骰` 命令发给群友
// 的那句话。所以两条纪律：
//   ① **每一颗骰子都印出来** —— "4d6kh3 → 14" 是不可复核的，玩家会问"我掷了哪四颗"；
//   ② 判据是**字段在不在**，不是值是否为零（同 `image-source/result-formatter.ts` 的规矩）：
//      算式明细由求值器给出（`DiceRoll.detail`），被丢弃的骰子才印"丢掉哪几颗"。

/** `3d6 → 4+2+5 = 11`、`4d6kh3 → 6+3+5 = 14（掷出 1,6,3,5，丢掉 1 颗；骰子和 14）`。 */
export function formatRoll(roll: DiceRoll): string {
  const keptSum = roll.kept.reduce((total, value) => total + value, 0);
  // 没有骰子（纯数字表达式）时不印 `12 → 12 = 12` 那种废话。
  let line = roll.detail
    ? `${roll.expr} → ${roll.detail} = ${roll.total}`
    : `${roll.expr} = ${roll.total}`;
  // 被丢弃的骰子要说出来，否则 `4d6kh3` 与 `3d6` 在结果上分不出来。
  if (roll.dropped > 0) {
    line += `（掷出 ${roll.dice.join(',')}，丢掉 ${roll.dropped} 颗；骰子和 ${keptSum}）`;
  }
  return line;
}

/** `1d100 对 50 → 30 = 30 ｜ 成功（差 20）`。档位的中文名优先取规则表给的 `label`。 */
export function formatCheck(result: CheckResult): string {
  const grade = result.label ?? GRADE_LABEL[result.grade] ?? result.grade;
  const gap = result.margin === 0 ? '正好' : (result.margin > 0 ? `超出 ${result.margin}` : `差 ${-result.margin}`);
  return `${formatRoll(result.roll)} ｜ 对 ${result.target} → ${result.success ? '成功' : '失败'}（${grade}，${gap}）`;
}

/**
 * 已知档位的中文名。
 *
 * 这只是**兜底**：规则表的 `label` 才是权威（COC 那套的"极难成功/困难成功"不在下表里）。
 * 认不出来就原样印 `grade`（同 `image-source` 的"字段在不在"那条规矩 —— 不替规则书编名字）。
 */
const GRADE_LABEL: Record<string, string> = {
  critical: '大成功',
  success: '普通成功',
  failure: '失败',
  fumble: '大失败'
};
