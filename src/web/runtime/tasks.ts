// 长期后台任务的**描述侧**（S9）。设计见 docs/global-registry-design.md §6。
//
// 这张表回答的问题是："这个应用里有哪些活着的长期任务，谁负责、怎么开、怎么停、能不能真的停掉。"
// 它**只描述，不启动**——见下面第 1 条。
//
// ⚠️ **它与 `web/lifecycle.ts`（S11c 的执行侧）是一对，别把两者混起来**：
//   • 本表（描述侧，纯数据）回答"**有哪些**长期任务、谁开谁停、`conformance` 是什么"；
//   • `web/lifecycle.ts`（执行侧，纯编排）回答"**谁按什么顺序**把它们装起来、拆下来"。
// 两边各写一份 id 字面量（本文件**不**被 `lifecycle.ts` import，`src/` 里除定义处外也无人
// 引用 `LONG_TERM_TASKS`——有断言守），一致性由 `tests/t-lifecycle.mjs` 第 2 段**对账**：
// 两个 id 集合必须相等、无重复、每个 id 恰好被清单的一条 entry 覆盖。**因此"加一行"是一个
// 要动三处的动作**：本表、`lifecycle.ts` 的 `LIFECYCLE`、`app.ts` 的 `lifecycleDeps()`；
// 只改一处会被套件拦下。另外，S11c 起本表**不再**是"谁按什么顺序启动"的事实源——那是清单。
//
// ⚠️ 三条禁令（都是设计稿 §6.2 的显式决定，不是风格偏好）：
//
// 1. **表是纯数据，不得触发 start/stop，也不得靠模块加载期副作用启动任何东西。**
//    否则"import 一张表"就成了新的副作用源，违背 `AGENTS.md` 里"新增长期后台任务必须能
//    显式启停"的约束。所以这里存的是**入口的名字**（`TaskEntry`），不是函数引用——
//    这样 `tests/t-tasks.mjs` 能把名字拿到真对象上去解析，验证表没撒谎；存函数引用反而
//    只能自己验证自己。本文件里没有任何调度调用（套件会扫）。
// 2. **绝不包装 `setTimeout` / `setInterval` 全局。** 那样会静默吞掉按 §6.1 分界线排除掉的
//    那 17 个局部计时器（LLM 超时、重试退避、限速等待、单次扫图 flush…），把"排除清单"
//    变成谎言。局部计时器**不进这张表**，`tests/t-tasks.mjs` 有一条反向断言钉住。
// 3. **`conformance` 必须如实标注**，做不到的不许写成能力。S9 落地时原有 6 个任务里有 4 个
//    （`price.feed` / 两个 jmcomic / `onebot.reconnect`）**无法被真正接管**，因为接管它们
//    要先改启动、配置刷新或退出流程——那是 S9 及之前的禁止项。S10+ 解禁后逐步接管，
//    每步翻一个：S10a 收下 `price.feed`，S10b 收下两个 jmcomic（worker 如实标 `partial`：
//    停不掉正在跑的那一次下载），S10c 收下 `onebot.reconnect`——**至此原有 6 个任务的启停入口
//    全部到位**，没有任何一个任务还靠构造函数副作用启动，`partial` 只剩"停不掉正在跑的那一次"
//    这一种成因（`jmcomic.worker`）。
//
// `conformance` 与启停入口的对应关系（套件按这条规则断言，改规则要同时改套件）：
//   full    ⇒ start 与 stop 都在，且 `stopCancelsPending` 为 true
//   partial ⇒ 有 start 但 stop 缺失，或 stop 在、却取消不掉已经在等待中的那一次
//   none    ⇒ 连 start 都没有（只能靠构造函数副作用启动，且没有任何停止入口）
//
// owner 写**实际持有这些计时器的模块**，不是门面（同 `control-port.ts` 的 `METHOD_CATALOG`：
// `Orchestrator` 是薄门面，`startProactiveLoop` 只是转调 `ProactiveController`）。

