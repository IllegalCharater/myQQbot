// 掷骰 / 检定结果的**展示**（从 `render.ts` 拆出，2026-10-16）。
//
// 这两份文本是**模型唯一能看到的骰子真相**（`roll` 工具的结果），也是 `.r` 命令发给群友
// 的那句话。所以两条纪律：
//   ① **每一颗骰子都印出来** —— "4d6kh3 → 14" 是不可复核的，玩家会问"我掷了哪四颗"；
//   ② 判据是**字段在不在**，不是值是否为零（同 `image-source/result-formatter.ts` 的规矩）：
//      算式明细由求值器给出（`DiceRoll.detail`），被丢弃的骰子才印"丢掉哪几颗"。
import type { CheckResult } from '../rules/check.js';
import type { DiceRoll } from '../rules/dice.js';
import type { CheckModifiers, RuntimeMechanic } from '../rules/rule-set.js';
import { describeMechanic, describeTrigger } from '../rules/rule-set.js';

/** `3d6 → 4+2+5 = 11`、`4d6kh3 → 6+3+5 = 14（掷出 1,6,3,5，丢掉 1 颗；骰子和 14）`。 */
export function formatRoll(roll: DiceRoll): string {
  const keptSum = roll.kept.reduce((total, value) => total + value, 0);
  // 没有骰子（纯数字表达式）时不印 `12 → 12 = 12` 那种废话。
  let line = roll.detail
    ? `${roll.expr} → ${roll.detail} = ${roll.total}`
    : `${roll.expr} = ${roll.total}`;
  // 被丢弃的骰子要说出来，否则 `4d6kh3` 与 `3d6` 在结果上分不出来。
  if (roll.dropped > 0) {
    line += `（掷出 ${roll.dice.join(',')}，丢掉 ${roll.dropped} 颗；骰子和 ${keptSum}）`;
  }
  return line;
}

/**
 * `1d100 → 47 = 47 ｜ 对 45 → 成功（差 2）`、`→ 成功（极难成功，超出 3）`。
 *
 * 档位的中文名**只从规则表来**（`result.label`）：`coc7` 的"极难成功/困难成功"与 `generic`
 * 的"大成功/大失败"都写在规则文件里，那才是权威。自定义 `judge` 不填 `label` 时就原样印
 * `grade` —— **这里刻意没有兜底表**：曾经有一张 `GRADE_LABEL`，它把 `success` 译成
 * "普通成功"而规则表给的是"成功"，同一个档位于是有两个名字，而改那张表不会影响真实输出
 * （规则表那条路永远带 `label`，兜底表根本走不到）。
 *
 * ⚠️ **档位名与"成功/失败"是同一个词时只印一次**：最常见的那一档（两套内置表的 `success`）
 * 就是这种情况，旧写法会印出「成功（成功，差 20）」，把成功说了两遍。
 */
export function formatCheck(result: CheckResult): string {
  const outcome = result.success ? '成功' : '失败';
  const grade = result.label ?? result.grade;
  const gap = result.margin === 0 ? '正好' : (result.margin > 0 ? `超出 ${result.margin}` : `差 ${-result.margin}`);
  return `${formatRoll(result.roll)} ｜ 对 ${result.target} → ${outcome}`
    + `（${grade === outcome ? gap : `${grade}，${gap}`}）`;
}

/**
 * 这一局的规则对**这次检定**做了什么（P7-d）。
 *
 * ⚠️ **必须说出去，不能悄悄算**：`formatCheck` 印的是**改过之后**的目标值，而 DM 手里那份
 * 卡上的数是原来那个 —— 不给一句话，它只会以为骰子坏了或者机制没生效，然后按错的数继续跑。
 * `overridden` 那条同理：`force_outcome` 盖住两条加减时，"为什么 -20 没算"必须有个答案
 * （那是 `CheckModifiers.overridden` 存在的全部理由）。
 *
 * 印的是机制的 `note`（写 `rule.json` 的人给它写的一句话），没有 `note` 才退到触发条件 ——
 * 两条都在 `rules/rule-set.ts` 里，不在这里再拼一遍。
 *
 * ⚠️ **已知代价**：这条文本既进 `roll` 工具的结果（给模型），也进 `.ra` 的回执（给群里）。
 * 而**触发条件可能是暗线旗标**（`旗标：真凶是医生 = 是`）—— 那种机制在 `.ra` 上命中时，
 * 群友会看到那个旗标名。没有更好的办法：目标值本身已经改了（`对 25` 与卡上的 45 对不上），
 * 那句话已经在泄露"有东西生效了"，而说清是哪一条是唯一能让 DM 把数对上的方式。**缓解手段
 * 是 `note`**：先印 `note`、只在它为空时才印触发条件，而 `note` 是写规则的人自己写的。
 *
 * 群友可见，所以**不许有 `**`**（`t-trpg.mjs` 5q 段扫的就是 `render/` 与 `commands/`）。
 * 没有机制命中时返回空串 —— 调用方按"有没有"决定要不要多印一行。
 */
