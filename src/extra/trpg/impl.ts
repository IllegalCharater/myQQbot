// 跑团扩展的**实现**（懒加载的那一半）。
//
// 它只在**被加载时**才被 `import()` —— 入口是人：群里敲 `/能力 加载 trpg`，或者敲它自己的
// `/跑团` `/掷骰`，或者 `config.json` 的 `extras.override` 在开机时播种。
// 它这一装载就是**接管**（`spec.mode === 'override'`）：那个会话的模型侧换成跑团这一套。
//
// ── 这一层几乎什么都不做，那是有意的 ──
//
// 状态在 `state.ts`、渲染在 `render.ts`、工具在 `tools.ts`、规则在 `rules/`、兜底建议在
// `suggest.ts`、模式在 `mode.ts`（它同时被 `toolsFor` / `prompt` / `onRunEnd` 读）。
// 这里只做**接线**：把 `ExtraRuntime` 那几个口子接到上面那几件东西上。
import { isPersonMessage } from '../../chat/store.js';
import { errorMessage } from '../../agent/tools/shared.js';
import { safeFetchBinary } from '../../media/safe-fetch.js';
import { FORMAT_LABEL, extractDocumentText } from '../../media/document/index.js';
import { EXTRA_PROMPT_SECTIONS } from '../prompts.js';
import { secureRng } from './entropy.js';
import { getConfig } from '../../core/config.js';
import { MODE_LABEL, TrpgModeStore, parseMode } from './mode.js';
import {
  SCENARIO_USAGE, formatRoll, renderBriefing, renderForModel, renderScenarioList, renderStatusCard, renderWizard
} from './render.js';
import { RuleStore } from './rule-store.js';
import { DiceError, looksLikeDiceRequest, rollDice } from './rules/dice.js';
import { MAX_SCENARIO_BYTES, ScenarioStore, isFormattedScenario, saveScenarioText } from './scenario.js';
import { formatScenarioText } from './scenario-format.js';
import { TRPG_ASSISTANT_TOOLS, trpgSpec } from './spec.js';
import { TrpgStore, appendLog } from './state.js';
import { generateSuggestions } from './suggest.js';
import { beginCampaign, createHandlers } from './tools.js';
import type { MediaEntry } from '../../chat/types.js';
import type { ExtraCommandInput, ExtraRuntime, ExtraRuntimeDeps, ExtraRunEnd } from '../types.js';

/** `/剧本` 的下载超时。这是**命令路径**（群友在等回执），不该被一个慢下载挂住。 */
const SAVE_TIMEOUT_MS = 15000;

/**
 * `/剧本 [名字]` —— 把**被引用的那个文件**收进剧本库。
 *
 * ── 为什么是"引用一个文件"而不是"把正文贴在命令后面" ──
 *
 * 剧本动辄几千字，而 QQ 单条消息有长度上限。文件没有这个问题，而且**人写剧本本来就是在编辑器里
 * 写一个文件**。被引用那条的媒体已经在 `ingest.ts` 里并进 `input.media` 了（那条 `if (slashCommand
 * && repliedMedia.length)`），所以这里只要在 media 里找 `kind: 'file'` 就行 —— 不需要任何新口子。
 *
 * ── 两个"当场" ──
 *
 * ① `url` 是协议端给的**临时直链**（实测带签名），所以要**当场下**，不能存起来等下次用；
 * ② 下载有**超时**（这是命令路径，群友在等回执，不该被一个慢下载挂住）。
 *
 * ── 权限 ──
 *
 * 与其余命令一致（白名单会话里可敲）。**已知代价**：白名单群里任何群友都能存剧本、也能覆盖同名剧本。
 * 要收紧只需在这里加一条判据（同 `/能力` 的权限那一句话）。
 */
export interface SaveScenarioDeps {
  /**
   * 注入点，**只给套件用**（生产路径一个都不传）。
   *
   * 为什么需要：这条路上有两件本机测不了的事 —— 起 Python 子进程抽文本、以及可能发生的一次
   * 模型调用。仓库的测试约定是**不许启动真解释器**，而真模型调用要么联网要么依赖桩端点；
   * 两者都会让"套件绿"变成"这台机器恰好能跑"。手法与 `agent/tools/document.ts` 的 `extract` 相同。
   */
  extract?: typeof extractDocumentText;
  format?: typeof formatScenarioText;
}

