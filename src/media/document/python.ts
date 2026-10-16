// 文档抽取的 Python 子进程：起进程、喂字节、收结果帧。
//
// ── 形状：字节走 stdin，结果走 stdout 一帧 ──
//
// 与 `media/jmcomic/python.ts`、`core/python-probe.ts` 同一条路子（起一个短命令进程，
// 从 stdout 认一帧 `__QQ_AGENT_RESULT__{json}`），差别只有一处：**这次要往子进程喂一大段字节**。
// 喂 stdin 而不是落临时文件，是因为临时文件会带来两件本来不需要操心的事 ——
// "什么时候删"与"路径会不会越界"（jmcomic 那套 `validatePdf` 的路径核对就是前车之鉴）。
//
// ── 三条照抄来的纪律 ──
//
//   • **只看最后一帧**：stdout 可能任意分块，JSON 也可能还没收全。每次都从累计内容里重新找
//     最后一行 `RESULT_PREFIX`，解析失败就当"还没到齐"（同 `parseResultFrame`）。
//   • **必须给硬超时**：抽一份 500 页的 PDF 是真的会跑很久，而模型在等这一次工具调用。
//     `probePython` 那条注释写得很清楚：短任务不需要闲置心跳，但需要一个上限。
//   • **报出实际用的那个命令**：解释器可能来自 `python.path` / `QQ_AGENT_PYTHON` /
//     随包内置运行时 / conda 中的任意一条，只说 "python" 会让一个填错的 `python.path`
//     看起来像"这个文件读不了"。
import { spawn } from 'node:child_process';
import { getConfig } from '../../core/config.js';
import { DOCUMENT_SCRIPT, resolvePythonCommand } from '../../core/python-runtime.js';
import { DocumentError } from './types.js';

/** 认结果帧的前缀。与 Python 侧、jmcomic、搜图 worker 逐字相同。 */
export const RESULT_PREFIX = '__QQ_AGENT_RESULT__';

/**
 * 单次抽取的硬超时。**不是配置项**：它是"别把一次工具调用挂死"的保险，不是用户会想调的旋钮。
 * 一份 500 页的 PDF 在慢机器上大约几十秒，60 秒留了余地。
 */
const EXTRACT_TIMEOUT_MS = 60_000;

/** 累计 stdout 的保留上限。正文本身由 `--max-chars` 夹住，这里防的是"它狂喷日志"。 */
const MAX_STDOUT_CHARS = 4_000_000;

// ── 可注入的子进程（同 `core/python-probe.ts` 的 `ProbeChild` / `SpawnLike`）──
//
// 是**参数**而不是模块级全局：抽取是请求作用域的动作，没有一个"活着的 app"可以挂。
// 用最小结构类型而不是 `ChildProcess`，是为了让套件能塞一个普通对象字面量进来
// （没有 `instanceof`、没有运行期校验）—— 那样套件永远不必真启动解释器。

export interface DocumentChild {
  stdin: { end(chunk: Buffer): unknown };
  stdout: { on(event: 'data', listener: (chunk: Buffer) => void): unknown };
  stderr: { on(event: 'data', listener: (chunk: Buffer) => void): unknown };
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'close', listener: (code: number | null) => void): unknown;
  kill(): unknown;
}

export interface DocumentSpawnOptions { windowsHide: boolean; stdio: ['pipe', 'pipe', 'pipe'] }
export type DocumentSpawnLike = (
  command: string, args: readonly string[], options: DocumentSpawnOptions
) => DocumentChild;

/** Python 回来的那一帧（成与不成都在这里）。 */
export interface ExtractFrame {
  ok: boolean;
  /** `ok:false` 时给模型看的中文原因。 */
  error: string;
  /** `ok:false` 时可机检的原因码；空串 = 没给（当通用失败处理）。 */
  code: string;
  format: string;
  text: string;
  chars: number;
  truncated: boolean;
  pages?: number;
  encoding?: string;
}

/**
 * 从累计 stdout 里抽最后一帧。返回 `null` = "帧还没到齐，等下一块"。
 *
 * 不做成 import 自 `media/jmcomic/python.ts`：`media/` 的规矩是**功能目录之间不互相 import**
 * （只横向引用 `safe-fetch` / `call-budget` / `media-source` 那几个平铺助手）。这 7 行就地
 * 重写是那条规矩的已知代价，不是漏看。
 */
