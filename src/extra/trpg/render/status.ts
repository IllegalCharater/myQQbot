// **命令回执与清单**（从 `render.ts` 拆出，2026-10-16）。
//
// 这一层没有 I/O：清单由调用方（`commands/*`）现读目录后**递进来**。
// 它只负责"同一件事只有一份拼法" —— 剧本清单被三处共用（`.trpg scenario`、`.trpg new`、向导），
// 各写一遍的话，加一种状态（比如"有坏文件"）时必然漏掉其中一处。
//
// ⚠️ **这一层产出的字面量几乎全是群友可见的**（`renderBriefing` 那一段是唯一的例外，它只进
// system prompt），所以**不许出现 Markdown 的加粗记号 `**`** —— QQ 不认 Markdown，那些星号
// 会原样显示。`renderScenarioList` 被 `.trpg scenario`、`.trpg new` 与向导共用（三处都是群友可见），
// 所以它也守这条。
import { renderForPlayers } from './players.js';
import { parseStruct } from '../scenario/extract/schema.js';
import { describeMechanic } from '../rules/rule-set.js';
import type { RuntimeRuleSet } from '../rules/rule-set.js';
import type { ScenarioStruct } from '../scenario/extract/schema.js';
import type { TrpgCampaign } from '../types.js';

/** `.trpg status` 的回执：玩家视角 + 长度上限（命令回执不该长到刷屏）。 */
export function renderStatusCard(campaign: TrpgCampaign | null): string {
  return renderForPlayers(campaign).slice(0, 2000);
}

/**
 * 中间段要用的清单。**由 `impl.ts` 现读目录拿到** —— 渲染层不做 I/O（它连 config 都不碰）。
 */
export interface BriefingCatalog {
  scenarios: readonly { id: string; title: string }[];
  rules: readonly { id: string; name: string; description: string }[];
  /**
   * 这一局的运行期规则集（P7-e）。**由 `impl.ts` 现算递进来** —— 渲染层不做 I/O、也不碰 store。
   *
   * 三档语义，**不能合并**（合并的表现是"还没开局"被印成"规则集坏了"）：
   * - `undefined` = 这一局没有规则集可言（没有战役）→ 这一段什么都不印；
   * - `null` = 有战役、但那份规则扩展**读不出来** → 印一句"读不出来"（模型该知道检定会报错）；
   * - 一份集合 = 印（`EMPTY_RULE_SET` 那种空集 → 不印，那与"没有扩展"是同一个意思）。
   */
  set?: RuntimeRuleSet | null;
}

/** 每一类最多印几条。超出的说"还有 N 条" —— 这一段**每轮都进 system prompt**，是成本不是洁癖。 */
const STRUCT_PRINT_LIMIT = 8;

function listOf(items: readonly string[], limit: number = STRUCT_PRINT_LIMIT): string {
  const shown = items.slice(0, limit);
  const rest = items.length - shown.length;
  return shown.join('；') + (rest > 0 ? `（还有 ${rest} 条）` : '');
}

/**
 * 剧情结构的**一行式概览**（进 system prompt 的中间段）。空结构返回空串（调用方跳过它）。
 *
 * ── 为什么要有它 ──
 *
 * 抽出来的结构本来只躺在 `.struct.json` 里，而 DM 每轮只看到**压缩后的**正文 —— 那些
 * "某个 NPC 免疫普通伤害""这个场景的检定要加惩罚"的特殊设定，就又得靠它从散文里现读现猜，
 * 而那正是抽取要解决的事。这里把它摊平给 DM 看。
 *
 * ⚠️ **纯代码、确定性**：条目里的文字是模型**在抽取时**写的，拼装是我们写的 —— 别在这里
 * 调模型（同 `render.ts` 那条"受众不同就必须是两份实现"的分工）。
 * ⚠️ **"没抽准"那一句是说给模型听的**：它不知道该去核对什么，但"有些条目没核对上"这件事
 * 直接决定它该不该把某条当硬规则用。管理员看的是回执与 `.trpg check`，两者说的是同一件事。
 */
