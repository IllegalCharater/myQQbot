import { TOOL_PROMPT_TEXT } from '../../core/prompt-catalog.js';
import type { ToolDefinition } from '../shared/types.js';

/**
 * 只读的"取热搜榜单"工具。
 *
 * **刻意不暴露播报能力**：`HotSearchScheduler.broadcast()` 带当天幂等与目标群白名单两重保护，
 * 把"发到所有目标群"这件事交给模型会绕开它们。模型想让群里看到榜单，用已有的 `send_message`
 * 把返回的文本发出去即可——发不发由它自己判断，这本来就是它的职责。
 *
 * 因此这里没有成本闸门：`readTopics()` 是只读检索，与同样不限次的 `web_search` 同类，
 * 且 `#exclusive` 已经保证同一时刻只有一次请求在飞。
 */
export function hotSearchTools(): ToolDefinition[] {
  return [{
    name: 'get_hot_search',
    description: TOOL_PROMPT_TEXT.get_hot_search.description,
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: TOOL_PROMPT_TEXT.get_hot_search.limit }
      },
      required: []
    },
    async execute(ctx, args) {
      const scheduler = ctx.hotSearch;
      if (!scheduler) return { content: '错误：热搜功能未启用', isError: true };
      // 非数字（含模型偶尔发的字符串 "5"）都退化成"用配置里的条数"，越界由 readTopics 收敛。
      const requested = Number(args.limit);
      const limit = Number.isFinite(requested) ? Math.round(requested) : undefined;
      try {
        const preview = await scheduler.readTopics(limit);
        const text = preview.pages.join('\n\n').trim();
        if (!text) return { content: '错误：这次没取到热搜内容', isError: true };
        return { content: text };
      } catch (error) {
        // 失败原因（接口超时/正在播报/空榜）都是中文可读文案，直接转述比套一层"查询失败"更有用。
        return { content: `错误：${error instanceof Error ? error.message : '热搜查询失败'}`, isError: true };
      }
    }
  }];
}
