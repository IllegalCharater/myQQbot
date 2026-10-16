// `roll` —— 掷骰与检定（从 `tools.ts` 拆出，2026-10-16）。
//
// 两者合成一个工具：**传了 `target` 就是检定**。它们的机械部分完全一样（解析、掷、算差值），
// 差别只在"要不要对目标值判一档"。拆成两个工具会让模型在"这次该调哪个"上多一次选择，
// 而选错的代价是白掷一次。
//
// **不自动发言** —— 要不要把点数讲给群友由模型决定（同「工具不得代模型发言」）。
import { err, ok } from '../../../agent/tools/shared.js';
import { text } from '../model/limits.js';
import { appendLog } from '../model/campaign.js';
import { formatCheck, formatRoll } from '../render/format.js';
import { resolveCheck } from '../rules/check.js';
import { rollDice } from '../rules/dice.js';
import { diceError } from './shared.js';
import type { Handler, ToolGates } from './shared.js';
import type { DiceRng } from '../rules/dice.js';
import type { RuleStore } from '../store/rule-store.js';
import type { TrpgStore } from '../store/campaign-store.js';

export interface RollHandlerDeps {
  store: TrpgStore;
  rules: RuleStore;
  /** **必填**：规则层没有默认随机源（见 `rules/dice.ts` 的文件头）。生产用 `entropy.ts` 的 `secureRng`。 */
  rng: DiceRng;
  gates: ToolGates;
}

export function createRollHandler({ store, rules, rng, gates }: RollHandlerDeps): Handler {
  const { gate, settle, withCampaign } = gates;

  return async (ctx, args) => {
    const reason = text(args?.reason, 80);
    // `actor` 是"这次判定算谁的行动"（用于配额）；不填就只走去重、不占配额 ——
    // 一轮里为四个人各掷一次察觉是正当的，那是四次不同的判定，不是重做。
    const actor = text(args?.actor, 24);
    // 掷骰放**在**读战役之后：顺序反了的话，没开局的会话会先白掷一次（消耗随机数），
    // 再把"还没开局"回给模型 —— 而它问的是骰子。先答"这个会话能不能掷"，再掷。
    return withCampaign(ctx, (campaign) => {
      // 同参数去重（声明了 actionSource 就放行）：这才是真正拦住"失败后重掷"的那一条 ——
      // 掷骰不改状态，主行动配额管不到它。
      const blocked = gate(ctx, {
        tool: 'roll', actor: actor || '判定', args, source: args?.actionSource, quota: Boolean(actor)
      });
      if (blocked) return ok(blocked);

      // 判据是**参数在不在**（而不是"它是不是一个数"）：目标值非数时要让 `resolveCheck` 抛出它
      // 那句写给模型的文案（"目标值必须是一个数，收到「难」"），而不是在这里悄悄降级成一次掷骰。
      const structured = args?.target !== undefined && args?.target !== null && args?.target !== '';
      let line: string;
      try {
        if (structured) {
          const lookup = rules.read(campaign.rule);
          // 规则表坏了就**拒绝**，不换一套顶上去：静默换一套会让"同一个骰面在两局里判出不同的档"
          // 变成一个没人能解释的现象。代价只是这个会话暂时做不了检定（`/掷骰` 不受影响）。
          if (!lookup.ok) return err(lookup.message);
          line = formatCheck(resolveCheck(args?.expr, args?.target, { rng, rule: lookup.rule }));
        } else {
          line = formatRoll(rollDice(args?.expr, rng));
        }
      } catch (error) {
        return diceError(error);
      }
      const body = `${line}${reason ? `（${reason}）` : ''}`;
      appendLog(campaign, structured ? 'check' : 'roll', body);
      return settle(ctx, 'roll', actor || '判定', args,
        ok(`${body}\n${structured ? '检定' : '掷骰'}不会自动发言：要报给群里就用 say。`));
    });
  };
}
