// 图像生成（百炼 · 千问 Qwen-Image）：配置归一化、请求体形状、两层提示词、错误映射、
// 单并发队列与两条投递路径、成本闸门、`/画` 命令与 `generate_image` 工具。
//
// 这里验的是**出图这条链自己的性质**，不重复验别人的：
//   · 三条异步回流条目在窗口里的行为由 t-window.mjs / t-jmcomic-callback.mjs 那类套件负责；
//   · 面板行渲染由 t-ui-render.mjs / t-panel-wiring.mjs 负责；
//   · 凭证脱敏在最后一段起真 app 验一次（与 t-transcription.mjs 同形）。
//
// 假 DashScope 服务器是刻意这么造的：`baseUrl` 是**管理员配置**、不是用户输入
// （与「请求结构」那条一致，那条链路同样不做 SSRF 校验），所以指向 127.0.0.1 是正常用法。
// 而**结果图**的下载走 safeFetchBinary，默认拒内网 —— 所以那一段要临时打开
// `security.allowPrivateImageHosts`，用完立刻还原（同 t-image-source.mjs 的做法）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { checker, dataDir, fakeImageServer, PNG_1X1 } from './lib/harness.mjs';
import { ROOT, load, stripComments } from './lib/src.mjs';

// dataDir 必须先于 load('core/config.js')：config 在加载时就把 DATA_DIR 定死。
dataDir('qqagent-image-gen-');
const { ok, done } = checker();

/** 读**源码**（不是 dist 产物）—— 源级文本断言扫的是 src/ 下那几行。 */
const readSource = (rel) => fs.readFileSync(path.join(ROOT, 'src', rel), 'utf8');

const ig = await load('media/image-gen/index.js');
const { DEFAULT_CONFIG, getConfig, updateConfig } = await load('core/config.js');
const { buildToolDefs, executeTool } = await load('agent/tools/index.js');

const {
  ImageGenQueue, ImageGenError, resolveImageGenConfig, buildImageGenRequest, withStyleLayer,
  parseDrawCommand, findReferenceImage, normalizeBaseUrl, normalizeSize, supportsNegativePrompt,
  generateImage, downloadImageToFile, fetchReferenceImage, IMAGE_GEN_PATH
} = ig;

// ── 夹具 ─────────────────────────────────────────────────────────
const PNG = PNG_1X1.toString('base64');

/**
 * 假百炼端点。`script` 里每一项形如 `{ status, body, delayMs, raw }`，按顺序吐；
 * 队列空了就返回一张成功的图。收到的请求全存进 `seen`。
 */
async function fakeDashscope() {
  const st = { script: [], seen: [] };
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch { /* 留 null，断言里能看出来 */ }
      st.seen.push({
        url: req.url, method: req.method, auth: req.headers.authorization,
        contentType: req.headers['content-type'], body: parsed
      });
      const next = st.script.shift() || { status: 200, body: okBody() };
      if (next.delayMs) await new Promise((r) => setTimeout(r, next.delayMs));
      const text = next.raw != null ? next.raw : JSON.stringify(next.body ?? {});
      res.writeHead(next.status ?? 200, { 'content-type': 'application/json' });
      res.end(text);
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return {
    get base() { return `http://127.0.0.1:${srv.address().port}`; },
    get script() { return st.script; },
    set script(v) { st.script = v; },
    get seen() { return st.seen; },
    close() { srv.close(); srv.closeAllConnections?.(); }
  };
}

/** 一次成功响应（形状照官方文档：output.choices[].message.content[].image）。 */
const okBody = (url = 'https://example.com/a.png') => ({
  output: { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: [{ image: url }] } }] },
  usage: { image_count: 1, width: 1024, height: 1024 },
  request_id: 'req-1'
});

/** 把配置改成一个"开着且配好"的出图能力，返回还原函数。 */
function withImageGen(patch = {}) {
  updateConfig({
    imageGen: {
      enabled: true, apiKey: 'sk-test-key', baseUrl: 'https://dashscope.aliyuncs.com',
      stylePrompt: '高质量，细节丰富',
      // 额度默认放到最大：这些夹具验的不是闸门，留着小额度只会让"第 3 次入队"莫名其妙地抛。
      // 闸门那两段自己会把它们调小（且配置是 deepMerge 的，不显式覆盖就会**继承前面用例的值**）。
      maxCallsPerChatPerHour: 60, maxCallsPerDay: 1000,
      ...patch
    }
  });
}

// 出厂默认必须在**任何 updateConfig 之前**读，否则读到的是被夹具改过的值。
const factory = structuredClone(DEFAULT_CONFIG.imageGen);

// ── 1. 配置归一化与钳制 ──────────────────────────────────────────
ok('出厂默认：关闭、不配 Key、模型是 2.1-turbo、风格层有默认值',
  factory.enabled === false && factory.apiKey === '' && factory.model === 'qwen-image-2.1-turbo'
  && String(factory.stylePrompt).length > 0);

withImageGen({ timeoutMs: 1, maxPromptChars: 999999, maxCallsPerDay: 0 });
let cfg = resolveImageGenConfig(getConfig());
ok('钳制：超时与描述上限被夹回合法区间（1 → 30000，999999 → 4000）',
  cfg.timeoutMs === 30000 && cfg.maxPromptChars === 4000, `${cfg.timeoutMs}/${cfg.maxPromptChars}`);
ok('钳制：调用上限至少为 1（0 被夹成 1，而不是"不限"）', cfg.maxCallsPerDay === 1, String(cfg.maxCallsPerDay));

withImageGen({ stylePrompt: '风'.repeat(400), maxStyleChars: 50 });
cfg = resolveImageGenConfig(getConfig());
ok('风格层被钳到 maxStyleChars（这句每张图都带上，长度必须由我们兜住）',
  [...cfg.stylePrompt].length === 50, String([...cfg.stylePrompt].length));

// 编译层：默认必须是**关**的。它让每张图多一次模型调用，而图按张计费 ——
// 出厂就打开等于给所有升级的人悄悄加一倍成本。
ok('出厂默认：提示词编译**关闭**（多一次模型调用是要花钱的）',
  factory.compile?.enabled === false, JSON.stringify(factory.compile));

withImageGen({ compile: { enabled: true, timeoutMs: 1 } });
{
  const c = resolveImageGenConfig(getConfig());
  ok('编译层钳制：超时被夹回 5000～300000',
    c.compile.timeoutMs === 5000, String(c.compile.timeoutMs));
  // 反向断言：那一档字数上限（`compile.maxChars`）**已经删掉**。留着它不会有任何报错，
  // 只会让"编译产物多长"重新变成代码层的判断 —— 而那是规则集（§15）的事。
  ok('编译层：`maxChars` 这一档已经删掉（代码层不再给画面描述定长度）',
    c.compile.maxChars === undefined, JSON.stringify(c.compile));
}
withImageGen({ compile: { enabled: false, timeoutMs: 60000 } });
ok('编译层：`enabled` 用 === true 判（"false" 这种畸形值不该把它打开）',
  resolveImageGenConfig(getConfig()).compile.enabled === false);

withImageGen({ apiKey: '' });
delete process.env.DASHSCOPE_API_KEY;
ok('没配 Key 且没有环境变量时 apiKey 为空（enqueue 才能据此拒绝）',
  resolveImageGenConfig(getConfig()).apiKey === '');
process.env.DASHSCOPE_API_KEY = 'sk-from-env';
ok('apiKey 留空时回退环境变量 DASHSCOPE_API_KEY（与官方文档示例同名）',
  resolveImageGenConfig(getConfig()).apiKey === 'sk-from-env');
delete process.env.DASHSCOPE_API_KEY;

ok('baseUrl 归一化：留空回落官方通用域名',
  normalizeBaseUrl('') === 'https://dashscope.aliyuncs.com' && normalizeBaseUrl('   ') === 'https://dashscope.aliyuncs.com');
ok('baseUrl 归一化：整条 endpoint 粘进来也能用（在 /api/v1/ 处截断、去尾斜杠）',
  normalizeBaseUrl('https://ws1.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation')
    === 'https://ws1.cn-beijing.maas.aliyuncs.com'
  && normalizeBaseUrl('https://dashscope.aliyuncs.com/') === 'https://dashscope.aliyuncs.com');
ok('size 归一化：字母 x 换成星号（官方警告过两套协议分隔符不同）',
  normalizeSize('1024x1024') === '1024*1024' && normalizeSize('768×1024') === '768*1024');
ok('size 归一化：空与 auto 都返回空串（= 不传这个参数），认不出的格式也返回空串',
  normalizeSize('') === '' && normalizeSize('auto') === '' && normalizeSize('大一点') === '');
ok('negative_prompt 只认 3.0 系列（其余模型传了会被接口判 400）',
  supportsNegativePrompt('qwen-image-3.0') && supportsNegativePrompt('qwen-image-3.0-pro')
  && !supportsNegativePrompt('qwen-image-2.1-turbo') && !supportsNegativePrompt('qwen-image-2.1-pro'));

// ── 2. 两层提示词与请求体（纯函数）───────────────────────────────
ok('两层拼接：风格层非空时接在模型给的描述之后（换行 + 固定标签）',
  withStyleLayer('一只猫', '动漫风格') === '一只猫\n画面风格要求：动漫风格');
ok('两层拼接：风格层留空时**逐字**返回模型给的那段（不留空行、不拼空串）',
  withStyleLayer('一只猫', '') === '一只猫' && withStyleLayer('一只猫', '   ') === '一只猫');

withImageGen({ size: '1024*768', negativePrompt: '文字', promptExtend: false, watermark: true });
cfg = resolveImageGenConfig(getConfig());
const t2i = buildImageGenRequest(cfg, { prompt: '一只猫' });
ok('T2I 请求体：content 里只有 {text}，且 text 是两层合并后的成品',
  t2i.input.messages[0].content.length === 1
  && t2i.input.messages[0].content[0].text === '一只猫\n画面风格要求：高质量，细节丰富'
  && t2i.input.messages[0].role === 'user');
ok('parameters：n 恒为 1、prompt_extend / watermark 按配置、size 透传',
  t2i.parameters.n === 1 && t2i.parameters.prompt_extend === false
  && t2i.parameters.watermark === true && t2i.parameters.size === '1024*768');
ok('2.1 系列**不带** negative_prompt（配置里写了也不发）',
  !('negative_prompt' in t2i.parameters));

withImageGen({ model: 'qwen-image-3.0-pro', negativePrompt: '文字' });
ok('3.0 系列才带 negative_prompt',
  buildImageGenRequest(resolveImageGenConfig(getConfig()), { prompt: 'x' }).parameters.negative_prompt === '文字');

withImageGen({ size: '' });
ok('size 未配时不出现这个键（= 由模型自动决定分辨率）',
  !('size' in buildImageGenRequest(resolveImageGenConfig(getConfig()), { prompt: 'x' }).parameters));

const i2i = buildImageGenRequest(cfg, { prompt: '改成赛博朋克', imageDataUrl: 'data:image/png;base64,AAAA' });
ok('I2I 请求体：参考图排在文字**前面**（官方示例如此，顺序定义图像顺序）',
  i2i.input.messages[0].content.length === 2
  && i2i.input.messages[0].content[0].image === 'data:image/png;base64,AAAA'
  && typeof i2i.input.messages[0].content[1].text === 'string');

// ── 3. 客户端错误映射（假百炼端点）──────────────────────────────
async function callGenerate(overrides = {}, input = { prompt: '一只猫' }) {
  return await generateImage(
    { ...resolveImageGenConfig(getConfig()), apiKey: 'sk-test-key', ...overrides },
    input,
    new AbortController().signal
  );
}

{
  const ds = await fakeDashscope();
  withImageGen({ baseUrl: ds.base });
  const url = await callGenerate();
  const seen = ds.seen[0];
  ok('调用成功时返回结果图 URL', url === 'https://example.com/a.png', String(url));
  ok('请求打到同步接口的正确路径上（异步那个是 image-generation/generation，别混）',
    seen.url === IMAGE_GEN_PATH, seen.url);
  ok('请求头：JSON + Bearer API Key',
    seen.method === 'POST' && seen.contentType === 'application/json'
    && seen.auth === 'Bearer sk-test-key', `${seen.method}/${seen.contentType}/${seen.auth}`);
  ds.close();
}

{
  const ds = await fakeDashscope();
  withImageGen({ baseUrl: ds.base });
  ds.script = [{ status: 400, body: { error: { code: 'InvalidParameter', message: 'Field prompt is required' } } }];
  let code = '';
  try { await callGenerate(); } catch (e) { code = e.code; }
  ok('HTTP 400 映射成可机检的错误码（上游 code 洗过再进码）',
    code === 'DASHSCOPE_InvalidParameter', code);
  ds.close();
}

