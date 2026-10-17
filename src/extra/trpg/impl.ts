// 跑团扩展的**实现**（懒加载的那一半）—— **纯接线**。
//
// 它只在**被加载时**才被 `import()` —— 入口是人：群里敲 `/能力 加载 trpg`，或者敲它自己的
// 命令，或者 `config.json` 的 `extras.override` 在开机时播种。
// 它这一装载就是**接管**（`spec.mode === 'override'`）：那个会话的模型侧换成跑团这一套。
//
// ── 这一层几乎什么都不做，那是有意的 ──
//
// 声明在 `spec.ts`、判据与状态机在 `model/`、落盘在 `store/`、剧本格式在 `scenario/`、
// 玩家命令在 `commands/`、模型工具在 `tools/`、展示在 `render/`、规则在 `rules/`、
// 兜底建议在 `suggest.ts`、真熵源在 `entropy.ts`。
// 这里只做一件事：把 `ExtraRuntime` 那几个口子接到上面那几件东西上。
import { isPersonMessage } from '../../chat/store.js';
import { errorMessage } from '../../agent/tools/shared.js';
import { getConfig } from '../../core/config.js';
import { EXTRA_PROMPT_SECTIONS } from '../prompts.js';
import { createCommands } from './commands/index.js';
import { usableScenarios } from './commands/shared.js';
import { secureRng } from './entropy.js';
import { appendLog } from './model/campaign.js';
import { renderForModel } from './render/model.js';
import { renderBriefing } from './render/status.js';
import { formatRoll } from './render/format.js';
import { DiceError, looksLikeDiceRequest, rollDice } from './rules/dice.js';
import { TRPG_ASSISTANT_TOOLS, trpgSpec } from './spec.js';
import { TrpgStore } from './store/campaign-store.js';
import { JournalStore } from './store/journal-store.js';
import { TrpgModeStore } from './store/mode-store.js';
import { RuleStore } from './store/rule-store.js';
import { ScenarioStore } from './store/scenario-store.js';
import { generateSuggestions } from './suggest.js';
import { createHandlers } from './tools/index.js';
import type { ExtraRuntime, ExtraRuntimeDeps, ExtraRunEnd } from '../types.js';

/**
 * 兜底建议的冷却：同一个会话这么久之内最多触发一次。
 *
 * 判据本身（"这一轮 DM 一句话没说，而且是真人推动的"）已经很少同时成立，冷却只是防止
 * "群里连着几个人各说一句、DM 每轮都沉默"时连着烧几次调用。
 */
const SUGGEST_COOLDOWN_MS = 3 * 60 * 1000;

/**
 * DM 模式露出的工具名 = `spec.tools` 全部。
 *
 * **从 spec 派生，不在这里再抄一遍**：抄一遍的话，往 `spec.tools` 加一个工具而忘了同步这里，
 * 表现是"那个工具在 DM 模式下**静默不出现**" —— 而 `toolsFor` 的返回值是工具表的唯一事实源，
 * 少一个名字不会有任何报错。
 */
const DM_TOOLS: readonly string[] = trpgSpec.tools.map((tool) => tool.name);

/**
 * 挂载期间把"上下文宽度"那几个旋钮**至少**抬到这里（见 `configPatch`）。
 *
 * 跑团比闲聊吃上下文得多：一局里的人物卡、旗标、剧本正文与日志每轮都要带上，默认那点窗口
 * 会让 DM 看不见自己十分钟前说过什么、也想不起三天前埋的线。这三个数就是"够跑一局"的那一档。
 *
 * ⚠️ 语义是**下限不是覆盖**（见 `configPatch` 里的 `lift`）：用户自己配得比这宽就照用户的。
 */
const CONTEXT_FLOOR = { maxContextMessages: 200, historyCount: 200, promptContextMaxChars: 60000 } as const;

