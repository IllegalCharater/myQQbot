// 配置管理：data/config.json，UI 可写。所有字段都有默认值。
import fs from 'node:fs';
import { PERSONAS } from './prompt-catalog.js';
import { sliderToTier, tierToSlider } from './tier-slider.js';   // 零依赖模块，避免循环依赖
// 路径常量集中在 paths.ts（向上找 package.json，对目录深度免疫）。
// 这里只是**转出**给老调用点用——仓库里另有 10 个模块从 config.js 取 DATA_DIR/ROOT，
// 一次性改它们会把 S3 和 S4 混成一件事；等 S4/S5 再让它们直接找 paths。
//
// ⚠️ 转出必须"先 import 再 export"，不能写 `export { ROOT } from './paths.js'`：
// 后者只转出、不给本文件引入绑定，下面用 DATA_DIR/CONFIG_FILE 时会 `is not defined`
// ——2026-09-24 的 `detectMime is not defined` 就是这么炸的。
import { ROOT, DATA_DIR, CONFIG_FILE } from './paths.js';
export { ROOT, DATA_DIR, CONFIG_FILE };

export const DEFAULT_CONFIG = {
  // OpenAI 兼容 API（必填才能跑）
  api: {
    // 出厂留空：这是作者本机的网关地址，对其他人毫无意义，
    // 留空能让「就绪度体检」正确提示"还没填 Base URL"。
    baseUrl: '',                             // 例如 https://api.deepseek.com/v1 或自建网关
    apiKey: '',
    model: '',                              // UI 里选择/填写
    provider: '',                           // 当前模型所属提供商（多提供商目录的选中项）
    vision: true,                           // 模型是否支持图片输入（关掉则移除看图工具）
    temperature: 0.8,
    maxRounds: 12,                          // 单次运行的最多工具轮数
    timeoutMs: 180000,
    // 成本核算（仅本地估算展示，不参与任何请求）
    priceInputPerM: 0,      // 输入单价（元 / 百万 token）—— 兜底默认值
    priceOutputPerM: 0,     // 输出单价
    priceCachedPerM: 0,     // 输入且命中缓存的单价；留 0 时按 priceInputPerM 计
    useOfficialPrice: true, // true = 优先用内置官方价格表（按模型 id 匹配）
    // 远程价格表 URL（可选）：指向一个自托管的 JSON（格式见 scripts/export-prices.mjs 产物）。
    // 启动时拉取一次，之后每 24 小时自动刷新（失败过 3 小时重试）；
    // 拉取全程异步、失败不清表 —— 对正常使用零影响。
    // 远程条目按模型 id 覆盖内置表，内置表其余条目仍是兜底。
    priceRemoteUrl: '',
    // 按模型单独设定的价格：{ [模型 id]: { in, out, cached } }
    // 优先级最高 —— 一旦这里有记录，就不再用内置官方表，也不受全局默认单价影响。
    // 改动只存在这里，不会回写内置价格表（src/llm/model-prices.ts）。
    modelPrices: {}
  },
  // 多提供商模型目录（设置页手动维护）
  providers: [],
  dshProviderKeys: {},   // providerId -> 真实 API Key（providers[] 里不再存明文 Key）
  providersSourceYaml: '',
  providersImported: true,
  // 联网搜索（默认 Bing 网页解析，无需 key；可选 DeepSeek/智谱/博查/百度/秘塔）
  webSearch: {
    enabled: true,
    searchUrl: 'https://cn.bing.com/search',
    maxResults: 6,
    // 可选：'bing' | 'deepseek' | 'zhipu' | 'bocha' | 'baidu' | 'metaso'
    provider: 'bing',
    deepseek: {
      apiKey: '',                     // 留空时回退环境变量 DEEPSEEK_API_KEY
      baseUrl: 'https://api.deepseek.com/responses',
      model: 'deepseek-v4-flash',     // Responses API 模型名：deepseek-v4-flash / deepseek-v4-pro
      timeoutMs: 60000
    },
    zhipu: {
      apiKey: '',                     // 留空时回退环境变量 ZHIPU_API_KEY
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4/web_search',
      engine: 'search_std',           // search_std(¥0.01) | search_pro(¥0.03) | search_pro_sogou | search_pro_quark
      count: 10,
      timeoutMs: 20000
    },
    bocha: {
      apiKey: '',                     // 留空时回退环境变量 BOCHA_API_KEY
      baseUrl: 'https://api.bochaai.com/v1/web-search',
      count: 10,
      timeoutMs: 20000
    },
    baidu: {
      apiKey: '',                     // 留空时回退环境变量 BAIDU_SEARCH_API_KEY
      baseUrl: 'https://qianfan.baidubce.com/v2/ai_search/web_search',
      count: 6,
      timeoutMs: 20000
    },
    metaso: {
      apiKey: '',                     // 留空时回退环境变量 METASO_API_KEY（无 key 也尝试官方免费额度）
      baseUrl: 'https://metaso.cn/api/open/v1/search',
      count: 6,
      timeoutMs: 20000
    },
    // 自定义搜索提供商列表（设置页可像添加模型提供商一样自行添加，可多个）。
    // 每项：{ id, name, type, baseUrl, apiKey, model, count, timeoutMs }
    // type: 'openai' = POST JSON 搜索接口；'bing' = GET 页面并按 b_algo 解析
    // 在「搜索提供方」下拉框里以 custom:<id> 的形式出现
    providers: [],
    // 自定义搜索服务（旧的单槽位，保留以兼容；新添加的建议用上面的 providers 数组）
    custom: {
      name: '',                       // 展示名，如"我的 SearXNG"
      type: 'openai',                 // 'openai' = OpenAI 风格的 JSON 搜索 API；'bing' = 抓 HTML 解析 b_algo
      baseUrl: '',                    // openai: 搜索端点；bing: 搜索页地址
      apiKey: '',                     // openai 类型需要（可选，视服务而定）
      model: '',                      // openai 类型可选： Responses API 风格的模型名
      count: 6,
      timeoutMs: 20000
    },
    // ── Yandex 网页解析 ──
    // **这是抓公开 HTML 页，不是官方付费 API**（后者是 searchapi.api.cloud.yandex.net/v2/web/search，
    // 响应为 base64 包着的 XML，需要 folderId 且没有结构化 JSON 出口）。
    // 抓取天生易碎：Yandex 类名混淆且会变（SearXNG 的 yandex 引擎 2021 年因此被删除），
    // 所以**选择器是配置项**，改版时用户能自己在设置页救回来，不必等发版。
    // 默认值取自可考证的两代标记的交集，未在真机验证过；对不上时工具会报出容器类名。
    yandex: {
      baseUrl: 'https://yandex.com/search/',
      serpClass: 'serp-item',
      urlClass: 'organic__url',
      titleClass: 'OrganicTitle',
      textClass: 'OrganicText'
    },
    // ── 网页收藏夹（枚举值 + 网页 URL + 用途）──
    // 每条三项，三项都必须非空：
    //   · `key`   枚举值，**模型在 web_search 的 site 参数里传的就是它**。限 ASCII 标识符
    //             （字母/数字/`-`/`_`），与代码里的枚举同形；中文会被丢弃并打日志。
    //   · `url`   网页地址。只取它的**域名**参与检索（`site:` 只认站点，不认页面），
    //             所以填整条网址是允许的，只是路径会被丢掉。
    //   · `purpose` 用途。**注入 system prompt 给模型当"该选哪一条"的依据** —— 这是枚举值
    //             能被真正用起来的关键：只给模型一个 `wiki` 而不说它是什么，等于没给。
    // 三项都限长：这条文本每轮都要进 system prompt，不设上限时 20 条能吃掉大块预算。
    //
    // 另有两个**可选**字段，用来把"限定站点"真正做成"站内搜索"：
    //   · `searchUrl` 站内搜索地址模板，用 `{q}` 占位（如
    //     `https://zh.wikipedia.org/w/index.php?search={q}`）。
    //     **为什么必须有它**：实测 `cn.bing.com` 与 `www.bing.com` 对程序化请求**完全忽略
    //     `site:` 限定符**（带与不带的结果逐字节相同，换个必然收录的站点也一样），
    //     所以只靠拼 `site:` 等于没限定。填了模板就直接去那个站自己的搜索页取内容，
    //     绕开搜索引擎。留空则退回 `site:` 行为（对自建 SearXNG 等仍有效）。
    //   · `resultClass` 站内搜索页里"每条结果容器"的类名，用于解析。
    //     留空时用**通用启发式**（见 media/web-search/site-search.ts 的 parseSiteSearch）——
    //     抓取解析天生易碎，这个字段是页面改版时的自救通路（同 yandex 那四个选择器）。
    bookmarks: [],
    // 收藏夹的**默认行为**，只影响"模型没说搜哪个站点"时走哪条路：
    //   'prefer' —— 按关键字先问收藏夹、再补全网（收藏夹命中排最前）；
    //   'web'    —— 直接全网，**只有模型显式传 site 时才进收藏夹**。
    // 模型显式指定站点时这个开关不起作用（那是模型的判断，不该被一个全局档位覆盖）。
    // 旧键 `bookmarkFirst` 会被 normalizeConfigShape 迁移成这里的 'web' 并删除。
    bookmarkMode: 'prefer',
    // 调用阀门（与 imageSource / transcription 同形，实现见 media/call-budget.ts）。
    //
    // ⚠️ 与那两个能力不同，web_search 在默认的 Bing 页面解析下**不直接产生费用**，
    // 所以这两项的作用不是"护住第三方配额"，而是**压住刷屏**：搜索是日常高频动作，
    // 阈值定得比搜图/转写宽松。换成按次计费的 provider（智谱/博查/百度）时请自行调小。
    maxCallsPerChatPerHour: 20,
    maxCallsPerDay: 200,
    // ── 抓取正文的长度预算（可配置）──
    //
    // 为什么要可配：这两个数直接决定"模型能读到多少资料"，而**合适的值取决于用户怎么用**。
    // 群聊闲聊不需要长正文（越小越省上下文、越省钱）；拿它当资料检索就要长正文
    // （实测萌娘百科 `prop=extracts` 一篇正文就有 7036 字符）。写死一个数只能对一半人正确。
    //
    // `fetchTextMaxChars`：`web_fetch` 单次交给模型的**正文**上限（剥掉 HTML 之后的字符数）。
    //   旧实现写死 20000。**上限是"整轮上下文预算"的一部分** ——
    //   `store.promptContextMaxChars` 默认 32000，所以别把它调得比那个还大。
    fetchTextMaxChars: 20000,
    // `flattenMaxChars`：收藏夹返回**单个对象**（整条资料）时压平后的总上限。
    //   旧实现写死 4000（更早是 2000，那对"整篇文章"型接口会把 7036 字的正文砍成 608 字，
    //   而模型拿到一份"看起来完整"的摘要、**不知道后面还有内容** —— 静默丢内容最难查）。
    flattenMaxChars: 4000
  },
  // 安全例外（默认全部关闭）
  security: {
    allowPrivateImageHosts: false           // true 时图片下载允许内网地址（仅本地测试/自建图床）
  },
  imageSource: {
    enabled: false,
    traceMoe: { enabled: true, timeoutMs: 15000, minSimilarity: 0.87, maxResults: 3 },
    sauceNao: { enabled: true, apiKey: '', timeoutMs: 20000, minSimilarity: 0.80, maxResults: 3 },
    // 一般向兜底引擎（百度识图）：专属引擎答不上/超时后才会被问到，见
    // docs/image-source-routing-design.md。
    // **它没有 minSimilarity 这一栏**，这是有意的：该引擎不返回置信度，"没有门槛这个概念"由
    // 字段的缺席表达。别为了跟上面两行对齐补一个 0 —— 那个 0 会被读成"门槛为零"。
    baidu: { enabled: true, timeoutMs: 15000, maxResults: 3 },
    maxImageBytes: 8 * 1024 * 1024,
    maxQueueLength: 5,
    totalTimeoutMs: 35000,
    cacheEnabled: true,
    cacheTtlMs: 24 * 60 * 60 * 1000,
    maxCallsPerChatPerHour: 5,              // 单群每小时调用上限（护住第三方配额）
    maxCallsPerDay: 30                      // 所有群合计每天上限
  },
  // SnowLuma / OneBot v11
  snowluma: {
    dir: '',                   // SnowLuma 程序目录；留空 = 自动探测项目内 ./snowluma
    autoLaunch: false,         // 应用启动时自动拉起 SnowLuma（未运行时）
    wsUrl: 'ws://127.0.0.1:3001',
    httpUrl: 'http://127.0.0.1:3000',
    accessToken: '',           // WebSocket 令牌
    httpAccessToken: ''        // HTTP API 令牌（SnowLuma 可与 WS 不同；留空沿用 accessToken）
  },
  // 人设与行为
  persona: {
    botName: '小鲸鱼',
    selfNickname: '',                       // 在群里的展示名（留空用 QQ 昵称）
    roleText: PERSONAS.xiaojingyu.text,     // 默认人设：原版"小鲸鱼"角色卡（适配版）
    participation: 'medium',                // low | medium | high —— 参与度参考
    customRules: ''                         // 追加自定义规则（可选）
  },
  // 用户自定义人设库（保存在配置里，可在设置页添加/选择）
  customPersonas: [],
  // 接入白名单
  allow: { groups: [], private: [] },
  deny: { groups: [], private: [] },
  allowAllWhenEmpty: false,
  // 每日全网热搜播报。API Key 可留空：运行时先读这里，再回退 HOT_SEARCH_API_KEY；
  // 两者都没有时按极数本源文档走匿名额度。目标群在执行时还会与 allow.groups 再取交集。
  hotSearchEnabled: false,
  hotSearchApiKey: '',
  hotSearchCron: '0 9 * * *',
  hotSearchTimezone: 'Asia/Shanghai',
  hotSearchTargetGroupIds: [],
  hotSearchItemLimit: 10,
  hotSearchPlatformFilter: [],
  hotSearchIncludeLinks: false,
  // 状态文件 data/hot-search-state.json 是任务状态的完整事实源；这里仅镜像最近成功日期，
  // 兼容配置备份/迁移，并让重启后的“当天只成功播报一次”有第二道持久化保险。
  hotSearchLastSuccessDate: '',
  // 运行节奏
  wakeDelayMs: 2000,        // 空闲时收到消息到发起运行的防抖窗口（等连发聚成一批）
  drainDelayMs: 1200,       // 一次运行结束后发现还有未读，到下一次运行的间隔
  maxConcurrentRuns: 2,     // 全局同时进行的 agent 运行数
  // 回复态节奏（静默态 ↔ 回复态）。
  //
  // 静默→回复的转换点是 scheduleWake 建立"等待中"会话的那一刻；回复→静默是
  // 运行结束（含失败重试跑完）的 finally。这一组只影响"回复态期间"的行为。
  reply: {
    // 等待窗口的**硬上限**：从本批第一条消息算起，等够这么久就不再等新消息、直接回复。
    // 与 wakeDelayMs（立即回复时间）配合：wakeDelayMs 是尾沿防抖（每条新消息重置），
    // maxWaitMs 是不被重置的天花板，防止连发不停导致永远不触发。0 = 不限制（= 原行为）。
    maxWaitMs: 0,
    // 命中分钟限频时最多等多久（毫秒）再发。0 = 直接报错（= 原行为）。
    // 之所以默认等待而非报错：抛错会让那条消息被丢弃，模型还会按提示重发、再失败，
    // 群里表现为"机器人坏了"。真人撞到打字速度上限时也是停一下再发。
    maxLimitWaitMs: 20000
  },
  // 聊天记录定时压缩：把老消息交给模型摘要成一段纪要写回存档，原文移到冷归档。
  compact: {
    enabled: false,             // 默认关：会调 LLM 花钱
    checkIntervalMs: 3600000,   // 巡检间隔（毫秒）
    minIntervalMs: 86400000,    // 同一会话两次压缩之间的冷却
    minMessagesToCompact: 800,  // 存档条数超过它才考虑压缩
    keepRecentMessages: 300,    // 最近 N 条原样保留、不参与压缩
    maxMessagesPerRound: 400,   // 单轮最多摘要多少条
    maxContextChars: 24000,     // 喂给模型的原始文本上限（先按它裁剪，再决定压缩范围）
    maxChatsPerSweep: 1,        // 一次巡检最多处理几个会话（控成本）
    compactMemory: true         // 顺带触发一次记忆整理（走它自己的冷却）
  },
  // 历史摘要注入：压缩产物的**消费端**。与 compact 分开是有意的 —— compact 管
  // "怎么生成摘要"，这里管"摘要怎么进提示词"。定时压缩关着、只用面板「立即压缩」
  // 压过的用户，同样要这里的设置生效。
  digest: {
    injectEveryRound: false,  // true = 不管这轮读不读历史都带上摘要；false = 只在读历史的那轮带
    merge: true,              // true = 多条摘要拼成一段；false = 每条各成一小节
    // 注入字数上限。**0 = 不注入**。
    // ⚠️ 这里故意偏离本文件「0 = 不限制」的惯例（见 maxMessagesPerChat/maxContextMessages）：
    //    摘要永不归档、只会越攒越多，"不限"等于无上限的 token 成本，没人想要；
    //    而 0 落在"静默不注入"这个安全方向，写错了也只是不说话，不会失控。
    maxChars: 8000,
    // 摘要**存档**的字数上限。**0 = 不限**（默认，与改动前完全一致）。
    // 与上面的 maxChars 是两件事：那个管"带多少进提示词"，这个管"存档里留多少"。
    // 摘要永不归档、也绝不被二次摘要（见 store.selectArchiveRange 的注释），
    // 所以每压一轮就多一条，长期跑下去存档本身会无界增长 —— 提示词的预算拦不住它。
    // 超上限时在**每次压缩成功后**整条丢掉最旧的（永远保留最新的一条，理由见
    // store.dropOldestDigests）。这是全局限定，不参与按群覆盖：它管的是磁盘占用。
    maxKeepChars: 0,
    unified: true,            // true = 全部会话用上面几个值；false = 白名单群可按群覆盖
    perChat: {}               // { [群号]: { injectEveryRound, merge, maxChars } }，仅 unified=false 时生效
  },
  // 发送保护
  send: {
    minGapMs: 1000,         // 相邻两条消息最小间隔
    maxGapMs: 3000,         // 最大间隔
    byLengthMs: 20,         // 按字数附加的间隔（毫秒/字）
    maxPerMinute: 80,
    maxPerHour: 500,
    hardSplitAt: 4000       // QQ 硬限制切分（0 = 不限制）
  },
  // 视频 URL 转写。密钥可留空并由服务端环境变量注入；控制台配置响应会按 secret 字段脱敏，
  // 设置页不提供这些凭证的输入框，避免把腾讯云长期密钥带到浏览器。
  transcription: {
    enabled: false,
    appId: '',
    secretId: '',
    secretKey: '',
    engineType: '16k_zh',
    ffmpegPath: 'ffmpeg',
    ffmpegTimeoutMs: 15 * 60 * 1000,
    flashTimeoutMs: 5 * 60 * 1000,
    maxDurationSeconds: 2 * 60 * 60, // 录音文件识别极速版官方硬上限
    maxAudioBytes: 100 * 1024 * 1024,
    maxSourceBytes: 256 * 1024 * 1024,
    resultMaxChars: 3500,
    // 模型自主调用时的成本闸门（`/转写` 命令不受它约束）。转写按次计费且单次成本远高于一次搜图，
    // 所以默认值比 imageSource 的 5/30 更紧。语义与 imageSource 同名两项一致，见 media/call-budget.ts。
    maxCallsPerChatPerHour: 3,
    maxCallsPerDay: 10
  },
  // ── Python 工具（`python-tools/`）共用的解释器 ──
  // **两个工具只有一个入口**：漫画下载（jmcomic_download.py）与搜图 worker
  // （pic_image_search_worker.py）都从 `python.path` 读解释器。原先是钉在漫画那一段里的
  // `jmcomic.pythonPath`，已经搬到这里并迁移（见 normalizeConfigShape）。
  // 留空时按 core/python-runtime.ts 的解析链回落：QQ_AGENT_PYTHON → Windows 固定环境 →
  // conda my_bot（旧的 JMCOMIC_PYTHON 别名已废弃删除）。依赖装法见 python-tools/requirements.txt。
  python: {
    path: ''
  },
  // 主动开话题（可选）
  proactive: {
    enabled: false,
    checkIntervalMinMs: 1800000,
    checkIntervalMaxMs: 5400000,
    idleThresholdMs: 1800000,   // 群里静默多久才算"冷场"
    probability: 0.25
  },
  // 表情包
  sticker: {
    enabled: true,
    promptMaxStickers: 10,
    collectEnabled: true,
    maxCollectPerHour: 10,
    // 发表情包的积极程度（0=不鼓励 1=偶尔 2=较积极 3=很积极）。
    // 这是在提示词层面引导模型"更愿意用表情回应"，不是强制每次都发 ——
    // 强制会显得机械，引导才能让它在合适的时候自然用上。
    encourage: 1,
    // bot 自己收藏的表情最多留几个。**0 = 不限**（默认，与改动前完全一致）。
    //   - 只数 source !== 'qq' 的条目。QQ 收藏是"源"，本地删了下次同步就并回来，
    //     所以它们既不算进这个数、也不该被它删掉（详见 stickers.selectEvictions）。
    //   - 超上限时在**新收藏一条之后**整理：按"使用频率最低、保存时间最早"整条删掉，
    //     连同它的本地缓存图片（sticker-cache.ts）一起。把数字调小不会立刻删东西。
    //   - 全局限定，不参与按群覆盖（表情配置本来就没有按群覆盖，见 digest.maxKeepChars 的同款说明）。
    maxKeepCount: 0
  },
  // 存储
  store: {
    // 单群 JSON 最大保留条数。**0 = 不限制**。
    // 用户明确要求取消上限（原为 2000）。配套措施：
    //   - 前端存档页已分页（首屏 500 条、滚动追加 200 条），不会因数据多而卡
    //   - store 的 #trim 在 maxPerChat<=0 时直接跳过
    // 注意：单群文件会随时间增长，磁盘占用请自行留意。
    maxMessagesPerChat: 0,
    // ── 动态上下文窗口的容量 ──
    // 每个会话常驻一个"一直保持最新"的窗口：只装**对方发来的**最新 N 条消息，
    // 消息一到就入窗、超出立刻丢最老（见 src/agent/context/context-window.ts）。
    // 它决定一次运行最多把多少条未读放进【本次唤醒】；被挤出窗口的那些不会丢，
    // 它们降级成【过去状态】候选（实际条数仍受档位深度/字符预算限制），也照样参与
    // “要不要回应”的判定。
    // 用途：长时间离线/被 @ 唤醒时，一次运行可能带上几百条积压，token 会失控。
    // **0 = 不限制**（= 原行为）。注意它与上面 maxMessagesPerChat 的区别：
    // 那个管"存档留多少条"（磁盘），这个管"一次运行读多少条"（token）。
    // 改动即时生效，无需重启；调小不会"追溯性地"丢掉积压（没消费过的仍算待处理）。
    maxContextMessages: 0,
    // 单次 user prompt 的统一字符预算；优先保留本轮新消息和决策指令，超出时依次
    // 收缩表情目录、历史摘要、长期记忆、已读历史。0 = 不限制。
    promptContextMaxChars: 32000,
    // ── 当前消息响应策略 ──
    // 唯一持久化事实源；响应档位和随机概率只在运行时派生。
    contextSliderPos: 95,
    keywords: [],               // 档2 的关键词表
    // ── 历史读取策略（与响应原因完全独立）──
    historyCount: 80,
    // ── 响应档位的作用范围 ──
    unifiedTier: true,          // true = 上方滑条对所有会话生效；false = 可按群单独设置
    groupSliderPos: {},         // { [群号]: 0~100 } 仅 unifiedTier=false 时生效；未设置的群/私聊跟随全局滑条
    keepSessionFiles: 0         // 保留最近多少个会话记录文件；**0 = 不限制**（原为 300）
  },
  // 屏蔽名单：{ [群号]: [QQ号, ...] }
  // 被屏蔽群员的消息在入口处直接丢弃——不存档、不触发会话、不作为提示词背景。
  // 机器人自己的消息不受影响。仅群聊有意义（私聊要屏蔽请直接用白名单/黑名单）。
  blocklist: {},
  // 记忆自动整理：条数超阈值且距上次超过冷却时间时，在运行结束后后台合并/去重/删过时
  memory: {
    consolidateEnabled: true,
    consolidateMinIntervalMs: 21600000,  // 默认 6 小时
    useChatModel: true,                   // true = 整理模型跟随聊天模型；false = 使用下方专用模型
    provider: '',                         // 专用模型所属提供商 id（useChatModel=false 时生效）
    model: ''                             // 专用模型 id（useChatModel=false 时生效）
  },
  // 桌面端/控制台
  server: {
    port: 3210,
    token: '',                // 留空 = 只监听 127.0.0.1
    autoStart: false,         // 开机自启（仅 Electron 桌面端生效）
    closeToTray: true         // 点关闭 = 最小化到托盘
  },
  ui: {
    // 主题：'dark' | 'light' | 'system'（system = 跟随系统偏好）。
    // 前端以 localStorage 为准做到即时生效，这里只是跨设备/重装后保留用。
    theme: 'dark',
    showVision: true,         // 模型目录显示图片输入能力徽标
    refreshMs: 15000          // 界面轮询间隔
  }
};