export async function saveScenario(
  input: { media: readonly MediaEntry[] },
  name: string,
  scenarios: ScenarioStore,
  deps: SaveScenarioDeps = {}
): Promise<string> {
  // 名字由调用方决定（显式给的，或从文件名推的）—— 推不出来时它已经回过 `SCENARIO_USAGE` 了，
  // 所以这里不必再兜一次。
  const file = input.media.find((item) => item.kind === 'file');
  if (!file) {
    return '引用的那条消息里没有文件。\n' + SCENARIO_USAGE;
  }
  const shown = String(file.name ?? '').trim() || String(file.file ?? '').trim() || '（没有名字的文件）';
  const url = typeof file.url === 'string' ? file.url : '';
  if (!url) {
    return `拿到了「${shown}」，但协议端没给下载地址（只给了 file_id）—— 这条路暂时下不来，`
      + '把文件内容贴成一条消息、或者直接放进 `data/trpg/scenarios/` 都行。';
  }

  try {
    const { buffer } = await safeFetchBinary(url, MAX_SCENARIO_BYTES, AbortSignal.timeout(SAVE_TIMEOUT_MS));
    // 字节 → 文本交给**通用能力**（`media/document/`）：剧本因此可以直接传 .pdf / .docx，
    // 而不只是 UTF-8 的 .md / .txt。那一步要起 Python 子进程，所以下面单独接一段错误 ——
    // "下载失败"与"读不出来"是两件事，压成一句会让人往错的方向查。
    let doc;
    try {
      doc = await (deps.extract ?? extractDocumentText)(buffer);
    } catch (error) {
      return `读「${shown}」失败：${errorMessage(error)}`;
    }
    // ── 先做**格式匹配** ──
    //
    // 判据是确定性的（有没有 frontmatter、能不能解析），不是"看起来像不像"。**格式本来就对的
    // 文件一次模型调用都不发** —— 那是这条命令的快路径。上传的是 PDF 模组、一段裸设定，
    // 或者 frontmatter 里的 JSON 写坏了，才让模型整理一遍。
    const sourceLabel = FORMAT_LABEL[doc.format];
    const usedModel = !isFormattedScenario(doc.text, name);
    let finalText = doc.text;
    if (usedModel) {
      const formatted = await (deps.format ?? formatScenarioText)(doc.text, { name, source: sourceLabel });
      if (!formatted.ok) return `${shown}：${formatted.message}`;
      finalText = formatted.text;
    }
    const saved = saveScenarioText(name, { ...doc, text: finalText }, scenarios);
    if (!saved.ok) return `${shown}：${saved.message}`;
    const skeleton = [
      Object.keys(saved.scenario.flags).length ? `${Object.keys(saved.scenario.flags).length} 条旗标` : '',
      saved.scenario.characters.length ? `${saved.scenario.characters.length} 张人物卡` : ''
    ].filter(Boolean).join('、');
    // 来源格式要说出来。**整理过的那一次也要说**：它是"回执为什么慢了"与"内容为什么被重排过"
    // 的唯一线索，不说的话群友只会看到一份与自己手里不一样的剧本，而不知道为什么。
    const origin = [sourceLabel, ...(doc.pages === undefined ? [] : [`${doc.pages} 页`]),
      ...(doc.encoding && doc.encoding !== 'utf-8' ? [`按 ${doc.encoding} 解码`] : [])].join('，');
    const formattedNote = usedModel
      ? `原文不是剧本格式，已让模型整理过（原文 ${doc.text.length} 字）。\n` : '';
    return `${formattedNote}已存剧本「${saved.scenario.id}」：标题「${saved.scenario.title}」`
      + `${skeleton ? `，带 ${skeleton}` : ''}，正文 ${saved.scenario.body.length} 字（来源 ${origin}）。`
      + (saved.ignored.length ? `（忽略了不认识的字段：${saved.ignored.join('、')}）` : '')
      + `\n开局：/开局 ${saved.scenario.id}`;
  } catch (error) {
    return `下载「${shown}」失败：${errorMessage(error)}`;
  }
}

/**
 * 命令参数按**词**切（第一个词是命令本身，丢掉）。
 *
 * 与 `/掷骰` 那边**剥前缀**是有意的不同：`/掷骰` 的参数是一整条表达式（`3d6 + 2` 里的空格
 * 属于表达式），而这几条命令的参数是若干个独立的词（`/开局 灯塔 coc7`）。两者形状不同，
 * 别统一成一种 —— 统一之后必然有一边的解析错。
 */
function wordsOf(input: ExtraCommandInput): string[] {
  return String(input.text ?? '').trim().split(/\s+/).slice(1);
}

