// 跑团 · **规则的唯一取用口**（P7-d，决定 3）。
//
// ── 它解决的是什么 ──
//
// 在 P7 之前，"这一局按什么规则判"只有一半：`RuleStore.read(id)` 给的是**基础规则表**
// （等级表、`dice`、`chargen`、`initiative`），而剧本自带的**规则扩展**（`ruleExt`，
// `<id>.rule.json`）谁也不认识。六处消费点各读各的基础表，于是"这一局的特殊机制"
// 要么被忽略，要么得在六处各接一遍 —— 六处各写一份判据必然漂移。
//
// 所以这里给**一个**函数：`ruleSetFor(campaign, rules)` 一次给出两样东西 ——
//   `base` 基础表（原来的 `RuleLookup.rule`，逐字不变）
//   `set`  这一局的运行期规则集（`ruleExt` 现编译出来的；没有扩展时是 `EMPTY_RULE_SET`）
// 六处消费点全部换成它，谁都不再自己 `rules.read`。
//
// ── 两个入口、一份实现（`beginCampaign` 那一条）──
//
// `ruleSetFor` 就是 `ruleSetOf(campaign.rule, campaign.scenario?.ruleExt, rules)`。
// `beginCampaign` 在**战役对象还没建出来**的时候要判同一件事（扩展坏了就别开局），
// 它因此调 `ruleSetOf` 并递进"候选的"那两个值 —— 判据只有一份，不会出现
// "开局时放行、运行期拒绝"这种两边不一致的状态。
//
// ── 扩展坏了就**拒绝**，不回落（与基础表逐字同源的一条判据）──
//
// `RuleStore.read` 对"引用的表不存在"是**回落 + `note`**（那句话原样进回执），对"表本身坏了"
// 是 `ok: false`。规则扩展只有后者这一种：它没有"回落成什么"的答案 —— 静默丢掉一局自己的
// 机制，表现是"这些规则填了、看着生效、实际一条都没跑"，正是本仓库最忌讳的那类故障。
//
// ⚠️ **所以六个消费点的 `if (!ok) return err(message)` 一个字都不用改** —— 它们本来就在
// 处理"规则数据坏了"这一种情况，只是现在坏的东西多了一种。代价是**手改了存档里那份
// `ruleExt` 会让那个会话的检定与先攻全部停摆**，而这是刻意的：正常路径上 `beginCampaign`
// 已经拒绝过坏扩展了，能走到这里的只有"有人手工改了 `data/trpg/<会话>.json`"，
// 那时一句说清哪条坏了的话比"照常跑但机制全没了"有用得多。
// （计划里曾写过"回落到 `EMPTY_RULE_SET` + `console.warn`"——落地时否掉了：那要在六处各加
// 一段新代码来实现一个更坏的行为，而 `console.warn` 在这个本机 Bot 里没有任何人读。）
//
// ── 条数上限住在 `rules/rule-set.ts`，不在这里 ──
//
// `MAX_MECHANICS` 与其余几个上限一起写在 `rules/rule-set.ts` 里（计划里说"加到
// `model/limits.ts`"——落地时否掉了）：`rules/**` 是**纯函数目录**，它连相对 import 都不许
// 出目录，所以它没法从 `model/limits.ts` 取那个数。上限与判据住在同一个文件里是唯一的选择。
import { activeMechanics, compileRuleSet } from '../rules/rule-set.js';
import type { MechanicContext, RuntimeMechanic, RuntimeRuleSet } from '../rules/rule-set.js';
import type { CheckRule } from '../rules/check.js';
import type { RuleStore } from '../store/rule-store.js';
import type { TrpgCampaign } from '../types.js';

/**
 * 一次取用的结果。
 *
 * ⚠️ **它不叫 `RuleSetLookup`** —— 那个名字已经被 `rules/rule-set.ts` 的编译结果占了
 * （`{ok:true, set} | {ok:false, problems}`）。两者是不同的问题："这份 DSL 编译得过吗"
 * 与"这个会话此刻按什么规则判"。重名会让读的人以为其中一个能替另一个用。
 */
export type RuleAccess =
  | {
    ok: true;
    /** 基础规则表。原来的 `RuleLookup.rule`，**同一个对象**。 */
    base: CheckRule;
    /** 这一局的运行期规则集。没有 `ruleExt` 时是 `EMPTY_RULE_SET`（空集不是"没有规则"）。 */
    set: RuntimeRuleSet;
    /** 非空 = 基础表**回落了**（引用的表不存在）。原样写进回执，不许吞掉。 */
    note: string;
  }
  | {
    ok: false;
    /**
     * 坏在哪一头（P7-f 加）。**只有 `beginCampaign` 读它** —— 它决定回执里指哪份文件：
     * `'base'` 指规则表（`data/trpg/rules/<id>.json`），`'extension'` 指这一局的规则扩展
     * （`data/trpg/scenarios/<剧本>.rule.json`）。六处消费点**不读它**（它们只报一句话，
     * 此刻谁都没法去改文件）。
     */
    source: 'base' | 'extension';
    /**
     * 整句（多条问题用 `；` 连起来）。**六处消费点只读这一个字段** —— 所以它们的失败形状
     * 与 P7-d 之前逐字相同（`t-trpg-rules.mjs` 17b 有一条逐字断言钉着它）。
     */
    message: string;
    /**
     * **逐条**的问题原文，原样来自 `RuleStore.read` / `compileRuleSet`（这一层不重写它们，
     * 只把它们摊开）。给"逐条说清"的回执用：`beginCampaign` 一条一行印出去。
     *
     * ⚠️ 基础表那一路只有一条（`RuleStore` 自己已经把 `problems` 连成一句了），所以它是
     * `[message]`。**这不是"少了一种情况"**：那一头的分条能力住在 `rule-store.ts` 里，
     * 这里再拆一次就会变成第二份判据。
     */
    problems: readonly string[];
  };

