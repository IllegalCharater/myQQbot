// 长期任务的**装配清单**（S11c，注册层的执行侧）。设计与边界见 docs/global-registry-design.md
// §0 / §6.2 / §7.1 / §7.4。
//
// 它与 `web/tasks.ts` 是一对互补的东西，别把两者混起来：
//   • `web/tasks.ts`（**描述侧**，纯数据）回答"**有哪些**长期任务、谁开谁停、conformance 是什么"；
//   • 本文件（**执行侧**，纯编排）回答"**谁按什么顺序**把它们装起来、拆下来"。
// 两边靠 `tests/t-lifecycle.mjs` 第 2 段的**对账**咬合：本表所有 entry 的 `ids` 并起来必须恰好
// 等于 `LONG_TERM_TASKS` 的 id 集合。本文件**不 import 那张表**（`t-tasks.mjs` 有一条"`src/` 除
// 定义处外无人引用 `LONG_TERM_TASKS`"的断言），两边各写一份 id 字面量，一致性由套件负责。
//
// ⚠️ 这是**静态装配清单**，不是被禁的"按名字分发的运行时注册表"（路线图禁令，§5.3/§5.4）。
// 三条性质写在这里，每条都有断言（`tests/t-lifecycle.mjs` 第 3 段）：
//   1. `start`/`stop` 存的是**函数引用**，运行期只按数组顺序 `for...of` 遍历 —— 没有任何
//      `LIFECYCLE[动态键]`、`.find(`、`.filter(`、`.get(`。套件会剥注释后扫 `src/`。
//   2. `ids` 只作**对账元数据**（给套件与文档用），运行期从不参与任何决策。
//   3. **import 本文件不启动任何东西**：启动只能由 `app.start()` 调 `startLifecycle()`，
//      停止只能由 `app.stop()` 调 `stopLifecycle()`。套件在假计时器下 import 一次来钉它。
//
// 能力（connect/close、两个巡检、价格表、jmcomic 队列、视频转写、图像生成）**全部由 `deps` 递进来**，本文件里
// 对下层模块只有 `import type`（编译期擦除，`dist/web/lifecycle.js` 不 require 任何下层模块）。
// 这不只是为了好看：只有这样，"顺序"才是一个能在假 `deps` 上被**逐条观察**到的性质
// （§9.3 的 spy 断言），否则这些 entry 里有一半只能靠"把代码读一遍"来确认。真正把模块函数
// 递进来的地方是 `app.ts` 的 `lifecycleDeps()`——**"装的是什么"在 app，"按什么顺序装"在这里**。
//
// ⚠️ 顺序即语义，两条都是结构性质而非约定：
//   • `stopLifecycle()` **逆序**遍历，于是设计稿 §7.4 的"关停顺序 = 启动顺序的逆序"不再靠人记；
//   • `onebot.reconnect` 排在第一位，逆序之后 `onebot.close()` 就是最后一个被调的，于是
//     "停长期任务必须排在 `onebot.close()` 之前"（在途的 QQ 上传还依赖传输层）自动成立。
// **往表里插一行时，位置就是行为**——插错地方不会有任何编译错误，只有 `t-lifecycle.mjs`
// 第 3 段那几条顺序断言会红。
import type { AppConfig } from '../../core/config.js';
import type { AgentControlPort } from '../../agent/runtime/control-port.js';
import type { OneBotClient } from '../../qq/onebot.js';
import type { SendQueue } from '../../qq/sender.js';
import type { ChatStore } from '../../chat/store.js';
import type { JmcomicCompletionSink } from '../../media/jmcomic/index.js';

/** jmcomic 队列需要的运行时（与 `media/jmcomic.ts` 的 `JmRuntime` 结构一致）。 */
export interface LifecycleJmRuntime {
  onebot: OneBotClient;
  sender: SendQueue;
  store: ChatStore;
  onCompleted: JmcomicCompletionSink;
}

/**
 * 清单要的全部能力。**每一项都必须能在假对象上替换**——套件就是靠这个数组之外的一层
 * 把每个 entry 的调用顺序逐条记下来的（否则价格表与 jmcomic 是直接 import 的单例，
 * 顺序只能靠读代码）。所以这里只放**最少必要**的方法，不放整个类。
 */