export type AppConfig = Omit<typeof DEFAULT_CONFIG,
  'providers' | 'dshProviderKeys' | 'store' | 'digest' | 'memory' |
  'hotSearchTargetGroupIds' | 'hotSearchPlatformFilter'> & {
  memberNotes?: Record<string, string>;
  modelVision?: Record<string, { providerId?: string; model?: string; verdict?: string; note?: string; httpStatus?: number | null; latencyMs?: number | null; source?: string; checkedAt?: number }>;
  dshProviderKeys: Record<string, string>;
  providers: Array<{ id: string; displayName?: string; baseURL?: string; apiKey?: string; models: string[]; [key: string]: unknown }>;
  hotSearchTargetGroupIds: string[];
  hotSearchPlatformFilter: string[];
  store: typeof DEFAULT_CONFIG.store & { groupSliderPos: Record<string, number> };
  digest: typeof DEFAULT_CONFIG.digest & {
    perChat: Record<string, Partial<Pick<typeof DEFAULT_CONFIG.digest, 'injectEveryRound' | 'merge' | 'maxChars'>>>;
  };
  memory: typeof DEFAULT_CONFIG.memory & {
    consolidateMinImpressions?: number;
    maxImpressionsPerMember?: number;
    discoverMinMessages?: number;
    discoverMaxMembers?: number;
  };
};
type ConfigPatch = Record<string, unknown>;

