// `.trpg scenario [名字]` —— 把**被引用的那个文件**收进剧本库（从 `impl.ts` 拆出，2026-10-16）。
//
// ── 为什么是"引用一个文件"而不是"把正文贴在命令后面" ──
//
// 剧本动辄几千字，而 QQ 单条消息有长度上限。文件没有这个问题，而且**人写剧本本来就是在编辑器里
// 写一个文件**。被引用那条的媒体已经在 `ingest.ts` 里并进 `input.media` 了（那条 `if (slashCommand
// && repliedMedia.length)`），所以这里只要在 media 里找 `kind: 'file'` 就行 —— 不需要任何新口子。
//
// ── 两个"当场" ──
//
// ① `url` 是协议端给的**临时直链**（实测带签名），所以要**当场下**，不能存起来等下次用；
// ② 下载有**超时**（这是命令路径，群友在等回执，不该被一个慢下载挂住）。
//
// ── 权限 ──
//
// 与其余命令一致（白名单会话里可敲）。**已知代价**：白名单群里任何群友都能存剧本、也能覆盖同名剧本。
// 要收紧只需在这里加一条判据（同 `/能力` 的权限那一句话）。
//
// ── 三档，判据只有一条（P7-a）──
//
// 分档全靠 `isFormattedScenario`（确定性：有没有 frontmatter、能不能解析），**不引入第三个档**：
//
//   ① 格式本来就对 → **一次模型调用都不发**，直接落库。逐字未变。
//   ② 格式不对 → **抽取管线**（`scenario/extract/`）：切几片分别抽结构、归并、合成一份压缩正文，
//      产物是 `<id>.md` + `<id>.struct.json` + `<id>.raw/`。这是主路。
//   ③ 管线没成 → **退回原来那条**（`formatScenarioText`，一次调用只做格式整理），产物只有 `.md`。
//      回执里两件事都说：抽取没成、以及退一步只做了整理。
//
// 为什么 ② 必须存在而不是加强 ③：正文上限 `MAX_SCENARIO_CHARS` 是成本不是洁癖（它每轮进
// system prompt），而一份 30 页模组的正文是 5 万字量级 —— 让模型"整理一下"只会把一份超长的
// 正文整理成另一份超长的正文，然后被 `parseScenario` 拒绝。压缩 + 细节进结构 + 原文另存，
// 是唯一走得通的做法。见 `scenario/extract/pipeline.ts` 文件头。
import { errorMessage } from '../../../agent/tools/shared.js';
import { safeFetchBinary } from '../../../media/safe-fetch.js';
import { FORMAT_LABEL, extractDocumentText } from '../../../media/document/index.js';
import { SlidingWindowBudget } from '../../../media/call-budget.js';
import { SCENARIO_BUDGET } from '../model/limits.js';
import { MAX_SCENARIO_BYTES, isFormattedScenario } from '../scenario/parse.js';
import { saveScenarioText } from '../scenario/save.js';
import { formatScenarioText } from '../scenario/format.js';
import { extractScenario } from '../scenario/extract/pipeline.js';
import { createAskPort } from '../scenario/extract/prompt.js';
import { renderScenarioList, SCENARIO_USAGE } from '../render/status.js';
import { argsOf, scenarioIds } from './shared.js';
import type { CommandHandler } from './shared.js';
import type { MediaEntry } from '../../../chat/types.js';
import type { DocumentText } from '../../../media/document/index.js';
import type { ScenarioStore } from '../store/scenario-store.js';
import type { ExtraUsage } from '../../types.js';
import type { AskPort } from '../scenario/extract/prompt.js';
import type { ExtractResult } from '../scenario/extract/pipeline.js';

/** 下载超时。这是**命令路径**（群友在等回执），不该被一个慢下载挂住。 */
const SAVE_TIMEOUT_MS = 15000;