export function createRuntime(deps: ExtraRuntimeDeps = {}): ExtraRuntime {
  const store = new TrpgStore();
  /** 规则表（`data/trpg/rules/`）。内置的两套由它**懒补齐**（首次用到规则时才写盘）。 */
  const rules = new RuleStore();
  /** 剧本库（`data/trpg/scenarios/`）。没有内置种子 —— 剧本是内容，得有人写。 */
  const scenarios = new ScenarioStore();
  /**
   * 战报（`data/trpg/journal/<会话>.jsonl`，append-only）。
   *
   * P2 起落地的是**写侧**：每次落盘的日志都镜像一条进去。读取与导出在 P6。
   * **记在导出之前** —— 否则 P6 上线那天开始的团才有完整战报（决策 6）。
   */
  const journal = new JournalStore();
  /**
   * 每个会话的运行模式（`data/trpg/modes.json`）。缺省 = DM。
   *
   * 它同时被 `toolsFor`（露哪些工具）、`prompt`（给哪份人格）与 `onRunEnd`（跑不跑兜底建议）
   * 三处读，所以必须是**同一个实例** —— 各建一个会在"读的是同一份文件"上浪费，更糟的是
   * 让人以为三处的判据可能不一致。
   */
  const modes = new TrpgModeStore();
  /** 每个会话上次兜底的时间。只留冷却窗口内的，所以它自然有界（见 `coolingDown`）。 */
  const lastSuggestAt = new Map<string, number>();

  const coolingDown = (chatKey: string, now: number): boolean => {
    for (const [key, at] of lastSuggestAt) {
      if (now - at >= SUGGEST_COOLDOWN_MS) lastSuggestAt.delete(key);
    }
    return now - (lastSuggestAt.get(chatKey) ?? 0) < SUGGEST_COOLDOWN_MS;
  };

  return {
    handlers: createHandlers({
      store, rules, scenarios, journal, rng: secureRng, deliverNote: deps.deliverNote
    }),

    commandHandlers: createCommands({
      store, rules, scenarios, modes, journal, rng: secureRng,
      sendPrivate: deps.sendPrivate, sendFile: deps.sendFile, recordUsage: deps.recordUsage
    }),

    /**
     * 这个会话露哪些工具。**助手模式只给骰子**（`roll` + `say`）。
     *
     * 判据是"模型看到的与它真能用的必须是同一套东西"：留着 `campaign`/`character` 在那里
     * 而只在提示词里求它别调，等于每轮都多花一段前缀、还给它一次调错的机会。
     * 名单在 `spec.ts`（紧挨着它必须是其子集的那份 `tools`），套件有断言钉着它是子集。
     */
    toolsFor(chatKey) {
      return modes.read(chatKey) === 'assistant' ? TRPG_ASSISTANT_TOOLS : DM_TOOLS;
    },

    /**
     * **助手模式：整条消息都不进模型**（见 `ExtraRuntime.intercept`）。
     *
     * 认得出骰子就掷、把结果回给群里；认不出的（@ 它、闲聊、问问题）**一律静默拦下**。
     * 这正是"仅能执行 onedice 指令"的字面意思，也是这个模式唯一的零成本保证：
     * 那个群里**一次模型调用都不会发生**（所以助手模式连人格都不注入 —— 见下面 `prompt()`）。
     *
     * ⚠️ 三条硬约束见 `ExtraRuntime.intercept`，这里最要紧的是**同步**：它跑在**每一条**入站
     * 消息上，所以下面只有同步的小文件读写，一个 `await` 都没有。
     */
    intercept(input) {
      if (modes.read(input.chatKey) !== 'assistant') return null;
      const expr = looksLikeDiceRequest(input.text);
      // 认不出 → `{}` = **拦下、不吭声**：不惊动模型，也不刷屏。
      if (!expr) return {};
      try {
        const roll = rollDice(expr, secureRng);
        // 掷骰记进这一局的日志（同 `.r`）。助手模式下通常没有战役 —— 有才记：那多半是
        // "从 DM 切过来、以后还要切回去"的群，把这段补上比留个洞好。
        const campaign = store.read(input.chatKey);
        if (campaign) {
          appendLog(campaign, 'roll', `${input.senderId || '有人'} 掷 ${formatRoll(roll)}`);
          store.write(campaign);
        }
        return { reply: formatRoll(roll) };
      } catch (error) {
        // 走到这里的不是"解析不了"（那种在 `looksLikeDiceRequest` 就已经返回 `null`、静默拦下了），
        // 而是**解析得了、掷不出来**：`0d6`、`101d6` 这类越界的数量。它们确实是掷骰请求，
        // 所以把**可读的原因**说出去 —— 那正是敲错的人需要的下一步（同 `.r`：文案原样进群，
        // 不换成一句"掷骰失败"）。
        return { reply: error instanceof DiceError ? error.message : `掷骰出错：${errorMessage(error)}` };
      }
    },

    /**
     * 挂载期间把"上下文宽度"抬到 `CONTEXT_FLOOR`（见那里）。
     *
     * ⚠️ **助手模式不抬**：它压根不跑模型（`intercept` 全拦），拓宽窗口只是白占内存。
     *
     * ⚠️ 这里读 `getConfig()`（全局那份）**只为算下限**，不是写它 —— 返回值经
     * `mergeConfigPatch` 叠在"这一轮那份"上，不落盘、也不外溢到别的群（那正是 `configPatch`
     * 与 `updateConfig` 的分界）。**别在这里 `updateConfig`**。
     */
    configPatch(chatKey) {
      if (modes.read(chatKey) === 'assistant') return {};
      const base = getConfig().store ?? {};
      // `0` = 不限 —— 已经是最宽了，写成 200 反而把它变窄。
      const lift = (current: unknown, floor: number): number => {
        const value = Math.max(0, Number(current) || 0);
        return value === 0 ? 0 : Math.max(value, floor);
      };
      return {
        store: {
          maxContextMessages: lift(base.maxContextMessages, CONTEXT_FLOOR.maxContextMessages),
          historyCount: lift(base.historyCount, CONTEXT_FLOOR.historyCount),
          promptContextMaxChars: lift(base.promptContextMaxChars, CONTEXT_FLOOR.promptContextMaxChars)
        }
      };
    },

    /**
     * system prompt 的贡献：**人格 → （清单 + 剧本正文）→ 当前状态**，顺序不能反。
     *
     * 顺序即缓存：清单只在管理员改文件时变、剧本正文整局不变，而状态每轮都变。
     * 把两个稳定的排在状态之前，system prompt 的公共前缀才能命中到状态变化点之前；
     * 反过来的话，同一场团连着跑几轮会让**整段**系统提示每轮失效（见 `render/model.ts` 顶部那段）。
     *
     * ⚠️ 本函数必须是**全函数**：装载时 `checkRuntimeShape` 会空着 `chatKey` 调它一次
     * （只做段落名对账），`store.read('')` 返回 `null`，于是渲染出"还没有开局"那段 ——
     * 不抛错、形状合法。这就是 `prompt(chatKey)` 要收参数、且不许抛的原因。
     * 中间那段也**永远非空**（规则清单至少有两个内置的），所以 body 恒为三段。
     */
    prompt(chatKey) {
      // ── 助手模式：**空 body**（2026-10-16 改，原先是一份"骰子助手"人格）──
      //
      // 那个形态下 `intercept` 把**每一条**消息都拦下（落成已读、`wakeEligible: false`），
      // 所以模型只在两条"绕不过去的唤醒"上才会跑：全局主动冒泡、异步结果回流。
      // 而那两种情况下**什么都不说**正是要的行为 —— 一份"你是骰子助手"的人格反而是在
      // 邀请它开口（解释自己、转述刚到的转写结果）。空 body 让它没有可扮演的身份。
      //
      // 空的 body **仍然保留框架契约两段**（`buildSystemPrompt` 的 override 分支是
      // `[...SYSTEM_FRAMEWORK_SECTIONS, ...body]`），所以工具协议那条"要发言必须调用 say"
      // 照旧在 —— 真要开口时它仍然知道怎么开口。
      if (modes.read(chatKey) === 'assistant') return { body: [] };
      const campaign = store.read(chatKey);
      return {
        body: [
          ...EXTRA_PROMPT_SECTIONS.trpg.body,
          renderBriefing(campaign, {
            scenarios: usableScenarios(scenarios).map((item) => ({ id: item.id, title: item.title })),
            rules: rules.list().filter((item) => !item.problems.length)
              .map((item) => ({ id: item.id, name: item.name, description: item.description }))
          }),
          renderForModel(campaign)
        ]
      };
    },

    /**
     * 一轮跑完了。**只在三件事同时成立时**才做兜底建议：
     *
     *   ① `status === 'noreply'` —— DM 这一轮一句话都没说（它运行正常，只是选择了沉默）。
     *      判据是收尾状态而不是"读它的正文看它给没给选项"：后者是被本仓库否掉的关键词正则复查。
     *      提示词要求它每轮自己给 2-4 个选项，所以正常路径**零成本**，只有沉默那一轮才走这里。
     *   ② 这一轮是**真人推动**的（触发批里有群友的消息）。
     *      ⚠️ **这一条同时是循环终止的证明**：兜底落下的回流条目会唤醒下一轮，而那一轮的
     *      触发批里只有机器条目、没有真人消息 → 不再兜底。少了它就是无限循环。
     *   ③ 冷却窗口过了（见 `SUGGEST_COOLDOWN_MS`）。
     *
     * 产物是一条 `suggest` 回流条目，**由下一轮的主 DM 自己用 say 说出来** —— 这里不代它发群。
     */
    async onRunEnd(session: ExtraRunEnd) {
      // **助手模式永远不跑兜底。** 它整轮不说话是常态（群友在聊别的），而"给几个行动方向"
      // 在骰子助手的语境里毫无意义 —— 跑下去只会白烧一次调用，还会把助手叫醒去说一堆
      // 它这个形态下不该说的话。判据放最前面：它最便宜，也最不容商量。
      if (modes.read(session.chatKey) === 'assistant') return;
      if (session.status !== 'noreply') return;
      if (!session.trigger.some((entry) => isPersonMessage(entry))) return;
      const now = Date.now();
      if (coolingDown(session.chatKey, now)) return;

      const campaign = store.read(session.chatKey);
      if (!campaign) return;
      if (!deps.deliverNote) return;

      lastSuggestAt.set(session.chatKey, now);
      // 这一次调用发生在 `finish()` 之后，所以用量走 `recordUsage`（只叠增量）——
      // 借会话那条记账路会把这一整轮的账再加一遍（见 `suggest.ts` 头部与 `chat/sessions.ts`）。
      const options = await generateSuggestions(campaign, deps.recordUsage);
      if (!options.length) return;
      deps.deliverNote(session.chatKey, {
        kind: 'suggest',
        text: `DM 这一轮没有回话，群里在等。下面是可以给他们的行动方向（你自己组织语言说出来，`
          + '别照抄、别说是系统给的）：\n' + options.map((option) => `- ${option}`).join('\n')
      });
    }

    // **没有 `dispose()`，是有意的。**
    //
    // 本扩展不持有任何长期资源：状态是每次调用现读现写的小 JSON（三个 store），没有子进程、
    // 没有 socket、没有常驻计时器、没有大缓存（`lastSuggestAt` 只有冷却窗口内的几条，见上）。
    // 所以"空闲卸载"对它确实什么都不做 —— 与其写一个清空空 Map 的空 `dispose()` 假装释放了什么，
    // 不如**不写**，让这个事实裸露在这里。
    // （要写扩展的人记住的那句话是"你的重资源要在 dispose() 里放掉"；没有重资源就没有那句话。）
  };
}
