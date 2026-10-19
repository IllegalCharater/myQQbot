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
import type { ExtractBudget } from '../model/limits.js';
import type { ExtractFailureKind, ExtractResult, ExtractSalvage } from '../scenario/extract/pipeline.js';

/** 下载超时。这是**命令路径**（群友在等回执），不该被一个慢下载挂住。 */
const SAVE_TIMEOUT_MS = 15000;

/**
 * 引用里那个文件**没有名字**时的占位。
 *
 * 两处认它，所以必须只有一个字面量：`openScenario` 拿它兜底（协议端没给 `name` 也没给 `file`），
 * `finishScenario` 拿它判断"来源那一栏要不要带上文件名" —— 写成两份的话，回执上会出现
 * `文本「（没有名字的文件）」` 这种把兜底话术当文件名的东西，而没有任何报错。
 */
const NO_FILE_NAME = '（没有名字的文件）';

/**
 * 抽取失败之后那句"下一步"—— **按 `kind` 分档**（2026-10-19 加）。
 *
 * 原先无论哪种失败，回执末尾都是同一句"要重试就把原文件重新发一次"。于是**配置性的
 * 必然失败**被说成了"偶发，建议重试"：管理员拿着一次真实的失败去撞同一堵墙，而回执
 * 本身没给他任何别的线索（实测就是这份 7345 字的《回声公寓》：预算在 L3 处正好用光，
 * 重发一次会以同样的方式、在同一个地方再失败一次）。
 *
 * 分档的判据只有一条：**重发一次有没有用**。
 *   - `timeout` 没用 —— 同一份文件、同样的片数、同样的死线。要的是"拆小/自己写"。
 *   - `empty`   没用 —— 文件里压根没有可抽的文字。要的是"换一份"。
 *   - `format` / `request` 有用 —— 这两档才是真的偶发。
 *
 * ⚠️ **写成 `Record<ExtractFailureKind, string>` 而不是 `switch`**：新增一个 kind 时
 * `tsc` 会当场报错，而 `switch` 会静默走 `default`。这与 `ENGINE_ROWS` / `ORDER` 那两张表
 * 是同一条纪律（穷尽性是有用的信号，别把它丢掉）。
 *
 * ⚠️ 这些句子**群友可见**，不许出现 Markdown 的 `**`（5q 段会扫这个目录）。
 */
const EXTRACT_ADVICE: Record<ExtractFailureKind, string> = {
  timeout: '这次是时间不够：原文太长，切成几片分别抽取时把预算用光了。重发一次多半还是不够 —— '
    + '同一份文件、同样的片数、同样的死线。把原文件拆成几份分别传，'
    + '或者自己按剧本格式写一份 `.md`（开头几行写 `title:` / `flags:`）再传，都比重发管用。',
  empty: '这份文件里没有能抽的正文（扫描件、或者正文全是图片）—— 重发一次结果一样，换成带文字的版本再传。',
  format: '模型这次没按格式答（抽取结果解不动、或者合成出来的东西没有剧本骨架）—— '
    + '这一档是偶发的，把原文件重新发一次、引用它敲 `.trpg scenario` 通常就好了。',
  request: '模型请求本身失败了（网络或接口的问题，与这份文件无关）—— '
    + '过一会儿把原文件重新发一次、引用它敲 `.trpg scenario`。'
};

/** 分档没认出来时的兜底。**不是**"再试一次"，而是"先去看日志"。 */
const UNKNOWN_ADVICE = '先看一眼日志里那条 `[trpg]` 的原始报错再决定要不要重发 —— 这次失败的类别没认出来。';

/**
 * 取某一档的"下一步"。
 *
 * ⚠️ **收 `undefined` 并给出兜底**：`analyze` 是**注入的**，套件里那些假管线返回的失败对象
 * 可能压根没有 `kind`（本仓库的假端点就是普通对象字面量）。少了这层兜底，群里会出现一句
 * `undefined` —— 而那正是本仓库反复踩过的那类"看着像能跑"的静默失败。
 */
