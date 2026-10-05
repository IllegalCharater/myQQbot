/**
 * 收藏夹的「请求结构」：按一段**结构化请求**去取数据，并把它转成搜索结果。
 *
 * 与同目录 `web-search.ts` 的「站内搜索地址」是两种不同的取数方式：
 *   · **站内搜索地址** —— 去一个**网页搜索页**抓 HTML，从链接里解析候选；
 *   · **请求结构**（本模块）—— 按指定的**方法 / 地址 / 请求头**发一次请求，把响应
 *     （通常是 JSON，如百度千帆的百科接口）转成候选。
 *
 * 为什么必须有这一条：很多权威数据源只提供 **JSON 接口**，它们没有"结果页"这回事。
 * 硬塞进站内搜索链的表现是**永远检测不通过**且报错指向"页面改版/容器类名"——
 * 方向完全错（实测：`appbuilder.baidu.com` 的百科接口）。
 *
 * ## 占位符的两分法（这条是配置形状的核心）
 *
 * | 形态 | 含义 | 值从哪来 |
 * |---|---|---|
 * | `{q}` | **运行时查询词** | 每次调用时由查询内容填入 |
 * | 其它 `{xxx}` | **静态参数**（如 `{top_k}`） | 设置页里给每个填一个固定值 |
 *
 * 这个区分是刻意的：`top_k` 这类参数配一次就不动，如果让它变成运行时变量，模型每次
 * 都要自己编一个值；而 `{q}` 必须每次变。凭据**两者都不是** —— 它走 `credential`，
 * 落地时从配置里取真值，模板正文里永远只有占位（见 `applyCredential`）。
 */

/** 静态参数值的上限（够放 token 之外的一切），防止有人把整篇文档粘进来。 */
const MAX_PARAM_VALUE = 500;
/** 请求头条数上限：正常接口几个到十几个，给足但不至于让配置无限膨胀。 */
const MAX_HEADERS = 20;
export const MAX_ENDPOINT_CHARS = 2000;
export const MAX_HEADER_NAME_CHARS = 100;
export const MAX_HEADER_VALUE_CHARS = 1000;

/** HTTP 方法白名单。**不开 PUT/DELETE/PATCH**：这是"取数据"的配置，不该有副作用。 */
export const BOOKMARK_METHODS = ['GET', 'POST'] as const;
export type BookmarkMethod = (typeof BOOKMARK_METHODS)[number];

export interface BookmarkHeader {
  name: string;
  value: string;
}

/** 请求结构：方法 + 地址 + 可选请求头。 */
export interface BookmarkRequest {
  method: BookmarkMethod;
  /** 完整 http(s) 地址，或只写路径（此时必须有一个 `Host` 头）。含 `{q}` 占位符。 */
  endpoint: string;
  headers?: BookmarkHeader[];
}

export interface BookmarkSite {
  key: string;
  host: string;
  purpose: string;
  /** 站内搜索地址模板（含 `{q}`）。与 `request` 互斥：有 request 时以 request 为准。 */
  searchUrl?: string;
  /** 请求结构（含 `{q}`）。填了就**按它发请求**，不再走 HTML 解析那条路。 */
  request?: BookmarkRequest;
  /** 静态占位符的值：`{top_k}` → `params.top_k`。 */
  params?: Record<string, string>;
  /** 结果容器类名（HTML 站内搜索用；JSON 接口不需要）。 */
  resultClass?: string;
}

/** 占位符：`{q}` 或 `{名字}`。名字限 ASCII 标识符，避免把 JSON 正文里的 `{}` 误当占位符。 */
const PLACEHOLDER_RE = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** 取出模板里除 `{q}` 之外的占位符名字（去重，保持出现顺序）。 */
export function staticPlaceholders(template: string): string[] {
  const out: string[] = [];
  for (const m of String(template ?? '').matchAll(PLACEHOLDER_RE)) {
    const name = m[1];
    if (name === 'q' || out.includes(name)) continue;
    out.push(name);
  }
  return out;
}

