// Python 解释器探测与自检：回答"设置页填的那个解释器真的能用吗"。
//
// 为什么需要它：`python.path` 是用户唯一能自救的旋钮，而在本模块之前，填错它的症状是
// "搜图/漫画悄悄不可用" —— 错误文本只会说"环境里没有某某库"，看不出实际用的是哪个解释器。
// 这里把**解析层级、解释器版本、两个库装没装**一次问清，并给 `--self-check` 一个入口
// （worker 里 4 张待对真实库验证的映射表只能靠它对齐，见 `python-tools/pic_image_search_worker.py` 头部 ⚑）。
//
// 三条边界：
// 1. **只吃解析结果，不吃请求体**：解释器路径只能来自已保存的配置（唯一的写入口是鉴权过的
//    `POST /api/config`）。若这里的入参从 HTTP 请求体取，就等于开了一个"用 HTTP 启动任意本机程序"
//    的一步接口。
// 2. **argv 里不可能有密钥**：`--self-check` 不需要 `apiKey`，所以这里连引擎参数都不传
//    （SauceNAO 的 key 只走 stdin 那条不变量，见 `image-source/`）。
// 3. **不碰常驻 worker 客户端**：探测是独立的一次性进程，与 `getPicImageSearchClient()`
//    那个长生命周期单例无关 —— 点一百次「测试解释器」也不会多留下一个常驻子进程。
//
// 这里的计时器是**请求作用域**的（硬超时），按 AGENTS.md 的判定不进 `LONG_TERM_TASKS`。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PIC_IMAGE_SEARCH_SCRIPT, resolvePythonCommand } from './python-runtime.js';
import type { PythonCommandSource, PythonPathConfig } from './python-runtime.js';

/** 探测脚本。一行 JSON 到 stdout：解释器自身信息 + 两个库的版本（未安装为 `null`）。 */
const PROBE_SCRIPT = [
  'import json, sys, importlib.util as U',
  'names = ["PicImageSearch", "jmcomic"]',
  'def dep(n):',
  '    try:',
  '        if U.find_spec(n) is None:',
  '            return None',
  '    except Exception:',
  '        return None',
  '    try:',
  '        import importlib.metadata as M',
  '        return M.version(n)',
  '    except Exception:',
  '        return "unknown"',
  'print(json.dumps({"exe": sys.executable, "version": "%d.%d.%d" % sys.version_info[:3],',
  '                  "deps": dict((n, dep(n)) for n in names)}))'
].join('\n');

/** 探测的硬超时。要够 conda 冷启动，但不能让页面转圈到用户放弃。 */
const PROBE_TIMEOUT_MS = 15_000;
/** 自检的硬超时。worker 的 self_check 只做 import 与内省，不联网。 */
const SELF_CHECK_TIMEOUT_MS = 60_000;
/** 自检输出上限。它会把模块导出的名字全列一遍，必须截断，但**保留开头**（关键信息在前）。 */
const MAX_OUTPUT_CHARS = 20_000;

/**
 * `spawn` 的**最小结构化形状**。测试用对象字面量顶替（与 `PicImageSearchPort` 同款做法，
 * 不引入 `instanceof`，也不校运行期类型）—— 这是"测探测模块而不真的启动解释器"的唯一途径。
 */
export interface ProbeChild {
  stdout: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown };
  stderr: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown };
  on(event: 'close', listener: (code: number | null) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  kill(): unknown;
}

export interface ProbeSpawnOptions { windowsHide: boolean; stdio: ['ignore', 'pipe', 'pipe'] }
export type SpawnLike = (command: string, args: readonly string[], options: ProbeSpawnOptions) => ProbeChild;

export interface ProbeDeps {
  /** 注入点。缺省是真 `spawn`；测试传假实现以避免启动任何解释器。 */
  spawn?: SpawnLike;
  /** 覆盖硬超时（毫秒）。测试用它把"超时"这条分支跑成 50ms。 */
  timeoutMs?: number;
}

export interface PythonDepReport { exe: string; version: string; deps: Record<string, string | null> }

