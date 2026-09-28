// 控制台 HTTP 表面：SSE 端点、鉴权、路由分发、静态文件、状态快照与配置脱敏。
//
// 为什么单独一个模块：这几样既不是"组件的新建/组装"，也不是"事件绑定"，而是**控制台这一侧
// 的对外表面**——它只回答"外部请求进来时怎么答"，不改变组件图。原先它们与组装根同处
// `app.ts` 的 `createApp()` 里（约 190 行），让"组装根在装什么"这件事被 HTTP 细节淹掉。
//
// **留在 `app.ts` 的两样东西，以及为什么**：
//   - `emit` 闭包与 `sseClients`：帧的拼装是跨层产物（`event-projector.ts`），
//     且 `tests/t-sse-project.mjs` 会读 `dist/web/app.js` 里那个闭包的形状；
//   - `applyConfigPatch`：它本质是"把配置变更接到组件上"（启停 proactive/compact、
//     重建价格表、比较后重连），与 `start()` 同类，属于组装根职责而不是 HTTP 职责。
//     它由本模块经 `deps.applyConfigPatch` 转交给路由（`POST /api/config`）。
//
// 一个容易踩的边界：**扫描式断言看不见这里**。`t-timers.mjs` 那两条"端点只有一个写入口"
// 的扫描原文只扫 `src/web/app.ts`，所以**不要在本模块里直接给 `onebot.wsUrl` 赋值**——
// 绕过 `applyEndpoint` 就绕过了归一化，而没有任何断言会拦住它。
import http from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AppConfig } from '../../core/config.js';
import { todayKey } from '../../core/util.js';
import type { AppEmit } from '../../core/events.js';
import type { ChatStore } from '../../chat/store.js';
import type { MemoryStore } from '../../chat/memory.js';
import type { SessionRegistry } from '../../chat/sessions.js';
import type { OneBotClient } from '../../qq/onebot.js';
import type { SendQueue } from '../../qq/sender.js';
import type { StickerManager } from '../../stickers/sticker-manager.js';
import type { AgentControlPort } from '../../agent/runtime/control-port.js';
import { estimateCost, cacheHitRate } from '../../llm/llm.js';
import { UI_DIR } from '../../core/paths.js';
import { serveStatic } from './static-files.js';
import { dispatchRoute } from './router.js';
import { routes } from '../routes/index.js';
import { buildUsageBreakdown, buildUsageStats } from '../usage-service.js';
import { errorMessage, isRecord, writeReply } from './http.js';
import type { SnowlumaController } from '../onebot/snowluma.js';
import type { HotSearchAdminActions } from '../../media/hot-search/admin-actions.js';

export interface ConsoleDeps {
  /** SSE 客户端集合由组装根持有（`emit` 闭包要往同一个集合里广播），这里只借用。 */
  sseClients: Set<ServerResponse>;
  store: ChatStore;
  memory: MemoryStore;
  sessions: SessionRegistry;
  onebot: OneBotClient;
  sender: SendQueue;
  stickers: StickerManager;
  orchestrator: AgentControlPort;
  emit: AppEmit;
  snowluma: SnowlumaController;
  hotSearch: HotSearchAdminActions;
  getConfig: () => AppConfig;
  updateConfig: (patch: Record<string, unknown>) => AppConfig;
  /** 组装根的实现（见文件头注释：它属于组装根职责，这里只做转交）。 */
  applyConfigPatch: (patch: unknown) => AppConfig;
  log: (...args: unknown[]) => void;
}

export interface Console {
  server: Server;
  handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void>;
  /** 监听一个端口；端口被占用时 reject（调用方负责试下一个）。 */
  listenOn(port: number): Promise<number>;
  buildStatus(): Promise<unknown>;
  sanitizeConfig(config: AppConfig): unknown;
}

