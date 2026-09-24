// 套件公用零件。
//
// 只放"新套件一定会要、或者已经被两份以上套件重复写了一遍"的东西；各套件自己的
// 夹具（假的 memory / stickers / onebot 对象之类）留在各自文件里，别往这儿塞。
//
// 现存 21 个套件里，有些是自己手写 ok() 的老写法（它们是从 %TEMP% 原样搬进来的，
// 为了不在这道"安全网本身"上做无谓的改动，没有回改成这里的 checker）。
// **新写的套件一律用这里的 checker()**，别再加第 N 份 ok()。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';

/**
 * 断言计数器。用法：
 *   const { ok, done } = checker();
 *   ok('名字', cond, '失败时附加的信息');
 *   process.exit(done() ? 0 : 1);      // done() 顺手打印汇总
 */
export function checker() {
  const counts = { pass: 0, fail: 0 };
  const ok = (name, cond, extra = '') => {
    if (cond) { counts.pass++; console.log(`  ✅ ${name}`); }
    else { counts.fail++; console.log(`  ❌ ${name}${extra ? `  ← ${extra}` : ''}`); }
  };
  const done = () => {
    console.log(`\n${counts.fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：${counts.pass} 通过 / ${counts.fail} 失败`);
    return counts.fail === 0;
  };
  return { ok, done, counts };
}

// ── 临时数据目录 ──
const tmpDirs = [];
process.on('exit', () => {
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});

/**
 * 造一个临时数据目录并把它设成 QQ_AGENT_DATA_DIR。
 *
 * ⚠️ 必须在 load() 任何模块**之前**调用：config.js 在加载时就把 DATA_DIR 定死。
 * 晚一步，测试就往真数据目录（真聊天记录、真表情包、真 API key）里写了。
 * 退出时自动删。
 */
export function dataDir(prefix = 'qqagent-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  process.env.QQ_AGENT_DATA_DIR = dir;
  return dir;
}

// ── 假图床 ──
/** 1×1 PNG，魔数齐全，够 detectMime 认出 image/png。 */
export const PNG_1X1 = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
  '1f15c4890000000a49444154789c6300010000050001' +
  '0d0a2db40000000049454e44ae426082', 'hex');

/**
 * 只认 /ok.png 的假图床，其余一律 404（用来验"取图失败"那条分支）。
 * 返回 { base, png, close }。
 */
