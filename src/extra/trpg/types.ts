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
 * 没人知道少了什么。落在这里而不是 `scenario/parse.ts`，是因为 `model/campaign.ts` 的归一化也要用（`normalizeScenario`），
 * 而 `scenario/parse.ts` 反过来 import `model/campaign.ts` —— 放本文件（零 import）两边都拿得到。
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
  /**
   * 魔法值（P4 起，COC7 的 MP）。`mpMax` 为 0 = 这套规则/这张卡没有 MP 这个概念
   * （同 `sanMax` 那条：**印一个 `MP 0/0` 只会让人困惑**，所以渲染按"字段在不在"决定印不印）。
   */
  mp: number;
  mpMax: number;
  /**
   * **伤害加值**（Damage Bonus），形如 `+1d4` / `-2` / `0`。
   *
   * 它是**一条掷骰表达式**而不是数字 —— 因为它本来就要被掷（`1d4+DB`）。存字符串而不是存
   * "几个骰子"，是为了让 DM 把它原样写进 `.r` / `roll` 里，不必自己换算。
   * COC7 的表按 STR+SIZ 查，见 `rules/chargen.ts`。
   */
  db: string;
  /** 体格（Build）。与 DB 同一张表给出，两者不独立。 */
  build: number;
  /** 移动力（MOV）。COC7 按 STR/DEX 与 SIZ 的大小关系给 7/8/9。 */
  mov: number;
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
  /**
   * 玩家自己确认过这张卡了吗（`.pc confirm`）。`preparing → active` 的一道闸门。
   *
   * ⚠️ **缺省 false**，而旧存档里的卡统统是 false —— 那不会挡住任何旧局：迁移把"没有 `status`
   * 字段"的存档一律读成 `active`（见 `model/campaign.ts`），而 `confirmed` 只在 `preparing`
   * 那一档参与判定。DM 那一份渲染与工具都不读它（DM 建卡是"它说了算"）。
   */
  confirmed: boolean;
}

/** 一局处在哪一步。见 `model/session.ts` 的状态机。 */
export type TrpgStatus = 'preparing' | 'active';

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
  /**
   * 这一条属于**哪一局**（`TrpgCampaign.sessionId`）。**只有战报里会写它**，`campaign.log`
   * 里恒为 `undefined`（那一局只有一个 `sessionId`，写进每一条是纯冗余）。
   *
   * ⚠️ **它是"收团不清战报"那条取舍的补丁**（2026-10-19 加）：战报按**会话** append
   * （`data/trpg/journal/<会话>.jsonl`），而 `.trpg end` 只删存档、不清战报 —— 于是连开两局
   * 之后，导出的那份文件里两局的条目混在一起，而 `seq` 是**每局从 1 重来**的
   * （`emptyCampaign` 的 `seq: 1`）。没有这个字段的话，读那份战报的人看到的是一串
   * 重复的序号，没有任何线索指出"这里换了一局"。
   *
   * 旧战报没有它（那时也还没有"分界"这个概念），读回来是 `undefined` ——
   * 渲染层按"字段在不在"决定要不要印分界行（同 `visible` / `time` 那几条规矩）。
   */
  session?: string;
  /**
   * 这一条能不能进**给玩家看的战报**（`data/trpg/journal/`）。缺省 `true`。
   *
   * ── 为什么是一个字段，而不是"导出时按 kind 再筛一遍" ──
   *
   * 战报要导出成文件发进群（`.log export`），而 `campaign.log` 的正文里**混着藏起来的东西**：
   * `新建人物卡：线人（玩家尚未见过）`、`隐藏：pools/notes`、`旗标：真凶是医生 = 是（暗线）`、
   * 一张 `hidden: ['stats']` 的卡上的 `属性：DEX 87`。把它们原样发进群就是**把刚藏好的东西
   * 又说了一遍**，而且没有任何报错。
   *
   * `render/players.ts` 那一侧靠 `PLAYER_LOG_KINDS`（只印 `roll`/`check`）避开它，但**战报要的是
   * 完整**（人要看"这一局打过什么"），按 kind 整类丢会连公开的叙事与场景一起丢掉。所以判据换成
   * **逐条**的：**谁写的谁判** —— 写那条日志的人（`character` / `campaign` 的旗标分支）此刻
   * 手里正好有"这张卡藏了没有、这条旗标是不是暗线"，而**别处谁都判不出来**。
   *
   * ⚠️ **只有一个判据，就在写入那一刻**：`mirrorLog` 按它过滤（`visible !== false` 才进战报），
   * 导出路径**不再筛第二遍** —— 再筛一遍就是第二份判据，迟早与第一份漂移（同 `journal-store.ts`
   * 文件头那句"不必在这里再筛一遍"）。
   *
   * 缺省 `true` 是有意的：既有调用点（叙事、掷骰、场景、揭示）一个字都不用改，而"忘了标"
   * 的后果是**多记了一条**（`t-trpg.mjs` 那条整链断言会红），不是静默丢一条。
   */
  visible?: boolean;
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
  /**
   * 抽取出来的剧情结构（P7-a）。**原样存，不在这里解释** —— 本文件不许 import 本模块的
   * 任何东西（见文件头），所以它的类型只能是 `unknown`，唯一解释处是
   * `scenario/extract/schema.ts` 的 `parseStruct`。
   *
   * 它随快照**冻结**（同 `body`）：改剧本文件不影响正在跑的这一局。
   */
  struct?: unknown;
  /** 抽取出来的规则扩展（P7-c 起产出）。唯一解释处是 `rules/rule-set.ts` 的 `compileRuleSet`。 */
  ruleExt?: unknown;
}

