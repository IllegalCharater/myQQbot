// 跑团规则引擎 · 行动经济账本（**纯逻辑**，不碰任何平台对象）
//
// ── 它解决什么 ──
//
// 模型可以在**同一次运行**里把同一个失败的动作重做到成功为止，也可以在一轮里连放三个法术、
// 连休两次。这两件事都不是"叙事风格"问题：它们改的是世界状态，而且改得没有代价。
// 账本是那条分界在"行动"这一层的落点 —— 叙事归模型，**次数归代码**。
//
// ── "一个回合"是什么 ──
//
// 本模块自己没有回合概念，它只是一个 Map。定义在调用方：`tools/shared.ts` 用一个
// `WeakMap<ToolContext, ActionLedger>` 持有它，而 `ctx` 是 `agent-runner` **每次运行新建一个**、
// 整个工具循环共用的对象。于是"一个回合 = 一次 agent 运行"这条定义由对象生命周期免费给出，
// 既不需要在运行结束时清理，也不需要往 `ToolContext` 里加字段。跑团在群里没有别的回合概念，
// 这是唯一合理的映射。
//
// ── 两条闸门，缺一不可 ──
//
//   ① **同回合去重**（`remember` / `recall`）：同样的工具 + 同样的行动者 + 同样的参数，
//      第二次直接返回上次的结果。**这才是真正拦住"重掷到成功"的那一条** —— 主行动配额只管
//      "改状态"，而掷骰本身不改状态，没有去重就拦不住。
//   ② **主行动配额**（`consume`）：改状态的动作每个行动者每回合一次；额外行动要用
//      `actionSource` 显式声明来源，且有合计上限。
//
// ── 为什么来源是自由文本 ──
//
// 不枚举 `multiattack` / `legendary_action` / `haste` 这类名字：那是**规则书知识**，而本模块
// 刻意不认识任何规则书（见 `types.ts` 里那条决定）。一张来源配额表就是规则书漏进领域层。
// 模型自己起名字，账本只按"申明了就不是主行动"记账。

/** 未声明来源时的那一个。它是"这个单位本回合的那一次行动"。 */
export const PRIMARY_SOURCE = 'primary';

/** 申明来源的额外行动，每个行动者每回合的**合计**上限。防的是"一轮打十次"。 */
export const MAX_EXTRA_ACTIONS = 3;

export interface ActionLedger {
  /** 行动者 → 来源 → 已用次数。 */
  actions: Map<string, Map<string, number>>;
  /** 去重表：`行动者|工具|规范化参数` → 上次回给模型的完整结果。 */
  results: Map<string, string>;
}

export function createLedger(): ActionLedger {
  return { actions: new Map(), results: new Map() };
}

/** 这次调用能不能算作本回合的一次行动。拒绝时 `reason` 直接就是回给模型的那句话。 */
export type ConsumeVerdict = { ok: true } | { ok: false; reason: string };

/**
 * 花掉一次行动额度。
 *
 * `source` 为空或是 `primary` 时走主行动那一档；否则算额外行动（见文件头）。
 * 被拒时**不记账** —— 与 `media/task-queue.ts` 的"被闸门拒掉的那一次不占额度"同一条规矩。
 */
export function consume(ledger: ActionLedger, actor: string, source: unknown): ConsumeVerdict {
  const who = String(actor ?? '').trim() || '这个单位';
  const name = String(source ?? '').trim() || PRIMARY_SOURCE;
  const used = ledger.actions.get(who) ?? new Map<string, number>();
  const already = used.get(name) ?? 0;

  if (name === PRIMARY_SOURCE) {
    if (already >= 1) {
      return {
        ok: false,
        reason: `「${who}」这一轮已经行动过了。同一个动作不要重做（重掷失败的结果也算重做）——`
          + '如果这确实是规则允许的额外行动，用 actionSource 声明它的来源（例如 actionSource="multiattack"）'
      };
    }
  } else {
    const extras = [...used].reduce((sum, [key, count]) => (key === PRIMARY_SOURCE ? sum : sum + count), 0);
    if (extras >= MAX_EXTRA_ACTIONS) {
      return {
        ok: false,
        reason: `「${who}」这一轮的额外行动已经到上限（合计最多 ${MAX_EXTRA_ACTIONS} 次）——`
          + '同一个动作反复做不是额外行动，是重做'
      };
    }
  }

  used.set(name, already + 1);
  ledger.actions.set(who, used);
  return { ok: true };
}

/** 记下这次调用的结果，供同回合的重复调用直接复用。 */
export function remember(ledger: ActionLedger, actor: string, tool: string, args: unknown, result: string): void {
  ledger.results.set(resultKey(actor, tool, args), result);
}

/** 这个行动者用完全相同的参数调过同一个工具吗？是就返回上次的结果。 */
export function recall(ledger: ActionLedger, actor: string, tool: string, args: unknown): string | null {
  return ledger.results.get(resultKey(actor, tool, args)) ?? null;
}

function resultKey(actor: string, tool: string, args: unknown): string {
  return `${String(actor ?? '').trim()}|${tool}|${stableKey(args)}`;
}

/**
 * 参数的规范化键。
 *
 * 两个刻意的处理：
 *   • **丢掉空值**（`undefined` / `null` / 空串）—— 模型常常在一个调用里写 `reason: ""`、
 *     在下一个里干脆不写，那是同一次调用；
 *   • **键排序** —— JSON 的对象键顺序不保证，`{a,b}` 与 `{b,a}` 必须同键。
 *
 * ⚠️ 嵌套对象只做浅层排序（`JSON.stringify` 保留原顺序），所以"同样的 `stats` 换了键序"
 * 会被当成两次不同的调用。这个方向的误差是**多放行**，而不是误拦，可以接受。
 */
function stableKey(args: unknown): string {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return JSON.stringify(args ?? null);
  const entries = Object.entries(args as Record<string, unknown>)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(entries);
}
