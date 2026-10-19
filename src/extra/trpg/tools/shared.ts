// 四个工具共用的**闸门与取值助手**（从 `tools.ts` 拆出，2026-10-16）。
//
// ── 行动经济挂在哪 ──
//
// `ledgers`（`WeakMap<ToolContext, ActionLedger>`）：`ctx` 是 `agent-runner` **每次运行新建一个**、
// 整个工具循环共用的对象（`executeTool(toolDefs, ctx, …)`），所以"一个回合 = 一次运行"这条定义
// 由对象生命周期免费给出 —— 运行结束自动清零，不需要清理代码，也不必往 `ToolContext` 里加字段。
//
// ⚠️ **一本账只能有一个来源**：`createGates()` 每次调用新建一个 `WeakMap`，而 `createHandlers()`
// 只调它一次、把结果分给四个工具。每个工具各建一份的话，"同参数去重"与"主行动配额"就各算各的，
// 而那正是这两道闸门要拦的东西（`test` 里那句"新 ctx 即新回合"也钉不住）。
import { err, errorMessage } from '../../../agent/tools/shared.js';
import { clampInt, text, MAX_NAME_CHARS, MAX_STATS_PER_CHARACTER, MAX_STAT, MIN_STAT } from '../model/limits.js';
import { appendLog, mirrorLog } from '../model/campaign.js';
import { advanceAfterActions } from '../model/combat.js';
import { createLedger, consume, recall, refund, remember, PRIMARY_SOURCE } from '../rules/economy.js';
import { DiceError } from '../rules/dice.js';
import type { ActionLedger } from '../rules/economy.js';
import type { JournalPort } from '../model/campaign.js';
import type { TrpgStore } from '../store/campaign-store.js';
import type { TrpgCampaign } from '../types.js';
import type { ToolArguments, ToolContext, ToolResult } from '../../../agent/shared/types.js';

export type Handler = (ctx: ToolContext, args: ToolArguments) => Promise<ToolResult>;

/** 回流条目的形状。**故意很窄**：扩展只说"这是一条什么、正文是什么"，怎么落库是宿主的事。 */
export interface TrpgNote {
  /** `journal` = 玩家视角变了（【跑团笔记】）；`suggest` = 兜底生成的行动建议（【行动建议】）。 */
  kind: 'journal' | 'suggest';
  text: string;
}

export interface ToolGates {
  /** 两道闸门的入口：拒绝时给回给模型的那句话（空串 = 放行）。 */
  gate: (
    ctx: ToolContext,
    opts: { tool: string; actor: string; args: ToolArguments; source: unknown; quota: boolean }
  ) => string;
  /** 没出错才记进去重表。 */
  settle: (ctx: ToolContext, tool: string, actor: string, args: ToolArguments, result: ToolResult) => ToolResult;
  /** "需要已经开局"的工具共用外壳：读战役 → 跑动作 → **没出错才落盘**。 */
  withCampaign: (ctx: ToolContext, run: (campaign: TrpgCampaign) => ToolResult) => Promise<ToolResult>;
}

/**
 * 造一套闸门（**每个 `createHandlers` 只调一次**，见文件头）。
 *
 * `withCampaign` 出错不落盘是有意的：校验失败的请求不该留下任何痕迹（否则一次误调用会在日志里
 * 留下一条"什么也没发生"的记录，而日志是给模型看的上下文）。**战报跟着这条判据走** ——
 * 它镜像的是"真的落盘了的东西"（见 `model/campaign.ts` 的 `mirrorLog`）。
 */