/** 到哪儿去找某个启停入口。 */
export interface TaskEntry {
  /**
   * 承载这个名字的对象：
   * - `'Orchestrator'` / `'OneBotClient'` → 类方法，套件在原型或真实例上解析；
   * - `'price-feed'` / `'jmcomic'` → 模块导出；其余名字 → 类方法。
   */
  on: 'Orchestrator' | 'OneBotClient' | 'VideoTranscriptionQueue' | 'HotSearchScheduler' | 'price-feed' | 'jmcomic';
  kind: 'method' | 'export';
  name: string;
}

/** 开关来源。`null` 表示无条件运行，或由隐式条件决定（如"有下载任务就干活"）。 */
export interface TaskEnablement {
  /** 点分配置键路径，如 `'proactive.enabled'`。套件会到真实配置里按这条路径取值。 */
  path: string;
  /** 这个键怎么算"开着"：布尔真值，还是非空字符串（如 `api.priceRemoteUrl`）。 */
  kind: 'boolean' | 'non-empty';
}

export interface LongTermTask {
  /** 稳定标识，点分命名，与设计文档 §6.3 的表一致。 */
  id: string;
  /** 源码文件（仓库相对路径）。套件断言文件存在，且里面确实有调度调用。 */
  owner: string;
  /** 中文说明，供文档与将来的面板使用。 */
  label: string;
  enabledBy: TaskEnablement | null;
  /** `each-tick`：每 tick 重读配置；`on-apply`：配置保存时重建；`not-applicable`：无配置依赖。 */
  configRefresh: 'each-tick' | 'on-apply' | 'not-applicable';
  /** `false` = 这个任务**会把进程钉住**（影响退出语义，动它之前先看 §7.4）。 */
  unref: boolean;
  /** 更进一步：有待办时不 unref。仅 `jmcomic.worker` 有此形态。 */
  holdsProcessWhilePending?: boolean;
  /** 现存的启动入口；`null` = 没有独立入口，只能靠构造函数副作用启动。 */
  start: TaskEntry | null;
  /** 现存的停止入口；`null` = 没有任何停止入口。 */
  stop: TaskEntry | null;
  /**
   * `stop` 非 null 时才有意义：它能不能取消该任务**已经排定、但尚未触发的那一次**
   * （即句柄已交给宿主、正在等待的这一次）。`false` = 只能阻止下一次。
   * 它不回答"正在执行中的那一次能不能中断"——那是另一回事，写在 `note` 里。
   */
  stopCancelsPending: boolean;
  conformance: 'full' | 'partial' | 'none';
  /** 如实写明"为什么只能是这个 conformance"、以及接管它需要做什么。 */
  note: string;
}

/**
 * 8 个长期任务（原有 6 个 + 视频转写 worker + 每日热搜播报）。**不含** `wake.debounce`：那是每会话的唤醒防抖，按 §6.1 的分界线
 * （生命周期是否长于一次请求或一次会话）属于局部计时器，`tests/t-tasks.mjs` 有一条
 * 反向断言专门钉它不在表内——设计稿 §6.3 的表里把它列为第 7 行"排除"是清点时的写法，
 * 不是表的一行。
 */
