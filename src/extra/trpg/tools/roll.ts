// `roll` —— 掷骰与检定（从 `tools.ts` 拆出，2026-10-16）。
//
// 两者合成一个工具：**传了 `target` 就是检定**。它们的机械部分完全一样（解析、掷、算差值），
// 差别只在"要不要对目标值判一档"。拆成两个工具会让模型在"这次该调哪个"上多一次选择，
// 而选错的代价是白掷一次。
//
// **不自动发言** —— 要不要把点数讲给群友由模型决定（同「工具不得代模型发言」）。
import { err, ok } from '../../../agent/tools/shared.js';
import { text, MAX_NAME_CHARS } from '../model/limits.js';
import { appendLog } from '../model/campaign.js';
import { mechanicContextOf, ruleSetFor, secretFlagNames } from '../model/rule-set.js';
import { describeCheckModifiers, formatCheck, formatRoll } from '../render/format.js';
import { resolveCheck } from '../rules/check.js';
import { rollDice } from '../rules/dice.js';
import { applyCheckModifiers } from '../rules/rule-set.js';
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
    /**
     * 这次检定算**哪个技能** —— 这一局的规则扩展按它匹配 `{op:'skill'}` 机制（P7-e）。
     *
     * ⚠️ **少了它，机制只在 `.ra` / `.rh` 那条路上生效**：那两条命令从命令词里拿到技能名，
     * 而工具这一侧原先恒传空串，于是同一张卡、同一个场景、同一个骰面，DM 掷出来与玩家敲
     * `.ra` 掷出来**目标值不一样**（实测：一边判成功、一边判失败）。这正是六处消费点共用一个
     * 取用口要避免的那类分岔，只不过分岔在参数上而不是在数据上。
     */
    const skill = text(args?.skill, MAX_NAME_CHARS);
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
      let note = '';
      /** 写进日志的那一份（**受众是玩家**）—— 与 `note` 只差暗线旗标名那一处，见下。 */
      let loggedNote = '';
      try {
        if (structured) {
          const found = ruleSetFor(campaign, rules);
          // 基础表坏了、或这一局的规则扩展编译不过，就**拒绝**，不换一套顶上去：静默换一套会让
          // "同一个骰面在两局里判出不同的档"变成一个没人能解释的现象。代价只是这个会话暂时
          // 做不了检定（`.r` 那条路不受影响）。
          if (!found.ok) return err(found.message);
          // ⚠️ 目标值**不是数时不碰它**：`resolveCheck` 会抛出那句写给模型的文案（"目标值必须是
          // 一个数，收到「难」"），而那句话里带着**原文**。先在这里 `Number()` 一次再传进去的话，
          // 模型看到的会变成「收到「NaN」」—— 一条既有文案就这么被悄悄改掉了，没有任何断言会红。
          const goal = Number(args?.target);
          const mods = Number.isFinite(goal)
            ? applyCheckModifiers(found.set, mechanicContextOf(campaign, actor, skill), goal)
            : null;
          line = formatCheck(resolveCheck(args?.expr, mods ? mods.target : args?.target, {
            rng, judge: mods?.judge, rule: found.base
          }));
          if (mods) {
            // ── 同一句话，**两个受众，两份文本** ──
            //
            // 给模型的那一份**不遮**：机制挂在哪个暗线旗标上是它自己要推进的东西，而"为什么
            // 目标值变了"是它把数对上的唯一线索（同 `render/model.ts` 与 `render/players.ts`
            // 那条"受众不同就必须是两份实现"）。
            //
            // 写进日志的那一份**必须遮**：`appendLog` 的正文会被 `.trpg status` 印给全群
            // （`PLAYER_LOG_KINDS` 就收 `roll` / `check` 两类），也会镜像进战报、被
            // `.log export` 再发一次。暗线旗标的名字从那里漏出去，与 `.ra` 漏出去是同一件事
            // （实测过）。判据与取值都收在 `secretFlagNames` 一处。
            note = describeCheckModifiers(mods);
            loggedNote = describeCheckModifiers(mods, { secretFlags: secretFlagNames(campaign) });
          }
        } else {
          line = formatRoll(rollDice(args?.expr, rng));
        }
      } catch (error) {
        return diceError(error);
      }
      const head = `${line}${reason ? `（${reason}）` : ''}`;
      const body = `${head}${note ? `\n${note}` : ''}`;
      const logged = `${head}${loggedNote ? `\n${loggedNote}` : ''}`;
      appendLog(campaign, structured ? 'check' : 'roll', logged);
      return settle(ctx, 'roll', actor || '判定', args,
        ok(`${body}\n${structured ? '检定' : '掷骰'}不会自动发言：要报给群里就用 say。`));
    });
  };
}
