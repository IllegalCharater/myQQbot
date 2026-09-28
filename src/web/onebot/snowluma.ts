// OneBot 接入侧 · SnowLuma 程序
//
// `web/onebot/` 这一组放的是「本进程 ⇄ SnowLuma」那一侧的接入物：进程与目录管理
// （本文件）、令牌桥（`tokens.ts`）、入站事件摄取（`ingest.ts`）。
// 与 `src/qq/` 的分工：那边是协议客户端本身（连接、收发、段解析），这边是应用侧接线。
// 名字取自配置项——`snowluma.wsUrl` / `snowluma.accessToken`——也就是说在本项目里
// SnowLuma 就是「那个 OneBot 端」，三个文件都属于它的接入面。
//
// 原先这十件事是 `app.ts` 里 `createApp()` 内部的闭包 + 三个私有变量（约 210 行）。
// 搬出来只为一件事：这台机器的状态（进程句柄、日志环形缓冲、进程组标志）只属于它
// 自己，不参与组装根的对象图。**行为逐行保持不变**，`app.ts` 那边仍是同样的调用点，
// 只把裸函数名换成控制器上的方法。
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { ROOT } from '../../core/paths.js';
import { EVENTS } from '../../core/events.js';
import type { AppEmit } from '../../core/events.js';
import { errorMessage } from '../http/http.js';
import type { Reply, SnowlumaStatus } from '../types.js';

interface SnowlumaLog { at: number; stream: string; text: string }

/** `POST /api/snowluma/launch` 的响应体。键与形状是既有前端契约，别改。 */
export interface SnowlumaLaunchResult {
  ok: boolean;
  error?: string;
  alreadyRunning?: boolean;
  launched?: boolean;
  embedded?: boolean;
  pid?: number;
}

export interface SnowlumaController {
  /** 程序目录：配置优先，其次项目内置的 snowLuma/ 与 snowluma/（含 asar 解包目录）。找不到返回空串。 */
  dir(): string;
  servicePort(): number;
  webuiUrl(): string;
  isPortOpen(host: string, port: number, timeoutMs?: number): Promise<boolean>;
  /** 日志环形缓冲本体（最近 500 行）。调用方自己 slice。 */
  logs(): SnowlumaLog[];
  status(): SnowlumaStatus;
  launch(): Promise<SnowlumaLaunchResult>;
  stop(): boolean;
  openFolder(): Reply;
  openWebui(): Reply;
}