export const LONG_TERM_TASKS: LongTermTask[] = [
  {
    id: 'hot-search.daily-broadcast',
    owner: 'src/web/runtime/hot-search/scheduler.ts',
    label: '每日全网热搜播报（Asia/Shanghai cron）',
    enabledBy: { path: 'hotSearchEnabled', kind: 'boolean' },
    configRefresh: 'on-apply',
    unref: true,
    start: { on: 'HotSearchScheduler', kind: 'method', name: 'start' },
    stop: { on: 'HotSearchScheduler', kind: 'method', name: 'stop' },
    stopCancelsPending: true,
    conformance: 'full',
    note: 'node-cron 句柄由 HotSearchScheduler 私有持有，stop() 会 destroy 未来计划并等待在途播报收尾；' +
      '配置保存经 applyConfigPatch → refresh() 原地重建。定时器 unref，不会单独钉住进程。'
  },
  {
    id: 'proactive.bubble',
    owner: 'src/agent/maintenance/proactive-controller.ts',
    label: '主动冒泡巡检（隔一段时间挑一个会话主动开话题）',
    enabledBy: { path: 'proactive.enabled', kind: 'boolean' },
    configRefresh: 'each-tick',
    unref: false,
    start: { on: 'Orchestrator', kind: 'method', name: 'startProactiveLoop' },
    stop: { on: 'Orchestrator', kind: 'method', name: 'stopProactiveLoop' },
    stopCancelsPending: true,
    conformance: 'full',
    note: '开关每 tick 现读配置，启停入口齐全且 stop 会清掉计时器句柄。' +
      '唯一未定性的是 unref：它会把进程钉住，这是有意还是疏忽没有注释说明（§10 待定 5），' +
      '改动会改变进程退出语义，必须先定性。'
  },
  {
    id: 'compact.sweep',
    owner: 'src/agent/maintenance/history-compactor.ts',
    label: '历史压缩巡检（摘要入档 + 原文冷归档）',
    enabledBy: { path: 'compact.enabled', kind: 'boolean' },
    configRefresh: 'each-tick',
    unref: true,
    start: { on: 'Orchestrator', kind: 'method', name: 'startCompactLoop' },
    stop: { on: 'Orchestrator', kind: 'method', name: 'stopCompactLoop' },
    stopCancelsPending: true,
    conformance: 'full',
    note: '与冒泡同构，但补了 unref()（纯维护任务不该把进程钉住），且首次延迟错开。' +
      '默认关闭，因为会调 LLM 花钱。'
  },
  {
    id: 'price.feed',
    owner: 'src/llm/price-feed.ts',
    label: '模型价格表定时刷新（每小时检查是否该拉）',
    enabledBy: { path: 'api.priceRemoteUrl', kind: 'non-empty' },
    configRefresh: 'on-apply',
    unref: true,
    start: { on: 'price-feed', kind: 'export', name: 'initPriceFeed' },
    stop: { on: 'price-feed', kind: 'export', name: 'stopPriceFeed' },
    stopCancelsPending: true,
    conformance: 'full',
    note: '模块级单例。S10a 起有 stopPriceFeed（清定时器、置 enabled=false，保留最后一次快照），' +
      'app.start() 里启动、app.stop() 里在 abortAll() 之后、onebot.close() 之前停止。' +
      'stopCancelsPending 为真：清的就是那个 setInterval 句柄。' +
      '配置保存走 applyConfigPatch → initPriceFeed 重新判定（S10a 修掉了"同 URL 早退却已清掉定时器"' +
      '导致的小时级刷新永久停摆）。'
  },
  {
    id: 'jmcomic.cleanup',
    owner: 'src/media/jmcomic.ts',
    label: 'jmcomic 下载缓存定期清理（首次还会立刻跑一次）',
    enabledBy: null,
    configRefresh: 'not-applicable',
    unref: true,
    start: { on: 'jmcomic', kind: 'export', name: 'initJmcomicQueue' },
    stop: { on: 'jmcomic', kind: 'export', name: 'stopJmcomicQueue' },
    stopCancelsPending: true,
    conformance: 'full',
    note: '模块级单例。S10b 起 initJmcomicQueue 移出 Orchestrator 构造函数，' +
      '改由 app.start() 启动、app.stop() 里在 onebot.close() 之前停止（上传阶段要用 onebot.call）。' +
      'stopCancelsPending 为真：stopJmcomicQueue 清的就是这个 setInterval 句柄（并顺带清 wake timer、置空 runtime）。'
  },
  {
    id: 'jmcomic.worker',
    owner: 'src/media/jmcomic.ts',
    label: 'jmcomic 下载 worker（复跑待办队列）',
    enabledBy: null,
    configRefresh: 'not-applicable',
    unref: false,
    holdsProcessWhilePending: true,
    start: { on: 'jmcomic', kind: 'export', name: 'initJmcomicQueue' },
    stop: { on: 'jmcomic', kind: 'export', name: 'stopJmcomicQueue' },
    // 只能阻止"下一次唤醒"（stopJmcomicQueue 清 wake timer + scheduleNextWake 的 !runtime 早退），
    // 停不掉**正在跑**的那一次下载 —— 所以是 partial。
    stopCancelsPending: false,
    conformance: 'partial',
    note: 'unref 形态与 cleanup 相反：有待办时不 unref（否则进程退出会把任务丢掉）。' +
      '**§10 待定 6 已定性（S10b）**：这是刻意的，本步不动 unref 策略，补上的是它缺的另一半 —— ' +
      'stop 之后 scheduleNextWake 不再排新 wake，队列不会把自己复活。' +
      '**停不掉正在跑的那一次下载**（如实标注，用户已确认接受）：Python 子进程句柄是 runPython 的 ' +
      'promise 局部变量，模块外拿不到；stop 把 runtime 置空后，那次下载的收尾会退化成空操作（各处都是 ' +
      'runtime?.），结果不会发出去。另一条语义：stop 之后再来一次 enqueueJmcomicDownload 会重新拉起队列' +
      '（懒初始化保留，避免工具回复"已加入队列"而队列永远不动）；现实中到不了 —— stop 只在退出路径上调用，' +
      '那时 abortAll() 已跑完、不会再产生新的模型轮次。'
  },
  {
    id: 'transcription.worker',
    owner: 'src/media/video-transcription.ts',
    label: '视频 URL 转写单并发 worker（FFmpeg → 腾讯云录音文件识别极速版）',
    enabledBy: null,
    configRefresh: 'not-applicable',
    unref: false,
    holdsProcessWhilePending: true,
    start: { on: 'VideoTranscriptionQueue', kind: 'method', name: 'start' },
    stop: { on: 'VideoTranscriptionQueue', kind: 'method', name: 'stop' },
    stopCancelsPending: true,
    conformance: 'full',
    note: 'app.start() 检查 FFmpeg 并启用队列；入队只排一个可取消的 wake，worker 始终单并发。' +
      'stop() 会清 wake、拒绝尚未执行的任务、终止当前 FFmpeg，并等待 worker 收尾与临时文件清理；' +
      '运行中会持有进程，避免无信号退出时静默丢任务。'
  },
  {
    id: 'onebot.reconnect',
    owner: 'src/qq/onebot.ts',
    label: 'OneBot 断线重连（固定 3s 间隔，无限重试）',
    enabledBy: null,
    configRefresh: 'not-applicable',
    unref: false,
    start: { on: 'OneBotClient', kind: 'method', name: 'connect' },
    stop: { on: 'OneBotClient', kind: 'method', name: 'close' },
    // S10c 起 #reconnectTimer 存了句柄，close()/connect()/reconnect() 三处都调 #cancelReconnect()，
    // 所以"已排定但尚未触发的那一次"真的取消得掉。刻意不 unref：有重连待办时钉住进程是对的。
    stopCancelsPending: true,
    conformance: 'full',
    note: 'S10c 起 #reconnectTimer 存了重连句柄，cancelReconnect 能清掉"已排定但尚未触发的那一次"，' +
      '于是 close() 真的停得住（同时不再白钉住事件循环）。S10c 之前那句"取消不掉已在等待中的重连"' +
      '只是表症：两处调度是裸 setTimeout、句柄没存，迟到的定时器会再进 #connectLoop 建第二个 ' +
      'WebSocket 覆盖 this.socket，connect()/reconnect() 刚作废旧 socket 的动作反而被漏掉（连接泄漏）。' +
      'S10c 把这两条路径一起修了。重连间隔是单一常量 RECONNECT_MIN_MS（3s、无限重试，不做指数退避）；' +
      'RECONNECT_MAX_MS 零引用，S11b 已删。**S11b 起配置刷新语义也补上了**：改 snowluma 的 ' +
      'wsUrl/httpUrl/accessToken/httpAccessToken 经 applyConfigPatch → OneBotClient.applyEndpoint ' +
      '**比较后**重连（值没变不重连，所以保存一次没动端点的设置不会断连）。'
  }
];
