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
import { MODE_LABEL, TrpgModeStore, parseMode } from './mode.js';
import { formatRoll, renderBriefing, renderForModel, renderStatusCard } from './render.js';
import { RuleStore } from './rule-store.js';
import { rollDice } from './rules/dice.js';
import { MAX_SCENARIO_BYTES, ScenarioStore, isFormattedScenario, saveScenarioText } from './scenario.js';
import { formatScenarioText } from './scenario-format.js';
import { TRPG_ASSISTANT_TOOLS, trpgSpec } from './spec.js';
import { TrpgStore, appendLog } from './state.js';
import { generateSuggestions } from './suggest.js';
import { beginCampaign, createHandlers } from './tools.js';
import type { MediaEntry } from '../../chat/types.js';
import type { ExtraRuntime, ExtraRuntimeDeps, ExtraRunEnd } from '../types.js';

/** `/跑团 存剧本` 的下载超时。这是**命令路径**（群友在等回执），不该被一个慢下载挂住。 */
const SAVE_TIMEOUT_MS = 15000;

/**
 * `/跑团 存剧本 <名字>` —— 把**被引用的那个文件**收进剧本库。
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
  name: string | undefined,
  scenarios: ScenarioStore,
  deps: SaveScenarioDeps = {}
): Promise<string> {
  const usage = '用法：/跑团 存剧本 <名字>\n'
    + '先把剧本作为**文件**发到群里（.md / .txt / .docx / .pdf 都行），再**引用（回复）**那条消息敲这一条。\n'
    + '名字就是以后 `/跑团 开局 <名字>` 用的那个。\n'
    + '（文件本来就是剧本格式的话直接用；只是普通设定/模组的话，会**让模型整理一遍**（多一点等待、也花一次调用）。）';
  if (!name) return usage;

  const file = input.media.find((item) => item.kind === 'file');
  if (!file) {
    return '引用的那条消息里没有文件。\n' + usage;
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
      + `\n开局：/跑团 开局 ${saved.scenario.id}`;
  } catch (error) {
    return `下载「${shown}」失败：${errorMessage(error)}`;
  }
}

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

  return {
    handlers: createHandlers({ store, rules, scenarios, rng: secureRng, deliverNote: deps.deliverNote }),

    commandHandlers: {
      /**
       * `/跑团` —— 不带参数时看这一局的**玩家视角**笔记。**零 LLM 成本**的确定性快路径
       * （同 `/转写` 那个取舍）：群友想确认"我现在几点血"不该惊动模型、也不该花一次模型调用。
       *
       * ⚠️ 它给的是**玩家视角**（`renderStatusCard` → `renderForPlayers`）：藏起来的人物与暗线
       * 旗标**根本不会出现**。给模型看的那一份（含全部隐藏信息）只在 `prompt()` 里走。
       *
       * 子命令 `开局 <剧本> [规则]` —— 与 DM 的 `campaign action=start` 走**同一个实现**
       * （`beginCampaign`），所以两边的判据（已经开过局怎么拒、剧本读不到怎么办、规则表坏了
       * 怎么办）不可能漂移。人在群里敲这一条，就不必指望模型从清单里挑对。
       */
      async '/跑团'(input) {
        // 按**词**切而不是正则剥前缀：子命令的参数是若干个词（`/跑团 开局 灯塔 coc7`），
        // 而 `/掷骰` 那边剥前缀是因为它的参数是一整条表达式。两者形状不同，别统一。
        const words = String(input.text ?? '').trim().split(/\s+/).slice(1);
        const mode = modes.read(input.chatKey);

        if (!words.length) {
          // 助手模式下**不该给状态卡**：它不注入状态、也不管战役，给一张"这个群还没开团"
          // 只会让人以为助手模式坏了。给的是"这个模式怎么用"。
          if (mode === 'assistant') {
            return `当前是${MODE_LABEL.assistant}：发一个骰子表达式（3d6、d20、2d6+3、4d6kh3…）我就掷。\n`
              + '要变成跑团（我当主持人）：`/跑团 模式 DM`。';
          }
          return renderStatusCard(store.read(input.chatKey));
        }

        if (words[0] === '模式') {
          const wanted = words[1];
          if (!wanted) {
            return `当前：${MODE_LABEL[mode]}\n`
              + '· `/跑团 模式 助手` —— 只掷骰\n'
              + '· `/跑团 模式 DM` —— 跑团，我当主持人';
          }
          const next = parseMode(wanted);
          if (!next) return `不认识的模式「${wanted}」。可用的是：助手（骰子）、DM（跑团）。`;
          if (next === mode) return `已经是${MODE_LABEL[mode]}了。`;
          modes.write(input.chatKey, next);
          // 切模式**不动战役存档**：切回 DM 时那一局还在原地等着（助手模式下它只是不被注入）。
          const kept = next === 'assistant' && store.read(input.chatKey) ? '这一局的存档留着，切回 DM 就接着跑。' : '';
          return `已切到${MODE_LABEL[next]}，**下一轮运行生效**。${kept}`;
        }

        if (words[0] === '开局' || words[0] === '开团') {
          const [, scenario, rule] = words;
          if (!scenario) {
            return '用法：/跑团 开局 <剧本名> [规则表 id]\n'
              + '剧本名见设置页「跑团」那一栏；规则表 id 不填就用剧本推荐的那张。';
          }
          const result = beginCampaign(input.chatKey, { scenario, rule }, { store, rules, scenarios });
          return String(result.content);
        }

        if (words[0] === '存剧本' || words[0] === '存') {
          return saveScenario(input, words[1], scenarios);
        }

        return `不认识的子命令「${words[0]}」。可用的是：\n`
          + '· `/跑团` —— 看你们已经知道的那份局势\n'
          + '· `/跑团 模式 [助手|DM]` —— 看 / 切换我当骰子助手还是当主持人\n'
          + '· `/跑团 开局 <剧本名> [规则表 id]` —— 用某份剧本开一局\n'
          + '· `/跑团 存剧本 <名字>` —— 引用一份剧本文件，把它收进剧本库';
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

    prompt(chatKey) {
      // **助手模式只有一段人格**：清单、剧本正文、当前状态一概不注入 —— 那些东西的存在本身
      // 就在暗示"你可以叙事、可以改状态"，而它这个形态下连那些工具都没有。
      if (modes.read(chatKey) === 'assistant') {
        return { body: [...EXTRA_PROMPT_SECTIONS.trpg.assistantBody] };
      }
      const campaign = store.read(chatKey);
      return {
        body: [
          ...EXTRA_PROMPT_SECTIONS.trpg.body,
          renderBriefing(campaign, {
            // 坏文件不进清单（它们本来也选不中），但它们仍然出现在设置页里 —— 那才是能修的地方。
            scenarios: scenarios.list().filter((item) => !item.problems.length)
              .map((item) => ({ id: item.id, title: item.title })),
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