export interface ProbeReport {
  ok: boolean;
  /** 命中的解析层级，见 `PythonCommandSource`。 */
  source: PythonCommandSource;
  command: string;
  prefix: string[];
  /** `command` 是绝对路径时才判：`false` = 这个路径下没有文件。conda 形态为 `null`。 */
  exists: boolean | null;
  /** 拿到回答才有。`deps` 里 `null` = 该库没装（这是"提示"，权威检查是自检）。 */
  interpreter: PythonDepReport | null;
  error?: string;
  durationMs: number;
}

export interface SelfCheckReport {
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  /** worker 的 stderr 原文（它把 self_check 全打在 stderr），必要时截断。 */
  output: string;
  command: string;
  prefix: string[];
  durationMs: number;
}

/**
 * 跑一次子进程，收集 stdout/stderr，带硬超时。
 *
 * 与 `media/jmcomic.ts` 的 `runPython()` 同一形态（那里有闲置心跳，这里不需要：探测与自检
 * 都是短任务，没有"连续 N 分钟没进度"可谈）。
 */
function runChild(
  command: string, args: readonly string[], timeoutMs: number, spawnFn: SpawnLike
): Promise<{ code: number | null; stdout: string; stderr: string; error: Error | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    let child: ProbeChild;
    try {
      child = spawnFn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      // 假 spawn 或极端环境下构造就抛：与 `error` 事件同一条出口。
      resolve({ code: null, stdout: '', stderr: '', error: error instanceof Error ? error : new Error(String(error)), timedOut: false });
      return;
    }
    let stdout = ''; let stderr = ''; let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (value: { code: number | null; error: Error | null; timedOut: boolean }) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ ...value, stdout, stderr });
    };
    child.stdout.on('data', (chunk) => { stdout = (stdout + chunk.toString('utf8')).slice(-200_000); });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString('utf8')).slice(-200_000); });
    child.on('error', (error) => finish({ code: null, error, timedOut: false }));
    child.on('close', (code) => finish({ code, error: null, timedOut: false }));
    timer = setTimeout(() => {
      try { child.kill(); } catch { /* 已经退出 */ }
      finish({ code: null, error: null, timedOut: true });
    }, timeoutMs);
    // ⚠️ 这里**故意不 unref**。`jmcomic.ts` 的 runPython 给它的硬超时加 unref 是对的（那条路
    // 还有子进程句柄撑着事件循环），但探测这条路的超时是**唯一的兜底**：假 spawn 或"启动了却
    // 永不退出"的解释器不持有任何句柄，unref 掉的计时器会被无视，顶层 await 永远不结算，
    // Node 直接以退出码 13（Unfinished Top-Level Await）走掉 —— 实测过，症状是套件在"超时"
    // 那一条**静默中止**，后面的断言一次都没跑。
  });
}

/** 从可能的杂音里挑出那行 JSON（conda 之类的前置程序会往 stdout 打招呼）。 */
function parseProbeOutput(stdout: string): PythonDepReport | null {
  const lines = stdout.split(/\r?\n/).reverse();
  for (const line of lines) {
    const text = line.trim();
    if (!text.startsWith('{')) continue;
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && 'exe' in parsed) {
        const record = parsed as { exe?: unknown; version?: unknown; deps?: unknown };
        const deps: Record<string, string | null> = {};
        if (record.deps && typeof record.deps === 'object') {
          for (const [key, value] of Object.entries(record.deps as Record<string, unknown>)) {
            deps[key] = typeof value === 'string' ? value : null;
          }
        }
        return { exe: String(record.exe ?? ''), version: String(record.version ?? ''), deps };
      }
    } catch { /* 不是 JSON，继续往上找 */ }
  }
  return null;
}

function excerpt(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 500 ? `${trimmed.slice(0, 500)}…` : trimmed;
}

/**
 * 探测配置里的解释器：能启动吗、是什么版本、两个库装了没有。
 *
 * `ok` 的含义是"解释器回答了"，**不是"依赖齐全"** —— 依赖状态在 `interpreter.deps` 里如实列出
 * （`null` = 没装）。真正权威的依赖检查是 {@link runSelfCheck}（它会真的 import）。
 */