/**
 * 这条命令的调用闸门（每会话每小时 / 全局每天，见 `SCENARIO_BUDGET`）。
 *
 * ⚠️ **模块级单例是有意的**：滑动窗口的状态必须**跨调用累积**，放进 `execute` 里每次新建
 * 就等于没有闸门（同 `agent/tools/shared.ts` 的 `webBudget`）。这本账是**进程内的内存态**，
 * 重启即清零 —— 与 `media/call-budget.ts` 的既定取舍一致。
 *
 * 它整个 `createRuntime()` 共用一份：测试里造好几个运行时也读同一本账，所以套件要判"被限流"
 * 的用例得注入一个自己的实例（`ScenarioCommandDeps.budget`）。
 */
const scenarioBudget = new SlidingWindowBudget({ getLimits: () => SCENARIO_BUDGET });

export interface ScenarioCommandDeps {
  scenarios: ScenarioStore;
  /** 用量上报（透给 `saveScenario`）。缺省 = 不记账。 */
  recordUsage?: ((usage: ExtraUsage) => void) | null;
  /**
   * 调用闸门。缺省 = 模块级那本账（生产路径）。
   *
   * 套件要验"限额到了会怎样"时必须注入自己的实例 —— 共用一个进程内的账本会让断言依赖
   * "前面跑过几次"，那种前提在本仓库被踩过（见 AGENTS.md 的测试约定）。
   */
  budget?: SlidingWindowBudget;
  /**
   * 往会话里补一句话（宿主的口子，见 `ExtraRuntimeDeps.sendText`）。
   *
   * **接了它 = 需要模型的那一半改到后台跑**（先回一句"正在抽"，抽完再发回执）；
   * **没接 = 就地跑完再返回**（套件与未接线的宿主走这条）。
   */
  sendText?: ((chatKey: string, text: string) => Promise<void>) | null;
  /**
   * 透给 `openScenario` / `finishScenario` 的注入点（`extract` / `analyze` / `format` / `ask`）。
   * **只给套件用**，生产路径一个都不传 —— 见 `SaveScenarioDeps` 里那段说明。
   */
  save?: SaveScenarioDeps;
  /** 这条命令的词（`'.trpg scenario'`）—— 由 `commands/index.ts` 递进来，见 `argsOf`。 */
  command: string;
}

/**
 * `.trpg scenario [名字]` —— 不带名字时：引用了文件就用文件名当名字，没引用就是**列出剧本库**
 * （清单里那两句正好也说了怎么再传一份）。
 *
 * ── 为什么要分成"前半就地、后半交出去"（2026-10-19）──
 *
 * 前半（下载 + 解字节）是几秒的事；后半在**需要模型**时最多 90 秒（`EXTRACT_TOTAL_BUDGET_MS`）。
 * 而命令是被 `ingest.ts` 的 `enqueueIngest` **按会话串行** await 的 —— 也就是说那 90 秒里
 * 这个群的所有消息都排在后面：不落档、不唤醒、面板不动。群里看到的是"传完剧本之后机器人
 * 死了"。同一条链上，`/转写` 与 `/画` 早就把几十秒的活交给各自的单并发后台队列了，
 * `.trpg scenario` 是这三件里最重的一件，偏偏是唯一没交出去的。
 *
 * 判据是**确定性的**：`isFormattedScenario`（格式本来就对 → 后半不花调用，就地跑完）。
 * 所以常见的"传一份写好的 `.md`"仍然是一条回执，只有真的要抽剧情时才多一句。
 */
