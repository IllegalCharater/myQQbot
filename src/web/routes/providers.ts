import { chatCompletion, resolveApiKey } from '../../llm/llm.js';
import { customSearch, probeSiteSearch, normalizeSiteInput } from '../../media/web-search.js';
import { testBookmarkRequest, MAX_ENDPOINT_CHARS } from '../../media/bookmark-request.js';
import { validateFetchUrl } from '../../media/safe-fetch.js';
import {
  addModelsToProvider, currentProviders, fetchModelsFrom, removeModelFromProvider,
  setProviderKey, testAllProviders, testModelChat, testOneProvider, upsertProvider,
} from '../../llm/providers.js';
import { errorMessage, isRecord, readBody } from '../http/http.js';
import type { Route } from '../types.js';
import { builtinVisionResults } from '../../llm/model-vision-docs.js';
import { scanModelsVision, visionResults } from '../../llm/vision-scan.js';

const visionScan = { running: false };

function bodyRecord(value: unknown): Record<string, unknown> { return isRecord(value) ? value : {}; }

interface SearchProvider extends Record<string, unknown> {
  id: string; name: string; type: 'bing' | 'openai'; baseUrl: string; apiKey: string;
  model: string; count: number; timeoutMs: number;
}

function searchConfig(ctx: Parameters<Route['handle']>[0]): { provider: string; providers: SearchProvider[]; raw: Record<string, unknown> } {
  const config = ctx.getConfig() as unknown as Record<string, unknown>;
  const raw = isRecord(config.webSearch) ? config.webSearch : {};
  const providers = Array.isArray(raw.providers) ? raw.providers.filter(isRecord).map((item) => ({
    ...item,
    id: String(item.id ?? ''), name: String(item.name ?? ''),
    type: item.type === 'bing' ? 'bing' as const : 'openai' as const,
    baseUrl: String(item.baseUrl ?? ''), apiKey: String(item.apiKey ?? ''), model: String(item.model ?? ''),
    count: Number(item.count) || 6, timeoutMs: Number(item.timeoutMs) || 20_000,
  })) : [];
  return { provider: String(raw.provider ?? ''), providers, raw };
}

function sanitizeProvider(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const { apiKey, ...rest } = value;
  return { ...rest, apiKey: '', hasKey: Boolean(String(apiKey ?? '').trim()) };
}

function keyEndpointAllowed(req: Parameters<Route['handle']>[1], token: string): boolean {
  const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (token && (req.headers['x-console-token'] === token || requestUrl.searchParams.get('token') === token)) return true;
  if (req.headers['x-console-token']) return true;
  const host = String(req.headers.host ?? '');
  const origin = String(req.headers.origin ?? '');
  const referer = String(req.headers.referer ?? '');
  if (!(/^127\.0\.0\.1:\d+$/.test(host) || /^localhost:\d+$/.test(host))) return false;
  if (origin) return origin === `http://${host}`;
  if (referer) return referer.startsWith(`http://${host}/`);
  return true;
}

