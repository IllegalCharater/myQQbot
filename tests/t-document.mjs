// 读文档（pdf / docx / txt / md）的能力与它的工具。
//
// ── 这一套件最关键的一条纪律：**绝不启动真解释器** ──
//
// 抽取那一头是 Python。真去 spawn 的话，套件的红绿就由"这台机器装没装 Python、装没装 pypdf"
// 决定 —— 而"套件绿"从此不再意味着代码对（本机恰好没装就全红，装了就成了环境在测）。
// 所以 Node 侧的**子进程是假的**（普通对象字面量，`DocumentChild` 是最小结构类型，
// 没有 instanceof、没有运行期校验），与 `core/python-probe.ts` / `t-jmcomic.mjs` 同一手法。
// **真解释器那一段是人工冒烟项**，写在 AGENTS.md 的已知边界里。
//
// Python 自身的逻辑因此只能从**源码文本**上守（同 `t-image-source.mjs` 第 ⑩ 段对
// `pic_image_search_worker.py` 的做法）—— 这些断言的前提是 `document_extract.py` 里
// 那几条判据**锚定到具体调用**而不是裸字段名，否则把代码删掉、注释里还留着名字，断言照样绿。
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { checker, dataDir } from './lib/harness.mjs';
import { ROOT, load } from './lib/src.mjs';

// 临时数据目录必须先于任何 load：config.js 在模块加载那一刻就把 DATA_DIR 定死了。
dataDir('qqagent-document-');

const { ok, done } = checker();
const { DocumentError } = await load('media/document/index.js');
const { extractDocumentText, MAX_DOCUMENT_CHARS } = await load('media/document/index.js');
const { parseResultFrame } = await load('media/document/python.js');
const { documentTools } = await load('agent/tools/document.js');
const { buildToolDefs } = await load('agent/tools/index.js');
const { PROMPT_CATALOG } = await load('core/prompt-catalog.js');
const { DOCUMENT_SCRIPT } = await load('core/python-runtime.js');
const { updateConfig, getConfig } = await load('core/config.js');

const PREFIX = '__QQ_AGENT_RESULT__';
const frame = (payload) => `${PREFIX}${JSON.stringify(payload)}\n`;

/**
 * 一个假子进程。`stdin.end` 被调用时**同步**把预设的 stdout/事件吐出来 ——
 * 被测代码注册监听器在 `end` 之前，所以同步吐是安全的，且省掉一堆等待。
 */
function fakeChild({ stdout = '', stderr = '', exitCode = 0, error = null, silence = false } = {}) {
  const data = [];
  const errs = [];
  const closes = [];
  let stderrFn = null;
  const child = {
    killed: false,
    written: null,
    stdin: {
      end(chunk) {
        child.written = Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk ?? []);
        if (silence) return;
        if (stderr && stderrFn) stderrFn(Buffer.from(stderr, 'utf8'));
        if (stdout) for (const fn of data) fn(Buffer.from(stdout, 'utf8'));
        if (error) for (const fn of errs) fn(error);
        else for (const fn of closes) fn(exitCode);
      }
    },
    stdout: { on: (event, fn) => { if (event === 'data') data.push(fn); return child.stdout; } },
    stderr: { on: (event, fn) => { if (event === 'data') stderrFn = fn; return child.stderr; } },
    on: (event, fn) => {
      if (event === 'error') errs.push(fn);
      if (event === 'close') closes.push(fn);
      return child;
    },
    kill() { child.killed = true; return true; }
  };
  return child;
}

/** 装一次假子进程，返回它收到的 (command, args, options)。 */
function spawnWith(child) {
  const calls = [];
  const spawnFn = (command, args, options) => {
    calls.push({ command, args: [...args], options });
    return child;
  };
  // 让 `python.path` 指向一个**写着路径**的假解释器：断言里就能看见"实际用的是哪个命令"
  // （那条"解释器可能来自四条链里任意一条"的报错，靠的就是它）。
  updateConfig({ python: { path: 'X:/fake/python.exe' } });
  return { spawnFn, calls };
}

