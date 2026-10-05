// 「请求结构」编辑弹窗：按指定的方法 / 地址 / 请求头去取数据（典型是 JSON 接口）。
//
// 为什么是一个弹窗而不是再往表格里加列：一张表里塞"方法 + 地址 + 任意个请求头 + 任意个
// 静态参数"会挤成一团，而这几项**只在配接口书签时才用得上**（普通网页搜索页只用
// 上面那一栏）。表格保持精简，复杂的部分按需展开 —— 同 `parts/persona.js` 那类弹窗。
//
// 三个概念的边界（与 `media/bookmark-request.ts` 完全一致，别在两端各写一套）：
//   · `{q}`      —— **运行时查询词**，每次搜索时填入；
//   · 其它 `{xxx}` —— **静态参数**，在这一栏按需展开给每个填一个固定值；
//   · 凭据       —— **不进这个弹窗**，它存在配置的密钥区（设置页另有入口），
//                   这里只把 `Authorization` 显示成占位提示，不显示真值。
import { $ } from '../dom.js';

/**
 * 请求头文本 ↔ 数组。
 *
 * 用 `Name: value` 逐行这种**人能直接读写的形态**，而不是 JSON：
 * 用户在文档里看到的就是这种写法，可以整段粘过来。
 */
export function headersToText(headers) {
  const list = Array.isArray(headers) ? headers : [];
  return list.map((h) => `${h?.name || ''}: ${h?.value || ''}`.trim()).join('\n');
}

/** 反方向。**空行忽略、没有冒号的行忽略**（宁可丢一行，也不要把整段文本塞成一个头）。 */
export function textToHeaders(text) {
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const name = line.slice(0, i).trim();
    const value = line.slice(i + 1).trim();
    if (!name) continue;
    out.push({ name, value });
  }
  return out;
}

/** 静态参数文本 ↔ 对象。同样是 `名字: 值` 逐行。 */
export function paramsToText(params) {
  const rec = params && typeof params === 'object' ? params : {};
  return Object.entries(rec).map(([k, v]) => `${k}: ${v}`).join('\n');
}

export function textToParams(text) {
  const out = {};
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const name = line.slice(0, i).trim();
    const value = line.slice(i + 1).trim();
    // `q` 是运行时查询词，后端也会忽略它；这里先挡掉，免得用户以为配了就生效
    if (!name || name === 'q') continue;
    out[name] = value;
  }
  return out;
}

/**
 * 打开请求结构编辑弹窗。
 *
 * @param {{ request?: object, params?: object }} current 当前值（来自该行）
 * @param {(next: {request?: object, params?: object}) => void} onApply 点确定后回填到行里
 *   —— **不直接写配置**：与其它弹窗一致，改动先落在 DOM，点「保存设置」才落盘。
 */
export function openBookmarkRequestModal(current, onApply) {
  const req = current?.request && typeof current.request === 'object' ? current.request : {};
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="max-width:720px">
      <div class="modal-head">请求结构（按指定的方法与请求头去取数据）</div>
      <div style="padding:10px 0">
        <div class="hint" style="margin-bottom:8px">
          <b>{q}</b> 是每次搜索的查询词，<b>必须出现</b>。<br />
          其它 <b>{名字}</b> 是<b>静态参数</b>（如 <code>{top_k}</code>），在下面「静态参数」里各填一个值。<br />
          <b>接口密钥也是静态参数</b>：请求头里写 <code>Authorization: Bearer {API Key}</code>，
          再到下面「静态参数」里加一行 <code>API Key: 你的密钥</code> 即可。
        </div>
        <div class="field-row">
          <div class="field" style="flex:0 0 110px"><label>方法</label>
            <select id="bqr-method">
              <option value="GET">GET</option>
              <option value="POST">POST</option>
            </select></div>
          <div class="field"><label>请求地址（必须含 {q}）</label>
            <input type="text" id="bqr-endpoint"
              placeholder="https://appbuilder.baidu.com/v2/baike/lemma/get_list_by_title?lemma_title={q}&top_k={top_k}" /></div>
        </div>
        <div class="field">
          <label>请求头（每行一条：<code>名字: 值</code>）</label>
          <textarea id="bqr-headers" rows="3"
            placeholder="Host: appbuilder.baidu.com&#10;Authorization: Bearer {API Key}"></textarea>
        </div>
        <div class="field">
          <label>静态参数（每行一条：<code>名字: 值</code>）</label>
          <textarea id="bqr-params" rows="2" placeholder="top_k: 5&#10;API Key: bce-v3/ALTAK-..."></textarea>
        </div>
        <div class="hint" id="bqr-hint"></div>
      </div>
      <div class="modal-foot">
        <button class="btn btn-primary" id="bqr-ok" type="button">确定</button>
        <button class="btn" id="bqr-clear" type="button">清空（不用请求结构）</button>
        <button class="btn" id="bqr-cancel" type="button">取消</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const hint = $('#bqr-hint', overlay);
  $('#bqr-method', overlay).value = String(req.method || 'GET').toUpperCase() === 'POST' ? 'POST' : 'GET';
  $('#bqr-endpoint', overlay).value = String(req.endpoint || req.url || '');
  $('#bqr-headers', overlay).value = headersToText(req.headers);
  $('#bqr-params', overlay).value = paramsToText(current?.params);

  const close = () => overlay.remove();
  $('#bqr-cancel', overlay).addEventListener('click', close);
  $('#bqr-clear', overlay).addEventListener('click', () => { onApply({}); close(); });
  $('#bqr-ok', overlay).addEventListener('click', () => {
    const endpoint = ($('#bqr-endpoint', overlay).value || '').trim();
    if (!endpoint) { hint.textContent = '请求地址不能为空。'; return; }
    // `{q}` 的校验放在这里，是为了**当场告诉用户**而不是保存后静默失效：
    // 后端对缺 {q} 的请求结构是直接丢弃（拼不出查询词），用户回来只会发现"没生效"。
    if (!endpoint.includes('{q}')) {
      hint.textContent = '请求地址里必须含 {q}（它会被替换成每次搜索的查询词），否则这条请求结构会被丢弃。';
      return;
    }
    const request = {
      method: $('#bqr-method', overlay).value === 'POST' ? 'POST' : 'GET',
      endpoint,
      headers: textToHeaders($('#bqr-headers', overlay).value)
    };
    const params = textToParams($('#bqr-params', overlay).value);
    onApply({ request, params });
    close();
  });
}
