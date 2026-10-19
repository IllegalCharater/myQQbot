// `.ra` / `.rh` / `.st` —— 玩家自己的检定与属性（P3 加）。
//
//   `.ra <技能>`          公开检定：自动读你自己卡上的技能值，群里出结果
//   `.rh <技能>`          暗骰：**群里只说"已私聊发送"**，点数与一段私密叙事只发给掷骰的人
//   `.st <技能> <值>`     确认之前改自己的技能（确认之后归 DM）
//
// ── 为什么这三条值得存在 ──
//
// 它们把"玩家自己动手"的那一半从模型手里拿回来：不需要叫 DM、不花模型调用，
// 而点数仍然是**代码掷的**（与 `roll` 工具共用 `resolveCheck` 与同一个 `rng`）。
//
// ── 暗骰的关键在"不留痕"（决策 7）──
//
// 暗骰的结果与那段私密叙事**既不写 `campaign.log`、也不进战报** —— 它们唯一的持久痕迹是
// 玩家私聊存档里那条 `我：…`。写进 `campaign.log` 就等于让"暗骰"在群存档里留下痕迹，
// 而暗骰的全部意义就是不留痕迹（DM 那一份渲染会把日志念给模型听）。
import { addUsage, chatCompletion, emptyUsage } from '../../../llm/llm.js';
import { SlidingWindowBudget } from '../../../media/call-budget.js';
import { errorMessage } from '../../../agent/tools/shared.js';
import { EXTRA_PROMPT_JOBS } from '../../prompts.js';
import { appendLog, mirrorLog } from '../model/campaign.js';
import { MAX_NAME_CHARS, MAX_STATS_PER_CHARACTER, MAX_STAT, MIN_STAT, SECRET_ROLL_BUDGET, clampInt } from '../model/limits.js';
import { mechanicContextOf, ruleSetFor, secretFlagNames } from '../model/rule-set.js';
import { playerOf } from '../model/session.js';
import { describeCheckModifiers, formatCheck } from '../render/format.js';
import { DiceError } from '../rules/dice.js';
import { resolveCheck } from '../rules/check.js';
import { applyCheckModifiers } from '../rules/rule-set.js';
import { restOf, argsOf } from './shared.js';
import type { CommandHandler } from './shared.js';
import type { CheckResult } from '../rules/check.js';
import type { ExtraUsage } from '../../types.js';
import type { JournalPort } from '../model/campaign.js';
import type { DiceRng } from '../rules/dice.js';
import type { TrpgCampaign, TrpgCharacter } from '../types.js';
import type { RuleStore } from '../store/rule-store.js';
import type { TrpgStore } from '../store/campaign-store.js';

/** 私密叙事的等待上限。与 `suggest.ts` 同一口径：旁路调用不该拖住别的东西。 */
const NARRATION_TIMEOUT_MS = 12000;

/**
 * 暗骰私密叙事的调用闸门（见 `SECRET_ROLL_BUDGET`）。
 *
 * ⚠️ **模块级单例是有意的**：滑动窗口要跨调用累积，每次新建等于没有闸门。
 */
const secretRollBudget = new SlidingWindowBudget({ getLimits: () => SECRET_ROLL_BUDGET });

export interface CheckCommandDeps {
  store: TrpgStore;
  rules: RuleStore;
  rng: DiceRng;
  /** 私聊投递（暗骰）。缺省 = 没装通道，`.rh` 会**如实说一句并且不掷**。 */
  sendPrivate?: ((targetUserId: string, text: string) => Promise<void>) | null;
  /**
   * 记一次独立模型调用的用量（暗骰那一次私密叙事）。
   * 缺省 = 不记账，叙事照常生成 —— 见 `ExtraRuntimeDeps.recordUsage`。
   */
  recordUsage?: ((usage: ExtraUsage) => void) | null;
  /**
   * 暗骰叙事的调用闸门。缺省 = 模块级那本账（生产路径）；套件要验"限额到了会怎样"时注入自己的。
   */
  budget?: SlidingWindowBudget;
  journal?: JournalPort | null;
  /** 这条命令的词（`'.ra'` 这样）—— 由 `commands/index.ts` 递进来。 */
  command: string;
}

/**
 * `.st` 的依赖 —— **比上面那个窄**：它只读卡、改卡、落盘，不掷骰也不走私聊。
 *
 * 窄一份是有意的（同 `commands/index.ts` 那条"每个词只写一次"的纪律）：按 `CheckCommandDeps`
 * 收的话，`index.ts` 会顺手把 `sendPrivate` / `rules` / `rng` 一起递进来，而它们在这里
 * **一个都不读** —— 下一个读代码的人会以为 `.st` 也掷骰、也会发私聊。
 */
