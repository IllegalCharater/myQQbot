// 模型端点的错误翻译（`src/llm/llm.ts` 的 `describeApiError`）。
//
// 存在的理由是一条真机反馈：截图里群里什么都没发生，面板的「会话」详情里躺着一串英文 JSON ——
// `{"error":{"code":"data_inspection_failed",...}}`。用户不可能从这句话里知道
// "是模型端的内容审核拒了请求"、"下一步该干嘛"。
//
// 这个套件钉两头：**认得出的要翻成人话**，**认不出的必须原样给**（猜错比不翻更糟 ——
// 用户会照着错的提示去改配置）。外加一条最容易被重构弄坏的：错误消息的开头必须仍是
// `模型 API HTTP <状态码>`，`isRetryableError` 靠它判"客户端错误不重试"。
import { checker, dataDir } from './lib/harness.mjs';
import { load } from './lib/src.mjs';

// `llm.js` 在加载时会读配置，而配置要定死数据目录 —— 必须排在 `load` 之前。
dataDir('qqagent-llm-error-');
const { ok, done } = checker();

const { describeApiError, isRetryableError } = await load('llm/llm.js');

// 真机上收到的那一份（逐字），不另编一个更好看的夹具。
const INSPECTION_BODY = JSON.stringify({
  error: {
    code: 'data_inspection_failed',
    param: null,
    message: 'Input text data may contain inappropriate content.',
    type: 'data_inspection_failed'
  },
  id: 'chatcmpl-83562705-806a-961c-958b-abdbe15a99b5'
});

// ── 1. 输入审核：翻成人话，且给出两条可执行的下一步 ──────────────────────────
{
  const text = describeApiError(400, INSPECTION_BODY);
  ok('★ 认出 `data_inspection_failed` 并说清"这是输入审核，不是网络或配置问题"',
    text.includes('输入审核未通过') && text.includes('不是网络或配置问题'), text);
  ok('给出两种常见来源（工具结果 / 一直在上下文里的东西）—— 它们对应不同的处置',
    text.includes('工具刚返回的内容') && text.includes('一直在上下文里的东西'), text);
  ok('原始响应留着（排查时要看得到它原样长什么样）',
    text.includes('原始响应：') && text.includes('data_inspection_failed'), text);
  ok('不带 Markdown 的 `**`（面板对 error 是原样转义显示的）', !text.includes('**'), text);
}

// ── 2. 分类不能坏：前缀仍是 `模型 API HTTP <码>` ─────────────────────────────
{
  const text = describeApiError(400, INSPECTION_BODY);
  ok('★ 消息仍以 `模型 API HTTP 400` 开头，且 `isRetryableError` 仍判"不该重试"',
    text.startsWith('模型 API HTTP 400') && isRetryableError(new Error(text)) === false,
    text.slice(0, 40));
  const limited = describeApiError(429, INSPECTION_BODY);
  ok('对照：429 仍被判成可重试（翻译没有把限流也吞掉）',
    isRetryableError(new Error(limited)) === true, limited.slice(0, 40));
}

// ── 3. 认不出的错误：原样给，绝不编造原因 ────────────────────────────────────
{
  const html = '<html><body><h1>502 Bad Gateway</h1></body></html>';
  const text = describeApiError(502, html);
  ok('非 JSON 的错误体（比如网关的 HTML 页）原样透传，不编原因',
    text === `模型 API HTTP 502：${html}`, text);

  const keyBody = JSON.stringify({ error: { code: 'invalid_api_key', message: 'Incorrect API key provided' } });
  const keyText = describeApiError(401, keyBody);
  ok('别的错误码同样原样透传（不冒充成内容审核）',
    keyText === `模型 API HTTP 401：${keyBody}` && !keyText.includes('输入审核'), keyText);
}

// ── 4. 原文截断：错误体可能很长（有的网关会把整页 HTML 塞进来）────────────────
{
  const huge = 'x'.repeat(10000);
  const text = describeApiError(500, huge);
  ok('超过 500 字的错误体只留前 500 字（面板里不铺一屏）',
    text.length < 600, String(text.length));
}

process.exit(done() ? 0 : 1);