export interface LifecycleDeps {
  /** 每个 entry 各自现读一次（与 S11c 之前逐处 `getConfig()` 的语义一致）。 */
  getConfig(): AppConfig;
  /**
   * 整个实例（不是只抽 `connect`/`close`）：jmcomic 的 worker 上传阶段要拿它去
   * `runtime.onebot.call(...)`，抽窄了这里就得凭空描述一遍 `call` 的签名。
   */
  onebot: OneBotClient;
  orchestrator: Pick<
    AgentControlPort,
    'startProactiveLoop' | 'stopProactiveLoop' | 'startCompactLoop' | 'stopCompactLoop'
  >;
  sender: SendQueue;
  store: ChatStore;
  priceFeed: { init(url: string): void; stop(): void };
  jmcomic: { init(runtime: LifecycleJmRuntime): void; stop(): void; onCompleted: JmcomicCompletionSink };
  transcription: { start(): void | Promise<void>; stop(): void | Promise<void> };
  imageGen: { start(): void | Promise<void>; stop(): void | Promise<void> };
  hotSearch: { start(): void | Promise<void>; stop(): void | Promise<void> };
  /**
   * 搜图常驻 worker 的启停。抽成 `start`/`stop` 而不是直接递那两个模块函数，是为了与其余
   * 能力同形（本文件对下层模块只有 `import type`，一行运行期 import 都没有）。
   *
   * `initPicImageSearch` 内部自己吞掉预热失败 —— 没装 PicImageSearch 是"搜图不可用"，
   * 不该让 `startLifecycle` 抛出去把整个 `app.start()` 掀翻。
   */
  imageSource: { start(): void | Promise<void>; stop(): void | Promise<void> };
}

export interface LifecycleEntry {
  /**
   * 这条 entry 覆盖的长期任务 id（`tasks.ts` 里的 `LongTermTask.id`）。
   * **只作对账元数据**，运行期不读它。一个 entry 可以覆盖多个 id（jmcomic 的清理与 worker
   * 是同一次 `initialize` 的两个面，拆成两条会把同一个入口调两遍）。
   */
  ids: readonly string[];
  /** 启动闸门。恒真的写 `ALWAYS`。 */
  enabled(config: AppConfig): boolean;
  start(deps: LifecycleDeps): void | Promise<void>;
  /**
   * 停止。返回值允许是 Promise（**与设计稿 §8.2 的 `stop(deps): void` 略有出入，这是有意的**）：
   * `stopLifecycle` 会 `await` 它，免得将来哪个 stop 变成异步时被静默地漏掉 await——那种错
   * 编译得过、跑起来"看起来停了"。
   */
  stop(deps: LifecycleDeps): void | Promise<void>;
}

/**
 * 无条件启动的闸门。**这不是在撒谎说"它没有开关"**：`price.feed` 的开关是
 * `api.priceRemoteUrl` 非空，`initPriceFeed('')` 恰好等价于 `stopPriceFeed()`（模块内已实现），
 * 所以判定留在入口内部才是对的；两个 jmcomic 任务本来就没有配置依赖（有下载任务就干活）。
 */
const ALWAYS = () => true;

/**
 * 装配清单，**按 S11c 之前 `app.start()` 里的真实启动顺序**排列：
 * connect → 热搜 → 冒泡 → 压缩 → 价格表 → jmcomic → 视频转写 → 搜图 worker → 图像生成。
 * 前五个是 S11c 收口的原顺序；转写、搜图 worker 与图像生成是后加的三个，都排在最后，
 * 于是停止时它们**最先**被收掉，不会拖着 OneBot 传输层一起等。
 *
 * 停止时逆序：图像生成 → 搜图 worker → 视频转写 → jmcomic → 价格表 → 压缩 → 冒泡 → 热搜 → `onebot.close()`。
 * 与 S11c 之前相比唯一调换的一对是"价格表 ↔ jmcomic"（原先 `stopPriceFeed()` 在前）：
 * 两者互不依赖，属**可观察但良性**的变化，已记入设计稿 §8.2 与真机冒烟清单。
 */
