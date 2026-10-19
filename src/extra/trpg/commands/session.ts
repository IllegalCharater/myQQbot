// `.trpg <子命令>` —— 会话这一族（`impl.ts` 拆出 2026-10-16；P1 起命令面带 `.`；P2 加状态机）。
//
// ── 一条命令只做一件事 ──
//
//   `.trpg new <名字> [规则表]`  建会话（`status: preparing`，发起人自动加入）
//   `.trpg join`                 报名（QQ 号进 `players`）
//   `.trpg status`               看局势（`preparing` 时直接给向导）
//   `.trpg start`                全员确认后 `preparing → active`
//   `.trpg end`                  收团：回摘要 + 清掉这一局的存档
//   `.trpg mode` / `.trpg scenario` / `.trpg check`  形态、剧本与核对（见各自文件）
//
// ⚠️ **`.trpg start` 不再负责建局**（P2 改）：建局是 `.trpg new`，`start` 只把
// `preparing` 推成 `active`。模型那条 `campaign action=start` 仍然是"建局即开跑"（`active`）——
// 两个入口共用 `beginCampaign`，差别只有 `status` 那一个参数（见 `model/session.ts`）。
import { MODE_LABEL } from '../model/mode.js';
import { mirrorLog } from '../model/campaign.js';
import { beginCampaign, canActivate, activate, canJoin, join, endCampaign } from '../model/session.js';
import { renderScenarioList, renderStatusCard, renderWizard } from '../render/status.js';
import { argsOf, scenarioIds } from './shared.js';
import type { CommandHandler } from './shared.js';
import type { JournalPort } from '../model/campaign.js';
import type { TrpgModeStore } from '../store/mode-store.js';
import type { RuleStore } from '../store/rule-store.js';
import type { ScenarioStore } from '../store/scenario-store.js';
import type { TrpgStore } from '../store/campaign-store.js';

/**
 * 裸 `.trpg` 的回执。**群友可见文案**，不属于提示词目录（同 `ROLL_USAGE`）。
 *
 * 它同时是"这一族命令有哪些"的**唯一**清单位置 —— 向导（`renderWizard`）只讲开一局的
 * 三步，而这里是给"敲错了/想看全部"的人看的。
 */
const COMMAND_USAGE = '这几条各自是一条命令：\n'
  + '· `.trpg new <名字> [规则表]` —— 起一局（发起人自动加入）\n'
  + '· `.trpg join` —— 报名\n'
  + '· `.trpg status` —— 看当前局势（还没开局会给向导）\n'
  + '· `.trpg start` —— 全员建卡并确认之后开跑\n'
  + '· `.trpg end` —— 收团（回一份摘要，这一局的存档清掉）\n'
  + '· `.trpg mode [助手|DM]` —— 看 / 切换我当骰子助手还是当主持人\n'
  + '· `.trpg scenario [名字]` —— 引用一份剧本文件收进库\n'
  + '· `.trpg check <剧本名>` —— 看这份剧本抽出了什么、有哪些待核项\n'
  + '· `.pc new <角色名>` —— 建人物卡（另外还有 `.pc roll` / `.pc confirm` / `.pc show` / `.pc save`）\n'
  + '· `.combat start` —— 排一次先攻并公布（另外还有 `.combat next` / `.combat end`）\n'
  + '· `.log export` —— 把这一局的战报导成一份 .md 发进群\n'
  + '· `.ra <技能>` —— 自己检定（群里出结果）\n'
  + '· `.rh <技能>` —— 暗骰（只有你自己看得到）\n'
  + '· `.st <技能> <值>` —— 确认之前改自己的技能\n'
  + '· `.r 3d6` —— 自己掷一次';

export interface SessionCommandDeps {
  store: TrpgStore;
  rules: RuleStore;
  scenarios: ScenarioStore;
  modes: TrpgModeStore;
  journal?: JournalPort | null;
  /** 这条命令的词（`'.trpg status'` 这样）—— 由 `commands/index.ts` 递进来，见 `argsOf`。 */
  command: string;
}

/** `.trpg status` */
export function createStatusCommand({ store, scenarios, modes, command }: SessionCommandDeps): CommandHandler {
  return async (input) => {
    const mode = modes.read(input.chatKey);
    // 带参数 = 敲错了。**不静默忽略**：说清这几条各自是独立命令。
    if (argsOf(input, command).length) return COMMAND_USAGE;
    if (mode === 'assistant') {
      return `当前是${MODE_LABEL.assistant}：发一个骰子表达式（3d6、d20、2d6+3、4d6kh3…）我就掷。\n`
        + '要变成跑团（我当主持人）：`.trpg mode DM`。';
    }
    const campaign = store.read(input.chatKey);
    if (campaign) return renderStatusCard(campaign);
    // 还没开局：`preparing` 与否在这里都还没战役可看，所以给向导（它按开一局的顺序说下一步）。
    return renderWizard({ modeLabel: MODE_LABEL[mode], scenarios: scenarioIds(scenarios) });
  };
}