/**
 * `/跑团` 收到参数时回的话。**群友可见文案**，不属于提示词目录（同 `ROLL_USAGE`）。
 *
 * 存在的理由：拆掉子命令之后，`/跑团 开局 灯塔` 这种旧写法（或敲错）会落到 `/跑团` 上。
 * **不能静默忽略** —— 那样群友只会看到一张状态卡，而不知道自己敲的那条为什么没生效。
 */
const COMMAND_USAGE = '这几条各自是一条命令：\n'
  + '· `/跑团` —— 看当前局势（还没开局会给向导）\n'
  + '· `/模式 [助手|DM]` —— 看 / 切换我当骰子助手还是当主持人\n'
  + '· `/剧本 [名字]` —— 引用一份剧本文件收进库（不带名字就用文件名；没引用就是列出来）\n'
  + '· `/开局 [剧本名] [规则表 id]` —— 不带名字是看有哪些剧本，带名字就开局\n'
  + '· `/掷骰 3d6` —— 自己掷一次';

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

/**
 * 引用的那个文件叫什么（去掉扩展名）。取不到返回 `null`。
 *
 * 导出只为单测：它上面那条路（`/剧本` 不带名字）会真的去下载并**起 Python 抽文本**，
 * 而仓库的测试约定是不启动真解释器 —— 所以判据在这一层单独钉。
 */
export function scenarioNameFromFile(media: readonly MediaEntry[]): string | null {
  const file = media.find((item) => item.kind === 'file');
  if (!file) return null;
  const raw = String(file.name ?? file.file ?? '').trim();
  return raw.replace(/\.[a-z0-9]+$/i, '').trim() || null;
}

