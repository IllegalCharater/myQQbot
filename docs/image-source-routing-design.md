# 搜图路由设计：类型专属引擎 + 一般向兜底

> 最后核对：2026-09-29。
> 落点：`src/media/image-source/reverse-image-source-service.ts`（Node 侧策略：跑哪些引擎、什么顺序、门槛多少、预算怎么分）、`python-tools/pic_image_search_worker.py`（引擎知识：类名、家族、字段归一化）与 `src/core/prompt-catalog.ts`（模型怎么选类型）。
> 相关：`AGENTS.md`「图片链路」；`docs/ts-migration-plan.md` §2。

## 0. 一句话

一张图先问**它那个类型的专属引擎**，答不上或超时（或答案不过门槛）再问**一般向引擎**兜底，兜底也失败就结束——**链上最多两发，没有第三发**。SauceNAO 的 R18 掩码（`hide`）按类型一行，今天两行都是 `0`（不藏）。

## 1. 一张图问谁：类型 → 引擎

```ts
const ORDER: Record<SearchIntent, readonly EngineWhich[]> = {
  anime:        ['trace', 'baidu'],   // 专属 trace.moe → 一般向兜底
  manga:        ['sauce', 'baidu'],   // 专属 SauceNAO → 一般向兜底
  illustration: ['sauce', 'baidu'],   // 专属 SauceNAO → 一般向兜底
  unknown:      ['baidu']             // 没有专属引擎，只有一般向这一发
};
```

| intent | 专属引擎 | 一般向兜底 | 为什么 |
| --- | --- | --- | --- |
| `anime` | trace.moe | 百度识图 | trace.moe 给**集数与时间点**，是 `kind: 'anime'` 与 formatter 动画分支存在的全部理由 |
| `manga` | SauceNAO | 百度识图 | 漫画书页/同人志——SauceNAO 的库里就有漫画与同人本索引 |
| `illustration` | SauceNAO | 百度识图 | 插画/画师/来源站——SauceNAO 覆盖面最广的一类 |
| `unknown` | —（没有） | 百度识图 | 判不出类型时，窄域引擎白烧一次调用、甚至给假命中并**拦住**后面的广域引擎 |

**四条判据是写出来的，不是"算出来"的**：

- **`anime` 保留 trace.moe**：把它换掉等于让 formatter 的动画分支变成死代码（那条分支打印"第几集、第几分几秒"）。
- **`manga` 与 `illustration` 共用 SauceNAO**：两者都是"二次元来源/画师/作品"这一类问题。
- **`unknown` 没有专属引擎**：它恰恰是模型判不出类型时填的那个值，所以"不知道是什么"不该等于"这是动画截图"。
- **一般向恒在末位**：它是兜底，不是主力。

**顺序即语义**：命中即 `break`——顺序同时决定"谁先答"与"谁拦住谁"（拦住的代价是真的：`break` 之后后面那个引擎不会被问）。

**接进来的是百度识图（`baidu`）**。5 个候选（`baidu` / `bing` / `google_lens` / `yandex` / `tineye`）里选它的三条理由：① 唯一**不需要 API Key** 的（worker 只对 saucenao 读 `apiKey`）；② 面向中文互联网，而本 bot 的内容就是中文群的梗图/截图/表情包；③ 它的类名 `BaiDu`（大写 D）是 5 个里唯一**被真机实测确认过**的。`google_lens` 在服务端所在网络不可达，`bing` 要 Azure Key，`yandex` / `tineye` 作为备选（接第二个 = `ENGINE_ROWS` 加一行 + 在 `ORDER` 里定位置 + 一段配置，**不动循环**）。

## 2. 掩码（SauceNAO 的 `hide`）：按类型一行，今天全是 0

```ts
const INTENT_PARAMS: Record<SearchIntent, Partial<Record<EngineWhich, Record<string, unknown>>>> = {
  anime:        {},                        // 不问 SauceNAO → 无参数
  manga:        { sauce: { hide: 0 } },    // 找漫画：不藏（R18 同人志是合法答案）
  illustration: { sauce: { hide: 0 } },    // 找插画：也不藏
  unknown:      {}                         // 不问 SauceNAO → 无参数
};
```

