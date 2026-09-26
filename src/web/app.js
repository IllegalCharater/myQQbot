// 总装：OneBot 事件接入 → 存储 → 编排器；HTTP API + SSE 给 UI。
// Electron 主进程与 headless 服务器都从这里启动。
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { getConfig, updateConfig } from '../core/config.js';
import { ROOT, DATA_DIR, UI_DIR } from '../core/paths.js';
import { customSearch } from '../media/web-search.js';
import { OneBotClient, segmentsToText, extractMediaFromSegments, expandForwardNodes, forwardIdFromData } from '../qq/onebot.js';
import { ChatStore } from '../chat/store.js';
import { MemoryStore } from '../chat/memory.js';
import { StickerManager } from '../stickers/sticker-manager.js';
import { validateImageUrl, safeFetchBinary } from '../media/safe-fetch.js';
import { detectMime } from '../agent/tools.js';
import { cachedPath } from '../stickers/sticker-cache.js';
import { SendQueue } from '../qq/sender.js';
import { SessionRegistry } from '../chat/sessions.js';
import { Orchestrator } from '../agent/orchestrator.js';
// 历史摘要的注入结果：面板顶部那块要显示"模型实际看到的"，就必须和提示词走同一个函数。
// prompt.js 只依赖 config/util/stickers/tier-slider，引它不会成环。
import { collectInjectedDigests } from '../agent/prompt.js';
import { listModels, chatCompletion, resolveApiKey, estimateCost, cacheHitRate } from '../llm/llm.js';
import { resolveOfficialPrice, listOfficialPrices, isPeakHour, priceAt, resolveModelPrice, modelLabel, splitModelLabel, UNKNOWN_VENDOR } from '../llm/model-prices.js';
import { initPriceFeed, refreshPriceFeed, priceFeedStatus } from '../llm/price-feed.js';
import { importFromDsh, currentProviders, setProviderKey, testAllProviders, testOneProvider, testModelChat, fetchModelsFrom, upsertProvider, addModelsToProvider, removeModelFromProvider } from '../llm/providers.js';
import { scanModelsVision, visionResults, modelImageVerdict } from '../llm/vision-scan.js';
import { builtinVisionResults } from '../llm/model-vision-docs.js';
import { createEventBus, todayKey } from '../core/util.js';
import { serveStatic } from './static-files.js';
import { dispatchRoute } from './router.js';
import { writeReply } from './http.js';
import { routes } from './routes/index.js';

// 全局 fetch（undici）默认连接建立超时只有 10 秒，openrouter.ai 这类海外端点
// 握手慢时会直接报 "Connect Timeout Error ... timeout: 10000ms"（注意这不是
// 请求超时——那是 llm.js 里 180 秒的 AbortSignal）。这里放宽到 30 秒。
// 动态导入 + 容错：undici 与 Electron 内置 Node 不兼容时只退回默认超时，绝不崩主进程。
try {
  const { Agent, setGlobalDispatcher } = await import('undici');
  setGlobalDispatcher(new Agent({ connect: { timeout: 30_000 } }));
} catch (error) {
  console.warn('[net] 全局连接超时设置失败（使用 undici 默认值 10s）:', error?.message ?? error);
}

// ── 白名单判断（移植自原版 allowed()） ───────────────────────────────────
function allowed(kind, id, cfg) {
  const s = String(id);
  const denyList = cfg.deny?.[kind] ?? cfg.deny?.[`${kind}s`] ?? [];
  if (denyList.map(String).includes(s)) return false;
  const allowList = cfg.allow?.[kind] ?? cfg.allow?.[`${kind}s`] ?? [];
  if (allowList.length > 0) return allowList.map(String).includes(s);
  return cfg.allowAllWhenEmpty === true;
}

// ── 版本信息 ─────────────────────────────────────────────────────────
// 只读本机 package.json，不做任何联网检查。
function localVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    return String(pkg.version || '0.0.0');
  } catch { return '0.0.0'; }
}