export function extractFailureAdvice(kind: ExtractFailureKind | undefined): string {
  return (kind && EXTRACT_ADVICE[kind]) || UNKNOWN_ADVICE;
}

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
   * 抽取的两个时间预算（`{totalMs, callMs}`）。**缺省 = 不传**，管线落回
   * `DEFAULT_EXTRACT_BUDGET`（两个默认常量）—— 于是既有调用点与全部套件逐字不变。
   *
   * ⚠️ **它与上面那个 `budget` 是两回事**（名字撞了，但语义毫不相干）：那个是**调用闸门**
   * （一本滑动窗口的账），这个是**时间预算**。所以这一个叫 `extractBudget`。
   *
   * ⚠️ **是 getter 不是值**：改完设置页该在下一次敲命令时就生效（同
   * `webSearch.fetchTextMaxChars` 那条"每次调用现读配置"）。传一个快照进来的话，改完要重启
   * 才生效，而症状是"填了、看着生效、实际按旧值走"。
   */
  extractBudget?: () => ExtractBudget;
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
 * 前半（下载 + 解字节）是几秒的事；后半在**需要模型**时最多跑 `trpg.extractTotalBudgetMs`
 * （默认 5 分钟）。而命令是被 `ingest.ts` 的 `enqueueIngest` **按会话串行** await 的 ——
 * 也就是说那几分钟里
 * 这个群的所有消息都排在后面：不落档、不唤醒、面板不动。群里看到的是"传完剧本之后机器人
 * 死了"。同一条链上，`/转写` 与 `/画` 早就把几十秒的活交给各自的单并发后台队列了，
 * `.trpg scenario` 是这三件里最重的一件，偏偏是唯一没交出去的。
 *
 * 判据是**确定性的**：`isFormattedScenario`（格式本来就对 → 后半不花调用，就地跑完）。
 * 所以常见的"传一份写好的 `.md`"仍然是一条回执，只有真的要抽剧情时才多一句。
 */
