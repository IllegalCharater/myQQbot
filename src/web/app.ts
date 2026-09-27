// 总装：OneBot 事件接入 → 存储 → 编排器；HTTP API + SSE 给 UI。
// Electron 主进程与 headless 服务器都从这里启动。
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getConfig, updateConfig } from '../core/config.js';
import type { AppConfig } from '../core/config.js';
import type { OneBotEvent } from '../qq/types.js';
import type { MediaEntry } from '../chat/types.js';
import { ROOT, UI_DIR } from '../core/paths.js';
import { OneBotClient, segmentsToText, extractMediaFromSegments, expandForwardNodes, forwardIdFromData } from '../qq/onebot.js';
import { ChatStore } from '../chat/store.js';
import { MemoryStore } from '../chat/memory.js';
import { StickerManager } from '../stickers/sticker-manager.js';
import { SendQueue } from '../qq/sender.js';
import { SessionRegistry } from '../chat/sessions.js';
import { Orchestrator } from '../agent/orchestrator.js';
import { estimateCost, cacheHitRate } from '../llm/llm.js';
import { initPriceFeed } from '../llm/price-feed.js';
import { createEventBus, todayKey } from '../core/util.js';
import { serveStatic } from './static-files.js';
import { dispatchRoute } from './router.js';
import { errorMessage, isRecord, writeReply } from './http.js';
import { routes } from './routes/index.js';
import { buildUsageBreakdown, buildUsageStats } from './usage-service.js';
import type { AppHandle, CreateAppOptions } from './types.js';

export type { AppHandle, CreateAppOptions } from './types.js';

interface TokenPair { wsToken: string; httpToken: string }
interface SnowlumaLog { at: number; stream: string; text: string }
type OneBotRuntime = OneBotClient & { tokenCandidates: TokenPair[] };

// 全局 fetch（undici）默认连接建立超时只有 10 秒，openrouter.ai 这类海外端点
// 握手慢时会直接报 "Connect Timeout Error ... timeout: 10000ms"（注意这不是
// 请求超时——那是 llm.js 里 180 秒的 AbortSignal）。这里放宽到 30 秒。
// 动态导入 + 容错：undici 与 Electron 内置 Node 不兼容时只退回默认超时，绝不崩主进程。
try {
  const { Agent, setGlobalDispatcher } = await import('undici');
  setGlobalDispatcher(new Agent({ connect: { timeout: 30_000 } }));
} catch (error) {
  console.warn('[net] 全局连接超时设置失败（使用 undici 默认值 10s）:', errorMessage(error));
}

// ── 白名单判断（移植自原版 allowed()） ───────────────────────────────────
function allowed(kind: 'group' | 'private', id: unknown, cfg: AppConfig) {
  const s = String(id);
  const key = kind === 'group' ? 'groups' : 'private';
  const denyList = cfg.deny?.[key] ?? [];
  if (denyList.map(String).includes(s)) return false;
  const allowList = cfg.allow?.[key] ?? [];
  if (allowList.length > 0) return allowList.map(String).includes(s);
  return cfg.allowAllWhenEmpty === true;
}

