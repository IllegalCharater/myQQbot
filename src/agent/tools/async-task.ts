// 异步能力工具的**共同外壳**（`transcribe_video` / `generate_image` / `download_jmcomic`）。
//
// 三者的流程是同一条：**模型调一次工具 → 立刻拿到回执 → 结果稍后回流入窗**。工具本身
// 只做三件事：解析参数与目标 → 交给队列 → 把"接下来会怎样"说给模型听（那句话整句取自
// `prompt-catalog`）。工具**不发任何消息**（那是模型的判断，见 AGENTS.md 的"工具不得代模型发言"）。
//
// 这里只收下**唯一一件容易各写各的**事：出了错怎么回给模型。
//
// ── 为什么失败必须带真实原因 ──
//
// 各工具自己写 try/catch 时，兜底很容易退化成一句"任务创建失败，稍后再试"（转写那条就曾如此，
// 见 git 历史）：它把"URL 不合法""凭证没配""额度用尽""这个群太频繁"**全抹平了**，
// 模型只能对着这句话复述给群友，而群友是唯一能照着改的人。判据很简单 ——
// **入队失败的原因来自我们自己的校验层，本来就是中文用户文案**，原样透传即可。
import { errorMessage } from './shared.js';
import type { ToolDefinition, ToolArguments, ToolContext, ToolResult } from '../shared/types.js';

/** 任务体：成功返回**要发给模型的那句话**（回执），失败直接抛（原因由外壳原样回给模型）。 */
export type TaskToolRun = (ctx: ToolContext, args: ToolArguments) => Promise<string | ToolResult> | string | ToolResult;

/**
 * 拼一个"入队型"工具定义。
 *
 * `run` 里允许返回一个完整的 `ToolResult`（例如"这条消息里没有可转写的链接"这类
 * 零成本拒绝），也可以只返回一句回执字符串 —— 后者是绝大多数情况。
 */
export function asyncTaskTool({ name, description, parameters, run }: {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run: TaskToolRun;
}): ToolDefinition {
  return {
    name,
    description,
    parameters,
    async execute(ctx, args) {
      try {
        const result = await run(ctx, args);
        return typeof result === 'string' ? { content: result } : result;
      } catch (error) {
        return { content: `错误：${errorMessage(error) || '任务创建失败，稍后再试。'}`, isError: true };
      }
    }
  };
}