export function createApp({ log = console.log } = {}) {
  const cfg = getConfig();
  const bus = createEventBus();
  const sseClients = new Set();

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

  function isPortOpen(host, port, timeoutMs = 800) {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      const done = (result) => { try { socket.destroy(); } catch { /* ignore */ } resolve(result); };
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
  const snowlumaLogs = [];
  let snowlumaProc = null;
  let snowlumaProcessGroup = false;
  let snowlumaStopping = false;

  function pushSnowlumaLog(text, stream = 'stdout') {
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
      pushSnowlumaLog(`关闭 SnowLuma 失败：${error?.message ?? error}`, 'stderr');
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
          pushSnowlumaLog(`SnowLuma 启动失败：${error?.message ?? error}`, 'stderr');
        });
        emit('snowluma-status', { running: true, embedded: true, pid: child.pid });
        return { ok: true, launched: true, embedded: true, pid: child.pid };
      } catch (error) {
        pushSnowlumaLog(`内置模式启动失败，尝试回退独立窗口：${error?.message ?? error}`, 'stderr');
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
      pushSnowlumaLog(`通过 ${launcherName} 启动失败：${error?.message ?? error}`, 'stderr');
      return { ok: false, error: `无法执行 ${launcherName}：${error?.message ?? error}` };
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

  const emit = (type, payload) => {
    bus.emit(type, payload);
    let line = null;
    if (type === 'session-update' && payload?.sessionId) {
      try {
        // peek：只序列化、不修改，不需要 get() 那份全量 structuredClone
        // （运行中的会话每次更新都广播，克隆大会话会拖慢事件投递）
        const s = sessions?.peek(payload.sessionId);
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
  const visionScan = { running: false };   // 模型图片输入能力扫描的运行状态
  const store = new ChatStore(cfg.store?.maxMessagesPerChat ?? 0);   // 0 = 不限
  const memory = new MemoryStore();
  const sessions = new SessionRegistry(cfg.store?.keepSessionFiles ?? 0);   // 0 = 不限
  const onebot = new OneBotClient({
    wsUrl: cfg.snowluma?.wsUrl,
    httpUrl: cfg.snowluma?.httpUrl,
    accessToken: cfg.snowluma?.accessToken,
    httpToken: cfg.snowluma?.httpAccessToken || cfg.snowluma?.accessToken,
    onEvent: (event) => handleOneBotEvent(event).catch((error) => log('[ingest] 处理事件出错:', error?.message ?? error))
  });
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
  function extractTokens(data) {
    const http = (data?.networks?.httpServers || []).find((s) => (s.port === 3000) || (s.name === 'http-default')) || (data?.networks?.httpServers || [])[0];
    const ws = (data?.networks?.wsServers || []).find((s) => (s.port === 3001) || (s.name === 'ws-default')) || (data?.networks?.wsServers || [])[0];
    return { wsToken: String(ws?.accessToken ?? ''), httpToken: String(http?.accessToken ?? '') };
  }

  /** 收集所有候选 token（含 onebot_0.json 的空令牌兜底），按"当前配置优先"排序。 */
  function readSnowlumaTokenCandidates() {
    const out = [];
    try {
      const dir = snowlumaDir();
      if (!dir) return out;
      const cfgDir = path.join(dir, 'config');
      let files = [];
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
      log('[onebot] 读取 SnowLuma OneBot 配置失败:', error?.message ?? error);
    }
    return out;
  }

  /** 候选游标：401 时递增轮换。连上后会钉住当前生效下标。 */
  let tokenCandidateIndex = 0;

  function applyTokens({ wsToken, httpToken }) {
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
      log('[onebot] 同步 SnowLuma 令牌失败:', error?.message ?? error);
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
  let atNameCache = new Map(); // groupId:userId -> name
  async function resolveAtName(groupId, userId) {
    const key = `${groupId}:${userId}`;
    if (atNameCache.has(key)) return atNameCache.get(key);
    try {
      const info = await onebot.getGroupMemberInfo(groupId, userId);
      const name = info?.card || info?.nickname || null;
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
  async function resolveReply(messageId, { kind = '', id = '' } = {}) {
    try {
      const msg = await onebot.getMsg(messageId);
      const senderName = msg?.sender?.card || msg?.sender?.nickname || '';
      let text = '';
      if (Array.isArray(msg?.message)) {
        // 必须复用 segmentsToText，不能自己拼。被引用的消息可能是 json 卡片 /
        // 合并转发 / 图片，自己拼只会得到 "[json]" "[forward]" 这类原始英文段名，
        // 模型完全读不懂 —— 曾经这里就是这样把"引用了一张卡片"变成四个无用字符。
        // includeReply:false：引用里再套引用只展开一层，防递归。
        // 注意这里不展开合并转发（只留占位符），展开是模型用 read_forward 主动做的事。
        text = await segmentsToText(msg.message, {
          includeReply: false,
          resolveAtName: (qq) => (kind === 'group' ? resolveAtName(id, qq) : null)
        });
      } else if (typeof msg?.message === 'string') {
        text = msg.message;
      }
      return { sender: String(senderName), text: String(text).slice(0, REPLY_PREVIEW_MAX) };
    } catch {
      return null;
    }
  }

  async function ingestMessage(kind, id, event) {
    const cfgNow = getConfig();
    if (!allowed(kind, id, cfgNow)) return; // 白名单外的聊天完全不记录

    const segments = Array.isArray(event.message) ? event.message : null;
    const senderId = String(event.sender?.user_id ?? event.user_id ?? '');
    const senderName = String(event.sender?.card || event.sender?.nickname || senderId || '');

    // 屏蔽名单：被屏蔽群员的消息直接丢弃 —— 不存档、不触发会话、不进提示词背景。
    // 放在最前面：连合并转发展开这种网络请求都不值得为它做。
    if (kind === 'group' && senderId && (cfgNow.blocklist?.[id] || []).map(String).includes(senderId)) return;
    const media = segments ? extractMediaFromSegments(segments) : [];

    let text;
    if (segments) {
      text = await segmentsToText(segments, {
        resolveReply: (mid) => resolveReply(mid, { kind, id }),
        resolveAtName: (qq) => kind === 'group' ? resolveAtName(id, qq) : null
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
          if (ex.media?.length) media.push(...ex.media);
        }
      } catch (e) {
        log(`[ingest] 展开合并转发失败（保留占位符）: ${e?.message ?? e}`);
      }
    }

    if (!text && !media.length) return;
    // 条目要**当面交给**编排器（onIncoming 的第二个参数）：上下文窗口的入窗入口
    // 只有它一个，少传一次窗口与存档就会静默分叉（那条消息永远不会被回应）。
    const entry = store.appendIncoming(`${kind}:${id}`, {
      mid: event.message_id,
      ts: event.time ? Math.round(Number(event.time) * 1000) : Date.now(),
      senderId,
      senderName,
      text: text || '[图片]' ,
      media
    });
    emit('chat-update', `${kind}:${id}`);
    orchestrator.onIncoming(`${kind}:${id}`, entry);
  }

  async function ingestPoke(event) {
    // OneBot v11: notice_type=notify, sub_type=poke；群拍 target_id，私聊拍自己
    const isGroup = event.group_id != null;
    const id = isGroup ? String(event.group_id) : String(event.user_id);
    const cfgNow = getConfig();
    if (!allowed(isGroup ? 'group' : 'private', id, cfgNow)) return;

    const operatorId = String(event.user_id ?? '');
    // 自己拍的拍（send_poke 的 OneBot 回显）不触发处理——与 message_sent 同理，发送时已留档
    if (operatorId && operatorId === onebot.selfId) return;
    // 屏蔽名单对拍一拍同样生效（操作者是被屏蔽群员则丢弃）
    if (isGroup && operatorId && (cfgNow.blocklist?.[id] || []).map(String).includes(operatorId)) return;
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

  async function handleOneBotEvent(event) {
    if (!event || typeof event !== 'object') return;
    if (event.post_type === 'message' || event.post_type === 'message_sent') {
      // 自己发的消息（message_sent / self_id 相同）不触发处理（发送时已自行记录）
      if (String(event.user_id ?? event.sender?.user_id ?? '') === onebot.selfId) return;
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
      log('[http] 处理出错:', error?.message ?? error);
      try {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(error?.message ?? error) }));
      } catch { /* ignore */ }
    });
  });

  function json(res, code, data) {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(data));
  }

  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) throw new Error('请求体过大');
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    return text ? JSON.parse(text) : {};
  }

  function authorize(req) {
    const token = String(getConfig().server?.token ?? '');
    if (!token) return true;
    const url = new URL(req.url, 'http://127.0.0.1');
    return req.headers['x-console-token'] === token || url.searchParams.get('token') === token;
  }

  // ── 配置脱敏 ────────────────────────────────────────────────────────────
  // 凡是字段名命中这些模式的，值一律替换为空串（保留"有/无"的 hasXxx 标记）。
  // 覆盖：apiKey / api_key / accessToken / httpAccessToken / token / secret / password …
  const SECRET_KEY_PATTERN = /(apikey|api_key|accesstoken|access_token|secret|password|privatekey|private_key)/i;
  // 形如 apiKeyFrom 的字段存的是"密钥来源标识"（如 manual），不是密钥本身，不要脱敏
  const SECRET_KEY_EXCLUDE = /from$/i;

  function sanitizeConfig(cfg) {
    const out = JSON.parse(JSON.stringify(cfg ?? {}));
    const seen = new WeakSet();

    const walk = (node) => {
      if (!node || typeof node !== 'object' || seen.has(node)) return;
      seen.add(node);
      for (const key of Object.keys(node)) {
        const value = node[key];
        if (value && typeof value === 'object') { walk(value); continue; }
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
    if (out.dshProviderKeys && typeof out.dshProviderKeys === 'object') {
      const has = {};
      for (const [k, v] of Object.entries(out.dshProviderKeys)) has[k] = Boolean(String(v ?? '').trim());
      out.dshProviderKeys = {};
      out.dshProviderKeyPresence = has;
    }

    // 提供商列表：删掉 key 字段（同样不能置空串，否则回传时覆盖真实 Key），补 hasKey
    if (Array.isArray(out.providers)) {
      for (const p of out.providers) {
        const real = (cfg?.dshProviderKeys || {})[p.id] || p.apiKey;
        delete p.apiKey;
        p.hasKey = Boolean(String(real ?? '').trim());
      }
    }
    // 顶层 api：walk 已生成 hasApiKey，这里补一个简写的 hasKey 供旧代码读取
    if (out.api) out.api.hasKey = out.api.hasApiKey ?? Boolean(String(cfg?.api?.apiKey ?? '').trim());

    return out;
  }

  // ── 明文密钥端点守卫 ────────────────────────────────────────────────────
  /**
   * 这是本地单机程序，控制台就在本机浏览器打开，「显示密钥」是用户自己的操作，
   * 不该被禁用。真正的风险来自**外部网页**冒用浏览器读 127.0.0.1（CSRF /
   * DNS rebinding）—— 所以防线应当是「校验请求来源」，而不是砍掉本地功能。
   *
   * 放行条件（任一）：
   *   1. 配置了 server.token 且请求带上了它（远程/多用户场景）
   *   2. 请求来自本机控制台：Origin/Referer 指向本服务，或带 x-console-token 头
   */
  function keyEndpointAllowed(req) {
    const token = String(getConfig().server?.token ?? '');
    if (token) {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.headers['x-console-token'] === token || url.searchParams.get('token') === token) return true;
    }
    // 带自定义头 → 不可能是简单跨站请求（需 CORS 预检通过才能发出），放行
    if (req.headers['x-console-token']) return true;

    const host = String(req.headers.host ?? '');
    const origin = String(req.headers.origin ?? '');
    const referer = String(req.headers.referer ?? '');
    const isLoopbackHost = /^127\.0\.0\.1:\d+$/.test(host) || /^localhost:\d+$/.test(host);
    if (!isLoopbackHost) return false;
    if (origin) return origin === `http://${host}`;
    if (referer) return referer.startsWith(`http://${host}/`);
    return true;   // 地址栏直连等无来源请求，无法进一步区分
  }

  /**
   * 提供商对象脱敏：去掉明文 apiKey，只留 hasKey。
   * upsertProvider / addModelsToProvider / removeModelFromProvider 的返回值都带
   * 明文 key（来自 withResolvedKey），不能直接 json 给前端。
   */
  function sanitizeProvider(p) {
    if (!p || typeof p !== 'object') return p;
    const { apiKey, ...rest } = p;
    return { ...rest, apiKey: '', hasKey: Boolean(String(apiKey ?? '').trim()) };
  }

  function applyConfigPatch(patch) {
    const next = updateConfig(patch);
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

  async function handleHttp(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
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
      const cfgNow = getConfig();

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
      const stickerListMatch = pathname === '/api/stickers' && method === 'GET';
      if (stickerListMatch) {
        const q = String(url.searchParams.get('q') ?? '');
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200));
        const force = url.searchParams.get('force') === '1';
        try {
          const data = await stickers.adminList(q, limit, force);
          // maxKeepCount 一并回显：面板顶部的计数行要拿它跟 owned 比着写（"bot 收藏 12 个 / 上限 20"）
          return json(res, 200, { ok: true, ...data, maxKeepCount: Math.max(0, Number(getConfig().sticker?.maxKeepCount) || 0) });
        } catch (error) {
          return json(res, 502, { ok: false, error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/stickers/sync' && method === 'POST') {
        try {
          const data = await stickers.adminList('', 500, true);
          emit('sticker-update', {});
          // fromCache / syncError 必须原样回：QQ 同步失败时页面上还显示着本地缓存，
          // 不说清楚的话用户会以为"我明明删了/改了的那个怎么又回来了"。
          return json(res, 200, { ok: !data.syncError, count: data.total, fromCache: data.fromCache, error: data.syncError || '' });
        } catch (error) {
          return json(res, 502, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // 「缓存图片」：把 bot 自己收藏的表情的图补进 data/sticker-cache/（发送时就不再依赖
      // 会过期的图床链接），顺手删掉没人认领的缓存文件。
      // 顺序做、一次有上限：这是个手工按钮，不需要快，更需要别把图床和事件循环打满。
      if (pathname === '/api/stickers/cache' && method === 'POST') {
        try {
          const targets = stickers.entries.filter((e) => e.source !== 'qq' && !cachedPath(e));
          const MAX = 200;
          let cached = 0;
          const failed = [];
          for (const item of targets.slice(0, MAX)) {
            const r = await stickers.cacheOne(item.id);
            if (r.cached) cached++;
            else failed.push({ id: item.id, error: r.error || '缓存失败' });
          }
          const swept = stickers.sweep();
          if (cached || swept) emit('sticker-update', {});
          return json(res, 200, {
            ok: true,
            cached,
            swept,
            failed: failed.length,
            errors: failed.slice(0, 5),
            remains: Math.max(0, targets.length - MAX)
          });
        } catch (error) {
          return json(res, 502, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // 缩略图代理。**必须**走这里，页面上绝不能写 <img src="qpic…">：
      //  ① 图床有防盗链，直连大概率裂图；
      //  ② stickers.json 一旦被污染成内网地址，直连就是"用户的浏览器"去打内网 ——
      //     发送路径有 validateImageUrl 把关（tools.js:172），浏览器直连等于绕开它。
      // 复用现成的两道闸，不在这里另开 allowPrivate 口子。
      const stickerImageMatch = /^\/api\/stickers\/([^/]+)\/image$/.exec(pathname);
      if (stickerImageMatch && method === 'GET') {
        let ref;
        try { ref = decodeURIComponent(stickerImageMatch[1]); } catch { return json(res, 400, { error: '表情 id 编码错误' }); }
        const entry = await stickers.find(ref).catch(() => null);
        if (!entry) return json(res, 404, { error: '找不到这个表情' });
        // 有本地缓存就直接读盘：这类条目（bot 自己收藏的）的图床链接是会过期的，
        // 缓存文件才是它真正的图源 —— 顺带省一次图床请求、绕开防盗链。
        // 读不出图片就往下走网络路径，不因为一个坏文件让面板裂图。
        const local = cachedPath(entry);
        if (local) {
          try {
            const buffer = await fs.promises.readFile(local);
            const mime = detectMime(buffer);
            if (mime) {
              res.writeHead(200, {
                'content-type': mime,
                'content-length': buffer.length,
                'cache-control': 'private, max-age=600',
                'x-content-type-options': 'nosniff',
                'content-security-policy': "default-src 'none'"
              });
              return res.end(buffer);
            }
          } catch { /* 读不到就当没有缓存 */ }
        }
        if (!entry.url) return json(res, 404, { error: '该表情没有图片地址' });
        try {
          const safeUrl = await validateImageUrl(entry.url);
          const { buffer, contentType } = await safeFetchBinary(safeUrl);
          // 只认真正探测到的图片魔数，content-type 仅作兜底且必须在 image/ 之内。
          // 否则一个指向 text/html 的 URL 就能把 HTML 注入面板同源页面（本页首次
          // 渲染远程图片，这道闸不能省）。
          const mime = detectMime(buffer) || (/^image\//i.test(String(contentType || '')) ? String(contentType).split(';')[0] : '');
          if (!mime) return json(res, 415, { error: '取回的内容不是图片' });
          res.writeHead(200, {
            'content-type': mime,
            'content-length': buffer.length,
            // 图床 URL 可能过期，缓存别太激进；private 防止共享代理串味
            'cache-control': 'private, max-age=600',
            'x-content-type-options': 'nosniff',
            'content-security-policy': "default-src 'none'"
          });
          return res.end(buffer);
        } catch (error) {
          return json(res, 502, { error: String(error?.message ?? error) });
        }
      }

      const stickerItemMatch = /^\/api\/stickers\/([^/]+)$/.exec(pathname);
      if (stickerItemMatch && method === 'PATCH') {
        let ref;
        try { ref = decodeURIComponent(stickerItemMatch[1]); } catch { return json(res, 400, { ok: false, error: '表情 id 编码错误' }); }
        const body = await readBody(req).catch(() => ({}));
        // desc 是 QQ 那边的收藏名，mergeStickerLibrary 每次同步都会用源数据盖回来
        // （stickers.js:74），所以它**只读**：这里不收 body.desc，前端也只展示。
        // ⚠️ 传给 applyStickerNote 的键必须是 note（它对外的字段名是 localNote，
        //    但 patch 的键叫 note —— 见 stickers.js:260）。
        const patch = {};
        if (body.note !== undefined) patch.note = String(body.note ?? '').trim().slice(0, 200);
        if (body.usage !== undefined) patch.usage = String(body.usage ?? '').trim().slice(0, 200);
        if (body.tags !== undefined) {
          const raw = Array.isArray(body.tags) ? body.tags : String(body.tags ?? '').split(/[,，\s]+/);
          patch.tags = [...new Set(raw.map((t) => String(t ?? '').trim().slice(0, 30)).filter(Boolean))].slice(0, 20);
        }
        if (!Object.keys(patch).length) return json(res, 400, { ok: false, error: '没有可改的字段（note / tags / usage）' });
        // 走 noteVerbose（认标签）而不是精确 id：与 sticker_note 工具的行为一致。
        // 歧义就报歧义并列出候选——静默挑一个改错表情，比失败糟得多。
        const result = stickers.noteVerbose(ref, patch);
        if (result.ambiguous?.length) {
          return json(res, 409, {
            ok: false,
            error: `「${ref}」对应 ${result.ambiguous.length} 个表情，请用 id 指定：${result.ambiguous.map((e) => e.id).join(' / ')}`,
            candidates: result.ambiguous.map((e) => ({ id: e.id, desc: e.desc, url: e.url }))
          });
        }
        if (!result.entry) return json(res, 404, { ok: false, error: '找不到这个表情' });
        emit('sticker-update', { id: result.entry.id });
        return json(res, 200, {
          ok: true,
          sticker: {
            id: result.entry.id, localNote: result.entry.localNote || '', tags: result.entry.tags || [],
            usage: result.entry.usage || '', desc: result.entry.desc || ''
          }
        });
      }

      if (stickerItemMatch && method === 'DELETE') {
        let ref;
        try { ref = decodeURIComponent(stickerItemMatch[1]); } catch { return json(res, 400, { ok: false, error: '表情 id 编码错误' }); }
        const result = stickers.remove(ref);
        if (result.refused === 'qq') {
          return json(res, 409, { ok: false, error: '这是 QQ 收藏里的表情，本地删不掉（下次同步就会回来）。请到 QQ 里取消收藏。' });
        }
        if (!result.removed) return json(res, 404, { ok: false, error: '找不到这个表情（删除只认 id / resId / md5 / 图片地址，不按备注名猜）' });
        emit('sticker-update', {});
        return json(res, 200, { ok: true, removed: { id: result.removed.id, desc: result.removed.desc || '' } });
      }

      return json(res, 404, { error: `未知 API：${method} ${pathname}` });
    }

    if (serveStatic(req, res, pathname, UI_DIR)) return;

    res.writeHead(404);
    res.end();
  }

  // ── 启停 ──
  // DSH 自动导入已移除：模型目录改为在设置页手动维护（见 /api/providers 相关接口）。

  // ── 启停 ──
  async function listenOn(port) {
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
        if (error?.code !== 'EADDRINUSE') throw error;
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
        log('[snowluma] 自动启动失败:', error?.message ?? error);
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

/**
 * 成本看板数据：按天 / 按会话 / 按群聚合最近 N 天的用量。
 *
 * 数据源是 data/sessions/*.json（会话留档），每个会话对象里已有
 * usage.{promptTokens, completionTokens, cachedTokens} 与 chatKey / model / rounds。
 * 没有历史汇总文件也能算 —— 直接扫留档即可。
 */
/**
 * 解析时间范围参数。
 *   'today' → 今天 00:00 起
 *   '24h'   → 最近 24 小时（滚动窗口，可能跨天）
 *   '3'|'7'|'14'|'30' → 最近 N 个自然日
 */
function resolveRange(raw) {
  const s = String(raw || '7').trim().toLowerCase();
  const now = Date.now();
  if (s === 'today') {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return { mode: 'today', start: d.getTime(), end: now, label: '今天' };
  }
  if (s === '24h') {
    return { mode: '24h', start: now - 24 * 60 * 60 * 1000, end: now, label: '最近 24 小时' };
  }
  const n = Math.min(30, Math.max(1, Number(s) || 7));
  // 按自然日：从 N-1 天前的 0 点算起，保证"7 天"是 7 个完整日历日
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return { mode: 'days', start: d.getTime() - (n - 1) * 24 * 60 * 60 * 1000, end: now, label: `最近 ${n} 天` };
}

/** 本地时区的 YYYY-MM-DD（用于按天分桶）。 */
function dayKeyOf(ts) {
  const d = new Date(Number(ts) || 0);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/**
 * 收集时间窗内的所有"调用行"。
 * 每行是一次真实 API 调用（有 raw 时）或一次会话聚合（无 raw 时），
 * 都带自己的 token、发生时刻、模型、所属会话。
 */
// ── 用量行缓存 ──
// collectUsageRows 要遍历并 JSON.parse 全部会话文件。实测 300 个文件 / 25MB 时
// 单次约 200ms，而前端每 15 秒轮询一次、stats 与 breakdown 还各扫一遍。
// 会话文件是"结束写一次、之后不再改"，所以缓存很安全。
//
// 失效策略（双保险，任一条命中就重算）：
//   1. 目录快照变化：文件数或目录 mtime 变了（新增/删除会话）
//   2. TTL 到期：20 秒。兜住"内容被改写但目录快照不变"这类边缘情况。
//      原来是 5 秒，但轮询间隔 4 秒、用户切页签的时机又很随机，
//      导致切过去时缓存经常刚好过期 → 每次都走 200ms 的冷启动（"黑一下"）。
//      用量统计不是实时数据，20 秒的新鲜度完全够用。
//      另外前端还有一层：切过去先用上次数据立即渲染，不等网络。
const usageRowsCache = { key: '', at: 0, rows: null, win: null };
const USAGE_CACHE_TTL_MS = 20000;

/** 目录快照：文件数 + 目录 mtime。成本低（一次 stat），足以捕捉增删。 */
function sessionsDirSignature() {
  const dir = path.join(DATA_DIR, 'sessions');
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    const st = fs.statSync(dir);
    return files.length + ':' + st.mtimeMs;
  } catch {
    return '';
  }
}

function collectUsageRows({ range }) {
  const win = resolveRange(range);
  // 命中缓存就直接返回（注意 rows 会被调用方改写字段，所以必须给副本）
  const sig = sessionsDirSignature() + '@' + String(range);
  if (usageRowsCache.rows && usageRowsCache.key === sig
      && (Date.now() - usageRowsCache.at) < USAGE_CACHE_TTL_MS) {
    return {
      rows: usageRowsCache.rows.slice(),
      win: win || usageRowsCache.win,
      searchCount: usageRowsCache.searchCount || 0,
      toolCounts: { ...(usageRowsCache.toolCounts || {}) }
    };
  }

  const dir = path.join(DATA_DIR, 'sessions');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return { rows: [], win, searchCount: 0, toolCounts: {} }; }

  const rows = [];
  // 会话级计数：搜索次数、各工具的调用次数。
  // 与 rows 在同一个循环里统计 —— 不额外多读一次文件。
  // 注意这些是"次数"不是"成本"：搜索通常是资源包或免费的，
  // 所以只列数量、绝不参与成本计算（用户明确要求）。
  let searchCount = 0;
  const toolCounts = Object.create(null);

  for (const f of files) {
    let s;
    try { s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    const started = Number(s.startedAt) || 0;
    if (!started) continue;

    // 这个会话是否落在时间窗口内（工具/搜索计数按会话归属，没有独立时间戳）
    if (started >= win.start && started <= win.end) {
      searchCount += Number(s.webSearchCount) || 0;
      for (const m of (s.messages || [])) {
        const name = m && m.toolCall && m.toolCall.name;
        if (name) toolCounts[String(name)] = (toolCounts[String(name)] || 0) + 1;
      }
    }

    // 逐次调用展开：每条 message.raw 有独立的 usage / created / model
    const calls = [];
    for (const m of (s.messages || [])) {
      const raw = m?.raw;
      if (!raw || typeof raw !== 'object') continue;
      const ru = raw.usage || {};
      const rp = Number(ru.prompt_tokens) || 0;
      const rc = Number(ru.completion_tokens) || 0;
      if (!rp && !rc) continue;
      const at = Number(raw.created) ? Number(raw.created) * 1000 : started;
      calls.push({
        promptTokens: rp,
        completionTokens: rc,
        cachedTokens: Number(ru.prompt_tokens_details?.cached_tokens) || 0,
        at,
        model: String(raw.model || s.model || '') || '(未知)'
      });
    }

    if (calls.length) {
      for (const c of calls) {
        if (c.at < win.start || c.at > win.end) continue;
        rows.push({ ...c, vendor: String(s.vendor || ''), chatKey: String(s.chatKey || '(未知)'), sessionId: s.id, exact: true });
      }
    } else {
      const u = s.usage || {};
      const p = Number(u.promptTokens) || 0;
      const c = Number(u.completionTokens) || 0;
      if (!p && !c) continue;
      if (started < win.start || started > win.end) continue;
      rows.push({
        promptTokens: p,
        completionTokens: c,
        cachedTokens: Number(u.cachedTokens) || 0,
        at: started,
        model: String(s.model || '') || '(未知)',
        chatKey: String(s.chatKey || '(未知)'),
        vendor: String(s.vendor || ''),
        sessionId: s.id,
        exact: false
      });
    }
  }
  // 模型身份 = 渠道 + 模型 id。
  // 渠道取**会话自己记录的** vendor（创建会话时由当时的配置派生）。
  // 老会话没这个字段 → 标为「未知渠道」，绝不拿当前配置去倒推历史 ——
  // 用户很可能早就换过渠道了，猜出来的结果是错的。
  for (const r of rows) {
    r.vendor = String(r.vendor || '').trim() || UNKNOWN_VENDOR;
    r.modelKey = modelLabel(r.vendor, r.model);
  }
  // 写缓存：存的是"清洗完的 rows"，取用时给副本避免调用方污染
  usageRowsCache.key = sig;
  usageRowsCache.at = Date.now();
  usageRowsCache.rows = rows.slice();
  usageRowsCache.win = win;
  usageRowsCache.searchCount = searchCount;
  usageRowsCache.toolCounts = { ...toolCounts };
  return { rows, win, searchCount, toolCounts };
}

/** 用配置解析价格（成本只与实际调用的模型有关，与当前选中模型无关）。 */
/**
 * 取某次调用的单价。
 *
 * 按「渠道：模型 id」优先查 —— 用户可以为某个渠道下的模型单独定价
 * （A6API 的 GLM-5.3-Flash 与 OpenRouter 的可能是两个价）。
 * 查不到再退回裸模型 id（通用价），最后才是全局兜底。
 *
 * ⚠️ 必须与前端展示/批量编辑用的身份一致，否则用户设的渠道价永远不会生效。
 */
function priceOf(model, vendor) {
  const cfg = getConfig();
  if (vendor) {
    const byVendor = resolveModelPrice(modelLabel(vendor, model), cfg);
    // 命中自定义价才算数；否则退回通用价（避免渠道名干扰官方表匹配）
    if (byVendor.source === 'custom') return byVendor;
  }
  return resolveModelPrice(model, cfg);
}

/** 对一批行计价，返回总额与峰谷拆分。 */
function costOfRows(rows) {
  const cfg = getConfig();
  let cost = 0, peakCost = 0, offPeakCost = 0, peakTokens = 0, offPeakTokens = 0;
  let promptTokens = 0, completionTokens = 0, cachedTokens = 0, exactCalls = 0, hasPeakModel = false;
  for (const r of rows) {
    const p = priceOf(r.model, r.vendor);
    if (p.peak) hasPeakModel = true;
    const tier = p.peak ? priceAt({ in: p.in, out: p.out, cached: p.cached, peak: p.peak }, r.at) : p;
    const prompt = Number(r.promptTokens) || 0;
    const completion = Number(r.completionTokens) || 0;
    const cached = Math.min(Number(r.cachedTokens) || 0, prompt);
    const fresh = Math.max(0, prompt - cached);
    const c = (fresh / 1_000_000) * tier.in + (cached / 1_000_000) * tier.cached + (completion / 1_000_000) * tier.out;
    cost += c;
    const tk = prompt + completion;
    if (isPeakHour(r.at)) { peakCost += c; peakTokens += tk; } else { offPeakCost += c; offPeakTokens += tk; }
    promptTokens += prompt;
    completionTokens += completion;
    cachedTokens += cached;
    if (r.exact) exactCalls += 1;
  }
  return {
    cost, peakCost, offPeakCost, peakTokens, offPeakTokens,
    promptTokens, completionTokens, cachedTokens,
    totalTokens: promptTokens + completionTokens,
    cacheHitRate: promptTokens ? Math.min(1, cachedTokens / promptTokens) : 0,
    peakRatio: (peakTokens + offPeakTokens) ? peakTokens / (peakTokens + offPeakTokens) : 0,
    exactCalls, hasPeakModel, runs: rows.length
  };
}

/** 按某个字段分组后各自计价。 */
function groupBy(rows, field, limit = 0) {
  const map = new Map();
  for (const r of rows) {
    const k = String(r[field] ?? '(未知)');
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  let out = [...map.entries()].map(([key, list]) => ({ key, ...costOfRows(list) }));
  out.sort((a, b) => b.cost - a.cost || b.totalTokens - a.totalTokens);
  if (limit) out = out.slice(0, limit);
  return out;
}

/** 主统计：按天 / 按会话 / 按模型三个维度。 */
function buildUsageStats({ range = '7' } = {}) {
  const { rows, win, searchCount, toolCounts } = collectUsageRows({ range });
  const totals = costOfRows(rows);
  // 单日/24小时场景下"按天"没有意义（只有一行），由前端决定是否隐藏
  const days = win.mode === 'days' ? groupBy(rows, 'dayKey').map((x) => ({ day: x.key, ...x })) : [];
  // 按天分桶需要 dayKey 字段
  for (const r of rows) r.dayKey = dayKeyOf(r.at);
  const byDay = win.mode === 'days'
    ? groupBy(rows, 'dayKey').map((x) => ({ day: x.key, ...x })).sort((a, b) => a.day.localeCompare(b.day))
    : [];
  const chats = groupBy(rows, 'chatKey', 0);
  // 不截断：截断会让"各行成本之和 ≠ 总成本"，用户核对时会困惑。
  // 行数多时由前端滚动容器处理。
  const models = groupBy(rows, 'modelKey', 0).map((m) => {
    const { vendor, model } = splitModelLabel(m.key);
    return { ...m, vendor, model };
  });
  return {
    range: String(range),
    rangeLabel: win.label,
    mode: win.mode,
    totals,
    // 次数类统计：只看数量，不参与成本计算
    searchCount: searchCount || 0,
    toolCounts: toolCounts || {},
    days: byDay,
    chats,
    models
  };
}

/**
 * 下钻明细：在某个维度取某个值，再按另一个维度展开。
 *   dim/key 定位子集，by 决定展开方式
 * 例：dim=chat&key=group:123&by=model → 该群下各模型的成本
 */
function buildUsageBreakdown({ range = '7', dim = '', key = '', by = '' } = {}) {
  const { rows, win } = collectUsageRows({ range });
  for (const r of rows) r.dayKey = dayKeyOf(r.at);
  // dim/by 为 model 时按复合身份匹配（模型 + 供应商）
  const fieldOf = (d) => (d === 'day' ? 'dayKey' : d === 'model' ? 'modelKey' : 'chatKey');
  const subset = dim ? rows.filter((r) => String(r[fieldOf(dim)] ?? '') === key) : rows;
  // 同样不截断：保证明细各项之和 = 该子集总成本
  const groups = groupBy(subset, fieldOf(by) || 'chatKey', 0);
  const sum = costOfRows(subset);
  // 峰谷信息跟随子集（弹窗外部上方展示用）
  return {
    range: String(range),
    dim, key, by,
    totals: sum,
    showPeak: sum.hasPeakModel && (sum.peakCost > 0 || sum.offPeakCost > 0),
    rows: groups.map((g) => ({
      key: g.key,
      cost: g.cost,
      promptTokens: g.promptTokens,
      completionTokens: g.completionTokens,
      cachedTokens: g.cachedTokens,
      totalTokens: g.totalTokens,
      cacheHitRate: g.cacheHitRate,
      runs: g.runs,
      exactCalls: g.exactCalls
    }))
  };
}
