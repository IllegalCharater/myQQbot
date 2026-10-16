// 跑团扩展的**实现**（懒加载的那一半）。
//
// 它只在**被加载时**才被 `import()` —— 入口是人：群里敲 `/能力 加载 trpg`，或者敲它自己的
// `/跑团` `/掷骰`，或者 `config.json` 的 `extras.override` 在开机时播种。
// 它这一装载就是**接管**（`spec.mode === 'override'`）：那个会话的模型侧换成跑团这一套。
//
// ── 这一层几乎什么都不做，那是有意的 ──
//
// 状态在 `state.ts`、渲染在 `render.ts`、工具在 `tools.ts`、规则在 `rules/`、兜底建议在
// `suggest.ts`。这里只做**接线**：把 `ExtraRuntime` 那五个口子接到上面那几件东西上。
import { isPersonMessage } from '../../chat/store.js';
import { EXTRA_PROMPT_SECTIONS } from '../prompts.js';
import { secureRng } from './entropy.js';
import { formatRoll, renderForModel, renderStatusCard } from './render.js';
import { rollDice } from './rules/dice.js';
import { TrpgStore, appendLog } from './state.js';
import { generateSuggestions } from './suggest.js';
import { createHandlers } from './tools.js';
import type { ExtraRuntime, ExtraRuntimeDeps, ExtraRunEnd } from '../types.js';

/**
 * `/掷骰` 不带参数时的用法提示。**群友可见文案**，不属于提示词目录（同 `/画` 的用法提示）。
 *
 * 与 `rules/dice.ts` 的 `SYNTAX_HINT` 是两份，受众不同：这里写给**群友**（怎么敲这个命令），
 * 那里写给**模型**（工具参数该怎么填）。两份都列出支持形态是有意的 —— 它们都会被人照着抄。
 */
const ROLL_USAGE = '用法：/掷骰 3d6 —— 支持 3d6、d20、1d100、2d6+3、2d6+1d4（多组相加）、'
  + '4d6kh3（留高）、4d6kl3（留低）、(2d6+3)*2（括号与四则）、1d100b2（奖励骰）；也可以直接给一个数。';

/**
 * 兜底建议的冷却：同一个会话这么久之内最多触发一次。
 *
 * 判据本身（"这一轮 DM 一句话没说，而且是真人推动的"）已经很少同时成立，冷却只是防止
 * "群里连着几个人各说一句、DM 每轮都沉默"时连着烧几次调用。
 */
const SUGGEST_COOLDOWN_MS = 3 * 60 * 1000;

export function createRuntime(deps: ExtraRuntimeDeps = {}): ExtraRuntime {
  const store = new TrpgStore();
  /** 每个会话上次兜底的时间。只留冷却窗口内的，所以它自然有界（见 `coolingDown`）。 */
  const lastSuggestAt = new Map<string, number>();

  const coolingDown = (chatKey: string, now: number): boolean => {
    for (const [key, at] of lastSuggestAt) {
      if (now - at >= SUGGEST_COOLDOWN_MS) lastSuggestAt.delete(key);
    }
    return now - (lastSuggestAt.get(chatKey) ?? 0) < SUGGEST_COOLDOWN_MS;
  };

  return {
    handlers: createHandlers({ store, rng: secureRng, deliverNote: deps.deliverNote }),

    commandHandlers: {
      /**
       * `/跑团` —— 看这一局的**玩家视角**笔记。**零 LLM 成本**的确定性快路径（同 `/转写` 那个取舍）：
       * 群友想确认"我现在几点血"不该惊动模型、也不该花一次模型调用。
       *
       * ⚠️ 它给的是**玩家视角**（`renderStatusCard` → `renderForPlayers`）：藏起来的人物与暗线
       * 旗标**根本不会出现**。给模型看的那一份（含全部隐藏信息）只在 `prompt()` 里走。
       */
      async '/跑团'(input) {
        return renderStatusCard(store.read(input.chatKey));
      },

      /**
       * `/掷骰 3d6` —— 玩家自己掷。同样零 LLM 成本。
       *
       * ⚠️ 这里**故意让 `DiceError` 抛出去**：`web/onebot/slash-commands.ts` 的外壳会把
       * `error.message` **原样发进群**，而解析层的文案本来就是写给群友看的中文 + 可执行的下一步。
       * 在这里 catch 成一句"掷骰失败"会把那些提示全丢掉 —— 而群里那位是唯一能照着改的人。
       */
      async '/掷骰'(input) {
        const expr = String(input.text ?? '').replace(/^\/掷骰/u, '').trim();
        if (!expr) return ROLL_USAGE;
        const roll = rollDice(expr, secureRng);
        // 掷骰记进这一局的日志：它是剧情的一部分，也是"这个点数不是我编的"的凭据。
        // 没开局时照常掷（掷骰本身无害），只是没地方记。
        const campaign = store.read(input.chatKey);
        if (campaign) {
          appendLog(campaign, 'roll', `${input.senderId || '有人'} 掷 ${formatRoll(roll)}`);
          store.write(campaign);
        }
        return formatRoll(roll);
      }
    },

    /**
     * system prompt 的贡献：**人格（稳定）+ 当前状态（易变）**，顺序不能反。
     *
     * 反了的代价是同一条纪律的老问题：状态每轮都变，把它放前面会让 system prompt 的
     * **整段**公共前缀每轮失效（见 `renderForModel` 顶部那段）。
     *
     * ⚠️ 本函数必须是**全函数**：装载时 `checkRuntimeShape` 会空着 `chatKey` 调它一次
     * （只做段落名对账），`store.read('')` 返回 `null`，于是渲染出"还没有开局"那段 ——
     * 不抛错、形状合法。这就是 `prompt(chatKey)` 要收参数、且不许抛的原因。
     */
    prompt(chatKey) {
      return {
        body: [...EXTRA_PROMPT_SECTIONS.trpg.body, renderForModel(store.read(chatKey))]
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
      if (session.status !== 'noreply') return;
      if (!session.trigger.some((entry) => isPersonMessage(entry))) return;
      const now = Date.now();
      if (coolingDown(session.chatKey, now)) return;

      const campaign = store.read(session.chatKey);
      if (!campaign) return;
      if (!deps.deliverNote) return;

      lastSuggestAt.set(session.chatKey, now);
      const options = await generateSuggestions(campaign);
      if (!options.length) return;
      deps.deliverNote(session.chatKey, {
        kind: 'suggest',
        text: `DM 这一轮没有回话，群里在等。下面是可以给他们的行动方向（你自己组织语言说出来，`
          + '别照抄、别说是系统给的）：\n' + options.map((option) => `- ${option}`).join('\n')
      });
    }

    // **没有 `dispose()`，是有意的。**
    //
    // 本扩展不持有任何长期资源：状态是每次调用现读现写的小 JSON（`TrpgStore`），没有子进程、
    // 没有 socket、没有常驻计时器、没有大缓存（`lastSuggestAt` 只有冷却窗口内的几条，见上）。
    // 所以"空闲卸载"对它确实什么都不做 —— 与其写一个清空空 Map 的空 `dispose()` 假装释放了什么，
    // 不如**不写**，让这个事实裸露在这里。
    // （要写扩展的人记住的那句话是"你的重资源要在 dispose() 里放掉"；没有重资源就没有那句话。）
  };
}
