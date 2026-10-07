// 联网搜索的共享类型。
//
// ⚠️ `SearchResponse` 是**跨 provider 的统一形状**：七个 provider（Bing / Yandex / DeepSeek /
// 智谱 / 博查 / 百度 / 秘塔）加上自定义与收藏夹两条路，最终都得收敛到它，否则
// `webSearch()` 上层的合并、去重与排序就得按 provider 分叉。
//
// 收藏夹的类型（`BookmarkSite` / `BookmarkRequest` / `BookmarkHeader`）**不在这里**：
// 它们与「请求结构」那条链共用，定义在 `media/bookmark-request.ts`，两边各写一份必然漂移。

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  /**
   * 这条结果来自网页收藏夹里的站点（由 `bookmarks.ts` 的 `annotateBookmarks` 标记）。
   *
   * 为什么要把"为什么它排在前面"告诉模型，而不是悄悄重排：收藏夹是我们替他做的排序，
   * 模型看不到排序依据时，会把"排第一"读成"最权威"，从而照着一条其实只是"用户常去"
   * 的站点回答。带上这个字段，它才能在需要时自己权衡。
   * 由**字段的缺席**表示"不是收藏夹结果"，与 ImageSourceResult.similarity 同一条规矩
   * （不写 false：那会让每条普通结果都多一个无信息量的键）。
   */
  fromBookmark?: true;
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
}

/**
 * `webSearch.provider` 的取值域。
 *
 * 只写**分发真正认的**那些：`searchOnce()` 把它们映射到各自的 provider 函数，
 * 认不出的值一律落到 Bing（默认）。`custom:<id>` 是多实例形态，所以这里是
 * `custom` 加一个前缀匹配的字符串，不是一个有限联合。
 */
export type SearchProvider =
  | 'bing' | 'yandex' | 'deepseek' | 'zhipu' | 'bocha' | 'baidu' | 'metaso' | 'custom';

/** 收藏夹优先模式（只影响"模型没说搜哪个站点"时的默认行为）。 */
export type BookmarkMode = 'prefer' | 'web';