export const LIFECYCLE: readonly LifecycleEntry[] = [
  {
    // 宿主就是 `OneBotClient` 自己（S10c）：`close()` 会撤掉已排定待触发的那一次重连。
    ids: ['onebot.reconnect'],
    enabled: ALWAYS,
    start: (deps) => deps.onebot.connect(),
    stop: (deps) => deps.onebot.close()
  },
  {
    // 管理器始终装配；是否真的建立 cron 由入口现读 enabled、每日表达式与合法目标群决定。
    // 它排在 onebot 之后，因此逆序停止时会先销毁计划/等在途播报收尾，再关闭 QQ 传输层。
    ids: ['hot-search.daily-broadcast'],
    enabled: ALWAYS,
    start: (deps) => deps.hotSearch.start(),
    stop: (deps) => deps.hotSearch.stop()
  },
  {
    ids: ['proactive.bubble'],
    // S11c 之前这里是 `if (getConfig().proactive?.enabled)`（真值判断）。收成 `=== true` 是
    // 有意的收紧：配置类型是 boolean，真值判断只会让 `"false"` 这种畸形值把巡检**启动**起来。
    enabled: (config) => config.proactive?.enabled === true,
    start: (deps) => deps.orchestrator.startProactiveLoop(),
    stop: (deps) => deps.orchestrator.stopProactiveLoop()
  },
  {
    ids: ['compact.sweep'],
    // 原代码这里是 `if (…) startCompactLoop(); else stopCompactLoop();`，**else 分支被丢掉了**：
    // 它在"启动时压缩是关的"这条路径上只是把从未启动过的巡检再停一次（`stopCompactLoop`
    // 本来就幂等、timer 为 null），而 `stopLifecycle` 现在会在退出时无条件停一次。行为等价。
    enabled: (config) => config.compact?.enabled === true,
    start: (deps) => deps.orchestrator.startCompactLoop(),
    stop: (deps) => deps.orchestrator.stopCompactLoop()
  },
  {
    ids: ['price.feed'],
    // 无条件调（与 S11c 之前一致）：URL 为空时 `initPriceFeed` 内部就等价于 stop。
    enabled: ALWAYS,
    start: (deps) => deps.priceFeed.init(deps.getConfig().api?.priceRemoteUrl || ''),
    stop: (deps) => deps.priceFeed.stop()
  },
  {
    // **两个 id 合成一条**：清理定时器与 worker 由同一次 `initJmcomicQueue` 拉起，
    // 拆成两条会把同一个入口调两遍、把停止也调两遍。真的拆开也不会立刻翻车（`startCleanupTimer`
    // 有 `if (cleanupTimer) return` 的护栏、`stopJmcomicQueue` 幂等），但那正是要避免的形态：
    // 让"这条 entry 代表一次真实的装配动作"这件事退化成运气。
    ids: ['jmcomic.cleanup', 'jmcomic.worker'],
    enabled: ALWAYS,
    start: (deps) => deps.jmcomic.init({
      onebot: deps.onebot,
      sender: deps.sender,
      store: deps.store,
      onCompleted: deps.jmcomic.onCompleted
    }),
    stop: (deps) => deps.jmcomic.stop()
  },
  {
    ids: ['transcription.worker'],
    enabled: ALWAYS,
    start: (deps) => deps.transcription.start(),
    stop: (deps) => deps.transcription.stop()
  },
  {
    // 排在最后 ⇒ 逆序停止时**第一个**被收掉：先在退出流程的最前面关掉 Python 子进程，
    // 不让它挂在后面跟 OneBot 传输层一起等。它与 onebot 之间没有任何依赖（搜图只走
    // 自己的 stdin/stdout），所以这个位置是自由的，选它只是为了让"新增任务排最后"这条
    // 从转写开始的先例保持一致。
    ids: ['image-source.pic-worker'],
    // 与 proactive / compact 同形：配置闸门在清单里判，默认 false —— 不用搜图的部署
    // 完全不付这次 Python 冷启动。注意 `stopLifecycle` **不按 enabled 过滤**，所以
    // "启动时关着、退出时被停一次"是正常的：`closePicImageSearchClient()` 在单例不存在时
    // 直接返回 resolved promise，零副作用。
    enabled: (config) => config.imageSource?.enabled === true,
    start: (deps) => deps.imageSource.start(),
    stop: (deps) => deps.imageSource.stop()
  },
  {
    // 图像生成队列排在最后 —— 与转写/搜图同样的理由：它与 OneBot 之间没有直接依赖
    // （上传走 `SendQueue.sendImage`，由清单里靠前的 `onebot.reconnect` 保证传输层最后才关），
    // 所以位置是自由的，选末尾只是为了把"新增任务排最后"这条先例保持一致。
    //
    // 与 image-source 那条**不同**：这里不加 `enabled` 闸门。队列空载时不持有任何东西
    // （没有子进程、没有常驻计时器），而把闸门提到这里会让"配置关着"报成
    // "画图服务尚未启动" —— 见 `tasks.ts` 里 image-gen.worker 的说明。
    ids: ['image-gen.worker'],
    enabled: ALWAYS,
    start: (deps) => deps.imageGen.start(),
    stop: (deps) => deps.imageGen.stop()
  }
];

/** 顺序装上所有该启动的长期任务。逐条 `await`，所以表里排前面的先起来。 */
export async function startLifecycle(deps: LifecycleDeps): Promise<void> {
  for (const entry of LIFECYCLE) {
    if (!entry.enabled(deps.getConfig())) continue;
    await entry.start(deps);
  }
}

/**
 * **逆序**拆掉清单里的每一个——**不按 `enabled` 过滤**。
 *
 * 两个决定都是有意的：逆序让"关停顺序 = 启动顺序的逆序"成为结构性质（见文件头）；
 * 不过滤是因为"启动时开着、停止时配置已被改关"的任务仍然活着，用当前配置去决定要不要停
 * 会把它漏在后台。代价是停得比启动多，靠各任务自身的幂等吸收（`proactive.stop` /
 * `stopCompactLoop` 只清句柄置 null，`stopPriceFeed` / `stopJmcomicQueue` 同形）。
 */
export async function stopLifecycle(deps: LifecycleDeps): Promise<void> {
  for (const entry of [...LIFECYCLE].reverse()) {
    await entry.stop(deps);
  }
}
