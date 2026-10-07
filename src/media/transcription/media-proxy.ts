// SSRF 安全的本机流式代理。
//
// FFmpeg **从不**直接访问上游 URL。它只访问本机这个一次性地址；代理对原始 URL 与每次
// 重定向逐跳校验、固定已校验的 DNS 结果并流式转发。因此既不落完整视频，也不会因为
// FFmpeg 自己跟随重定向而绕过 SSRF 防护。
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { openSafeStream, validateFetchUrl } from '../safe-fetch.js';
import type { MediaSource } from '../media-source/index.js';

export interface MediaProxy {
  url: string;
  close(): Promise<void>;
}

/**
 * 起一个只转发 `source.url` 的本机代理，返回它的 URL 与关闭函数。
 *
 * `token` 是随机 UUID 且只接受它：这个端口虽然只监听 127.0.0.1，但同机其他进程也能访问，
 * 没有 token 就等于给了它们一个"任意抓取"的入口。
 */
export async function createMediaProxy(source: MediaSource, signal: AbortSignal, maxBytes: number): Promise<MediaProxy> {
  // 启动监听前先完成一次 DNS 校验，让明显不可访问/内网目标尽早失败。
  await validateFetchUrl(source.url);
  const token = randomUUID();
  let transferred = 0;
  const active = new Set<http.IncomingMessage>();
  const server = http.createServer(async (req, res) => {
    if (req.url !== `/${token}` || (req.method !== 'GET' && req.method !== 'HEAD')) {
      res.writeHead(404).end();
      return;
    }
    try {
      const forwarded: Record<string, string> = { ...(source.headers || {}) };
      if (typeof req.headers.range === 'string') forwarded.range = req.headers.range;
      if (typeof req.headers['if-range'] === 'string') forwarded['if-range'] = req.headers['if-range'];
      const opened = await openSafeStream(source.url, {
        method: req.method as 'GET' | 'HEAD', headers: forwarded, signal
      });
      const upstream = opened.response;
      active.add(upstream);
      const responseHeaders: Record<string, string | number> = {};
      for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']) {
        const value = upstream.headers[name];
        if (typeof value === 'string') responseHeaders[name] = value;
      }
      res.writeHead(upstream.statusCode || 200, responseHeaders);
      if (req.method === 'HEAD') {
        upstream.resume();
        res.end();
      } else {
        const limiter = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            transferred += chunk.length;
            if (transferred > maxBytes) callback(new Error('SOURCE_TOO_LARGE'));
            else callback(null, chunk);
          }
        });
        await pipeline(upstream, limiter, res);
      }
      active.delete(upstream);
    } catch {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }).end('upstream unavailable');
      else res.destroy();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('PROXY_LISTEN_FAILED');
  return {
    url: `http://127.0.0.1:${address.port}/${token}`,
    close: () => new Promise<void>((resolve) => {
      for (const response of active) response.destroy();
      server.close(() => resolve());
      server.closeAllConnections?.();
    })
  };
}
