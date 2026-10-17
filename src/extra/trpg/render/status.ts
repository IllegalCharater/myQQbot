// **命令回执与清单**（从 `render.ts` 拆出，2026-10-16）。
//
// 这一层没有 I/O：清单由调用方（`commands/*`）现读目录后**递进来**。
// 它只负责"同一件事只有一份拼法" —— 剧本清单被三处共用（`.trpg scenario`、`.trpg new`、向导），
// 各写一遍的话，加一种状态（比如"有坏文件"）时必然漏掉其中一处。
//
// ⚠️ **这一层产出的字面量几乎全是群友可见的**（`renderBriefing` 那一段是唯一的例外，它只进
// system prompt），所以**不许出现 Markdown 的加粗记号 `**`** —— QQ 不认 Markdown，那些星号
// 会原样显示。`renderScenarioList` 被 `.trpg scenario`、`.trpg new` 与向导共用（三处都是群友可见），
// 所以它也守这条。
import { renderForPlayers } from './players.js';
import type { TrpgCampaign } from '../types.js';

/** `.trpg status` 的回执：玩家视角 + 长度上限（命令回执不该长到刷屏）。 */
export function renderStatusCard(campaign: TrpgCampaign | null): string {
  return renderForPlayers(campaign).slice(0, 2000);
}

/**
 * 中间段要用的清单。**由 `impl.ts` 现读目录拿到** —— 渲染层不做 I/O（它连 config 都不碰）。
 */
export interface BriefingCatalog {
  scenarios: readonly { id: string; title: string }[];
  rules: readonly { id: string; name: string; description: string }[];
}

/**
 * `prompt(chatKey)` 的**中间段**：可用清单 + 这一局的剧本正文。
 *
 * 它排在人格之后、状态之前 —— 顺序即缓存：清单只在管理员改文件时变、正文整局不变，
 * 而状态每轮都变。把这两个稳定的放前面，system prompt 的公共前缀才能命中到状态变化点之前。
 *
 * 段内也是同一个道理：**清单在前、正文在后**（清单对所有群都一样，正文只有这一局是）。
 *
 * ⚠️ **这一段永远非空**（规则清单至少有两个内置的）：`promptPlan()` 会滤掉空串，段数飘忽会让
 * "body 有几段"这件事没法断言。
 */
export function renderBriefing(campaign: TrpgCampaign | null, catalog: BriefingCatalog): string {
  const lines: string[] = ['【剧本与规则】'];

  lines.push('这一局能选的剧本（开局时用 scenario 指定它的名字）：'
    + (catalog.scenarios.length
      ? catalog.scenarios.map((item) => `${item.id}${item.title && item.title !== item.id ? `（${item.title}）` : ''}`).join('、')
      : '（还没有任何剧本 —— 让管理员往 data/trpg/scenarios/ 里放一份，或在群里用 `.trpg scenario` 存一份）'));
  lines.push('这一局能选的检定规则（开局时用 rule 指定它的 id）：'
    + catalog.rules.map((item) => `${item.id}${item.description ? `（${item.description}）` : ''}`).join('；'));

  const ref = campaign?.scenario;
  if (ref?.id) {
    lines.push('', `这一局的剧本是「${ref.id}」${ref.body ? '，正文如下：' : '（它没有正文，只有骨架）'}`);
    if (ref.body) lines.push(ref.body);
  } else {
    lines.push('', '这一局没有注入剧本 —— 设定与主线由你自己发挥（或者让群友先挑一份再开局）。');
  }

  return lines.join('\n');
}

/**
 * 剧本清单。`.trpg scenario`、`.trpg new`（不带名字那一次）与向导共用**这一份**拼法 ——
 * 三处各写一遍的话，加一种状态（比如"有坏文件"）时必然漏掉其中一处。
 */
export function renderScenarioList(scenarios: readonly string[]): string {
  if (!scenarios.length) {
    return '剧本库里还没有剧本。\n'
      + '把一份剧本（`.md` / `.txt` / `.docx` / `.pdf` 都行）发到群里，引用它敲 `.trpg scenario` 就收进来了。\n'
      + '不想要剧本也可以：直接 `.trpg new <随便是什么名字>` —— 那一局没有注入剧本，我自己发挥。';
  }
  return `剧本库里现在有：${scenarios.join('、')}\n`
    + '（要再加一份：把文件发到群里、引用它敲 `.trpg scenario`）';
}

/**
 * **未开局时的向导**：按开一局的顺序把下一步说清楚（P2 起是五步）。
 *
 * 为什么值得单独一份：`.trpg status` 在**已经开局**时给的是局势卡（玩的时候要看的就是它），
 * 而**还没开局**时给一张"（还没有人物卡）"的空卡等于什么都没说 —— 群里那位正需要知道
 * "接下来敲什么"。判据是"这个会话有没有战役"，确定性、不猜。
 */
export function renderWizard({ modeLabel, scenarios }: { modeLabel: string; scenarios: readonly string[] }): string {
  return [
    '【跑团】这个群还没开局。按这个顺序来：',
    '',
    `1. 定模式（当前：${modeLabel}）`,
    '   · `.trpg mode DM` —— 我当主持人：讲剧情、扮演 NPC、管人物卡与状态',
    '   · `.trpg mode 助手` —— 我只掷骰，别的什么都不做',
    '2. 传剧本（可选）：把剧本文件发到群里，引用它敲 `.trpg scenario`',
    '3. 起一局：`.trpg new <这一局的名字>`（或者写剧本名，就用那份剧本）',
    '4. 大家各自：`.trpg join` 报名 → `.pc new <角色名>` 建卡 → `.pc confirm` 确认',
    '5. 都确认了：`.trpg start` 开跑',
    '',
    renderScenarioList(scenarios)
  ].join('\n');
}

/** `.trpg scenario` 带了名字却没引用文件时的用法。 */
export const SCENARIO_USAGE = '用法：.trpg scenario [名字]\n'
  + '· 带名字：把引用的那个文件收进剧本库，用这个名字（`.md` / `.txt` / `.docx` / `.pdf` 都行）\n'
  + '· 不带名字：引用了文件就用文件名当名字；没引用就是列出剧本库';
