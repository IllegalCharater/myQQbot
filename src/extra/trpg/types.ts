// 跑团（TRPG）的领域类型。
//
// ⚠️ 本文件**不 import 本模块的任何文件**（同 `media/transcription/types.ts`、
// `media/jmcomic/types.ts` 的规矩）：它被 state / render / tools / impl / suggest 同时依赖，
// 反向依赖就成环。

/**
 * 一张人物卡上**可以被对玩家隐藏**的那几个字段。
 *
 * 字段级可见度是三级隔离里最省的那一级：它让"DM 知道全部、玩家只看到 `???`"不需要两份数据。
 * 取值是个封闭小集合（不像 NPC 那样十个字段各有三态）—— 本模块的卡本来就只有这几样东西。
 */
export const HIDDEN_FIELDS = ['stats', 'pools', 'notes'] as const;
export type HiddenField = (typeof HIDDEN_FIELDS)[number];

/**
 * 剧本正文的长度上限。
 *
 * 它**每轮都进 system prompt**，所以这个数是成本不是洁癖。一份典型剧本的世界观 + 主线在
 * 2–4k 字；再长就该拆成旗标/人物卡（那两样本来就是给"以后还要记得的事实"用的）。
 * 超限**当场拒绝**（而不是截断）：截断是在人还能改的时候不说、等到跑起来才少半段，而那时
 * 没人知道少了什么。落在这里而不是 `scenario.ts`，是因为 `state.ts` 的归一化也要用，
 * 而 `scenario.ts` 反过来 import `state.ts` —— 放本文件（零 import）两边都拿得到。
 */
export const MAX_SCENARIO_CHARS = 4000;

/**
 * 一张人物卡。
 *
 * ⚠️ **这里是"确定性状态"的家**：HP / SAN / 属性 / 技能都由**代码**持有并钳制，模型只能通过
 * 工具请求改动（`character`）。这正是跑团那条最要紧的分界 —— AI 负责叙事，代码负责状态；
 * 模型在叙述里说"你掉了三点血"而不调工具，群里的状态就与它说的对不上，
 * 而且**没有任何人会立刻发现**。
 *
 * `ownerId` 是玩家的 QQ 号，空串表示 NPC（由 DM 扮演，没有真人对应）。
 * 不区分"玩家角色 / NPC"两种结构：它们的字段完全一样，分开只会让渲染与工具都要写两份。
 */
export interface TrpgCharacter {
  name: string;
  /** 玩家 QQ 号；`''` = NPC。 */
  ownerId: string;
  /**
   * 属性与技能**合一张表**（键是名字、值是数）。
   *
   * 刻意不拆成 `attributes` / `skills` 两栏：跑团规则书五花八门（COC 是一长串百分技能，
   * D&D 是六属性 + 熟练），而"哪些算属性、哪些算技能"只有具体规则书说得清。本模块选了
   * 通用骰子表达式那条路（见 `rules/check.ts` 的 `CheckRule`），所以这里也**不替规则书分类**。
   */
  stats: Record<string, number>;
  hp: number;
  hpMax: number;
  san: number;
  sanMax: number;
  /** 自由文本备注（物品、状态、旧伤…）。有上限，因为它每轮都进提示词。 */
  notes: string[];
  /**
   * **实体级**可见度：玩家见过/知道这个人吗。
   *
   * `false` 时整张卡不进玩家视角的渲染 —— 用于"幕后反派""还没出场的线人"。
   * DM 那一份**照常显示**（它是 DM 的备忘录，不是玩家的清单）。
   */
  discovered: boolean;
  /** **字段级**可见度：这张卡上对玩家隐藏的字段名，取值见 `HIDDEN_FIELDS`。空数组 = 全可见。 */
  hidden: HiddenField[];
}

/** 一条跑团日志。 */
export interface TrpgLogEntry {
  /** 单调递增序号，**渲染时会印出来**（模型与群友都靠它指代"第 N 条"）。 */
  seq: number;
  ts: number;
  /**
   * `'narration'`（DM 说的话）| `'roll'`（掷骰）| `'check'`（检定）| `'state'`（状态变更）| `'scene'`。
   *
   * 是**给渲染层分类用的标签**，不是封闭枚举：加一种日志不必改这里，
   * 渲染层认不出来就当普通条目印。
   */
  kind: string;
  text: string;
}

/**
 * 一条剧情旗标。
 *
 * `visible: false` = **暗线**：DM 必须持续推进它，但玩家在笔记里只看到 `???`。
 * 与人物卡的两级（整张卡 + 字段）不同，旗标只有一级 —— 它本来就是"一句话事实"，
 * 没有"部分可见"可言。
 */
export interface TrpgFlag {
  value: string;
  visible: boolean;
}

/** 存档里那一份剧本的快照（见 `TrpgCampaign.scenario`）。`id` 空串 = 没注入剧本。 */
export interface TrpgScenarioRef {
  id: string;
  /** 正文。开局时从剧本文件里复制过来，之后与那个文件再无关系。 */
  body: string;
}

/** 一场跑团的全部状态。一个会话最多一场。 */
export interface TrpgCampaign {
  chatKey: string;
  title: string;
  /** 规则系统名（自由文本，如「通用骰子」「COC 7 版」）。**本模块不解释它**。 */
  system: string;
  /**
   * 检定规则表的 id（`rules/check.ts` 的 `LEVEL_RULES`）。认不出来一律回落到 `generic`。
   *
   * ⚠️ **与 `system` 分开是有意的**：`system` 是给人看的自由文本（"COC 7 版"也可能被写成
   * "克苏鲁"），而它决定的是"掷出来的这个数算不算成功"这个**确定性判断**。
   * 拿自由文本去做判断就是让拼写决定规则，所以判据是一个显式参数。
   */
  rule: string;
  /** 当前场景的一句话描述。 */
  scene: string;
  /**
   * 这一局用过的剧本 —— **开局时快照进来的，不是引用**。
   *
   * 为什么是快照：改剧本文件不该影响正在跑的团；存档要自洽（备份/恢复一致）；正文的落点与
   * "这一局的状态是一个文件"这条既有约定一致。代价是存档会大一点（正文最多
   * `MAX_SCENARIO_CHARS` 字）。`id` 空串 = 这一局没注入剧本（照旧由 DM 自己发挥）。
   */
  scenario: TrpgScenarioRef;
  /** 剧情旗标：键 → `{ value, visible }`。 */
  flags: Record<string, TrpgFlag>;
  characters: TrpgCharacter[];
  log: TrpgLogEntry[];
  /** 下一条日志的序号。单调递增、**只增不减**（截断旧日志不会让它回退，否则序号会重复）。 */
  seq: number;
  createdAt: number;
  updatedAt: number;
}