function deepMerge<T>(base: T, override: unknown): T {
  if (override === null || override === undefined) return structuredClone(base);
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return structuredClone(override) as T;
  const out = (Array.isArray(base) ? [...base] : { ...base }) as Record<string, unknown>;
  const baseRecord = base as Record<string, unknown>;
  for (const [key, value] of Object.entries(override)) {
    // 整体替换约定：{ __replace__: X } → 该键直接用 X，不做递归合并。
    // 用于映射型字段（如 api.modelPrices）需要"删掉旧键"的场景 ——
    // 普通深合并传 {} 是删不掉已有键的。
    if (value && typeof value === 'object' && !Array.isArray(value) && '__replace__' in value) {
      out[key] = structuredClone((value as Record<string, unknown>).__replace__);
      continue;
    }
    if (value && typeof value === 'object' && !Array.isArray(value) && baseRecord[key] && typeof baseRecord[key] === 'object' && !Array.isArray(baseRecord[key])) {
      out[key] = deepMerge(baseRecord[key], value);
    } else if (value !== undefined) {
      out[key] = structuredClone(value);
    }
  }
  return out as T;
}

export function loadConfig(): AppConfig {
  try {
    let text = fs.readFileSync(CONFIG_FILE, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const parsed = normalizeConfigShape(JSON.parse(text));
    return deepMerge(DEFAULT_CONFIG, parsed) as AppConfig;
  } catch {
    return structuredClone(DEFAULT_CONFIG) as AppConfig;
  }
}

/**
 * 网页收藏夹的站点上限。
 *
 * 为什么是一个写死的常量而不是配置项：它保护的是**查询串长度**，不是用户偏好——
 * 每家搜索引擎对 URL 长度都有一条不公开的线，而超长不报错、只是结果变差。20 个站点
 * 拼出的 `site:` 子句约 300 字符，仍在安全区内；再多就该先用别的手段筛选了。
 * 与 image-source 那四个"写明的常量而不是配置项"同一条理由（改它等于改行为）。
 */
const MAX_BOOKMARK_SITES = 20;

/**
 * 枚举值（`bookmarks[].key`）的长度与字符上限。
 *
 * **限 ASCII 标识符**（字母/数字/`-`/`_`）是与代码里的枚举同形的选择：模型要把它原样
 * 放进 tool 参数，`wiki-zh` 这种形状最不容易在传输里被改写（空格、冒号、引号都可能在
 * JSON 参数里制造歧义）。中文枚举值被有意排除 —— 需要中文说明时那是**用途**字段的事。
 */
const MAX_BOOKMARK_KEY = 32;
const BOOKMARK_KEY_RE = /^[A-Za-z0-9_-]+$/;

/** 用途字段的长度上限。它每轮都进 system prompt，20 条不设限能吃掉大块预算。 */
const MAX_BOOKMARK_PURPOSE = 60;

/** 站内搜索地址模板的长度上限（防把整页 HTML 粘进输入框）。 */
const MAX_BOOKMARK_SEARCH_URL = 500;

/** 结果容器类名的长度上限（同上；类名本身通常只有十几字符）。 */
const MAX_BOOKMARK_CLASS = 80;

/**
 * 「请求结构」相关上限。逐条都防同一件事：**用户把整篇接口文档粘进输入框**。
 * 这些值会进 `config.json`，也会在每次检索时参与拼装。
 */
const MAX_BOOKMARK_ENDPOINT = 2000;
const MAX_BOOKMARK_HEADERS = 20;
const MAX_BOOKMARK_HEADER_NAME = 100;
const MAX_BOOKMARK_HEADER_VALUE = 1000;
/** 静态参数值（`{top_k}` / `{API Key}` 这类）的上限。 */
const MAX_BOOKMARK_PARAM_VALUE = 500;

/** 枚举值是否合法（形状见 BOOKMARK_KEY_RE 的注释）。 */
function isBookmarkKey(value: unknown): boolean {
  const key = String(value ?? '').trim();
  return key.length > 0 && key.length <= MAX_BOOKMARK_KEY && BOOKMARK_KEY_RE.test(key);
}

/**
 * 把任意串压成合法枚举值（小写、非字母数字换成 `-`、折叠重复、去首尾）。
 *
 * 只给**旧配置迁移**用（宿主名 → 枚举值）。新配的条目走 `isBookmarkKey` 校验，
 * 不做"帮你改好"——用户敲的值与模型看到的值必须逐字一致。
 */
function slugifyKey(input: string): string {
  return String(input ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_BOOKMARK_KEY);
}

/** 普通对象（非 null、非数组）——读配置条目时的守卫。 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 把用户填的一条收藏夹条目归一成宿主名；认不出返回空串（由调用方丢弃）。
 *
 * 设计决定：**只接受宿主名或完整 URL，不接受带路径的任意串，也不接受裸词**。
 * 三条理由：
 *   · 裸词（`example`）没有点、也不是合法 IPv4，只会让查询串变成一条无效的 site: 条件；
 *   · 带路径的 URL 拼进 `site:` 没有意义（site: 只认站点），留着会让用户以为自己
 *     "收藏了某个页面"，而检索范围其实是整个站——这是**承诺与行为不符**；
 *   · 但用户复制粘贴出来的通常就是整条 URL（`https://a.com/x/y`），所以必须能收下它，
 *     只是把路径丢掉，并**在设置页的提示里说明这件事**（见 sections.js 的收藏夹说明）。
 */
function hostnameOf(input: unknown): string {
  const raw = String(input ?? '').trim();
  if (!raw) return '';
  // 先按"完整 URL"试。没写 scheme 的 `example.com/path` 会在这里抛错，下面再补一次。
  for (const candidate of [raw, `https://${raw}`]) {
    try {
      const url = new URL(candidate);
      // 只认 http/https：ftp:、file: 之类既搜不到也不该出现在这个名单里。
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
      const host = url.hostname.toLowerCase().replace(/\.$/, '');
      // 必须带点（域名）或是 IP 字面量；`localhost`、单标签主机名一律丢弃。
      if (!host.includes('.') && !/^\d+\.\d+\.\d+\.\d+$/.test(host)) continue;
      if (!/^[a-z0-9.\-:[\]]+$/.test(host)) continue;
      return host;
    } catch {
      // 换下一种写法再试
    }
  }
  return '';
}

/**
 * 把旧配置迁移到当前形状。历史深度曾按响应原因拆成四项；现在迁移为独立的
 * historyCount。迁移时采用旧配置当前响应档位所对应的那一项，尽量保持原成本。
 */
function normalizeConfigShape<T>(input: T): T {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const root = input as Record<string, unknown>;
  const imageSource = root.imageSource;
  if (imageSource && typeof imageSource === 'object' && !Array.isArray(imageSource)) {
    const c = imageSource as Record<string, unknown>;
    const clamp = (value: unknown, min: number, max: number, fallback: number) => {
      const n = Number(value); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
    };
    c.enabled = c.enabled === true;
    c.maxImageBytes = Math.round(clamp(c.maxImageBytes, 1024, 20 * 1024 * 1024, 8 * 1024 * 1024));
    c.maxQueueLength = Math.round(clamp(c.maxQueueLength, 0, 20, 5));
    c.totalTimeoutMs = Math.round(clamp(c.totalTimeoutMs, 1000, 120000, 35000));
    c.cacheEnabled = c.cacheEnabled !== false;
    c.cacheTtlMs = Math.round(clamp(c.cacheTtlMs, 60000, 7 * 24 * 60 * 60 * 1000, 24 * 60 * 60 * 1000));
    c.maxCallsPerChatPerHour = Math.round(clamp(c.maxCallsPerChatPerHour, 1, 60, 5));
    c.maxCallsPerDay = Math.round(clamp(c.maxCallsPerDay, 1, 1000, 30));
    // 第三列是 `maxResults`，第二列是 `minSimilarity` —— **`null` 表示这个引擎没有这个概念**
    // （网页类引擎不返回置信度，见 DEFAULT_CONFIG.imageSource.baidu 那段）。这时是 `delete`
    // 而不是写一个 0：`updateConfig` 走 `deepMerge`，**只加键不删键**，所以任何被写进去的
    // minSimilarity 都会永远留在用户的 config.json 里，成为一个从不被读、却看起来像配置的旋钮
    // （仓库里 jmcomic.pythonPath 那次的教训，见 AGENTS.md）。
    for (const [name, limitMs, minSim, maxResults] of [
      ['traceMoe', 15000, 0.87, 3], ['sauceNao', 20000, 0.80, 3], ['baidu', 15000, null, 3]
    ] as const) {
      const raw = c[name]; if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const p = raw as Record<string, unknown>;
      p.enabled = p.enabled !== false;
      p.timeoutMs = Math.round(clamp(p.timeoutMs, 1000, 60000, limitMs));
      if (minSim === null) delete p.minSimilarity;
      else p.minSimilarity = clamp(p.minSimilarity, 0, 1, minSim);
      p.maxResults = Math.round(clamp(p.maxResults, 1, 10, maxResults));
      if (name === 'sauceNao') p.apiKey = String(p.apiKey ?? '').trim();
    }
  }
  // ── 网页收藏夹 + 搜索调用阀门 ──
  //
  // **收藏夹为什么必须在配置层清洗，而不是在搜索时顺手兜住**：枚举值会被模型原样回传
  // （服务端据它选站点），域名会被拼进发给搜索引擎的查询串（`site:a.com OR site:b.com`），
  // 脏值不会报错、只会让整条查询静默作废。所以在这里一次性收口成
  // 「合法枚举值 + 合法宿主名 + 非空用途 + 去重 + 限量」，运行期只做查表与拼接。
  const webSearch = root.webSearch;
  if (webSearch && typeof webSearch === 'object' && !Array.isArray(webSearch)) {
    const w = webSearch as Record<string, unknown>;
    const clamp = (value: unknown, min: number, max: number, fallback: number) => {
      const n = Number(value); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
    };
    // ── 旧键迁移：bookmarkFirst → bookmarkMode ──
    //
    // 语义变了：从前 `bookmarkFirst: true` 的含义是"每次搜索都自动优先收藏夹"，现在收藏夹
    // 改由**模型显式传 site** 决定，"自动优先"只是「模型没点名」时的默认行为。所以旧键
    // 不能原样留用——`true` 与 `false` 现在分别对应 `prefer`（保持旧观感）与 `web`。
    //
    // 先把它读出来再删：这个 `delete` 是**必须的**（`updateConfig` 走 `deepMerge`，只加键
    // 不删键，不显式删就会让旧键永远留在用户的 config.json 里当一个没人读的旋钮，同
    // `jmcomic.pythonPath` 那次的教训）。
    const legacyBookmarkFirst = w.bookmarkFirst;
    delete w.bookmarkFirst;
    if (w.bookmarkMode === undefined && legacyBookmarkFirst !== undefined) {
      w.bookmarkMode = legacyBookmarkFirst === false ? 'web' : 'prefer';
    }
    // 归一成两档之一：写别的值（含拼错的）一律回落到默认的 'prefer'，避免运行期拿到
    // 一个既不是 prefer 也不是 web 的字符串后**两条路都不走**。
    if (w.bookmarkMode !== 'web') w.bookmarkMode = 'prefer';

    // ── 网页收藏夹：归一成 [{ key, url, purpose }] ──
    //
    // 旧形状是**纯宿主名数组**（`['a.com','b.com']`），与新形状不能共存，所以凡见到
    // 数组元素是字符串就整份走迁移：宿主名 slug 化当枚举值（`news.ycombinator.com` →
    // `news-ycombinator-com`），**用途留空**（下面会打一条日志提示用户去补）。
    // 迁移而不是丢弃是刻意的：那份名单是用户一条条敲进去的，静默清空等于毁他的数据
    // （同 `jmcomic.pythonPath` 那次的判据）。
    const rawBookmarks = Array.isArray(w.bookmarks) ? w.bookmarks : [];
    const legacyShape = rawBookmarks.some((item) => typeof item === 'string');
    const usedKeys = new Set<string>();
    const uniqueKey = (base: string): string => {
      const slug = slugifyKey(base) || 'site';
      let candidate = slug;
      let n = 2;
      while (usedKeys.has(candidate)) candidate = `${slug}-${n++}`.slice(0, MAX_BOOKMARK_KEY);
      usedKeys.add(candidate);
      return candidate;
    };
    type NormalizedRequest = { method: string; endpoint: string; headers?: Array<{ name: string; value: string }> };
    const bookmarks: Array<{ key: string; url: string; purpose: string; searchUrl?: string; resultClass?: string; request?: NormalizedRequest; params?: Record<string, string> }> = [];
    for (const item of rawBookmarks) {
      if (bookmarks.length >= MAX_BOOKMARK_SITES) break;
      // 旧形状：字符串 → 造一个枚举值，用途留空（用途空条目**仍然入库**，因为它是迁移来的，
      // 丢掉就等于删了用户的收藏；新配的条目则要求用途非空，见下）
      if (typeof item === 'string') {
        const host = hostnameOf(item);
        if (host) bookmarks.push({ key: uniqueKey(host), url: host, purpose: '' });
        continue;
      }
      if (!isPlainRecord(item)) continue;
      // **「网页地址」这一栏现在两用**（与「站内搜索地址」合并后的一栏）：
      //   · 只填域名 → 当站点标识，`url` 存域名（原「网页地址」的行为）；
      //   · 填了含 `{q}` 的完整地址 → 它是**站内搜索模板**，存进 `searchUrl`，
      //     而 `url` 退化成它归一出来的域名（检索要靠域名归因，也是提示词里给模型看的站点）。
      // 这样"合并成一栏"不需要用户做任何选择：填什么形态，程序自己认。
      const rawInput = String(item.url ?? item.site ?? '').trim();
      const asTemplate = /^https?:\/\//i.test(rawInput) && rawInput.includes('{q}') ? rawInput : '';
      let host = hostnameOf(rawInput);
      const rawKey = String(item.key ?? '').trim();
      const purpose = String(item.purpose ?? '').trim().slice(0, MAX_BOOKMARK_PURPOSE);
      if (usedKeys.has(rawKey)) continue;   // 重复枚举值：先到先得，否则模型传一个键会命中两条

      // 先把**请求结构**解析出来：`url` 可以**从它的地址推出来**（见下）。
      // 顺序很关键 —— 旧版先判 `!host` 就丢，于是"只配了请求结构、上面那一栏留空"的
      // 条目被整条丢掉（连请求结构一起没），刷新后设置页就空了（**实测反馈**）。
      // 「请求结构」里已经写着完整的接口地址，那个地址就是站点，没理由再要求用户抄一遍域名。
      const rawReq = isPlainRecord(item.request) ? item.request : null;
      let parsedRequest: { method: string; endpoint: string; headers?: Array<{ name: string; value: string }> } | undefined;
      let endpointHost = '';
      if (rawReq) {
        const method = String(rawReq.method ?? 'GET').trim().toUpperCase();
        const endpoint = String(rawReq.endpoint ?? rawReq.url ?? '').trim().slice(0, MAX_BOOKMARK_ENDPOINT);
        const headers: Array<{ name: string; value: string }> = [];
        if (Array.isArray(rawReq.headers)) {
          for (const h of rawReq.headers) {
            if (headers.length >= MAX_BOOKMARK_HEADERS) break;
            if (!isPlainRecord(h)) continue;
            const name = String(h.name ?? '').trim().slice(0, MAX_BOOKMARK_HEADER_NAME);
            if (!name) continue;
            headers.push({ name, value: String(h.value ?? '').trim().slice(0, MAX_BOOKMARK_HEADER_VALUE) });
          }
        }
        if (method !== 'GET' && method !== 'POST') {
          console.warn(`[config] 收藏夹「${rawKey}」的请求结构被忽略：方法只支持 GET/POST（收到 ${method || '空'}）。`);
        } else if (!endpoint || !endpoint.includes('{q}')) {
          console.warn(`[config] 收藏夹「${rawKey}」的请求结构被忽略：请求地址必须含 {q} 占位符（查询词要能填进去）。`);
        } else {
          parsedRequest = headers.length ? { method, endpoint, headers } : { method, endpoint };
          // 只写路径（靠 Host 头补全）时，域名在 Host 头里 —— 与 `resolveEndpoint()` 同一判据
          endpointHost = hostnameOf(/^https?:\/\//i.test(endpoint) ? endpoint : '')
            || String(headers.find((h) => h.name.toLowerCase() === 'host')?.value ?? '').trim();
        }
      }
      // `url` 的取值顺序：**用户填的那一栏** → **请求结构里的地址**。
      // 后一条是必须的：只配了请求结构而上面留空是完全合理的用法。
      if (!host) host = endpointHost;

      // 硬约束：站点标识可解析、枚举值是合法 ASCII 标识符。
      // **用途可以为空**（迁移来的老数据不能丢；新配的条目由前端提示补用途）。
      const hasUsableSource = !!asTemplate || !!parsedRequest;
      if ((!host || !isBookmarkKey(rawKey) || (!purpose && !hasUsableSource))) continue;
      usedKeys.add(rawKey);
      const entry: typeof bookmarks[number] = { key: rawKey, url: host, purpose };
      // `searchUrl` 模板：**只接受 http/https，且必须带 `{q}` 占位符**。
      // 两条都是硬要求，理由各不同：
      //   · 协议白名单 —— 这个地址会被直接请求，`file:`/`javascript:` 之类不该有机会；
      //   · 必须带 `{q}` —— 没有占位符就拼不出查询词，请求会打到搜索页首页并返回
      //     "什么都能搜"的页面，表现为"结果文不对题"而不是报错，比直接拒掉难查得多。
      const searchUrl = (asTemplate || String(item.searchUrl ?? '').trim()).slice(0, MAX_BOOKMARK_SEARCH_URL);
      if (searchUrl) {
        if (/^https?:\/\//i.test(searchUrl) && searchUrl.includes('{q}')) entry.searchUrl = searchUrl;
        else console.warn(`[config] 收藏夹「${rawKey}」的站内搜索地址被忽略：必须是 http(s) 且含 {q} 占位符。`);
      }
      const resultClass = String(item.resultClass ?? '').trim().slice(0, MAX_BOOKMARK_CLASS);
      if (resultClass) entry.resultClass = resultClass;
      // 请求结构已经解析好了，直接接上（校验在上面做完了 —— 它必须排在 `url` 判定之前，
      // 因为 `url` 可能是从它推出来的）
      if (parsedRequest) entry.request = parsedRequest;

      // ── 静态参数（可选）──
      // 给 `{q}` 之外的占位符用（如 `{top_k}`）。`q` 被显式排除：它是运行时查询词，
      // 不许被一个静态值顶掉 —— 否则"查什么"就变成配置里写死的了。
      if (isPlainRecord(item.params)) {
        const params: Record<string, string> = {};
        for (const [k, v] of Object.entries(item.params)) {
          const name = String(k).trim().slice(0, MAX_BOOKMARK_HEADER_NAME);
          if (!name || name === 'q') continue;
          params[name] = String(v ?? '').trim().slice(0, MAX_BOOKMARK_PARAM_VALUE);
        }
        if (Object.keys(params).length) entry.params = params;
      }
      bookmarks.push(entry);
    }
    w.bookmarks = bookmarks;
    if (legacyShape && bookmarks.length) {
      console.warn(`[config] 网页收藏夹已迁移为「枚举值 + 网页URL + 用途」共 ${bookmarks.length} 条；用途为空，请在设置页补上——模型要靠用途判断该选哪一条。`);
    }

    // ── 收藏夹凭据（密钥）──
    // **不再有 `credentials` 区**：接口密钥改用「静态参数」机制填 ——
    // 在请求头里写 `Authorization: Bearer {API Key}`，然后在静态参数里给 `API Key` 填值。
    // 一条机制覆盖"固定参数"与"密钥"，不必再有一套独立的凭据落盘/脱敏/回显规则。
    // 这里**必须显式删除**旧键：`updateConfig` 走 `deepMerge`（只加键不删键），
    // 不删的话旧的 `credentials` 会永远留在用户的 config.json 里，而且
    // "删掉的那套逻辑"留下的数据会让下一个人以为它还在生效。
    delete w.credentials;

    w.maxCallsPerChatPerHour = Math.round(clamp(w.maxCallsPerChatPerHour, 1, 200, 20));
    w.maxCallsPerDay = Math.round(clamp(w.maxCallsPerDay, 1, 5000, 200));
    // 抓取正文预算：下限 500（再小就没有可用信息了），上限 200000（防"把它当不限"，
    // 那个量级会一次吃掉整轮上下文并拖慢请求）。**不跟随 promptContextMaxChars**：
    // 它们是两个独立旋钮，绑在一起会让"我只想调搜索长度"变成"顺手改了提示词预算"。
    w.fetchTextMaxChars = Math.round(clamp(w.fetchTextMaxChars, 500, 200000, 20000));
    w.flattenMaxChars = Math.round(clamp(w.flattenMaxChars, 500, 200000, 4000));
    // Yandex 选择器：只做 trim + 长度上限，**不校验"是不是合法类名"**。
    // 类名规矩每个搜索引擎都不一样（Yandex 用 `OrganicTitle` 这种大驼峰），写一条
    // 自以为是的正则只会把用户手工救回来的值又打回去。长度上限防的是"整页 HTML
    // 被粘进输入框"，那种值会让 `findClassBlock` 的正则构造得很慢。
    if (w.yandex && typeof w.yandex === 'object' && !Array.isArray(w.yandex)) {
      const y = w.yandex as Record<string, unknown>;
      for (const key of ['baseUrl', 'serpClass', 'urlClass', 'titleClass', 'textClass']) {
        y[key] = String(y[key] ?? '').trim().slice(0, 200);
      }
    }
  }
  const store = root.store;
  if (store && typeof store === 'object' && !Array.isArray(store)) {
    const s = store as Record<string, unknown>;
    if (s.contextSliderPos === undefined && s.contextTier !== undefined) {
      s.contextSliderPos = tierToSlider(Number(s.contextTier), Number(s.randomPercent));
    }
    if (s.historyCount === undefined) {
      const { tier } = sliderToTier(Number(s.contextSliderPos ?? tierToSlider(Number(s.contextTier), Number(s.randomPercent))));
      const legacy = tier === 1 ? s.atCount : tier === 2 ? s.keywordCount : tier === 3 ? s.randomCount : s.allCount;
      const fallback = tier === 1 ? 20 : tier === 2 ? 15 : tier === 3 ? 8 : 80;
      s.historyCount = Math.max(0, Number(legacy) || fallback);
    }
    delete s.contextTier;
    delete s.randomPercent;
    delete s.atCount;
    delete s.keywordCount;
    delete s.randomCount;
    delete s.allCount;
  }
  const reply = root.reply;
  if (reply && typeof reply === 'object' && !Array.isArray(reply)) {
    const r = reply as Record<string, unknown>;
    const legacyLimit = Number(r.maxPerMinute);
    // 旧版若配置了更严格的回复态上限，迁移成统一上限时取两者较小值，避免升级后
    // 机器人突然发得更快。0 过去表示“沿用发送上限”，无需迁移。
    if (Number.isFinite(legacyLimit) && legacyLimit > 0) {
      const send = root.send && typeof root.send === 'object' && !Array.isArray(root.send)
        ? root.send as Record<string, unknown>
        : (root.send = {}) as Record<string, unknown>;
      const currentLimit = Number(send.maxPerMinute);
      send.maxPerMinute = Math.min(
        Number.isFinite(currentLimit) && currentLimit > 0 ? currentLimit : DEFAULT_CONFIG.send.maxPerMinute,
        legacyLimit
      );
    }
    delete r.maxPerMinute;
  }

  // ── Python 解释器：jmcomic.pythonPath → python.path（迁移，不是搬走） ──
  //
  // 旧字段钉在漫画那一段里，但两个 Python 工具用的是同一个解释器，所以它搬到了顶层。
  // **为什么是迁移而不是直接删**：README 一直教用户手改 config.json 写
  // `jmcomic.pythonPath`，直接删会让那些配置**静默失效**——解释器回落成默认探测链，
  // 用户看到的是"漫画下载突然要 conda 了"，而没有任何地方提示他重填。搬一次的成本是
  // 这几行，收益是那批人的配置照旧生效。同款先例见上面的 contextTier → contextSliderPos。
  //
  // 这里 `delete` 是**必须的**：updateConfig 走的是 `deepMerge(getConfig(), patch)`，
  // 它只会往对象里加键、不会删盘上已有的键，所以不显式删，旧键会一直在 config.json 里
  // 留着（`deepMerge` 把 override 的所有键都抄进去，包括它不认识的）。
  const python = root.python;
  if (python && typeof python === 'object' && !Array.isArray(python)) {
    (python as Record<string, unknown>).path = String((python as Record<string, unknown>).path ?? '').trim();
  }
  const legacyJmcomic = root.jmcomic;
  if (legacyJmcomic && typeof legacyJmcomic === 'object' && !Array.isArray(legacyJmcomic)) {
    const legacyPath = String((legacyJmcomic as Record<string, unknown>).pythonPath ?? '').trim();
    const currentPath = python && typeof python === 'object' && !Array.isArray(python)
      ? String((python as Record<string, unknown>).path ?? '').trim()
      : '';
    // 两边都有时以新字段为准（用户已经自己填过新位置，不要用旧的把它盖回去）。
    if (legacyPath && !currentPath) root.python = { path: legacyPath };
    delete root.jmcomic;
  }

  return input;
}

let currentConfig: AppConfig | null = null;

/** 取当前生效配置（未初始化时从磁盘读）。 */
export function getConfig(): AppConfig {
  if (!currentConfig) currentConfig = loadConfig();
  return currentConfig;
}

/** 更新并持久化配置（浅合并到当前值；patch 里传对象字段则整体替换该字段）。 */
export function updateConfig(patch: ConfigPatch) {
  currentConfig = normalizeConfigShape(deepMerge(getConfig(), patch));

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${CONFIG_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(currentConfig, null, 2), 'utf8');
  fs.renameSync(tmp, CONFIG_FILE);
  return currentConfig;
}

/** 内存态改动（不落盘）——用于运行期覆盖（如自测注入 mock）。 */
export function setRuntimeConfig(cfg: AppConfig) {
  currentConfig = cfg;
}

/**
 * 取某个会话实际生效的响应策略。只返回响应判定需要的最小字段，历史配置不会越界。
 * unifiedTier 开启 → 从全局滑条位置派生档位与概率；
 * 关闭 → 群聊查 groupSliderPos，有单独设置就换算出该群的 responseTier/randomPercent。
 * 关键词表仍沿用全局值；历史深度不属于本函数。私聊永远跟随全局响应档位。
 */
export function responseConfigForChat(chatKey: string) {
  const store = getConfig().store || {};
  let pos = store.contextSliderPos;
  if (store.unifiedTier !== false) {
    const { tier, randomPercent } = sliderToTier(pos);
    return { responseTier: tier, randomPercent, keywords: store.keywords };
  }
  const [kind, id] = String(chatKey || '').split(':');
  if (kind === 'group' && id) pos = store.groupSliderPos?.[id] ?? pos;
  const { tier, randomPercent } = sliderToTier(Number(pos));
  return { responseTier: tier, randomPercent, keywords: store.keywords };
}

/**
 * 取某个会话实际生效的历史摘要注入配置。
 * unified 开启 → 全局值；关闭 → 群聊查 perChat，有单独设置就覆盖，缺哪个字段就沿用全局。
 * 私聊永远跟随全局（和 responseConfigForChat 一致）。
 *
 * 返回的一定是**每个字段都有值**的对象（注入三项 + 存档回收上限）：调用方（提示词与面板）
 * 不该各自再兜一遍默认值，那样两边就会漂移。
 *
 * maxKeepChars 是唯一的例外：它**不参与按群覆盖**，永远是全局值（见下面 base 里的注释）。
 */
export function digestConfigForChat(chatKey: string) {
  const d = getConfig().digest || {};
  const num = (v: unknown, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(200000, Math.max(0, Math.round(n))) : fallback;
  };
  const base = {
    injectEveryRound: d.injectEveryRound === true,
    merge: d.merge !== false,
    maxChars: num(d.maxChars, 8000),
    // 存档回收上限：全局限定，不参与按群覆盖（它管的是磁盘占用，不是"这个群怎么说话"）
    maxKeepChars: num(d.maxKeepChars, 0)
  };
  if (d.unified !== false) return base;
  const [kind, id] = String(chatKey || '').split(':');
  if (kind !== 'group' || !id) return base;
  const o = d.perChat?.[id];
  if (!o || typeof o !== 'object') return base;
  // 覆盖项里**没写的字段沿用全局**（逐字段判断，而不是"有覆盖项就整份替换"）。
  // 面板每次都会写全三项，所以这里主要挡的是手改 config.json 写出半份覆盖的情况：
  // 那种情况下"缺的字段回到默认值"会让用户觉得"我就改了个字数上限，每轮注入怎么被关了"。
  return {
    injectEveryRound: o.injectEveryRound === undefined ? base.injectEveryRound : o.injectEveryRound === true,
    merge: o.merge === undefined ? base.merge : o.merge !== false,
    maxChars: num(o.maxChars, base.maxChars),
    maxKeepChars: base.maxKeepChars   // 不按群覆盖，见上面 base 里的注释
  };
}