export async function fakeImageServer({ png = PNG_1X1, path: p = '/ok.png' } = {}) {
  const srv = http.createServer((req, res) => {
    if (req.url === p) { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(png); }
    res.writeHead(404); res.end('nope');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return {
    base: `http://127.0.0.1:${srv.address().port}`,
    png,
    close() { srv.close(); srv.closeAllConnections?.(); }
  };
}

// ── 假模型端点 ──
/**
 * OpenAI 兼容的假端点：按 script 队列依次吐响应，并把收到的请求体全存下来。
 *
 *   const ep = await fakeModelServer();
 *   updateConfig({ api: { baseUrl: ep.url, model: 'stub-vision' } });
 *   ep.script = [{ tool_calls: [toolCall('send_message', {...})] }, { content: '好' }];
 *   ...跑一轮...
 *   ep.requests[0].messages   // 断言"图片真的作为图像输入发出去了"
 *
 * script 里一项形如 `{ content, tool_calls }`；队列空了就当"模型什么都不说、
 * 也不调工具"（会把整轮跑停）。`toolCall()` 是拼 tool_calls 的小 helper。
 */
export async function fakeModelServer({ model = 'stub', delayMs = 0 } = {}) {
  const st = { script: [], requests: [], served: 0 };
  const srv = http.createServer((req, res) => {
    if (!req.url.endsWith('/chat/completions')) { res.writeHead(404); return res.end('nope'); }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch {}
      st.requests.push(parsed);
      st.served++;
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      const next = st.script.shift() || { content: null, tool_calls: [] };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        model,
        choices: [{
          index: 0,
          finish_reason: next.tool_calls?.length ? 'tool_calls' : 'stop',
          message: { role: 'assistant', content: next.content ?? null, tool_calls: next.tool_calls }
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return {
    get base() { return `http://127.0.0.1:${srv.address().port}`; },
    get url() { return `${this.base}/v1`; },
    state: st,
    get script() { return st.script; },
    set script(v) { st.script = v; },
    get requests() { return st.requests; },
    set requests(v) { st.requests = v; },
    close() { srv.close(); srv.closeAllConnections?.(); }
  };
}

/** 拼一个 OpenAI 形状的 tool_call。 */
export const toolCall = (name, args, id) => ({
  id, type: 'function', function: { name, arguments: JSON.stringify(args) }
});

/**
 * 等这一轮 agent 彻底跑完，返回留档后的会话对象（读它的 messages 看记录）。
 *
 * 两个坑，都踩过：
 *  1. sessions.finish() 会把会话从 sessions.current 移走（只留
 *     data/sessions/<id>.json），所以不能只看 current —— 留档要按 id 从 get() 读。
 *  2. 假端点 + 本地假图床下一轮只要几毫秒，轮询 current 会**整个错过**这次运行，
 *     于是"没抓到会话"和"真的没记录"分不清。所以改成听 session-end 事件拿 id。
 *
 * @param sessions SessionRegistry
 * @param ended    套件在 emit 里收下的 session-end payload 数组
 */
export async function readArchivedSession(sessions, ended, { timeoutMs = 8000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (ended.length) {
      const s = sessions.get(ended[ended.length - 1].sessionId);
      if (s) return s;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  return null;
}

// ── vm 里的假 DOM ──
/**
 * ui/app.js 是 classic script，没有 DOM 就得整份丢进 vm 里跑。这里手搓一层最小壳：
 * 只实现 app.js 真正用到的方法，**没实现的就让它抛错**——那正是"用了壳里没有的
 * 能力"的信号，不该被静默吞掉。
 *
 * 返回 { sandbox, ctx, doc, el }：
 *   sandbox  全局对象，也是 vm 的 globalThis（`globalThis.x = ...` 会挂在这上面）
 *   ctx      vm context，喂给 vm.runInContext
 *   el(sel)  按选择器取假节点；同一选择器每次拿到同一个对象，方便事后读 innerHTML
 *
 * querySelectorAll 一律返回空数组：app.js 拿它取"刚渲染出来的节点"再绑事件，
 * 那部分没有真 DOM 验不了，但不影响"拼出来的 HTML 对不对"。
 */
export function createDomSandbox() {
  function mkEl(tag = 'div') {
    return {
      tagName: String(tag).toUpperCase(), nodeName: String(tag).toUpperCase(),
      children: [], dataset: {}, style: {}, hidden: false, disabled: false,
      _html: '', textContent: '', value: '', selectionStart: 0, id: '',
      classList: {
        _s: new Set(),
        add(...c) { c.forEach((x) => this._s.add(x)); },
        remove(...c) { c.forEach((x) => this._s.delete(x)); },
        toggle(c, on) { if (on === undefined) on = !this._s.has(c); on ? this._s.add(c) : this._s.delete(c); return on; },
        contains(c) { return this._s.has(c); }
      },
      addEventListener() {}, removeEventListener() {},
      appendChild(c) { this.children.push(c); return c; },
      removeChild() {}, remove() {}, insertBefore() {},
      contains() { return false; }, closest() { return null; },
      focus() {}, blur() {}, click() {},
      setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
      setSelectionRange() {}, scrollIntoView() {},
      querySelector() { return null; }, querySelectorAll() { return []; },
      get innerHTML() { return this._html; },
      set innerHTML(v) { this._html = String(v); }
    };
  }

  const selCache = new Map();
  const doc = {
    documentElement: mkEl('html'), body: mkEl('body'), head: mkEl('head'),
    activeElement: null, title: '',
    createElement: (t) => mkEl(t), createTextNode: (t) => ({ textContent: String(t) }),
    createDocumentFragment: () => mkEl('fragment'),
    addEventListener() {}, removeEventListener() {},
    querySelector(sel) { if (!selCache.has(sel)) selCache.set(sel, mkEl('div')); return selCache.get(sel); },
    querySelectorAll() { return []; },
    getElementById(id) { return this.querySelector('#' + id); }
  };

  const store = new Map();
  const sandbox = {
    document: doc, console,
    window: { matchMedia: () => ({ matches: false, addEventListener() {} }), addEventListener() {}, location: {} },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k)
    },
    location: { href: 'http://127.0.0.1/', search: '', hash: '', reload() {} },
    navigator: { userAgent: 'node' },
    alert: () => {}, confirm: () => true, prompt: () => null,
    // 启动阶段让所有请求永远挂起：既不发真请求，也不会让 boot 的 await 链往下走
    // （真跑起来会去拉 /api/config 然后改 state，把测试要用的干净状态弄脏）。
    fetch: () => new Promise(() => {}),
    EventSource: class { constructor() { this.readyState = 0; } addEventListener() {} close() {} },
    setInterval: () => 0, clearInterval: () => {},
    setTimeout: () => 0, clearTimeout: () => {},
    requestAnimationFrame: () => 0
  };

  return {
    sandbox,
    ctx: vm.createContext(sandbox),
    doc,
    el: (sel) => doc.querySelector(sel)
  };
}