{
  const ds = await fakeDashscope();
  withImageGen({ baseUrl: ds.base });
  // ⚠️ 这一条是整套里最要紧的：鉴权失败时接口可能给 **HTTP 200 + 响应体里的 code**。
  // 只判 response.ok 的话会把它当成成功，然后死在"没有返回图片"上 —— 归因完全错。
  ds.script = [{ status: 200, body: { code: 'InvalidApiKey', message: 'Invalid API-key provided.', request_id: 'r' } }];
  let code = '', msg = '';
  try { await callGenerate(); } catch (e) { code = e.code; msg = e.userMessage; }
  ok('HTTP 200 但响应体里带 code 也算失败（否则会被读成成功、归因指向图片）',
    code === 'DASHSCOPE_InvalidApiKey', code);
  ok('这条的文案指向 API Key / 地域，而不是"没返回图片"',
    /API Key/.test(msg), msg);
  ds.close();
}

{
  const ds = await fakeDashscope();
  withImageGen({ baseUrl: ds.base });
  ds.script = [{ status: 200, body: { output: { choices: [{ message: { content: [{ text: '抱歉' }] } }] } } }];
  let code = '';
  try { await callGenerate(); } catch (e) { code = e.code; }
  ok('成功响应里没有图片时抛 NO_IMAGE_URL（不返回 undefined 往下走）', code === 'NO_IMAGE_URL', code);
  ds.close();
}

{
  const ds = await fakeDashscope();
  withImageGen({ baseUrl: ds.base });
  ds.script = [{ status: 200, raw: 'x'.repeat(3 * 1024 * 1024) }];
  let code = '';
  try { await callGenerate(); } catch (e) { code = e.code; }
  ok('响应体超限时抛自己的错误码（不冒充传输失败、也不把几百 MB 读进内存）',
    code === 'RESPONSE_TOO_LARGE', code);
  ds.close();
}

{
  const ds = await fakeDashscope();
  withImageGen({ baseUrl: ds.base });
  ds.script = [{ status: 200, body: okBody(), delayMs: 400 }];
  let code = '';
  try { await callGenerate({ timeoutMs: 100 }); } catch (e) { code = e.code; }
  ok('超时抛 IMAGE_TIMEOUT（超时是**内部**的一条死线，不是把请求挂在外面等）', code === 'IMAGE_TIMEOUT', code);
  ds.close();
}

{
  const ds = await fakeDashscope();
  withImageGen({ baseUrl: ds.base });
  ds.script = [{ status: 200, body: okBody(), delayMs: 400 }];
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 50);
  let code = '';
  try {
    await generateImage({ ...resolveImageGenConfig(getConfig()), timeoutMs: 5000 }, { prompt: 'x' }, ac.signal);
  } catch (e) { code = e.code; }
  ok('外部 abort（关停）抛 CANCELLED，与"超时"分开报', code === 'CANCELLED', code);
  ds.close();
}

// ── 4. 队列：单并发、状态、闸门、两条投递路径 ────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const workFiles = [];

function makeQueue({ operations = {}, deliver, senderOverrides = {}, compilePrompt = null } = {}) {
  const sentText = [];
  const sentImages = [];
  const queue = new ImageGenQueue({
    getConfig,
    sender: {
      sendTextBatch: async (chatKey, messages) => { sentText.push({ chatKey, messages }); return { sent: [], failed: [] }; },
      sendImage: async (chatKey, file) => { sentImages.push({ chatKey, file }); return { message_id: 1 }; },
      ...senderOverrides
    },
    log: () => {},
    operations,
    deliverImageResult: deliver ?? null,
    compilePrompt
  });
  return { queue, sentText, sentImages };
}

withImageGen({ baseUrl: 'http://127.0.0.1:1' });
{
  let peak = 0;
  const running = [];
  const { queue, sentImages } = makeQueue({
    operations: {
      // 记下"同时有几个在跑"，并让每个任务真正占用一段真实时间。
      runTask: async (job, _signal, setStatus, _config, workDir) => {
        running.push(job.id);
        peak = Math.max(peak, running.length);
        setStatus('generating');
        await sleep(30);
        running.pop();
        const filePath = path.join(workDir, `${job.id}.png`);
        fs.writeFileSync(filePath, PNG_1X1);
        workFiles.push(filePath);
        return { filePath, bytes: PNG_1X1.length };
      }
    }
  });
  await queue.start();
  const a = queue.enqueue({ chatKey: 'group:1', prompt: '甲' });
  queue.enqueue({ chatKey: 'group:2', prompt: '乙' });
  ok('入队后立刻拿到视图，且视图里**没有** prompt（用户内容不进对外读模型）',
    a.id && !('prompt' in a) && !('referenceUrl' in a), JSON.stringify(a));
  queue.enqueue({ chatKey: 'group:3', prompt: '丙' });
  await sleep(300);
  ok('三个任务串行执行（同时最多一个）', peak === 1, `峰值并发 ${peak}`);
  ok('两条路径都真的把图发出去了', sentImages.length === 3, String(sentImages.length));
  ok('生成的临时文件在投递后被删掉（临时目录归队列所有）',
    workFiles.every((f) => !fs.existsSync(f)));
  await queue.stop();
}

{
  // assisted 模式：发图 **且** 恰好回调一次回流端口。
  const delivered = [];
  const { queue, sentImages } = makeQueue({
    deliver: (input) => { delivered.push(input); },
    operations: {
      runTask: async (job, _s, _set, _c, workDir) => {
        const filePath = path.join(workDir, `${job.id}.png`);
        fs.writeFileSync(filePath, PNG_1X1);
        return { filePath, bytes: PNG_1X1.length };
      }
    }
  });
  await queue.start();
  queue.enqueue({ chatKey: 'group:9', prompt: '一只戴墨镜的鲸鱼', mode: 'assisted' });
  await sleep(80);
  ok('assisted 模式：图由队列发进群，且回流端口恰好被调一次',
    sentImages.length === 1 && delivered.length === 1, `${sentImages.length}/${delivered.length}`);
  ok('回流载荷：状态是 sent、带**模型给的那段描述**（不是后端合并后的成品），且没有失败原因',
    delivered[0]?.status === 'sent' && delivered[0]?.prompt === '一只戴墨镜的鲸鱼' && delivered[0]?.reason === '',
    JSON.stringify(delivered[0]));
  await queue.stop();
}

{
  // **失败也走同一条回流通道**（这是这条路的核心契约：只由模型开口，队列不代它说话）。
  for (const [label, error, expect] of [
    ['没画成', new ImageGenError('generating', 'IMAGE_TIMEOUT', '画图超时（超过 300 秒），稍后再试'), 'failed'],
    ['画好了没发出去', new ImageGenError('uploading', 'SEND_TIMEOUT', '上传超时了（图可能已经在群里，也可能没发出去）'), 'unsent']
  ]) {
    const delivered = [];
    const { queue, sentText } = makeQueue({
      deliver: (input) => { delivered.push(input); },
      operations: { runTask: async () => { throw error; } }
    });
    await queue.start();
    queue.enqueue({ chatKey: 'group:17', prompt: '一只猫', mode: 'assisted' });
    await sleep(60);
    ok(`assisted 失败（${label}）：回流端口收到 ${expect}，**群里一个字都不发**（代它说会让它以为说过了）`,
      delivered.length === 1 && delivered[0].status === expect
      && delivered[0].prompt === '一只猫' && delivered[0].reason === error.userMessage
      && sentText.length === 0,
      `${JSON.stringify(delivered)} / ${JSON.stringify(sentText)}`);
    await queue.stop();
  }
}

{
  // 没有回流端口 / 回流端口抛错时**必须**退回贴一句 —— 否则群友什么都等不到（"只有确定有人接的时候才闭嘴"）。
  const cases = [
    ['没装回流端口', null],
    ['回流端口抛错', () => { throw new Error('落存档失败'); }]
  ];
  for (const [label, deliver] of cases) {
    const { queue, sentText } = makeQueue({
      deliver,
      operations: { runTask: async () => { throw new ImageGenError('generating', 'IMAGE_TIMEOUT', '画图超时（超过 300 秒），稍后再试'); } }
    });
    await queue.start();
    queue.enqueue({ chatKey: 'group:18', prompt: 'x', mode: 'assisted' });
    await sleep(60);
    ok(`assisted 但${label} → 退回让队列自己说（不能无声无息）`,
      sentText.length === 1 && String(sentText[0].messages).includes('画图失败'), JSON.stringify(sentText));
    await queue.stop();
  }
}

{
  // 没有回流端口时不能无声无息，但任务本身仍然是成功的（图已经发出去了）。
  const { queue, sentImages } = makeQueue({
    operations: {
      runTask: async (job, _s, _set, _c, workDir) => {
        const filePath = path.join(workDir, `${job.id}.png`);
        fs.writeFileSync(filePath, PNG_1X1);
        return { filePath, bytes: PNG_1X1.length };
      }
    }
  });
  await queue.start();
  const view = queue.enqueue({ chatKey: 'group:10', prompt: 'x', mode: 'assisted' });
  await sleep(60);
  await queue.stop();
  ok('缺回流端口时任务仍然算完成（图已经发出去了，不能因为没人接就判失败）',
    queue.get(view.id).status === 'done' && sentImages.length === 1,
    JSON.stringify(queue.get(view.id)));
}

{
  // 失败路径：阶段文案 + 群里那句话 + 任务状态。
  const { queue, sentText } = makeQueue({
    operations: {
      runTask: async () => { throw new ImageGenError('downloading', 'IMAGE_TOO_LARGE', '生成的图片太大，发不出去'); }
    }
  });
  await queue.start();
  // 显式 standalone：这是**没有模型接**的那条路（今天只有它自己会贴文案；两条生产入口都走 assisted）。
  const view = queue.enqueue({ chatKey: 'group:11', prompt: 'x', mode: 'standalone' });
  await sleep(60);
  const after = queue.get(view.id);
  ok('失败时任务状态与阶段都记下来了（阶段决定排查方向）',
    after.status === 'failed' && after.failedStage === 'downloading' && after.errorCode === 'IMAGE_TOO_LARGE',
    JSON.stringify(after));
  ok('失败文案进群，且**点名是哪一段失败**（中文字面，不是阶段码）',
    sentText.length === 1 && /画图失败（下载图片）：/.test(String(sentText[0].messages)),
    JSON.stringify(sentText));
  await queue.stop();
}

{
  // stop 的行为：未开跑的判失败、在途的被 abort、不往群里发失败文案。
  const { queue, sentText } = makeQueue({
    operations: {
      runTask: async (job, signal) => {
        await new Promise((resolve) => {
          const t = setTimeout(resolve, 300);
          signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
        });
        if (signal.aborted) throw new ImageGenError('generating', 'CANCELLED', '任务已取消');
        return { filePath: '', bytes: 0 };
      }
    }
  });
  await queue.start();
  const first = queue.enqueue({ chatKey: 'group:12', prompt: '在跑的' });
  const second = queue.enqueue({ chatKey: 'group:12', prompt: '排队的' });
  await sleep(30);
  await queue.stop();
  ok('stop：排队中的任务被判失败并标明 SHUTDOWN（不留着它们随进程静默消失）',
    queue.get(second.id).status === 'failed' && queue.get(second.id).errorCode === 'SHUTDOWN',
    JSON.stringify(queue.get(second.id)));
  ok('stop：在途任务被 abort，记成 CANCELLED', queue.get(first.id).errorCode === 'CANCELLED',
    JSON.stringify(queue.get(first.id)));
  ok('stop：**不**往群里发失败文案（那是我们主动取消的，不是任务真的失败）',
    sentText.length === 0, JSON.stringify(sentText));
}

{
  // 上传阶段失败必须归到 `uploading` 并带上**真实原因**。
  // 这一段是真机实测逼出来的：`SendQueue` 抛的是裸 Error，不包的话它会穿到 `#drain` 的兜底文案，
  // 群里看到的是「画图失败（画图）：画图失败（Error），稍后再试」——阶段和原因一起丢了。
  const { queue, sentText } = makeQueue({
    operations: {
      runTask: async (job, _s, _set, _c, workDir) => ({ filePath: path.join(workDir, `${job.id}.png`), bytes: 10 })
    },
    senderOverrides: {
      sendImage: async () => { throw new Error('发送频率超限（每分钟最多 80 条），请等一会再发'); }
    }
  });
  await queue.start();
  const view = queue.enqueue({ chatKey: 'group:14', prompt: 'x' });
  await sleep(60);
  ok('上传失败：阶段记成 uploading（不是笼统的"画图"）',
    queue.get(view.id).failedStage === 'uploading', JSON.stringify(queue.get(view.id)));
  ok('上传失败：群里那句话带**真实原因**（限频那类文案本来就是写给人看的，原样透传）',
    sentText.length === 1 && String(sentText[0].messages).includes('发送频率超限'),
    JSON.stringify(sentText));
  await queue.stop();
}