// ── 1. 抽取管线：帧 → 结果、失败 → DocumentError ─────────────────────────────
{
  const child = fakeChild({ stdout: frame({ ok: true, format: 'pdf', text: '正文', chars: 12, truncated: true, pages: 3 }) });
  const { spawnFn, calls } = spawnWith(child);
  const doc = await extractDocumentText(Buffer.from('hello'), { spawn: spawnFn });

  ok('正常帧被翻译成 DocumentText（format / pages / chars / truncated 一个不少）',
    doc.format === 'pdf' && doc.pages === 3 && doc.chars === 12 && doc.truncated === true && doc.text === '正文',
    JSON.stringify(doc));
  ok('**喂给 Python 的就是那一段字节**（逐字节相同，没有编码/换行上的手脚）',
    Buffer.compare(child.written, Buffer.from('hello')) === 0, String(child.written));
  ok('argv 里只有脚本与 --max-chars，**没有任何用户内容**（文件名/URL/正文都不进命令行）',
    calls[0].args.length === 3 && calls[0].args[1] === '--max-chars'
    && calls[0].args[0] === DOCUMENT_SCRIPT, JSON.stringify(calls[0].args));
  ok('用的是解析链给出的那份解释器（报错文案要靠它说清"实际跑的是哪个"）',
    calls[0].command === 'X:/fake/python.exe', calls[0].command);
  ok('抽完就把子进程收掉（Python 那份不留后台进程）', child.killed === true);

  // `encoding` 只在文本格式时才有；没有的键**不该凭空出现**（判据是"字段在不在"，
  // 同 image-source 的 `similarity` / `time` 那条规矩 —— 兜一个默认值等于替对方编了个它没说过的数）。
  const plain = await extractDocumentText(Buffer.from('x'), {
    spawn: spawnWith(fakeChild({ stdout: frame({ ok: true, format: 'text', text: 'a', chars: 1, truncated: false }) })).spawnFn
  });
  ok('Python 没给的字段不凭空补上（pdf 那份没有 encoding、txt 那份没有 pages）',
    !('encoding' in doc) && !('pages' in plain),
    `${JSON.stringify(doc)} / ${JSON.stringify(plain)}`);
}

// ── 2. 失败要说清是哪一种 ───────────────────────────────────────────────────
{
  const raises = async (childOptions, options = {}, label, check) => {
    const child = fakeChild(childOptions);
    const { spawnFn } = spawnWith(child);
    try {
      await extractDocumentText(Buffer.from('x'), { spawn: spawnFn, ...options });
      ok(label, false, '居然没抛');
    } catch (error) {
      ok(label, error instanceof DocumentError && check(error), `${error?.code} ${error?.message}`);
    }
  };

  await raises({ stdout: frame({ ok: false, error: '这份 PDF 加了密码，读不了它的正文' }) }, {},
    'Python 报错 → DocumentError（文案原样带出来，不是一句"读取失败"）',
    (error) => error.code === 'EXTRACT_FAILED' && /加了密码/.test(error.message));

  await raises({ stdout: frame({ ok: false, error: '未装 pypdf：pip install -r python-tools/requirements.txt', code: 'MISSING_PDF_LIB' }) }, {},
    '**缺库单列一档**：code 透传（"装完就能读"与"这份文件读不了"是两件事，合成一档用户会反复重传）',
    (error) => error.code === 'MISSING_PDF_LIB' && /pip install/.test(error.message));

  await raises({ error: new Error('spawn ENOENT') }, {},
    '起不来进程 → PYTHON_SPAWN，且文案里有**实际用的那个命令**',
    (error) => error.code === 'PYTHON_SPAWN' && /X:\/fake\/python\.exe/.test(error.message) && /ENOENT/.test(error.message));

  await raises({ exitCode: 2, stderr: 'SyntaxError: invalid syntax' }, {},
    '没有结果帧就退出 → PYTHON_NO_FRAME，并把 stderr 带出来（否则只剩一个退出码）',
    (error) => error.code === 'PYTHON_NO_FRAME' && /SyntaxError/.test(error.message));

  await raises({ silence: true }, { timeoutMs: 30 },
    '不吐任何东西 → 到点判超时，并杀掉子进程（一次工具调用不能被挂死）',
    (error) => error.code === 'EXTRACT_TIMEOUT' && /秒/.test(error.message));

  await raises({ stdout: frame({ ok: true, format: 'markdown', text: 'x', chars: 1, truncated: false }) }, {},
    'Python 回了不认识的格式 → BAD_FRAME（不猜一个默认格式糊过去，那会让版本不一致永远没人发现）',
    (error) => error.code === 'BAD_FRAME');

  // 空字节在**这一层**就拦下，连进程都不起 —— 那是零成本校验该有的位置。
  {
    const child = fakeChild({ stdout: frame({ ok: true, format: 'text', text: 'x', chars: 1, truncated: false }) });
    const { spawnFn, calls } = spawnWith(child);
    try {
      await extractDocumentText(Buffer.alloc(0), { spawn: spawnFn });
      ok('空文件当场拒（不起进程）', false, '居然没抛');
    } catch (error) {
      ok('空文件当场拒（不起进程）', error.code === 'EMPTY' && calls.length === 0, `${error.code} calls=${calls.length}`);
    }
  }
}