export function createSnowlumaController({ getConfigDir, emit, log }: {
  /** 读 `config.snowluma.dir`。递进来而不是直接 import `core/config`，与 `app.ts` 保持一致：配置的唯一读者是组装根。 */
  getConfigDir: () => string;
  emit: AppEmit;
  log: (...args: unknown[]) => void;
}): SnowlumaController {
  // SnowLuma 内置控制台日志（环形缓冲，最近 500 行）
  // 内置 SnowLuma 状态与日志。未采用多进程方案：由 Electron 主进程提供 IPC 控制与日志转发，
  // 确保 SnowLuma 随 QQ Agent 退出、无需单独管理窗口。
  const snowlumaLogs: SnowlumaLog[] = [];
  let snowlumaProc: ChildProcess | null = null;
  let snowlumaProcessGroup = false;

  function dir() {
    const configured = String(getConfigDir() || '').trim();
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

  function servicePort() {
    try {
      const directory = dir();
      const runtimePath = directory && path.join(directory, 'config', 'runtime.json');
      if (runtimePath && fs.existsSync(runtimePath)) {
        const runtime = JSON.parse(fs.readFileSync(runtimePath, 'utf8'));
        const port = Number(runtime.webuiPort);
        if (Number.isInteger(port) && port > 0 && port <= 65535) return port;
      }
    } catch { /* ignore */ }
    return 5099;
  }

  /** 从 SnowLuma 的 runtime.json 读取 WebUI 地址（http(s)://host:port/）。拿不到就返回空串。 */
  function webuiUrl() {
    try {
      const directory = dir();
      if (!directory) return '';
      const rtPath = path.join(directory, 'config', 'runtime.json');
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

  function pushLog(text: unknown, stream = 'stdout') {
    const line = { at: Date.now(), stream, text: String(text ?? '').replace(/\r?\n$/, '') };
    if (!line.text) return;
    snowlumaLogs.push(line);
    if (snowlumaLogs.length > 500) snowlumaLogs.splice(0, snowlumaLogs.length - 500);
    emit(EVENTS.snowlumaLog, line);
  }

  function status(): SnowlumaStatus {
    return { embedded: !!snowlumaProc, pid: snowlumaProc?.pid ?? null };
  }

  /** 关闭内置启动的 SnowLuma。返回是否执行了关闭动作。 */
  function stop() {
    const proc = snowlumaProc;
    if (!proc) return false;
    try {
      // launcher.sh 可能再拉起子进程；Linux 下终止整个进程组，避免只关掉 shell 后 SnowLuma 残留。
      if (snowlumaProcessGroup && process.platform !== 'win32' && proc.pid) process.kill(-proc.pid, 'SIGTERM');
      else proc.kill();
      pushLog('已请求关闭 SnowLuma。', 'stdout');
    } catch (error) {
      pushLog(`关闭 SnowLuma 失败：${errorMessage(error)}`, 'stderr');
      throw error;
    }
    return true;
  }

  /** 拉起 SnowLuma。优先用项目内置 node.exe 直接运行；失败后按平台回退到 launcher.bat / launcher.sh。 */
  async function launch(): Promise<SnowlumaLaunchResult> {
    const directory = dir();
    if (!directory) return { ok: false, error: '找不到 SnowLuma 目录：请确认项目内 snowluma/ 文件夹存在，或在设置里填写 SnowLuma 目录' };
    const port = servicePort();
    if (await isPortOpen('127.0.0.1', port)) {
      pushLog(`SnowLuma 已在运行（端口 ${port} 已就绪），无需重复启动`, 'stdout');
      return { ok: true, alreadyRunning: true };
    }
    const indexMjs = path.join(directory, 'index.mjs');
    const nodeExe = path.join(directory, 'node.exe');
    if (fs.existsSync(indexMjs) && fs.existsSync(nodeExe)) {
      try {
        // 用 Windows 的 CREATE_NEW_PROCESS_GROUP + 独立进程方式启动，
        // 让 SnowLuma 真正独立于 Electron 主进程（Electron 退出时不会拖垮它）。
        const child = spawn(nodeExe, [indexMjs], {
          cwd: directory,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          detached: false
        });
        snowlumaProc = child;
        child.unref();
        pushLog(`SnowLuma 启动中（内置模式，pid=${child.pid}）…`, 'stdout');
        child.stdout.on('data', (d) => {
          for (const line of String(d).split(/\r?\n/)) {
            if (line.trim()) pushLog(line, 'stdout');
          }
        });
        child.stderr.on('data', (d) => {
          for (const line of String(d).split(/\r?\n/)) {
            if (line.trim()) pushLog(line, 'stderr');
          }
        });
        child.on('exit', (code, signal) => {
          snowlumaProc = null;
          pushLog(`SnowLuma 进程已退出（code=${code ?? ''} signal=${signal ?? ''}）`, 'stderr');
          emit(EVENTS.snowlumaStatus, { running: false, embedded: false, pid: null });
        });
        child.on('error', (error) => {
          pushLog(`SnowLuma 启动失败：${errorMessage(error)}`, 'stderr');
        });
        emit(EVENTS.snowlumaStatus, { running: true, embedded: true, pid: child.pid });
        return { ok: true, launched: true, embedded: true, pid: child.pid };
      } catch (error) {
        pushLog(`内置模式启动失败，尝试回退独立窗口：${errorMessage(error)}`, 'stderr');
        snowlumaProc = null;
      }
    }
    // 回退到发行包自带的启动脚本。Linux/macOS 通过 sh 执行，因此脚本无需预先设置可执行位。
    const isWindows = process.platform === 'win32';
    const launcherName = isWindows ? 'launcher.bat' : 'launcher.sh';
    const launcher = path.join(directory, launcherName);
    if (!fs.existsSync(launcher)) {
      return { ok: false, error: `目录里没有可用的 index.mjs / node.exe，也没有 ${launcherName}：${directory}` };
    }
    const child = spawn(isWindows ? 'cmd.exe' : '/bin/sh', isWindows ? ['/c', launcher] : [launcher], {
      cwd: directory,
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
      pushLog(`通过 ${launcherName} 启动失败：${errorMessage(error)}`, 'stderr');
      return { ok: false, error: `无法执行 ${launcherName}：${errorMessage(error)}` };
    }

    if (isWindows) {
      child.unref();
      pushLog(`SnowLuma 已通过 ${launcherName} 启动（此模式下日志不进内置控制台）`, 'stdout');
      return { ok: true, launched: true, embedded: false };
    }

    // Linux/macOS 下把脚本进程纳入管理页：转发日志、显示 PID，并允许“停止”按钮关闭进程组。
    snowlumaProc = child;
    snowlumaProcessGroup = true;
    pushLog(`SnowLuma 启动中（${launcherName}，pid=${child.pid}）…`, 'stdout');
    child.stdout?.on('data', (data) => {
      for (const line of String(data).split(/\r?\n/)) if (line.trim()) pushLog(line, 'stdout');
    });
    child.stderr?.on('data', (data) => {
      for (const line of String(data).split(/\r?\n/)) if (line.trim()) pushLog(line, 'stderr');
    });
    child.on('exit', (code, signal) => {
      if (snowlumaProc === child) {
        snowlumaProc = null;
        snowlumaProcessGroup = false;
      }
      pushLog(`SnowLuma 进程已退出（code=${code ?? ''} signal=${signal ?? ''}）`, code ? 'stderr' : 'stdout');
      emit(EVENTS.snowlumaStatus, { running: false, embedded: false, pid: null });
    });
    emit(EVENTS.snowlumaStatus, { running: true, embedded: true, pid: child.pid });
    return { ok: true, launched: true, embedded: true, pid: child.pid };
  }

  function openFolder(): Reply {
    const directory = dir();
    if (!directory) return { status: 400, body: { ok: false, error: '找不到 SnowLuma 目录' } };
    spawn('explorer.exe', [directory], { detached: true, stdio: 'ignore' }).unref();
    return { status: 200, body: { ok: true } };
  }

  function openWebui(): Reply {
    const url = webuiUrl();
    if (!url) return { status: 400, body: { ok: false, error: '没有找到 SnowLuma WebUI 地址（等日志出现 listening 后再试）' } };
    spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    return { status: 200, body: { ok: true, webuiUrl: url } };
  }

  return { dir, servicePort, webuiUrl, isPortOpen, logs: () => snowlumaLogs, status, launch, stop, openFolder, openWebui };
}