`hide` 的四档语义（实测自 PicImageSearch 3.12.11 的 `SauceNAO.__init__`，结论见 worker 头部 ⚑ f 条）：

| 值 | 含义 |
| --- | --- |
| `0` | 全部（**今天所有档位都是这个**） |
| `1` | 隐藏预期 R18 |
| `2` | 隐藏预期存疑 |
| `3` | 只留预期安全 |

**为什么今天全是 `0`——这是实测撞出来的，不是"照默认值不动"**：

- `unknown` 曾是 `1` → 真机反馈是"图源接口响应太慢 / 没结果"。排查结论：它把原本匹配上的同人志图（Madokami 那次）**藏掉了**，于是这一路不再短路、必须去问 trace.moe，而 trace.moe 只索引动画帧、答不了漫画。**已改回 `0`**；本轮 `unknown` 不再问 SauceNAO，这一行随之消失。
- `illustration` 曾是 `1`（上一轮的建议）→ 本轮同样定为 `0`。判据：`hide` 是**服务端按它自己的判定**过滤的，我们无法复核"它凭什么认为这张是预期 R18"；一次误判的代价是**整条结果消失**，而收益（少几条 R18）在"只在群里报来源"的场景里并不明确。
- `manga` 从建立起就是 `0`。

**这张表今天没有任何"档位差异"。它保留的不是两个值，而是唯一那个"按类型收紧过滤"的落点。** 三条理由：① 它的穷尽性（`Record<SearchIntent, …>`）会在第五个 intent 出现时**逼出一次决定**，而不是让它悄悄变成"没有掩码"；② `hide` 是**显式传**的，不依赖库的构造默认值（默认值是库的实现细节，变了我们不会知道）；③ 值写在能被 review 的地方。**将来要收紧**（例如"只有 `illustration` 藏 R18"）：把那一行从 `0` 改成 `1`，**只改这一处**。

**它刻意不是设置页上的一个档位**：模型每次调用都已经给出了"这是什么图"，而一张图该不该看到 R18 结果正取决于它——一个全局档位只能同时错杀一边。

**掩码递下去的路**：`hide` 是 SauceNAO 的**构造**参数，不是 `search()` 的 kwargs → 经 `engineOptions` 进 worker 的 `_saucenao_constructor_args()`。那里**必须白名单**：`__init__` 的 `**request_kwargs` 让 `_filtered_call` 变成全传，拼错的键不报错、会被直接塞给 HTTP 客户端。`dbmask` / `dbmaski` / `db` / `dbs` **有意不接**（编号表不在库里，凭印象填的表现是"悄悄隐藏了另外几套库"）。

## 3. 「失败或超时 → 兜底」按什么判

每一发引擎调用之后：

| 情况 | 继续问下一发？ | 记进 `failures`？ |
| --- | --- | --- |
| 引擎抛错（`RATE_LIMIT` / `QUOTA_EXHAUSTED` / `HTTP_ERROR` / `INVALID_RESPONSE` / `PROVIDER_UNAVAILABLE`） | 是 | 是：`<which>:<码>` |
| 引擎自己的 `timeoutMs` 到期 | 是 | 是：`<which>:TIMEOUT` |
| 返回 0 条结果 | 是 | **否** |
| 有结果但都低于该引擎的 `minSimilarity` | 是 | **否** |
| 引擎未启用 / SauceNAO 没配 key（`ready === false`） | 跳过（这一发等于不存在） | **否** |
| 剩余预算不够开这一发 | 跳过 | 是：`<which>:NO_BUDGET` |

后三行里**前两行不记 `failures` 是既有语义，别改**：工具靠 `failures.length` 区分"接口全挂了"与"图确实没匹配上"（前者不能说成后者，否则排查方向会指向图片本身）。而**"没预算"必须记**——它不是"没匹配上"，是**我们没给引擎时间**，说成"没找到"就是撒谎。

**两个推论**（都从同一张表落出来，不用额外代码）：

- SauceNAO 没配 key 时，`manga` / `illustration` 的链自动缩成 `['baidu']`——一般向顶上当主力。
- trace.moe 关掉时，`anime` 的链自动缩成 `['baidu']`。