/**
 * 把模板里的占位符全部替换成实际值。
 *
 * **没给值的占位符要报错，不能原样留下**：留着 `{top_k}` 会被 URL 编码成 `%7Btop_k%7D`
 * 发给服务端，表现为"接口返回空/报参数错误"，而配置页看起来配好了 —— 与
 * `bookmarkList()` 那条"必须含 `{q}`"是同一条判据：**拼不出查询的请求不如直接拒掉**。
 */
export function fillRequestTemplate(
  template: string,
  values: { q: string; params?: Record<string, string> }
): { ok: true; value: string } | { ok: false; error: string } {
  const params = values.params || {};
  const missing: string[] = [];
  const value = String(template ?? '').replace(PLACEHOLDER_RE, (_all, name: string) => {
    if (name === 'q') return encodeURIComponent(values.q);
    const v = params[name];
    if (v === undefined || v === '') { missing.push(name); return ''; }
    return encodeURIComponent(v);
  });
  if (missing.length) {
    const names = [...new Set(missing)].map((n) => `{${n}}`).join('、');
    return { ok: false, error: `这些占位符还没有填值：${names}。请在设置页的「静态参数」里给它们各填一个值（例如 top_k = 5）。` };
  }
  return { ok: true, value };
}

/**
 * 把 `Authorization: Bearer <API Key>` 这类凭据头拼上。
 *
 * 真值存在配置里，**模板正文里只有占位**（设置页显示为 `<API Key>`）。这一条与
 * `SauceNAO` 的 `apiKey` 只走 stdin 是同一条不变量：密钥不进模板文本、不进日志。
 */
export function applyCredential(
  headers: BookmarkHeader[],
  credential: { header: string; scheme: string; value: string } | undefined
): BookmarkHeader[] {
  const out = headers.filter((h) => h.name.toLowerCase() !== 'authorization');
  if (!credential || !credential.value) return out;
  const header = String(credential.header || 'Authorization').trim();
  if (!header) return out;
  const scheme = String(credential.scheme || '').trim();
  return [...out, { name: header, value: scheme ? `${scheme} ${credential.value}` : credential.value }];
}