export function createGates(store: TrpgStore, journal: JournalPort | null = null): ToolGates {
  /** 每个回合（= 每次 agent 运行）一本账。见文件头那段说明。 */
  const ledgers = new WeakMap<ToolContext, ActionLedger>();
  const ledgerFor = (ctx: ToolContext): ActionLedger => {
    let ledger = ledgers.get(ctx);
    if (!ledger) { ledger = createLedger(); ledgers.set(ctx, ledger); }
    return ledger;
  };
  /**
   * 这一轮**真的花掉了主行动**的角色名（P5：战斗指针靠它前进）。
   *
   * 与 `ledgers` 同一手法、同一生命周期（一次运行一个 `ctx`）。**只在配额真的被消费时记**：
   * 被去重拦下、或被配额拒绝的那次调用什么也没做，不该让战斗往前挪一格。
   *
   * ⚠️ **它由 `withCampaign` 收口**（读完即清）。这不是洁癖：`gate` 目前**只被
   * `withCampaign` 的回调调用**（四个工具都如此），所以"谁读了这份名单"只有一个答案；
   * 漏了清空的话，一次 `roll` 留下的名字会被同一轮里**下一次** `withCampaign` 当成
   * "他又动了"而再推一格 —— 那是"指针一次跳两格"，而它不会有任何报错。
   */
  const acted = new WeakMap<ToolContext, string[]>();

  /**
   * 这一轮**刚花掉的那一格额度**（每个 `ctx` 至多一条）。
   *
   * 由 `gate` 记、由 `withCampaign` 收口：`result.isError` 时**还回去**（见 `refund`）。
   * 没有它的话，一次纯粹写错参数的调用会把那个角色这一回合的行动吃掉 —— 而模型改正参数
   * 重来时拿到的是「这一轮已经行动过了」，血没掉、卡没改，群里也看不出发生了什么（实测过）。
   *
   * ⚠️ **必须"读到即清"**：留着的话，下一次 `withCampaign` 会拿着一格已经还过的额度去退，
   * 于是把**别人**的额度退掉 —— 症状是"某个角色一回合能行动两次"，而它不会有任何报错。
   */
  const spent = new WeakMap<ToolContext, { actor: string; source: string }>();

  const gate: ToolGates['gate'] = (ctx, { tool, actor, args, source, quota }) => {
    const declared = text(source, 24);
    // 上一次调用留下的那一格已经在 `withCampaign` 里收口了；这里再清一次是防"有人
    // 绕过 `withCampaign` 直接调 gate"（今天没有这样的调用点，但清一次比留个隐患便宜）。
    spent.delete(ctx);
    const ledger = ledgerFor(ctx);
    // 声明了额外行动来源 = 这是规则允许的另一次行动，同样的参数可以合法地再来一次。
    if (!declared) {
      const reused = recall(ledger, actor, tool, args);
      if (reused) return `这一轮已经做过这件事了，下面是上次的结果：\n${reused}`;
    }
    if (quota) {
      const verdict = consume(ledger, actor, declared);
      if (!verdict.ok) return `⚠ ${verdict.reason}`;
      // 只有**过了配额**才算这个人这一回合真的动了（被拒的那次没做事）。
      const list = acted.get(ctx);
      if (list) list.push(actor); else acted.set(ctx, [actor]);
      // 记下这一格，**成不成功由 `withCampaign` 定**（它在 `run` 之后才知道）。
      spent.set(ctx, { actor, source: declared || PRIMARY_SOURCE });
    }
    return '';
  };

  const settle: ToolGates['settle'] = (ctx, tool, actor, args, result) => {
    if (!result.isError && typeof result.content === 'string') {
      remember(ledgerFor(ctx), actor, tool, args, result.content);
    }
    return result;
  };

  const withCampaign: ToolGates['withCampaign'] = async (ctx, run) => {
    const campaign = store.read(ctx.chatKey);
    if (!campaign) {
      return err('这个会话还没有开局 —— 先调 campaign（action=start）把这场跑团建起来');
    }
    const beforeSeq = campaign.seq;
    const result = run(campaign);
    // ⚠️ **无论成败都要收口**（`delete`，不是只读）：失败那次留着的话，它会跟着下一次
    // 工具调用一起被消费掉 —— 于是"报错的那次"也推了指针，而群友只看到 DM 说"这不行"。
    const actors = acted.get(ctx) ?? [];
    acted.delete(ctx);
    // 额度同理：**没做成的事不收费**。这一格只可能在 `result.isError` 时还在（成功时下面
    // 那句 `store.write` 之前就已经用掉了），所以"读出来再判"比"看情况删"更难写错。
    const used = spent.get(ctx);
    spent.delete(ctx);
    if (!result.isError) {
      // ── 额外行动留痕（2026-10-19 第三轮）──
      //
      // `actionSource` 是**自由文本、声明即接受**：代码只做两件事 —— 非空就跳过去重、
      // 计入"额外行动"桶（上限 `MAX_EXTRA_ACTIONS`）。"这个来源是不是规则书允许的"代码判不了
      // （规则表里没有那一栏），所以至少让它**在日志里留一条**：事后有人问"他为什么这一回合
      // 动了两次"，翻得到那一行。
      //
      // ⚠️ **必须 `visible: false`**：`state` 类日志会镜像进战报，而战报是发进群的文件。
      // "额外行动"是 DM 的记账，不是玩家该看到的东西（同 `tools/campaign.ts` 的 `sceneNotes`）。
      if (used && used.source !== PRIMARY_SOURCE) {
        appendLog(campaign, 'state', `额外行动：${used.source}（${used.actor}）`, false);
      }
      // 战斗指针在**落盘之前**推进：它和这一轮的动作是同一件事的两半，分两次写就会留下
      // 一个"日志里记了他打了人、指针还停在他身上"的中间态（那次写入崩了的话）。
      advanceAfterActions(campaign, actors);
      store.write(campaign);
      // 战报在**落盘之后**镜像（见 `mirrorLog`）：被 `return err(...)` 撤销的那次调用
      // 一个字都不该进战报。
      mirrorLog(campaign, beforeSeq, journal);
    } else if (used) {
      refund(ledgerFor(ctx), used.actor, used.source);
    }
    return result;
  };

  return { gate, settle, withCampaign };
}

/** 认得出 `DiceError` 就把它的中文文案原样回给模型；别的异常才走通用文案。 */
export function diceError(error: unknown): ToolResult {
  if (error instanceof DiceError) return err(error.message);
  return err(errorMessage(error));
}

/** 一张卡的"一行摘要"，用在变更日志里（`阿飞 HP 10→7；备注+：受了刀伤`）。 */
export function changeNote(parts: string[]): string {
  return parts.filter(Boolean).join('；');
}

/**
 * 读一组"名字 → 数值"。键去空白、值夹进区间；非对象的输入给空表（调用方会当"没给"处理）。
 *
 * 上限在这里**不查**（那是各调用点的事）：`create` 是"从头建"，
 * `update` 要看"现有的 + 这次的"总数，两者的判据不一样。
 */
export function readStats(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const label = text(key, MAX_NAME_CHARS);
    if (!label) continue;
    if (Object.keys(out).length >= MAX_STATS_PER_CHARACTER) break;
    out[label] = clampInt(raw, MIN_STAT, MAX_STAT, 0);
  }
  return out;
}

// 字段级可见度（`hidden`）**没有**这里的一份：它的唯一实现在 `model/character.ts` 的
// `normalizeHidden`（工具层与存档层共用那一个，见那里的注释）。曾经这里有过一个 `readHidden`
// 与它并存，两者对标量输入的行为不同 —— 别再把它加回来。