export async function probePython(config: PythonPathConfig = {}, deps: ProbeDeps = {}): Promise<ProbeReport> {
  const started = Date.now();
  const { command, prefix, source } = resolvePythonCommand(config);
  const spawnFn = deps.spawn ?? (spawn as unknown as SpawnLike);
  // 绝对路径先判存在性：**"路径打错"与"解释器坏了"是两种错**，不该都靠一次 spawn 才分得出来
  // （conda 那条路 command 不是路径，无从判起 → null）。
  const exists = path.isAbsolute(command) ? fs.existsSync(command) : null;
  const base = { source, command, prefix, exists, durationMs: 0 };
  if (exists === false) {
    return { ...base, ok: false, interpreter: null, error: `这个路径下没有文件：${command}`, durationMs: Date.now() - started };
  }
  const run = await runChild(command, [...prefix, '-c', PROBE_SCRIPT], deps.timeoutMs ?? PROBE_TIMEOUT_MS, spawnFn);
  const durationMs = Date.now() - started;
  if (run.error) {
    // 报出**实际用的那个命令**（与 jmcomic 同款理由）：只说"Python 启动失败"会让填错的
    // python.path 看起来像环境缺库。
    return { ...base, ok: false, interpreter: null, error: `无法启动 Python（${command}）：${run.error.message}`, durationMs };
  }
  if (run.timedOut) {
    return { ...base, ok: false, interpreter: null, error: `解释器 ${deps.timeoutMs ?? PROBE_TIMEOUT_MS}ms 内没有回应（可能不是 Python 程序）`, durationMs };
  }
  if (run.code !== 0) {
    return { ...base, ok: false, interpreter: null, error: `解释器异常退出（${run.code}）：${excerpt(run.stderr) || excerpt(run.stdout)}`, durationMs };
  }
  const interpreter = parseProbeOutput(run.stdout);
  if (!interpreter) {
    return { ...base, ok: false, interpreter: null, error: `解释器没有给出可识别的回答：${excerpt(run.stdout) || excerpt(run.stderr)}`, durationMs };
  }
  return { ...base, ok: true, interpreter, durationMs };
}

/**
 * 在配置的解释器上跑 `pic_image_search_worker.py --self-check`，把它的输出原样带回来。
 *
 * **不做任何润色或截断之外的处理**：那段输出是"库到底长什么样"的第一手材料，worker 头部
 * 4 张未验证的映射表要靠它对齐（例如 `search()` 的入参名、能否直接喂 bytes）。取 `stderr`
 * 优先，因为 `self_check()` 全打在 stderr（库缺失时返回 2）。
 */
export async function runSelfCheck(config: PythonPathConfig = {}, deps: ProbeDeps = {}): Promise<SelfCheckReport> {
  const started = Date.now();
  const { command, prefix } = resolvePythonCommand(config);
  const spawnFn = deps.spawn ?? (spawn as unknown as SpawnLike);
  const run = await runChild(
    command, [...prefix, PIC_IMAGE_SEARCH_SCRIPT, '--self-check'],
    deps.timeoutMs ?? SELF_CHECK_TIMEOUT_MS, spawnFn
  );
  const collected = (run.stderr.trim() || run.stdout.trim());
  const full: string[] = [];
  if (run.error) full.push(`无法启动 Python（${command}）：${run.error.message}`);
  if (run.timedOut) full.push(`自检 ${deps.timeoutMs ?? SELF_CHECK_TIMEOUT_MS}ms 内没有结束，已终止。`);
  if (run.code != null && run.code !== 0 && !run.timedOut) full.push(`退出码：${run.code}`);
  if (collected) full.push(collected);
  const joined = full.join('\n');
  const output = joined.length > MAX_OUTPUT_CHARS
    ? `${joined.slice(0, MAX_OUTPUT_CHARS)}\n…（输出已截断，原文共 ${joined.length} 字）`
    : joined;
  return {
    ok: !run.error && !run.timedOut && run.code === 0,
    exitCode: run.code, timedOut: run.timedOut, output,
    command, prefix, durationMs: Date.now() - started
  };
}