/**
 * 一场正在进行中的战斗（P5）。`null` = 没在打。
 *
 * ── 为什么是"一个指针 + 一份名字顺序"，而不是一堆战斗单位对象 ──
 *
 * 战斗里**唯一需要被记住的状态就是"轮到谁了"**。HP、属性、备注全在人物卡上（那是唯一权威），
 * 这里再存一份就是同一件事的第二份，而两份必然漂移 —— 漂移的表现是"顺序里那个人还有 8 点血、
 * 卡上已经倒了"，谁也不会去核对。所以这里只放顺序与指针，**每次要问状态时回人物卡上现读**
 * （`immobileNames` 就是这么做的）。
 *
 * ── 为什么名字而不是下标 ──
 *
 * 顺序是**名单**：DM 中途加一个人、删一张卡、改一个名字，下标就会集体错位，而名字不会。
 * 代价是"卡被删了"这件事得单独认（`immobileNames` 把查不到卡的名字一并算成动不了）。
 */
export interface TrpgCombat {
  /**
   * 排先攻用的是卡上哪个属性（规则表的 `initiative`，缺省 `DEX`）。
   *
   * ⚠️ **必须记下来**：不记的话渲染与回执只能把 `DEX` 写死在展示层里 —— 那是规则书知识漏进
   * 显示层，而换一套规则（比如用 `敏捷` 排先攻的表）时，那句话会变成一个**不成立的解释**。
   * 记下来之后，"他们卡上没有 DEX"这句才能说准。
   */
  key: string;
  /** 名字，从先到后。**这是战斗里唯一的权威顺序**（下标就是 `turn`）。 */
  order: string[];
  /** 轮到 `order[turn]`。取值永远夹在 `[0, order.length)` 里（`rules/combat.ts` 的 `clampTurn`）。 */
  turn: number;
  /** 第几轮，从 1 起数。绕回队首一次算一轮。 */
  round: number;
  /** 卡上没有 `key` 那个属性的人。回执要点名 —— 他们按 0 参与排序，不说就像"先攻垫底"。 */
  missing: string[];
}

/** 一场跑团的全部状态。一个会话最多一场。 */
export interface TrpgCampaign {
  chatKey: string;
  /**
   * **这一局的身份**。`/trpg new` 时生成（`base36` 的时间戳），换局时换一个新的。
   *
   * 用途是"把这一局的东西认出来"：收团摘要的标题、日志里的指代，以及 P6 那个战报文件
   * 想让"哪几段属于同一局"看得出来（战报本身按会话 append，不按局分文件）。
   * **不是主键** —— 存档仍然一个会话一个文件（`data/trpg/<会话>.json`）。
   */
  sessionId: string;
  /**
   * 这一局走到哪一步了。缺省 `active`（**迁移**：旧存档没有这个字段，一律读成"已经在跑了" ——
   * 升级不该把正在进行的团退回建卡阶段）。判据与状态机在 `model/session.ts`。
   */
  status: TrpgStatus;
  /**
   * 加入了这一局的**玩家 QQ 号**（决策 2：玩家 = QQ 号，不引入账号体系）。
   *
   * 与 `characters[].ownerId` 是同一套身份的两种用法：这里管"谁报了名"（`.trpg join`），
   * 卡上那个管"这张卡是谁的"。`preparing → active` 要求两者对得上（见 `canActivate`）。
   */
  players: string[];
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
  /**
   * 正在进行的战斗（P5）。`null` = 没在打。
   *
   * ⚠️ **迁移取"更宽"的那一边**：旧存档没有这个字段，读成 `null`（= 没在打）是对的 ——
   * 它不会拦住任何既有玩法，也不会凭空造出一场谁都没开始的战斗。同 `status` 那条
   * （缺字段读成 `active`）与 `normalizeFlag` 对旧旗标形状的取舍：**缺省那一侧必须是
   * "少做一件事"而不是"多做一件事"**。
   */
  combat: TrpgCombat | null;
  log: TrpgLogEntry[];
  /** 下一条日志的序号。单调递增、**只增不减**（截断旧日志不会让它回退，否则序号会重复）。 */
  seq: number;
  createdAt: number;
  updatedAt: number;
}
