import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Reply } from './types.js';

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function readBody(req: IncomingMessage): Promise<unknown> {
  let raw = '';
  for await (const chunk of req) raw += String(chunk);
  return raw ? JSON.parse(raw) : {};
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function writeReply(res: ServerResponse, reply: Reply): void {
  if (reply.kind === 'empty') {
    res.writeHead(reply.status, reply.headers);
    res.end();
    return;
  }
  if (reply.kind === 'binary') {
    res.writeHead(reply.status, reply.headers);
    res.end(reply.body);
    return;
  }
  res.writeHead(reply.status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...reply.headers,
  });
  res.end(JSON.stringify(reply.body));
}
