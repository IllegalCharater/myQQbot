// **会话的状态机与开局/收团**（`beginCampaign` 2026-10-16 从 `tools.ts` 拆出，P2 加状态机）。
//
// ── 一局的两步：`preparing → active` ──
//
//   • **`preparing`**：人从 `.trpg new` 起的一局。大家 `.trpg join` 报名、`.pc new` 建卡、
//     `.pc confirm` 确认，然后 `.trpg start` 开跑。**卡没建完/没确认时不该开始** ——
//     否则 DM 一开局就得对着几张不存在的卡叙事。
//   • **`active`**：正在跑。DM 的 `campaign action=start` 直接建出这一档（"它说开就开"），
//     旧存档也一律读成这一档（迁移见 `model/campaign.ts`）。
//
// ── 为什么判据放这里而不是命令里 ──
//
// 三条命令（`join` / `start` / `end`）与工具都要问同一批问题："这个人能加入吗""能开始了吗"。
// 写在命令层就会有两份，而漂移的表现是"群里敲得动、模型敲不动"。
//
// ⚠️ `beginCampaign` 返回 `ToolResult`（`agent` 层的形状）是因为**命令与工具共用它**：
// 命令那边原样把 `content` 发进群、工具那边原样回给模型。`extra → agent` 是**合法方向**。
// 状态机那几个（`join` / `activate` / …）是纯数据变换，不返回 `ToolResult`。
//
// ── 本文件的 I/O ──
//
// 全靠参数传进来的端口（`store` / `rules` / `scenarios` / `journal`），自己不 import `node:fs` ——
// 这是 `model/` 那条闸门的要求。
import { err, ok } from '../../../agent/tools/shared.js';
import { MAX_PLAYERS, MAX_RULE_CHARS, MAX_SCENARIO_ID_CHARS, text } from './limits.js';
import { appendLog, emptyCampaign, mirrorLog } from './campaign.js';
import { ruleSetOf } from './rule-set.js';
import type { JournalPort } from './campaign.js';
import type { ToolArguments, ToolResult } from '../../../agent/shared/types.js';
import type { TrpgCampaign, TrpgCharacter, TrpgStatus } from '../types.js';
import type { TrpgStore } from '../store/campaign-store.js';
import type { RuleStore } from '../store/rule-store.js';
import type { ScenarioStore } from '../store/scenario-store.js';
import type { TrpgScenario } from '../scenario/parse.js';

export interface BeginDeps {
  store: TrpgStore;
  rules: RuleStore;
  scenarios: ScenarioStore;
  /** 战报（写侧）。缺省不记 —— 测试与未接线时。 */
  journal?: JournalPort | null;
}

// ── 状态机（纯）──────────────────────────────────────────────────────────────

export type Verdict = { ok: true } | { ok: false; reason: string };

/**
 * 玩家的 QQ 号判据。`players`、`ownerId`、三条命令都走它。
 *
 * ⚠️ **它不是唯一的落点**（这句曾经写成"只有这一处"，那是错的）：另有 4 处内联的
 * `/^\d+$/` 字面量 —— `tools/say.ts`（`atUserId`）、`tools/character.ts` 与
 * `model/character.ts`（`ownerId`）、`model/campaign.ts`（`players` 归一化）。
 * 它们各自都在**读一个不可信来源的字段**（工具参数 / 存档文件），就地判一次比跨层
 * 引一个 helper 更直白。**改判据时要五处一起改**（QQ 号是纯数字这条今天不会变，
 * 所以这四份拷贝的风险是可接受的）。
 */
export function isQq(value: unknown): boolean {
  return /^\d+$/.test(String(value ?? ''));
}

/** 这个 QQ 号在这一局里的卡。`preparing → active` 与 `.pc *` 都按它找"你的卡"。 */
export function playerOf(campaign: TrpgCampaign, qq: unknown): TrpgCharacter | null {
  if (!isQq(qq)) return null;
  const owner = String(qq);
  return campaign.characters.find((card) => card.ownerId === owner) ?? null;
}

