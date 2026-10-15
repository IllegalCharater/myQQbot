// 扩展能力的 HTTP 表面：设置页需要知道"这台机器上注册了哪些扩展"。
//
// 为什么必须有个端点：`ui/js/` 是浏览器原生 ES Module，**够不着 `src/`**（没有打包器、
// 也没有跨目录的取值方式）。注册表住在 `src/extra/registry.ts`，所以它得经 HTTP 出来一份
// —— 同 `bookmarkList()` 那条名单的处境（模型那边走 system prompt，面板这边走端点）。
//
// 只读：**唯一的配置写入口仍然是 `POST /api/config`**（与 python-probe / search-bookmark 那两条
// 管理端点同一条规矩）。这里不提供"启用/禁用某个扩展"的写接口，那是配置的事。
import { EXTRA_REGISTRY } from '../../extra/registry.js';
import { isExtraEnabled } from '../../extra/runtime.js';
import type { Route } from '../types.js';

export const extrasRoutes: Route[] = [
  {
    method: 'GET',
    path: '/api/extras',
    async handle(ctx) {
      const config = ctx.getConfig();
      return {
        status: 200,
        body: {
          ok: true,
          // `enabled` 已经把 `defaultEnabled` 兜进去了，所以面板不需要自己再判一次 ——
          // 判据只有 `isExtraEnabled` 一处（与模型看到的工具表用的是同一个）。
          extras: EXTRA_REGISTRY.map((entry) => ({
            id: entry.id,
            title: entry.title,
            // 给人看的一句话说明（**不是**模型看到的那段工具描述，见 extra/types.ts）。
            description: entry.displayDesc,
            mode: entry.mode ?? 'attach',
            defaultEnabled: entry.defaultEnabled,
            enabled: isExtraEnabled(entry, config)
          }))
        }
      };
    }
  }
];