export function createConsole(deps: ConsoleDeps): Console {
  const {
    sseClients, store, memory, sessions, onebot, sender, stickers, orchestrator,
    emit, snowluma, hotSearch, getConfig, updateConfig, applyConfigPatch, log
  } = deps;

  const server = http.createServer((req, res) => {
    handleHttp(req, res).catch((error) => {
      log('[http] 处理出错:', errorMessage(error));
      try {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: errorMessage(error) }));
      } catch { /* ignore */ }
    });
  });

  function json(res: ServerResponse, code: number, data: unknown) {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(data));
  }

  function authorize(req: IncomingMessage) {
    const token = String(getConfig().server?.token ?? '');
    if (!token) return true;
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    return req.headers['x-console-token'] === token || url.searchParams.get('token') === token;
  }

  // ── 配置脱敏 ────────────────────────────────────────────────────────────
  // 凡是字段名命中这些模式的，值一律替换为空串（保留"有/无"的 hasXxx 标记）。
  // 覆盖：apiKey / api_key / accessToken / httpAccessToken / token / secret / password …
  const SECRET_KEY_PATTERN = /(apikey|api_key|accesstoken|access_token|secret|password|privatekey|private_key)/i;
  // 形如 apiKeyFrom 的字段存的是"密钥来源标识"（如 manual），不是密钥本身，不要脱敏
  const SECRET_KEY_EXCLUDE = /from$/i;

  function sanitizeConfig(cfg: AppConfig) {
    const parsed: unknown = JSON.parse(JSON.stringify(cfg ?? {}));
    const out: Record<string, unknown> = isRecord(parsed) ? parsed : {};
    const seen = new WeakSet<object>();

    const walk = (node: Record<string, unknown>) => {
      if (seen.has(node)) return;
      seen.add(node);
      for (const key of Object.keys(node)) {
        const value = node[key];
        if (isRecord(value)) { walk(value); continue; }
        if (Array.isArray(value)) {
          for (const item of value) if (isRecord(item)) walk(item);
          continue;
        }
        if (SECRET_KEY_EXCLUDE.test(key)) continue;
        // 已生成的 hasXxx 布尔标记本身也会被 apikey 模式匹配到，
        // 不排除就会连锁生成 hasHasXxx
        if (/^has/i.test(key) && typeof value === 'boolean') continue;
        if (SECRET_KEY_PATTERN.test(key)) {
          // ⚠️ 必须"删除字段"而不是"置为空串"。
          // 前端保存设置时会把整个 config 展开成 patch 回传（...c.webSearch?.deepseek），
          // 若这里留一个空串，deepMerge 会拿空串覆盖掉服务端保存的真 Key ——
          // 表现为：用户点一次"保存设置"，所有搜索 Key 就被静默清空。
          // 删掉字段则展开时不会带上该键，服务端原值得以保留。
          delete node[key];
          const flagName = `has${key.charAt(0).toUpperCase()}${key.slice(1)}`;
          node[flagName] = Boolean(String(value ?? '').trim());
        }
      }
    };
    walk(out);

    // 音视频转写凭证也支持 systemd 环境变量。通用 walk 只看配置文件里的值，
    // 这里补上“实际是否可用”和来源标记；只返回布尔值，绝不把环境变量明文带给浏览器。
    if (isRecord(out.transcription)) {
      const target = out.transcription;
      const stored = cfg.transcription;
      const envEnabled = String(process.env.QQ_AGENT_TRANSCRIPTION_ENABLED || '').trim();
      const envAppId = String(process.env.TENCENTCLOUD_APP_ID || '').trim();
      const envSecretId = String(process.env.TENCENTCLOUD_SECRET_ID || '').trim();
      const envSecretKey = String(process.env.TENCENTCLOUD_SECRET_KEY || '').trim();
      target.hasAppId = Boolean(String(stored.appId || envAppId).trim());
      target.hasSecretId = Boolean(String(stored.secretId || envSecretId).trim());
      target.hasSecretKey = Boolean(String(stored.secretKey || envSecretKey).trim());
      target.appIdFromEnvironment = !String(stored.appId || '').trim() && Boolean(envAppId);
      target.secretIdFromEnvironment = !String(stored.secretId || '').trim() && Boolean(envSecretId);
      target.secretKeyFromEnvironment = !String(stored.secretKey || '').trim() && Boolean(envSecretKey);
      target.enabledFromEnvironment = Boolean(envEnabled);
      target.effectiveEnabled = envEnabled
        ? ['1', 'true', 'yes', 'on'].includes(envEnabled.toLowerCase())
        : stored.enabled === true;
    }

    // 热搜 Key 还支持 systemd 环境变量。只回显“是否存在”，绝不把环境变量值带进配置响应。
    out.hasHotSearchApiKey = Boolean(String(cfg.hotSearchApiKey || process.env.HOT_SEARCH_API_KEY || '').trim());

    // 密钥集合整体清空（不逐 key 暴露存在性）
    if (isRecord(out.dshProviderKeys)) {
      const has: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(out.dshProviderKeys)) has[k] = Boolean(String(v ?? '').trim());
      out.dshProviderKeys = {};
      out.dshProviderKeyPresence = has;
    }

    // 提供商列表：删掉 key 字段（同样不能置空串，否则回传时覆盖真实 Key），补 hasKey
    if (Array.isArray(out.providers)) {
      for (const p of out.providers) {
        if (!isRecord(p)) continue;
        const real = (cfg.dshProviderKeys || {})[String(p.id ?? '')] || p.apiKey;
        delete p.apiKey;
        p.hasKey = Boolean(String(real ?? '').trim());
      }
    }
    // 顶层 api：walk 已生成 hasApiKey，这里补一个简写的 hasKey 供旧代码读取
    if (isRecord(out.api)) out.api.hasKey = out.api.hasApiKey ?? Boolean(String(cfg.api?.apiKey ?? '').trim());

    return out;
  }

  async function buildStatus() {
    const usage = sessions.todayUsage(todayKey());
    const current = getConfig();
    return {
      onebot: {
        connected: onebot.connected,
        everConnected: onebot.everConnected,
        error: onebot.lastConnectError,
        self: onebot.selfInfo ? { userId: onebot.selfId, nickname: onebot.selfNickname } : null
      },
      snowluma: {
        dir: snowluma.dir(),
        running: await snowluma.isPortOpen('127.0.0.1', snowluma.servicePort()),
        webuiUrl: snowluma.webuiUrl(),
        ...snowluma.status()
      },
      orchestrator: orchestrator.statusSummary(), usage,
      cost: estimateCost(usage, { model: current.api?.model }),
      cacheHitRate: cacheHitRate(usage),
      webSearchCount: usage.webSearchCount || 0,
      paused: orchestrator.paused,
      pauseReason: orchestrator.pauseReason ?? null
    };
  }

  async function handleHttp(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pathname = url.pathname;

    // SSE
    if (pathname === '/api/events' && req.method === 'GET') {
      if (!authorize(req)) return json(res, 401, { error: '未授权' });
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      });
      res.write(`event: hello\ndata: {}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    if (pathname.startsWith('/api/')) {
      if (!authorize(req)) return json(res, 401, { error: '未授权' });
      const method = req.method;
      const routed = await dispatchRoute(routes, {
        store, memory, sessions, onebot, sender, stickers, orchestrator, emit, hotSearch,
        getConfig, updateConfig, buildUsageStats, buildUsageBreakdown,
        sanitizeConfig, applyConfigPatch, buildStatus,
        launchSnowluma: () => snowluma.launch(),
        stopSnowluma: () => snowluma.stop(),
        snowlumaStatus: () => snowluma.status(),
        getSnowlumaLogs: () => snowluma.logs().slice(-200),
        openSnowlumaFolder: () => snowluma.openFolder(),
        openSnowlumaWebui: () => snowluma.openWebui()
      }, req, url);
      if (routed) return writeReply(res, routed);

      // ── 多提供商模型目录 ──
      // ── 表情包管理（面板"表情"页） ────────────────────────────────────────
      //
      // 库里 48 条表情以前只能靠 `data/stickers.json` 手改，这是第一个入口。
      return json(res, 404, { error: `未知 API：${method} ${pathname}` });
    }

    if (serveStatic(req, res, pathname, UI_DIR)) return;

    res.writeHead(404);
    res.end();
  }

  function listenOn(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        resolve(port); // 必须把实际端口传回去，Electron 壳要用它加载页面
      });
    });
  }

  return { server, handleHttp, listenOn, buildStatus, sanitizeConfig };
}