export function createScenarioCommand({
  scenarios, recordUsage, budget, sendText, save, command
}: ScenarioCommandDeps): CommandHandler {
  const ledger = budget ?? scenarioBudget;
  return async (input) => {
    const name = argsOf(input, command)[0] ?? scenarioNameFromFile(input.media);
    if (!name) return renderScenarioList(scenarioIds(scenarios));
    // 闸门排在最前面（顺序与 `/转写` `/画` 一致：**被拒的那一次不占额度、也不做任何事**）。
    // 记账按"敲了几次"算而不是"发了几次模型调用"：后者要等下载 + 解字节之后才知道，
    // 而那两件事已经做了 —— 闸门就没意义了。代价是格式本来就对的 `.md`（0 次调用）也占一格，
    // 方向偏保守（同 image-source 那条"命中缓存的重复查询也占额度"）。
    try {
      ledger.take(input.chatKey);
    } catch {
      return '传剧本太频繁了 —— 一小时最多 5 次（每次最多 7 次模型调用，这份额度是一起算的）。'
        + '过一会儿再传，或者让管理员直接把文件放进 `data/trpg/scenarios/`。';
    }
    // ⚠️ `recordUsage` **放在 `...save` 之后**：它是宿主的口子，不该被测试的注入点顶掉。
    const deps: SaveScenarioDeps = { ...(save ?? {}), recordUsage };
    // 前半就地跑（几秒）。它自己会把"没有文件 / 没有下载地址 / 读不出来"那三种早退回出去。
    const opened = await openScenario(input, deps);
    if (!opened.ok) return opened.message;
    const { doc, shown } = opened.opened;
    const needsModel = !isFormattedScenario(doc.text, name);
    if (!sendText || !needsModel) {
      return finishScenario(doc, shown, name, scenarios, deps);
    }
    // 需要模型 → 交到后台，先回一句"正在抽"。**不 await**：await 就等于没拆。
    void finishScenario(doc, shown, name, scenarios, deps)
      .then((receipt) => sendText(input.chatKey, receipt))
      .catch((error) => {
        // 走到这里说明 `finishScenario` 自己抛了（它内部把该接的都接了），或者宿主发不出去。
        // 两种都不该把异常打到入站链上 —— 那条链已经走完了。
        console.warn('[trpg] 剧本抽取的后台任务失败:', error instanceof Error ? error.message : error);
      });
    return `正在收「${shown}」—— 这份不是剧本格式，要先抽剧情结构（最多 7 次模型调用，可能要一分钟）。`
      + '抽完我在这里发一条回执；这期间群里照常说话。';
  };
}

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
  /**
   * 剧情抽取管线（P7-a）。缺省 `extractScenario` —— 真跑四级流水线，会发**多次**模型调用。
   *
   * 它与 `format` **不是二选一**：管线是主路，`format` 是它的后备（管线没成时退回去，
   * 只把原文整理成规定格式）。既有那几条用例验的正是后备那条路，所以它们注入一个
   * "必定失败"的实现（见 `t-trpg.mjs`），于是照旧走 `format`。
   */
  analyze?: typeof extractScenario;
  /** 管线的模型调用端口。缺省 `createAskPort(recordUsage)`（真走 `chatCompletion`）。 */
  ask?: AskPort;
  /**
   * 用量上报（2026-10-19 补）。这条路最多发 **6 次**模型调用（`MAX_CHUNKS` 片 + 一次归并），
   * 或者后备那次整理 1 次 —— 它们是"传一份剧本"的全部成本，不记账就没人知道它花了多少。
   *
   * 缺省 = 不记账、**调用照常**（测试与未接线的宿主）。
   */
  recordUsage?: ((usage: ExtraUsage) => void) | null;
  /** 现在几点（毫秒）。管线的死线靠它算 —— 测试可以给一个自己控制的钟。 */
  now?: () => number;
}

/**
 * 引用的那个文件叫什么（去掉扩展名）。取不到返回 `null`。
 *
 * 导出只为单测：它上面那条路（`.trpg scenario` 不带名字）会真的去下载并**起 Python 抽文本**，
 * 而仓库的测试约定是不启动真解释器 —— 所以判据在这一层单独钉。
 */
export function scenarioNameFromFile(media: readonly MediaEntry[]): string | null {
  const file = media.find((item) => item.kind === 'file');
  if (!file) return null;
  const raw = String(file.name ?? file.file ?? '').trim();
  return raw.replace(/\.[a-z0-9]+$/i, '').trim() || null;
}