export interface StatCommandDeps {
  store: TrpgStore;
  journal?: JournalPort | null;
  command: string;
}

/** 你的卡上都有哪些技能/属性。`.ra` / `.st` 说不清时都要列它。 */
function skillList(card: TrpgCharacter): string {
  const keys = Object.keys(card.stats);
  return keys.length ? keys.join('、') : '（一个都还没有 —— 让主持人给你定，或者用 `.st <技能> <值>` 填）';
}

/**
 * 这一局里**玩家不该看到名字**的旗标（暗线）。
 *
 * 给 `describeCheckModifiers` 用：那条文本会**进群**（`.ra`）或**进私聊**（`.rh`），
 * 而它在机制没有 `note` 时会退到触发条件 —— 触发条件可能是暗线旗标。不遮的话，一次 `.ra`
 * 就会把 `旗标：真凶是医生 = 是` 印在全群面前（实测过），并跟着日志进战报。
 *
 * 判据收在 `model/rule-set.ts` 的 `secretFlagNames` 一处（`roll` 工具写日志那一份也要它）。
 */
const secretFlagsOf = secretFlagNames;

/**
 * 读一次规则集并**检查它接受这个形状**，顺带算上这一局的机制。
 *
 * 拒绝的两种成因分开报（同 `roll` 工具）：表坏了要人去修，形状不匹配要换骰子或换表。
 * 都交给 `resolveCheck` → `check()` 抛的那句中文，不在这里重写。
 *
 * ⚠️ **`.ra` 与 `.rh` 共用这一个**（它是这两条路唯一的检定入口），所以机制钩子接在这里
 * 就等于两条都接上了 —— 分开写两份的话，"`.ra` 吃了机制而 `.rh` 没吃"不会有任何报错，
 * 表现只是同一个人同一张卡公开掷与暗掷出不同的目标值。
 *
 * `note` 是"规则改了目标值"那一行（P7-d）：调用方按它是不是空串决定要不要多印一行。
 * 它**带上了暗线旗标的遮挡**（见 `secretFlagsOf`）—— 这两条路的受众都是玩家。
 */
function judge(
  deps: CheckCommandDeps, campaign: TrpgCampaign, card: TrpgCharacter, skill: string, target: number
): { result: CheckResult; note: string } {
  const found = ruleSetFor(campaign, deps.rules);
  // 基础表坏了、或这一局的规则扩展编译不过，就**拒绝**，不换一套顶上去（同 `roll` 工具那条）。
  if (!found.ok) throw new DiceError('RULE', found.message);
  const mods = applyCheckModifiers(found.set, mechanicContextOf(campaign, card.name, skill), target);
  const result = resolveCheck(found.base.dice, mods.target, {
    rng: deps.rng, judge: mods.judge, rule: found.base
  });
  return { result, note: describeCheckModifiers(mods, { secretFlags: secretFlagsOf(campaign) }) };
}

/**
 * 暗骰的私密叙事 —— **一次独立的模型调用**。
 *
 * ⚠️ **它拿不到点数**：`EXTRA_PROMPT_JOBS.trpg.secretRoll.user` 的参数里根本没有那个数
 * （只有技能名、技能值与档位）。这是刻意的隔离 —— 模型看不见那个数，就不可能写偏。
 *
 * 失败一律返回空串（调用方只发点数那行）：它是旁路，不该让一次暗骰因为模型抽风而失败。
 *
 * **用量走 `recordUsage`**（见 `ExtraRuntimeDeps.recordUsage`）：这一次调用发生在
 * `SessionRegistry.finish()` **之后**，借不了会话那条记账路（那条路对已结束的会话会整份重复
 * 累加）。缺省时只是不记账，调用照常。
 */
async function generateSecretNarration(
  ask: { card: string; skill: string; target: number; grade: string },
  recordUsage?: ((usage: ExtraUsage) => void) | null
): Promise<string> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), NARRATION_TIMEOUT_MS);
    try {
      const result = await chatCompletion({
        messages: [
          { role: 'system', content: EXTRA_PROMPT_JOBS.trpg.secretRoll.system },
          { role: 'user', content: EXTRA_PROMPT_JOBS.trpg.secretRoll.user(ask) }
        ],
        temperature: 0.9,
        signal: controller.signal
      });
      const usage = result.usage;
      if (usage) {
        // 归一到与全局同一套字段（`addUsage` 是唯一那份归一化，`llm/llm.ts`）。
        recordUsage?.(addUsage(emptyUsage(), usage));
        // 日志仍留着：这一次调用的开销不进任何一条会话，日志是它唯一的当场痕迹。
        console.log(`[trpg] 暗骰叙事用量：`
          + `prompt=${usage.prompt_tokens ?? 0} completion=${usage.completion_tokens ?? 0}`);
      }
      return String(result.message?.content ?? '').trim().slice(0, 200);
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    console.warn('[trpg] 暗骰叙事生成失败（只发点数）:', error instanceof Error ? error.message : error);
    return '';
  }
}

