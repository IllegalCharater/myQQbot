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

function makeQueue({ operations = {}, deliver, senderOverrides = {} } = {}) {
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
    deliverImageResult: deliver ?? null
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
}

process.exit(done() ? 0 : 1);