export function parseResultFrame(stdout: string): ExtractFrame | null {
  const line = stdout.split(/\r?\n/).reverse().find((item) => item.startsWith(RESULT_PREFIX));
  if (!line) return null;
  try {
    const parsed: unknown = JSON.parse(line.slice(RESULT_PREFIX.length));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    return {
      ok: record.ok === true,
      error: String(record.error ?? ''),
      code: String(record.code ?? ''),
      format: String(record.format ?? ''),
      text: String(record.text ?? ''),
      chars: Math.max(0, Math.round(Number(record.chars) || 0)),
      truncated: record.truncated === true,
      ...(record.pages === undefined ? {} : { pages: Math.max(0, Math.round(Number(record.pages) || 0)) }),
      ...(record.encoding === undefined ? {} : { encoding: String(record.encoding) })
    };
  } catch {
    return null;
  }
}

/**
 * 把一段字节交给 Python 抽成文本。**失败一律抛 `DocumentError`**（带 code）。
 *
 * `spawn` 与 `timeoutMs` 是给套件的注入点；生产路径一个都不传。
 */
export function extractWithPython(
  buffer: Buffer,
  { maxChars, spawn: spawnFn = spawn, timeoutMs = EXTRACT_TIMEOUT_MS }: {
    maxChars: number;
    spawn?: DocumentSpawnLike;
    timeoutMs?: number;
  }
): Promise<ExtractFrame> {
  const { command, prefix } = resolvePythonCommand(getConfig());
  const args = [...prefix, DOCUMENT_SCRIPT, '--max-chars', String(Math.max(1, Math.round(maxChars)))];

  return new Promise<ExtractFrame>((resolve, reject) => {
    let child: DocumentChild;
    try {
      child = spawnFn(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      // 假 spawn 或极端环境下构造就抛：与 `error` 事件同一条出口。
      reject(new DocumentError('PYTHON_SPAWN', `无法启动 Python（${command}）：${error instanceof Error ? error.message : String(error)}`));
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      finish(() => reject(new DocumentError('EXTRACT_TIMEOUT', `读这份文件超过了 ${Math.round(timeoutMs / 1000)} 秒，已放弃`)));
    }, timeoutMs);
    // ⚠️ **故意不 unref** —— 与 `core/python-probe.ts` 那条逐字同一个理由：这里的超时是
    // **唯一的兜底**，而"假 spawn"或"启动了却永不退出的解释器"不持有任何句柄；unref 掉的计时器
    // 会被无视，顶层 await 永远不结算，Node 直接以退出码 13（Unfinished Top-Level Await）走掉。
    // 实测症状是**套件在"超时"那一条静默中止、后面的断言一次都没跑**（我在本套件初版上又踩了一次）。

    const finish = (run: () => void): boolean => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      run();
      return true;
    };

    /**
     * 帧一到就结算，不等 `close` —— 同 jmcomic 那条注释：第三方库可能留下仍存活的线程，
     * 那时结果早 flush 出来了，等 `close` 只会白挂到超时。
     */
    const settle = (): boolean => {
      if (settled) return true;
      const frame = parseResultFrame(stdout);
      if (!frame) return false;
      if (!frame.ok) {
        finish(() => reject(new DocumentError(frame.code || 'EXTRACT_FAILED', frame.error || stderr.trim() || '读这个文件失败')));
      } else {
        finish(() => resolve(frame));
      }
      try { child.kill(); } catch { /* ignore */ }
      return true;
    };

    child.stdout.on('data', (chunk) => {
      stdout = (stdout + chunk.toString('utf8')).slice(-MAX_STDOUT_CHARS);
      settle();
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-50_000);
    });
    child.on('error', (error) => {
      finish(() => reject(new DocumentError('PYTHON_SPAWN', `无法启动 Python（${command}）：${error.message}`)));
    });
    child.on('close', (code) => {
      if (settled) return;
      if (settle()) return;
      // 没有结果帧：脚本可能压根没跑起来（文件不存在 / 语法错），stderr 是唯一线索。
      finish(() => reject(new DocumentError(
        'PYTHON_NO_FRAME',
        `Python 没能给出结果（退出码 ${code}）：${stderr.trim() || '没有任何输出'}`
      )));
    });

    try {
      child.stdin.end(buffer);
    } catch (error) {
      finish(() => reject(new DocumentError('PYTHON_STDIN', `把文件写给 Python 时出错：${error instanceof Error ? error.message : String(error)}`)));
    }
  });
}
