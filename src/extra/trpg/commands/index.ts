// 命令层的**装配清单**（从 `impl.ts` 拆出，2026-10-16）。
//
// 每条命令一个文件、一个工厂，这里只把依赖分下去、按 `spec.ts` 的词拼成映射 ——
// 与 `tools/index.ts` 同形。
//
// ── 键从哪来 ──
//
// 带 `subs` 的声明被 `runtime.ts` 展开成 `<命令> <子命令>`，**键就是那个串**
// （见 `ExtraCommandSpec.subs`）。所以这里写的键必须与 `spec.ts` 展开出来的逐个对上，
// 对不上就是**装载期拒绝装载**（`checkRuntimeShape` 两个方向都查）。
//
// ⚠️ **每个词只写一次**：下面那张表里，键与递进去的 `command` 是同一个值（`make(word)`）——
// 分开写的话，"键是 `.pc new` 而 handler 按 `.pc confirm` 切参数"这种错不会有任何编译
// 报错，只会让参数解析全错位。
//
// ⚠️ **匹配顺序由 `spec.ts` 决定**（`commandDefs()` 按那份声明的顺序产出），这里排成一样
// 只是为了读起来一致。每条**裸命令都必须排在它自己的子命令之后**：反过来的话它会把
// `.trpg start …` 整个吃掉。
import {
  createEndCommand, createJoinCommand, createNewCommand, createStartCommand,
  createStatusCommand, createUsageCommand
} from './session.js';
import {
  createCharacterConfirmCommand, createCharacterNewCommand, createCharacterRollCommand,
  createCharacterSaveCommand, createCharacterShowCommand, createCharacterUsageCommand
} from './character.js';
import { createCheckCommand, createSecretCheckCommand, createStatCommand } from './check.js';
import { createCombatCommand, createCombatUsageCommand } from './combat.js';
import { createLogCommand, createLogUsageCommand } from './log.js';
import { createModeCommand } from './mode.js';
import { createScenarioCommand } from './scenario.js';
import { createVerifyCommand } from './verify.js';
import { createDiceCommand } from './dice.js';
import type { CommandHandler } from './shared.js';
import type { JournalReadPort } from './log.js';
import type { ExtraUsage } from '../../types.js';
import type { JournalPort } from '../model/campaign.js';
import type { DiceRng } from '../rules/dice.js';
import type { RuleStore } from '../store/rule-store.js';
import type { ScenarioStore } from '../store/scenario-store.js';
import type { TrpgModeStore } from '../store/mode-store.js';
import type { TrpgStore } from '../store/campaign-store.js';

export interface CommandDeps {
  store: TrpgStore;
  rules: RuleStore;
  scenarios: ScenarioStore;
  modes: TrpgModeStore;
  /** 规则层没有默认随机源，`.r` 与工具共用同一个注入点。 */
  rng: DiceRng;
  /**
   * 战报。**两半都要**（`JournalStore` 一个对象同时实现它们）：写侧给其余命令记档，
   * 读侧只给 `.log export` 用。缺省 = 没接战报。
   */
  journal?: (JournalPort & JournalReadPort) | null;
  /** 私聊投递（暗骰）。缺省 = 没装通道，`.rh` 会如实说一句并且**不掷**。 */
  sendPrivate?: ((targetUserId: string, text: string) => Promise<void>) | null;
  /** 群文件投递（`.log export`）。缺省 = 没装通道，导出会如实说一句。 */
  sendFile?: ((chatKey: string, fileName: string, content: string) => Promise<void>) | null;
  /**
   * 记一次**独立模型调用**的用量（只有 `.rh` 的私密叙事有）。
   * 缺省 = 不记账（测试与未接线的宿主），调用照常进行 —— 见 `ExtraRuntimeDeps.recordUsage`。
   */
  recordUsage?: ((usage: ExtraUsage) => void) | null;
}

export function createCommands(deps: CommandDeps): Record<string, CommandHandler> {
  // `rng` 也进 base：`.pc roll` / `.ra` / `.rh` / `.st` 都要它（规则层没有默认随机源）。
  const base = {
    store: deps.store, rules: deps.rules, scenarios: deps.scenarios, modes: deps.modes,
    journal: deps.journal, rng: deps.rng
  };
  const rows: Array<[string, (command: string) => CommandHandler]> = [
    ['.trpg new', (command) => createNewCommand({ ...base, command })],
    ['.trpg join', (command) => createJoinCommand({ ...base, command })],
    ['.trpg status', (command) => createStatusCommand({ ...base, command })],
    ['.trpg start', (command) => createStartCommand({ ...base, command })],
    ['.trpg end', (command) => createEndCommand({ ...base, command })],
    ['.trpg mode', (command) => createModeCommand({ ...base, command })],
    ['.trpg scenario', (command) => createScenarioCommand({ ...base, command })],
    // 核对抽取结果（P7-b）：零模型调用、零写入。**排在自己的子命令之后、裸 `.trpg` 之前**
    // （顺序即行为，见文件头那条）。
    ['.trpg check', (command) => createVerifyCommand({ ...base, command })],
    ['.trpg', () => createUsageCommand()],
    ['.pc new', (command) => createCharacterNewCommand({ ...base, command })],
    ['.pc roll', (command) => createCharacterRollCommand({ ...base, command })],
    ['.pc confirm', (command) => createCharacterConfirmCommand({ ...base, command })],
    ['.pc show', (command) => createCharacterShowCommand({ ...base, command })],
    ['.pc save', (command) => createCharacterSaveCommand({ ...base, command })],
    ['.pc', () => createCharacterUsageCommand()],
    // 战斗（P5）：与 `campaign action=combat` 共用 `model/combat.ts`。
    ['.combat start', (command) => createCombatCommand({ ...base, command })],
    ['.combat next', (command) => createCombatCommand({ ...base, command })],
    ['.combat end', (command) => createCombatCommand({ ...base, command })],
    ['.combat', () => createCombatUsageCommand()],
    // 战报（P6）：导出这一局的完整记录。**不要求这一局还在**（`.trpg end` 不清战报）。
    ['.log export', (command) => createLogCommand({ ...base, sendFile: deps.sendFile, command })],
    ['.log', () => createLogUsageCommand()],
    // 检定与属性：都要读卡，所以都在 `commands/check.ts`。
    // `.ra` **不传 `sendPrivate`、也不传 `recordUsage`**（只有 `.rh` 会发起模型调用）；
    // `.st` 只收它真用的那三样（见 `StatCommandDeps`）。
    ['.ra', (command) => createCheckCommand({ ...base, command })],
    ['.rh', (command) => createSecretCheckCommand({
      ...base, sendPrivate: deps.sendPrivate, recordUsage: deps.recordUsage, command
    })],
    ['.st', (command) => createStatCommand({ store: deps.store, journal: deps.journal, command })],
    ['.r', (command) => createDiceCommand({ ...base, command })]
  ];
  return Object.fromEntries(rows.map(([word, make]) => [word, make(word)]));
}
