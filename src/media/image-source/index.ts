/**
 * 搜图模块的对外表面。三个消费方都从这里取东西：
 * `agent/tools/image-source.ts`（服务 + 格式化）、`web/app.ts`（`initPicImageSearch` /
 * `closePicImageSearchClient`，装配给长期任务）、`web/routes/config.ts`（`PicImageSearchProvider`
 * 的 `test()`）。
 *
 * ⚠️ 这里是**唯一**该长新导出的地方：引擎名取值域在 `types.js`（`PicImageSearchEngine`）、
 * 客户端与端口在 `pic-image-search-client.js`、可注入的薄 provider 在
 * `pic-image-search-provider.js`。`image-loader.js` **有意不在**这里 —— 它是内部实现
 * （只被服务层用），不构成对外契约。
 */
export * from './types.js';
export * from './cache.js';
export * from './queue.js';
export * from './pic-image-search-client.js';
export * from './pic-image-search-provider.js';
export * from './reverse-image-source-service.js';
export * from './result-formatter.js';