/** 从请求结构里解析出最终要请求的 URL（处理"只给路径 + Host 头"的写法）。 */
export function resolveEndpoint(request: BookmarkRequest): { ok: true; url: string } | { ok: false; error: string } {
  const raw = String(request.endpoint || '').trim();
  if (!raw) return { ok: false, error: '请求路径是空的。' };
  if (/^https?:\/\//i.test(raw)) return { ok: true, url: raw };
  // 只写了路径 → 用 Host 头补出完整地址（文档里那种 `HOST: appbuilder.baidu.com` 的写法）
  const host = (request.headers || []).find((h) => h.name.trim().toLowerCase() === 'host')?.value.trim();
  if (!host) {
    return { ok: false, error: '请求路径没有带协议，也没找到 Host 请求头 —— 至少要给一个，否则拼不出完整地址。' };
  }
  if (!/^[A-Za-z0-9.-]+(:\d+)?$/.test(host)) {
    return { ok: false, error: `Host 请求头看起来不是主机名：${host}` };
  }
  return { ok: true, url: `https://${host}${raw.startsWith('/') ? '' : '/'}${raw}` };
}

export interface ExecutedBookmarkRequest {
  /** 转成搜索结果之后的内容。 */
  results: Array<{ title: string; url: string; snippet: string }>;
  /** 供归因/日志用：实际请求的地址（已含查询词，**不含凭据**）。 */
  url: string;
  status: number;
}

/**
 * 发一次请求并把响应转成搜索结果。
 *
 * 响应形态分两路：
 *   · **JSON** → `jsonToResults()` 通用转换（找对象数组 / 用已知字段名）或
 *     `flattenJson()` 压平成一段资料；
 *   · **HTML** → 交给调用方（`web-search.ts`）用现成的链接解析器处理。
 *     本函数只在拿到 HTML 时把正文回传，不重复实现一遍解析。
 */
export interface BookmarkFetchResult {
  kind: 'json' | 'html' | 'other';
  body: string;
  contentType: string;
  url: string;
  status: number;
}

export async function fetchBookmarkRequest(
  request: BookmarkRequest,
  values: { q: string; params?: Record<string, string>; credential?: { header: string; scheme: string; value: string } },
  options: { timeoutMs?: number } = {}
): Promise<{ ok: true; response: BookmarkFetchResult } | { ok: false; error: string }> {
  const filled = fillRequestTemplate(request.endpoint, values);
  if (!filled.ok) return { ok: false, error: filled.error };
  const resolved = resolveEndpoint({ ...request, endpoint: filled.value });
  if (!resolved.ok) return { ok: false, error: resolved.error };

  // ⚠️ **与站内搜索同一条取舍：这里不做 SSRF 校验**（`validateFetchUrl`）。
  //
  // 判据是"谁决定这个地址"：`web_fetch` 的地址来自**模型**，所以那边必须校验；
  // 而这里的地址来自**管理员在设置页亲手填的配置**，且只在管理员点了保存之后才生效。
  // 另外 `siteSearch` 走 `searchUrl`、以及 Bing 的 `searchUrl` 覆盖，**两条既有路径
  // 都是裸 `fetch`、都没有校验** —— 只给新加的这条加上，会同时造成两件事：
  //   · 不一致（同类配置行为不同，没人能预期）；
  //   · 管理员**无法**接内网/本机上的服务（自建百科服务、内网知识库都是正常用法）。
  //
  // **代价是知情的**：凭据头会发往配置里写的那个主机，所以"谁能改配置"等于"谁能拿到
  // 这个凭据"。这与 `POST /api/config` 本身是管理员权限接口是同一层级的前提。
  // 要收紧的话，正确的做法是给**三条路径一起**加校验（那会牺牲内网用法），
  // 而不是只堵这一条。

  const rawHeaders = (request.headers || []).filter((h) => h.name.trim().toLowerCase() !== 'host');
  const withCred = applyCredential(rawHeaders, values.credential);
  const headers: Record<string, string> = {
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    'accept': 'application/json, text/plain, */*'
  };
  for (const h of withCred) {
    const name = String(h.name || '').trim();
    if (!name) continue;
    const v = fillRequestTemplate(String(h.value ?? ''), values);
    headers[name] = v.ok ? v.value : String(h.value ?? '');
  }

  try {
    const res = await fetch(resolved.url, {
      method: request.method,
      headers,
      signal: AbortSignal.timeout(Math.max(3000, Math.min(30000, Number(options.timeoutMs) || 15000))),
      redirect: 'follow'
    });
    const body = await res.text();
    const contentType = String(res.headers.get('content-type') || '');
    const kind = /json/i.test(contentType) || /^\s*[{[]/.test(body) ? 'json'
      : (/html/i.test(contentType) || /^\s*</.test(body) ? 'html' : 'other');
    if (!res.ok) {
      return { ok: false, error: `接口返回 HTTP ${res.status}：${body.slice(0, 200).replace(/\s+/g, ' ')}` };
    }
    return { ok: true, response: { kind, body, contentType, url: resolved.url, status: res.status } };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `请求失败：${msg}` };
  }
}

/** 标题候选字段名。**从最具体的排到最一般的**，命中即用。 */
const TITLE_KEYS = ['lemma_title', 'title', 'name', 'heading', 'label', 'subject', 'question', 'text'];
/** 链接候选字段名。 */
const URL_KEYS = ['url', 'link', 'href', 'uri', 'detail_url', 'source_url'];
/** 摘要候选字段名。 */
const SNIPPET_KEYS = ['lemma_desc', 'desc', 'description', 'snippet', 'summary', 'abstract', 'content', 'answer'];

const pickString = (obj: Record<string, unknown>, keys: string[]): string => {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
};

/**
 * 递归找出"看起来是一批条目"的数组，并为每个条目抽出标题/链接/摘要。
 *
 * 为什么要通用：接口的字段名是**各家自己定的**（`lemma_title` / `title` / `answer`…），
 * 为每个数据源写一个适配器不可维护。这里只按"有没有若干个含标题字段的对象"来判断，
 * 找不到就退回 `flattenJson()`（把整个响应压成一段资料）。
 */
export function jsonToResults(raw: string, limit: number, baseUrl = ''): Array<{ title: string; url: string; snippet: string }> {
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return []; }
  const best = findBestArray(data, Math.max(1, limit));
  if (!best.length) return [];
  return best.map((item) => {
    const title = pickString(item, TITLE_KEYS) || pickString(item, SNIPPET_KEYS).slice(0, 40) || '（无标题）';
    let url = pickString(item, URL_KEYS);
    // 相对链接按请求地址补全；实在没有链接就用请求地址（接口只给内容时也要能定位来源）
    if (url && !/^https?:\/\//i.test(url) && baseUrl) {
      try { url = new URL(url, baseUrl).toString(); } catch { /* 保持原样 */ }
    }
    const snippet = pickString(item, SNIPPET_KEYS);
    return { title, url: url || baseUrl, snippet };
  }).filter((r) => r.title || r.snippet);
}

/**
 * 在 JSON 里找"最像**结果列表**"的那个数组。
 *
 * 判据是**条目必须自带链接**（`url`/`link`/`href`）—— 那才是"一条搜索结果"的特征。
 * 只认标题是不行的，实测踩到两次：
 *   · 千帆 `get_content` 的响应是 `{ request_id, result: { lemma_title, summary,
 *     relations: [...] } }`。外层 `result` 也有 `lemma_title`，于是"外层"与"relations"
 *     **同时**被当成条目，真正的正文（`summary`）反而丢了；
 *   · `relations` 里的条目只有 `lemma_title` + `relation_name`，是**关联词条**，
 *     拿它当搜索结果，模型看到的就是一串"妻子 / 父亲"。
 *
 * 找不到"带链接的列表"就返回空 —— 调用方会退回 `flattenJson()`，把那整个对象
 * 压平成一段资料。**这才是单对象响应（如 `get_content`）的正确归宿。**
 */
function findBestArray(data: unknown, limit: number, depth = 0): Array<Record<string, unknown>> {
  if (depth > 6 || data === null || typeof data !== 'object') return [];
  if (Array.isArray(data)) {
    const objs = data.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x));
    const withLink = objs.filter((o) => pickString(o, URL_KEYS));
    // 至少两条、且带链接，才算"一个结果列表"（单条也可能是别的东西，别急着当列表）
    if (withLink.length >= 2) return withLink.slice(0, limit);
    return [];
  }
  let best: Array<Record<string, unknown>> = [];
  for (const v of Object.values(data as Record<string, unknown>)) {
    const found = findBestArray(v, limit, depth + 1);
    if (found.length > best.length) best = found;
  }
  return best;
}

