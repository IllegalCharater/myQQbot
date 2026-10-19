// `.trpg check <名字>` —— **核对抽取结果**（P7-b）。零模型调用、一个字都不写。
//
// ── 它为什么存在 ──
//
// 抽取管线（P7-a）把一份非结构化的模组变成三样东西：`.md`（压缩正文，唯一进 system prompt
// 的那一份）、`.struct.json`（剧情结构）、`.raw/`（原文切片，保底）。抽得对不对、有没有条目
// 被上限裁掉、引文对不对得上原文 —— **管理员在群里一处都看不到**。这条命令就是那个出口。
//
// ── 为什么是**第三份**渲染 ──
//
// 展示层已经有两份投影，受众不同：`renderForModel`（全量 + 标注）与 `renderForPlayers`
// （藏起来的东西根本不出现）。这一份的受众是**管理员**，判据与那两份都不同：
//   • 它要报**抽取的账**（切了几片、有几条待核项、哪个伴生文件读不动）—— 模型与玩家都不需要；
//   • 它要说**下一步敲什么**（改哪个文件、再敲哪条命令）—— 另两份都不管这个。
// 所以它是第三份实现，**不复用 `describeStruct`**：那一份是给模型的压缩视图（每类封顶 8 条、
// 待核项只给一个计数）。共用会让两边漂移，而漂移的表现是"管理员看到的与模型看到的不是同一
// 件事"—— 那恰恰是这份回执要回答的问题本身。
//
// ── 零模型调用、零写入 ──
//
// 它只读目录与三个伴生文件（`ScenarioStore.read` 一次读全），**一个字都不写**。所以它可以随时
// 敲、敲多少次都不要钱 —— 这是"手改结构文件、再核对一遍"那个工作流的全部依据（`read()` 的
// 缓存签名把三个伴生的 mtime 都算进去了，所以改了立刻读得到新的一版）。
//
// ── 权限 ──
//
// 与其余命令一致（白名单会话里可敲）。**已知代价**（与 `.trpg scenario` 同源）：白名单群里
// 任何群友本来就能传一份剧本把它覆盖掉，所以"能看抽取结果"不增加泄漏面。要收紧只需在这个
// handler 里加一句判据。
import { parseStruct } from '../scenario/extract/schema.js';
import { compileRuleSet, describeMechanic, describeTrigger } from '../rules/rule-set.js';
import { describeEnding } from '../scenario/endings.js';
import { CHECK_USAGE, renderScenarioList } from '../render/status.js';
import { argsOf, scenarioIds } from './shared.js';
import type { CommandHandler } from './shared.js';
import type { ScenarioStore } from '../store/scenario-store.js';
import type { TrpgStore } from '../store/campaign-store.js';

/**
 * 待核项最多逐条印几条，超出的说一句"还有 N 条"。
 *
 * 值恰好与 `render/status.ts` 的 `STRUCT_PRINT_LIMIT` 相同，但**不是同一个判据**：那一个是
 * "每轮进 system prompt 的成本上限"，这一个只是"回执别长到刷屏"。两处各自写死、各自可调 ——
 * 合成一个常量的话，改提示词预算会顺手改掉命令回执的长度。
 */
const WARN_PRINT_LIMIT = 8;

export interface VerifyCommandDeps {
  store: TrpgStore;
  scenarios: ScenarioStore;
  /** 这条命令的词（`'.trpg check'`）—— 由 `commands/index.ts` 递进来，见 `argsOf`。 */
  command: string;
}

/**
 * `.trpg check [名字]` —— 把一份剧本抽出来的东西摊开给管理员看。
 *
 * 三段：**统计**（抽到了什么）、**待核项**（哪些没核对上）、**下一步**（开一局 / 改哪个文件）。
 * 不带名字就是用法 + 剧本库清单（复用 `renderScenarioList`，那一份拼法三处共用）。
 */