export function createApp({ log = console.log }: CreateAppOptions = {}): AppHandle {
  const cfg = getConfig();
  const bus = createEventBus();
  const sseClients = new Set<ServerResponse>();

  // ── SnowLuma 程序目录与进程管理 ──
  function snowlumaDir() {
    const configured = String(getConfig().snowluma?.dir || '').trim();
    if (configured) return configured;
    // Windows 不区分大小写，而 Linux 区分；兼容仓库当前的 snowLuma 目录和旧版 snowluma 目录。
    for (const name of ['snowLuma', 'snowluma']) {
      const bundled = path.join(ROOT, name);
      if (fs.existsSync(bundled)) return bundled;
      // 兼容已有安装版：asar 里的文件不可执行，协议端可能位于解包目录。
      const unpacked = bundled.replace('app.asar', 'app.asar.unpacked');
      if (unpacked !== bundled && fs.existsSync(unpacked)) return unpacked;
    }
    return '';
  }

  function snowlumaServicePort() {
    try {
      const dir = snowlumaDir();
      const runtimePath = dir && path.join(dir, 'config', 'runtime.json');
      if (runtimePath && fs.existsSync(runtimePath)) {
        const runtime = JSON.parse(fs.readFileSync(runtimePath, 'utf8'));
        const port = Number(runtime.webuiPort);
        if (Number.isInteger(port) && port > 0 && port <= 65535) return port;
      }
    } catch { /* ignore */ }
    return 5099;
  }

  /** 从 SnowLuma 的 runtime.json 读取 WebUI 地址（http(s)://host:port/）。拿不到就返回空串。 */
  function snowlumaWebuiUrl() {
    try {
      const dir = snowlumaDir();
      if (!dir) return '';
      const rtPath = path.join(dir, 'config', 'runtime.json');
      if (!fs.existsSync(rtPath)) return '';
      const rt = JSON.parse(fs.readFileSync(rtPath, 'utf8'));
      const host = String(rt.webuiHost || '127.0.0.1');
      const port = Number(rt.webuiPort) || 5099;
      const tls = !!(rt.webuiTls && rt.webuiTls.enabled);
      return `${tls ? 'https' : 'http'}://${host}:${port}/`;
    } catch {
      // 配置读不到时，从最近日志里找 "listening http(s)://…" 兜底
      for (const line of [...snowlumaLogs].reverse()) {
        const m = /listening\s+(https?:\/\/[\w.:-]+)/i.exec(line.text || '');
        if (m) return m[1];
      }
      return '';
    }
  }

  function isPortOpen(host: string, port: number, timeoutMs = 800): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      const done = (result: boolean) => { try { socket.destroy(); } catch { /* ignore */ } resolve(result); };
      socket.setTimeout(timeoutMs);
      socket.once('connect', () => done(true));
      socket.once('timeout', () => done(false));
      socket.once('error', () => done(false));
      socket.connect(port, host);
    });
  }

  // SnowLuma 内置控制台日志（环形缓冲，最近 500 行）
  // 内置 SnowLuma 状态与日志。未采用多进程方案：由 Electron 主进程提供 IPC 控制与日志转发，
  // 确保 SnowLuma 随 QQ Agent 退出、无需单独管理窗口。
  const snowlumaLogs: SnowlumaLog[] = [];
  let snowlumaProc: ChildProcess | null = null;
  let snowlumaProcessGroup = false;

  function pushSnowlumaLog(text: unknown, stream = 'stdout') {
    const line = { at: Date.now(), stream, text: String(text ?? '').replace(/\r?\n$/, '') };
    if (!line.text) return;
    snowlumaLogs.push(line);
    if (snowlumaLogs.length > 500) snowlumaLogs.splice(0, snowlumaLogs.length - 500);
    emit('snowluma-log', line);
  }

  function snowlumaStatus() {
    return { embedded: !!snowlumaProc, pid: snowlumaProc?.pid ?? null };
  }

  /** 关闭内置启动的 SnowLuma。返回是否执行了关闭动作。 */
  function stopSnowluma() {
    const proc = snowlumaProc;
    if (!proc) return false;
    try {
      // launcher.sh 可能再拉起子进程；Linux 下终止整个进程组，避免只关掉 shell 后 SnowLuma 残留。
      if (snowlumaProcessGroup && process.platform !== 'win32' && proc.pid) process.kill(-proc.pid, 'SIGTERM');
      else proc.kill();
      pushSnowlumaLog('已请求关闭 SnowLuma。', 'stdout');
    } catch (error) {
      pushSnowlumaLog(`关闭 SnowLuma 失败：${errorMessage(error)}`, 'stderr');
      throw error;
    }
    return true;
  }

  /** 拉起 SnowLuma。优先用项目内置 node.exe 直接运行；失败后按平台回退到 launcher.bat / launcher.sh。 */
  async function launchSnowluma() {
    const dir = snowlumaDir();
    if (!dir) return { ok: false, error: '找不到 SnowLuma 目录：请确认项目内 snowluma/ 文件夹存在，或在设置里填写 SnowLuma 目录' };
    const servicePort = snowlumaServicePort();
    if (await isPortOpen('127.0.0.1', servicePort)) {
      pushSnowlumaLog(`SnowLuma 已在运行（端口 ${servicePort} 已就绪），无需重复启动`, 'stdout');
      return { ok: true, alreadyRunning: true };
    }
    const indexMjs = path.join(dir, 'index.mjs');
    const nodeExe = path.join(dir, 'node.exe');
    if (fs.existsSync(indexMjs) && fs.existsSync(nodeExe)) {
      try {
        // 用 Windows 的 CREATE_NEW_PROCESS_GROUP + 独立进程方式启动，
        // 让 SnowLuma 真正独立于 Electron 主进程（Electron 退出时不会拖垮它）。
        const child = spawn(nodeExe, [indexMjs], {
          cwd: dir,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          detached: false
        });
        snowlumaProc = child;
        child.unref();
        pushSnowlumaLog(`SnowLuma 启动中（内置模式，pid=${child.pid}）…`, 'stdout');
        child.stdout.on('data', (d) => {
          for (const line of String(d).split(/\r?\n/)) {
            if (line.trim()) pushSnowlumaLog(line, 'stdout');
          }
        });
        child.stderr.on('data', (d) => {
          for (const line of String(d).split(/\r?\n/)) {
            if (line.trim()) pushSnowlumaLog(line, 'stderr');
          }
        });
        child.on('exit', (code, signal) => {
          snowlumaProc = null;
          pushSnowlumaLog(`SnowLuma 进程已退出（code=${code ?? ''} signal=${signal ?? ''}）`, 'stderr');
          emit('snowluma-status', { running: false, embedded: false, pid: null });
        });
        child.on('error', (error) => {
          pushSnowlumaLog(`SnowLuma 启动失败：${errorMessage(error)}`, 'stderr');
        });
        emit('snowluma-status', { running: true, embedded: true, pid: child.pid });
        return { ok: true, launched: true, embedded: true, pid: child.pid };
      } catch (error) {
        pushSnowlumaLog(`内置模式启动失败，尝试回退独立窗口：${errorMessage(error)}`, 'stderr');
        snowlumaProc = null;
      }
    }
    // 回退到发行包自带的启动脚本。Linux/macOS 通过 sh 执行，因此脚本无需预先设置可执行位。
    const isWindows = process.platform === 'win32';
    const launcherName = isWindows ? 'launcher.bat' : 'launcher.sh';
    const launcher = path.join(dir, launcherName);
    if (!fs.existsSync(launcher)) {
      return { ok: false, error: `目录里没有可用的 index.mjs / node.exe，也没有 ${launcherName}：${dir}` };
    }
    const child = spawn(isWindows ? 'cmd.exe' : '/bin/sh', isWindows ? ['/c', launcher] : [launcher], {
      cwd: dir,
      detached: true,
      stdio: isWindows ? 'ignore' : ['ignore', 'pipe', 'pipe'],
      windowsHide: isWindows ? false : undefined // Windows 保留 SnowLuma 自己的控制台窗口
    });

    // spawn 的 ENOENT 等错误是异步事件；等待 spawn 后再向管理页面报告启动成功。
    try {
      await new Promise((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
    } catch (error) {
      pushSnowlumaLog(`通过 ${launcherName} 启动失败：${errorMessage(error)}`, 'stderr');
      return { ok: false, error: `无法执行 ${launcherName}：${errorMessage(error)}` };
    }

    if (isWindows) {
      child.unref();
      pushSnowlumaLog(`SnowLuma 已通过 ${launcherName} 启动（此模式下日志不进内置控制台）`, 'stdout');
      return { ok: true, launched: true, embedded: false };
    }

    // Linux/macOS 下把脚本进程纳入管理页：转发日志、显示 PID，并允许“停止”按钮关闭进程组。
    snowlumaProc = child;
    snowlumaProcessGroup = true;
    pushSnowlumaLog(`SnowLuma 启动中（${launcherName}，pid=${child.pid}）…`, 'stdout');
    child.stdout?.on('data', (data) => {
      for (const line of String(data).split(/\r?\n/)) if (line.trim()) pushSnowlumaLog(line, 'stdout');
    });
    child.stderr?.on('data', (data) => {
      for (const line of String(data).split(/\r?\n/)) if (line.trim()) pushSnowlumaLog(line, 'stderr');
    });
    child.on('exit', (code, signal) => {
      if (snowlumaProc === child) {
        snowlumaProc = null;
        snowlumaProcessGroup = false;
      }
      pushSnowlumaLog(`SnowLuma 进程已退出（code=${code ?? ''} signal=${signal ?? ''}）`, code ? 'stderr' : 'stdout');
      emit('snowluma-status', { running: false, embedded: false, pid: null });
    });
    emit('snowluma-status', { running: true, embedded: true, pid: child.pid });
    return { ok: true, launched: true, embedded: true, pid: child.pid };
  }

  const emit = (type: string, payload: unknown) => {
    bus.emit(type, payload);
    let line = null;
    if (type === 'session-update' && isRecord(payload) && payload.sessionId) {
      try {
        // peek：只序列化、不修改，不需要 get() 那份全量 structuredClone
        // （运行中的会话每次更新都广播，克隆大会话会拖慢事件投递）
        const s = sessions?.peek(String(payload.sessionId));
        if (s) {
          line = `event: ${type}\ndata: ${JSON.stringify({
            sessionId: s.id,
            chatKey: s.chatKey,
            startedAt: s.startedAt,
            status: s.status,
            waitUntil: s.waitUntil ?? null,
            activity: s.activity ?? '',
            webSearchCount: s.webSearchCount ?? 0,
            rounds: s.rounds ?? 0,
            usage: s.usage ?? null,
            trigger: s.triggerSummary ?? '',
            triggerSummary: s.triggerSummary ?? '',
            messages: s.messages ?? [],
            // sent/finishReason/error/endedAt 必须随 SSE 推下去：
            // 曾经载荷里没有它们，"已发送到 QQ"徽标只能等 HTTP 轮询带回来；
            // 而会话一结束轮询就不再拉详情（只刷 running/waiting），
            // 用户只能手动刷新才看得到最终发言 —— 这就是"详情更新不及时"。
            sent: s.sent ?? [],
            finishReason: s.finishReason ?? null,
            error: s.error ?? null,
            endedAt: s.endedAt ?? null
          })}\n\n`;
        }
      } catch { /* 失败就退回原 payload */ }
    }
    if (!line) line = `event: ${type}\ndata: ${JSON.stringify(payload ?? {})}\n\n`;
    for (const res of sseClients) {
      try { res.write(line); } catch { /* 客户端断开会由 close 清理 */ }
    }
  };

  // ── 组件 ──
  const store = new ChatStore(cfg.store?.maxMessagesPerChat ?? 0);   // 0 = 不限
  const memory = new MemoryStore();
  const sessions = new SessionRegistry(cfg.store?.keepSessionFiles ?? 0);   // 0 = 不限
  const onebot = new OneBotClient({
    wsUrl: cfg.snowluma?.wsUrl,
    httpUrl: cfg.snowluma?.httpUrl,
    accessToken: cfg.snowluma?.accessToken,
    httpToken: cfg.snowluma?.httpAccessToken || cfg.snowluma?.accessToken,
    onEvent: (event) => handleOneBotEvent(event).catch((error) => log('[ingest] 处理事件出错:', errorMessage(error)))
  }) as OneBotRuntime;
  onebot.tokenCandidates = [];
  // onChange：bot 自己改库（收藏/改备注/发过）时也让面板那页刷新 —— 否则用户正看着
  // 表情页，模型在群里偷偷收藏了一张，页面不会动。
  const stickers = new StickerManager(onebot, { onChange: () => emit('sticker-update', {}) });
  const sender = new SendQueue({
    onebot, store,
    onSent: ({ chatKey, text }) => log(`[发送 -> ${chatKey}] ${String(text).slice(0, 60)}`)
  });
  const orchestrator = new Orchestrator({ store, memory, stickers, sender, sessions, onebot, emit });

  // 远程价格表：启动即初始化（内部幂等；URL 为空则完全不动）
  initPriceFeed(cfg.api?.priceRemoteUrl || '');

  // OneBot 连接状态推送
  onebot.onStatus((status) => emit('onebot-status', status));

  // ── 从 SnowLuma 配置自动同步 OneBot 令牌 ──
  // SnowLuma 给每个登录过的账号生成独立随机 token（config/onebot_<uin>.json），
  // 且**永久保留**——不表示"当前在线"。多账号场景下"取第一个文件"会拿错 token
  // （WS 401 无限重试）。策略改为：收集所有 per-uin 文件的 token 作为候选，
  // 401 时轮换下一个重连，连上后记住生效的那个（天然支持 SnowLuma 里切账号）。
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
  function readSnowlumaTokenCandidates() {
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

  /** 把候选列表同步进配置 + 挂到 onebot 实例（不立即连接）。返回是否有变化。 */
  function syncSnowlumaTokens() {
    try {
      const candidates = readSnowlumaTokenCandidates();
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
  function maybeRecoverOnebot() {
    const now = Date.now();
    if (now - tokenSyncRetryAt < 5000) return;   // 限频
    tokenSyncRetryAt = now;
    // ⚠️ 先重读磁盘：全新安装是"先启动后登录"，候选集是启动时的 [空令牌]；
    // 登录后 per-uin 文件才带着真令牌落盘。不回读就会拿空令牌 401 到天荒地老。
    const refreshed = syncSnowlumaTokens();
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
  onebot.onStatus((status) => {
    if (status.connected) {
      // 连上了：钉住当前候选。下次 401（比如 SnowLuma 里切了账号）再从下一个开始轮
      const cands = onebot.tokenCandidates || [];
      if (cands.length > 1) log('[onebot] 连接成功，当前令牌候选已生效');
      return;
    }
    if (String(status.error || '').includes('401')) maybeRecoverOnebot();
  });

  // ── 入站事件处理 ──
  const atNameCache = new Map<string, string>(); // groupId:userId -> name
  async function resolveAtName(groupId: unknown, userId: unknown): Promise<string | null> {
    const key = `${groupId}:${userId}`;
    if (atNameCache.has(key)) return atNameCache.get(key) ?? null;
    try {
      const info = await onebot.getGroupMemberInfo(groupId, userId);
      const name = isRecord(info) ? info.card || info.nickname || null : null;
      if (name) {
        atNameCache.set(key, String(name));
        if (atNameCache.size > 500) atNameCache.clear(); // 简单防膨胀
        return String(name);
      }
    } catch { /* ignore */ }
    return null;
  }

  // 引用预览的长度上限。原先是 120：卡片解析出的文本最长 300，被截到 120 会丢内容。
  const REPLY_PREVIEW_MAX = 300;

  /**
   * 解析被引用消息的原文。
   * ctx 传当前会话的 kind/id：QQ 里引用只可能发生在同一个会话内，所以被引用消息里的
   * @ 就是本群成员，能正常解析成群名片（与主消息路径的行为保持一致）。
   */
  async function resolveReply(messageId: unknown, { kind = '', id = '' }: { kind?: string; id?: string } = {}) {
    try {
      const msg = await onebot.getMsg(messageId);
      const sender = isRecord(msg) && isRecord(msg.sender) ? msg.sender : {};
      const senderName = sender.card || sender.nickname || '';
      let text = '';
      if (isRecord(msg) && Array.isArray(msg.message)) {
        // 必须复用 segmentsToText，不能自己拼。被引用的消息可能是 json 卡片 /
        // 合并转发 / 图片，自己拼只会得到 "[json]" "[forward]" 这类原始英文段名，
        // 模型完全读不懂 —— 曾经这里就是这样把"引用了一张卡片"变成四个无用字符。
        // includeReply:false：引用里再套引用只展开一层，防递归。
        // 注意这里不展开合并转发（只留占位符），展开是模型用 read_forward 主动做的事。
        text = await segmentsToText(msg.message, {
          includeReply: false,
          resolveAtName: (qq) => (kind === 'group' ? resolveAtName(id, qq) : Promise.resolve(null))
        });
      } else if (isRecord(msg) && typeof msg.message === 'string') {
        text = msg.message;
      }
      return { sender: String(senderName), text: String(text).slice(0, REPLY_PREVIEW_MAX) };
    } catch {
      return null;
    }
  }

  async function ingestMessage(kind: 'group' | 'private', id: string, event: OneBotEvent) {
    const cfgNow = getConfig();
    if (!allowed(kind, id, cfgNow)) return; // 白名单外的聊天完全不记录

    const segments = Array.isArray(event.message) ? event.message : null;
    const eventSender = isRecord(event.sender) ? event.sender : {};
    const senderId = String(eventSender.user_id ?? event.user_id ?? '');
    const senderName = String(eventSender.card || eventSender.nickname || senderId || '');

    // 屏蔽名单：被屏蔽群员的消息直接丢弃 —— 不存档、不触发会话、不进提示词背景。
    // 放在最前面：连合并转发展开这种网络请求都不值得为它做。
    const blocklist = cfgNow.blocklist as Record<string, unknown[]>;
    if (kind === 'group' && senderId && (blocklist[id] || []).map(String).includes(senderId)) return;
    const media: MediaEntry[] = (segments ? extractMediaFromSegments(segments) : [])
      .filter((item): item is Record<string, unknown> & { kind: string } => typeof item.kind === 'string')
      .map((item) => ({ ...item, kind: item.kind }));

    let text;
    if (segments) {
      text = await segmentsToText(segments, {
        resolveReply: (mid) => resolveReply(mid, { kind, id }),
        resolveAtName: (qq) => kind === 'group' ? resolveAtName(id, qq) : Promise.resolve(null)
      });
    } else {
      text = String(event.raw_message ?? event.message ?? '').trim();
    }

    // 合并转发：占位符 → 展开真实内容（模型要读懂、看懂转发的聊天记录）
    // 用转发段自带的 res_id 展开 —— 实测（2026-09-22，SnowLuma）get_forward_msg 认 res_id、
    // 不认 message_id（传后者报 retcode=100 "download forward message payload is empty"）。
    // 旧注释把结论记反成"只认 message_id、res_id 会过期"，照它写的这行代码从来没成功过：
    // 每条收到的合并转发都只留下占位符，正文永远进不了存档。
    // 媒体里的 url 此时是新鲜的，一并收进 media（模型看图/存档页展示都能用）。
    // 展开失败时占位符留在存档里，模型可用 read_forward 工具稍后重试。
    const fwdSeg = segments ? segments.find((s) => s?.type === 'forward') : null;
    if (fwdSeg || text.includes('[合并转发') || text.includes('[转发消息')) {
      try {
        const nodes = await onebot.getForwardNodes({
          resId: forwardIdFromData(fwdSeg?.data ?? {}),
          messageId: event.message_id
        });
        const ex = await expandForwardNodes(nodes);
        if (ex && ex.text) {
          text = ex.text;
          if (ex.media?.length) {
            media.push(...ex.media
              .filter((item): item is Record<string, unknown> & { kind: string } => typeof item.kind === 'string')
              .map((item) => ({ ...item, kind: item.kind })));
          }
        }
      } catch (e) {
        log(`[ingest] 展开合并转发失败（保留占位符）: ${errorMessage(e)}`);
      }
    }

    if (!text && !media.length) return;
    // 条目要**当面交给**编排器（onIncoming 的第二个参数）：上下文窗口的入窗入口
    // 只有它一个，少传一次窗口与存档就会静默分叉（那条消息永远不会被回应）。
    const entry = store.appendIncoming(`${kind}:${id}`, {
      mid: typeof event.message_id === 'string' || typeof event.message_id === 'number' ? event.message_id : null,
      ts: event.time ? Math.round(Number(event.time) * 1000) : Date.now(),
      senderId,
      senderName,
      text: text || '[图片]' ,
      media
    });
    emit('chat-update', `${kind}:${id}`);
    orchestrator.onIncoming(`${kind}:${id}`, entry);
  }

  async function ingestPoke(event: OneBotEvent) {
    // OneBot v11: notice_type=notify, sub_type=poke；群拍 target_id，私聊拍自己
    const isGroup = event.group_id != null;
    const id = isGroup ? String(event.group_id) : String(event.user_id);
    const cfgNow = getConfig();
    if (!allowed(isGroup ? 'group' : 'private', id, cfgNow)) return;

    const operatorId = String(event.user_id ?? '');
    // 自己拍的拍（send_poke 的 OneBot 回显）不触发处理——与 message_sent 同理，发送时已留档
    if (operatorId && operatorId === onebot.selfId) return;
    // 屏蔽名单对拍一拍同样生效（操作者是被屏蔽群员则丢弃）
    const blocklist = cfgNow.blocklist as Record<string, unknown[]>;
    if (isGroup && operatorId && (blocklist[id] || []).map(String).includes(operatorId)) return;
    const targetId = String(event.target_id ?? event.user_id ?? '');
    const selfId = onebot.selfId;
    // 拍一拍也要记下真实群名片：原先这里硬编码"（拍一拍事件）"，
    // 会覆盖同一 QQ 在普通消息里的真实昵称 —— 记忆整理时取名字会拿到这个占位符，
    // 导致"317183522 的名字叫（拍一拍事件）"这种脏数据。
    const chatKeyNow = `${isGroup ? 'group' : 'private'}:${id}`;
    let operatorName = isGroup ? ((await resolveAtName(id, operatorId)) || '') : '';
    if (!operatorName) {
      const prior = (store.recent(chatKeyNow, { limit: 500 }) || [])
        .find((m) => !m.self && String(m.senderId) === operatorId
          && String(m.senderName || '') && String(m.senderName) !== '（拍一拍事件）');
      operatorName = prior ? String(prior.senderName) : operatorId;
    }
    let text;
    if (String(targetId) === String(selfId)) {
      text = `[拍一拍] 你拍了拍${isGroup ? '' : '你'}（来自 ${operatorName}）`;
    } else {
      const targetName = isGroup ? (await resolveAtName(id, targetId)) || targetId : targetId;
      text = operatorId === targetId ? `[拍一拍] ${operatorName} 拍了拍自己` : `[拍一拍] ${operatorName} 拍了拍 ${targetName}`;
    }
    const entry = store.appendIncoming(chatKeyNow, {
      mid: null,
      ts: event.time ? Math.round(Number(event.time) * 1000) : Date.now(),
      senderId: operatorId,
      senderName: operatorName,
      text,
      media: []
    });
    emit('chat-update', chatKeyNow);
    orchestrator.onIncoming(chatKeyNow, entry);
  }

  async function handleOneBotEvent(event: OneBotEvent) {
    if (!event || typeof event !== 'object') return;
    if (event.post_type === 'message' || event.post_type === 'message_sent') {
      // 自己发的消息（message_sent / self_id 相同）不触发处理（发送时已自行记录）
      const sender = isRecord(event.sender) ? event.sender : {};
      if (String(event.user_id ?? sender.user_id ?? '') === onebot.selfId) return;
      if (event.message_type === 'group' && event.group_id != null) return ingestMessage('group', String(event.group_id), event);
      if (event.message_type === 'private' && event.user_id != null) return ingestMessage('private', String(event.user_id), event);
      return;
    }
    if (event.post_type === 'notice' && event.notice_type === 'notify' && event.sub_type === 'poke') {
      return ingestPoke(event);
    }
    // meta/心跳等事件忽略
  }

  // ── HTTP API ──
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

  function applyConfigPatch(patch: unknown) {
    const next = updateConfig(patch as Record<string, unknown>);
    store.setMaxPerChat(next.store?.maxMessagesPerChat ?? 0);
    if (next.proactive?.enabled) orchestrator.startProactiveLoop(); else orchestrator.stopProactiveLoop();
    if (next.compact?.enabled) orchestrator.startCompactLoop(); else orchestrator.stopCompactLoop();
    initPriceFeed(next.api?.priceRemoteUrl || '');
    emit('status', { configUpdated: true });
    return next;
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
        dir: snowlumaDir(),
        running: await isPortOpen('127.0.0.1', snowlumaServicePort()),
        webuiUrl: snowlumaWebuiUrl(),
        ...snowlumaStatus()
      },
      orchestrator: orchestrator.statusSummary(), usage,
      cost: estimateCost(usage, { model: current.api?.model }),
      cacheHitRate: cacheHitRate(usage),
      webSearchCount: usage.webSearchCount || 0,
      paused: orchestrator.paused,
      pauseReason: orchestrator.pauseReason ?? null
    };
  }

  function openSnowlumaFolder() {
    const dir = snowlumaDir();
    if (!dir) return { status: 400, body: { ok: false, error: '找不到 SnowLuma 目录' } };
    spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref();
    return { status: 200, body: { ok: true } };
  }

  function openSnowlumaWebui() {
    const webuiUrl = snowlumaWebuiUrl();
    if (!webuiUrl) return { status: 400, body: { ok: false, error: '没有找到 SnowLuma WebUI 地址（等日志出现 listening 后再试）' } };
    spawn('cmd.exe', ['/c', 'start', '', webuiUrl], { detached: true, stdio: 'ignore' }).unref();
    return { status: 200, body: { ok: true, webuiUrl } };
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
        store, memory, sessions, onebot, sender, stickers, orchestrator, emit,
        getConfig, updateConfig, launchSnowluma, stopSnowluma, snowlumaStatus,
        buildUsageStats, buildUsageBreakdown, sanitizeConfig, applyConfigPatch,
        buildStatus, getSnowlumaLogs: () => snowlumaLogs.slice(-200),
        openSnowlumaFolder, openSnowlumaWebui
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

  // ── 启停 ──
  // DSH 自动导入已移除：模型目录改为在设置页手动维护（见 /api/providers 相关接口）。

  // ── 启停 ──
  async function listenOn(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        resolve(port); // 必须把实际端口传回去，Electron 壳要用它加载页面
      });
    });
  }

  async function start() {
    // 先把 HTTP 服务拉起来，让窗口/浏览器立刻能加载页面（loading 壳）
    const basePort = Number(getConfig().server?.port) || 3210;
    let port = null;
    let lastError = null;
    for (let p = basePort; p < basePort + 10; p++) {
      try {
        port = await listenOn(p);
        break;
      } catch (error) {
        lastError = error;
        if (!isRecord(error) || error.code !== 'EADDRINUSE') throw error;
      }
    }
    if (port == null) throw lastError ?? new Error('无法监听端口');

    // 拉起 SnowLuma（如配置了自动启动）、连 OneBot。
    if (getConfig().snowluma?.autoLaunch) {
      try {
        const servicePort = snowlumaServicePort();
        if (!(await isPortOpen('127.0.0.1', servicePort))) {
          const r = await launchSnowluma();
          if (r.ok && r.launched) {
            for (let i = 0; i < 20 && !(await isPortOpen('127.0.0.1', servicePort)); i++) {
              await new Promise((resolve) => setTimeout(resolve, 1000));
            }
          }
        }
      } catch (error) {
        log('[snowluma] 自动启动失败:', errorMessage(error));
      }
    }
    // OneBot 连接前先尝试从 SnowLuma 配置同步令牌（脱敏副本/首次登录场景尤其重要）
    if (syncSnowlumaTokens()) {
      const c = getConfig();
      onebot.wsUrl = String(c.snowluma?.wsUrl || onebot.wsUrl);
      onebot.httpUrl = String(c.snowluma?.httpUrl || onebot.httpUrl).replace(/\/+$/, '');
      // accessToken/httpToken 已由 applyTokens 直接挂到实例（候选[0]）
    }
    await onebot.connect();
    if (getConfig().proactive?.enabled) orchestrator.startProactiveLoop();
    // 压缩巡检：启动时按当前开关决定是否拉起（默认关，会在 60s 后才第一次巡检）
    if (getConfig().compact?.enabled) orchestrator.startCompactLoop(); else orchestrator.stopCompactLoop();
    log(`控制台已就绪：http://127.0.0.1:${port}`);
    log(`OneBot（SnowLuma）: ws=${getConfig().snowluma?.wsUrl} http=${getConfig().snowluma?.httpUrl}`);
    log(`模型: ${getConfig().api.model || '（未设置，请在设置里选择）'} @ ${getConfig().api.baseUrl}`);
    return port;
  }

  async function stop() {
    await orchestrator.abortAll();
    onebot.close();
    server.close();
    // 内置启动的 SnowLuma：QQ Agent 退出时一并关掉，避免留一个无窗口的后台进程。
    // 注意：SnowLuma 退出时不一定能立刻把 config 落盘，但我们的 stop 不会再去读它，
    // 下次启动会读到完整文件。
    try { stopSnowluma(); } catch { /* ignore */ }
  }

  return { server, onebot, store, memory, stickers, sender, sessions, orchestrator, start, stop, emit, getConfig, updateConfig, launchSnowluma, stopSnowluma, snowlumaStatus };
}