{
  // 协议端**明确拒绝**本机路径（retcode）→ 用结果图链接重发一次（与 stickers 同一条判据）。
  const attempts = [];
  const { queue, sentText } = makeQueue({
    operations: {
      runTask: async (job, _s, _set, _c, workDir) => ({
        filePath: path.join(workDir, `${job.id}.png`), bytes: 10, remoteUrl: 'https://example.com/result.png'
      })
    },
    senderOverrides: {
      sendImage: async (chatKey, file) => {
        attempts.push(file);
        if (attempts.length === 1) throw new Error('OneBot send_group_msg 失败: retcode=100 ');
        return { message_id: 1 };
      }
    }
  });
  await queue.start();
  const view = queue.enqueue({ chatKey: 'group:15', prompt: 'x' });
  await sleep(60);
  ok('本机路径被协议端拒绝时，退回结果图链接重发一次（本机路径是唯一没法在本机验证的东西）',
    attempts.length === 2 && attempts[0].endsWith('.png') && attempts[1] === 'https://example.com/result.png',
    JSON.stringify(attempts));
  ok('兜底成功 → 任务算成功，不往群里发失败文案',
    queue.get(view.id).status === 'done' && sentText.length === 0, JSON.stringify(queue.get(view.id)));
  await queue.stop();
}

{
  // 超时那类错误**不许**兜底重发：说不清消息到底发出去没有，重发就是刷屏。
  // 真机（2026-10-10）就是这一条：图片段吃了 `call()` 的 15 秒默认超时，协议端其实还在传，
  // 于是群里先收到"画图失败"、紧接着又收到那张图。见 onebot.ts 的 SEGMENT_UPLOAD_TIMEOUT_MS。
  const attempts = [];
  const { queue, sentText } = makeQueue({
    operations: {
      runTask: async (job, _s, _set, _c, workDir) => ({
        filePath: path.join(workDir, `${job.id}.png`), bytes: 10, remoteUrl: 'https://example.com/result.png'
      })
    },
    senderOverrides: {
      // `AbortSignal.timeout()` 抛的就是这个形状：DOMException、name 是 TimeoutError。
      sendImage: async (chatKey, file) => {
        attempts.push(file);
        throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
      }
    }
  });
  await queue.start();
  const view = queue.enqueue({ chatKey: 'group:16', prompt: 'x' });
  await sleep(60);
  ok('只有明确拒绝（retcode）才兜底；超时只报失败、不重发（重发可能是刷屏）',
    attempts.length === 1 && sentText.length === 1, JSON.stringify(attempts));
  ok('超时归成 SEND_TIMEOUT（不是笼统的 TimeoutError）',
    queue.get(view.id).errorCode === 'SEND_TIMEOUT', JSON.stringify(queue.get(view.id)));
  ok('上传阶段的文案**不说"画图失败"**：图确实画好了，而且消息可能已经在群里',
    String(sentText[0].messages).startsWith('图已经画好了，但没能发到群里：')
    && String(sentText[0].messages).includes('可能已经在群里'),
    JSON.stringify(sentText));
  await queue.stop();
}

{
  // 写盘失败归到 downloading，并带上 errno。
  const img = await fakeImageServer();
  updateConfig({ security: { allowPrivateImageHosts: true } });
  let code = '';
  try {
    await downloadImageToFile(`${img.base}/ok.png`, 8 * 1024 * 1024, new AbortController().signal,
      path.join(os.tmpdir(), 'qq-agent-definitely-missing-dir', 'x.png'));
  } catch (e) { code = e.code; }
  ok('写盘失败归到 downloading 并带 errno（裸 fs 异常会一路穿成"画图失败，稍后再试"）',
    code === 'ENOENT', code);
  updateConfig({ security: { allowPrivateImageHosts: false } });
  img.close();
}

{
  const { userError, safeErrorDetail } = ig;
  ok('未分类异常的兜底文案**带上码**（原先那句"画图失败，稍后再试"连哪一步都说不出）',
    /（ENOENT）/.test(userError(Object.assign(new Error('x'), { code: 'ENOENT' })).userMessage),
    userError(Object.assign(new Error('x'), { code: 'ENOENT' })).userMessage);
  ok('日志细节先洗过：URL 与本机路径都不出现在里面',
    safeErrorDetail(new Error('connect failed https://secret.example.com/a.png at C:\\Users\\me\\tmp\\x.png'))
      === 'connect failed [url] at [path]',
    safeErrorDetail(new Error('connect failed https://secret.example.com/a.png at C:\\Users\\me\\tmp\\x.png')));
}

// ── 5. 图片发送不占会话串行链 ────────────────────────────────────
// 真机（2026-10-10）第二症状：上传慢到分钟级时，**正在进行的对话整体堵住** ——
// 模型收尾那一步正是 send_message，它排在同一条链上等上传，于是工具调用不返回、
// 本轮运行不结束，面板上那条会话一直显示"运行中"。
{
  const { SendQueue } = await load('qq/sender.js');
  let releaseText;
  const gate = new Promise((resolve) => { releaseText = resolve; });
  let textDone = false;
  const images = [];
  const sender = new SendQueue({
    onebot: {
      sendText: async () => { await gate; return { message_id: 1 }; },
      sendImage: async (kind, id, file) => { images.push(file); return { message_id: 2 }; },
      sendSticker: async () => ({ message_id: 3 }),
      sendPoke: async () => ({})
    },
    store: { appendSelf: () => ({}) }
  });
  // 先把链占住（那条文本卡在网关后面），再发图。
  const textPromise = sender.sendTextBatch('group:700', '占住会话链的一条').then(() => { textDone = true; });
  await sleep(10);
  await sender.sendImage('group:700', '/tmp/generated.png');
  ok('图片发送不等在卡住的文本后面（会话的收尾不该由一张图的传输速度决定）',
    images.length === 1 && textDone === false, `images=${images.length} textDone=${textDone}`);
  releaseText();
  await textPromise;
  ok('链外发图不影响文本那条照常发出去（限频与存档都还在）', textDone === true);
}

{
  // 任务视图有界保留最近 100 条。
  const { queue } = makeQueue({ operations: { runTask: async (job, _s, _set, _c, workDir) => ({ filePath: path.join(workDir, `${job.id}.png`), bytes: 1 }) } });
  await queue.start();
  let lastId = '';
  // 轮换会话：额度是**每会话**一本账，105 次挤在同一个群里会先撞上每小时上限，
  // 那样测的就不是"视图有界"了（而且红得像是视图那行坏了）。
  for (let i = 0; i < 105; i++) lastId = queue.enqueue({ chatKey: `group:${100 + (i % 50)}`, prompt: `p${i}` }).id;
  await sleep(200);
  ok('任务视图有界保留最近 100 条（无上限会随运行时长涨）',
    queue.get(lastId) !== null && queue.get('nope') === null);
  await queue.stop();
}

// ── 5. 成本闸门：两条入口共用同一本账 ───────────────────────────
{
  withImageGen({ maxCallsPerChatPerHour: 2, maxCallsPerDay: 100 });
  const { queue } = makeQueue({ operations: { runTask: async (job, _s, _set, _c, workDir) => ({ filePath: path.join(workDir, `${job.id}.png`), bytes: 1 }) } });
  await queue.start();
  const errs = [];
  for (let i = 0; i < 3; i++) {
    try { queue.enqueue({ chatKey: 'group:20', prompt: 'x' }); } catch (e) { errs.push(e); }
  }
  ok('每群每小时上限真的拦得住（第 3 次被拒）', errs.length === 1 && errs[0].code === 'RATE_LIMITED', JSON.stringify(errs.map((e) => e.code)));
  ok('被拒的文案里带上限数字（用户才能自己决定要不要调）',
    /每小时最多 2 次/.test(errs[0]?.userMessage || ''), errs[0]?.userMessage);
  // 同一个限额对另一个群不生效（每群一本账）。
  let otherChatOk = true;
  try { queue.enqueue({ chatKey: 'group:21', prompt: 'x' }); } catch { otherChatOk = false; }
  ok('另一个群不受这个群已用掉的额度影响', otherChatOk);
  // 被拒绝的那几次不占额度：group:21 那次成功了，说明 group:20 的第三次被拒没记进别的账。
  await queue.stop();
}

{
  withImageGen({ maxCallsPerChatPerHour: 100, maxCallsPerDay: 2 });
  const { queue } = makeQueue({ operations: { runTask: async (job, _s, _set, _c, workDir) => ({ filePath: path.join(workDir, `${job.id}.png`), bytes: 1 }) } });
  await queue.start();
  const errs = [];
  for (const k of ['group:30', 'group:31', 'group:32']) {
    try { queue.enqueue({ chatKey: k, prompt: 'x' }); } catch (e) { errs.push(e); }
  }
  ok('全局每日上限跨会话生效（第三个别群也被拦）', errs.length === 1 && errs[0].code === 'RATE_LIMITED', JSON.stringify(errs.map((e) => e.code)));
  await queue.stop();
}

// ── 6. 建任务之前的零成本拒绝 ───────────────────────────────────
{
  withImageGen({});
  const { queue } = makeQueue();
  await queue.start();
  const reject = (fn) => { try { fn(); return ''; } catch (e) { return e.code; } };
  ok('描述为空被拒（MISSING_PROMPT）', reject(() => queue.enqueue({ chatKey: 'group:40', prompt: '   ' })) === 'MISSING_PROMPT');
  ok('描述超长被拒并说清上限（不静默截断：截断会画出一张不是它要的图）',
    reject(() => queue.enqueue({ chatKey: 'group:40', prompt: '字'.repeat(5000) })) === 'PROMPT_TOO_LONG');
  updateConfig({ imageGen: { enabled: false } });
  ok('未启用时被拒（DISABLED）', reject(() => queue.enqueue({ chatKey: 'group:40', prompt: 'x' })) === 'DISABLED');
  withImageGen({ apiKey: '' });
  process.env.DASHSCOPE_API_KEY = '';
  delete process.env.DASHSCOPE_API_KEY;
  ok('没配 API Key 时被拒，文案点名去哪儿配（CONFIG_MISSING）',
    reject(() => queue.enqueue({ chatKey: 'group:40', prompt: 'x' })) === 'CONFIG_MISSING');
  withImageGen({ baseUrl: 'dashscope' });
  ok('接口地址不是合法 URL 时被拒（INVALID_BASE_URL），而不是让 fetch 抛一句 Failed to parse URL',
    reject(() => queue.enqueue({ chatKey: 'group:40', prompt: 'x' })) === 'INVALID_BASE_URL');
  await queue.stop();
  ok('未启动的队列拒绝入队（NOT_STARTED）', reject(() => queue.enqueue({ chatKey: 'group:40', prompt: 'x' })) === 'NOT_STARTED');
}