/**
 * 能不能加入。
 *
 * **`active` 之后也允许加入**（"来晚了"是常态），只是回执里会说清"这一局已经在跑了" ——
 * 拒绝的话群友只剩"等下一局"一条路，而 DM 明明可以给他补一张卡。满员仍然拦住。
 */
export function canJoin(campaign: TrpgCampaign, qq: unknown): Verdict {
  if (!isQq(qq)) {
    return { ok: false, reason: '拿不到你的 QQ 号 —— 在群里直接敲就行' };
  }
  if (campaign.players.includes(String(qq))) return { ok: false, reason: '你已经在这一局里了' };
  if (campaign.players.length >= MAX_PLAYERS) {
    return { ok: false, reason: `这一局已经满了（${MAX_PLAYERS} 人）—— 等下一局，或者让主持人想办法` };
  }
  return { ok: true };
}

/** 加入（就地改，调用方负责写盘）。判据与 `canJoin` **同一份**。 */
export function join(campaign: TrpgCampaign, qq: unknown): Verdict {
  const verdict = canJoin(campaign, qq);
  if (!verdict.ok) return verdict;
  campaign.players.push(String(qq));
  return { ok: true };
}

/**
 * 能不能开跑。**"全员确认"是逐人查的**，所以拒绝时要说清是谁还没好、下一步敲什么 ——
 * 只说一句"还有人没确认"等于让群友互相猜。
 */
export function canActivate(campaign: TrpgCampaign): Verdict {
  if (campaign.status === 'active') return { ok: false, reason: '这一局已经在跑了' };
  if (!campaign.players.length) {
    return { ok: false, reason: '还没有人加入 —— 让要玩的人敲 `.trpg join`' };
  }
  const missing: string[] = [];
  for (const qq of campaign.players) {
    const card = playerOf(campaign, qq);
    if (!card) missing.push(`${qq} 还没建卡（\`.pc new <角色名>\`）`);
    else if (!card.confirmed) missing.push(`${card.name}（${qq}）还没确认（\`.pc confirm\`）`);
  }
  if (missing.length) return { ok: false, reason: `还差这些才能开始：\n· ${missing.join('\n· ')}` };
  return { ok: true };
}

/**
 * `preparing → active`（就地改）。返回 `false` = 判据没过（调用方先用 `canActivate` 拿原因）。
 *
 * ⚠️ **顺手落一条日志**（2026-10-19 加）。不加的话这个状态迁移对模型是**完全不可见的**：
 * `.trpg start` 是斜杠命令（落成已读历史、不唤醒模型），而 `renderForModel` 在两者之间
 * 只差一行"准备中"—— 消失得悄无声息。日志是模型下一轮唯一能看到的"刚才发生了什么"。
 *
 * `kind` 用 `state` 而不是 `scene`：`campaignSummary` 会把 `scene` 那几类拼成"走过的场景"，
 * 而"开跑"不是一处场景。
 */
export function activate(campaign: TrpgCampaign): boolean {
  if (campaign.status === 'active') return false;
  campaign.status = 'active';
  appendLog(campaign, 'state',
    `开跑：《${campaign.title}》（${campaign.players.length} 位玩家、${campaign.characters.length} 张人物卡）`);
  return true;
}

// ── 收团 ─────────────────────────────────────────────────────────────────────

/** `125` → `2 小时 5 分`；`40` → `40 分钟`。 */
function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 60) return `${minutes} 分钟`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

/**
 * 收团摘要：**时长 / 玩家 / 走过的场景 / 没解开的事**。
 *
 * 四项都由**代码**从状态里算出来，不是让模型总结 —— 敲这一条的是人，而人要看的是
 * "记下来的事实"。
 *
 * "没解开的事"取的是**暗线旗标**（`visible: false`）：那正是玩家不知道、而 DM 手上还攥着的
 * 线索。公开旗标不算 —— 那些已经说破了。
 */