/** 下载 + 解字节之后的东西。`shown` 是给人看的文件名（回执里要用）。 */
export interface OpenedScenario {
  doc: DocumentText;
  shown: string;
}

export type OpenScenarioOutcome = { ok: true; opened: OpenedScenario } | { ok: false; message: string };

/**
 * 这条命令的**前半**：从引用里认出文件 → 下载 → 字节转文本。**一次模型调用都不发。**
 *
 * ⚠️ 拆成两半是为了让"要不要让模型干活"这个决定落在**命令层**（见 `createScenarioCommand`）：
 * 需要模型的那一半最多跑 90 秒（`EXTRACT_TOTAL_BUDGET_MS`），而它不该把整个群的入站处理链
 * 堵住 —— 那条链是**按会话串行**的（`ingest.ts` 的 `enqueueIngest`），堵住它的表现是
 * "传完剧本之后的一分钟里，这个群说什么都没反应、面板也不动"。
 *
 * `saveScenario` 仍然把两半串起来：套件与"宿主没接异步口子"的那条路走的就是它。
 */
export async function openScenario(
  input: { media: readonly MediaEntry[] },
  deps: SaveScenarioDeps = {}
): Promise<OpenScenarioOutcome> {
  // 名字由调用方决定（显式给的，或从文件名推的）—— 推不出来时它已经回过 `SCENARIO_USAGE` 了，
  // 所以这里不必再兜一次。
  const file = input.media.find((item) => item.kind === 'file');
  if (!file) {
    return { ok: false, message: `引用的那条消息里没有文件。\n${SCENARIO_USAGE}` };
  }
  const shown = String(file.name ?? '').trim() || String(file.file ?? '').trim() || '（没有名字的文件）';
  const url = typeof file.url === 'string' ? file.url : '';
  if (!url) {
    return {
      ok: false,
      message: `拿到了「${shown}」，但协议端没给下载地址（只给了 file_id）—— 这条路暂时下不来，`
        + '把文件内容贴成一条消息、或者直接放进 `data/trpg/scenarios/` 都行。'
    };
  }

  try {
    const { buffer } = await safeFetchBinary(url, MAX_SCENARIO_BYTES, AbortSignal.timeout(SAVE_TIMEOUT_MS));
    // 字节 → 文本交给**通用能力**（`media/document/`）：剧本因此可以直接传 .pdf / .docx，
    // 而不只是 UTF-8 的 .md / .txt。那一步要起 Python 子进程，所以下面单独接一段错误 ——
    // "下载失败"与"读不出来"是两件事，压成一句会让人往错的方向查。
    try {
      const doc = await (deps.extract ?? extractDocumentText)(buffer);
      return { ok: true, opened: { doc, shown } };
    } catch (error) {
      return { ok: false, message: `读「${shown}」失败：${errorMessage(error)}` };
    }
  } catch (error) {
    return { ok: false, message: `下载「${shown}」失败：${errorMessage(error)}` };
  }
}

/**
 * 这条命令的**后半**：格式匹配 →（抽取管线 / 一次整理）→ 落库 + 伴生文件 → 回执。
 *
 * ⚠️ **这一段会发模型调用**（最多 `MAX_CHUNKS + 1` = 7 次），所以命令层要决定是就地跑还是
 * 交到后台（见 `createScenarioCommand`）。返回值就是群里要看到的那段文本。
 */
