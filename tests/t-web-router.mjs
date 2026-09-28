import { Readable } from 'node:stream';
import { load } from './lib/src.mjs';
import { checker } from './lib/harness.mjs';

const { ok, done, counts } = checker();
const { matchRoute, dispatchRoute } = await load('web/http/router.js');
const { readBody, writeReply } = await load('web/http/http.js');

const noop = async () => ({ status: 200, body: { ok: true } });
const routes = [
  { method: 'GET', path: '/same', handle: noop },
  { method: 'POST', path: '/same', handle: noop },
  { method: 'GET', path: /^\/items\/(\d+)$/, handle: noop },
];

ok('精确路径按方法匹配', matchRoute(routes, 'POST', '/same')?.route === routes[1]);
ok('方法不匹配不返回 405 伪结果', matchRoute(routes, 'DELETE', '/same') === null);
ok('正则路由保留完整捕获组', matchRoute(routes, 'GET', '/items/42')?.match?.[1] === '42');
ok('未知路径不匹配', matchRoute(routes, 'GET', '/missing') === null);

const dispatched = await dispatchRoute(routes, {}, { method: 'GET' }, new URL('http://local/items/7'));
ok('派发器执行匹配 handler', dispatched?.status === 200);

const valid = Readable.from(['{"x":1}']);
ok('readBody 解析 JSON', (await readBody(valid)).x === 1);
const empty = Readable.from([]);
ok('readBody 将空请求体归一化为空对象', Object.keys(await readBody(empty)).length === 0);
const invalid = Readable.from(['{']);
ok('readBody 对非法 JSON 保持抛错', await readBody(invalid).then(() => false, () => true));

function capture() {
  return {
    status: 0, headers: {}, chunks: [],
    writeHead(status, headers = {}) { this.status = status; this.headers = headers; },
    end(chunk) { if (chunk !== undefined) this.chunks.push(chunk); },
  };
}
const json = capture();
writeReply(json, { status: 201, body: { ok: true } });
ok('JSON reply 统一写状态与 JSON 内容', json.status === 201 && String(json.chunks[0]) === '{"ok":true}');
const binary = capture();
writeReply(binary, { kind: 'binary', status: 200, body: Buffer.from('image'), headers: { 'content-type': 'image/png' } });
ok('二进制 reply 不做 JSON 编码', binary.status === 200 && Buffer.from(binary.chunks[0]).toString() === 'image');
const emptyReply = capture();
writeReply(emptyReply, { kind: 'empty', status: 204 });
ok('空 reply 不写响应体', emptyReply.status === 204 && emptyReply.chunks.length === 0);

done();
if (counts.fail) process.exit(1);