// ── 7. 端到端：真 fetch 出图 → 真下载结果图 → 真发图 ────────────
{
  const ds = await fakeDashscope();
  const img = await fakeImageServer();
  // 结果图在 127.0.0.1 上，而 safeFetchBinary 默认拒内网 —— 这是**测试**才需要的放开，
  // 用完立刻还原（别把内网放行漏给后面的用例）。
  updateConfig({ security: { allowPrivateImageHosts: true } });
  ds.script = [{ status: 200, body: okBody(`${img.base}/ok.png`) }, { status: 200, body: okBody(`${img.base}/ok.png`) }];
  withImageGen({ baseUrl: ds.base, apiKey: 'sk-e2e', stylePrompt: '胶片质感' });

  const sent = [];
  const queue = new ImageGenQueue({
    getConfig,
    sender: {
      sendTextBatch: async () => ({ sent: [], failed: [] }),
      sendImage: async (chatKey, file) => {
        sent.push({ chatKey, file, size: fs.existsSync(file) ? fs.statSync(file).size : -1 });
        return { message_id: 7 };
      }
    },
    log: () => {},
    deliverImageResult: () => {}
  });
  await queue.start();
  // 两条入口各来一次：`/画` 命令（standalone）与模型工具（assisted）。
  const cmdPrompt = parseDrawCommand('/画 一只戴墨镜的鲸鱼');
  queue.enqueue({ chatKey: 'group:50', prompt: cmdPrompt });
  await sleep(200);
  queue.enqueue({ chatKey: 'group:50', prompt: cmdPrompt, mode: 'assisted' });
  await sleep(200);

  ok('端到端：结果图被真的下载成本机文件再发出去（不是把 24 小时有效的链接交给协议端）',
    sent.length === 2 && sent.every((s) => s.size === PNG_1X1.length), JSON.stringify(sent.map((s) => s.size)));
  ok('端到端：临时文件发完就删', sent.every((s) => !fs.existsSync(s.file)));
  const [req1, req2] = ds.seen;
  const textOf = (r) => r.body.input.messages[0].content.at(-1).text;
  ok('端到端：命令路径与工具路径拼出来的请求体**逐字节相同**（同一份实现，两层提示词只此一处）',
    JSON.stringify(req1.body) === JSON.stringify(req2.body),
    `${textOf(req1)} vs ${textOf(req2)}`);
  ok('端到端：风格层确实拼在了成品里，且模型给的原话也在里面',
    textOf(req1) === '一只戴墨镜的鲸鱼\n画面风格要求：胶片质感', textOf(req1));
  await queue.stop();
  updateConfig({ security: { allowPrivateImageHosts: false } });
  ds.close();
  img.close();
}

// ── 8. 参考图（图生图）─────────────────────────────────────────
{
  const img = await fakeImageServer();
  updateConfig({ security: { allowPrivateImageHosts: true } });
  const dataUrl = await fetchReferenceImage(`${img.base}/ok.png`, 8 * 1024 * 1024, new AbortController().signal);
  ok('参考图取回后转成 data URL（图生图的入参格式）',
    dataUrl.startsWith('data:image/png;base64,') && dataUrl.endsWith(PNG), dataUrl.slice(0, 30));
  let code = '';
  try { await fetchReferenceImage(`${img.base}/nope.png`, 8 * 1024 * 1024, new AbortController().signal); }
  catch (e) { code = e.code; }
  ok('参考图取不到时抛带阶段的错误（不是静默当作"没有参考图"）', code === 'HTTP_404', code);
  let tooLarge = '';
  try { await fetchReferenceImage(`${img.base}/ok.png`, 4, new AbortController().signal); }
  catch (e) { tooLarge = e.code; }
  ok('参考图超过上限被判 IMAGE_TOO_LARGE（safeFetchBinary 到量只截断、不抛，必须自己认出来）',
    tooLarge === 'IMAGE_TOO_LARGE', tooLarge);
  let format = '';
  const bad = await fakeImageServer({ png: Buffer.from('这不是图片，但是够长的一段字节'.repeat(3)) });
  try {
    await fetchReferenceImage(`${bad.base}/ok.png`, 8 * 1024 * 1024, new AbortController().signal);
  } catch (e) { format = e.code; } finally { bad.close(); }
  ok('认不出格式的字节不许当图片用（否则会发一张破图出去）', format === 'IMAGE_FORMAT', format);
  updateConfig({ security: { allowPrivateImageHosts: false } });
  img.close();
}

// ── 9. `/画` 命令解析与参考图定位 ───────────────────────────────
ok('/画：正常解析出描述', parseDrawCommand('/画 一只猫') === '一只猫');
ok('/画：前后空白被剥掉；多行描述保留换行', parseDrawCommand('  /画   一只猫 \n在窗台上  ') === '一只猫 \n在窗台上');
ok('/画：不是这条命令时返回 null（对普通消息发用法提示是最糟的一种"贴心"）',
  parseDrawCommand('画一只猫') === null && parseDrawCommand('/画像') === null && parseDrawCommand('/转写 x') === null);
let usage = '';
try { parseDrawCommand('/画'); } catch (e) { usage = e.userMessage; }
ok('/画：没写描述时抛用法提示（与"不是这条命令"是两回事）', usage === '用法：/画 <画面描述>', usage);
ok('参考图定位：只认真的带 url 的图片段',
  findReferenceImage([{ kind: 'video', url: 'v' }, { kind: 'image', url: 'a.png' }, { kind: 'image', url: 'b.png' }]) === 'a.png'
  && findReferenceImage([{ kind: 'image' }]) === '' && findReferenceImage([]) === '');

// ── 10. generate_image 工具 ────────────────────────────────────
const defs = buildToolDefs();
ok('工具表里有 generate_image，且描述来自 Catalog', defs.some((d) => d.name === 'generate_image'));

{
  withImageGen({});
  const enqueued = [];
  const sent = [];
  const ctx = {
    chatKey: 'group:60',
    triggerEntries: [{ mid: '1001', media: [{ kind: 'image', url: 'https://cdn.example.com/a.jpg' }] }],
    // 真 store 有 `recent`（midHint 要靠它列出最近可见的 id），这里给个空实现即可。
    store: { findByMid: () => null, recent: () => [] },
    sender: { sendTextBatch: async (...a) => { sent.push(a); return { sent: [], failed: [] }; } },
    session: { id: 's1', sent: [] },
    emit: () => {},
    imageGen: { enqueue: (job) => { enqueued.push(job); return { id: 'job-1' }; } }
  };
  const r1 = await executeTool(defs, ctx, 'generate_image', { prompt: '一只猫' });
  ok('工具入队并返回 Catalog 里的回执（自己不发任何消息）',
    enqueued.length === 1 && sent.length === 0 && String(r1.content).includes('画图已入队'),
    String(r1.content).slice(0, 40));
  ok('工具走 assisted（结果要回流给模型收尾）', enqueued[0].mode === 'assisted');
  ok('工具**不把任务号写进结果**（没有原料就编不出"任务已派上（任务 xxxx）"）',
    !String(r1.content).includes('job-1') && !/[0-9a-f]{8}-[0-9a-f]{4}/.test(String(r1.content)));

  enqueued.length = 0;
  const r2 = await executeTool(defs, ctx, 'generate_image', { prompt: '改成赛博朋克', messageId: '1001' });
  ok('给了 messageId 就把那张图当参考图（图生图）',
    enqueued.length === 1 && enqueued[0].imageUrl === 'https://cdn.example.com/a.jpg', JSON.stringify(enqueued[0] || {}));
  ok('messageId 也用作回复目标', String(enqueued[0].replyToMessageId) === '1001' || enqueued[0].replyToMessageId === '1001');
  void r2;

  const r3 = await executeTool(defs, ctx, 'generate_image', { prompt: '' });
  ok('缺少 prompt 时拒绝（没有描述就没有图）', r3.isError === true && /prompt/.test(String(r3.content)));
  const r4 = await executeTool(defs, ctx, 'generate_image', { prompt: 'x', messageId: '9999' });
  ok('消息 id 找不到时分开报（id 打错 ≠ 那条消息里没有图）',
    r4.isError === true && /没找到消息 9999/.test(String(r4.content)));
  const ctxNoImage = { ...ctx, triggerEntries: [{ mid: '1002', media: [{ kind: 'video', url: 'v' }] }] };
  const r5 = await executeTool(defs, ctxNoImage, 'generate_image', { prompt: 'x', messageId: '1002' });
  ok('消息里没有图时，错误文案列出**实际看到的附件种类**（卡片在、链接不在时靠它看出真相）',
    r5.isError === true && /只看到：video/.test(String(r5.content)), String(r5.content));
  const r6 = await executeTool(defs, { ...ctx, imageGen: undefined }, 'generate_image', { prompt: 'x' });
  ok('能力未装配时给友好错误，不抛', r6.isError === true && /未启用/.test(String(r6.content)));
}

{
  // 队列抛的 ImageGenError 要原样变成模型看得懂的那句话。
  withImageGen({ apiKey: '' });
  delete process.env.DASHSCOPE_API_KEY;
  const { queue } = makeQueue();
  await queue.start();
  const defs2 = buildToolDefs();
  const r = await executeTool(defs2, {
    chatKey: 'group:61', triggerEntries: [], store: { findByMid: () => null },
    sender: { sendTextBatch: async () => ({}) }, session: { id: 's', sent: [] }, emit: () => {},
    imageGen: queue
  }, 'generate_image', { prompt: '一只猫' });
  ok('缺 Key 时工具把可执行的那句话原样交给模型（点名去哪儿配）',
    r.isError === true && /API Key/.test(String(r.content)), String(r.content));
  await queue.stop();
}

// ── 11. 脱敏：API Key 不进浏览器 ────────────────────────────────
{
  withImageGen({ apiKey: 'sk-super-secret-value' });
  const { createApp } = await load('web/app.js');
  const app = createApp({ log: () => {} });
  const port = await app.start();
  try {
    const body = await (await fetch(`http://127.0.0.1:${port}/api/config`)).json();
    ok('GET /api/config：imageGen.apiKey 不在响应里，只留 hasApiKey 标记',
      body.imageGen && !('apiKey' in body.imageGen) && body.imageGen.hasApiKey === true,
      JSON.stringify(body.imageGen || {}));
    ok('GET /api/config：响应全文里搜不到那个 Key 的字面量',
      !JSON.stringify(body).includes('sk-super-secret-value'));
  } finally {
    await app.stop();
  }
}

// ── 12. 回流条目：窗口、提示词与响应档位 ────────────────────────
// 这一段是**第三种 kind 的全部落点**：少一处，出图完成后模型就永远看不到）。
{
  const { ChatStore, isSystemRecord, isPersonMessage } = await load('chat/store.js');
  const { buildTriggerBlock } = await load('agent/prompting/prompt-builder.js');
  const { evaluateWindowTrigger } = await load('agent/context/response-policy.js');
  const store = new ChatStore(0);
  const KEY = 'group:70001';
  const entry = store.appendImageResult(KEY, { prompt: '一只戴墨镜的鲸鱼', count: 1 });
  ok('回流条目：未读、非 self、不可引用、senderId 空 —— 但要进窗口',
    entry.read === false && entry.self === false && entry.mid === null
    && entry.senderId === '' && entry.senderName === '图像' && entry.kind === 'image-result'
    && entry.text.includes('一只戴墨镜的鲸鱼'),
    JSON.stringify(entry));
  ok('回流条目：进唤醒窗口（不是 isSystemRecord），但不算某个群友的发言（是 isPersonMessage 的反面）',
    !isSystemRecord(entry) && !isPersonMessage(entry));
  ok('回流条目答不出"谁发的"（空 senderId 不会在活跃成员里造出幽灵）',
    !store.activeMembers(KEY, 20).some((m) => m.userId === ''), JSON.stringify(store.activeMembers(KEY, 20)));

  const block = buildTriggerBlock([entry], { selfNickname: '小鲸鱼' });
  ok('提示词把回流条目渲染成【图片生成结果】，不冒充群友',
    block.includes('【图片生成结果】') && block.includes('一只戴墨镜的鲸鱼')
    && !block.slice(0, block.indexOf('【图片生成结果】')).includes('：'), block);
  const decision = evaluateWindowTrigger({
    entries: [entry], identity: { selfNickname: '小鲸鱼' },
    policy: { responseTier: 1, randomPercent: 0, keywords: [] }, roll: 99
  });
  ok('最低响应档位也不会静默吞掉出图结果（被吞掉 = 模型永远看不到自己画过什么）',
    decision.shouldRespond === true && decision.responseTier === 0 && decision.reason === '图片生成结果',
    JSON.stringify(decision));

  // 失败两态：**同一条通道、同样必须进窗口**，而且标签分得开 —— 模型看到失败标签要做的事
  // 与看到成功标签不同（交代 vs 顺口补一句）。
  const failed = store.appendImageResult(KEY, {
    prompt: '一只猫', status: 'failed', reason: '画图超时（超过 300 秒），稍后再试'
  });
  ok('失败条目：正文说清"没画成"、带上原因，count 记 0',
    failed.imageResult.status === 'failed' && failed.imageResult.count === 0
    && failed.text.includes('没画成') && failed.text.includes('画图超时'), JSON.stringify(failed));
  ok('失败条目：提示词里换成【图片生成失败】标签',
    buildTriggerBlock([failed], {}).includes('【图片生成失败】'));
  ok('失败条目照样进窗口（成功失败走同一条通道是这条链的硬规则）',
    !isSystemRecord(failed) && !isPersonMessage(failed)
    && evaluateWindowTrigger({
      entries: [failed], identity: { selfNickname: '小鲸鱼' },
      policy: { responseTier: 1, randomPercent: 0, keywords: [] }, roll: 99
    }).shouldRespond === true);

  const unsent = store.appendImageResult(KEY, {
    prompt: '一只猫', status: 'unsent', reason: '上传超时了（图可能已经在群里，也可能没发出去）'
  });
  ok('未送达条目**不能**说成"没画成"：图确实画好了，而且消息可能已经在群里',
    unsent.text.includes('已经画好了，但没能发到群里') && !unsent.text.includes('没画成'),
    unsent.text);
  ok('未送达用【图片发送失败】这个标签（与"生成失败"分开）',
    buildTriggerBlock([unsent], {}).includes('【图片发送失败】'));
}