export function createRuntime(deps: ExtraRuntimeDeps = {}): ExtraRuntime {
  const store = new TrpgStore();
  /** 规则表（`data/trpg/rules/`）。内置的两套由它**懒补齐**（首次用到规则时才写盘）。 */
  const rules = new RuleStore();
  /** 剧本库（`data/trpg/scenarios/`）。没有内置种子 —— 剧本是内容，得有人写。 */
  const scenarios = new ScenarioStore();
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

  /**
   * 剧本库里**此刻能用的**那些。
   *
   * 坏文件不进清单（它们本来也选不中），但它们仍然出现在设置页里 —— 那才是能修的地方。
   * 抽成一个函数是因为**三处**要用（模型那份简报、向导、`/开局` 的候选），
   * 各写一遍的话，加一种"不能用"的成因时必然漏掉其中一处。
   */
  const usableScenarios = () => scenarios.list().filter((item) => !item.problems.length);
  const scenarioIds = (): string[] => usableScenarios().map((item) => item.id);

  return {
    handlers: createHandlers({ store, rules, scenarios, rng: secureRng, deliverNote: deps.deliverNote }),

    commandHandlers: {
      /**
       * `/跑团` —— **只报当前状态**。四个动作各有各的命令（2026-10-16 拆的）：
       *
       *   `/模式 [助手|DM]` → `/剧本 [名字]`（上传/列出，**可选**）→ `/开局 [剧本名] [规则表]`，
       *   外加随时能敲的 `/掷骰 3d6`。
       *
       * ⚠️ **它不再接受任何子命令。** 原先三个动作挂在这里当 `words[0]` 分支，那张分支表就是
       * `spec.commands` 词形列表的第二份定义 —— 而词形列表只有那一处（`names[0]` 同时是
       * `commandHandlers` 的键）。拆开之后加一个动作 = 加一行声明 + 一个 handler。
       * **带参数时不静默忽略**（旧写法 `/跑团 开局 灯塔` 会落到这里）：说清它们已经拆开了，
       * 否则群友只会看到一张状态卡，而不知道自己敲的那条为什么没生效。
       *
       * 不带参数时按**这个会话此刻处在哪一步**给不同的东西（判据全是确定性的）：
       *   · 助手模式 → 这个模式怎么用（它不注入状态，给一张"还没开团"的空卡会让人以为坏了）；
       *   · 已经开局 → **玩家视角**的局势卡（玩的时候要看的就是它，零 LLM 成本）；
       *   · 还没开局 → **向导**（正需要知道下一步敲什么）。
       */
      async '/跑团'(input) {
        const mode = modes.read(input.chatKey);
        if (wordsOf(input).length) return COMMAND_USAGE;
        if (mode === 'assistant') {
          return `当前是${MODE_LABEL.assistant}：发一个骰子表达式（3d6、d20、2d6+3、4d6kh3…）我就掷。\n`
            + `要变成跑团（我当主持人）：\`/模式 DM\`。`;
        }
        const campaign = store.read(input.chatKey);
        return campaign
          ? renderStatusCard(campaign)
          : renderWizard({ modeLabel: MODE_LABEL[mode], scenarios: scenarioIds() });
      },

      /** `/模式 [助手|DM]` —— 看 / 切换这个群的形态。不带参数就是看当前的。 */
      async '/模式'(input) {
        const mode = modes.read(input.chatKey);
        const wanted = wordsOf(input)[0];
        if (!wanted) {
          return `当前：${MODE_LABEL[mode]}\n`
            + '· `/模式 助手` —— 只掷骰\n'
            + '· `/模式 DM` —— 跑团，我当主持人';
        }
        const next = parseMode(wanted);
        if (!next) return `不认识的模式「${wanted}」。可用的是：助手（骰子）、DM（跑团）。`;
        if (next === mode) return `已经是${MODE_LABEL[mode]}了。`;
        modes.write(input.chatKey, next);
        // 切模式**不动战役存档**：切回 DM 时那一局还在原地等着（助手模式下它只是不被注入）。
        const kept = next === 'assistant' && store.read(input.chatKey) ? '这一局的存档留着，切回 DM 就接着跑。' : '';
        return `已切到${MODE_LABEL[next]}，**下一轮运行生效**。${kept}`;
      },

      /**
       * `/剧本 [名字]` —— 把**引用的那个文件**收进剧本库（开一局的第 2 步，**可选**）。
       *
       * 不带名字时：引用了文件就用文件名当名字，没引用就是**列出剧本库**（清单里那两句正好
       * 也说了怎么再传一份）。旧写法 `/跑团 存剧本 <名字>` 随子命令一起去掉了 —— 那是同一条
       * 命令的第二份词形，留着就得在两处各写一遍。
       */
      async '/剧本'(input) {
        const name = wordsOf(input)[0] ?? scenarioNameFromFile(input.media);
        if (!name) return renderScenarioList(scenarioIds());
        return saveScenario(input, name, scenarios);
      },

      /**
       * `/开局 [剧本名] [规则表]` —— 开一局（第 3 步）。不带名字就是**选剧本**这一步。
       *
       * 它跟 DM 的 `campaign action=start` 走**同一个实现**（`beginCampaign`），所以两边的判据
       * （已经开过局怎么拒、剧本读不到怎么办、规则表坏了怎么办）不可能漂移。人在群里敲这一条，
       * 就不必指望模型从清单里挑对。
       */
      async '/开局'(input) {
        const [wanted, rule] = wordsOf(input);
        if (!wanted) {
          return '选一份剧本开局：`/开局 <剧本名> [规则表 id]`\n'
            + '（规则表 id 不填就用剧本推荐的那张）\n\n' + renderScenarioList(scenarioIds());
        }
        // 名字对得上就用那份剧本，对不上就当**标题**开一局（剧本是可选的，见 `/剧本`）。
        // 这里没有第二份判据：两种情况都交给同一个 `beginCampaign` 去拒（已经开过局等）。
        const useScenario = scenarios.read(wanted).ok;
        const args = useScenario ? { scenario: wanted, rule } : { title: wanted, rule };
        const result = beginCampaign(input.chatKey, args, { store, rules, scenarios });
        if (result.isError) return String(result.content);
        return String(result.content)
          + (useScenario ? '' : `\n（剧本库里没有「${wanted}」，这一局**没有注入剧本** —— 想用剧本就先传一份）`);
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
     * system prompt 的贡献：**人格 → （清单 + 剧本正文）→ 当前状态**，顺序不能反。
     *
     * 顺序即缓存：清单只在管理员改文件时变、剧本正文整局不变，而状态每轮都变。
     * 把两个稳定的排在状态之前，system prompt 的公共前缀才能命中到状态变化点之前；
     * 反过来的话，同一场团连着跑几轮会让**整段**系统提示每轮失效（见 `renderForModel` 顶部那段）。
     *
     * ⚠️ 本函数必须是**全函数**：装载时 `checkRuntimeShape` 会空着 `chatKey` 调它一次
     * （只做段落名对账），`store.read('')` 返回 `null`，于是渲染出"还没有开局"那段 ——
     * 不抛错、形状合法。这就是 `prompt(chatKey)` 要收参数、且不许抛的原因。
     * 中间那段也**永远非空**（规则清单至少有两个内置的），所以 body 恒为三段。
     */
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
        // 掷骰记进这一局的日志（同 `/掷骰`）。助手模式下通常没有战役 —— 有才记：那多半是
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
        // 所以把**可读的原因**说出去 —— 那正是敲错的人需要的下一步（同 `/掷骰`：文案原样进群，
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
            scenarios: usableScenarios().map((item) => ({ id: item.id, title: item.title })),
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
