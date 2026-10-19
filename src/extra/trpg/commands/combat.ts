// `.combat start|next|end` —— 战斗的先攻与回合推进（P5）。零 LLM 成本。
//
// 与 `campaign` 工具的 `action=combat` **共用 `model/combat.ts`**：两条路（人敲的 / 模型调的）
// 做的是同一件事，判据只有一份。差别只有两处，都是有意的：
//   • **措辞**：命令的回执写给群友看，工具的结果回给模型看；
//   • **先攻数值只给模型**（见下）。
//
// ⚠️ **回执里不印先攻数值**，只印名字顺序。先攻顺序是公开的（谁先动在桌上藏不住），
// 但那个**数**就是卡上的属性（规则表里的 `initiative`，缺省 `DEX`）—— 而 `character` 的
// `hidden: ['stats']` 机制存在的理由正是"藏属性"。把数值印进群等于**悄悄把藏起来的属性
// 说出去**，且没有任何报错。模型那一侧照常带数值（它本来就看得到全量状态），所以它叙事时心里有数。
import { appendLog, mirrorLog } from '../model/campaign.js';
import { advanceCombat, currentActor, endCombat, immobileNames, startCombat } from '../model/combat.js';
import { ruleSetFor } from '../model/rule-set.js';
import { formatInitiative, formatOrder } from '../render/format.js';
import type { CommandHandler } from './shared.js';
import type { JournalPort } from '../model/campaign.js';
import type { DiceRng } from '../rules/dice.js';
import type { RuleStore } from '../store/rule-store.js';
import type { TrpgStore } from '../store/campaign-store.js';
import type { TrpgCampaign } from '../types.js';

/** 裸 `.combat` 的回执。**群友可见文案**，不属于提示词目录（同 `ROLL_USAGE`）。
 *
 * ⚠️ 群友可见的文案里**不许出现 Markdown 的加粗记号 `**`**：QQ 不认 Markdown，那些星号会
 * 原样显示成排版垃圾。这一族里所有回执都守这条（`tests/t-trpg.mjs` 有一条端到端断言扫它）。
 */
const COMBAT_USAGE = '用法：\n'
  + '· `.combat start` —— 按先攻属性排一次顺序并公布（再排一次 = 重排，中途加人就用它）\n'
  + '· `.combat next` —— 轮到下一个人\n'
  + '· `.combat end` —— 这一场打完了';

export interface CombatCommandDeps {
  store: TrpgStore;
  rules: RuleStore;
  /** **必填**：规则层没有默认随机源（见 `rules/dice.ts` 的文件头）。排先攻要用它。 */
  rng: DiceRng;
  /** 战报（写侧）。缺省不记。 */
  journal?: JournalPort | null;
  /** 这条命令的词（`'.combat start'` 这样）—— 由 `commands/index.ts` 递进来，见 `argsOf`。 */
  command: string;
}

/**
 * 玩家**看得见的**参战者。
 *
 * ⚠️ **与 `render/players.ts` 的 `combatLines` 同一条判据**：先攻顺序是公开的，但"这个人
 * 存在"仍然可以是秘密。`startCombat` 建序时已经按 `discovered` 滤过一遍，可 DM **完全可以在
 * 开打之后**用 `character` 把某人改成 `visible: false` —— 那时这一族命令若不滤，就会把
 * 那个人名原样印进群，而玩家视角那份（`.trpg status`）会滤掉。**同一份状态，两个地方两个答案**，
 * 而它不会有任何报错（2026-10-19 勘察确认的真泄漏）。
 */
function visibleOrder(campaign: TrpgCampaign): string[] {
  const seen = new Set(
    campaign.characters.filter((card) => card.discovered).map((card) => card.name)
  );
  return (campaign.combat?.order ?? []).filter((name) => seen.has(name));
}

/** 顺序的紧凑写法（**群友可见**：标出倒下的，不印数值）。顺序为空时返回空串。 */
function orderLine(campaign: TrpgCampaign): string {
  const combat = campaign.combat;
  if (!combat) return '';
  const order = visibleOrder(campaign);
  return order.length ? `顺序：${formatOrder(order, immobileNames(campaign, combat))}` : '';
}

