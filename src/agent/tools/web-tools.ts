import { TOOL_PROMPT_TEXT } from '../../core/prompt-catalog.js';
import { webFetch, webSearch } from '../../media/web-search.js';
import { err, errorMessage, ok, takeWebBudget } from './shared.js';
import type { ToolDefinition } from '../shared/types.js';

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
          return ok({
            url: result.url,
            statusCode: result.statusCode,
            truncated: result.truncated || body.length > 20000,
            content: body.slice(0, 20000)
          });
        } catch (error) {
          return err(`抓取失败：${errorMessage(error)}`);
        }
      }
    }
  ];
}
