import { readBody } from '../http/http.js';
import type { Route } from '../types.js';
import { SauceNaoProvider, TraceMoeProvider } from '../../media/image-source/index.js';

export const configRoutes: Route[] = [
  {
    method: 'POST',
    path: '/api/image-source/test',
    async handle(ctx) {
      const cfg = ctx.getConfig().imageSource;
      const [trace, sauce] = await Promise.allSettled([
        cfg.traceMoe.enabled ? new TraceMoeProvider().test(cfg.traceMoe.timeoutMs) : Promise.resolve(false),
        cfg.sauceNao.enabled && cfg.sauceNao.apiKey ? new SauceNaoProvider().test(cfg.sauceNao.apiKey, cfg.sauceNao.timeoutMs) : Promise.resolve(false)
      ]);
      return { status: 200, body: {
        traceMoe: trace.status === 'fulfilled' && trace.value,
        sauceNao: !cfg.sauceNao.apiKey ? '未配置' : (sauce.status === 'fulfilled' && sauce.value ? '可用' : '失败')
      } };
    }
  },
  {
    method: 'GET',
    path: '/api/config',
    async handle(ctx) {
      return { status: 200, body: ctx.sanitizeConfig(ctx.getConfig()) };
    },
  },
  {
    method: 'POST',
    path: '/api/config',
    async handle(ctx, req) {
      const patch = await readBody(req);
      const config = ctx.applyConfigPatch(patch);
      // 保存响应同 GET /api/config 一样必须脱敏；否则新增的热搜 Key 会在浏览器响应里回显。
      return { status: 200, body: { ok: true, config: ctx.sanitizeConfig(config) } };
    },
  },
];