export function createCombatCommand(deps: CombatCommandDeps): CommandHandler {
  const { store, rules, rng, journal, command } = deps;

  return async (input) => {
    // ⚠️ **子命令从 `command` 里取，不从 `argsOf` 里取**：`argsOf` 切掉的是**整个命令词**
    // （`'.combat start'`），所以 `.combat start` 后面本来就一个参数词都没有 —— 按 `argsOf`
    // 读会把每一次调用都读成"认不出的子命令"，回一句用法清单（实测踩到：`.combat start`
    // 永远排不出先攻，而回执看着像"你敲错了"）。
    // 这与 `.trpg mode 助手` 那一族**形状不同**是有意的：那一条的参数在命令词**之后**
    // （`argsOf` 正好切出来），这一条的子命令**就在命令词里**。
    const sub = command.trim().split(/\s+/)[1]?.toLowerCase() ?? '';
    // 认不出的子命令落到**裸 `.combat`** 上（`spec.ts` 里它排在三条子命令之后，且词形边界
    // 要求子命令后面跟空白/结束，所以 `.combat 乱写` 命中的是裸那一条）。这条守卫因此够不着，
    // 留着只是不让"表里少写一行"变成静默排先攻。
    if (sub !== 'start' && sub !== 'next' && sub !== 'end') return COMBAT_USAGE;

    const campaign = store.read(input.chatKey);
    if (!campaign) return '这个会话还没有开局 —— 先让谁来敲 `.trpg new <名字>` 起一局。';
    const beforeSeq = campaign.seq;
    const flush = (): void => {
      store.write(campaign);
      mirrorLog(campaign, beforeSeq, journal ?? null);
    };

    if (sub === 'end') {
      if (!endCombat(campaign)) return '现在没有在进行中的战斗。';
      appendLog(campaign, 'state', '战斗结束');
      flush();
      return '战斗结束。';
    }

    if (sub === 'next') {
      if (!campaign.combat) return '现在没有在进行中的战斗 —— 先敲 `.combat start` 排一次先攻。';
      advanceCombat(campaign);
      flush();
      // ⚠️ 当前行动者**没被玩家见过**时，"轮到「X」"整句不出现 —— 只滤名单、照印那一句，
      // 等于用一个名字把刚藏起来的人说出来（同 `render/players.ts` 的 `combatLines`）。
      const order = visibleOrder(campaign);
      const current = currentActor(campaign.combat);
      const lines: string[] = [];
      if (order.includes(current)) lines.push(`轮到「${current}」。`);
      const compact = orderLine(campaign);
      if (compact) lines.push(compact);
      return lines.length
        ? lines.join('\n')
        : '（这一场里还没有大家见过的人 —— 顺序只在玩家见过的人之间公布）';
    }

    // sub=start：规则表坏了（或这一局的规则扩展编译不过）就**拒绝**，不换一套顶上去（同
    // `roll` 工具那条判据：静默换一套会让"同一个骰面在两局里判出不同的档"没人能解释）。
    const found = ruleSetFor(campaign, rules);
    if (!found.ok) return `规则表读不出来，排不了先攻：${found.message}`;
    const key = found.base.initiative;
    const restarted = Boolean(campaign.combat);
    const rolled = startCombat(campaign, { key, rng });
    if (!rolled) {
      return '没有可以参战的人 —— 先攻序排的是「玩家已经见过、还站着」的人物卡。'
        + '先敲 `.pc new <角色名>` 把在场的人建出来。';
    }
    // 日志里只留**名字顺序**（一行、不印数值）：`appendLog` 的正文会镜像进战报，
    // 而战报是给人看的（P6 的 `.log export` 会把它发进群）。
    appendLog(campaign, 'state', `先攻（按 ${key}）：${formatOrder(rolled.order)}`);
    flush();

    const notes: string[] = [];
    if (restarted) notes.push('这次是重排 —— 上一场的顺序作废，从第 1 轮重新开始');
    if (rolled.missing.length) {
      notes.push(`${rolled.missing.join('、')} 的卡上没有 ${key}，按 0 排在后面`);
    }
    return `${restarted ? '已重新排好' : '先攻'}（按 ${key}）：\n${formatInitiative(rolled.order)}\n`
      + `第 1 轮，轮到「${currentActor(campaign.combat)}」。`
      + (notes.length ? `\n（${notes.join('；')}）` : '');
  };
}

/** 裸 `.combat`（**排在三个子命令之后**，只在它们都没匹配上时命中）。 */
export function createCombatUsageCommand(): CommandHandler {
  return async () => COMBAT_USAGE;
}
