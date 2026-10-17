// 跑团扩展 · 抽取管线的**模型调用端口**（L2 / L3 的唯一出口）。
//
// ── 为什么单独一个文件 ──
//
// 管线（`pipeline.ts`）里那三段编排要能**脱离网络被测**：给它一个假的 `ask`，它就该跑出
// 确定的结果。所以"真的去调模型"这件事被隔离在这里，只做两件事：按 `job` 取提示词、
// 调 `chatCompletion`、把内容原样交回去。
//
// ⚠️ **它不做任何解释**：`JSON.parse` / 剥围栏 / 认字段都归管线。这里的返回类型是"模型说了
// 一串字符"，不是"一份结构" —— 一旦这里开始解析，假的 `ask` 就得跟着模拟同样的解析，
// 而那正是测试要避开的耦合（同 `media/document/` 那条"这一层只管字节 → 文本"的分工）。
//
// ⚠️ **超时不在这里**：死线归管线（每一发都从 `EXTRACT_TOTAL_BUDGET_MS` 倒推，同
// `image-source` 那条"给兜底留位置"的纪律），本文件只把收进来的 `signal` 转交。
// `chatCompletion` 自己另有一个 `api.timeoutMs` 兜底，两者取更早的那个。
//
// ── 已知缺口：这两次调用的用量没进 token 账 ──
//
// 与 `format.ts` / `suggest.ts` 同一条（`format.ts` 头部有完整推导）：这条路径不挂在某个
// 会话上，而 `SessionRegistry` 没有"只累加增量"的入口，所以只把用量写进日志。
import { chatCompletion } from '../../../../llm/llm.js';
import { EXTRA_PROMPT_JOBS } from '../../../prompts.js';

/**
 * L2 那一片的入参。字段名与 `EXTRA_PROMPT_JOBS.trpg.extractChunk.user` 的参数逐个对应。
 *
 * ⚠️ **四张取值清单都由调用方递进来**（`mechanicTypes` / `triggerOps` / `effectHandlers`）：
 * `extra/prompts.ts` 必须零 import（`LAYER_ALLOW` 唯一条例外的全部依据），它够不着
 * `rules/rule-set.ts`。递进来还有个好处：提示词里念的清单与 `compileRuleSet` 认的清单
 * **是同一份** —— 抄一遍的话，加了新 handler 而提示词没跟上，表现是"模型写了一个
 * 其实支持、却没人告诉它可以写的值"（抽出来的机制静默变少）。
 */
export interface ChunkPayload {
  name: string;
  index: number;
  total: number;
  heading: string;
  text: string;
  maxItems: number;
  maxTextChars: number;
  maxQuoteChars: number;
  mechanicTypes: readonly string[];
  triggerOps: readonly string[];
  effectHandlers: readonly string[];
}

/** L3 那一次的入参。`extracted` 是**归并好的结构化结果**，不是原文（原文塞不进来）。 */
export interface MergePayload {
  name: string;
  source: string;
  chars: number;
  maxChars: number;
  maxFlags: number;
  maxCharacters: number;
  extracted: string;
}

/**
 * 一次抽取调用。用**可辨识联合**而不是 `(job, payload)` 两个参数：那样 `payload` 只能是
 * `unknown`，而 `prompt.ts` 里那句 `job.user(payload)` 就失去了检查 —— 字段名拼错不会报错，
 * 表现只是提示词里少一段（模型照样答得出来，只是答得差，没人查得出来）。
 */
export type AskRequest = { job: 'chunk'; payload: ChunkPayload } | { job: 'merge'; payload: MergePayload };

export type AskOutcome =
  | { ok: true; content: string; usage: string }
  | { ok: false; message: string };

/** 管线收下的那个端口。生产实现是 `askModel`，测试注入假端点。 */
export type AskPort = (request: AskRequest, signal: AbortSignal) => Promise<AskOutcome>;

/**
 * 真实现：按 `job` 取目录里的固定指令，调一次模型，把**原始内容**交回去。
 *
 * 温度恒为 0.2 —— 这两件事都是**转换**而不是创作（同 `formatScenarioText`）：同一份原文
 * 抽两次该抽出同一个结果。
 */
export async function askModel(request: AskRequest, signal: AbortSignal): Promise<AskOutcome> {
  const jobs = EXTRA_PROMPT_JOBS.trpg;
  const content = request.job === 'chunk'
    ? { system: jobs.extractChunk.system, user: jobs.extractChunk.user(request.payload) }
    : { system: jobs.mergeExtract.system, user: jobs.mergeExtract.user(request.payload) };

  try {
    const result = await chatCompletion({
      messages: [{ role: 'system', content: content.system }, { role: 'user', content: content.user }],
      temperature: 0.2,
      signal
    });
    const usage = result.usage
      ? `prompt=${result.usage.prompt_tokens ?? 0} completion=${result.usage.completion_tokens ?? 0}`
      : '';
    // ⚠️ **这是这两次调用唯一的用量凭据**（见文件头那条已知缺口）：不进 token 账，
    // 所以"这份模组抽一次花了多少"只有日志答得上来。同 `format.ts` 那一行。
    if (usage) console.log(`[trpg] 剧本抽取用量（${request.job}，不进 token 账，见 prompt.ts 头部）：${usage}`);
    return { ok: true, content: String(result.message?.content ?? ''), usage };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
