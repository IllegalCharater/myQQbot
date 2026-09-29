import { readBody } from '../http/http.js';
import type { Route } from '../types.js';
import { PicImageSearchProvider } from '../../media/image-source/index.js';

export const configRoutes: Route[] = [
  {
    method: 'POST',
    path: '/api/image-source/test',
    async handle(ctx) {
      const cfg = ctx.getConfig().imageSource;
      // 一个通用 provider 上问三次：引擎名 + 各自的引擎参数（SauceNAO 的 key 走 engineOptions，
      // 只进 worker 的 stdin）。三条状态照旧**分开**回给设置页，响应形状与拆类之前逐字一致。
      //
      // `test()` 自己已经吞掉异常并返回 false，所以 allSettled 如今只是 HTTP 边界上的第二道
      // 保险 —— 留着它是因为这条路径要面对的最终是用户的点击，不是内部调用。
      const provider = new PicImageSearchProvider();
      const [trace, sauce, baidu] = await Promise.allSettled([
        cfg.traceMoe.enabled ? provider.test('trace.moe', cfg.traceMoe.timeoutMs) : Promise.resolve(false),
        cfg.sauceNao.enabled && cfg.sauceNao.apiKey
          ? provider.test('saucenao', cfg.sauceNao.timeoutMs, { apiKey: cfg.sauceNao.apiKey })
          : Promise.resolve(false),
        // trace / sauce 那两个探针**有意不顺手改成三态**（它们把"未启用"渲染成"失败"，是与本次
        // 无关的既有小瑕疵，改它就是改与本次无关的响应形状）。新加的这一个用三态，因为对百度
        // 识图来说"未启用"与"失败"是两种完全不同的处境：前者是我们自己关的，后者要去查库。
        cfg.baidu.enabled ? provider.test('baidu', cfg.baidu.timeoutMs) : Promise.resolve(null)
      ]);
      return { status: 200, body: {
        traceMoe: trace.status === 'fulfilled' && trace.value,
        sauceNao: !cfg.sauceNao.apiKey ? '未配置' : (sauce.status === 'fulfilled' && sauce.value ? '可用' : '失败'),
        baidu: baidu.status !== 'fulfilled' || baidu.value === null ? '未启用' : (baidu.value ? '可用' : '失败')
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
