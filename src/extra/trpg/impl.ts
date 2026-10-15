// 跑团扩展的**实现**（懒加载的那一半）。
//
// 它只在**被加载时**才被 `import()` —— 入口是人：群里敲 `/能力 加载 trpg`，或者敲它自己的
// `/跑团` `/掷骰`，或者 `config.json` 的 `extras.override` 在开机时播种。
// 它这一装载就是**接管**（`spec.mode === 'override'`）：那个会话的模型侧换成跑团这一套。
//
// ── 这一层几乎什么都不做，那是有意的 ──
//
// 状态在 `state.ts`、渲染在 `render.ts`、工具在 `tools.ts`、规则在 `rules/`。
// 这里只做**接线**：把 `ExtraRuntime` 那四个口子接到上面那几件东西上。
import { EXTRA_PROMPT_SECTIONS } from '../prompts.js';
import { formatRoll, renderForModel, renderStatusCard } from './render.js';
import { rollDice } from './rules/dice.js';
import { TrpgStore, appendLog } from './state.js';
import { createHandlers } from './tools.js';
import type { ExtraRuntime } from '../types.js';

/** `/掷骰` 不带参数时的用法提示。群友可见文案，不属于提示词目录（同 `/画` 的用法提示）。 */
const ROLL_USAGE = '用法：/掷骰 3d6 —— 支持 3d6、d20、1d100、2d6+3、4d6kh3（留高）、4d6kl3（留低），'
  + '也可以直接给一个数。一次只能掷一组，要掷两组就敲两次。';

export function createRuntime(): ExtraRuntime {
  const store = new TrpgStore();

  return {
    handlers: createHandlers(store),

    commandHandlers: {
      /**
       * `/跑团` —— 看这一局的状态卡。**零 LLM 成本**的确定性快路径（同 `/转写` 那个取舍）：
       * 群友想确认"我现在几点血"不该惊动模型、也不该花一次模型调用。
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
        const roll = rollDice(expr);
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
    }

    // **没有 `dispose()`，是有意的。**
    //
    // 本扩展不持有任何长期资源：状态是每次调用现读现写的小 JSON（`TrpgStore`），没有子进程、
    // 没有 socket、没有常驻计时器、没有大缓存。所以"空闲卸载"对它确实什么都不做 ——
    // 与其写一个清空空 Map 的空 `dispose()` 假装释放了什么，不如**不写**，让这个事实裸露在这里。
    // （要写扩展的人记住的那句话是"你的重资源要在 dispose() 里放掉"；没有重资源就没有那句话。）
  };
}