## 4. 预算：让"兜底"真的有机会

`totalTimeoutMs`（默认 35000）是**整轮**的死线，**包含图片下载**。历史上那次真机 `TOTAL_TIMEOUT` 的算术是：`ORDER.unknown = ['sauce','trace']` → 20000 + 15000 = **35000 = 预算本身，零余量**。

若不做任何事，"专属引擎超时 → 用兜底"在**最需要它的那一刻恰恰不会发生**：专属引擎把预算吃光，兜底根本没机会开火。所以每一发的时间必须**从同一个死线倒推**：

```
deadline = 本轮开始 + cfg.totalTimeoutMs
每一发引擎调用前：
  remaining = deadline - now
  rest      = 这一发之后还没试过、且「能跑」的引擎数
  available = remaining - FALLBACK_RESERVE_MS × rest - DEADLINE_EDGE_MS
  available < MIN_ENGINE_MS  ⇒ 跳过并记 `<which>:NO_BUDGET`
  budget    = min(该引擎配置的 timeoutMs, available)
```

注意判据落在 `available`（**我们能匀出多少**）上，而不是落在最终预算 `budget` 上：配置侧的钳制是
1000–60000，用户把小超时配成 1 秒是**合法的决定**，我们不去替他收回；拿最终预算去比，就会把
"用户把超时配小了"报成 `NO_BUDGET` —— 一句关于我们自己的陈述，说着用户的配置。

四个常量（**写明的常量，不是新配置项**；改它们等于改行为，所以放在一处并写明理由）：

| 常量 | 值 | 理由 |
| --- | --- | --- |
| `FALLBACK_RESERVE_MS` | 8000 | 留给每一发后续引擎的**下限**。网页类搜图典型 3–8s，低于它兜底形同虚设 |
| `MIN_ENGINE_MS` | 3000 | 我们能匀给这一发的**下限**。低于它不该开这一枪。判据比的是"匀得出的时间"而不是引擎配置的超时（见上面那段），否则"用户把超时配小"会被报成 `NO_BUDGET`。宁可诚实记 `NO_BUDGET`（"我们没给它时间"），也不要记 `TIMEOUT`（"它太慢"）——这两种原因指向完全不同的排查方向 |
| `DEADLINE_EDGE_MS` | 500 | 让**引擎自己的超时**先于**整轮死线**触发，失败才可归因到具体引擎；否则两者同时到期，报出来的是 `TOTAL_TIMEOUT`，看不出是谁慢 |
| `DOWNLOAD_MAX_MS` | 15000 | 图片下载最多占多少预算（它没有专门的配置项）。再多就说明链路有问题，应当报 `IMAGE_TIMEOUT` 让人去查链路，而不是让引擎饿死 |

**默认配置下的实际分配**（`totalTimeoutMs = 35000`）：

| intent | 链 | 下载 2s（典型） | 下载 15s（最坏） |
| --- | --- | --- | --- |
| `manga` / `illustration` | sauce 20000 → baidu 15000 | sauce 满额；若它超时，baidu 仍得 **12.5s** | sauce 得 3.5s；baidu 仍得 **8s** |
| `anime` | trace 15000 → baidu 15000 | trace 满额；超时后 baidu 满额 | trace 3.5s；baidu 8s |
| `unknown` | baidu 15000 | 满额 | 8s |

**不变式**：每一发都从同一个死线倒推，所以**整轮永远不会超过 `totalTimeoutMs`**（下载也被夹住、且已接 `AbortSignal`，见 §6）。外层那条 `Promise.race` 于是退化成**兜底中的兜底**（防的是 provider 不守时这类 bug），正常路径不会再触发它。

## 5. 一般向引擎不报置信度 → 接受策略要换一套

这是接通用引擎**真正的代价**，不是加个引擎名那么简单。worker 里早有一条对应的注释（`_normalize_web` 的文档，写于"引擎知识全在 Python"那一轮）：这些引擎**普遍不给相似度**，Node 侧的 `similarity >= minSimilarity` 会把它们全部滤掉，并写着"真要启用这些引擎，需要的是另一套判定策略（另行设计）"。

三处合起来把"没有置信度"变成"返回空"，全都要改：