// ── 14. 提示词编译层（两段式：先挑节、再原样贴入编译）───────────────
//
// 这一段的判据围绕**三件"删掉不会报错、只会静默变坏"**的事：
//   · **规则是逐字原样的**（切分与拼接不许改动任何一个字节）—— 那是 CC BY-NC-ND 的边界，
//     也是一旦漂了就没人会发现的那种错；
//   · **关掉编译时端口一次都不许被调**（对照，防"顺手多跑一次"）；
//   · **任何失败都必须 fail-open 且留日志**（防静默降级成"开了编译却没生效"）。
{
  const {
    parseCompiledPrompt, buildCompileRequest, buildSelectRequest, buildUserText, compileImagePrompt,
    splitSkillSections, buildSkillToc, parseSectionSelection, readSkillText,
    PREAMBLE_ID, LAYOUT_JSON_SECTION_ID, DEFAULT_CANVAS, canvasOf, PROMPT_MARK, NEGATIVE_MARK
  } = ig;
  const { PROMPT_CATALOG } = await load('core/prompt-catalog.js');

  // 14a 解析（纯函数）—— 正面是一段 **Layout JSON**（规则 §15），这里判的是"认不认得出来"
  const wrap = (p, n) => `${PROMPT_MARK}\n${p}\n${NEGATIVE_MARK}\n${n}`;
  /** 一份最小的 §15 产物（字段照 §15.1 的示例，画布尺寸字段按 §15.4 不写）。 */
  const layoutJson = JSON.stringify({
    summary: { meta: ['single'], canvas: 'single', caption: '一只猫，居中' },
    items: [{ label: 'object', caption: '一只猫', bbox: [-256, -256, 256, 256] }],
    bbox_coord_space: 'abs_centralized',
    bbox_format: 'yxyx'
  });
  const parsed = parseCompiledPrompt(wrap(layoutJson, 'blurry, watermark'));
  ok('编译解析：正常两段各自取出',
    parsed.ok && parsed.value.positive === layoutJson && parsed.value.negative === 'blurry, watermark',
    JSON.stringify(parsed));
  ok('⚠️ 编译解析：正面是能 `JSON.parse` 的对象 → `layout: true`（§15 那一路走通了）',
    parsed.layout === true);
  ok('编译解析：缺 <<<NEGATIVE>>> 是**宽容**的（2.1 那一档本来就不产负面词）',
    parseCompiledPrompt(`${PROMPT_MARK}\n一只猫`).value?.negative === '');
  ok('编译解析：缺 <<<PROMPT>>> → FORMAT（模型没照格式答）',
    parseCompiledPrompt('好的，这是提示词：一只猫').code === 'FORMAT');
  ok('编译解析：正面为空 → EMPTY', parseCompiledPrompt(wrap('   ', '')).code === 'EMPTY');
  ok('编译解析：剥掉 ``` 围栏之后照样认得出来（模型最爱把 JSON 包进代码块）',
    (() => {
      const r = parseCompiledPrompt(wrap('```json\n' + layoutJson + '\n```', ''));
      return r.ok && r.layout === true && r.value.positive === layoutJson;
    })());
  ok('编译解析：围栏之外还夹了话时，取**第一个 `{` 到最后一个 `}`** 那一段',
    (() => {
      const r = parseCompiledPrompt(wrap(`好的，这是 Layout JSON：\n${layoutJson}\n希望满意`, ''));
      return r.ok && r.layout === true && r.value.positive === layoutJson;
    })());
  // ⚠️ **解不出来不失败**：出图照常、用原文，只是 `layout: false`。这条与"编译失败一律
  // fail-open"是同一条纪律 —— 一次可选增强的格式没照做，不该把一张已经扣过额度的图搞失败。
  ok('⚠️ 编译解析：解不出 JSON **不失败** —— 原样当文本发出（`layout: false`）',
    (() => {
      const r = parseCompiledPrompt(wrap('一只猫', ''));
      return r.ok && r.layout === false && r.value.positive === '一只猫';
    })());
  ok('⚠️ 编译解析：**数组不算** Layout JSON（schema 是对象，收下数组等于给画图模型一段无字段的东西）',
    (() => {
      const r = parseCompiledPrompt(wrap('[1,2,3]', ''));
      return r.ok && r.layout === false && r.value.positive === '[1,2,3]';
    })());
  ok('编译解析：标记**之前**的寒暄被丢掉（模型爱写"好的，这是提示词："）',
    parseCompiledPrompt(`好的！\n${wrap('一只猫', 'blurry')}`).value?.positive === '一只猫');

  // 14a2 画布（纯函数）—— §15 的 bbox 是**绝对像素**，不知道画布多大就编不出坐标
  ok('画布：`size` 解析得出来就用它（bbox 的坐标系必须与真实画幅一致）',
    canvasOf('768*1024').w === 768 && canvasOf('768*1024').h === 1024
    && canvasOf('768*1024').assumed === false);
  ok('画布：`size` 空（自动）或认不出时回落默认值，并**如实标记**是假定的（不能写"未指定"）',
    (() => {
      const auto = canvasOf('');
      const bogus = canvasOf('大一点');
      return auto.w === DEFAULT_CANVAS.w && auto.h === DEFAULT_CANVAS.h && auto.assumed === true
        && bogus.assumed === true;
    })());

  // 14b 分节（纯函数）—— 这是"逐字原样"的机器判据，也是整个两段式的地基
  {
    const doc = [
      '---', 'name: x', '---', '', '# 标题', '> 总闸', '',
      '## 0. 甲', '甲的内容', '### 0.1 子标题', '子内容', '',
      '## 1. 乙', '乙的内容', '',
      '## 9.1 丙', '丙的内容', ''
    ].join('\n');
    const secs = splitSkillSections(doc);
    ok('分节：前言自成 `preamble` 节（frontmatter + 标题 + 总闸都在里面）',
      secs[0].id === PREAMBLE_ID && secs[0].text.includes('> 总闸') && secs[0].text.startsWith('---'),
      JSON.stringify(secs.map((s) => s.id)));
    ok('分节：`## ` 边界切出 3 节，节号取自标题行',
      secs.length === 4 && secs.map((s) => s.id).join(',') === 'preamble,0,1,9.1',
      secs.map((s) => s.id).join(','));
    ok('分节：`### ` 是节内子标题，**不另开一节**（它跟着父节走）',
      secs[1].text.includes('### 0.1 子标题'), secs[1].text);
    ok('⚠️ 分节：全部节拼起来**逐字节等于原文**（切分不许改动任何一个字节 —— CC 的边界就在这）',
      secs.map((s) => s.text).join('') === doc,
      `${secs.map((s) => s.text).join('').length} vs ${doc.length}`);
    ok('分节：空文本返回空数组（不是"一节空的"）', splitSkillSections('').length === 0);
    ok('分节：一个 `## ` 都没有时整份当前言（格式不像预期也不该整条失效）',
      (() => { const r = splitSkillSections('只有一段话'); return r.length === 1 && r[0].id === PREAMBLE_ID; })());

    const toc = buildSkillToc(secs);
    ok('目录：**只有节标题**，一行一节，且前言不进目录（它恒定入选）',
      toc === '## 0. 甲\n## 1. 乙\n## 9.1 丙', JSON.stringify(toc));
    ok('目录：不含任何规则正文（选节那一次必须便宜，否则两段式白跑）',
      !toc.includes('甲的内容') && !toc.includes('子内容'));

    const pick = (t) => parseSectionSelection(t, secs).map((s) => s.id).join(',');
    ok('选择：数字列表按原顺序取出', pick('1,0') === '0,1', pick('1,0'));
    ok('选择：`all` / 中文"全部"都取全部', pick('all') === '0,1,9.1' && pick('全部') === '0,1,9.1');
    ok('选择：空回答 → **全部**（fail-open：漏选一节的代价是画错，多选一节只是几百 token）',
      pick('') === '0,1,9.1' && pick('我看不太懂') === '0,1,9.1');
    ok('选择：编造的节号一个都不匹配 → 退回全部（不返回空，那等于没有规则）',
      pick('42,99') === '0,1,9.1');
    ok('选择：夹在解释文字里的节号照样认得出', pick('需要的节：9.1 就够了。') === '9.1', pick('需要的节：9.1 就够了。'));
  }

  // 14c 真文件：它必须**在包里**，而且我们没改过它一个字
  const skillText = readSkillText();
  ok('规则文件读得到（它在 assets/ 下，已在打包白名单 APP_ENTRIES 里）',
    typeof skillText === 'string' && skillText.length > 50000, String(skillText?.length));
  const sections = splitSkillSections(skillText);
  const numbered = sections.filter((s) => s.id !== PREAMBLE_ID);
  const sec = (id) => (sections.find((s) => s.id === id) || {}).text || '';
  ok('真文件：切出 19 个编号节 + 1 个前言',
    numbered.length === 19 && sections.length === 20, `${numbered.length}/${sections.length}`);
  ok('⚠️ 真文件：全部节拼起来**逐字节等于文件原文**（运行期只切分与拼接，绝不改写）',
    sections.map((s) => s.text).join('') === skillText);
  ok('真文件：`## 9.1` 是独立的 `##` 节（作者把它写在了与 9 同级的位置，切分要跟着原文走）',
    numbered.some((s) => s.id === '9.1'));
  // §15 **恒定入选**（`LAYOUT_JSON_SECTION_ID`），所以它必须真的在文件里 —— 一个拼错的 id
  // 不会报任何错，表现只是"模型没看过 schema 却要按它写 JSON"，而那件事从结果图上看不出来。
  ok('⚠️ 真文件：§15（Layout JSON schema）真的存在，且就是讲 bbox 坐标的那一节',
    numbered.some((s) => s.id === LAYOUT_JSON_SECTION_ID)
    && sec(LAYOUT_JSON_SECTION_ID).includes('bbox_coord_space')
    && sec(LAYOUT_JSON_SECTION_ID).includes('abs_centralized'));
  ok('真文件：frontmatter 与总闸都在前言节里（总闸是全文优先级最高的一段，恒定入选）',
    sec(PREAMBLE_ID).includes('name: moss-image-prompt-skill')
    && sec(PREAMBLE_ID).includes('总闸'));

  // 逐字节收录的**锚点**：哈希一变就说明有人动过这份第三方文件。
  // 那时候要做的是去读 assets/moss-image-prompt-skill/NOTICE.md 并同步版本与日期，
  // **不是**把这条断言改掉。
  {
    const crypto = await import('node:crypto');
    const { PROMPT_SKILL_FILE } = await load('core/paths.js');
    const hash = crypto.createHash('sha256').update(fs.readFileSync(PROMPT_SKILL_FILE), 'utf8').digest('hex');
    ok('⚠️ 真文件：sha256 与收录时一致（对不上 = 有人改过这份第三方文件，先读 NOTICE.md）',
      hash === '75097225dfd2e8723a430a51fcb859fe9ae6b9a0ac68658eb8824bc9d701dead', hash);
  }

  // 14d 两段式的请求形状（纯函数）
  const baseInput = {
    raw: '画个猫', hasReference: false, size: '1024*1024',
    wantsNegative: true, select: true
  };
  const selectReq = buildSelectRequest(baseInput, buildSkillToc(sections));
  const compileReq = buildCompileRequest(baseInput, sec(PREAMBLE_ID) + sec('5'));
  ok('两段式：覆盖前言在两段的**最前面**（它是跨调用稳定的前缀，缓存的命中全靠它）',
    selectReq.system.startsWith(PROMPT_CATALOG.imageCompile.overlay)
    && compileReq.system.startsWith(PROMPT_CATALOG.imageCompile.overlay));
  ok('两段式：第 1 段给目录、不给规则正文',
    selectReq.system.includes('## 5. Step 3 结构布局分流') && !selectReq.system.includes(sec('5')));
  ok('两段式：第 2 段把选中的节**原文**贴进去', compileReq.system.includes(sec('5')));
  ok('两段式：两段共用同一份 user 段（原始描述逐字在里面）',
    selectReq.user === compileReq.user && selectReq.user === buildUserText(baseInput)
    && selectReq.user.includes('画个猫'));
  ok('两段式：user 段把**画布尺寸**念给模型（§15 的 bbox 是绝对像素，不知道画布多大就编不出坐标）',
    compileReq.user.includes('1024×1024') && compileReq.user.includes('bbox')
    && compileReq.user.includes('x∈[-512, 512]'), compileReq.user);
  // ⚠️ 反向断言：**代码层不许再给画面描述定长度上限**。合适的长度是规则集的事（§15 有自己的
  // 字段与取值域），而"写得比我们预期的长"就把整条编译结果扔掉是本末倒置。body 传空串，
  // 于是 system 里只有我们自己的固定指令，不会被规则原文里的字眼干扰。
  ok('两段式：固定指令里**没有**任何字数上限（那一档 2026-10-20 删掉了）',
    !/上限|不超过|字数/.test(buildCompileRequest(baseInput, '').system),
    buildCompileRequest(baseInput, '').system);
  ok('两段式：模型不认负面词时让它别写那一串（省下的 token 是实打实的）',
    buildCompileRequest({ ...baseInput, wantsNegative: false }, '').system.includes('内容留空'));

  // 14d2 对照作者示例 JSON 之后补的五条（2026-10-20）。都住在"任务说明"那一段里，
  // 所以只钉"这几句在不在 system 里" —— 模型照不照做只能人工出图复核。
  // body 传空串，于是扫到的一定是我们自己的固定指令，不会被规则原文里的字眼蒙混过去
  // （比如 §8 那句防克隆句的**原文**就在 body 里，传真 body 的话下一条会永远绿）。
  {
    const fixed = buildCompileRequest(baseInput, '').system;
    ok('五条①：中文 caption 与英文固定句/tag 的分界写明了（§8 防克隆句、§17 的 <|…|> 正文要逐字照抄）',
      fixed.includes('逐字照抄') && fixed.includes('Featuring exactly') && fixed.includes('<|tag|>'));
    ok('五条②：`summary.caption` 末尾要附 §2.1 那批逗号分隔的主体 tag',
      fixed.includes('末尾再附') && fixed.includes('1girl, 1boy'));
    ok('五条③：`caption` 里的方位必须与同一项的 `bbox` 一致（撞到过"说右上角、bbox 在上方中间"）',
      fixed.includes('必须与同一项的 `bbox` 一致') && fixed.includes('拿不准就别写方位'));
    ok('五条④：分格画面里每处文字单独成一项',
      fixed.includes('每处文字单独成一项') && fixed.includes('label:"text"'));
    ok('五条⑤：通用画质词**要自己写全**（§11 的负面底座），只有部署方配的那一条由系统另加',
      fixed.includes('要自己写全') && fixed.includes('blurry') && fixed.includes('只有那一条'));
    // ⚠️ 反向断言：原话"部署方配的通用负面词由系统另加，你不用重复"是**空头承诺** ——
    // `imageGen.negativePrompt` 的出厂值是 `''`（core/config.ts），模型信了它就会一条画质词
    // 都不写。这句话写回来不会有任何报错，只有这一条拦得住。
    ok('⚠️ 反向：那句"通用负面词由系统另加"的空头承诺不许回来',
      !fixed.includes('通用负面词由系统另加') && !fixed.includes('你不用重复'));
  }

  // 14e 覆盖前言与署名
  const overlay = PROMPT_CATALOG.imageCompile.overlay;
  ok('**年龄控制那一节没有被引进来**（它是被覆盖的，不是被搬运的）',
    !overlay.includes('15-year-old') && !overlay.includes('14-year-old'));
  ok('模型适配：明说规则集是给别的模型写的、采样参数那一类条款要跳过（否则模型会写 SLG/Steps）',
    overlay.includes('MOSS-Image') && overlay.includes('qwen-image') && overlay.includes('采样参数'));

  // 署名与许可：CC BY-NC-ND 4.0 的**硬要求**，四样（标题/作者/来源/协议）一个都不能少。
  // 读原文而不是 stripComments —— 署名就住在注释与 NOTICE 里。
  const noticeSrc = fs.readFileSync(path.join(ROOT, 'assets/moss-image-prompt-skill/NOTICE.md'), 'utf8');
  ok('署名：NOTICE.md 里标题 / 作者 / 来源 / 协议四样都在（CC BY-NC-ND 的署名要求）',
    /moss-image-prompt-skill/.test(noticeSrc) && /Moeblack/.test(noticeSrc)
    && /github\.com\/Moeblack\/moss-image-prompt-skill/.test(noticeSrc)
    && /CC BY-NC-ND 4\.0/.test(noticeSrc));
  ok('署名：LICENSE 全文随包（"去掉协议声明"是明确不允许的）',
    fs.existsSync(path.join(ROOT, 'assets/moss-image-prompt-skill/LICENSE')));
  ok('许可边界：NOTICE 里写明了"逐字节原样、不许手工编辑 SKILL.md"',
    noticeSrc.includes('逐字节') && noticeSrc.includes('不要在这里手工编辑'));
  const catalogSrc = readSource('core/prompt-catalog.ts');
  ok('许可边界：**规则正文一个字都不在 prompt-catalog 里**（它运行期从文件读，这里只放我们自己的文本）',
    !catalogSrc.includes('Magic Blocks') && !catalogSrc.includes('单向因果染色定律'));

  // ⚠️ 门禁**已经删掉**（2026-10-20）。它从收录那天起就一直是注释掉的，却在 `compileSystem`
  // 里留着一句"上面的【部署方附加约束】优先于下面全部规则"—— 一句指向不存在的东西的指令。
  // 这是**反向断言**：那两句都不许回来（写回来不会有任何报错，模型只会照它执行一段约束）。
  // ⚠️ **必须剥注释再扫**：`overlay` 上面那段 doc comment 正记着"删了什么、为什么删"，
  // 原样扫会把那段文档本身打红（同 `core/events.ts` 注释里写着 `AgentEventMap` 那条先例）。
  const catalogCode = stripComments(catalogSrc);
  ok('⚠️ 门禁已删：附加约束那一段与那句"优先于下面全部规则"都不在 Catalog 的代码里',
    !catalogCode.includes('部署方附加约束') && !catalogCode.includes('日常着装'));
  // 同批删掉的还有代码层那份写死的安全负面词。它与门禁是同一类东西（"限制写在代码里"），
  // 删掉之后边界由 `imageGen.negativePrompt` / `stylePrompt` 两个**配置项**表达。
  ok('⚠️ 代码层那份写死的安全负面词已经删掉（`SAFETY_NEGATIVE` 不许回来）',
    !stripComments(readSource('media/image-gen/compile.ts')).includes('SAFETY_NEGATIVE')
    && !stripComments(readSource('media/image-gen/queue.ts')).includes('SAFETY_NEGATIVE'));

  // 14f 缺文件 → NO_SKILL + fail-open（注入一个"读不到"的 reader，不必真的动仓库里的文件）
  {
    const r = await compileImagePrompt(baseInput, async () => ({ ok: true, content: '' }), new AbortController().signal, () => null);
    ok('规则文件读不到 → `NO_SKILL`（不是一个含糊的 REQUEST），调用方据此记日志并回退原始描述',
      r.ok === false && r.code === 'NO_SKILL', JSON.stringify(r));
  }

  // 14g 队列集成：真 fetch 出图，看假百炼端点到底收到了什么
  const ds = await fakeDashscope();
  const img = await fakeImageServer();
  updateConfig({ security: { allowPrivateImageHosts: true } });
  const textOf = (r) => r?.body?.input?.messages?.[0]?.content?.at(-1)?.text ?? '';
  // ⚠️ 取法**必须容忍 `undefined`**：这些用例的前提（"请求真的发出去了"）一旦不成立，
  // 一个裸的 `seen.body.…` 会抛 `TypeError` 把**整个套件**中止掉 —— 后面的断言不是变红，
  // 是**从未运行**（AGENTS.md「测试约定」那条）。取成空值，红的才是对应的那一条。
  const paramsOf = (r) => r?.body?.parameters ?? {};

  let asked = [];
  let compilePromptForThis = null;
  /** 一个会**按段数**回答的假端口：看到目录就回节号，否则回编译结果。 */
  const twoStagePort = (picked = '5,17', compiled = '编译后的猫') => async (request) => {
    asked.push(request);
    if (request.system.includes('【规则目录】')) return { ok: true, content: picked };
    return { ok: true, content: `${PROMPT_MARK}\n${compiled}\n${NEGATIVE_MARK}\nblurry, watermark` };
  };
  const make = (log) => new ImageGenQueue({
    getConfig,
    sender: { sendTextBatch: async () => ({ sent: [], failed: [] }), sendImage: async () => ({ message_id: 1 }) },
    log: log || (() => {}),
    deliverImageResult: () => {},
    compilePrompt: compilePromptForThis
  });
  /** 跑一个任务并等它落地（这些用例都只发一张图）。 */
  const runOnce = async (prompt, log) => {
    ds.seen.length = 0;
    ds.script = [{ status: 200, body: okBody(`${img.base}/ok.png`) }];
    const queue = make(log);
    await queue.start();
    queue.enqueue({ chatKey: 'group:70', prompt });
    await sleep(200);
    await queue.stop();
    return ds.seen[0];
  };
  const base = { baseUrl: ds.base, model: 'qwen-image-3.0', negativePrompt: '管理员那条' };

  // ① 两段式（默认）：两次调用，第二次只带挑中的节
  withImageGen({ ...base, compile: { enabled: true, select: true, timeoutMs: 60000 } });
  asked = [];
  compilePromptForThis = twoStagePort();
  const logsTwo = [];
  let seen = await runOnce('画个猫', (...a) => logsTwo.push(a.join(' ')));
  ok('两段式：端口被调了**两次**（先挑节、再编译）', asked.length === 2, String(asked.length));
  ok('两段式：第 1 段给的是目录（含节标题、不含规则正文）',
    asked[0].system.includes('【规则目录】') && asked[0].system.includes('## 5. Step 3 结构布局分流')
    && !asked[0].system.includes(sec('5')));
  ok('两段式：第 2 段**逐字**带着挑中的那两节', asked[1].system.includes(sec('5')) && asked[1].system.includes(sec('17')));
  ok('两段式：**没挑中的节一个都没有**（这是两段式省下来的全部东西）',
    !asked[1].system.includes(sec('16')) && !asked[1].system.includes(sec('0')));
  ok('两段式：前言恒定入选（总闸不进目录、也不由模型挑）', asked[1].system.includes(sec(PREAMBLE_ID)));
  // ⚠️ §15 **恒定入选**：编译的产出就是按它写的 Layout JSON，而模型**没看过 schema 就只能编
  // 字段**。所以它不受"模型挑没挑中它"影响 —— 上面那条用例里模型只挑了 5 和 17。
  ok('⚠️ 两段式：§15（Layout JSON schema）恒定入选，模型没挑它也在里面',
    asked[1].system.includes(sec(LAYOUT_JSON_SECTION_ID))
    && !asked[0].system.includes(sec(LAYOUT_JSON_SECTION_ID)));
  ok('两段式：日志记下"挑了几节"（两段式的全部收益都在这个数上，没有它看不出选节白跑了）',
    logsTwo.some((l) => /compile=ok picked=3\/19 sections=5,15,17 skillChars=\d+ layout=text/.test(l)),
    logsTwo.join(' | '));
  ok('两段式：发给画图模型的是编译结果，不是原始描述',
    textOf(seen).includes('编译后的猫') && !textOf(seen).includes('画个猫'), textOf(seen));
  // ⚠️ 负面词的来源**只剩两条**：编译产出 + 管理员配置那条。代码层那份写死的安全前排
  // 2026-10-20 删掉了 —— 边界现在由 `imageGen.negativePrompt` 这个配置项表达。
  ok('两段式：负面词 = 编译产出 + 管理员那条，顺序就是这个（代码层不再偷偷加安全前排）',
    paramsOf(seen).negative_prompt === 'blurry, watermark, 管理员那条',
    paramsOf(seen).negative_prompt);

  // ①b 正面**真的是一段 Layout JSON** 时：原样发给画图模型，日志里 `layout=json`
  // （这是"按 §15 输出"这条要求在链路上唯一的可观测面 —— 结果图上看不出来）
  {
    const layoutPort = async (request) => {
      asked.push(request);
      if (request.system.includes('【规则目录】')) return { ok: true, content: '5,17' };
      return { ok: true, content: `${PROMPT_MARK}\n${layoutJson}\n${NEGATIVE_MARK}\nblurry` };
    };
    asked = [];
    compilePromptForThis = layoutPort;
    const logsLayout = [];
    const seenLayout = await runOnce('画个猫', (...a) => logsLayout.push(a.join(' ')));
    ok('⚠️ Layout JSON：正面原样发给画图模型（不做任何改写 —— §15 允许自然语言与结构化输入混用）',
      textOf(seenLayout).includes('"bbox_coord_space":"abs_centralized"')
      && textOf(seenLayout).includes('"bbox_format":"yxyx"'), textOf(seenLayout));
    ok('⚠️ Layout JSON：日志里 `layout=json`（模型没照 schema 写时这里会是 `text`，那是唯一的线索）',
      logsLayout.some((l) => /compile=ok picked=3\/19 sections=5,15,17 skillChars=\d+ layout=json/.test(l)),
      logsLayout.join(' | '));
  }

  // ①c 调试点：`QQ_AGENT_DEBUG_IMAGE_JSON=1` 时把编译产物原样打一行（正面 = 那段 Layout JSON）
  {
    // ⚠️ 夹具刻意用**缩进过的** JSON（`null, 2`）：真实模型十有八九就是这么写的，而
    // "整段在一行里"那条断言**只有夹具里带真换行时才有判别力** —— 单行 JSON 的话，
    // 实现里用不用 `JSON.stringify` 都只有一行，那条断言是假的绿（本套件初版就踩了）。
    const prettyLayout = JSON.stringify({
      summary: { meta: ['single'], canvas: 'single', caption: '一只猫，居中' },
      items: [{ label: 'object', caption: '一只猫', bbox: [-256, -256, 256, 256] }],
      bbox_coord_space: 'abs_centralized',
      bbox_format: 'yxyx'
    }, null, 2);
    const layoutPort2 = async (request) => {
      asked.push(request);
      if (request.system.includes('【规则目录】')) return { ok: true, content: '5,17' };
      return { ok: true, content: `${PROMPT_MARK}\n${prettyLayout}\n${NEGATIVE_MARK}\nblurry, watermark` };
    };
    compilePromptForThis = layoutPort2;
    // 默认关：日志里**一个字都不带画面描述**。这条是"这个开关真的在闸门上"的对照 ——
    // 少了它，"打开时有"可能只是因为那行一直打着。
    const logsQuiet = [];
    seen = await runOnce('画个猫', (...a) => logsQuiet.push(a.join(' ')));
    ok('调试点：默认关 —— 日志里既没有 `[image-gen][debug]` 那行，也不带任何画面描述',
      !logsQuiet.some((l) => l.includes('[image-gen][debug]'))
      && !logsQuiet.some((l) => l.includes('bbox_coord_space')),
      logsQuiet.join(' | '));

    process.env.QQ_AGENT_DEBUG_IMAGE_JSON = '1';
    const logsDebug = [];
    try {
      compilePromptForThis = layoutPort2;
      seen = await runOnce('画个猫', (...a) => logsDebug.push(a.join(' ')));
    } finally {
      // 被测模块是模块级单例、同进程后续用例共用，环境变量必须还原（同 `withFakeTimers` 那条纪律）。
      delete process.env.QQ_AGENT_DEBUG_IMAGE_JSON;
    }
    const debugLine = logsDebug.find((l) => l.includes('[image-gen][debug]'));
    ok('调试点：打开后那一行里是**编译产物的原文** —— 正面是那段 Layout JSON、负面另起一格',
      !!debugLine && debugLine.includes('bbox_coord_space')
      && debugLine.includes(JSON.stringify('blurry, watermark')),
      debugLine || logsDebug.join(' | '));
    // ⚠️ 判据是"捕获到的那一行里没有**真**换行"：journald 按行拆多行条目，散开就看不懂了。
    // `JSON.stringify` 把换行转义成 `\n`（反斜杠 + n 两个字符）正是为此，这条断言钉住那个转义
    // 没被去掉 —— 夹具里那份 JSON 是缩进过的，所以去掉转义这里当场会红（探针实测过）。
    ok('⚠️ 调试点：整段 JSON 在**一行**里（换行被 `JSON.stringify` 转义，不是真换行）',
      !!debugLine && !debugLine.includes('\n') && !debugLine.includes('\r'),
      JSON.stringify(debugLine));
  }

  // ② 挑不出来 → 退回全文（fail-open 到"最保险的那一档"，不会因为挑错而少给规则）
  asked = [];
  compilePromptForThis = twoStagePort('胡说八道');
  seen = await runOnce('画个猫');
  ok('挑不出来时退回**全文**（19/19）—— 宁可多花 token，也不要因为挑错而少给规则',
    asked.length === 2 && asked[1].system.includes(sec('16')) && asked[1].system.includes(sec('0')));

  // ③ `select: false` → 一次调用、直接上全文
  withImageGen({ ...base, compile: { enabled: true, select: false, timeoutMs: 60000 } });
  asked = [];
  compilePromptForThis = twoStagePort();
  const logsFull = [];
  seen = await runOnce('画个猫', (...a) => logsFull.push(a.join(' ')));
  ok('单段全文：**只调一次**，system 里是整份规则原文（harness 里"判定相关就读整份"的那一档）',
    asked.length === 1 && asked[0].system.includes(sec('5')) && asked[0].system.includes(sec('16'))
    && asked[0].system.includes(sec(PREAMBLE_ID)), String(asked.length));
  // 上面那条只证明"某几节在里面"。这一条才是**整份原样**：文件全文作为一个连续子串出现在
  // system 里 —— 中间没被插进任何东西，也没少任何一个字节。
  ok('⚠️ 单段全文：**整份原文逐字**都在 system 里（`includes(全文)` —— 连续子串，没插东西也没少字节）',
    asked[0].system.includes(skillText),
    `文件 ${skillText.length} 字符，system ${asked[0].system.length} 字符`);
  ok('单段全文：日志里记的是 19/19 且 `sections=all`（没有选节那一次，全部节都进了）',
    logsFull.some((l) => /compile=ok picked=19\/19 sections=all/.test(l)), logsFull.join(' | '));
  // **这一条是整个"逐字节原样"最直接的证据**：`skillChars` 就是实际拼进 system 的规则原文
  // 字符数，`select:false` 时它必须**恰好**等于文件长度 —— 少一个字都说明没贴全。
  ok('⚠️ 单段全文：日志里的 `skillChars` 恰好等于 SKILL.md 的长度（少一个字节就是没贴全）',
    logsFull.some((l) => l.includes(`skillChars=${skillText.length}`)),
    `文件 ${skillText.length} 字符；日志：${logsFull.filter((l) => l.includes('compile=ok')).join(' | ')}`);

  // ④ 对照：编译关掉 —— 端口一次都不许被调，且行为与加这一层之前逐字相同
  withImageGen({ ...base, compile: { enabled: false, select: true, timeoutMs: 60000 } });
  asked = [];
  compilePromptForThis = twoStagePort();
  const logsOff = [];
  seen = await runOnce('画个猫', (...a) => logsOff.push(a.join(' ')));
  ok('对照：编译关掉时端口**一次都没被调**（不是"调了但不用"）', asked.length === 0, String(asked.length));
  // 关着也必须留一行。否则日志里"什么都没有"同时对应两种完全不同的情况 ——
  // 配置没开、与开了但压根没走到 —— 而排查"我的 skill 怎么没生效"第一步就是回答这个。
  ok('对照：编译关掉时日志里有 `compile=off`（不是什么都不打）',
    logsOff.some((l) => l.includes('compile=off')) && !logsOff.some((l) => l.includes('compile=ok')),
    logsOff.join(' | '));
  ok('对照：关掉编译时正面提示词就是原始描述', textOf(seen).startsWith('画个猫'), textOf(seen));
  ok('对照：关掉编译时负面词回落成管理员配置那条（**不偷偷加安全前排**）',
    paramsOf(seen).negative_prompt === '管理员那条', paramsOf(seen).negative_prompt);

  // ⑤ fail-open：端口抛错 → 图照样出，用原始描述，且日志留下固定码
  withImageGen({ ...base, negativePrompt: '', compile: { enabled: true, select: true, timeoutMs: 60000 } });
  const logsFail = [];
  compilePromptForThis = async () => { throw new Error('连不上 https://example.com/x 或 C:\\secret\\a.json'); };
  seen = await runOnce('画个猫', (...a) => logsFail.push(a.join(' ')));
  ok('fail-open：编译抛错时图**照样出来了**，用的是原始描述（额度已经扣了，不能白扣）',
    !!seen && textOf(seen).startsWith('画个猫'), textOf(seen));
  ok('fail-open：日志里留下固定码 COMPILE_REQUEST（这是管理员唯一能发现"编译一直失败"的地方）',
    logsFail.some((l) => l.includes('COMPILE_REQUEST')), logsFail.join(' | '));
  ok('fail-open：日志里的细节**洗过**了（URL 与本机路径不许进日志）',
    !logsFail.some((l) => l.includes('https://example.com') || l.includes('C:\\secret')),
    logsFail.join(' | '));
  ok('fail-open：**挑节那一次失败也算失败**（不拿一个空选择继续往下编译）',
    logsFail.filter((l) => l.includes('COMPILE_REQUEST')).length >= 1);

  // ⑥ 2.1：负面词不发（发了会被判 400），且日志说明是模型不支持
  withImageGen({ ...base, model: 'qwen-image-2.1-turbo', compile: { enabled: true, select: true, timeoutMs: 60000 } });
  const logs21 = [];
  compilePromptForThis = twoStagePort();
  seen = await runOnce('画个猫', (...a) => logs21.push(a.join(' ')));
  ok('2.1 系列：negative_prompt **不发**（发了会被接口判 400）',
    paramsOf(seen).negative_prompt === undefined, JSON.stringify(paramsOf(seen)));
  ok('2.1 系列：日志说明是模型不支持（否则"负面词没生效"会被当成配置写错了去查）',
    logs21.some((l) => l.includes('SKIPPED_UNSUPPORTED')), logs21.join(' | '));
  ok('2.1 系列：正面提示词照样是编译结果（负面那一半被丢，正面不受影响）',
    textOf(seen).includes('编译后的猫'), textOf(seen));

  // ⑦ 端口没接上（配置开着但没注入）——必须留线索，否则"开了编译、一个字没变"无从查起
  withImageGen({ ...base, compile: { enabled: true, select: true, timeoutMs: 60000 } });
  const logsNoPort = [];
  compilePromptForThis = null;
  seen = await runOnce('画个猫', (...a) => logsNoPort.push(a.join(' ')));
  ok('端口没接上：照常按原始描述出图，且日志里有 COMPILE_NO_PORT',
    textOf(seen).startsWith('画个猫') && logsNoPort.some((l) => l.includes('COMPILE_NO_PORT')),
    logsNoPort.join(' | '));

  // ⑧ 超时：一次挂住的编译不能把单并发队列堵死。
  // ⚠️ 这一条要真等 5 秒 —— `compile.timeoutMs` 的钳制下限就是 5000（见 config.ts），
  // 没有更快的办法从配置侧构造出这条死线。慢归慢，它守的是"队列被整个堵死"这件事。
  // **不能用 `runOnce`**：它在 200ms 时就 `stop()`，那会先一步 abort 掉在途的编译，
  // 于是这条用例测的就成了"stop 会不会中止编译"，而不是"死线到点会不会中止它"。
  withImageGen({ ...base, compile: { enabled: true, select: true, timeoutMs: 5000 } });
  const logsTimeout = [];
  let abortedAt = 0;
  const t0 = Date.now();
  compilePromptForThis = (request, signal) => new Promise((resolve) => {
    signal.addEventListener('abort', () => {
      abortedAt = Date.now() - t0;
      resolve({ ok: false, message: 'aborted' });
    }, { once: true });
  });
  ds.seen.length = 0;
  ds.script = [{ status: 200, body: okBody(`${img.base}/ok.png`) }];
  const queueTimeout = make((...a) => logsTimeout.push(a.join(' ')));
  await queueTimeout.start();
  queueTimeout.enqueue({ chatKey: 'group:70', prompt: '画个猫' });
  await sleep(6500);
  await queueTimeout.stop();
  const seenTimeout = ds.seen[0];
  ok('编译超时：死线**到点才**中止那一次调用（约 5 秒，不是立刻、也不是永不）',
    abortedAt >= 4900 && abortedAt < 8000, `abortedAt=${abortedAt}ms`);
  ok('编译超时：中止之后图照常出、用的是原始描述（单并发队列不会被一次挂住的编译堵死）',
    !!seenTimeout && textOf(seenTimeout).startsWith('画个猫'), textOf(seenTimeout));
  ok('编译超时：日志里有 COMPILE_REQUEST（超时走的是端口回 ok:false 那条路）',
    logsTimeout.some((l) => l.includes('COMPILE_REQUEST')), logsTimeout.join(' | '));

  updateConfig({ security: { allowPrivateImageHosts: false } });
  ds.close();
  img.close();
}

