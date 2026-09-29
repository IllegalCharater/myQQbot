// Node 侧**唯一**的搜图 provider。
//
// 它刻意很薄 —— 这不是偷懒，是这条链路的职责划分（2026-09-29 定）：
//
//   • **引擎知识在 Python。** "某个引擎的类叫什么、构造要哪些参数、图片怎么喂给它、
//     返回的字段叫什么"全部在 `python-tools/pic_image_search_worker.py` 里
//     （`ENGINE_CLASS_CANDIDATES` / `_input_param` / `_normalize_*`）。Node 只说
//     "用哪个引擎搜这张图"，不重复描述任何一个引擎。
//   • **字段映射在客户端。** worker 返回的行 → `ImageSourceResult` 由
//     `pic-image-search-client.ts` 的 `toImageSourceResult()` 一处完成。
//   • **分发策略在调用方。** 跑哪些引擎、什么顺序、相似度门槛多少，是
//     `reverse-image-source-service.ts` 按配置决定的（那里也是唯一知道
//     `traceMoe` / `sauceNao` 两段配置的地方）。
//
// 于是这里只剩两件事：给服务层一个**可注入的接缝**（`deps.provider`），以及给设置页一个
// 吞异常的 `test()`。**不要往这个文件里长按引擎分支** —— 那正是上一版三个 provider 类
// 做的事，也正是这次要消掉的东西：同一个引擎的写法在多处各有一份，必然漂移。
//
// 历史教训（为什么按引擎分的类被删掉）：`saucenao-provider.ts` / `trace-moe-provider.ts`
// 各自用原生 `fetch` 直连远端并各带一张映射表，于是"接口怎么调、字段叫什么"在 Node 与
// Python 各有一份；而两者对同一个引擎给出的展示名还不一样（`'SauceNAO'` vs `'saucenao'`）。

import { getPicImageSearchClient } from './pic-image-search-client.js';
import type { PicImageSearchPort } from './pic-image-search-client.js';
import type { PicImageSearchEngine, ProviderResponse } from './types.js';

export class PicImageSearchProvider implements PicImageSearchPort {
  /**
   * 默认取进程级单例（**不启动任何东西**，第一次 search/ping 或显式 `start()` 才 spawn）。
   * 参数是为了测试能塞一个对象字面量进来 —— `PicImageSearchPort` 是纯结构接口。
   */
  constructor(private readonly client: PicImageSearchPort = getPicImageSearchClient()) {}

  /** 按引擎名搜一张图。原样转发，不做任何引擎分支。 */
  search(
    engine: PicImageSearchEngine,
    buffer: Buffer,
    mime: string,
    timeoutMs: number,
    maxResults: number,
    signal?: AbortSignal,
    engineOptions?: Record<string, unknown>
  ): Promise<ProviderResponse> {
    return this.client.search(engine, buffer, mime, timeoutMs, maxResults, signal, engineOptions);
  }

  /** 探活。转发给客户端（它本身已经保证不抛）。 */
  ping(
    engine?: PicImageSearchEngine,
    timeoutMs?: number,
    signal?: AbortSignal,
    engineOptions?: Record<string, unknown>
  ): Promise<boolean> {
    return this.client.ping(engine, timeoutMs, signal, engineOptions);
  }

  /**
   * 设置页「测试连接」用的探活：**任何失败都返回 false，从不抛**。
   *
   * 与 `ping()` 的差别只有两点，都是为调用方服务的：
   * - 名字沿用旧 provider 的 `test()`，于是 `web/routes/config.ts` 的调用点形状不变；
   * - 这里多一层 try/catch。客户端的 `ping` 已经保证不抛，但注入进来的假实现可能是会抛的，
   *   而"设置页上点一下按钮"这条路径不该因为一个注入实现而把异常冒到 HTTP 层。
   *
   * ⚠️ `true` 的含义是「**配置对**」，不是「远端活着」：worker 的 `probe` 只验证
   * "库里有这个引擎、参数能构造出对象"，**刻意不发真实请求**（测试连接是个能随便点的按钮，
   * 烧掉 SauceNAO 的免费额度不合适）。给用户看的文案要说清这个区别。
   *
   * ⚠️ 测 SauceNAO 时必须把 key 递进来（`engineOptions = { apiKey }`）。项目的 key 存在配置里、
   * 不在环境里，所以 worker 的 `SAUCENAO_API_KEY` 兜底在正常路径上永远不会命中 ——
   * 实测过一次：进程健康、库也装了，但没传 key 时返回 `false`，报的却是"未配置 API Key"。
   */
  async test(
    engine: PicImageSearchEngine,
    timeoutMs: number,
    engineOptions?: Record<string, unknown>
  ): Promise<boolean> {
    try {
      return await this.client.ping(engine, timeoutMs, undefined, engineOptions);
    } catch {
      return false;
    }
  }
}
