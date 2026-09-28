// OneBot 接入侧 · 令牌桥
//
// SnowLuma 给每个登录过的账号生成独立随机 token（`config/onebot_<uin>.json`），
// 且**永久保留**——不表示"当前在线"。多账号场景下"取第一个文件"会拿错 token
// （WS 401 无限重试）。这里的策略是：收集所有 per-uin 文件的 token 作为候选，
// 401 时轮换下一个重连，连上后记住生效的那个（天然支持 SnowLuma 里切账号）。
//
// 原先这五件事是 `app.ts` 里 `createApp()` 内部的闭包 + 三个私有变量（约 105 行）。
// 搬出来只为一件事：候选游标、去重签名与限频时间戳是这台桥自己的状态，组装根不需要
// 知道它们。**行为逐行保持不变**——`app.ts` 那边仍是同样的调用点（`sync()` / `watch()`）。
import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../../core/config.js';
import type { OneBotClient } from '../../qq/onebot.js';
import { errorMessage, isRecord } from '../http/http.js';

export interface TokenPair { wsToken: string; httpToken: string }

/** `OneBotClient` 加上桥挂上去的候选列表（实例字段，不在类声明里）。 */
export type OneBotRuntime = OneBotClient & { tokenCandidates: TokenPair[] };

export interface TokenBridge {
  /** 把候选列表同步进配置 + 挂到 onebot 实例（不立即连接）。返回是否有变化。 */
  sync(): boolean;
  /** 装 401 监听：断开且错误含 401 时轮换下一个候选重连。 */
  watch(): void;
}

export function createTokenBridge({ onebot, snowlumaDir, getConfig, updateConfig, log }: {
  onebot: OneBotRuntime;
  snowlumaDir: () => string;
  getConfig: () => AppConfig;
  updateConfig: (patch: Record<string, unknown>) => AppConfig;
  log: (...args: unknown[]) => void;
}): TokenBridge {
  let lastSyncTokenSig = '';

  /** 从单个配置对象里提取 ws/http token（找不到网络段时返回 null）。 */
  function extractTokens(data: unknown): TokenPair {
    const root = isRecord(data) ? data : {}; const networks = isRecord(root.networks) ? root.networks : {};
    const httpServers = Array.isArray(networks.httpServers) ? networks.httpServers.filter(isRecord) : [];
    const wsServers = Array.isArray(networks.wsServers) ? networks.wsServers.filter(isRecord) : [];
    const http = httpServers.find((server) => server.port === 3000 || server.name === 'http-default') || httpServers[0];
    const ws = wsServers.find((server) => server.port === 3001 || server.name === 'ws-default') || wsServers[0];
    return { wsToken: String(ws?.accessToken ?? ''), httpToken: String(http?.accessToken ?? '') };
  }

  /** 收集所有候选 token（含 onebot_0.json 的空令牌兜底），按"当前配置优先"排序。 */
  function readCandidates() {
    const out: TokenPair[] = [];
    try {
      const dir = snowlumaDir();
      if (!dir) return out;
      const cfgDir = path.join(dir, 'config');
      let files: string[] = [];
      try {
        files = fs.readdirSync(cfgDir).filter((f) => /^onebot_\d+\.json$/.test(f) && !/^onebot_0\.json$/.test(f)).sort();
      } catch { /* ignore */ }
      for (const f of files) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(cfgDir, f), 'utf8'));
          out.push(extractTokens(data));
        } catch { /* 单个文件坏了跳过，不影响其他候选 */ }
      }
      // 空令牌兜底：SnowLuma 允许无 token 连接（onebot_0.json 模板就是空）
      out.push({ wsToken: '', httpToken: '' });
    } catch (error) {
      log('[onebot] 读取 SnowLuma OneBot 配置失败:', errorMessage(error));
    }
    return out;
  }

  /** 候选游标：401 时递增轮换。连上后会钉住当前生效下标。 */
  let tokenCandidateIndex = 0;

  function applyTokens({ wsToken, httpToken }: TokenPair) {
    onebot.accessToken = wsToken;
    onebot.httpToken = httpToken || wsToken;
    const cur = getConfig();
    if (cur.snowluma?.accessToken !== wsToken || cur.snowluma?.httpAccessToken !== (httpToken || wsToken)) {
      updateConfig({ snowluma: { ...cur.snowluma, accessToken: wsToken, httpAccessToken: httpToken || wsToken } });
      log(`[onebot] 应用 OneBot 访问令牌（WS ${wsToken ? '有' : '无'} / HTTP ${httpToken ? '有' : '无'}）`);
    }
  }

  function sync() {
    try {
      const candidates = readCandidates();
      if (!candidates.length) return false;
      const sig = candidates.map((c) => `${c.wsToken}|${c.httpToken}`).join(';');
      if (sig === lastSyncTokenSig) return false;
      // 游标重置：候选集变化了，从头开始试
      tokenCandidateIndex = 0;
      applyTokens(candidates[0]);
      onebot.tokenCandidates = candidates;   // 401 轮换用
      lastSyncTokenSig = sig;
      log(`[onebot] 已收集 ${candidates.length} 个 OneBot 令牌候选（SnowLuma 多账号场景 401 时自动轮换）`);
      return true;
    } catch (error) {
      log('[onebot] 同步 SnowLuma 令牌失败:', errorMessage(error));
      return false;
    }
  }

  // 401 / 未连接时：轮换下一个候选 token 重连（3 秒重连循环已有，轮换成本为零）
  let tokenSyncRetryAt = 0;
  function maybeRecover() {
    const now = Date.now();
    if (now - tokenSyncRetryAt < 5000) return;   // 限频
    tokenSyncRetryAt = now;
    // ⚠️ 先重读磁盘：全新安装是"先启动后登录"，候选集是启动时的 [空令牌]；
    // 登录后 per-uin 文件才带着真令牌落盘。不回读就会拿空令牌 401 到天荒地老。
    const refreshed = sync();
    const candidates = onebot.tokenCandidates || [];
    if (!candidates.length) return;
    if (refreshed) {
      // 候选集变了（sig 变化时内部已重置游标并应用候选[0]）→ 直接拿新集合的第一个试
      onebot.reconnect();
      return;
    }
    // 磁盘没变化：指向下一个候选（首次触发也从 0→1 开始换：刚被 401 拒的就是当前这个）
    tokenCandidateIndex = (tokenCandidateIndex + 1) % candidates.length;
    const c = candidates[tokenCandidateIndex];
    applyTokens(c);
    onebot.reconnect();
  }

  function watch() {
    onebot.onStatus((status) => {
      if (status.connected) {
        // 连上了：钉住当前候选。下次 401（比如 SnowLuma 里切了账号）再从下一个开始轮
        const cands = onebot.tokenCandidates || [];
        if (cands.length > 1) log('[onebot] 连接成功，当前令牌候选已生效');
        return;
      }
      if (String(status.error || '').includes('401')) maybeRecover();
    });
  }

  return { sync, watch };
}