// ── 13. 源级接线（几条"删掉不会报错、只会静默变坏"的）────────────
const clientSrc = stripComments(readSource('media/image-gen/client.ts'));
ok('client.ts 里没有任何日志调用（Key 在 Authorization 头里，那里是唯一可能出现它的地方）',
  !/console\.(log|warn|error)/.test(clientSrc));
ok('negative_prompt 的判定只有一处（client.ts 里这个字面量只出现一次）',
  (clientSrc.match(/negative_prompt/g) || []).length === 1,
  String((clientSrc.match(/negative_prompt/g) || []).length));
const queueSrc = stripComments(readSource('media/image-gen/queue.ts'));
ok('队列自身不 import qq/ 或 chat/（跨层只走注入的端口）',
  !/from '\.\.\/\.\.\/(qq|chat|agent)\//.test(queueSrc));
ok('队列的 0ms 唤醒句柄被存进 #wake（有句柄 stop 才取消得掉）',
  /#wake = setTimeout\(/.test(queueSrc) && /clearTimeout\(this\.#wake\)/.test(queueSrc));

const toolSrc = stripComments(readSource('agent/tools/image-gen.ts'));
ok('工具自己一次都不发消息（不出现 sendTextBatch / sendImage 调用）',
  !/\.sendTextBatch\(|\.sendImage\(/.test(toolSrc));

// 编译层的跨层边界：`llm` 与 `media` 同属 T1、严格互斥（T1_ALLOW 是空集），
// 所以它**只能**走注入的端口。删掉这一条的话，一次"顺手 import chatCompletion"
// 不会有任何报错 —— 只有 check-layers 会红，而那条闸门说的是"依赖方向"、
// 不说"这一层该不该自己调模型"。
const compileSrc = stripComments(readSource('media/image-gen/compile.ts'));
ok('编译层不 import llm/，也不 import qq|chat|agent（跨层只走注入的端口）',
  !/from '\.\.\/\.\.\/(llm|qq|chat|agent)\//.test(compileSrc), '');
ok('编译层不自己调 fetch（它只组装请求 + 解析，网络归宿主注入的端口）',
  !/\bfetch\(/.test(compileSrc));
ok('编译层的规则来自 catalog，不是就地写死（模型可见的固定指令只许有一个落点）',
  /PROMPT_CATALOG\.imageCompile/.test(compileSrc));
// 规则文件路径**必须**从 core/paths.ts 取。写死在 compile.ts 里的话，文件挪窝只会在运行期
// 变成一次 `readFileSync` 失败 —— 而它的表现是"编译静默失效、退回原始描述"，与"没开编译"一样。
ok('编译层：规则文件路径来自 core/paths.js（不自己拼字面量 —— 那种错只在运行期炸）',
  /from '\.\.\/\.\.\/core\/paths\.js'/.test(compileSrc)
  && /PROMPT_SKILL_FILE/.test(compileSrc)
  && !/assets\/moss|assets'/.test(compileSrc));
ok('编译层：两段调用的 system 都以覆盖前言开头（它是跨调用稳定的前缀，缓存的命中全靠它）',
  /const withOverlay = \(rest: string\) => `\$\{PROMPT_CATALOG\.imageCompile\.overlay\}/.test(compileSrc));
ok('编译层：切分只认 `## `（`### ` 是节内子标题），且切片按**原文字符下标**（逐字节的关键）',
  /\/\^## \(\?!#\)\/gm/.test(compileSrc) && /body\.slice\(starts\[i\]/.test(compileSrc));
ok('编译层：拼装用**空串**连接（换行连接会在节之间插入原文没有的东西，那就不是"原样引用"了）',
  /\.map\(\(s\) => s\.text\)\.join\(''\)/.test(compileSrc));
ok('⚠️ 编译层里**不许出现规则正文**（它只负责切分与拼接；正文从文件读，我们不许改）',
  !compileSrc.includes('Magic Blocks') && !compileSrc.includes('单向因果染色'));

// `#compile` 必须排在 `run` **之前**：编译结果写在 job 上，出图那一步读它。
// 顺序反了不会有任何编译错误 —— 表现只是"编译开了但提示词没变"。
ok('队列：编译排在出图之前（`await this.#compile(` 出现在 `const run =` 之前）',
  queueSrc.indexOf('await this.#compile(') > -1
  && queueSrc.indexOf('await this.#compile(') < queueSrc.indexOf('const run = this.#operations.runTask'));
ok('队列：出图用的是编译产物、回落原始描述（`job.compiled?.positive ?? job.prompt`）',
  /job\.compiled\?\.positive \?\? job\.prompt/.test(queueSrc));
ok('队列：编译那一次调用有自己的死线（出图那条最长 15 分钟，不能让它把编译一起拖住）',
  /setTimeout\(\(\) => controller\.abort\(\), config\.compile\.timeoutMs\)/.test(queueSrc));

// 端口的真实现只在组装根。**删掉 app.ts 那一行不会有任何报错** ——
// 表现是"编译开着却什么都没发生"，而日志里只有一行 COMPILE_NO_PORT。
const appSrc = readSource('web/app.ts');
ok('接线：app.ts 真的把编译端口递给队列了',
  /compilePrompt: compileImagePrompt/.test(appSrc));
ok('接线：那个端口用 temperature 0.2（这是转换不是创作，同一个需求该编译出同一个结果）',
  /temperature: 0\.2/.test(stripComments(appSrc)));
ok('接线：那次调用的用量走 addExtraUsage（它多半发生在会话 finish() 之后，不能走整份累加那条路）',
  /sessions\.addExtraUsage\(addUsage\(emptyUsage\(\), result\.usage\)\)/.test(appSrc));

// 图片段的超时必须比 `call()` 的默认值大得多 —— 真机实测的假失败就是这 15 秒造成的。
{
  const { SEGMENT_UPLOAD_TIMEOUT_MS } = await load('qq/onebot.js');
  const onebotSrc = stripComments(readSource('qq/onebot.ts'));
  ok('图片段的上传超时远大于 call() 的 15 秒默认值（真机每一次出图都死在这上面）',
    Number(SEGMENT_UPLOAD_TIMEOUT_MS) >= 60000, String(SEGMENT_UPLOAD_TIMEOUT_MS));
  ok('sendImage 真的把它传给了 sendSegments（常量在那儿躺着不算数）',
    /sendSegments\(kind, id, segments, SEGMENT_UPLOAD_TIMEOUT_MS\)/.test(onebotSrc));
  ok('纯文本仍走默认的 15 秒（别顺手把整条发送链都拉长）',
    /async call\(action: string, params: Record<string, unknown> = \{\}, timeoutMs = 15000\)/.test(onebotSrc));
}

// 设置页三件套的 id 必须对得上：只有 save.js 读了某个 id、而 sections.js 里没有这个输入框时，
// `val()` 取到 undefined 会**静默回退成当前值** —— 用户改了没反应，且没有任何报错。
{
  const sectionsSrc = fs.readFileSync(path.join(ROOT, 'ui/js/views/settings/sections.js'), 'utf8');
  const saveSrc = fs.readFileSync(path.join(ROOT, 'ui/js/views/settings/save.js'), 'utf8');
  const indexSrc = fs.readFileSync(path.join(ROOT, 'ui/js/views/settings/index.js'), 'utf8');
  const declared = new Set([...sectionsSrc.matchAll(/id="(cfg-imagegen-[\w-]+)"/g)].map((m) => m[1]));
  const read = new Set([...saveSrc.matchAll(/'#(cfg-imagegen-[\w-]+)'/g)].map((m) => m[1]));
  const missing = [...read].filter((id) => !declared.has(id));
  ok('设置页：save.js 读的每个 cfg-imagegen-* id 都在 sections.js 里真的存在（否则静默回退成当前值）',
    read.size >= 10 && missing.length === 0, `缺：${missing.join('、')}`);
  ok('设置页：分区已接进菜单与分发（否则整块设置页都进不去）',
    /'image-gen', '图像生成'/.test(indexSrc) && /'image-gen': \(\) => renderImageGenSection\(c\)/.test(indexSrc));
  ok('设置页：API Key 用密码框回显掩码（留空不修改），照 sauceNao 那条',
    /id="cfg-imagegen-apikey"[\s\S]{0,80}type="password"/.test(sectionsSrc)
    || /type="password"[\s\S]{0,80}id="cfg-imagegen-apikey"/.test(sectionsSrc));

  // 编译层各档的钳制有**两份实现**（后端 resolver 与设置页 save），它们必须逐项一致。
  // 漂移的表现是"我填了 5000 却按别的数走"，而没人会去比两边源码（同 webSearch 那条）。
  const configSrc = stripComments(readSource('media/image-gen/config.ts'));
  ok('编译层钳制：后端 resolver 与设置页 save 是**同一组数**（漂移 = 填了却不按它走）',
    /boundedInt\(raw\.compile\?\.timeoutMs, 60_000, 5_000, 300_000\)/.test(configSrc)
    && /clampInt\(val\('#cfg-imagegen-compile-timeout'[\s\S]{0,40}?5000, 300000, 60000\)/.test(saveSrc));
  ok('编译层：设置页的 input 上下限与那组数一致（min/max 写错时浏览器只拦一半）',
    /id="cfg-imagegen-compile-timeout"[^>]*min="5000"[^>]*max="300000"/.test(sectionsSrc));
  // ⚠️ 反向断言：那一档字数上限**三处都不许留**（后端配置项 / save 的读取 / 设置页的输入框）。
  // 留一处不会有任何报错，只会让"编译产物多长"重新变成代码层的判断 —— 而那是规则集（§15）的事。
  ok('⚠️ 编译层：`maxChars` 那一档在后端配置、save 与设置页三处都不存在了',
    !/maxChars/.test(configSrc) && !/cfg-imagegen-compile-maxchars/.test(saveSrc)
    && !/cfg-imagegen-compile-maxchars/.test(sectionsSrc)
    && !/maxChars/.test(stripComments(readSource('media/image-gen/compile.ts'))));
  // 编译层的三档配置**没有"留着不用"的字段**：多一个键就多一处"配了没反应"。
  ok('⚠️ 编译层：`ImageCompileConfig` 恰好三个键（多一个键 = 多一处"配了没反应"）',
    /interface ImageCompileConfig \{[\s\S]*?\n\}/.test(stripComments(readSource('media/image-gen/types.ts')))
    && (stripComments(readSource('media/image-gen/types.ts'))
      .match(/interface ImageCompileConfig \{[\s\S]*?\n\}/)[0].match(/^\s{2}\w+[?]?:/gm) || []).length === 3);
  ok('编译层：默认值是**关**（设置页的 checkbox 不勾），且文案说清"多一次模型调用"',
    /id="cfg-imagegen-compile-enabled"[^>]*\$\{g\.compile\?\.enabled === true \? 'checked' : ''\}/.test(sectionsSrc)
    && sectionsSrc.includes('每张图会多一到两次模型调用'));
  // 设置页那句"正面按 §15 的 Layout JSON 输出"是**对用户的承诺**，必须与实现一致 ——
  // 实现改成 JSON、文案还写着"一段描述"的话，管理员永远不会知道要去看 `layout=` 那一格。
  ok('编译层：设置页写明了产出是 §15 的 Layout JSON，并给出 `layout=json|text` 这个观测点',
    sectionsSrc.includes('Layout JSON') && sectionsSrc.includes('layout=json|text'));
  // `select` 这一栏的判据与后端 `raw.compile?.select !== false`（缺省真）是**同一条**：
  // 写反了不会报任何错，表现只是"勾了没反应 / 取消勾选反而变两次调用"。
  ok('编译层：`select` 那一栏的缺省也是**开**，且 save 与后端同一条判据',
    /id="cfg-imagegen-compile-select"[^>]*\$\{g\.compile\?\.select !== false \? 'checked' : ''\}/.test(sectionsSrc)
    && /chk\('#cfg-imagegen-compile-select', g\.compile\?\.select !== false\)/.test(saveSrc)
    && /select: raw\.compile\?\.select !== false/.test(configSrc));
}

process.exit(done() ? 0 : 1);
