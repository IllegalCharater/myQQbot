// `.r 3d6` —— 玩家自己掷（从 `impl.ts` 拆出，2026-10-16）。零 LLM 成本。
//
// ⚠️ 这里**故意让 `DiceError` 抛出去**：`web/onebot/commands.ts` 的外壳会把
// `error.message` **原样发进群**，而解析层的文案本来就是写给群友看的中文 + 可执行的下一步。
// 在这里 catch 成一句"掷骰失败"会把那些提示全丢掉 —— 而群里那位是唯一能照着改的人。
//
// 与助手模式的 `intercept`（`impl.ts`）共用同一个 `rollDice` 与 `formatRoll`：两条路给群友
// 看到的必须是同一句话。
import { appendLog, mirrorLog } from '../model/campaign.js';
import { formatRoll } from '../render/format.js';
import { rollDice } from '../rules/dice.js';
import { restOf } from './shared.js';
import type { CommandHandler } from './shared.js';
import type { JournalPort } from '../model/campaign.js';
import type { DiceRng } from '../rules/dice.js';
import type { TrpgStore } from '../store/campaign-store.js';

/**
 * 不带参数时的用法提示。**群友可见文案**，不属于提示词目录（同 `/画` 的用法提示）。
 *
 * 与 `rules/dice.ts` 的 `SYNTAX_HINT` 是两份，受众不同：这里写给**群友**（怎么敲这个命令），
 * 那里写给**模型**（工具参数该怎么填）。两份都列出支持形态是有意的 —— 它们都会被人照着抄。
 */
const ROLL_USAGE = '用法：.r 3d6 —— 支持 3d6、d20、1d100、2d6+3、2d6+1d4（多组相加）、'
  + '4d6kh3（留高）、4d6kl3（留低）、(2d6+3)*2（括号与四则）、1d100b2（奖励骰）；也可以直接给一个数。';

export interface DiceCommandDeps {
  store: TrpgStore;
  /** 战报（写侧）。缺省不记。 */
  journal?: JournalPort | null;
  /** 这条命令的词（`'.r'`）—— 由 `commands/index.ts` 递进来。 */
  command: string;
  /** **必填**：规则层没有默认随机源。生产路径递 `entropy.ts` 的 `secureRng`。 */
  rng: DiceRng;
}

export function createDiceCommand({ store, rng, command, journal }: DiceCommandDeps): CommandHandler {
  return async (input) => {
    const expr = restOf(input, command);
    if (!expr) return ROLL_USAGE;
    const roll = rollDice(expr, rng);
    // 掷骰记进这一局的日志：它是剧情的一部分，也是"这个点数不是我编的"的凭据。
    // 没开局时照常掷（掷骰本身无害），只是没地方记。
    const campaign = store.read(input.chatKey);
    if (campaign) {
      const beforeSeq = campaign.seq;
      appendLog(campaign, 'roll', `${input.senderId || '有人'} 掷 ${formatRoll(roll)}`);
      store.write(campaign);
      mirrorLog(campaign, beforeSeq, journal ?? null);
    }
    return formatRoll(roll);
  };
}