export function describeStruct(struct: ScenarioStruct): string {
  const lines: string[] = ['【剧情结构】（从剧本原文里抽出来的，按它来铺）'];
  if (struct.summary) lines.push(`概要：${struct.summary}`);

  if (struct.scenes.length) {
    lines.push(`场景（按顺序）：${listOf(struct.scenes.map((scene) => {
      const bits = [
        scene.npcs.length ? `在场：${scene.npcs.join('、')}` : '',
        scene.clues.length ? `线索：${scene.clues.join('、')}` : ''
      ].filter(Boolean).join('，');
      const name = scene.name || scene.summary;
      return bits ? `${name}（${bits}）` : name;
    }))}`);
  }
  if (struct.npcs.length) {
    lines.push(`NPC：${listOf(struct.npcs.map((npc) => {
      const bits = [npc.attitude, npc.location].filter(Boolean).join('，');
      return `${npc.name}${bits ? `（${bits}）` : ''}`;
    }))}`);
  }
  if (struct.clues.length) lines.push(`线索：${listOf(struct.clues.map((clue) => clue.text))}`);
  if (struct.items.length) {
    lines.push(`道具：${listOf(struct.items.map((item) => (item.location ? `${item.name}（${item.location}）` : item.name)))}`);
  }
  if (struct.mechanics.length) {
    lines.push(`特殊机制（检定与伤害要照它来）：${listOf(struct.mechanics.map((mechanic) => {
      const effect = mechanic.effectText || mechanic.note || mechanic.triggerText;
      const when = mechanic.triggerText ? `当${mechanic.triggerText}时，` : '';
      return `${when}${effect}（${mechanic.type}）`;
    }))}`);
  }

  if (lines.length === 1) return '';
  if (struct.warnings.length) {
    lines.push(`（有 ${struct.warnings.length} 条抽取结果没核对上，仅供参考 —— 别把它们当成板上钉钉的设定）`);
  }
  return lines.join('\n');
}

/**
 * **这一局的特殊规则**（进 system prompt 的中间段，P7-e）。
 *
 * ── 为什么它必须存在 ──
 *
 * 基础规则表只管"掷什么骰、多少算成功"，而真实模组里到处都是**那一本自己的规矩**。
 * `rules/rule-set.ts` 已经把那些机制编译成了能参与判定的东西（`roll` / `.ra` / `.rh` 真的
 * 会改目标值），可 DM **看不到它改了什么** —— 它只知道"点数对不上"。所以这里把机制摊平给它看。
 *
 * ── 三档，与 `BriefingCatalog.set` 那三档一一对应 ──
 *
 * 空集与 `undefined` 都返回空串（"没有特殊规则"与"这一局没有规则集"对模型是同一件事）；
 * `null` 印一句"读不出来" —— 那时每一次检定都会报错，**不说的话 DM 只会以为工具坏了**。
 *
 * ── 两条边界 ──
 *
 * ⚠️ **判定的那几条一条都不许截断**。`describeStruct` 每一类封顶 8 条（少一条线索只是少点
 * 风味），而机制少一条意味着"目标值被改了而 DM 不知道为什么" —— 条数上限只有编译期那一个
 * （`MAX_MECHANICS`），在这里再设一道就是**静默藏掉真的在生效的规则**。
 * 叙事那几条（`narrate`）不参与判定，用 `listOf` 封顶是安全的 —— 它们只是提示。
 *
 * ⚠️ **它是 system prompt 的一部分**，所以顺序即缓存：机制按**声明顺序**印（那一份整局不变），
 * 于是同一场团连着跑几轮，公共前缀能一直命中到这里之后。
 *
 * 唯一拼法：每一条都调 `describeMechanic`（与三条工具的回执同一份）—— 各拼一遍的话，
 * "回执里说的"与"提示词里说的"必然漂移，而那种不一致没有人会去核对。
 */
