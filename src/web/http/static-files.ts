import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

export function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string, uiDir: string): boolean {
  if (req.method !== 'GET') return false;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Bad Request');
    return true;
  }
  const parts: string[] = [];
  let blocked = false;
  for (const part of decoded.replace(/^[/\\]+/, '').split(/[/\\]+/)) {
    if (!part || part === '.') continue;
    if (part === '..' || /[\0-\x1f]/.test(part)) { blocked = true; break; }
    parts.push(part);
  }
  if (blocked || parts.length === 0) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return true;
  }
  const root = path.resolve(uiDir);
  const file = path.resolve(root, ...parts);
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return true;
  }
  try {
    const data = fs.readFileSync(file);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  }
  return true;
}
