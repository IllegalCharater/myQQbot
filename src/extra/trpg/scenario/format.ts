// 跑团扩展 · 把**任意格式**的文本整理成规定的剧本文件。
//
// ── 什么时候走这里 ──
//
// 只在"格式匹配失败"时（`isFormattedScenario` 为假）：上传的是一份 PDF 模组、一段裸的设定，
// 或者 frontmatter 里的 JSON 写坏了。**格式本来就对的文件一次模型调用都不发** ——
// 那是 `/剧本` 的零成本快路径。判据是确定性的（有没有 frontmatter、能不能解析），
// 不是"看起来像不像"的猜测。
//
// ── 产物去哪 ──
//
// 这里只**返回整理好的文本**，落库由调用方再过一遍 `parseScenario`（`saveScenarioText`）。
// 为什么不信模型给的就算数：它给的也可能不合规（正文超长、JSON 写坏、干脆没按格式写），
// 那时必须**如实报错**，而不是把一份解析不了的文件写进剧本库 ——
// 那会变成"开局了但什么都没注入"，而群里没人知道为什么。
// 所以本函数的**后置条件是"返回的文本一定是规定格式"**，不满足就返回失败。
//
// ── 已知缺口：这一次调用的用量没进 token 账 ──
//
// 与 `suggest.ts` 同一条（那里有完整推导）：这条路径不挂在某个会话上，而
// `SessionRegistry` 没有"只累加增量"的入口（`#persist` 对已结束的会话会重复累加），
// 所以只把用量写进日志。
import { chatCompletion } from '../../../llm/llm.js';
import { EXTRA_PROMPT_JOBS } from '../../prompts.js';
import { isFormattedScenario, parseScenario } from './parse.js';
import { MAX_CHARACTERS, MAX_FLAGS } from '../model/limits.js';
import { MAX_SCENARIO_CHARS } from '../types.js';

/** 一次整理的等待上限。它挂在命令路径上（群友在等回执），但整理一份长文确实要一会儿。 */
const FORMAT_TIMEOUT_MS = 60_000;

/**
 * 正文给模型的上限，比 `MAX_SCENARIO_CHARS` **留一截余量**。
 *
 * 为什么要余：解析时算的是**整份正文**的长度，而模型多半还会带上一点自己的措辞，
 * 卡着上限告诉它、它就会时不时超出去一格，然后整份被拒。留一截比让它重试便宜得多。
 *
 * ⚠️ **导出**是因为抽取管线（`extract/pipeline.ts`）也要给模型同一个数：它的 L3 产出的
 * 是同一份东西，两个数各写一遍必然漂移，而漂移的表现是"一条路产出的文件刚好能落库、
 * 另一条时不时被拒"。
 */
export const BODY_BUDGET = Math.max(200, Math.floor(MAX_SCENARIO_CHARS * 0.75));

/**
 * 剥掉模型套的外壳。
 *
 * 提示词里明确说了"不要代码块"，而模型**仍然经常套**（` ```markdown ` 是最常见的形态）。
 * 与其把这份带壳的文本当成剧本主体落库（那会变成正文以 ```` ``` ```` 开头的怪文件），
 * 不如在这里剥一次：**有围栏就取第一段围栏里的内容**，没有就用全文。
 */
export function stripFence(raw: unknown): string {
  const text = String(raw ?? '').trim();
  const fenced = /```[a-zA-Z]*\r?\n([\s\S]*?)```/.exec(text);
  return (fenced ? fenced[1] : text).trim();
}

export type FormatOutcome = { ok: true; text: string; usage: string } | { ok: false; message: string };

/**
 * 让模型把 `text` 整理成规定的剧本文件。
 *
 * `name` 会作为"剧本名的兜底"递给模型（`parseScenario` 在模型没写 title 时也用它），
 * `source` 是来源格式的中文名（`PDF` / `Word 文档` / `文本`），只用于让模型知道自己拿到的是什么。
 */
export async function formatScenarioText(
  text: string, { name, source }: { name: string; source: string }
): Promise<FormatOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FORMAT_TIMEOUT_MS);
  let content = '';
  let usageLine = '';
  try {
    const result = await chatCompletion({
      messages: [
        { role: 'system', content: EXTRA_PROMPT_JOBS.trpg.formatScenario.system },
        {
          role: 'user',
          content: EXTRA_PROMPT_JOBS.trpg.formatScenario.user({
            name,
            source,
            text,
            chars: text.length,
            maxChars: BODY_BUDGET,
            maxFlags: MAX_FLAGS,
            maxCharacters: MAX_CHARACTERS
          })
        }
      ],
      // 这是一次**转换**而不是创作：温度调低，让同一份原文两次整理出同一个结果。
      temperature: 0.2,
      signal: controller.signal
    });
    content = String(result.message?.content ?? '');
    if (result.usage) {
      usageLine = `prompt=${result.usage.prompt_tokens ?? 0} completion=${result.usage.completion_tokens ?? 0}`;
    }
  } catch (error) {
    return { ok: false, message: `让模型整理剧本时出错：${error instanceof Error ? error.message : String(error)}` };
  } finally {
    clearTimeout(timer);
  }
  if (usageLine) console.log(`[trpg] 剧本整理用量（不进 token 账，见 format.ts 头部）：${usageLine}`);

  const generated = stripFence(content);
  if (!generated) return { ok: false, message: '模型没有给出任何内容，稍后再试' };

  // **后置条件**：返回的必须是规定格式。不满足就如实报错，而不是让调用方把一份
  // 解析不了（或压根没骨架）的文件写进剧本库 —— 后者的表现是"开局了但什么都没注入"。
  if (!isFormattedScenario(generated, name)) {
    const why = parseScenario(generated, name);
    return {
      ok: false,
      message: why.ok
        ? '模型整理出来的东西不是剧本格式（没有骨架）—— 稍后再试一次'
        : `模型整理出来的剧本不合规：${why.message}`
    };
  }
  return { ok: true, text: generated, usage: usageLine };
}