/**
 * 把任意 JSON 压平成一段可读资料（"字段路径: 值"逐行）。
 *
 * 这是"接口没有条目列表"时的兜底：像千帆的 `get_content` 返回的是**单个词条的
 * 对象**（`lemma_title` / `summary` / `relations`…），它不是列表，但那些内容本身就是
 * 答案。压平之后模型能直接读，而且**字段路径保留**（`relations[0].relation_name`），
 * 模型知道每一行的含义，比丢一坨 JSON 给它强。
 *
 * 值一律**截断**：`summary` 这类字段可能有几千字，一条资料不该吃掉整轮上下文预算。
 */
export function flattenJson(raw: string, maxChars: number): string {
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return raw.slice(0, maxChars); }
  const lines: string[] = [];
  let used = 0;
  const walk = (value: unknown, path: string, depth: number): void => {
    if (used >= maxChars || depth > 6) return;
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      value.slice(0, 20).forEach((item, i) => walk(item, `${path}[${i}]`, depth + 1));
      return;
    }
    if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) walk(v, path ? `${path}.${k}` : k, depth + 1);
      return;
    }
    const text = String(value).replace(/\s+/g, ' ').trim();
    if (!text) return;
    const line = `${path}: ${text.length > 500 ? `${text.slice(0, 500)}…` : text}`;
    lines.push(line);
    used += line.length + 1;
  };
  walk(data, '', 0);
  return lines.join('\n').slice(0, maxChars);
}