/**
 * 吃"还没存盘的"那两个值 —— `beginCampaign` 用（拒绝开局时什么都别落）。
 *
 * `ruleExt` 收 `unknown`：它的唯一解释处是 `compileRuleSet`，而 `types.ts` 里那两个字段
 * 只能是 `unknown`（那个文件不许 import 本模块的任何东西）。`undefined` 与 `null` 一视同仁
 * （手写的 `.md` 一个扩展都没有，那是正常状态，不是错误）。
 */
export function ruleSetOf(ruleId: unknown, ruleExt: unknown, rules: RuleStore): RuleAccess {
  const found = rules.read(ruleId);
  if (!found.ok) {
    return { ok: false, source: 'base', message: found.message, problems: [found.message] };
  }
  const compiled = compileRuleSet(ruleExt ?? null);
  if (!compiled.ok) {
    // 逐条列出来、用 `；` 连起来：调用方（`.trpg new` 的回执、`beginCampaign` 的拒绝）
    // 要么整句照印，要么自己拆开逐条说 —— 两种都读得懂，而压成一句"规则扩展有问题"
    // 就再也没人知道该改哪一条了。
    return {
      ok: false,
      source: 'extension',
      message: `这一局的规则扩展有问题：${compiled.problems.join('；')}`,
      problems: compiled.problems
    };
  }
  return { ok: true, base: found.rule, set: compiled.set, note: found.note };
}

/** 六处消费点走的那一个。 */
export function ruleSetFor(campaign: TrpgCampaign, rules: RuleStore): RuleAccess {
  return ruleSetOf(campaign.rule, campaign.scenario?.ruleExt, rules);
}

/**
 * 当前局面 → 机制的求值上下文。
 *
 * 旗标要**摊平成 `名字 → 值`**：存档里那一份是 `{ value, visible }`（`TrpgFlag`，
 * 可见性给玩家视角用），而机制匹配只问"这个旗标等不等于这个值"。**暗线旗标照样进** ——
 * 机制本来就该能挂在暗线上（"真凶是医生"正是最该有机制的那条），可见性是展示层的事。
 *
 * `actor` / `skill` 没有就传空串（`MechanicContext` 的约定）：`{op:'actor'}` 那种机制
 * 因此只在"确实知道是谁"的那条路上命中 —— 裸掷骰不带行动者，它就不该被角色的机制影响。
 */
export function mechanicContextOf(
  campaign: TrpgCampaign, actor: string, skill: string
): MechanicContext {
  const flags: Record<string, string> = {};
  for (const [key, flag] of Object.entries(campaign.flags)) flags[key] = flag.value;
  return { scene: campaign.scene, flags, actor, skill };
}

/**
 * 这一局里**玩家不该看到名字**的旗标（暗线）。
 *
 * ── 它为什么是一个共享助手，而不是各调用点自己筛 ──
 *
 * `describeCheckModifiers` 在机制没有 `note` 时退到触发条件，而触发条件可能是暗线旗标
 * （`describeTrigger` 会印成 `旗标：真凶是医生 = 是`）。**凡是要给玩家看的地方**都要把那个
 * 名字遮掉，而"哪些地方要给玩家看"分散在三处：`.ra` / `.rh` 的回执（`commands/check.ts`）、
 * 以及 `roll` 工具**写进 `campaign.log` 的那一份**（`tools/roll.ts`）—— 后一处容易被漏掉，
 * 因为工具的结果本身是给模型的；但那份日志会被 `.trpg status` 印给全群（`PLAYER_LOG_KINDS`
 * 就收 `roll` / `check` 两类），也会镜像进战报、被 `.log export` 再发一次。
 *
 * 三处各筛一遍必然漂移，而漂移的表现是"这条命令遮住了、那条没有" —— 没有任何报错。
 * 所以判据（`visible === false`）与取值都收在这里一处，调用方只管传不传。
 */
export function secretFlagNames(campaign: TrpgCampaign): ReadonlySet<string> {
  const out = new Set<string>();
  for (const [key, flag] of Object.entries(campaign.flags)) {
    if (!flag.visible) out.add(key);
  }
  return out;
}

/**
 * 这一局面下**此刻**生效的机制 —— `campaign` 的两个钩子（换场景 / 开局）与 P7-e 的提示词共用它。
 *
 * `actor` / `skill` 都空着是**有意的**：那两样要到检定的那一刻才知道，而这里是"此刻这一场景
 * 下压着哪些规则"。所以 `{op:'actor'}` / `{op:'skill'}` 那两类机制在这一份里**不会**命中 ——
 * 它们只在 `applyCheckModifiers` 那条路上出现，这不是漏了。
 *
 * ⚠️ **读不出来时返回 `null`，不是空数组**：两件事不一样 —— 空数组是"这一刻没有机制命中"
 * （什么都不用说），`null` 是"我不知道"（该说一句读不出来）。合并成一个会让"规则集坏了"看起来
 * 像"这一场很太平"。正常路径上走不到 `null`：`beginCampaign` 已经拒绝过坏扩展，能到这儿的只有
 * "有人手改了 `data/trpg/<会话>.json` 里冻结的那份 `ruleExt`"。
 */
export function sceneMechanics(
  campaign: TrpgCampaign, rules: RuleStore
): readonly RuntimeMechanic[] | null {
  const found = ruleSetFor(campaign, rules);
  if (!found.ok) return null;
  return activeMechanics(found.set, mechanicContextOf(campaign, '', ''));
}
