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
import { $, esc } from '../dom.js';
import { api } from '../api.js';

/**
 * 测试按钮的默认查询词。
 *
 * ⚠️ 这个字面量**必须与后端 `TEST_QUERY_DEFAULT`（`src/media/bookmark-request.ts`）逐字相同**。
 * `ui/` 是浏览器原生 ES Module，**够不着 `dist/`**（没有打包器、也没有取值端点），所以只能各留一份；
 * `t-panel-wiring.mjs` 有一条断言把两边钉在一起 —— 漂移的表现是"提示说会用 A、实际发了 B"，
 * 而这种不一致没人会去核对。
 *
 * 挑这个词的理由：它几乎必然有结果。用空查询或罕见词会让"接口配置对不对"与
 * "这个词有没有内容"两件事混在一起，而测试要回答的是**前者**。
 */
const TEST_QUERY_DEFAULT = '初音未来';

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

/**
 * 静态参数从对象 → DOM 行。
 *
 * 为什么改成「一行一个参数」而不是一个 `名字: 值` 的多行文本框：**密钥要能单独切换显示**，
 * 而一个 textarea 里没法给某一行加按钮。这与设置页「模型 API」那套是同一个形状
 * （`type="password"` 的输入框 + 旁边的「显示」按钮），用户不必学第二种交互。
 *
 * 值用 `esc` 转义后写进 `value="…"`。
 */
function paramsRowsHtml(params) {
  const entries = Object.entries(params && typeof params === 'object' ? params : {});
  if (!entries.length) return '';
  return entries.map(([k, v]) =>
    '<div class="field-row" data-bqp-row style="align-items:center;gap:6px;margin-bottom:4px">'
    + `<input type="text" data-bqp-key value="${esc(k)}" placeholder="参数名（如 top_k / api_key）" style="flex:1" />`
    + '<span style="opacity:.6">:</span>'
    + `<input type="password" data-bqp-value value="${esc(v)}" placeholder="参数值" autocomplete="new-password" style="flex:2" />`
    // 与「模型 API」区块同一个按钮文案与语义：password ⇄ text
    + '<button class="btn btn-small" data-bqp-toggle type="button">显示</button>'
    + '<button class="btn btn-small btn-danger" data-bqp-del type="button" title="删掉这个参数">×</button>'
    + '</div>'
  ).join('');
}

/** 把 DOM 行收成参数对象（空名字丢弃；`q` 是运行时查询词，挡掉）。 */
function collectParams(overlay) {
  const out = {};
  for (const row of overlay.querySelectorAll('[data-bqp-row]')) {
    const name = (row.querySelector('[data-bqp-key]')?.value || '').trim();
    if (!name || name === 'q') continue;
    out[name] = row.querySelector('[data-bqp-value]')?.value || '';
  }
  return out;
}

/**
 * 打开请求结构编辑弹窗。
 *
 * @param {{ request?: object, params?: object, prefillNote?: string, testQuery?: string }} current
 *   当前值（来自该行）。`prefillNote` 是**给用户看的一句话**，说明"这个地址是哪来的"
 *   （例如刚刚检测出它是 JSON 接口、地址被自动搬进来了）；`testQuery` 是「测试」的初始查询词
 *   （留空 = 用后端默认词）。没有这两项时弹窗与原来完全一样。
 * @param {(next: {request?: object, params?: object}) => void} onApply 点确定后回填到行里
 *   —— **不直接写配置**：与其它弹窗一致，改动先落在 DOM，点「保存设置」才落盘。
 */