export function campaignSummary(campaign: TrpgCampaign, now: number = Date.now()): string {
  const who = campaign.players.map((qq) => {
    const card = playerOf(campaign, qq);
    return card ? `${card.name}（${qq}）` : `${qq}（没建卡）`;
  });
  // ⚠️ **只收 `场景：` 开头的那一类**（2026-10-19 修）：这一族日志（`kind === 'scene'`）
  // 里混着三种东西 —— `场景：X`、`开团：《X》`，以及 `旗标：真凶是医生 = 是（暗线）`
  // （`tools/campaign.ts` 的 `setFlags` 也记成 `scene`）。原先靠"排除 `开团：`"来筛，
  // 于是**暗线旗标的名字会被当成一处场景印进收团摘要**发进群。改成白名单前缀之后，
  // 将来再加一类 `scene` 日志也不会意外漏进来。
  const scenes = campaign.log
    .filter((entry) => entry.kind === 'scene')
    .map((entry) => entry.text.trim())
    .filter((line) => line.startsWith('场景：'))
    .map((line) => line.replace(/^场景：/, '').trim())
    .filter(Boolean);
  const secrets = Object.entries(campaign.flags)
    .filter(([, flag]) => !flag.visible).map(([key]) => key);

  return [
    `《${campaign.title}》收团。这一局跑了 ${formatDuration(now - campaign.createdAt)}，`
      + `留下 ${campaign.log.length} 条记录、${campaign.characters.length} 张人物卡。`,
    `玩家：${who.join('、') || '（一个都没有）'}`,
    scenes.length ? `走过的场景：${scenes.join(' → ')}` : '',
    secrets.length ? `没解开的事（原本的暗线）：${secrets.join('、')}` : ''
  ].filter(Boolean).join('\n');
}

/**
 * 收团：**回一句摘要，然后把这一局的存档删掉**。
 *
 * 删而不是留，是因为 `beginCampaign` 见到已有存档会拒（"已经有《X》在跑了"）——
 * 留着旧存档，下一局就只能靠 `restart` 清，而那条路会连带清掉人物卡。删掉才让
 * "`.trpg new` 起一局 → 玩 → `.trpg end`"成为一个**能循环**的动作。
 *
 * 代价知情：**这一局的 `campaign.log` 也随之没了**。完整历史在战报（jsonl，
 * `store/journal-store.ts`）里 —— 那是 append-only 的，收团不动它。
 */
export function endCampaign(chatKey: string, store: TrpgStore): string {
  const campaign = store.read(chatKey);
  if (!campaign) return '这个会话当前没有在进行中的团。';
  const summary = campaignSummary(campaign);
  store.remove(chatKey);
  // ⚠️ **说清"什么没了、什么还在"**（2026-10-19 补）：删的只是这一局的存档
  // （`data/trpg/<会话>.json`）；剧本库与它的抽取产物（`.struct.json` / `.rule.json` /
  // `raw/`）住在 `data/trpg/scenarios/`、**以剧本为键**，`.trpg end` 碰不到它们 ——
  // 下次用同一份剧本开局**不用重抽**（那本来就是 7 次模型调用）。不说的话，"存档已经清掉"
  // 会被读成"连剧本也没了"。
  return `${summary}\n（这一局的存档已经清掉；战报留着，剧本库与它抽出来的结构也留着 —— `
    + '下次用同一份剧本开局不用重抽。要再开一局就敲 `.trpg new <名字>`）';
}

// ── 开局（**两个入口共用一个实现**）─────────────────────────────────────────

export interface BeginOptions {
  /**
   * 建出来的一局是 `preparing` 还是 `active`。缺省 `active`（"DM 说开就开"）。
   *
   * ⚠️ 这是**唯一**一个人工入口（`.trpg new`）与工具入口（`campaign action=start`）的差别：
   * 判据（已经开过局时怎么拒、剧本读不到时怎么办、规则表坏了怎么办）仍是同一份。
   */
  status?: TrpgStatus;
  /** 发起人（`.trpg new` 的人）—— 给了就顺手加进 `players`。工具路径不传。 */
  initiator?: string;
}

/**
 * 开一局。
 *
 * 剧本注入是**快照**（见 `types.ts` 的 `TrpgCampaign.scenario`）：骨架落进状态、正文复制进存档，
 * 此后与那个剧本文件再无关系。改剧本不该影响正在跑的团。
 */
