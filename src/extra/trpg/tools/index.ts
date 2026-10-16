// 跑团工具的**装配**（从 `tools.ts` 拆出，2026-10-16）。
//
// 声明在 `spec.ts`，文案在 `extra/prompts.ts`，各工具的实现在本目录的四个文件里。
// 这里只做三件事：建一套闸门、把依赖分下去、按名字把四个处理函数拼成映射。
//
// ── 这一层的职责边界 ──
//
// 工具只做三件事：**校验参数 → 改状态 → 把"发生了什么"回给模型**。它**不发言**（`say` 除外 ——
// 它就是发言本身，因为接管模式下内置的 `send_message` 不在表里）。这条与仓库的
// 「工具不得代模型发言」是同一条：掷骰不会自动喊出点数，交不交代是模型自己的判断。
//
// ── "AI 不得直接改状态"这条契约落在哪 ──
//
// 落在 `tools/*` 这一层：HP / SAN / 旗标全部由代码钳制（`model/limits.ts` 的上限），
// 模型只能**请求**改动，请求带着"从多少变到多少"进日志。所以它没法在自己的叙述里偷偷把局势
// 改掉 —— 叙述与状态之间那条线，是这批工具画的。
//
// ── 为什么处理函数是工厂而不是模块级函数 ──
//
// 它们都要 `store` 与那两道闸门（而闸门要 `ctx`、账本按 `ctx` 分组）。提到模块级就得用一个
// 共享的可变对象把当前那一份挂出去 —— 而 `createHandlers` 在测试里会被调用好几次（每次一个
// 临时目录），共享对象会让第 N 次创建的 store 覆盖前面那个。工厂是唯一不会出这个错的写法。
import { createGates } from './shared.js';
import { createCampaignHandler } from './campaign.js';
import { createCharacterHandler } from './character.js';
import { createRollHandler } from './roll.js';
import { createSayHandler } from './say.js';
import type { Handler } from './shared.js';
import type { JournalPort } from '../model/campaign.js';
import type { DiceRng } from '../rules/dice.js';
import type { RuleStore } from '../store/rule-store.js';
import type { ScenarioStore } from '../store/scenario-store.js';
import type { TrpgStore } from '../store/campaign-store.js';

export type { Handler, TrpgNote, ToolGates } from './shared.js';

/** 组装根递给跑团的口子。 */
export interface TrpgToolDeps {
  store: TrpgStore;
  /** 规则表（从 `data/trpg/rules/` 读，坏表会拒绝而不是静默用别的）。 */
  rules: RuleStore;
  /** 剧本库（从 `data/trpg/scenarios/` 读）。 */
  scenarios: ScenarioStore;
  /** **必填**：规则层没有默认随机源（见 `rules/dice.ts` 的文件头）。生产用 `entropy.ts` 的 `secureRng`。 */
  rng: DiceRng;
  /** 把一条机器条目送进会话（落存档 + 入窗 + 通知面板）。缺省时不做任何事（测试与未接线时）。 */
  deliverNote?: (chatKey: string, note: import('./shared.js').TrpgNote) => void;
  /**
   * 战报（P2 起落地的是**写侧**）：每次落盘的日志都镜像一份进 `data/trpg/journal/<会话>.jsonl`。
   * 缺省不记（测试与未接线时）。
   */
  journal?: JournalPort | null;
}

export function createHandlers(deps: TrpgToolDeps): Record<string, Handler> {
  const { store, rules, scenarios, rng } = deps;
  // ⚠️ **一套闸门，四个工具共用**（`createGates` 里那个 WeakMap 是账本，见 `shared.ts` 的文件头）。
  // 每个工具各建一份的话，"同参数去重"与"主行动配额"就各算各的。
  const gates = createGates(store, deps.journal ?? null);

  return {
    say: createSayHandler({ store, journal: deps.journal }),
    campaign: createCampaignHandler({
      store, rules, scenarios, rng, gates, deliverNote: deps.deliverNote, journal: deps.journal
    }),
    character: createCharacterHandler({ store, gates, journal: deps.journal }),
    roll: createRollHandler({ store, rules, rng, gates })
  };
}