export function describeCheckModifiers(mods: CheckModifiers): string {
  if (!mods.applied.length && !mods.overridden.length) return '';
  const name = (mechanic: RuntimeMechanic) => mechanic.note || describeTrigger(mechanic.trigger);
  const applied = mods.applied.map(name).join('、');
  if (mods.judge) {
    return `这一局的规则定了结果：${applied}`
      + (mods.overridden.length ? `（${mods.overridden.map(name).join('、')} 被它盖住，没算）` : '');
  }
  return `这一局的规则改了目标值：${applied}`;
}

/**
 * "这一场景下生效的规则"那一小段（P7-d 的 `campaign` 钩子，换场景与开局时附在回执末尾）。
 *
 * 空数组返回空串 —— 调用方按"有没有"决定要不要多印一段（同 `describeCheckModifiers`）。
 * 读不出来（`sceneMechanics` 给 `null`）时调用方**根本不该调它**：那是另一件事，见那边。
 *
 * 一行一条（`· ` 起头）：机制可能有好几条，横着串起来在群里/在工具结果里都读不清。
 * 每条用的是 `describeMechanic` —— 它是"一条机制的一行说明"的唯一拼法（提示词那一节也调它），
 * 在这里另拼一遍的话，"回执里说的"与"提示词里说的"必然漂移。
 *
 * ⚠️ **它只给模型，唯一的调用点是 `campaign` 工具**（`action=scene` 与 `action=start` 的回执）。
 * **绝不要在 `beginCampaign` 里调它** —— `.trpg new` 会把那份回执**原样印进群**
 * （`commands/session.ts` 里那句 `return String(result.content)`），而这里的每条名字来自
 * `describeMechanic`，它的 `note` 为空时会退到 `describeTrigger`，那会印出
 * `旗标：真凶是医生 = 是` 这样的暗线。所以"开局时报一次生效规则"由 `tools/campaign.ts`
 * 在 `beginCampaign` **之后**补一句（那一侧的回执只给模型）。
 *
 * 写进 `campaign.log` 的那一份（触发详情）由调用方标 `visible: false` —— 日志会镜像进战报，
 * 而战报是要发进群的。
 */
export function describeSceneMechanics(mechanics: readonly RuntimeMechanic[]): string {
  if (!mechanics.length) return '';
  return `\n这一场景下生效的规则：\n${mechanics.map((mechanic) => `· ${describeMechanic(mechanic)}`).join('\n')}`;
}

/**
 * 先攻序：`1. 阿飞 14\n2. 阿豪 12（倒下）`（P5）。
 *
 * 两个可选字段，判据都是**"字段在不在"**（同 `image-source` 的 `time` 与 `similarity` 两条规矩）：
 *   • `scores` 只有**排完那一次**手里有数值（`rollInitiative` 的返回）。中途渲染手里只有一份
 *     名字顺序，缺了就只印名字 —— **不印 `0`**：那会变成"这个人先攻是 0"，而真相是
 *     "我们此刻不知道他的先攻"。
 *   • `gone` 是已经动不了的人（卡没了 / 倒下了）。标出来，让"推进时会跳过谁"在文本里看得见。
 *
 * ⚠️ **`scores` 只该给模型看，不该进群、更不该进日志**：那个数就是卡上的属性（`DEX`），
 * 而 `hidden: ['stats']` 存在的理由正是"藏属性"；而日志会镜像进战报（P6 要导出成文件发群）。
 * 群友那一侧一律只传名字（`commands/combat.ts` 与 `render/players.ts` 都这么做）。
 *
 * 一行一个（不是 ` → ` 串起来）：这份列表会长到 20 人，横着串起来在群里折成好几屏。
 */
export interface InitiativeView {
  scores?: Record<string, number>;
  gone?: ReadonlySet<string>;
}

export function formatInitiative(order: readonly string[], view: InitiativeView = {}): string {
  return order
    .map((name, index) => {
      const score = view.scores?.[name];
      const mark = view.gone?.has(name) ? '（倒下）' : '';
      return `${index + 1}. ${name}${score === undefined ? '' : ` ${score}`}${mark}`;
    })
    .join('\n');
}

/**
 * 顺序的**紧凑写法**：`阿飞 → 阿豪（倒下） → 教授`（P5）。
 *
 * 与 `formatInitiative` 的分工：这一份**一行装得下**，所以它是"回执里顺带说一句现在什么局面"
 * 与"日志里留一条记录"用的；`formatInitiative` 那份一行一个，是排完先攻时的正式公布。
 * 两份都不印数值 —— 见 `InitiativeView` 那段（数值只给模型）。
 *
 * **日志那一处必须用它**：`appendLog` 的正文会镜像进战报（P6 要导出成文件发群），
 * 而战报是**给人看的**；多行的日志正文会破掉"一条日志一行"这个形状。
 */
export function formatOrder(order: readonly string[], gone?: ReadonlySet<string>): string {
  return order.map((name) => (gone?.has(name) ? `${name}（倒下）` : name)).join(' → ');
}
