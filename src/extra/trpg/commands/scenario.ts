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
import { errorMessage } from '../../../agent/tools/shared.js';
import { safeFetchBinary } from '../../../media/safe-fetch.js';
import { FORMAT_LABEL, extractDocumentText } from '../../../media/document/index.js';
import { MAX_SCENARIO_BYTES, isFormattedScenario } from '../scenario/parse.js';
import { saveScenarioText } from '../scenario/save.js';
import { formatScenarioText } from '../scenario/format.js';
import { renderScenarioList, SCENARIO_USAGE } from '../render/status.js';
import { argsOf, scenarioIds } from './shared.js';
import type { CommandHandler } from './shared.js';
import type { MediaEntry } from '../../../chat/types.js';
import type { ScenarioStore } from '../store/scenario-store.js';

/** 下载超时。这是**命令路径**（群友在等回执），不该被一个慢下载挂住。 */
const SAVE_TIMEOUT_MS = 15000;

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

/** 名字与入口都定好了：下载 → 抽文本 → 格式匹配（必要时让模型整理）→ 落库。 */
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
      + `\n开局：.trpg start ${saved.scenario.id}`;
  } catch (error) {
    return `下载「${shown}」失败：${errorMessage(error)}`;
  }
}

export interface ScenarioCommandDeps {
  scenarios: ScenarioStore;
  /** 这条命令的词（`'.trpg scenario'`）—— 由 `commands/index.ts` 递进来，见 `argsOf`。 */
  command: string;
}

/**
 * `.trpg scenario [名字]` —— 不带名字时：引用了文件就用文件名当名字，没引用就是**列出剧本库**
 * （清单里那两句正好也说了怎么再传一份）。
 */
export function createScenarioCommand({ scenarios, command }: ScenarioCommandDeps): CommandHandler {
  return async (input) => {
    const name = argsOf(input, command)[0] ?? scenarioNameFromFile(input.media);
    if (!name) return renderScenarioList(scenarioIds(scenarios));
    return saveScenario(input, name, scenarios);
  };
}
