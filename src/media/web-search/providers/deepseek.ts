// DeepSeek 服务端原生搜索（Responses API，web_search 工具）。
// 文档：https://api-docs.deepseek.com/zh-cn/guides/responses-api
//
// 说明：搜索在 DeepSeek 服务端完成并注入上下文，客户端能拿到的是模型基于搜索结果生成的
// 最终回答；URL/标题/摘要为黑盒，拿不到结构化来源。适合"只要能搜到并总结"的场景；
// 需要引用列表时请用 Bing / 其他搜索 API。**这也是它与其他 provider 形状不同的原因**：
// 它返回一条"合成答案"，不是 N 条来源。
import { getConfig } from '../../../core/config.js';
import { asRecord, recordArray } from '../record-utils.js';
import type { SearchResponse } from '../types.js';

export async function deepSeekSearch(query: string): Promise<SearchResponse> {
  const cfg = getConfig().webSearch?.deepseek ?? {};
  const apiKey = String(cfg.apiKey || process.env.DEEPSEEK_API_KEY || '').trim();
  if (!apiKey) throw new Error('DeepSeek 搜索需要 API Key（设置里填，或环境变量 DEEPSEEK_API_KEY）');
  const baseUrl = String(cfg.baseUrl || 'https://api.deepseek.com/responses').replace(/\/+$/, '');
  const model = String(cfg.model || 'deepseek-v4-flash');

  const res = await fetch(baseUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      input: `请联网搜索并回答（用中文，简洁、只给结论和关键信息）：${query}`,
      tools: [{ type: 'web_search' }],
      stream: false
    }),
    signal: AbortSignal.timeout(Math.max(10000, Number(cfg.timeoutMs) || 60000))
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`DeepSeek 搜索 HTTP ${res.status}：${text.slice(0, 300)}`);
  }
  const raw: unknown = await res.json().catch(() => { throw new Error('DeepSeek 搜索返回了无法解析的 JSON'); });
  const data = asRecord(raw);
  const outputText = String(data.output_text ?? '').trim();
  if (!outputText) {
    // 兼容不同字段位置
    const message = recordArray(data.output).find((item) => item.type === 'message' && recordArray(item.content).length);
    const alt = message ? recordArray(message.content).map((content) => String(content.text ?? '')).join('') : '';
    if (!alt) throw new Error('DeepSeek 搜索没有返回文本（可能是模型不支持 web_search 工具）');
    return { query, results: [{ title: 'DeepSeek 搜索', url: '', snippet: alt }] };
  }
  return { query, results: [{ title: 'DeepSeek 搜索', url: '', snippet: outputText }] };
}
