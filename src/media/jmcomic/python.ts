// 下载用的 Python 子进程：起进程、收结果帧、校验 PDF。
//
// 两条铁律（都是真机踩出来的）：
//   · **结果帧一到就结算**，不依赖进程 `close` —— jmcomic 可能留下仍存活的非 daemon 线程，
//     那时 PDF 已经生成、结果也 flush 出来了，等 close 会永久卡在 downloading。
//   · stdout 可能任意分块，所以每次从累计尾部重新找最后一帧，JSON 没收全时等下一块。

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { getConfig } from '../../core/config.js';
import { JMCOMIC_SCRIPT, resolvePythonCommand } from '../../core/python-runtime.js';
import { getRuntime } from './runtime.js';
import { ensureDirs, persistNow } from './jobs.js';
import {
  errorMessage, isRecord, DOWNLOAD_DIR, LOG_DIR, DOWNLOAD_TIMEOUT_MS, INACTIVITY_TIMEOUT_MS, RESULT_PREFIX
} from './shared.js';
import type { JmJob, PythonResult } from './types.js';

export function validatePdf(pdfPath: unknown): string {
  const resolved = path.resolve(String(pdfPath || ''));
  const root = path.resolve(DOWNLOAD_DIR) + path.sep;
  if (!resolved.startsWith(root)) throw new Error('Python 返回的 PDF 路径越界');
  const stat = fs.statSync(resolved);
  if (!stat.isFile() || stat.size < 1024) throw new Error('PDF 文件为空或不完整');
  const fd = fs.openSync(resolved, 'r');
  try {
    const header = Buffer.alloc(5);
    fs.readSync(fd, header, 0, 5, 0);
    if (header.toString('ascii') !== '%PDF-') throw new Error('生成文件不是有效 PDF');
  } finally {
    fs.closeSync(fd);
  }
  return resolved;
}

/**
 * 从累计 stdout 里抽最后一帧 `RESULT_PREFIX` JSON。
 *
 * 抽成公用是因为**搜索**与**下载**两条路都要用它，而这段的坑（stdout 任意分块、
 * JSON 可能还没收全、只看最后一帧）不该写两份。返回 `null` 表示"帧还没到齐，等下一块"。
 */
export function parseResultFrame(stdout: string): { ok: boolean; payload: Record<string, unknown> } | null {
  const line = stdout.split(/\r?\n/).reverse().find((item) => item.startsWith(RESULT_PREFIX));
  if (!line) return null;
  try {
    const parsed: unknown = JSON.parse(line.slice(RESULT_PREFIX.length));
    if (!isRecord(parsed)) return null;
    return { ok: parsed.ok === true, payload: parsed };
  } catch {
    return null;
  }
}

/** 给 Python 用的通用报错文案（两条路共用，措辞里的路径与解释器都是实测踩过的点）。 */
export const PYTHON_MISSING_HINT =
  '当前 Python 解释器未安装 jmcomic。请用**同一个**解释器装一遍项目依赖'
  + '（设置页「Python 工具」里有解释器路径，也可以用环境变量 QQ_AGENT_PYTHON 指定）';

export function runPython(job: JmJob): Promise<PythonResult> {
  ensureDirs();
  // 解释器与脚本路径都来自 core/python-runtime（两个 Python 工具共用一条解析链）。
  const { command, prefix } = resolvePythonCommand(getConfig());
  const logFile = path.join(LOG_DIR, `${job.id}.log`);
  return new Promise<PythonResult>((resolve, reject) => {
    const spawnProcess = getRuntime()?.spawnProcess ?? spawn;
    const child = spawnProcess(command, [...prefix, JMCOMIC_SCRIPT, job.comicId, DOWNLOAD_DIR], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let hardTimer: ReturnType<typeof setTimeout> | null = null;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let lastPersistedHeartbeat = 0;

    const finish = <T>(fn: (value: T) => void, value: T): boolean => {
      if (settled) return false;
      settled = true;
      if (hardTimer) clearTimeout(hardTimer);
      if (idleTimer) clearTimeout(idleTimer);
      fn(value);
      return true;
    };
    const stop = (message: string) => {
      try { child.kill(); } catch { /* ignore */ }
      finish(reject, new Error(message));
    };
    const heartbeat = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => stop('下载连续 5 分钟没有任何进度，已终止'), INACTIVITY_TIMEOUT_MS);
      const now = Date.now();
      if (now - lastPersistedHeartbeat >= 5_000) {
        lastPersistedHeartbeat = now;
        job.heartbeatAt = now;
        job.updatedAt = now;
        persistNow();
      }
    };
    const appendLog = (chunk: Buffer) => {
      try { fs.appendFileSync(logFile, chunk); } catch { /* ignore */ }
      heartbeat();
    };

    /**
     * Python 用 RESULT_PREFIX 输出一帧最终结果。和搜图 worker 的 JSON Lines 回调同一原则：
     * **帧到达就是任务完成**，不能继续等待进程 close。jmcomic/图片下载器可能留下仍存活的
     * 非 daemon 线程；那时 PDF 已经生成、结果也 flush 出来了，但旧实现会一直卡在
     * `downloading`，永远走不到上传阶段。
     *
     * stdout 可能任意分块，所以每次都从累计尾部重新找最后一帧；JSON 尚未收全时解析失败，
     * 下一块到达后自然再试。close 仍保留为“没有结果帧/异常退出”的兜底。
     */
    const settleFromResultFrame = (): boolean => {
      if (settled) return true;
      const frame = parseResultFrame(stdout);
      if (!frame) return false;
      if (!frame.ok) {
        const didFinish = finish(reject, new Error(String(frame.payload.error || stderr.trim() || 'Python 返回下载失败')));
        if (didFinish) try { child.kill(); } catch { /* ignore */ }
        return true;
      }
      try {
        const value: PythonResult = { ...frame.payload, ok: true, pdfPath: validatePdf(frame.payload.pdfPath) };
        const didFinish = finish(resolve, value);
        // 结果帧写出前 PDF 已经原子换入最终路径；此后 Python 的工作已经结束。若第三方库
        // 留下后台线程，就主动收掉进程，避免它继续钉住 Node/Electron。
        if (didFinish) try { child.kill(); } catch { /* ignore */ }
      } catch (error) {
        const didFinish = finish(reject, error);
        if (didFinish) try { child.kill(); } catch { /* ignore */ }
      }
      return true;
    };

    child.stdout.on('data', (chunk) => {
      appendLog(chunk);
      stdout = (stdout + chunk.toString('utf8')).slice(-300_000);
      settleFromResultFrame();
    });
    child.stderr.on('data', (chunk) => {
      appendLog(chunk);
      stderr = (stderr + chunk.toString('utf8')).slice(-50_000);
    });
    // 报出**实际用的那个命令**，而不是写死 "my_bot"。解释器可能来自 python.path /
    // QQ_AGENT_PYTHON / Windows 固定环境 / conda 回退中的任意一条，只说 "my_bot" 会让
    // 一个填错的 python.path 看起来像 conda 环境缺库。
    child.on('error', (error) => finish(reject, new Error(`无法启动 Python（${command}）：${error.message}`)));
    child.on('close', (code) => {
      if (settled) return;
      if (settleFromResultFrame()) return;
      finish(reject, new Error(String(stderr.trim() || `Python 异常退出（${code}）`)));
    });
    heartbeat();
    hardTimer = setTimeout(() => stop('下载超过 30 分钟，已终止'), DOWNLOAD_TIMEOUT_MS);
  });
}

