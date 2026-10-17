// 跑团扩展 · **机制草稿的成形**（P7-c）：把 L2 抽出来的 `StructMechanic[]` 变成一份
// 落得进 `<id>.rule.json` 的草稿。
//
// ── 这一层与 `compileRuleSet` 的分工（唯一要记住的一条）──
//
//   `compileRuleSet`（`rules/rule-set.ts`） 是**语法与互斥的权威**，它对谁都一视同仁 ——
//                                           人手改过的文件与抽取产物走的是同一条路。
//   本文件                                  只处理**抽取质量**导致的降级。
//
// 判据是**两种失败该由谁承担**：
//
//   • **模型没写好**（认不出的 type、写不出可判定的 trigger/effect）→ 这里**降级**成纯叙事，
//     记一笔待核项。**不拒绝** —— 抽取是一次尽力而为的模型调用，让一条没写好的机制把
//     "开一局"整个挡住，代价与收益完全不成比例（而且那条机制的信息还在 `struct.json` 里）。
//   • **数据自相矛盾**（同一个触发条件下两个相反的 handler、认不出的 handler）→ 交给
//     `compileRuleSet` **拒绝**。那种必须由人决定留哪一条，代码猜不了。
//
// ── 语法不在这里判 ──
//
// 想知道"这条能不能编译"，本文件**去问 `compileRuleSet`**（下面那两个小函数），不自己写一份判据。
// 自己写一份就是同一套语法有两个定义，而两份必然漂移 —— 漂移的表现是"这里说能编译、
// 那边说不能"，或者反过来（更坏）：这里放行了一条编译不过的，于是**开局时**才炸。
import { compileRuleSet, isMechanicType, type RuleDraftMechanic, type RuleExtensionDraft } from '../../rules/rule-set.js';
import type { StructMechanic } from './schema.js';

/**
 * 单独试编译一条机制。
 *
 * 判据只有一条（`ok`），所以互斥表那条路在这里**不可能**触发 —— 一次只有一条机制。
 * 那是有意的：互斥是**条与条之间**的事，该在整份草稿上判，不该让某一条为别人的冲突背锅。
 */
function compiles(mechanic: RuleDraftMechanic): boolean {
  return compileRuleSet({ version: 1, mechanics: [mechanic] }).ok;
}

/**
 * 试编译失败时那句人话。探针里恒为一条，所以前缀恒是「第 1 条机制…」——剥掉它更好读。
 *
 * ⚠️ **前缀有两种形状，都要剥**（`rules/rule-set.ts` 里那两处 `problems.push`）：
 *   • `第 1 条机制：${reason}`             —— trigger / effect 自己写坏了；
 *   • `第 1 条机制（${type}）没写 trigger…` —— 缺 trigger 那条，括号里是类型、**没有冒号**。
 * 只剥冒号那一种的话，第二种会**把前缀印两遍**（外面那句本来就已经写了「第 N 条机制（type）」），
 * 而它长得像一句正常的文案，没有任何报错。
 *
 * 剥不掉也没关系（正则不匹配时原样留着），比"猜一个前缀"稳妥。
 */
function whyNot(mechanic: RuleDraftMechanic): string {
  const probe = compileRuleSet({ version: 1, mechanics: [mechanic] });
  if (probe.ok) return '';
  return probe.problems.join('；').replace(/^第 \d+ 条机制(?:（[^）]*）)?[：:]?/, '');
}

/**
 * `StructMechanic[]` → `RuleExtensionDraft`。
 *
 * **没有机制时返回 `null`** —— 那是"这份剧本没有规则扩展"这个事实，与"有一份空的规则扩展"
 * 是两回事（后者会让 `store` 落一个空文件、`.trpg check` 报一句"0 条机制"，而前者什么都不该有）。
 * 与 `store/scenario-store.ts` 的 `writeExtras` 一致：缺的字段不写。
 */
export function buildRuleExtension(
  mechanics: readonly StructMechanic[], warnings: string[]
): RuleExtensionDraft | null {
  if (!mechanics.length) return null;
  const out: RuleDraftMechanic[] = [];
  mechanics.forEach((mechanic, at) => {
    const index = at + 1;
    const type = String(mechanic.type ?? '').trim();
    const draft: RuleDraftMechanic = {
      type,
      note: String(mechanic.note ?? '').trim(),
      trigger: mechanic.trigger,
      effect: mechanic.effect,
      sourceQuote: String(mechanic.sourceQuote ?? '').trim()
    };
    // ① 认不出的 type：**原样交出去**。`compileRuleSet` 才是那份清单的权威，它会把这条降级成
    //    `narrative_hook` 并记一笔 —— 在这里再判一次就是第二份定义（而且那句话会说两遍）。
    // ② `narrative_hook` 本来就是"只当提示"，它不需要可判定的 trigger，交给权威处理。
    if (!isMechanicType(type) || type === 'narrative_hook' || compiles(draft)) {
      out.push(draft);
      return;
    }
    // ③ 写得出 type 却写不出可判定的 trigger/effect —— 降级成纯叙事。
    //    `effect` 一并换成 `narrate`：留着原来那个（比如一条缺 `params.value` 的
    //    `penalty_to_check`）会让 `compileRuleSet` 再记一笔"是 narrative_hook 却写了 X"，
    //    于是同一条机制在待核项里出现两遍，说的还是同一件事。
    out.push({ ...draft, type: 'narrative_hook', effect: { handler: 'narrate', params: {} } });
    warnings.push(`第 ${index} 条机制（${type}）没能写成可判定的规则`
      + `（${whyNot(draft) || '字段不完整'}），已按纯叙事处理`);
  });
  return { version: 1, mechanics: out };
}
