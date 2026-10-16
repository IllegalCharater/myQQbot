// `say` —— 接管模式下**唯一的发言通道**（从 `tools.ts` 拆出，2026-10-16）。
//
// 它必须走和内置 `send_message` 完全一样的路：`sendTextBatch` 发出去 → `recordSent` 记账。
//
// ⚠️ **`recordSent` 那一步不能省**：会话的收尾状态（`done` / `noreply`）、协议纠正的
// `sentExternalAction`、面板的 `sentCount` 三处都读那本账。漏了它的表现是"明明说了话
// 却被记成没说过，而且模型被追着再发一次"，两样都不报错。
//
// 叙事的**记档由代码做**（说了什么就记什么），不另开一个"记日志"的工具 ——
// 那会给模型一个"我可以说但不记"的口子，而日志正是它下一轮的上下文。
import { normalizeMessageList } from '../../../core/util.js';
import { err, errorMessage, ok, recordSent, sentTextEntries } from '../../../agent/tools/shared.js';
import { appendLog, mirrorLog } from '../model/campaign.js';
import type { Handler } from './shared.js';
import type { JournalPort } from '../model/campaign.js';
import type { TrpgStore } from '../store/campaign-store.js';

export function createSayHandler({ store, journal }: { store: TrpgStore; journal?: JournalPort | null }): Handler {
  return async (ctx, args) => {
    try {
      const messages = normalizeMessageList(args?.text);
      if (!messages.length) return err('要说的正文是空的（text）');
      const result = await ctx.sender.sendTextBatch(ctx.chatKey, messages, {
        replyToMessageId: args?.replyToMessageId ?? null,
        // **点名必须走这个字段**：写进 text 只是一串普通文字，协议端不会把它变成真的 @
        // （模型很容易以为"我写了 @阿飞 就叫他了"）。只支持纯数字 QQ 号，其余当没给。
        atUserId: /^\d+$/.test(String(args?.atUserId ?? '')) ? String(args.atUserId) : null
      });
      recordSent(ctx, sentTextEntries(result));

      const campaign = store.read(ctx.chatKey);
      if (campaign) {
        // 说了什么就记什么，**一条一条**（渲染层按条给模型看"最近发生"）。
        const beforeSeq = campaign.seq;
        for (const line of messages) appendLog(campaign, 'narration', line);
        store.write(campaign);
        mirrorLog(campaign, beforeSeq, journal ?? null);
      }

      const failed = result.failed.length
        ? `（另有 ${result.failed.length} 条没发出去：${result.failed.map((f) => f.error).join('；')}——成功的不必重发）`
        : '';
      return ok(`已发送 ${result.sent.length} 条。${failed}不要输出"已发送"类汇报，接着推进剧情或直接结束。`);
    } catch (error) {
      return err(errorMessage(error));
    }
  };
}