/**
 * 暗骰叙事那一次调用过不过闸门。**过不了返回 `false`，只省掉叙事**（点数照掷照发）。
 *
 * 单独抽一个函数是为了让"限额到了会怎样"能被断言：`SlidingWindowBudget.take` 抛
 * `RATE_LIMITED`，而这里把它收成布尔值 —— 顺带保证**抛错不会漏到命令层**（那会让整条
 * 暗骰变成一句"出错"，而它本来只是加菜没了）。
 *
 * **导出只为单测**（同 `scenarioNameFromFile`）：真跑一次得有个能应答的模型端点，
 * 而本仓库的测试约定不许联网。
 */
export function takeNarrationBudget(budget: SlidingWindowBudget | undefined, chatKey: string): boolean {
  try {
    (budget ?? secretRollBudget).take(chatKey);
    return true;
  } catch {
    console.warn('[trpg] 暗骰叙事的调用额度用完了，这次只发点数');
    return false;
  }
}

/**
 * `.ra <技能>` —— 公开检定。
 *
 * 三种"做不了"分开说（清单 29 / 30）：**没有战役**（先开局）、**没有卡**（先建卡）、
 * **卡上没有这个技能**（列出有什么，并给出 `.r` 这条替代路）。
 */
export function createCheckCommand(deps: CheckCommandDeps): CommandHandler {
  const { store, command } = deps;
  return async (input) => {
    const campaign = store.read(input.chatKey);
    if (!campaign) return '这个会话还没有开局 —— 先让谁来敲 `.trpg new <名字>` 起一局。';
    const card = playerOf(campaign, input.senderId);
    if (!card) return '你还没有人物卡 —— 先敲 `.pc new <角色名>`。';

    const skill = restOf(input, command);
    if (!skill) return `用法：\`.ra <技能>\`\n你卡上有：${skillList(card)}\n（想掷别的表达式就直接 \`.r 3d6\`）`;
    const target = card.stats[skill];
    if (target === undefined) {
      return `你卡上没有「${skill}」这一项。\n有这些：${skillList(card)}\n`
        + '（让主持人用 `character` 给你加上，或者想掷别的就直接 `.r 3d6`）';
    }

    try {
      const { result, note } = judge(deps, campaign, card, skill, target);
      const line = `${card.name} 的${skill}：${formatCheck(result)}${note ? `\n${note}` : ''}`;
      const beforeSeq = campaign.seq;
      appendLog(campaign, 'check', line);
      store.write(campaign);
      mirrorLog(campaign, beforeSeq, deps.journal ?? null);
      return line;
    } catch (error) {
      return error instanceof DiceError ? error.message : `检定出错：${errorMessage(error)}`;
    }
  };
}

