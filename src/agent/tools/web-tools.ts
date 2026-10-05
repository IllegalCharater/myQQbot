import { TOOL_PROMPT_TEXT } from '../../core/prompt-catalog.js';
import { webFetch, webSearch } from '../../media/web-search.js';
import { htmlToText, looksLikeHtml, looksBlocked } from '../../media/html-to-text.js';
import { err, errorMessage, ok, takeWebBudget } from './shared.js';
import type { ToolDefinition } from '../shared/types.js';

/**
 * `web_fetch` 交给模型的**可读正文**上限（字符）。
 *
 * 与旧实现那个 20000 是同一个数，但**含义变了**：旧的是"原始 HTML 的前 20000 字符"
 * （绝大多数被 `<script>` 吃掉），现在是"剥掉 HTML 之后的正文前 20000 字"。
 */
const FETCH_TEXT_MAX_CHARS = 20000;

/** 受统一成本闸门保护的联网检索工具。 */
export function webTools(): ToolDefinition[] {
  return [
    {
      name: 'web_search',
      description: TOOL_PROMPT_TEXT.web_search.description,
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: TOOL_PROMPT_TEXT.web_search.query },
          // 由**模型**决定搜哪个站点（照 reverse_image_source 的 intent 那一套）。
          // 可选：不传就是全网搜索。取值必须来自提示词里那份收藏夹名单，服务端会校验。
          site: { type: 'string', description: TOOL_PROMPT_TEXT.web_search.site }
        },
        required: ['query']
      },
      async execute(ctx, args) {
        // 限频排在联网之前：被拒绝的调用不该真去发请求，也不该占额度。
        const limited = takeWebBudget(ctx.chatKey);
        if (limited) return err(limited);
        try {
          const result = await webSearch(String(args.query ?? ''), args.site);
          if (!result.results.length) {
            return ok({ query: result.query, results: [], note: '没有搜到结果，试试换关键词或更具体的说法。' });
          }
          return ok(result);
        } catch (error) {
          return err(`搜索失败：${errorMessage(error)}`);
        }
      }
    },
    {
      name: 'web_fetch',
      description: TOOL_PROMPT_TEXT.web_fetch.description,
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: TOOL_PROMPT_TEXT.web_fetch.url } },
        required: ['url']
      },
      async execute(ctx, args) {
        const limited = takeWebBudget(ctx.chatKey);
        if (limited) return err(limited);
        try {
          const result = await webFetch(String(args.url ?? ''));
          const body = String(result.body || '');
          const contentType = String(result.contentType || '');
          // ⚠️ **必须先剥 HTML 再截断**（顺序反了就是那个"抓回来只有脚本"的 bug）。
          // 旧实现是 `body.slice(0, 20000)`：现代站点的 `<head>` 塞满 `<script>`
          // （MediaWiki 的 `RLCONF={…}` 动辄几十 KB），20000 字符几乎全被它吃掉 ——
          // 实测萌娘百科初音未来词条只给出 **206** 字可读文本，正文一个字都进不去，
          // 模型于是以为"抓取失败/被限流"并反复重试。剥过之后同一页能给 **2 万多字**。
          const isHtml = looksLikeHtml(body, contentType);
          const text = isHtml ? htmlToText(body, String(result.url || '')) : body;
          // ⚠️ **"剥完是空的"绝不能说成成功**（**实测反馈**）：模型抓到 `content: ""` 却看到
          // 一条"已从 HTML 中提取可读正文"，于是它以为修复没生效，而真实原因是站点在拦它
          // （Cloudflare 挑战页 / `未授权操作`，两者都是 **HTTP 200**）。
          // 判据只用一次、放在这里，因为**同一个 `text` 才是模型真正会看到的东西**。
          const verdict = looksBlocked(body, {
            server: String(result.server || ''),
            cfMitigated: String(result.cfMitigated || ''),
            text
          });
          if (verdict.blocked) return err(`抓取不到内容：${verdict.reason}`);
          return ok({
            url: result.url,
            statusCode: result.statusCode,
            contentType: contentType || undefined,
            // `truncated` 的语义：**给模型看的正文被截断了**（不是"原始响应很大"）。
            // 旧判据拿 `result.truncated`（原始响应 ≥50000 字符）来说事，而剥 HTML 之后
            // 那个数已经不代表模型看到的东西了 —— 会报出一个用户无法理解的"截断了"，
            // 而正文其实完整。所以这里只按**剥完之后的文本**判。
            truncated: text.length > FETCH_TEXT_MAX_CHARS,
            content: text.slice(0, FETCH_TEXT_MAX_CHARS),
            ...(isHtml ? { note: '（已从 HTML 中提取可读正文）' } : {})
          });
        } catch (error) {
          return err(`抓取失败：${errorMessage(error)}`);
        }
      }
    }
  ];
}