export function openBookmarkRequestModal(current, onApply) {
  const req = current?.request && typeof current.request === 'object' ? current.request : {};
  const prefillNote = String(current?.prefillNote || '').trim();
  // 测试查询词的初值：调用方可以给一个（例如将来想"用它刚搜过的词"），默认留空 = 用后端默认词
  const testQuery = String(current?.testQuery || '').trim();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="max-width:720px">
      <div class="modal-head">请求结构（按指定的方法与请求头去取数据）</div>
      <div style="padding:10px 0">
        ${prefillNote ? `<div class="hint" style="margin-bottom:8px;color:var(--orange)">${esc(prefillNote)}</div>` : ''}
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
          <label>静态参数（<code>{名字}</code> 的值，含密钥）</label>
          <div id="bqr-params"></div>
          <div style="margin-top:6px">
            <button class="btn btn-small" id="bqr-add-param" type="button">＋ 添加参数</button>
          </div>
          <div class="hint" style="margin-top:4px">
            密钥就填在这里（例如 <code>API Key</code> → 你的密钥），请求头里用 <code>{API Key}</code> 引用。
            点「显示」可临时看到明文；输入框默认是密码态。
          </div>
        </div>
        <div class="hint" id="bqr-hint"></div>
        <div class="field" style="margin-top:8px">
          <label>测试用的查询词（可留空）</label>
          <input type="text" id="bqr-test-query" value="${esc(testQuery)}" placeholder="${esc(TEST_QUERY_DEFAULT)}" />
          <div class="hint" style="margin-top:4px">
            点下面「测试」时用这个词发一次真实请求。<b>留空</b>就用 <code>${esc(TEST_QUERY_DEFAULT)}</code>
            （它几乎必然有结果）。想知道某个具体词能不能搜到，就填那个词。
          </div>
        </div>
        <div id="bqr-test-out" class="hint" style="margin-top:6px;white-space:pre-wrap"></div>
      </div>
      <div class="modal-foot">
        <button class="btn btn-primary" id="bqr-ok" type="button">确定</button>
        <button class="btn" id="bqr-test" type="button">测试</button>
        <button class="btn" id="bqr-clear" type="button">清空（不用请求结构）</button>
        <button class="btn" id="bqr-cancel" type="button">取消</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const hint = $('#bqr-hint', overlay);
  $('#bqr-method', overlay).value = String(req.method || 'GET').toUpperCase() === 'POST' ? 'POST' : 'GET';
  $('#bqr-endpoint', overlay).value = String(req.endpoint || req.url || '');
  $('#bqr-headers', overlay).value = headersToText(req.headers);
  const paramsBox = $('#bqr-params', overlay);
  paramsBox.innerHTML = paramsRowsHtml(current?.params);

  // ── 静态参数的增删与「显示/隐藏」──
  // 全部走 overlay 上的事件委托：行是动态插进来的，绑到具体按钮上会漏掉新增行。
  // 切显示的行为与设置页「模型 API」一致：password ⇄ text，按钮文案「显示」/「隐藏」。
  $('#bqr-add-param', overlay).addEventListener('click', () => {
    paramsBox.insertAdjacentHTML('beforeend', paramsRowsHtml({ '': '' }));
    // 新行的名字框聚焦，省得用户再点一下
    paramsBox.lastElementChild?.querySelector('[data-bqp-key]')?.focus();
  });
  paramsBox.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const del = target.closest('[data-bqp-del]');
    if (del) { del.closest('[data-bqp-row]')?.remove(); return; }
    const toggle = target.closest('[data-bqp-toggle]');
    if (!toggle) return;
    const input = toggle.closest('[data-bqp-row]')?.querySelector('[data-bqp-value]');
    if (!input) return;
    const toText = input.type === 'password';
    input.type = toText ? 'text' : 'password';
    toggle.textContent = toText ? '隐藏' : '显示';
  });

  const close = () => overlay.remove();
  $('#bqr-cancel', overlay).addEventListener('click', close);
  $('#bqr-clear', overlay).addEventListener('click', () => { onApply({}); close(); });

  // ── 「测试」：把当前这套配置**原样**发一次真实请求并解释结果 ──
  //
  // 为什么这一栏特别需要它：地址拼错、占位符没填值、密钥不对、接口要求 POST 却填了 GET，
  // 这些**除了保存都没有验证手段**，要等到模型真的去搜、在群里答不出话时才暴露。
  // 而「网页地址」那一栏早有「检测」按钮（**实测反馈**）。
  //
  // 判据走**后端同一条解析链**（`testBookmarkRequest` 用的就是真实检索那批函数），
  // 所以"测试通过"的含义是**真能搜到条目**，不只是"连得上"。
  const testOut = $('#bqr-test-out', overlay);
  const testBtn = $('#bqr-test', overlay);
  const testQueryInput = $('#bqr-test-query', overlay);
  // 在查询词框里按回车 = 点「测试」——填完词顺手回车是最自然的动作
  testQueryInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); testBtn.click(); }
  });
  testBtn.addEventListener('click', async () => {
    const endpoint = ($('#bqr-endpoint', overlay).value || '').trim();
    const request = {
      method: $('#bqr-method', overlay).value === 'POST' ? 'POST' : 'GET',
      endpoint,
      headers: textToHeaders($('#bqr-headers', overlay).value)
    };
    // 本地先挡一次空地址：省一轮网络往返，也让提示更即时
    if (!endpoint) { testOut.textContent = '请求地址是空的，先填一条含 {q} 的地址。'; return; }
    testBtn.disabled = true;
    const label = testBtn.textContent;
    testBtn.textContent = '测试中…';
    testOut.textContent = '正在按当前配置发一次真实请求…';
    try {
      // 查询词留空 → 发**空串**，由后端回落到它自己的默认词。
      // 不在这里兜一个前端默认值：那样"用户留空"与"用户手打了默认词"在后端看起来一样，
      // 而后端的 `TEST_QUERY_DEFAULT` 才是唯一权威（两边的字面量由套件钉住一致）。
      const rawQuery = ($('#bqr-test-query', overlay)?.value || '').trim();
      const r = await api('/api/search-bookmark/test-request', {
        method: 'POST',
        body: JSON.stringify({ request, params: collectParams(overlay), sampleQuery: rawQuery })
      });
      const res = r?.result || {};
      // 结论 + 实测细节一起给：只说"成功/失败"用户没法判断"结果对不对"
      const detail = [];
      if (res.status) detail.push(`HTTP ${res.status}`);
      if (res.kind) detail.push(res.kind);
      if (res.bodyChars !== undefined) detail.push(`${res.bodyChars} 字符`);
      if (res.latencyMs !== undefined) detail.push(`${res.latencyMs}ms`);
      const head = res.ok ? '✓ ' : '✗ ';
      testOut.textContent = head + String(res.note || '测试没有返回结论')
        + (detail.length ? `\n实测：${detail.join(' / ')}` : '')
        + (res.sampleQuery ? `\n查询词：${res.sampleQuery}` : '')
        + (res.sampleTitles?.length ? `\n前几条标题：${res.sampleTitles.join(' / ')}` : '');
      testOut.style.color = res.ok ? '' : 'var(--red)';
    } catch (e) {
      testOut.textContent = `✗ 测试请求失败：${e.message}`;
      testOut.style.color = 'var(--red)';
    } finally {
      testBtn.disabled = false;
      testBtn.textContent = label;
    }
  });

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
    // 参数从**行**里收（不再是一个 textarea 的文本）
    const params = collectParams(overlay);
    onApply({ request, params });
    close();
  });
}