export function renderRuleNotes(set: RuntimeRuleSet | null): string {
  if (set === null) {
    return '【这一局的特殊规则】读不出来 —— 这一局的规则扩展坏了，检定与先攻都会报错。'
      + '如实跟群里说一句，别硬往下跑。';
  }
  const judging = set.mechanics.filter((mechanic) => mechanic.effect.handler !== 'narrate');
  const narrative = set.mechanics.filter((mechanic) => mechanic.effect.handler === 'narrate');
  if (!judging.length && !narrative.length) return '';

  const lines = ['【这一局的特殊规则】（这一本模组自己的规矩，判定照它来）'];
  for (const mechanic of judging) lines.push(`· ${describeMechanic(mechanic)}`);
  if (narrative.length) {
    lines.push(`· 还有些没能编译成判定的设定，按叙事处理：${listOf(narrative.map(describeMechanic))}`);
  }
  if (set.warnings.length) {
    // ⚠️ 措辞是「**没能编译成判定**」而不是「没编译进来」（P7-f 改）：四种 warning 里只有
    // "超过 MAX_MECHANICS"那一种是**真的没进集合**，另外三种（认不出的 type、narrative_hook
    // 写了别的 handler、effect 看不懂）都**降级成了 `narrate` 机制、确实在集合里** ——
    // 它们只是不参与判定。说成"没编译进来"是字面假话，而这句话是模型判断"我到底该不该照
    // 那条设定来"的唯一依据。所以判据是"进没进**判定**"，不是"进没进集合"。
    lines.push(`（有 ${set.warnings.length} 条机制没能编译成判定，判定时不算数`
      + ' —— 让管理员敲 `.trpg check` 看是哪几条）');
  }
  return lines.join('\n');
}

/**
 * `prompt(chatKey)` 的**中间段**：可用清单 + 这一局的剧本正文 + 抽出来的剧情结构 + 这一局的特殊规则。
 *
 * 它排在人格之后、状态之前 —— 顺序即缓存：清单只在管理员改文件时变、正文与结构整局不变，
 * 而状态每轮都变。把这两个稳定的放前面，system prompt 的公共前缀才能命中到状态变化点之前。
 *
 * 段内也是同一个道理：**清单在前、正文与结构在后**（清单对所有群都一样，后两样只有这一局是）。
 * P7-e 的规则说明**并进这一段，不新开一段** —— 它与正文同稳定度，而且段数一变，
 * "body 恒为 3 段"那条断言就废了（`promptPlan()` 会滤空串，段数飘忽没法断言）。
 *
 * ⚠️ **这一段永远非空**（规则清单至少有两个内置的）。
 */
export function renderBriefing(campaign: TrpgCampaign | null, catalog: BriefingCatalog): string {
  const lines: string[] = ['【剧本与规则】'];

  lines.push('这一局能选的剧本（开局时用 scenario 指定它的名字）：'
    + (catalog.scenarios.length
      ? catalog.scenarios.map((item) => `${item.id}${item.title && item.title !== item.id ? `（${item.title}）` : ''}`).join('、')
      : '（还没有任何剧本 —— 让管理员往 data/trpg/scenarios/ 里放一份，或在群里用 `.trpg scenario` 存一份）'));
  lines.push('这一局能选的检定规则（开局时用 rule 指定它的 id）：'
    + catalog.rules.map((item) => `${item.id}${item.description ? `（${item.description}）` : ''}`).join('；'));

  const ref = campaign?.scenario;
  if (ref?.id) {
    lines.push('', `这一局的剧本是「${ref.id}」${ref.body ? '，正文如下：' : '（它没有正文，只有骨架）'}`);
    if (ref.body) lines.push(ref.body);
    // 结构紧跟正文：它与正文**同稳定度**（开局时一起冻结进快照），排在状态之前才能命中前缀缓存。
    // 解不动就**不印**（那是管理员的文件坏了，回执里已经说过；对模型沉默才是对的 ——
    // 它没法修，而印一句"结构坏了"只会让它以为这一局有什么东西缺了）。
    const struct = parseStruct(ref.struct);
    if (struct.ok) {
      const described = describeStruct(struct.struct);
      if (described) lines.push('', described);
    }
  } else {
    lines.push('', '这一局没有注入剧本 —— 设定与主线由你自己发挥（或者让群友先挑一份再开局）。');
  }

  // 规则说明排在**正文与结构之后、状态之前**：它与前两样同稳定度（都来自开局时冻结进快照的
  // 那一份抽取产物），而状态每轮都变。放在 `if/else` **外面**是有意的 —— 它来自规则集，
  // 与"这一局有没有剧本"是两件事（`ruleExt` 今天只可能跟着剧本一起来，但判据不该依赖这个巧合）。
  //
  // ⚠️ **判据是 `!== undefined`，不许写成 `catalog.set ?? null`**：那会把"还没开局"（调用方
  // 压根没给）与"有战役但读不出来"（显式 `null`）合成同一档，于是每一个还没开团的会话都会
  // 拿到一句"规则扩展坏了"。两档的区别见 `BriefingCatalog.set`。
  if (catalog.set !== undefined) {
    const notes = renderRuleNotes(catalog.set);
    if (notes) lines.push('', notes);
  }

  return lines.join('\n');
}