export function beginCampaign(
  chatKey: string,
  args: ToolArguments,
  deps: BeginDeps,
  options: BeginOptions = {}
): ToolResult {
  const existing = deps.store.read(chatKey);
  if (existing && args?.restart !== true) {
    // ── 按**状态**分岔（2026-10-19 补）──
    //
    // 原先只有一句"已经有《X》在跑了"，而 `preparing` 的局**并没有在跑** —— 那句话是假话，
    // 更糟的是后面那句"真要推倒重来就把 restart 设成 true"：模型照着做会**清掉全队刚建好的卡**。
    // 这一档正确的下一步是"让群友敲 `.trpg start`"，而且必须是**人**来敲（`canActivate` 的闸门
    // 在那儿），模型没有那个工具 —— 所以要把这件事说明白，否则它会反复试 start。
    if (existing.status === 'preparing') {
      return err(`这一局还没开跑（《${existing.title}》，${existing.players.length} 人已加入、`
        + `${existing.characters.length} 张人物卡）。等大家建卡并确认之后，让群友敲 \`.trpg start\` 开跑 ——`
        + '那一步只能由人来敲，你不需要、也没有工具去开始或重开。'
        + '要改设定用 action=scene / flag，要改人用 character。');
    }
    return err(`这个会话已经有《${existing.title}》在跑了（${existing.characters.length} 张人物卡）。`
      + '改设定用 action=scene/flag、改人用 character；真要推倒重来，把 restart 设成 true'
      + '——那会清掉现有的卡与全部记录，先跟群友说一声');
  }

  // 剧本先读：读不到就**直接拒绝**，别开出一个"标题有了、骨架没有"的半截团。
  const wanted = text(args?.scenario, MAX_SCENARIO_ID_CHARS);
  let scenario: TrpgScenario | null = null;
  if (wanted) {
    const found = deps.scenarios.read(wanted);
    if (!found.ok) return err(found.message);
    scenario = found.scenario;
  }

  // 标题：显式给的优先，其次剧本的，最后从文件名兜底（剧本的 title 没写时用的就是它的 id）。
  const title = text(args?.title, 60) || scenario?.title || '';
  if (!title) {
    return err('要给这场团起个名字（title）—— 或者指定一份带标题的剧本（scenario）');
  }

  // 规则：显式给的 > 剧本推荐的 > generic。取规则这一步分三种失败，处理不同：
  //   • 引用的表**不存在** → 回落 generic，并把那句 note 原样写进回执（静默回落是本仓库
  //     最忌讳的那类故障："填了、看着生效、实际用的是别的"）；
  //   • 表**本身有问题** → 拒绝开局，把问题报上去让人去修（不是"随便换一套继续跑"）；
  //   • 剧本自带的**规则扩展**编译不过 → 同样拒绝，而且此刻**什么都还没写盘**（P7-d）。
  //
  // ⚠️ 这一条走的是**统一取用口**（`ruleSetOf`），不是 `deps.rules.read`：六处消费点读的是
  // 同一个函数，所以"开局时放行、运行期全部报错"这种两边不一致的状态在结构上就不可能出现。
  // 递进去的 `scenario?.ruleExt` 是**还没快照进战役**的那一份（战役对象此刻还没建出来）。
  const found = ruleSetOf(
    text(args?.rule, MAX_RULE_CHARS) || scenario?.rule || '', scenario?.ruleExt, deps.rules
  );
  if (!found.ok) {
    // 两条坏路，回执**分开**（P7-f）——判据是"此刻那个人能去改哪一份文件"：
    //   • 基础表坏了：原样照印 `rule-store.ts` 那句话（`规则表「X」有问题：…`）。
    //     **不许在这里改写**：六个消费点报的也是它，改一处就变成"开局时说的"与
    //     "跑起来报的"不是同一句话 —— 而那句正是排查时唯一能对上号的线索。
    //   • 规则扩展坏了：**逐条**说 + 指出去改哪份文件。这一条是给管理员看的，而
    //     "这一局的规则扩展有问题：A；B；C"那一整句在群里既读不下去、也没说改哪儿。
    if (found.source === 'base') return err(found.message);
    return err([
      '这份剧本的规则扩展有问题，开局停了：',
      ...found.problems.map((problem) => `· ${problem}`),
      scenario
        ? `改完 data/trpg/scenarios/${scenario.id}.rule.json 再开一次。`
        : '改完那份 .rule.json 再开一次。'
    ].join('\n'));
  }
  const rule = found.base;

  const campaign = emptyCampaign(chatKey, {
    title, system: text(args?.system, 60), rule: rule.id
  });
  campaign.status = options.status ?? 'active';
  if (isQq(options.initiator)) campaign.players.push(String(options.initiator));
  campaign.scene = text(args?.scene, 400) || scenario?.scene || '';

  if (scenario) {
    // 抽取产物（`struct` / `ruleExt`）**一起快照**，同 `body` 那条理由：改剧本文件不该影响
    // 正在跑的这一局。两个字段是可选的 —— 手写的 `.md` 一个都没有，那是正常状态。
    campaign.scenario = {
      id: scenario.id,
      body: scenario.body,
      ...(scenario.struct === undefined ? {} : { struct: scenario.struct }),
      ...(scenario.ruleExt === undefined ? {} : { ruleExt: scenario.ruleExt })
    };
    // 骨架落进状态。**预置的在前、同名不覆盖**：将来若支持"往已经跑着的团里补一份剧本"，
    // 场上的事实该赢过纸上的设定。
    campaign.flags = { ...scenario.flags, ...campaign.flags };
    for (const card of scenario.characters) {
      if (!campaign.characters.some((existingCard) => existingCard.name === card.name)) {
        campaign.characters.push(card);
      }
    }
  }

  // 战报要的"这次新加的那一条"就是**写之前**的 `seq`（它单调递增，见 `mirrorLog`）。
  const beforeSeq = campaign.seq;
  appendLog(campaign, 'scene',
    `开团：《${campaign.title}》${campaign.system ? `（${campaign.system}）` : ''} ｜ 检定规则：${rule.name}`
    + (scenario
      ? ` ｜ 剧本：${scenario.id}（预置 ${Object.keys(scenario.flags).length} 条旗标、${scenario.characters.length} 张人物卡）`
      : ''));
  deps.store.write(campaign);
  mirrorLog(campaign, beforeSeq, deps.journal ?? null);

  const next = campaign.status === 'preparing'
    ? '接下来让要玩的人敲 `.trpg join` 报名、`.pc new <角色名>` 建卡，都确认之后敲 `.trpg start` 开跑。'
    : '接下来用 character 的 action=create 补上玩家角色，然后开始叙事（发言记得用 say）。';
  // 抽取产物的两句话**只在真有东西要说时**才出现（手写的 `.md` 两个字段都没有）：
  //   • 有结构 → 说一句"它跟着进上下文"，否则管理员不知道那份 `.struct.json` 有没有生效；
  //   • 伴生坏了 → **明说，但开局照常**（`.md` 是好的，旁路文件不该掀翻一整局 —— 见
  //     `scenario-store.ts` 文件头那条）。两者都不是既有回执的形状，所以既有断言逐字不变。
  const extrasNote = (scenario?.struct === undefined
    ? ''
    : '这份剧本还带了一份抽取出来的剧情结构，会随状态一起进 DM 的上下文。')
    + (scenario?.extrasProblems?.length
      ? `\n注意：${scenario.extrasProblems.join('；')}。开局照常，但那份产物用不了 —— 重传一次剧本能刷新。`
      : '');
  return ok(`《${campaign.title}》已经开局，检定规则表是 ${rule.id}（${rule.name}）。`
    + (scenario
      ? `剧本「${scenario.id}」已注入：` + (scenario.body ? `正文 ${scenario.body.length} 字，` : '没有正文，')
        + `预置 ${Object.keys(scenario.flags).length} 条旗标、${campaign.characters.length} 张人物卡。`
      : '')
    + (found.note ? `注意：${found.note}。` : '')
    + extrasNote
    + next);
}