export function createScenarioCommand({
  scenarios, recordUsage, budget, extractBudget, sendText, save, command
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
      // ⚠️ 单位是**份**（= 敲了几次），不是"几次模型调用"（2026-10-19 澄清）：
      // 一次触发的成本在 0（格式本来就对）/ 1（后备整理）/ 7（管线）之间浮动，
      // 而闸门排在下载之前、只知道"敲了一次"。别把这句话改回"5 次调用"。
      return '传剧本太频繁了 —— 一小时最多 5 份（一份最多 7 次模型调用；格式本来就对的那份一次都不发）。'
        + '过一会儿再传，或者让管理员直接把文件放进 `data/trpg/scenarios/`。';
    }
    // ⚠️ 三者的优先级（后写的赢）：宿主那份预算 → 测试注入的 `save` → `recordUsage`。
    // 宿主那份**在这里现读一次**（不是构造时读一次）：设置页改完，下一次敲命令就生效。
    const deps: SaveScenarioDeps = {
      ...(extractBudget ? { extractBudget: extractBudget() } : {}),
      ...(save ?? {}),
      recordUsage
    };
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
    return `正在收「${shown}」—— 这份不是剧本格式，要先抽剧情结构（最多 7 次模型调用，可能要几分钟）。`
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
   * 管线那两个时间预算，透给 `extractScenario` 的 `deps.budget`。
   *
   * 缺省 = 不传，管线落回 `DEFAULT_EXTRACT_BUDGET`（= `limits.ts` 的两个默认常量），
   * **既有套件因此逐字不变** —— 只有生产路径（`impl.ts` 从 `getConfig().trpg` 读）会传它。
   */
  extractBudget?: ExtractBudget;
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
 * 需要模型的那一半最多跑 `trpg.extractTotalBudgetMs`（默认 5 分钟），而它不该把整个群的入站处理链
 * 堵住 —— 那条链是**按会话串行**的（`ingest.ts` 的 `enqueueIngest`），堵住它的表现是
 * "传完剧本之后的几分钟里，这个群说什么都没反应、面板也不动"。
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
  const shown = String(file.name ?? '').trim() || String(file.file ?? '').trim() || NO_FILE_NAME;
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
  // 抽取没成时抢救下来的东西（原文切片 + 半份结构，见 `ExtractSalvage`）。它**只在降级路径**
  // 上有值，而那条路正是"磁盘上只剩一份被重排过的正文"的那条 —— 所以要把它交出去。
  let salvage: ExtractSalvage | null = null;
  let extractionNote = '';
  if (usedModel) {
    // 主路：**抽取管线**。它把原文切成几片分别抽、归并成结构化剧情，再合成一份压缩正文 ——
    // 一份 30 页模组的正文塞不进 `MAX_SCENARIO_CHARS`，所以"压缩 + 细节进结构 + 原文另存"
    // 是这条路唯一走得通的做法（见 `extract/pipeline.ts` 文件头）。
    const outcome = await (deps.analyze ?? extractScenario)(doc.text, { name, source: sourceLabel }, {
      ask: deps.ask ?? createAskPort(deps.recordUsage),
      ...(deps.now ? { now: deps.now } : {}),
      // ⚠️ **缺省不传**（不是传一个"默认值"）：管线的 `deps.budget` 自己缺省成
      // `DEFAULT_EXTRACT_BUDGET`，两处各写一份默认值必然漂移。
      ...(deps.extractBudget ? { budget: deps.extractBudget } : {})
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
        return `${shown}：[剧情抽取] 没成（${outcome.message}）；[格式整理] 也没成（${formatted.message}）。`
          + `\n${extractFailureAdvice(outcome.kind)}`;
      }
      finalText = formatted.text;
      // ⚠️ **防御性读取**：`analyze` 是**注入的**，套件里的假管线是普通对象字面量，可能压根
      // 没有 `salvage`（同 `kind` 那条）。少了这层兜底，回执会拼出一个 `undefined`。
      salvage = outcome.salvage ?? null;
      // ⚠️ **两个阶段分开说**（2026-10-19 加）。原先这两件事混在一句话里，于是回执**自相矛盾**：
      // "带 8 条旗标、4 张人物卡"（那是**格式整理**给的）与"没有剧情结构"（那是**剧情抽取**没成）
      // 并排出现，读起来像"抽了、但抽了个空的"。真相是两个阶段**各给了一半** —— 整理那一步
      // 只重排正文、顺手交出骨架里的旗标与人物卡；抽取那一步才是场景 / NPC / 线索 / 道具 /
      // 机制的来源，而它这次没成。实测就是这份 7345 字的《回声公寓》：管理员看到"8 条旗标、
      // 4 张人物卡"再看到"没有剧情结构"，只会以为抽取坏了，而不知道该往哪儿查。
      // ⚠️ 那句"下一步"**按 `outcome.kind` 分档**，不再固定说"建议重试"（见 `EXTRACT_ADVICE`）。
      // ⚠️ 群友可见，不许有 Markdown 的 `**`（5q 段会扫这个目录）。
      extractionNote = `[剧情抽取] 没成（${outcome.message}）。`
        + `\n[格式整理] 原文不是剧本格式（${doc.text.length} 字），已让模型按剧本格式重排了一遍 —— `
        + '上面那份正文就是它写的（上面那句里的旗标与人物卡也是它给的）。'
        + '场景、NPC、线索、道具、机制一条都没有，DM 只能从正文里自己读。'
        + '这一局不会应用剧本里的特殊规则。'
        + `\n${extractFailureAdvice(outcome.kind)}`;
    }
  }
  const saved = saveScenarioText(name, { ...doc, text: finalText }, scenarios);
  if (!saved.ok) return `${shown}：${saved.message}`;
  // 抽取产物落成**伴生文件**（`.struct.json` + `.rule.json` + `raw/`）。写失败**不回滚**：
  // `.md` 已经是好的，一个旁路文件坏了不该让整份剧本白传一次 —— 如实说出去（同 `writeExtras` 那条约定）。
  //
  // ⚠️ **降级路径也要写**（2026-10-19 加），而且那正是它最要紧的一次：抽取没成时 `raw/` 是这份
  // 文件**唯一**的完整副本 —— 后备那条路只把原文重排一遍，实测 7345 字进去、2687 字出来。
  // 原先这一档什么都不写，于是管理员手里只剩一份被砍掉 63% 的正文，连回去对照原文都做不到。
  let extrasProblem = '';
  if (usedModel) {
    // 结构**可能没有**（一片都没抽成）；规则扩展**降级路径一定没有** —— 两处 ⚠️ 见下。
    const struct = analysis ? analysis.struct : salvage?.struct ?? null;
    const ruleExt = analysis ? analysis.ruleExt : null;
    const chunks = analysis ? analysis.chunks : salvage?.chunks ?? [];
    // 三样都是"有才传"（`writeExtras` 的约定），所以一片都没抽成时这里**一个键都没有** ——
    // 那就不必调它：`write()` 那一步已经把上一次留下的伴生文件清掉了。
    if (struct || ruleExt || chunks.length) {
      const written = scenarios.writeExtras(saved.scenario.id, {
        // ⚠️ **一条机制都没抽到时不传 `ruleExt`**（判据是它非空，不是"传了 null"）：
        // `writeExtras` 的约定是"给了才动"，而 `null` 是一个**给了**的值 —— 它会在剧本目录里落一个
        // 写着 `null` 的 `.rule.json`，然后 `.trpg check` 报一句"0 条机制"，看起来像抽坏了。
        ...(struct ? { struct } : {}),
        // ⚠️ **降级路径绝不写 `ruleExt`**：`.rule.json` 是 `ruleSetFor` 在**开局**时读的那一份，
        // 写了它就等于那一局**真的会应用特殊规则**，而回执上明明写着"不会"。宁可少一样产物，
        // 也不要让回执里那句话变成谎话（`analysis ? … : null` 这一行就是那条边界）。
        ...(ruleExt ? { ruleExt } : {}),
        ...(chunks.length ? { raw: chunks.map((chunk) => ({ heading: chunk.heading, text: chunk.text })) } : {})
      });
      if (!written.ok) extrasProblem = written.message;
    }
  }
  const skeleton = [
    Object.keys(saved.scenario.flags).length ? `${Object.keys(saved.scenario.flags).length} 条旗标` : '',
    saved.scenario.characters.length ? `${saved.scenario.characters.length} 张人物卡` : ''
  ].filter(Boolean).join('、');
  // 来源格式要说出来。**整理过的那一次也要说**：它是"回执为什么慢了"与"内容为什么被重排过"
  // 的唯一线索，不说的话群友只会看到一份与自己手里不一样的剧本，而不知道为什么。
  //
  // ⚠️ **光印「文本」两个字没有信息量**（2026-10-19 补）：同一批上传里常常有好几份文本，
  // 而回执里只有格式名时，管理员对不上自己刚发的是哪一份（`文本` 既可能是那份 `.md`、
  // 也可能是随手贴的一段设定）。所以带上**文件名** —— 它与 `openScenario` 的兜底同源
  // （`NO_FILE_NAME`），没有名字时不硬凑，退回裸的格式名。
  const originLabel = shown === NO_FILE_NAME ? sourceLabel : `${sourceLabel}「${shown}」`;
  const origin = [originLabel, ...(doc.pages === undefined ? [] : [`${doc.pages} 页`]),
    ...(doc.encoding && doc.encoding !== 'utf-8' ? [`按 ${doc.encoding} 解码`] : [])].join('，');
  // 抽取结果的一句话账。**"抽了几片"与"还有多少字没抽"分开说**：后者是管理员判断"要不要
  // 手工再传一次"的唯一依据（原文切片只到片数上限，超出的那些字一份都没进）。
  // 有待核项时**指向 `.trpg check`**（P7-b 起才有那条命令）：这一行只报得出条数，逐条看要
  // 另敲一条 —— 而不指路的话，"待核项 3 条"就成了一句没法追问的话。没有待核项时**不提它**：
  // 那时没有任何东西可看，提一句只是噪音（命令清单里本来就有它）。
  //
  // ⚠️ **开头那个阶段标签是回执自洽的唯一依据**（2026-10-19 加）：降级路径上另有一句
  // `[格式整理]`，两个标签并排，"哪一半是谁给的"才读得出来。原先没有标签，两条信息撞在
  // 一起就成了"带 8 条旗标、4 张人物卡"+"没有剧情结构"这种自相矛盾（见上面 `extractionNote`）。
  // ⚠️ 标签用 `[...]` 而**不是** Markdown 的 `**`（5q 段会扫这个目录）。
  const extractedNote = analysis
    ? `[剧情抽取] 抽出了 ${analysis.struct.scenes.length} 个场景、${analysis.struct.npcs.length} 个 NPC、`
      + `${analysis.struct.clues.length} 条线索、${analysis.struct.items.length} 件道具、`
      + `${analysis.struct.mechanics.length} 条机制（原文 ${analysis.totalChars} 字切成 `
      + `${analysis.chunks.length} 片，用了 ${analysis.calls} 次调用`
      + (analysis.droppedChars > 0 ? `，还有 ${analysis.droppedChars} 字超出片数上限没进抽取` : '')
      + '）。'
      + (analysis.struct.warnings.length
        ? `待核项 ${analysis.struct.warnings.length} 条 —— 敲 \`.trpg check ${saved.scenario.id}\` 逐条看。`
        : '没有待核项。')
    : '';
  // 降级路径的**唯一线索出口**（2026-10-19 加）：抽取没成时，管理员在群里一处都看不到
  // "这次到底留下了什么" —— 原文切片、抽到一半的结构、以及没抽成的那些片。`.trpg check`
  // 零模型调用、零写入，正是为这个场景存在的（见 `commands/verify.ts` 文件头）。
  //
  // ⚠️ **只在真有东西可看时才指路**：一片都没抽成、或者伴生文件根本没写进去的时候，指过去
  // 只会让人敲一条什么都不报的命令（那比不指路更坏：他会以为是自己敲错了）。
  const salvagePointer = salvage && !extrasProblem && (salvage.chunks?.length ?? 0) > 0
    ? `这次留下的东西：敲 \`.trpg check ${saved.scenario.id}\` 看（零模型调用）—— `
      + `原文切片 ${salvage.chunks.length} 片`
      + (salvage.struct ? '、抽到一半的剧情结构' : '')
      + '都在那里。'
    : '';
  return `已存剧本「${saved.scenario.id}」：标题「${saved.scenario.title}」`
    + `${skeleton ? `，带 ${skeleton}` : ''}，正文 ${saved.scenario.body.length} 字（来源 ${origin}）。`
    + (saved.ignored.length ? `（忽略了不认识的字段：${saved.ignored.join('、')}）` : '')
    + (extractionNote ? `\n${extractionNote}` : '')
    + (extractedNote ? `\n${extractedNote}` : '')
    + (salvagePointer ? `\n${salvagePointer}` : '')
    + (extrasProblem ? `\n伴生文件没写进去：${extrasProblem}（剧本本身是好的，重传一次能补上）。` : '')
    // 开局那一句必须是**真能开局的词形**：`.trpg new <名字> [规则表]`（`.trpg start`
    // 不带参数，它只把 `preparing` 推到 `active`）。照抄 `start` 的话群友敲下去只会拿到
    // 一句「用法：`.trpg start`（不带参数）」—— 回执把人带错，而且没有任何报错。
    + `\n开局：.trpg new ${saved.scenario.id}`;
}

/**
 * 下载 → 抽文本 → 格式匹配（必要时让模型整理）→ 落库。**前半 + 后半，一次性跑完。**
 *
 * 这条路**会占住调用方**（最长约 `trpg.extractTotalBudgetMs`，默认 5 分钟）。生产路径上
 * `.trpg scenario` 只在"宿主没接
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
