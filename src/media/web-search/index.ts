// 联网搜索的对外表面。三个消费方都从这里取东西：
// `agent/tools/web-tools.ts`（`webSearch` / `webFetch`）、`agent/runtime/agent-runner.ts`
// （`bookmarkList`，注入系统提示词的收藏夹名单）、`web/routes/providers.ts`
// （`customSearch` / `probeSiteSearch` / `normalizeSiteInput`）。
//
// 文件划分（对照 `image-source/` 那张图：清单 / 取值 / 分发 / 展示各占一处）：
//   · `types.ts`           跨 provider 的统一形状（`SearchResult` / `SearchResponse`）
//   · `query.ts`           查询词清洗
//   · `record-utils.ts`    外部 JSON 的防御性读取
//   · `shared.ts`          跨 provider 共用的读取（maxResults / 自定义配置解析）
//   · `text-utils.ts`      实体解码 / 剥标签 / 站点家族 / 去重键
//   · `bookmarks.ts`       收藏夹名单、枚举值校验、命中标记与排序（**清单**）
//   · `site-search.ts`     抓收藏夹那个站自己的搜索页并解析（**取值**）
//   · `providers/`         七个 provider，一个文件一个来源
//   · `web-search.ts`      `webSearch()` 编排 + `searchOnce()` 分发 + `webFetch()`
//   · `site-probe.ts`      设置页「自动检测」按钮的后端
//
// ⚠️ 这里是**唯一**该长新导出的地方：新增 provider 要同时改 `providers/` 与
// `web-search.ts` 的分发表，**不必**在这里加导出（外面只认 `webSearch()` 一个入口）。
// `webFetch` 有意留在这里而不是单独一个文件：它只是 `safeFetch` 的一层薄转发，
// 拆出去只会让"抓正文"多一个没有内容的模块。
//
// 注意 `providers/` 是一整个目录，**不逐个 `export *`**：外面按名字挑，
// 而 `bingSearchWithUrl` 之类是 `custom` 的内部细节，不必成为对外契约。
export * from './types.js';
export * from './query.js';
export * from './bookmarks.js';
export * from './site-search.js';
export * from './site-probe.js';
export * from './web-search.js';

export { bingSearch } from './providers/bing.js';
export { yandexSearch } from './providers/yandex.js';
export { deepSeekSearch } from './providers/deepseek.js';
export { zhipuSearch } from './providers/zhipu.js';
export { bochaSearch } from './providers/bocha.js';
export { baiduSearch } from './providers/baidu.js';
export { metasoSearch } from './providers/metaso.js';
export { customSearch } from './providers/custom.js';