/** `.rh <技能>` —— 暗骰。**群里那句话逐字不含点数**（那条断言就是为它写的）。 */
export function createSecretCheckCommand(deps: CheckCommandDeps): CommandHandler {
  const { store, command } = deps;
  /** 那句回执。**不许带上任何点数**。 */
  const RECEIPT = '暗骰结果已私聊发送 —— 点开和我的私聊看。';
  return async (input) => {
    const campaign = store.read(input.chatKey);
    if (!campaign) return '这个会话还没有开局 —— 先让谁来敲 `.trpg new <名字>` 起一局。';
    const card = playerOf(campaign, input.senderId);
    if (!card) return '你还没有人物卡 —— 先敲 `.pc new <角色名>`。';

    const skill = restOf(input, command);
    if (!skill) return `用法：\`.rh <技能>\`（暗骰：只有你自己看得到点数）\n你卡上有：${skillList(card)}`;
    const target = card.stats[skill];
    if (target === undefined) {
      return `你卡上没有「${skill}」这一项。\n有这些：${skillList(card)}`;
    }
    // **先看通道再掷**：掷了却发不出去等于把这次暗骰丢了，而群友只会看到一句"发不出去"。
    if (!deps.sendPrivate) return '这个机器人没装私聊通道，暗骰发不出去 —— 用 `.ra` 公开掷吧。';

    let judged: ReturnType<typeof judge>;
    try {
      judged = judge(deps, campaign, card, skill, target);
    } catch (error) {
      // 规则表的问题**不走私聊**：那是配置问题，群里说一句更有用（而且里面没有点数）。
      return error instanceof DiceError ? error.message : `检定出错：${errorMessage(error)}`;
    }
    const { result, note } = judged;

    const line = formatCheck(result);
    // ── 那一次私密叙事**先过闸门**（2026-10-19 加）──
    //
    // 每次暗骰都要发一次模型调用，而这是白名单群里任何群友都能敲的命令 —— 没有闸门的话
    // 它就成了一个不限次数的免费模型入口。限额到了**只省掉那段叙事**：点数照掷、照发，
    // 因为它才是这条命令的正文（叙事是加菜）。所以这里不拒绝整条命令。
    const narration = takeNarrationBudget(deps.budget, input.chatKey)
      ? await generateSecretNarration({
        card: card.name, skill, target, grade: result.label ?? result.grade
      }, deps.recordUsage)
      : '';
    try {
      await deps.sendPrivate(String(input.senderId), [
        `【暗骰】${card.name} 的${skill}（${target}）`,
        line,
        // 机制那一行也要给他：`formatCheck` 印的是**改过之后**的目标值，不给一句话，
        // 掷骰的人只会觉得自己卡上的数与掷出来的对不上。空串由 `filter(Boolean)` 滤掉。
        note,
        narration ? `\n${narration}` : ''
      ].filter(Boolean).join('\n'));
    } catch (error) {
      // 私聊发不出去时**退回群里**？不行 —— 那正好泄漏了这次暗骰。如实说一句，不报点数。
      console.warn('[trpg] 暗骰私聊投递失败:', error instanceof Error ? error.message : error);
      return '暗骰掷出来了，但私聊没发出去 —— 再敲一次试试。';
    }
    // ⚠️ **不写 `campaign.log`、不镜像战报**（决策 7）：暗骰不留痕。
    return RECEIPT;
  };
}

/**
 * `.st <技能> <值>` —— 确认之前改自己的技能（清单 5）。
 *
 * **确认之后归 DM**：`confirmed` 的语义就是"这张卡定下来了"，而玩家在开跑之后随手改自己的
 * 关键数值会让 DM 手里的局势与群里对不上（那条"状态归代码管"的分界在玩家这一侧同样成立）。
 * 钳制与 `character` 用的是同一组常量（`MIN_STAT` / `MAX_STAT` / `MAX_STATS_PER_CHARACTER`）。
 */
export function createStatCommand(deps: StatCommandDeps): CommandHandler {
  const { store, command } = deps;
  return async (input) => {
    const campaign = store.read(input.chatKey);
    if (!campaign) return '这个会话还没有开局。';
    const card = playerOf(campaign, input.senderId);
    if (!card) return '你还没有人物卡 —— 先敲 `.pc new <角色名>`。';

    const words = argsOf(input, command);
    if (!words.length) {
      return `用法：\`.st <技能> <值>\`（确认之前可以改）\n你卡上有：${skillList(card)}`;
    }
    if (words.length === 1) {
      const only = words[0];
      const value = card.stats[only];
      return value === undefined
        ? `你卡上没有「${only}」。有这些：${skillList(card)}`
        : `${only} = ${value}（想改就敲 \`.st ${only} <新值>\`）`;
    }
    if (card.confirmed) {
      return `「${card.name}」已经确认过了 —— 开跑之后改数值请让主持人用 \`character\`。`;
    }

    // 名字可能是词组（`计算机使用`），所以**最后一个词才是值**。
    const raw = words[words.length - 1];
    const name = words.slice(0, -1).join(' ').slice(0, MAX_NAME_CHARS);
    const value = Number(raw);
    if (!Number.isFinite(value)) return `「${raw}」不是一个数 —— 用法：\`.st <技能> <值>\``;
    const isNew = !(name in card.stats);
    if (isNew && Object.keys(card.stats).length >= MAX_STATS_PER_CHARACTER) {
      return `一张卡最多 ${MAX_STATS_PER_CHARACTER} 项，加不下了 —— 让主持人删几个不用的。`;
    }
    const next = clampInt(value, MIN_STAT, MAX_STAT, 0);
    const before = card.stats[name];
    card.stats[name] = next;
    const beforeSeq = campaign.seq;
    appendLog(campaign, 'state', `${card.name} 的${name}：${before ?? '（无）'}→${next}`);
    store.write(campaign);
    mirrorLog(campaign, beforeSeq, deps.journal ?? null);
    return `${card.name} 的${name} = ${next}${before === undefined ? '（新加的）' : ''}`
      + '。\n都定好之后敲 `.pc confirm`。';
  };
}