/** `.trpg new <名字> [规则表]` —— 起一局，停在 **`preparing`**（等人报名/建卡/确认）。 */
export function createNewCommand(deps: SessionCommandDeps): CommandHandler {
  const { store, rules, scenarios, journal, command } = deps;
  return async (input) => {
    const [title, rule] = argsOf(input, command);
    if (!title) {
      // 不带名字 = **选剧本**这一步：把库里有的列出来（清单里那两句正好也说了怎么传一份），
      // 再给出用法。只回一句"用法"的话群友还得自己回去翻有什么剧本。
      return '用法：`.trpg new <这一局的名字> [规则表 id]`\n'
        + '（想用剧本就先 `.trpg scenario` 把它收进库，再在名字后面写上剧本名）\n\n'
        + renderScenarioList(scenarioIds(scenarios));
    }
    // 名字对得上就用那份剧本，对不上就当**标题**开一局（剧本是可选的）。两种情况都交给
    // 同一个 `beginCampaign` 去拒（已经开过局等）—— 这里没有第二份判据。
    const useScenario = scenarios.read(title).ok;
    const args = useScenario ? { scenario: title, rule } : { title, rule };
    const result = beginCampaign(input.chatKey, args, { store, rules, scenarios, journal },
      { status: 'preparing', initiator: String(input.senderId ?? '') });
    if (result.isError) return String(result.content);
    return String(result.content)
      + (useScenario ? '' : `\n（剧本库里没有「${title}」，这一局没有注入剧本 —— 想用剧本就先传一份）`);
  };
}

/** `.trpg join` —— 报名。 */
export function createJoinCommand({ store, command }: SessionCommandDeps): CommandHandler {
  return async (input) => {
    const campaign = store.read(input.chatKey);
    if (!campaign) return '这个会话还没有开局 —— 先让谁来敲 `.trpg new <名字>` 起一局。';
    if (argsOf(input, command).length) return '用法：`.trpg join`（不带参数，报的就是敲这条命令的人）';
    const verdict = canJoin(campaign, input.senderId);
    if (!verdict.ok) return verdict.reason;
    join(campaign, input.senderId);
    store.write(campaign);
    const late = campaign.status === 'active'
      ? '\n（这一局已经在跑了 —— 让主持人给你补一张卡，用 `character` 的 action=create）' : '';
    return `已加入《${campaign.title}》（现在 ${campaign.players.length} 人）。`
      + `\n接下来敲 \`.pc new <角色名>\` 建一张卡。${late}`;
  };
}

/**
 * `.trpg start` —— 全员建卡并确认之后开跑。
 *
 * 判据全在 `canActivate` 里（`model/session.ts`），它拒绝时会**逐人**说清谁还没好、
 * 下一步敲什么 —— 只说一句"还有人没确认"等于让群友互相猜。
 */
export function createStartCommand({ store, journal, command }: SessionCommandDeps): CommandHandler {
  return async (input) => {
    const campaign = store.read(input.chatKey);
    if (!campaign) return '这个会话还没有开局 —— 先让谁来敲 `.trpg new <名字>` 起一局。';
    if (argsOf(input, command).length) return '用法：`.trpg start`（不带参数）';
    const verdict = canActivate(campaign);
    if (!verdict.ok) return verdict.reason;
    // `activate` 顺手落一条"开跑"日志（见那边），所以这一处也要镜像战报 ——
    // 与其余命令逐字同形：**改了状态就写盘，写盘之后镜像**。
    const beforeSeq = campaign.seq;
    activate(campaign);
    store.write(campaign);
    mirrorLog(campaign, beforeSeq, journal ?? null);
    return `《${campaign.title}》开跑！${campaign.players.length} 位玩家，`
      + `${campaign.characters.length} 张人物卡。\n接下来直接说话就行 —— 比如描述你的第一个行动，`
      + '或者问问大家想做什么。';
  };
}

/** `.trpg end` —— 收团摘要 + 清掉这一局的存档。 */
export function createEndCommand({ store, command }: SessionCommandDeps): CommandHandler {
  return async (input) => {
    if (argsOf(input, command).length) return '用法：`.trpg end`（不带参数，会清掉这一局的存档）';
    return endCampaign(input.chatKey, store);
  };
}

/** 裸 `.trpg`（**排在所有子命令之后**，只在它们都没匹配上时命中）。 */
export function createUsageCommand(): CommandHandler {
  return async () => COMMAND_USAGE;
}