export async function finishScenario(
  doc: DocumentText,
  shown: string,
  name: string,
  scenarios: ScenarioStore,
  deps: SaveScenarioDeps = {}
): Promise<string> {
  // ── 先做**格式匹配** ──
  //
  // 判据是确定性的（有没有 frontmatter、能不能解析），不是"看起来像不像"。**格式本来就对的
  // 文件一次模型调用都不发** —— 那是这条命令的快路径。上传的是 PDF 模组、一段裸设定，
  // 或者 frontmatter 里的 JSON 写坏了，才走下面这条要花调用的路。
  const sourceLabel = FORMAT_LABEL[doc.format];
  const usedModel = !isFormattedScenario(doc.text, name);
  let finalText = doc.text;
  let analysis: ExtractResult | null = null;
  let extractionNote = '';
  if (usedModel) {
    // 主路：**抽取管线**。它把原文切成几片分别抽、归并成结构化剧情，再合成一份压缩正文 ——
    // 一份 30 页模组的正文塞不进 `MAX_SCENARIO_CHARS`，所以"压缩 + 细节进结构 + 原文另存"
    // 是这条路唯一走得通的做法（见 `extract/pipeline.ts` 文件头）。
    const outcome = await (deps.analyze ?? extractScenario)(doc.text, { name, source: sourceLabel }, {
      ask: deps.ask ?? createAskPort(deps.recordUsage),
      ...(deps.now ? { now: deps.now } : {})
    });
    if (outcome.ok) {
      analysis = outcome.result;
      finalText = outcome.result.body;
    } else {
      // 后备：**只让模型把原文整理成规定格式**（这条命令原来唯一的那条路，一次调用）。
      // 两条都失败时把**两条原因都说出来**：管线那句说的是哪一片、哪一步没成，后备那句
      // 说的是"连整理都没成" —— 只说一句会把一半事实丢掉。
      const formatted = await (deps.format ?? formatScenarioText)(
        doc.text, { name, source: sourceLabel }, deps.recordUsage
      );
      if (!formatted.ok) {
        return `${shown}：${outcome.message}（退一步只做格式整理也没成：${formatted.message}）`;
      }
      finalText = formatted.text;
      extractionNote = `剧情抽取没成（${outcome.message}），只做了格式整理 —— `
        + '这份剧本没有剧情结构，DM 只能从正文里自己读。';
    }
  }
  const saved = saveScenarioText(name, { ...doc, text: finalText }, scenarios);
  if (!saved.ok) return `${shown}：${saved.message}`;
  // 抽取产物落成**伴生文件**（`.struct.json` + `.rule.json` + `raw/`）。写失败**不回滚**：
  // `.md` 已经是好的，一个旁路文件坏了不该让整份剧本白传一次 —— 如实说出去（同 `writeExtras` 那条约定）。
  let extrasProblem = '';
  if (analysis) {
    const written = scenarios.writeExtras(saved.scenario.id, {
      struct: analysis.struct,
      // ⚠️ **一条机制都没抽到时不传 `ruleExt`**（判据是 `analysis.ruleExt` 非空，不是"传了 null"）：
      // `writeExtras` 的约定是"给了才动"，而 `null` 是一个**给了**的值 —— 它会在剧本目录里落一个
      // 写着 `null` 的 `.rule.json`，然后 `.trpg check` 报一句"0 条机制"，看起来像抽坏了。
      ...(analysis.ruleExt ? { ruleExt: analysis.ruleExt } : {}),
      raw: analysis.chunks.map((chunk) => ({ heading: chunk.heading, text: chunk.text }))
    });
    if (!written.ok) extrasProblem = written.message;
  }
  const skeleton = [
    Object.keys(saved.scenario.flags).length ? `${Object.keys(saved.scenario.flags).length} 条旗标` : '',
    saved.scenario.characters.length ? `${saved.scenario.characters.length} 张人物卡` : ''
  ].filter(Boolean).join('、');
  // 来源格式要说出来。**整理过的那一次也要说**：它是"回执为什么慢了"与"内容为什么被重排过"
  // 的唯一线索，不说的话群友只会看到一份与自己手里不一样的剧本，而不知道为什么。
  const origin = [sourceLabel, ...(doc.pages === undefined ? [] : [`${doc.pages} 页`]),
    ...(doc.encoding && doc.encoding !== 'utf-8' ? [`按 ${doc.encoding} 解码`] : [])].join('，');
  // ⚠️ 判据是 `!analysis` 而不是 `usedModel`：两档都要花调用，但**只有后备那一档是"整理"**。
  // 抽取那一档已经把同一件事说得更准了（`extractedNote` 会报切了几片、用了几次），再补一句
  // "已让模型整理过"等于把"抽取"降格成"排版" —— 管理员会以为这份剧本只有格式被动过，
  // 而实际上它的剧情结构已经被抽出来并压缩过了。
  const formattedNote = usedModel && !analysis
    ? `原文不是剧本格式，已让模型整理过（原文 ${doc.text.length} 字）。\n` : '';
  // 抽取结果的一句话账。**"抽了几片"与"还有多少字没抽"分开说**：后者是管理员判断"要不要
  // 手工再传一次"的唯一依据（原文切片只到片数上限，超出的那些字一份都没进）。
  // 有待核项时**指向 `.trpg check`**（P7-b 起才有那条命令）：这一行只报得出条数，逐条看要
  // 另敲一条 —— 而不指路的话，"待核项 3 条"就成了一句没法追问的话。没有待核项时**不提它**：
  // 那时没有任何东西可看，提一句只是噪音（命令清单里本来就有它）。
  const extractedNote = analysis
    ? `抽出了 ${analysis.struct.scenes.length} 个场景、${analysis.struct.npcs.length} 个 NPC、`
      + `${analysis.struct.clues.length} 条线索、${analysis.struct.items.length} 件道具、`
      + `${analysis.struct.mechanics.length} 条机制（原文 ${analysis.totalChars} 字切成 `
      + `${analysis.chunks.length} 片，用了 ${analysis.calls} 次调用`
      + (analysis.droppedChars > 0 ? `，还有 ${analysis.droppedChars} 字超出片数上限没进抽取` : '')
      + '）。'
      + (analysis.struct.warnings.length
        ? `待核项 ${analysis.struct.warnings.length} 条 —— 敲 \`.trpg check ${saved.scenario.id}\` 逐条看。`
        : '没有待核项。')
    : '';
  return `${formattedNote}已存剧本「${saved.scenario.id}」：标题「${saved.scenario.title}」`
    + `${skeleton ? `，带 ${skeleton}` : ''}，正文 ${saved.scenario.body.length} 字（来源 ${origin}）。`
    + (saved.ignored.length ? `（忽略了不认识的字段：${saved.ignored.join('、')}）` : '')
    + (extractionNote ? `\n${extractionNote}` : '')
    + (extractedNote ? `\n${extractedNote}` : '')
    + (extrasProblem ? `\n伴生文件没写进去：${extrasProblem}（剧本本身是好的，重传一次能补上）。` : '')
    // 开局那一句必须是**真能开局的词形**：`.trpg new <名字> [规则表]`（`.trpg start`
    // 不带参数，它只把 `preparing` 推到 `active`）。照抄 `start` 的话群友敲下去只会拿到
    // 一句「用法：`.trpg start`（不带参数）」—— 回执把人带错，而且没有任何报错。
    + `\n开局：.trpg new ${saved.scenario.id}`;
}

/**
 * 下载 → 抽文本 → 格式匹配（必要时让模型整理）→ 落库。**前半 + 后半，一次性跑完。**
 *
 * 这条路**会占住调用方**（最长约 90 秒）。生产路径上 `.trpg scenario` 只在"宿主没接
 * `sendText`"时才走它（见 `createScenarioCommand`）；套件也一律走它 —— 它们注入
 * `extract` / `analyze` / `format`，从不真的发调用。
 */
export async function saveScenario(
  input: { media: readonly MediaEntry[] },
  name: string,
  scenarios: ScenarioStore,
  deps: SaveScenarioDeps = {}
): Promise<string> {
  const opened = await openScenario(input, deps);
  if (!opened.ok) return opened.message;
  return finishScenario(opened.opened.doc, opened.opened.shown, name, scenarios, deps);
}