export const providerRoutes: Route[] = [
  {
    method: 'GET', path: '/api/providers', async handle(ctx) {
      const providers = currentProviders().map((provider) => ({
        id: provider.id, displayName: provider.displayName, baseURL: provider.baseURL, apiKey: '',
        apiKeyFrom: provider.apiKeyFrom || '', needsBaseUrl: provider.needsBaseUrl === true,
        hasKey: Boolean(provider.apiKey), anthropicOrigin: provider.anthropicOrigin === true,
        models: provider.models, modelNames: provider.modelNames || {},
      }));
      return { status: 200, body: { providers, source: ctx.getConfig().providersSourceYaml } };
    },
  },
  {
    method: 'GET', path: '/api/providers/key', async handle(ctx, req, _match, url) {
      if (!keyEndpointAllowed(req, String(ctx.getConfig().server?.token ?? ''))) return { status: 403, body: { error: '请求来源不被信任，已拒绝读取明文密钥。' } };
      const provider = currentProviders().find((item) => item.id === String(url.searchParams.get('providerId') || ''));
      return { status: 200, body: { apiKey: provider?.apiKey || '' } };
    },
  },
  {
    method: 'GET', path: '/api/api-key', async handle(ctx, req) {
      if (!keyEndpointAllowed(req, String(ctx.getConfig().server?.token ?? ''))) return { status: 403, body: { error: '请求来源不被信任，已拒绝读取明文密钥。' } };
      return { status: 200, body: { apiKey: String(ctx.getConfig().api.apiKey || '') } };
    },
  },
  {
    method: 'POST', path: '/api/providers/fetch-models', async handle(ctx, req) {
      try {
        const body = bodyRecord(await readBody(req)); const config = ctx.getConfig();
        const baseUrl = String(body.baseUrl || config.api.baseUrl || '');
        const apiKey = body.apiKey !== undefined ? String(body.apiKey ?? '') : String(config.api.apiKey || '');
        return { status: 200, body: { ok: true, models: await fetchModelsFrom(baseUrl, apiKey) } };
      } catch (error) { return { status: 502, body: { ok: false, error: errorMessage(error) } }; }
    },
  },
  {
    method: 'POST', path: '/api/providers/test-one', async handle(_ctx, req) {
      try {
        const body = bodyRecord(await readBody(req));
        const result = await testOneProvider({ providerId: String(body.providerId ?? ''), baseUrl: String(body.baseUrl ?? ''), apiKey: String(body.apiKey ?? '') });
        return { status: 200, body: { ok: true, result } };
      } catch (error) { return { status: 500, body: { ok: false, error: errorMessage(error) } }; }
    },
  },
  {
    method: 'POST', path: '/api/providers/test-chat', async handle(ctx, req) {
      try {
        const body = bodyRecord(await readBody(req)); const submitted = String(body.apiKey ?? '').trim();
        const apiKey = submitted && submitted !== '******' ? submitted : resolveApiKey(ctx.getConfig());
        const result = await testModelChat({ baseUrl: String(body.baseUrl ?? ''), apiKey, model: String(body.model ?? '') });
        return { status: 200, body: { ok: true, result } };
      } catch (error) { return { status: 400, body: { ok: false, error: errorMessage(error) } }; }
    },
  },
  {
    method: 'POST', path: '/api/providers', async handle(_ctx, req) {
      try {
        const body = bodyRecord(await readBody(req));
        const result = upsertProvider({ baseUrl: String(body.baseUrl ?? ''), apiKey: String(body.apiKey ?? ''), models: Array.isArray(body.models) ? body.models : [] });
        return { status: 200, body: { ok: true, ...result, provider: sanitizeProvider(result.provider) } };
      } catch (error) { return { status: 400, body: { ok: false, error: errorMessage(error) } }; }
    },
  },
  {
    method: 'POST', path: '/api/providers/models', async handle(_ctx, req) {
      try {
        const body = bodyRecord(await readBody(req));
        const provider = addModelsToProvider(String(body.providerId ?? ''), Array.isArray(body.models) ? body.models : []);
        return provider ? { status: 200, body: { ok: true, provider: sanitizeProvider(provider) } } : { status: 404, body: { ok: false, error: '提供商不存在' } };
      } catch (error) { return { status: 400, body: { ok: false, error: errorMessage(error) } }; }
    },
  },
  {
    method: 'DELETE', path: '/api/providers/models', async handle(_ctx, req) {
      try {
        const body = bodyRecord(await readBody(req)); const provider = removeModelFromProvider(String(body.providerId ?? ''), String(body.modelId ?? ''));
        return provider ? { status: 200, body: { ok: true, provider: sanitizeProvider(provider) } } : { status: 404, body: { ok: false, error: '提供商或模型不存在' } };
      } catch (error) { return { status: 400, body: { ok: false, error: errorMessage(error) } }; }
    },
  },
  {
    method: 'POST', path: '/api/providers/set-key', async handle(_ctx, req) {
      const body = bodyRecord(await readBody(req)); const updated = setProviderKey(String(body.providerId ?? ''), String(body.apiKey ?? ''));
      return updated ? { status: 200, body: { ok: true, hasKey: Boolean(updated.apiKey) } } : { status: 404, body: { ok: false, error: '提供商不存在' } };
    },
  },
  {
    method: 'POST', path: '/api/providers/test-all', async handle() {
      const results = await testAllProviders(currentProviders());
      return { status: 200, body: { ok: true, results, okCount: Object.values(results).filter((result) => result.ok).length, total: Object.keys(results).length } };
    },
  },
  {
    method: 'GET', path: '/api/vision/results', async handle() {
      return { status: 200, body: { results: { ...builtinVisionResults(currentProviders()), ...visionResults() }, scanning: visionScan.running } };
    },
  },
  {
    method: 'POST', path: '/api/vision/scan', async handle(ctx, req) {
      if (visionScan.running) return { status: 409, body: { ok: false, error: '已有一次扫描正在进行' } };
      const body = bodyRecord(await readBody(req).catch(() => ({})));
      const onlyProviderIds = Array.isArray(body.providerIds) ? body.providerIds.map(String) : null;
      visionScan.running = true;
      // 进度与结果不再经事件上报（`vision-scan` 零消费者，S11d 已删）。
      // 面板靠这一条 HTTP 的 202 与 `/api/vision/results` 的 `scanning` 标志轮询，
      // 所以这里的 `visionScan.running` 是**真在用的**本地状态，不是事件残留。
      void scanModelsVision({ providers: currentProviders(), onlyProviderIds, timeoutMs: 25_000, limit: 3 })
        .catch(() => { /* 失败不改已返回的 202；下一次轮询会看到 running 归位 */ })
        .finally(() => { visionScan.running = false; });
      return { status: 202, body: { ok: true, started: true } };
    },
  },
  {
    method: 'GET', path: '/api/search-key', async handle(ctx, req, _match, url) {
      if (!keyEndpointAllowed(req, String(ctx.getConfig().server?.token ?? ''))) return { status: 403, body: { error: '请求来源不被信任，已拒绝读取明文密钥。' } };
      const field = String(url.searchParams.get('field') || '');
      if (!['deepseek', 'zhipu', 'bocha', 'baidu', 'metaso'].includes(field)) return { status: 400, body: { error: `未知搜索服务：${field}` } };
      const { raw } = searchConfig(ctx); const provider = isRecord(raw[field]) ? raw[field] : {};
      return { status: 200, body: { apiKey: String(provider.apiKey || '') } };
    },
  },
  {
    method: 'GET', path: '/api/search-providers', async handle(ctx) {
      const providers = searchConfig(ctx).providers.map((item) => ({
        id: item.id, name: item.name, type: item.type, baseUrl: item.baseUrl, model: item.model,
        count: item.count, timeoutMs: item.timeoutMs, hasApiKey: Boolean(item.apiKey.trim()),
      }));
      return { status: 200, body: { providers } };
    },
  },
  {
    method: 'POST', path: '/api/search-providers', async handle(ctx, req) {
      try {
        const body = bodyRecord(await readBody(req).catch(() => ({}))); const baseUrl = String(body.baseUrl ?? '').trim();
        const type: SearchProvider['type'] = String(body.type ?? 'openai').trim() === 'bing' ? 'bing' : 'openai';
        if (!baseUrl) return { status: 400, body: { ok: false, error: '接口地址不能为空' } };
        const list = [...searchConfig(ctx).providers]; let entry = list.find((item) => item.baseUrl === baseUrl && item.type === type);
        if (entry) {
          entry.name = String(body.name ?? entry.name ?? '').trim() || entry.name; entry.baseUrl = baseUrl; entry.type = type;
          entry.model = String(body.model ?? entry.model ?? '').trim(); entry.count = Math.min(20, Math.max(1, Number(body.count) || entry.count || 6));
          entry.timeoutMs = Math.max(5_000, Number(body.timeoutMs) || entry.timeoutMs || 20_000);
          const submitted = String(body.apiKey ?? '').trim(); if (submitted && submitted !== '******') entry.apiKey = submitted;
        } else {
          entry = { id: `sp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name: String(body.name ?? '').trim() || baseUrl,
            type, baseUrl, apiKey: String(body.apiKey ?? '').trim() === '******' ? '' : String(body.apiKey ?? '').trim(),
            model: String(body.model ?? '').trim(), count: Math.min(20, Math.max(1, Number(body.count) || 6)), timeoutMs: Math.max(5_000, Number(body.timeoutMs) || 20_000) };
          list.push(entry);
        }
        ctx.updateConfig({ webSearch: { providers: list } });
        return { status: 200, body: { ok: true, provider: { ...entry, apiKey: '', hasApiKey: Boolean(entry.apiKey.trim()) } } };
      } catch (error) { return { status: 400, body: { ok: false, error: errorMessage(error) } }; }
    },
  },
  {
    method: 'DELETE', path: '/api/search-providers', async handle(ctx, req) {
      try {
        const body = bodyRecord(await readBody(req).catch(() => ({}))); const id = String(body.id ?? '').trim();
        if (!id) return { status: 400, body: { ok: false, error: '缺少 id' } };
        const current = searchConfig(ctx); ctx.updateConfig({ webSearch: { providers: current.providers.filter((item) => item.id !== id) } });
        if (current.provider === `custom:${id}`) ctx.updateConfig({ webSearch: { provider: 'bing' } });
        return { status: 200, body: { ok: true } };
      } catch (error) { return { status: 400, body: { ok: false, error: errorMessage(error) } }; }
    },
  },
  {
    method: 'POST', path: '/api/search-providers/test', async handle(_ctx, req) {
      const startedAt = Date.now();
      try {
        const body = bodyRecord(await readBody(req).catch(() => ({}))); const result = await customSearch('qq agent 测试', String(body.providerId ?? '').trim() || null);
        return { status: 200, body: { ok: true, result: { ok: true, count: result.results.length, sample: result.results[0]?.title || '', latencyMs: Date.now() - startedAt } } };
      } catch (error) { return { status: 200, body: { ok: true, result: { ok: false, note: errorMessage(error), latencyMs: Date.now() - startedAt } } }; }
    },
  },
  {
    // 收藏夹的「自动检测站内搜索地址」。**只做 URL 校验 + 探测**，不写配置 ——
    // 唯一的配置写入口仍是鉴权过的 `POST /api/config`（与 python-probe 同一条规矩：
    // 别凭空开一个"用 HTTP 改配置"的旁路）。
    method: 'POST', path: '/api/search-bookmark/probe', async handle(_ctx, req) {
      const startedAt = Date.now();
      const body = bodyRecord(await readBody(req).catch(() => ({})));
      // 归一成带协议的 URL 再校验：设置页那一栏的标签是「网页地址」、占位符是裸域名
      // （`zh.wikipedia.org`），所以用户填裸域名是最正常的填法。`validateFetchUrl`
      // 直接吃 `new URL(...)`，裸域名会抛"URL 无效" —— 那会报成用户看不懂的错误。
      const site = normalizeSiteInput(body.site ?? body.url ?? '');
      if (!site) return { status: 400, body: { ok: false, error: '缺少 site' } };
      // **先过 SSRF 校验**：这个端点会按用户给的域名去联网抓页面，是仓库里少数
      // "由请求内容决定目标地址"的出口之一。`validateFetchUrl` 会拒掉非 http/https、
      // URL 内嵌凭据、本机/内网/链路本地/云元数据地址，并做一次 DNS 解析检查。
      // ⚠️ 已知残余风险（知情取舍，不是疏忽）：实际发请求用的是 `fetch`，它会**再解析一次**
      // DNS，所以"解析后固定到已校验 IP"这层防护在这里不成立（`safeFetch` 才有那层）。
      // 换来的是不必为探测再写一遍有界读取与逐跳校验；本端点仅管理员可达、只读、一次性。
      try {
        await validateFetchUrl(site);
      } catch (error) {
        return { status: 400, body: { ok: false, error: `站点地址不可用：${errorMessage(error)}` } };
      }
      // 「站内搜索地址」这一栏**已填**时只测他填的那个；留空则自动检测（见 probeSiteSearch 头注释）。
      // 两者是**同一个端点**：对用户来说都是"点检测"，区别只由"那一栏空不空"决定。
      const result = await probeSiteSearch(site, {
        searchUrl: String(body.searchUrl ?? '').trim(),
        hint: String(body.hint ?? '').trim()
      });
      return { status: 200, body: { ok: true, result: { ...result, latencyMs: Date.now() - startedAt } } };
    },
  },
  {
    // 「请求结构」弹窗里的「测试」按钮。
    //
    // 为什么需要它：那一栏填的东西**除了保存没有别的验证手段** —— 地址拼错了、占位符没填值、
    // 密钥不对、接口要求 POST 而填了 GET，全都要等到模型真的去搜、或者在群里答不出话时
    // 才暴露。而「网页地址」那一栏早就有「检测」按钮了，这一栏却没有（**实测反馈**）。
    //
    // 它与真实检索**走同一条解析链**（`testBookmarkRequest` → 与 `siteSearch()` 同一批
    // `jsonToResults`/`flattenJson`），所以"测试通过"就是"真能搜到"，不是"连得上"。
    method: 'POST', path: '/api/search-bookmark/test-request', async handle(ctx, req) {
      const startedAt = Date.now();
      const body = bodyRecord(await readBody(req).catch(() => ({})));
      const raw = bodyRecord(body.request);
      const endpoint = String(raw.endpoint ?? '').trim();
      if (!endpoint) return { status: 400, body: { ok: false, error: '缺少 request.endpoint' } };
      if (endpoint.length > MAX_ENDPOINT_CHARS) {
        return { status: 400, body: { ok: false, error: `请求地址过长（上限 ${MAX_ENDPOINT_CHARS} 字符）` } };
      }
      const method = String(raw.method ?? 'GET').trim().toUpperCase() || 'GET';
      const headers = Array.isArray(raw.headers)
        ? raw.headers.filter(isRecord).map((h) => ({ name: String(h.name ?? ''), value: String(h.value ?? '') }))
        : [];
      const params = isRecord(body.params)
        ? Object.fromEntries(Object.entries(body.params).map(([k, v]) => [String(k), String(v ?? '')]))
        : undefined;

      // **先过 SSRF 校验**，与 probe 同一个理由：这是"由请求内容决定目标地址"的出口之一。
      // 校验的是**填好占位符之后**的最终地址：用户填的是模板，`{q}` 会让 `new URL` 直接抛。
      // ⚠️ 只写路径、靠 `Host` 头补全的写法（`/v2/x?q={q}` + `Host: api.example.com`）
      // 要在这里补出协议再校验 —— `resolveEndpoint()` 支持那种写法，漏了它会把**合法配置**
      // 误报成"地址不可用"（判据必须与那条链一致）。
      const bareHost = headers.find((h) => h.name.trim().toLowerCase() === 'host')?.value.trim();
      const endpointWithHost = /^https?:\/\//i.test(endpoint)
        ? endpoint
        : (bareHost ? `https://${bareHost}/` : '') + endpoint.replace(/^\/+/, '');
      const filled = endpointWithHost.replace(/\{q\}/g, encodeURIComponent('test'))
        .replace(/\{[^{}]{1,60}\}/g, 'test');
      try {
        // ⚠️ 要**尊重** `security.allowPrivateImageHosts`（与 `safeFetch` 同一条判据）。
        // 内网/本机上的自建 JSON 接口是**正常用法**（自建百科、Dify、内网知识库），
        // 硬挡会把这条路走死；而这个开关本来就是为"本地测试/自建服务"准备的。
        // 不传的话默认仍是拒绝内网 —— 那是安全的那一侧，不是漏掉。
        const allowPrivate = (ctx.getConfig() as { security?: { allowPrivateImageHosts?: boolean } })
          .security?.allowPrivateImageHosts === true;
        await validateFetchUrl(filled, { allowPrivate });
      } catch (error) {
        return { status: 400, body: { ok: false, error: `请求地址不可用：${errorMessage(error)}` } };
      }

      // 响应体长度：`testBookmarkRequest` 已经把进诊断文案的响应原文**截到 200 字符**
      // （见它那几条 note），所以这里不必再设二次上限 —— 别把一个用不上的常量放进来假装有保护。
      try {
        const result = await testBookmarkRequest(
          { method: method as 'GET' | 'POST', endpoint, headers },
          params,
          { sampleQuery: String(body.sampleQuery ?? '').trim(), limit: Number(body.limit) || 5 }
        );
        return {
          status: 200,
          body: { ok: true, result: { ...result, latencyMs: Date.now() - startedAt } }
        };
      } catch (error) {
        // 与 probe 一致：探测类端点**不把异常抛给上层**，如实回报给界面看
        return {
          status: 200,
          body: { ok: true, result: { ok: false, note: `测试失败：${errorMessage(error)}`, latencyMs: Date.now() - startedAt } }
        };
      }
    },
  },
  {
    method: 'POST', path: '/api/test/api', async handle() {
      const startedAt = Date.now();
      try {
        const result = await chatCompletion({ messages: [{ role: 'user', content: '请只回复两个字符：pong' }], tools: null, temperature: 0 });
        const reply = typeof result.message.content === 'string' ? result.message.content.slice(0, 100) : '';
        return { status: 200, body: { ok: true, model: result.model, reply, latencyMs: Date.now() - startedAt } };
      } catch (error) { return { status: 200, body: { ok: false, error: errorMessage(error), latencyMs: Date.now() - startedAt } }; }
    },
  },
];