| 位置 | 今天 | 改成 |
| --- | --- | --- |
| `pic-image-search-client.ts` | `similarity: num('similarity') ?? 0` | **取到才写**（与 `title` / `time` 同一套"字段不在就不写"的规矩；兜 `0` 就是替引擎编了一个"0% 相似"） |
| `reverse-image-source-service.ts` | `find((x) => x.similarity >= spec.minSimilarity)` | `gate === undefined \|\| (x.similarity !== undefined && x.similarity >= gate)` |
| `result-formatter.ts` | 无条件印 `相似度：x%` | 字段在才印（判据是"字段在不在"，不是"值是否非零"——与 `time` 那个 `00:00` 是同一条规矩） |

门槛因此是**引擎级**的：没有这个概念的引擎（网页类）在配置里**根本没有 `minSimilarity` 这一栏**——"该引擎没有置信度这个概念"由**字段的缺席**表达，它给出什么顺序，第一条就是它的答案。有门槛的引擎仍然要求"结果自带置信度且过线"：**无置信度的结果对它们照样被丢弃**（宁可空手，也不认一条无法核实的命中）。

**结果形状**：`ImageSourceResult.similarity` 变可选；`kind` 不变（`baidu` 在 `ENGINE_DISPLAY` 里是 `'illustration'`，走 formatter 的"可能来源/画师/来源/链接"分支——manga 的结果也走它，"可能来源"对漫画同样成立），**不为 manga 长第四个 `ImageSourceKind`**。

## 6. 图片下载的预算与信号

`loadSafeImage` 今天不带 `AbortSignal`（只有 `safeFetchBinary` 的 5s DNS + 20s socket 超时），于是**下载慢与引擎慢在结果里长得一模一样**：都是 `TOTAL_TIMEOUT`，而文案写的是"图源接口响应太慢"——**归因是错的**。本轮：

- `loadSafeImage(url, maxBytes, signal?)` → `safeFetchBinary(url, n, signal?)`（可选参数，其它调用方不受影响）。
- 下载在它自己的 `DOWNLOAD_MAX_MS` 切片内跑；超时**由服务层抛 `IMAGE_TIMEOUT`**（服务层拥有预算，loader 保持"只负责下载"）。
- 工具侧 `FAILURE_TEXT` 加一行 `IMAGE_TIMEOUT: '图片下载超时（不是图源接口的问题），稍后再试。'`——与既有的 `IMAGE_TOO_LARGE` / `IMAGE_EMPTY` / `IMAGE_FORMAT` 同一族。

## 7. 模型可见的部分

- `prompt-catalog.ts` 的 `reverse_image_source.intent` 加 `manga`，并把**漫画从 `illustration` 挪出来**：`manga` = 日式漫画书页 / 同人志 / 漫画截图（整页分格、对白框、黑白网点）；`illustration` = 插画、画师作品、Pixiv/Twitter 同人图、游戏立绘；`unknown` = 其余一切，拿不准就填它。
- **刻意不写"选 manga 才会用 SauceNAO"**：那是传输层的事，说出来会诱导模型为挑引擎而选类型（与掩码那一轮同一判据）。
- `failures` 串会经工具**原样进模型可见文本** → `NO_BUDGET` 这类新码必须一眼能读懂，别取需要解释的名字。

## 8. 已知空白（如实记录）

- **百度识图的输出质量与可达性没有任何套件能验**：假 provider 只看得到"参数传对了、无置信度的结果被接受了"。
- **`_normalize_web` 的字段名是推出来的，不是实测的**（⚑ 那几条只覆盖 saucenao / trace.moe）：`baidu` 真返回什么字段（`title` / `url` / `thumbnail`）要等真机。若对不上，表现是"有结果但标题为空"。
- **`baidu` 从未被真机调用过**：类名 `BaiDu` 修好了，但那只是"名字对得上"。唯一的机检入口是设置页「测试连接」（走 worker 的 `probe`，**只回答"库里有这个类吗"，不烧远端配额**）。
- **设置页的新字段没有机检守护**：`tests/t-panel-wiring.mjs` 整段不覆盖 image-source（既有空白，本次未变）。