export function createVerifyCommand({ store, scenarios, command }: VerifyCommandDeps): CommandHandler {
  return async (input) => {
    const name = argsOf(input, command)[0];
    if (!name) return `${CHECK_USAGE}\n\n${renderScenarioList(scenarioIds(scenarios))}`;

    const found = scenarios.read(name);
    // `read()` 的失败文案**已经带上了"现在有：…"**（见 `store/scenario-store.ts`），所以这里
    // 不再拼第二遍清单 —— 拼一遍会让同一句话出现两次。
    if (!found.ok) return found.message;

    const scenario = found.scenario;
    const struct = parseStruct(scenario.struct);
    const problems = scenario.extrasProblems ?? [];
    const lines: string[] = [`【剧本核对】${scenario.id}`];

    lines.push(`标题：${scenario.title}${scenario.rule ? `（推荐规则表：${scenario.rule}）` : ''}`);
    // ⚠️ 这里**不报"丢了多少字"**：`droppedChars` 只活在抽取那一次的 `ExtractResult` 里，
    // 没落盘。它并没有丢 —— 管线把"原文太长，只抽了前 N 片（还有 X 字没进抽取）"写进了
    // `struct.warnings`，所以那句话会出现在下面的**待核项**里。想在这儿印就得再存一个字段，
    // 而那个字段唯一的消费者就是这一行，不值得。
    lines.push(`正文 ${scenario.body.length} 字，原文切片 ${scenario.rawParts ?? 0} 片`);

    if (struct.ok) {
      const counts = struct.struct;
      lines.push(`剧情结构：${counts.scenes.length} 个场景、${counts.npcs.length} 个 NPC、`
        + `${counts.clues.length} 条线索、${counts.items.length} 件道具、${counts.mechanics.length} 条机制`);
    } else if (problems.length) {
      // 伴生文件在、但读不动。措辞是"没有可用的"而不是"还没有抽取产物"：`parseStruct` 那一句
      // 在**文件解不开**时也会出现（`#readJson` 解不动时交出来的就是 `undefined`），而那时
      // "没抽过"是错的 —— 抽过，只是文件坏了。
      lines.push('剧情结构：没有可用的 —— 原因见下面的「伴生文件」');
    } else {
      lines.push(`剧情结构：${struct.message}`);
    }

    // ── 阶段（P8）──
    //
    // ⚠️ **只印幕名 / 序号 / 场景 / 完成条件**。`goal` 与 `keeperNotes` 都不印：这条命令
    // 在**群里**敲，而那两个字段标着"DM 可见 / 仅 DM"。要看它们请直接读
    // `data/trpg/scenarios/<id>.struct.json` —— 那才是这个页面的"详细信息"。
    if (struct.ok && struct.struct.acts.length) {
      lines.push('', `阶段：${struct.struct.acts.length} 幕`);
      for (const act of struct.struct.acts) {
        const tail = [
          act.scenes.length ? `场景：${act.scenes.join('、')}` : '没有关联场景',
          act.exitCondition ? `完成条件：${describeTrigger(act.exitCondition)}` : ''
        ].filter(Boolean).join('；');
        lines.push(`· 第 ${act.order} 幕「${act.name}」${act.visible ? '' : '（暗线幕）'}${tail ? `｜${tail}` : ''}`);
      }
    }

    // ── 结局（P8-c）──
    //
    // 与阶段那一段同一条边界：**只印名字 / 触发 / 奖励**。`readAloud` 与 `keeperNotes`
    // 都不印 —— 这条命令在群里敲，而它们要么是"念给玩家听的原文"，要么是"仅 DM"。
    if (struct.ok && struct.struct.endings.length) {
      lines.push('', `结局：${struct.struct.endings.length} 个`);
      for (const ending of struct.struct.endings) lines.push(`· ${describeEnding(ending)}`);
    }

    // ── 规则扩展（P7-f）──
    //
    // 三类**分开列**，判据只有一条：`effect.handler` 是不是 `narrate`（编译期就定了，不是这里猜的）。
    // 为什么非分不可：可执行的那几条**真的会改检定与伤害**，而叙事那几条不会 —— 混在一张单子里，
    // 管理员没法回答"这份模组到底改了什么判定"这个唯一要紧的问题。
    //
    // ⚠️ 它**不复用** `renderRuleNotes`（`render/status.ts` 那一份）：那一段每轮进 system prompt，
    // 所以它给模型的只有机制清单 + 一句计数；这里给管理员的是**全量 + 编译期的账 + 下一步**。
    // 共用会让两边漂移，而漂移的表现是"管理员看到的与模型看到的不是同一件事"。
    const compiled = compileRuleSet(scenario.ruleExt ?? null);
    if (!compiled.ok) {
      // 读不出来要说清"开局会被拒" —— 否则管理员看到一堆问题却不知道它此刻有没有生效。
      lines.push('', '规则扩展：读不出来（这份规则扩展坏了，用它的那一局开局会被拒）：');
      for (const problem of compiled.problems) lines.push(`· ${problem}`);
    } else {
      const set = compiled.set;
      const judging = set.mechanics.filter((mechanic) => mechanic.effect.handler !== 'narrate');
      const narrative = set.mechanics.filter((mechanic) => mechanic.effect.handler === 'narrate');
      if (judging.length || narrative.length || set.warnings.length) {
        lines.push('', `规则扩展：可执行 ${judging.length} 条、只作叙事提示 ${narrative.length} 条、`
          + `编译时没进判定 ${set.warnings.length} 条`);
        if (judging.length) {
          lines.push('可执行的（检定与伤害照它来）：');
          // **一条都不截断**（同 `renderRuleNotes` 那条）：少印一条 = 管理员以为这份模组没这条规则。
          for (const mechanic of judging) lines.push(`· ${describeMechanic(mechanic)}`);
        }
        if (narrative.length) {
          lines.push('只作叙事提示的（不参与判定，DM 拿它当氛围参考）：');
          for (const mechanic of narrative) lines.push(`· ${describeMechanic(mechanic)}`);
        }
        if (set.warnings.length) {
          // 认不出的 type / 写坏的 effect / 条数超限 —— 这些**原文里还在**，只是没变成规则。
          // 逐条原样印（它们是编译期写好的句子，这里不重写：重写一份必然与那边漂移）。
          lines.push('编译时没进判定的：');
          for (const warning of set.warnings) lines.push(`· ${warning}`);
        }
      } else if (scenario.ruleExt === undefined) {
        lines.push('', '规则扩展：没有 —— 这份剧本的检定按基础规则表走。');
      } else {
        lines.push('', '规则扩展：空的（文件在，但里面一条机制都没有）。');
      }
    }

    // 待核项。**只有结构读出来了才谈得上待核项** —— 读不出来时印一句"没有"是假的。
    const warnings = struct.ok ? struct.struct.warnings : [];
    if (warnings.length) {
      lines.push('', `待核项（${warnings.length} 条）：`);
      for (const warning of warnings.slice(0, WARN_PRINT_LIMIT)) lines.push(`· ${warning}`);
      if (warnings.length > WARN_PRINT_LIMIT) {
        lines.push(`· （还有 ${warnings.length - WARN_PRINT_LIMIT} 条没列 —— 它们都在 struct.json 里）`);
      }
    } else if (struct.ok) {
      lines.push('', '待核项：没有。');
    }

    // 伴生文件的问题（解不开的 JSON）。它**不掀翻剧本**（`.md` 是好的），所以它是一段附注而不是
    // 一个错误；但它是"结构为什么没有可用的"的唯一线索，所以必须印出来。
    if (problems.length) {
      lines.push('', '伴生文件：');
      for (const problem of problems) lines.push(`· ${problem}`);
    }

    // 下一步。**正在用这份剧本的那一局**优先说 —— 那时"去开一局"是错的提示。
    lines.push('');
    const campaign = store.read(input.chatKey);
    if (campaign?.scenario?.id === scenario.id) {
      lines.push(`《${campaign.title}》正在用这份剧本 —— 改完结构文件再敲一次这条命令就能核对。`);
    } else if (struct.ok) {
      lines.push(`要开局：.trpg new ${scenario.id}`);
    } else if (scenario.rawParts) {
      // ⚠️ **"原文切片在、结构不在"是一档独立的状态**（2026-10-19 加），不能并进下面那句
      // "没有抽取产物"：抽取**跑过**，只是没成（超时 / 模型没按格式答），管线把切好的原文
      // 交了出来。说"没有抽取产物"会让管理员以为得从头再来一遍 —— 而他手里已经有一份完整的
      // 原文副本（`<id>.raw/`），那正是降级路径最要紧的那件东西（后备整理实测 7345 → 2687 字）。
      //
      // ⚠️ 判据是 `scenario.rawParts`（**磁盘上真有几片**），不是"回执上说抽过"。后者没落盘，
      // 而且这条命令刻意不读任何"上次的回执"。
      //
      // ⚠️ 两种成因共用这一段：**一片都没抽成**（`struct` 压根没写）与**结构文件坏了**
      // （`problems` 非空）。上面那行"剧情结构：…"已经把成因分开了，所以这里**不指方向**
      // （一种成因的线索在上面、另一种在下面，写死哪一边都会有一半的时候是错的）。
      lines.push(`抽取产物不全：剧情结构没有可用的，`
        + `但原文切片还在（${scenario.rawParts} 片，在 data/trpg/scenarios/${scenario.id}.raw/）。`);
      lines.push(`要补结构：照着切片手写一份 data/trpg/scenarios/${scenario.id}.struct.json，`
        + '再敲一次这条命令就能核对（它只读不写，随便改随便验）。');
      lines.push(`要重抽一遍：把原始文件重新发到群里、引用它敲 \`.trpg scenario ${scenario.id}\` —— `
        + '⚠️ 太长的那份重发一次多半还是不够，先看上面那条建议。');
    } else {
      lines.push('这份剧本没有抽取产物。手写的、格式本来就对的剧本不会走抽取，那是正常的；'
        + `要抽一遍：把原始文件重新发到群里、引用它敲 \`.trpg scenario ${scenario.id}\`。`);
    }
    if (struct.ok) {
      lines.push(`要改：编辑 data/trpg/scenarios/${scenario.id}.struct.json，`
        + `再敲一次 \`.trpg check ${scenario.id}\`。`);
    }
    // 规则扩展是**另一份文件**（`<id>.rule.json`）：结构与机制分居两处，所以"要改哪个文件"
    // 有两句。⚠️ 判据是 `!== undefined` —— 手写的剧本一个扩展都没有（`read()` 那一步就不写
    // 这个字段），那时印一句"要改 rule.json"是让人去改一份**不存在**的文件。
    if (scenario.ruleExt !== undefined) {
      lines.push(`规则扩展要改：编辑 data/trpg/scenarios/${scenario.id}.rule.json，`
        + `再敲一次 \`.trpg check ${scenario.id}\` 核对。`);
    }

    return lines.join('\n');
  };
}
