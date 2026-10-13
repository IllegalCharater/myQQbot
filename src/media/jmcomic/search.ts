// 按关键词 / tag 搜索漫画（只搜索，不下载）。
//
// **为什么与下载分开**：搜索是廉价的只读操作，下载要过页数检查、拉全部图片、导出 PDF、
// 上传群文件（30 分钟超时且不可撤销）。合成一个动作等于"模型猜一个关键词"触发一次完整下载。
// 这里**只返回条目**，要不要下载由模型看过结果后再单独调 `enqueueJmcomicDownload` 决定 ——
// 与"工具不得代模型发言"是同一条取舍。

import { spawn } from 'node:child_process';
import { getConfig } from '../../core/config.js';
import { JMCOMIC_SCRIPT, resolvePythonCommand } from '../../core/python-runtime.js';
import { getRuntime } from './runtime.js';
import { ensureDirs } from './jobs.js';
import { parseResultFrame, PYTHON_MISSING_HINT } from './python.js';
import { errorMessage, isRecord } from './shared.js';
import type { JmSearchItem, JmSearchMode, JmSearchOrder, JmSearchOutput } from './types.js';

export const MAX_SEARCH_QUERY_CHARS = 100;
/** 一次返回多少条。上限与 Python 侧的 `MAX_SEARCH_RESULTS` 对齐。 */
export const MAX_SEARCH_LIMIT = 40;
/**
 * 搜索超时。**远短于下载的 30 分钟**：这是模型在等结果的同步调用，不是后台任务。
 * 实测一次搜索 1 秒上下，12 秒足够覆盖慢网络，再久就该如实报失败而不是让模型干等。
 */
const SEARCH_TIMEOUT_MS = 12_000;

// 两张白名单：Node 与 Python 两侧各校验一次（这些值会拼进查询串，透传等于让模型决定 URL 内容）。
const SEARCH_MODES: readonly JmSearchMode[] = ['keyword', 'tag', 'author', 'work', 'actor'];
const SEARCH_ORDERS: readonly JmSearchOrder[] = ['latest', 'view', 'picture', 'like', 'score', 'comment'];

function isJmSearchMode(value: unknown): value is JmSearchMode {
  return typeof value === 'string' && (SEARCH_MODES as readonly string[]).includes(value);
}

function isJmSearchOrder(value: unknown): value is JmSearchOrder {
  return typeof value === 'string' && (SEARCH_ORDERS as readonly string[]).includes(value);
}

/**
 * 跑一次搜索子进程并把结果帧解析出来。
 *
 * 与下载那条路的区别是刻意的：**不写 per-job 日志、不碰 `jobs`、不做心跳**。
 * 搜索结果没有留存价值（下次搜同一个词还要重新查），也不会被上传或被核验。
 */
function runPythonSearch(args: string[]): Promise<Record<string, unknown>> {
  ensureDirs();
  const { command, prefix } = resolvePythonCommand(getConfig());
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const spawnProcess = getRuntime()?.spawnProcess ?? spawn;
    const child = spawnProcess(command, [...prefix, JMCOMIC_SCRIPT, ...args], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* ignore */ }
      reject(new Error(`搜索超时（${SEARCH_TIMEOUT_MS / 1000} 秒），请稍后重试或换个关键词`));
    }, SEARCH_TIMEOUT_MS);
    timer.unref?.();
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    child.stdout.on('data', (chunk) => {
      stdout = (stdout + chunk.toString('utf8')).slice(-200_000);
      const frame = parseResultFrame(stdout);
      if (!frame) return;
      finish(() => {
        if (frame.ok) resolve(frame.payload);
        else reject(new Error(String(frame.payload.error || stderr.trim() || '搜索失败')));
      });
      // 结果帧已出，Python 的活干完了；收掉可能残留的后台线程。
      try { child.kill(); } catch { /* ignore */ }
    });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString('utf8')).slice(-20_000); });
    child.on('error', (error) => {
      // 解释器起不来时的错误必须点明"是解释器问题"，否则会被当成"搜不到"（同下载那条路）。
      finish(() => reject(new Error(`无法启动 Python（${command}）：${error.message}`)));
    });
    child.on('close', (code) => {
      finish(() => {
        const frame = parseResultFrame(stdout);
        if (frame?.ok) return resolve(frame.payload);
        const detail = String(stderr.trim() || `Python 异常退出（${code}）`);
        // 库缺失是很常见的一类失败，把可执行的下一步直接带上（否则用户只看到
        // "No module named 'jmcomic'"，不知道要用哪个解释器去装）。
        reject(new Error(detail.includes('No module named') ? `${PYTHON_MISSING_HINT}（原始错误：${detail}）` : detail));
      });
    });
  });
}

/**
 * 按关键词或 tag 搜索漫画。**只搜索，不下载。**
 *
 * 参数在这里做白名单校验（模式、排序），**不是**直接透传给库的魔法值：
 * 它们会拼进查询串，透传等于让模型决定 URL 内容。
 */
export async function searchJmcomic(input: {
  query: unknown;
  mode?: unknown;
  orderBy?: unknown;
  page?: unknown;
  limit?: unknown;
}): Promise<JmSearchOutput> {
  const query = String(input.query ?? '').trim();
  if (!query) throw new Error('搜索词不能为空');
  if (query.length > MAX_SEARCH_QUERY_CHARS) {
    throw new Error(`搜索词过长（上限 ${MAX_SEARCH_QUERY_CHARS} 字）`);
  }
  const rawMode = String(input.mode ?? 'keyword').trim().toLowerCase() || 'keyword';
  if (!isJmSearchMode(rawMode)) {
    throw new Error(`不支持的搜索范围：${rawMode}（可选：${SEARCH_MODES.join('、')}）`);
  }
  const rawOrder = String(input.orderBy ?? 'latest').trim().toLowerCase() || 'latest';
  if (!isJmSearchOrder(rawOrder)) {
    throw new Error(`不支持的排序方式：${rawOrder}（可选：${SEARCH_ORDERS.join('、')}）`);
  }
  const page = Math.max(1, Math.trunc(Number(input.page) || 1));
  const limit = Math.min(MAX_SEARCH_LIMIT, Math.max(1, Math.trunc(Number(input.limit) || 10)));

  const payload = await runPythonSearch([
    'search', query, '--mode', rawMode, '--orderBy', rawOrder, '--page', String(page), '--limit', String(limit)
  ]);

  const items: JmSearchItem[] = Array.isArray(payload.items)
    ? payload.items.map((item) => {
        const record = isRecord(item) ? item : {};
        return {
          comicId: String(record.comicId ?? ''),
          title: String(record.title ?? ''),
          tags: Array.isArray(record.tags) ? record.tags.map((tag) => String(tag)) : []
        };
      }).filter((item) => item.comicId !== '')
    : [];

  return { mode: rawMode, query, orderBy: rawOrder, page, total: Number(payload.total) || 0, items };
}