/**
 * 剧本清单。`.trpg scenario`、`.trpg new`（不带名字那一次）与向导共用**这一份**拼法 ——
 * 三处各写一遍的话，加一种状态（比如"有坏文件"）时必然漏掉其中一处。
 */
export function renderScenarioList(scenarios: readonly string[]): string {
  if (!scenarios.length) {
    return '剧本库里还没有剧本。\n'
      + '把一份剧本（`.md` / `.txt` / `.docx` / `.pdf` 都行）发到群里，引用它敲 `.trpg scenario` 就收进来了。\n'
      + '不想要剧本也可以：直接 `.trpg new <随便是什么名字>` —— 那一局没有注入剧本，我自己发挥。';
  }
  return `剧本库里现在有：${scenarios.join('、')}\n`
    + '（要再加一份：把文件发到群里、引用它敲 `.trpg scenario`）';
}

/**
 * **未开局时的向导**：按开一局的顺序把下一步说清楚（P2 起是五步）。
 *
 * 为什么值得单独一份：`.trpg status` 在**已经开局**时给的是局势卡（玩的时候要看的就是它），
 * 而**还没开局**时给一张"（还没有人物卡）"的空卡等于什么都没说 —— 群里那位正需要知道
 * "接下来敲什么"。判据是"这个会话有没有战役"，确定性、不猜。
 */
export function renderWizard({ modeLabel, scenarios }: { modeLabel: string; scenarios: readonly string[] }): string {
  return [
    '【跑团】这个群还没开局。按这个顺序来：',
    '',
    `1. 定模式（当前：${modeLabel}）`,
    '   · `.trpg mode DM` —— 我当主持人：讲剧情、扮演 NPC、管人物卡与状态',
    '   · `.trpg mode 助手` —— 我只掷骰，别的什么都不做',
    '2. 传剧本（可选）：把剧本文件发到群里，引用它敲 `.trpg scenario`',
    '3. 起一局：`.trpg new <这一局的名字>`（或者写剧本名，就用那份剧本）',
    '4. 大家各自：`.trpg join` 报名 → `.pc new <角色名>` 建卡 → `.pc confirm` 确认',
    '5. 都确认了：`.trpg start` 开跑',
    '',
    renderScenarioList(scenarios)
  ].join('\n');
}

/** `.trpg scenario` 带了名字却没引用文件时的用法。 */
export const SCENARIO_USAGE = '用法：.trpg scenario [名字]\n'
  + '· 带名字：把引用的那个文件收进剧本库，用这个名字（`.md` / `.txt` / `.docx` / `.pdf` 都行）\n'
  + '· 不带名字：引用了文件就用文件名当名字；没引用就是列出剧本库';

/**
 * `.trpg check` **不带名字**时的用法（P7-b）。
 *
 * 它在这里而不在 `commands/verify.ts` 里，是为了与 `SCENARIO_USAGE` 并排 —— 这一族"带不带名字
 * 是两件事"的命令只有这两条，两份用法分居两处会让下一个人改一条忘一条。
 *
 * ⚠️ 与 `SCENARIO_USAGE` 一样是**群友可见文案**，所以不许出现 Markdown 的加粗记号。
 */
export const CHECK_USAGE = '用法：.trpg check <剧本名>\n'
  + '· 把这份剧本抽出来的东西摊开看：抽到几个场景 / NPC / 线索，有哪些待核项，原文切了几片\n'
  + '· 一次模型调用都不发，也不改任何文件 —— 随时可以敲\n'
  + '· 手改了 data/trpg/scenarios/<名字>.struct.json 之后再敲一次，看到的就是新的那一版';