// ── 3. 结果帧的读法：stdout 会任意分块，只看最后一帧 ─────────────────────────
{
  ok('帧不在末尾时找得到（前面可能混着别的输出）',
    parseResultFrame(`噪声\n${PREFIX}{"ok":true,"text":"a","chars":1}`)?.text === 'a');
  ok('只认**最后**一帧（中途的进度帧不该赢）',
    parseResultFrame(`${PREFIX}{"ok":true,"text":"旧","chars":1}\n${PREFIX}{"ok":true,"text":"新","chars":1}`)?.text === '新');
  ok('JSON 还没收全 → null（等下一块，而不是当成失败）', parseResultFrame(`${PREFIX}{"ok":tr`) === null);
  ok('压根没有帧 → null', parseResultFrame('随便什么输出') === null);
  ok('帧是数组/标量时也当"没收到"（形状不对不该当成数据）',
    parseResultFrame(`${PREFIX}[1,2]`) === null && parseResultFrame(`${PREFIX}42`) === null);
}

// ── 4. `read_document` 工具 ─────────────────────────────────────────────────
const ctxFor = ({ chatKey = 'group:1', entries = [], found = null } = {}) => ({
  chatKey,
  triggerEntries: entries,
  store: { findByMid: () => found, recent: () => [] }
});

const fileMedia = (over = {}) => ({ kind: 'file', name: '灯塔.pdf', file: '灯塔.pdf', url: 'http://x/y.pdf', ...over });
const fakeDoc = { format: 'pdf', text: '灯塔三年前就废弃了。', chars: 11, truncated: false, pages: 2 };

/** 装一个"不碰 Python"的工具集：抽取换成假的，字节仍走真的 `safeFetchBinary`（回环）。 */
const toolWith = (extract) => {
  const tool = documentTools({ extract }).find((item) => item.name === 'read_document');
  return (ctx, args) => tool.execute(ctx, args);
};
const bodyOf = (result) => String(result.content);

{
  const call = toolWith(async () => fakeDoc);

  ok('两个都不给 → 明说要给一个', /messageId/.test(bodyOf(await call(ctxFor(), {}))) && /url/.test(bodyOf(await call(ctxFor(), {}))));
  ok('两个都给 → 明说只能给一个', /只能给一个/.test(bodyOf(await call(ctxFor(), { messageId: 1, url: 'http://x' }))));

  const missing = await call(ctxFor(), { messageId: 4242 });
  ok('消息找不到时报错，并把可见的 id 提示带上（免得模型接着瞎猜）',
    /找不到消息 4242/.test(bodyOf(missing)) && /没有带 #id 的消息/.test(bodyOf(missing)), bodyOf(missing));

  const empty = await call(ctxFor({ found: { mid: '7', media: [] } }), { messageId: 7 });
  ok('那条消息里没有文件 → 明说 + 给出下一步（不是一句"失败"）',
    /没有可读的文件/.test(bodyOf(empty)) && /发到群里/.test(bodyOf(empty)), bodyOf(empty));

  // 顺带：那条消息**引用了**另一条、而两条都没有文件时，报错要说清"引用的那条也没有"
  // （否则模型会以为回退没生效，接着拿同一个 id 重试）。真正"回退成功"的那条在下面 ——
  // 它要拿到字节才算数，所以与回环服务放在一起。
  const bothEmpty = await call(ctxFor({
    found: { mid: '20', media: [], reply: { mid: '10', sender: '甲', text: '' } }
  }), { messageId: 20 });
  ok('回退也找不到时说清"引用的那条里也没有"（免得模型拿同一个 id 重试）',
    /没有可读的文件/.test(bodyOf(bothEmpty)) && /#10/.test(bodyOf(bothEmpty)), bodyOf(bothEmpty));
}

// ── 5. 真字节那条路（回环 HTTP）+ 结果表头 ──────────────────────────────────
{
  const PNG = Buffer.from('这是个假文档，但字节是真的');
  const server = http.createServer((req, res) => {
    if (req.url === '/ok.bin') { res.writeHead(200, { 'content-type': 'application/octet-stream' }); return res.end(PNG); }
    res.writeHead(404); res.end('nope');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  // 回环地址默认被 SSRF 挡掉（那是安全的那一侧，不是漏掉）—— 这里临时开一下，
  // 跑完立刻复原。先例是 `t-image-source.mjs` 第 ② 段。
  const before = getConfig().security?.allowPrivateImageHosts;
  updateConfig({ security: { allowPrivateImageHosts: true } });
  try {
    const call = toolWith(async (buffer) => {
      // 抽取实现是假的，但**喂给它的字节是真的**：这条断言因此能证明"下载真的发生了"。
      return { format: 'text', text: `读到 ${buffer.length} 字节`, chars: buffer.length, truncated: false };
    });

    const hit = await call(ctxFor({ chatKey: 'group:901', found: { mid: '7', media: [fileMedia({ url: `${base}/ok.bin` })] } }), { messageId: 7 });
    ok('走 messageId 时真的把字节取回来了（下载 + 抽取被接起来了）',
      !hit.isError && bodyOf(hit).includes(`读到 ${PNG.length} 字节`), bodyOf(hit));

    const urlHit = await call(ctxFor({ chatKey: 'group:902' }), { url: `${base}/ok.bin` });
    ok('url 那条入口走的是同一条路（两个入口共用一份实现）',
      !urlHit.isError && bodyOf(urlHit).includes(`${PNG.length} 字节`), bodyOf(urlHit));

    const bad = await call(ctxFor({ chatKey: 'group:903' }), { url: `${base}/nope.bin` });
    ok('取字节失败时把 HTTP 状态说出来', bad.isError && /404/.test(bodyOf(bad)), bodyOf(bad));

    // 表头：模型要能从结果里读出"这是什么格式、多长、有没有被截断"。
    const head = toolWith(async () => ({ format: 'pdf', text: '正文', chars: 9999, truncated: true, pages: 12 }));
    const shown = await head(ctxFor({ chatKey: 'group:904' }), { url: `${base}/ok.bin` });
    ok('表头写明来源、格式、页数与**总字数**（截断了要说出来，否则模型以为就到这儿了）',
      /PDF/.test(bodyOf(shown)) && /12 页/.test(bodyOf(shown)) && /共 9999 字/.test(bodyOf(shown))
      && /以上只是开头/.test(bodyOf(shown)), bodyOf(shown).split('\n')[0]);

    const gbkDoc = toolWith(async () => ({ format: 'text', text: '正文', chars: 2, truncated: false, encoding: 'gbk' }));
    const gbkShown = await gbkDoc(ctxFor({ chatKey: 'group:905' }), { url: `${base}/ok.bin` });
    ok('按非 UTF-8 解码时**在表头点名**（那是我们替它猜的一档，不能默默做）',
      /按 gbk 解码/.test(bodyOf(gbkShown)), bodyOf(gbkShown).split('\n')[0]);

    // 本轮快照优先：模型作出工具决定前可能已经过了很久，实时存档可能因容量裁剪/删除而失去这条。
    // 夹具让 `store.findByMid` 返回 null、只有 `triggerEntries` 里那条 —— 走的是真实代码路径，
    // 不是"我以为的优先顺序"（同 `keepSessionFiles` 那条教训：别拿"我以为的时机"当断言）。
    const snapshotOnly = await toolWith(async () => fakeDoc)(
      { chatKey: 'group:906', triggerEntries: [{ mid: '31', media: [fileMedia({ url: `${base}/ok.bin` })] }], store: { findByMid: () => null, recent: () => [] } },
      { messageId: 31 }
    );
    ok('本轮快照里的文件读得到（哪怕实时存档里已经找不到了）',
      !snapshotOnly.isError && bodyOf(snapshotOnly).includes('灯塔三年前就废弃了。'), bodyOf(snapshotOnly));

    // **顺着 reply.mid 回退**：群友把文件发上来、再引用它说一句话，模型手里那条（引用的）
    // 消息上是没有文件的。这与 `get_message_images` 那个 bug 是同一个病的两种形态。
    //
    // 夹具刻意让"被引用的那条"只存在于**存档**里（`findByMid('10')`），问的那条只在
    // `triggerEntries` 里 —— 两条路都真的走到了，才谈得上验回退。
    const quoting = (reply) => {
      const ctx = ctxFor({ chatKey: 'group:907' });
      ctx.triggerEntries = [{ mid: '20', media: [], ...(reply ? { reply } : {}) }];
      ctx.store = {
        // ⚠️ 真实签名是 `findByMid(chatKey, mid)` —— 首参是会话键。写成 `(mid) => …` 会让
        // 判断永远落在会话键上，回退那一条于是**静默失效**（本套件初版就是这么假红的）。
        findByMid: (_chatKey, mid) => (String(mid) === '10'
          ? { mid: '10', media: [fileMedia({ url: `${base}/ok.bin` })] }
          : null),
        recent: () => []
      };
      return ctx;
    };
    const quoted = await toolWith(async () => fakeDoc)(quoting({ mid: '10', sender: '甲', text: '' }), { messageId: 20 });
    ok('引用着文件的消息也能读（顺着 reply.mid 回退，同 get_message_images 那条纪律）',
      !quoted.isError && bodyOf(quoted).includes('灯塔三年前就废弃了。'), bodyOf(quoted));
    ok('走回退时**点名文件来自哪条消息**（不点明模型会把归属配错）',
      /消息 #10/.test(bodyOf(quoted)), bodyOf(quoted).slice(0, 80));

    // 对照：同一套夹具、只是那条消息**不引用任何东西** —— 它必须报"没有可读的文件"，
    // 否则上面两条红的可能性等于零，那是假绿。判据用文案而不是 `isError`：
    // "这条消息里没有文件"是一条**正常答复**（同 `get_message_images` 的"没有可查看的图片"），
    // 走的是 `ok()` 而不是 `err()`。
    const noQuote = await toolWith(async () => fakeDoc)(quoting(null), { messageId: 20 });
    ok('对照：不引用任何东西时读不到（上面两条才不是假绿）',
      /没有可读的文件/.test(bodyOf(noQuote)), bodyOf(noQuote));
  } finally {
    updateConfig({ security: { allowPrivateImageHosts: before === true } });
    server.close();
    server.closeAllConnections?.();
  }
}

// ── 6. Python 侧只能从源码守（真解释器是人工冒烟项）──────────────────────────
{
  const py = fs.readFileSync(path.join(ROOT, 'python-tools', 'document_extract.py'), 'utf8');

  // 嗅探的**顺序**就是语义：PDF 魔数必须排在"NUL 判文本"之前 —— 反过来的话，一份正文里
  // 恰好含 NUL 的 PDF 会被当成二进制拒掉，而报错指向"这不是文本"。同一类顺序错误在
  // `judgeTemplate` 那里也踩过一次（「认 JSON 要排在认 HTML 之前」）。
  const atPdf = py.indexOf('b"%PDF-"');
  // 找 `OLE2_MAGIC` 的**使用处**而不是常量定义处 —— 定义在文件顶部，拿它比顺序会永远通过。
  const atOle = py.indexOf('startswith(OLE2_MAGIC)');
  const atZip = py.indexOf('b"PK\\x03\\x04"');
  const atNul = py.indexOf('b"\\x00" in data');
  ok('嗅探顺序：PDF 魔数 → OLE2 → ZIP → 最后才是"NUL 判文本"',
    atPdf > 0 && atOle > atPdf && atZip > atOle && atNul > atZip, `pdf=${atPdf} ole=${atOle} zip=${atZip} nul=${atNul}`);

  ok('旧版 .doc（OLE2）有**专门**一句话（"另存为 .docx"），不是笼统的"不支持"',
    /另存为 \.docx/.test(py));

  // 三条编码判据（这一套原先在 `extra/trpg/scenario.ts` 的 `decodeScenarioFile` 里，
  // 2026-10-16 随抽取一起搬进 Python）。**判据必须同时看绝对量与占比**：
  // 只看占比会把"恰好含一两个坏字节的短文件"误杀，只看绝对量会放过一篇短乱码。
  ok('编码阶梯是 utf-8 → gbk（**只在前一档明确失败时才试下一档**）',
    /ENCODINGS = \("utf-8", "gbk"\)/.test(py) && /for encoding in ENCODINGS/.test(py));
  ok('乱码判据同时要"绝对量"与"占比"两条',
    /broken < 10 or broken \/ max\(1, len\(text\)\) <= 0\.01/.test(py));
  ok('用哪一档解码**要如实报出去**（猜错的表现是通顺的乱码，必须留痕）',
    /if best is not None:/.test(py) && /"encoding": encoding/.test(py));

  ok('docx 跳过"已删除的修订"与"域代码"（那两个都不是正文）',
    /W \+ "delText", W \+ "instrText"/.test(py));
  ok('单页抽不出来不毁掉整份（留成空行继续下一页）', /except Exception:\s*\n\s*# 单页[\s\S]{0,40}pages\.append\(""\)/.test(py));
  ok('抽出来是空的**别说成成功**（扫描件会走到这里，空正文会被当成"文件本来就没内容"）',
    /if not text:/.test(py) && /扫描件/.test(py));
  ok('缺库的文案里带"怎么装"（requirements.txt），而不是只报一句 ImportError',
    /MISSING_PDF_LIB/.test(py) && /pip install -r python-tools\/requirements\.txt/.test(py));
  ok('**不许用 eval / exec / compile**（它读的是用户传上来的字节）',
    !/\beval\(/.test(py) && !/\bexec\(/.test(py) && !/\bcompile\(/.test(py));
  ok('stdin 读了上限就停（别先把一个 2GB 的东西读进内存再说话）',
    /sys\.stdin\.buffer\.read\(MAX_INPUT_BYTES \+ 1\)/.test(py));

  const req = fs.readFileSync(path.join(ROOT, 'python-tools', 'requirements.txt'), 'utf8');
  ok('依赖清单里加了 pypdf，且只有这一份清单', /^pypdf$/m.test(req));
}

// ── 7. 工具表接点 ───────────────────────────────────────────────────────────
{
  const tools = buildToolDefs();
  const entry = tools.find((item) => item.name === 'read_document');
  ok('read_document 进了主流程工具表', !!entry);
  ok('它的 description 取自提示词目录（模型可见的固定指令只有一个落点）',
    entry.description === PROMPT_CATALOG.tools.read_document.description);
  ok('两个入口都可选、required 为空（"二选一"这件事 schema 表达不了，只能靠执行体的报错兜）',
    JSON.stringify(entry.parameters.required) === '[]'
    && 'messageId' in entry.parameters.properties && 'url' in entry.parameters.properties);
  ok('它排在读消息媒体那几个之后（顺序即语义，由 t-agent-structure 逐字钉住）',
    tools.findIndex((item) => item.name === 'read_document') === tools.findIndex((item) => item.name === 'reverse_image_source') + 1);
}

process.exit(done() ? 0 : 1);
