import { esc } from '../../dom.js';
import { state } from '../../state.js';
import { THEME_ICON, THEME_LABEL } from '../../theme.js';
import { getThemePref } from '../../theme.js';
import { renderChatSection } from '../../parts/chat-settings.js';
import { renderModelColumn, renderProviderColumn, visionBadge } from '../../parts/providers.js';

export function renderApiSection(c) {
  const currentProvider = (state.providers || []).find((p) => p.id === c.api.provider);
  const currentModelDisplay = (currentProvider?.modelNames || {})[c.api.model] || c.api.model;
  return `
    <h3 id="settings-api">模型 API</h3>
    <div class="field"><label>模型目录</label>
      <div style="display:flex;gap:8px">
        <input type="text" id="cfg-model-pick" readonly placeholder="点击选择模型" value="${esc(currentModelDisplay || '')}" style="flex:1;cursor:pointer" />
        <button class="btn btn-small" id="test-provider-btn">测试连通性</button>
        <span id="provider-test-result" class="muted" style="align-self:center"></span>
      </div>
      <div class="hint" id="provider-hint">${currentProvider ? `当前：${esc(currentProvider.displayName)} · ${esc(c.api.model || '未选模型')} @ ${esc(currentProvider.baseURL)}${currentProvider.hasKey ? ' · 已保存 API Key（不显示）' : ' · 未保存 API Key'}` : '尚未选择模型'}</div>
      <div class="hint" id="model-vision-hint" style="margin-top:6px"></div>
      <input type="hidden" id="cfg-provider" value="${esc(c.api.provider || '')}" />
      <input type="hidden" id="cfg-model" value="${esc(c.api.model || '')}" />
    </div>
    <div class="field-row">
      <div class="field"><label>当前 Base URL</label>
        <div style="display:flex;gap:8px">
          <input type="text" id="cfg-baseurl" readonly value="${esc(c.api.baseUrl)}" style="flex:1" />
          <button class="btn btn-small" id="fetch-current-models-btn">获取列表</button>
        </div></div>
      <div class="field"><label>当前 API Key</label>
        <div style="display:flex;gap:8px">
          <input type="password" id="cfg-apikey" value="${esc((currentProvider?.hasKey || c.api.apiKey) ? '******' : '')}" placeholder="输入新 Key 可替换；留空保存则保持原 Key" autocomplete="new-password" style="flex:1" />
          <button class="btn btn-small" id="cfg-apikey-toggle" type="button">显示</button>
        </div></div>
    </div>
    <div class="field-row">
      <div class="field"><label>温度</label><input type="number" id="cfg-temperature" step="0.1" min="0" max="2" value="${esc(c.api.temperature)}" /></div>
      <div class="field"><label>单次运行最大工具轮数</label><input type="number" id="cfg-maxrounds" min="1" max="40" value="${esc(c.api.maxRounds)}" /></div>
    </div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-vision" ${c.api.vision !== false ? 'checked' : ''} />
      <label for="cfg-vision">图片输入（关闭则移除看图工具，模型只会看到 [图片] 占位符）</label>
      <span id="vision-switch-hint" class="muted" style="font-size:12px;align-self:center"></span></div>
    <div class="settings-divider"></div>

    <h3>成本核算</h3>

    <div class="checkbox-row"><input type="checkbox" id="cfg-useofficialprice" ${c.api.useOfficialPrice !== false ? 'checked' : ''} />
      <label for="cfg-useofficialprice">用内置官方价格表估算（按模型 id 自动匹配；走中转站请关掉）</label></div>

    <div class="field" style="margin-top:6px"><label>远程价格表 URL</label>
      <div style="display:flex;gap:8px">
        <input type="text" id="cfg-price-remote-url" placeholder="例如 https://你的服务器/prices.json" value="${esc(c.api.priceRemoteUrl || '')}" style="flex:1" />
        <button class="btn btn-small" id="price-feed-refresh-btn" title="不等定时，立即拉一次">立即拉取</button>
      </div>
      <div class="hint" id="price-feed-status" style="margin-top:4px"></div>
    </div>

    <!-- 当前模型的价格卡片：切换模型时内容跟着变 -->
    <div class="price-card" id="model-price-card">
      <div class="pc-head">
        <span class="pc-title">当前模型单价</span>
        <span class="pc-model" id="pc-model">${esc(c.api.model || '（未选择模型）')}</span>
      </div>
      <div class="pc-rows">
        <div class="pc-row"><span class="pc-label">输入</span>
          <input type="number" id="cfg-price-in" step="0.01" min="0" value="0" /><span class="pc-unit">元/百万</span></div>
        <div class="pc-row"><span class="pc-label">输出</span>
          <input type="number" id="cfg-price-out" step="0.01" min="0" value="0" /><span class="pc-unit">元/百万</span></div>
        <div class="pc-row"><span class="pc-label">缓存命中</span>
          <input type="number" id="cfg-price-cached" step="0.01" min="0" value="0" /><span class="pc-unit">元/百万</span></div>
      </div>
      <div class="pc-note" id="pc-note"></div>
    </div>

    <div style="display:flex;gap:8px;margin:8px 0">
      <button class="btn btn-small" id="batch-price-btn">批量自定义价格编辑</button>
      <span class="muted" style="font-size:12px;align-self:center">为多个模型分别设定单价</span>
    </div>

    <div class="settings-divider"></div>

    <h3>手动添加提供商</h3>
    <div class="field"><label>Base URL（可填写）</label>
      <div style="display:flex;gap:8px">
        <input type="text" id="new-baseurl" placeholder="例如 https://api.deepseek.com/v1 或 https://open.bigmodel.cn/api/paas/v4" style="flex:1" />
        <button class="btn btn-small" id="fetch-models-btn">获取列表</button>
      </div></div>
    <div class="field"><label>API Key（手动添加时填写）</label>
      <div style="display:flex;gap:8px">
        <input type="password" id="new-apikey" placeholder="sk-..." autocomplete="new-password" style="flex:1" />
        <button class="btn btn-small" id="new-apikey-toggle" type="button">显示</button>
      </div></div>
    <div class="field"><label>模型 id（两列：左侧模型 ID，右侧模型目录中显示的名字；可添加多行）</label>
      <div id="model-rows"></div>
      <div style="display:flex;gap:8px;margin-top:6px">
        <button class="btn btn-small" id="add-model-row-btn">＋ 添加一行</button>
      </div>
      <div class="hint">「获取列表」会从上面的 Base URL 拉取模型，并在弹窗里勾选加入列表。</div></div>
    <div class="field-row">
      <div class="field"><button class="btn btn-primary" id="confirm-add-provider-btn">确认添加</button></div>
      <div class="field"><button class="btn btn-danger" id="delete-model-btn">删除模型…</button></div>
    </div>
    <div class="hint" id="provider-action-hint"></div>`;
}


/**
 * 渲染收藏夹的三元组行（枚举值 / 网页地址 / 用途）。
 *
 * 每条用 `data-bm` 标记成一行，保存时由 `save.js` 逐行读取（见那里的 readBookmarks）。
 * 值走 `esc()`：这三项都会进模型可见的提示词，未转义的引号能在 schema 里制造歧义。
 * 用途为空是**合法回显**（旧配置迁移来的条目就是这样），所以不给它兜一个假默认值 ——
 * 那会让用户以为"已经填过了"，而模型实际拿到的是一条没有依据的枚举值。
 */
export function renderBookmarkRows(bookmarks) {
  const list = Array.isArray(bookmarks) ? bookmarks : [];
  // 「网页地址」与「站内搜索地址」**已合并成一栏**（`data-bm-url`）：填域名就是站点标识，
  // 填含 `{q}` 的完整地址就是站内搜索模板 —— 由后端按形态自己认，用户不用选。
  // 那一栏的值优先显示 `searchUrl`（更具体），没有才显示域名。
  const row = (key, urlOrTemplate, purpose, resultClass, hasRequest) =>
    '<tr data-bm>'
    + `<td><input type="text" data-bm-key value="${esc(key)}" placeholder="wiki" /></td>`
    + `<td>`
    + `<input type="text" data-bm-url value="${esc(urlOrTemplate)}" placeholder="zh.wikipedia.org 或 https://…/search?q={q}" />`
    + `<div style="display:flex;gap:6px;align-items:center;margin-top:3px">`
    + `<button class="btn btn-small" data-bm-probe type="button" title="这一栏空着=自动查找搜索地址；已填=只测你填的那条">检测</button>`
    + `</div>`
    // 检测结果就地显示在这一行下面：把结论放在按钮旁边，用户不用去别处找
    + `<div class="muted" data-bm-status style="font-size:11px;margin-top:3px"></div>`
    + `</td>`
    + `<td><input type="text" data-bm-purpose value="${esc(purpose)}" placeholder="查百科条目、定义、背景事实" /></td>`
    + `<td>`
    + `<button class="btn btn-small" data-bm-req type="button" title="按指定的方法/地址/请求头去取数据（JSON 接口用）">`
    + `${hasRequest ? '已配置 ✓' : '配置…'}</button>`
    + `<input type="text" data-bm-resultclass value="${esc(resultClass)}" placeholder="容器类名（留空=通用）" style="margin-top:3px" />`
    + `</td>`
    + '<td><button class="btn btn-small btn-danger" data-bm-del type="button" title="删除这条">×</button></td>'
    + '</tr>';
  if (!list.length) return row('', '', '', '', false);
  return list.map((item) => row(
    item?.key || '',
    item?.searchUrl || item?.url || '',
    item?.purpose || '',
    item?.resultClass || '',
    !!(item?.request && item.request.endpoint)
  )).join('');
}

/**
 * 接口密钥的行。
 *
 * **密钥真值读不到**：后端脱敏时会把 `credentials.<key>.value` 整个删掉、只留一个
 * `hasValue` 布尔标记（理由见 `http/console.ts` 那段：留着空串会让前端回传时覆盖真值）。
 * 所以这里的分工是：
 *   · 输入框**永远留空**，`placeholder` 根据 `hasValue` 显示"已设置（留空=不改）"；
 *   · 保存时**只有非空才写** —— 空值整键不写，服务端原值才不会被清掉。
 * 这是"值不回显又不被误清"的唯一可行组合，别为了好看向 input 里塞掩码字符。
 */
export function renderCredentialRows(credentials) {
  const map = credentials && typeof credentials === 'object' ? credentials : {};
  const keys = Object.keys(map);
  const row = (key, header, scheme, hasValue) =>
    '<tr data-bmc>'
    + `<td><input type="text" data-bmc-key value="${esc(key)}" placeholder="baike" /></td>`
    + `<td><input type="text" data-bmc-header value="${esc(header)}" placeholder="Authorization" /></td>`
    + `<td><input type="text" data-bmc-scheme value="${esc(scheme)}" placeholder="Bearer" /></td>`
    + `<td><div style="display:flex;gap:6px;align-items:center">`
    + `<input type="password" data-bmc-value value="" placeholder="${hasValue ? '已设置（留空=不修改）' : '粘贴密钥'}" style="flex:1" autocomplete="new-password" />`
    + `<button class="btn btn-small btn-danger" data-bmc-del type="button" title="删除这条密钥">×</button>`
    + '</div></td>'
    + '</tr>';
  if (!keys.length) return row('', '', '', false);
  return keys.map((k) => row(
    k,
    String(map[k]?.header || ''),
    String(map[k]?.scheme || ''),
    Boolean(map[k]?.hasValue)
  )).join('');
}

export function renderSearchSection(c) {
  // 每个提供方区块的初始显隐都要跟当前 provider 一致
  const prov = String(c.webSearch?.provider || 'bing');
  // 自定义搜索提供商列表（可多个），用于动态生成下拉框选项
  const customProvs = Array.isArray(c.webSearch?.providers) ? c.webSearch.providers : [];
  return `
    <h3 id="settings-search">搜索服务</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-websearch" ${c.webSearch?.enabled !== false ? 'checked' : ''} />
      <label for="cfg-websearch">联网搜索：启用 web_search / web_fetch 工具</label></div>
    <div class="field"><label>搜索提供方</label>
      <select id="cfg-searchprovider">
        <option value="bing" ${prov === 'bing' ? 'selected' : ''}>Bing 网页解析</option>
        <option value="deepseek" ${prov === 'deepseek' ? 'selected' : ''}>DeepSeek 原生搜索</option>
        <option value="zhipu" ${prov === 'zhipu' ? 'selected' : ''}>智谱 Web Search</option>
        <option value="bocha" ${prov === 'bocha' ? 'selected' : ''}>博查 AI Search</option>
        <option value="baidu" ${prov === 'baidu' ? 'selected' : ''}>百度千帆 AI Search</option>
        <option value="metaso" ${prov === 'metaso' ? 'selected' : ''}>秘塔 AI 搜索</option>
        <option value="yandex" ${prov === 'yandex' ? 'selected' : ''}>Yandex 网页解析</option>
        ${customProvs.map((p) => `<option value="custom:${esc(p.id)}" ${prov === `custom:${p.id}` ? 'selected' : ''}>${esc(p.name || p.baseUrl)}（自定义 · ${p.type === 'bing' ? '网页解析' : 'JSON 接口'}）</option>`).join('')}
      </select></div>
    <div class="field" id="custom-provider-manage" style="${prov.startsWith('custom:') ? '' : 'display:none'}">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <button class="btn btn-small" id="test-search-provider-btn">测试这个搜索服务</button>
        <button class="btn btn-small btn-danger" id="del-search-provider-btn">删除这个搜索服务</button>
        <span id="search-provider-action-hint" class="muted" style="font-size:12px"></span>
      </div>
    </div>
    <div class="field" id="bing-search-fields" style="${prov === 'bing' ? '' : 'display:none'}"><label>搜索地址（高级：可替换为兼容 Bing 结果格式的引擎）</label><input type="text" id="cfg-searchurl" value="${esc(c.webSearch?.searchUrl || 'https://cn.bing.com/search')}" /></div>
    <div class="field-row" id="deepseek-search-fields" style="${prov === 'deepseek' ? '' : 'display:none'}">
      <div class="field"><label>DeepSeek 搜索 API Key（留空用环境变量 DEEPSEEK_API_KEY）</label>
        <div style="display:flex;gap:8px">
          <input type="password" id="cfg-ds-searchkey" value="${esc(c.webSearch?.deepseek?.hasApiKey ? '******' : '')}" placeholder="输入新 Key 可替换；留空保持不变" autocomplete="new-password" style="flex:1" />
          <button class="btn btn-small" id="cfg-ds-searchkey-toggle" type="button">显示</button>
        </div></div>
      <div class="field"><label>模型</label><input type="text" id="cfg-ds-searchmodel" value="${esc(c.webSearch?.deepseek?.model || 'deepseek-chat')}" /></div>
    </div>
    <div class="field-row" id="zhipu-search-fields" style="${prov === 'zhipu' ? '' : 'display:none'}">
      <div class="field"><label>智谱 API Key（留空用环境变量 ZHIPU_API_KEY）</label>
        <div style="display:flex;gap:8px">
          <input type="password" id="cfg-zhipu-key" value="${esc(c.webSearch?.zhipu?.hasApiKey ? '******' : '')}" placeholder="输入新 Key 可替换；留空保持不变" autocomplete="new-password" style="flex:1" />
          <button class="btn btn-small" id="cfg-zhipu-key-toggle" type="button">显示</button>
        </div></div>
      <div class="field"><label>搜索引擎</label>
        <select id="cfg-zhipu-engine">
          <option value="search_std" ${c.webSearch?.zhipu?.engine === 'search_std' ? 'selected' : ''}>基础版 ¥0.01/次</option>
          <option value="search_pro" ${c.webSearch?.zhipu?.engine === 'search_pro' ? 'selected' : ''}>高级版 ¥0.03/次</option>
          <option value="search_pro_sogou" ${c.webSearch?.zhipu?.engine === 'search_pro_sogou' ? 'selected' : ''}>搜狗版 ¥0.05/次</option>
          <option value="search_pro_quark" ${c.webSearch?.zhipu?.engine === 'search_pro_quark' ? 'selected' : ''}>夸克版 ¥0.05/次</option>
        </select></div>
    </div>
    <div class="field" id="bocha-search-fields" style="${prov === 'bocha' ? '' : 'display:none'}">
      <label>博查 API Key</label>
      <div style="display:flex;gap:8px">
        <input type="password" id="cfg-bocha-key" value="${esc(c.webSearch?.bocha?.hasApiKey ? '******' : '')}" placeholder="输入新 Key 可替换；留空保持不变" autocomplete="new-password" style="flex:1" />
        <button class="btn btn-small" id="cfg-bocha-key-toggle" type="button">显示</button>
      </div></div>
    <div class="field" id="baidu-search-fields" style="${prov === 'baidu' ? '' : 'display:none'}">
      <label>百度千帆 API Key（留空用环境变量 BAIDU_SEARCH_API_KEY）</label>
      <div style="display:flex;gap:8px">
        <input type="password" id="cfg-baidu-key" value="${esc(c.webSearch?.baidu?.hasApiKey ? '******' : '')}" placeholder="输入新 Key 可替换；留空保持不变" autocomplete="new-password" style="flex:1" />
        <button class="btn btn-small" id="cfg-baidu-key-toggle" type="button">显示</button>
      </div></div>
    <div class="field" id="metaso-search-fields" style="${prov === 'metaso' ? '' : 'display:none'}">
      <label>秘塔 API Key（可选，留空用官方免费额度 / 环境变量 METASO_API_KEY）</label>
      <div style="display:flex;gap:8px">
        <input type="password" id="cfg-metaso-key" value="${esc(c.webSearch?.metaso?.hasApiKey ? '******' : '')}" placeholder="输入新 Key 可替换；留空保持不变" autocomplete="new-password" style="flex:1" />
        <button class="btn btn-small" id="cfg-metaso-key-toggle" type="button">显示</button>
      </div></div>

    <div class="field" id="yandex-search-fields" style="${prov === 'yandex' ? '' : 'display:none'}">
      <label>搜索页地址</label>
      <input type="text" id="cfg-yandex-baseurl" value="${esc(c.webSearch?.yandex?.baseUrl || 'https://yandex.com/search/')}" />
      <div class="muted" style="font-size:12px;margin-top:4px">
        抓的是公开结果页（不需要 Key）。被 CAPTCHA 拦时会明确报"要求人机验证"，而不是假装没搜到。
        <strong>Yandex 会改页面结构</strong>，工具报"没有解析到结果"时，用下面几个类名把选择器改回当前页面即可。
      </div>
    </div>
    <div class="field-row" id="yandex-selector-fields" style="${prov === 'yandex' ? '' : 'display:none'}">
      <div class="field"><label>结果容器类名</label>
        <input type="text" id="cfg-yandex-serp" value="${esc(c.webSearch?.yandex?.serpClass || 'serp-item')}" /></div>
      <div class="field"><label>标题锚点类名</label>
        <input type="text" id="cfg-yandex-title" value="${esc(c.webSearch?.yandex?.titleClass || 'OrganicTitle')}" /></div>
    </div>
    <div class="field-row" id="yandex-selector-fields2" style="${prov === 'yandex' ? '' : 'display:none'}">
      <div class="field"><label>链接类名（取 href）</label>
        <input type="text" id="cfg-yandex-url" value="${esc(c.webSearch?.yandex?.urlClass || 'organic__url')}" /></div>
      <div class="field"><label>摘要类名</label>
        <input type="text" id="cfg-yandex-text" value="${esc(c.webSearch?.yandex?.textClass || 'OrganicText')}" /></div>
    </div>

    <h3>网页收藏夹</h3>
    <div class="field" id="bookmark-mode-field">
      <label>收藏夹的默认行为（只影响模型<strong>没有</strong>指定站点时走哪条路）</label>
      <select id="cfg-search-bookmarkmode">
        <option value="prefer" ${c.webSearch?.bookmarkMode !== 'web' ? 'selected' : ''}>优先在收藏夹里查，再补全网</option>
        <option value="web" ${c.webSearch?.bookmarkMode === 'web' ? 'selected' : ''}>直接全网，只在模型指定站点时才查收藏夹</option>
      </select>
      <div class="muted" style="font-size:12px;margin-top:4px">
        模型每次搜索都可以自己决定"只在这个站点里搜"（<code>web_search</code> 的 <code>site</code> 参数，
        可选值是下面这份名单）。这个下拉只管它<strong>没说</strong>的时候：默认先问收藏夹、再补全网，所以收藏夹
        永远不会让搜索变窄到搜不到。
      </div>
    </div>
    <div class="field">
      <label>收藏的站点（枚举值 + 网页地址 + 用途；最多 20 条）</label>
      <div class="muted" style="font-size:12px;margin-bottom:6px">
        前三项都要填，缺一条这一条就不生效：<br />
        · <strong>枚举值</strong>：模型在 <code>web_search</code> 的 <code>site</code> 参数里传的就是它。
        只能是字母/数字/<code>-</code>/<code>_</code>（如 <code>wiki</code>、<code>news-yc</code>），中文会被丢弃。<br />
        · <strong>网页地址</strong>：只取它的<strong>域名</strong>（填整条网址也行，路径会被丢掉）。<br />
        · <strong>用途</strong>：<strong>会随每轮提示词交给模型</strong>，是它判断"该选哪一条"的依据。<br />
        <br />
        <strong>⚠️ 想让它真的"只在这个站里搜"，请填「站内搜索地址」。</strong>
        实测 Bing 对程序化请求<strong>忽略 <code>site:</code> 限定符</strong>（带与不带的结果完全一样），
        所以只靠域名等于没限定。填了模板就直接去那个站自己的搜索页取内容：<br />
        · <code>https://zh.wikipedia.org/w/index.php?search={q}</code>（维基，<code>{q}</code> 是查询词占位符）<br />
        · <code>https://your-docs.example.com/search?q={q}</code><br />
        必须含 <code>{q}</code>，否则这一栏会被忽略。留空则退回 <code>site:</code> 行为（对自建 SearXNG 等有效）。<br />
        <br />
        <strong>「检测」按钮看这一栏空不空，自动决定做哪件事：</strong><br />
        · <strong>这一栏是空的</strong> → 自动去这个站里<strong>查找</strong>可用的搜索地址，找到就填进来；<br />
        · <strong>这一栏已经填了</strong> → <strong>只测试你填的这一条</strong>能不能用，不会换成别的地址。
        不通过时会说清为什么（没有 <code>{q}</code> / 减掉导航后没剩几条 / 乱串查询也能拿到同样多的链接）。
        想重新自动找，把这一栏清空再点。<br />
        <strong>结果容器类名</strong>留空时用通用解析，会带上一些导航链接；知道该站结果块的类名时填上更准
        （页面改版导致"解析不出结果"时，就改这一栏）。
      </div>
      <table class="bookmark-table" style="width:100%;border-collapse:collapse">
        <thead>
          <tr>
            <th style="text-align:left;width:13%">枚举值</th>
            <th style="text-align:left;width:38%">网页地址 / 站内搜索地址</th>
            <th style="text-align:left;width:22%">用途</th>
            <th style="text-align:left;width:22%">请求结构 / 容器类名</th>
            <th style="width:36px"></th>
          </tr>
        </thead>
        <tbody id="search-bookmarks-body">
          ${renderBookmarkRows(c.webSearch?.bookmarks)}
        </tbody>
      </table>
      <div style="margin-top:6px">
        <button class="btn btn-small" id="add-search-bookmark-btn" type="button">＋ 添加一条</button>
      </div>
    </div>
    <div class="field-row">
      <div class="field"><label>单会话每小时最多搜索次数</label>
        <input type="number" id="cfg-search-chat-hourly" min="1" max="200" value="${esc(c.webSearch?.maxCallsPerChatPerHour ?? 20)}" /></div>
      <div class="field"><label>全部会话每天最多搜索次数</label>
        <input type="number" id="cfg-search-daily" min="1" max="5000" value="${esc(c.webSearch?.maxCallsPerDay ?? 200)}" /></div>
    </div>

    <h3>接口密钥（配了「请求结构」的收藏夹用）</h3>
    <div class="hint">
      填了「请求结构」的收藏夹（典型是 JSON 接口）如果要求鉴权，密钥填在这里。<br />
      <b>为什么不填在请求结构里</b>：那一栏的内容会被回显、可能被复制分享，而密钥是长期凭据。
      这里存的值<b>不回显</b>（只显示"已设置"），保存时也不会被空值覆盖。<br />
      左边填<b>收藏夹的枚举值</b>（要和上面那张表的枚举值一致），右边填密钥原文（不用写 <code>Bearer</code>，
      下面有单独的 scheme 输入框）。
    </div>
    <table class="bookmark-table" style="width:100%;border-collapse:collapse">
      <thead>
        <tr>
          <th style="text-align:left;width:18%">收藏夹枚举值</th>
          <th style="text-align:left;width:22%">请求头名</th>
          <th style="text-align:left;width:14%">scheme</th>
          <th style="text-align:left;width:46%">密钥</th>
        </tr>
      </thead>
      <tbody id="search-credentials-body">
        ${renderCredentialRows(c.webSearch?.credentials)}
      </tbody>
    </table>
    <div style="margin-top:6px">
      <button class="btn btn-small" id="add-search-credential-btn" type="button">＋ 添加一条密钥</button>
    </div>

    <h3>添加自定义搜索服务</h3>
    <div class="field-row">
      <div class="field"><label>名称（自己辨认用）</label>
        <input type="text" id="new-sp-name" placeholder="例如：自建 SearXNG" /></div>
      <div class="field"><label>类型</label>
        <select id="new-sp-type">
          <option value="openai">JSON 搜索接口（POST）</option>
          <option value="bing">网页解析（Bing 结果格式）</option>
        </select></div>
    </div>
    <div class="field"><label>接口地址 / 搜索页地址</label>
      <input type="text" id="new-sp-baseurl" placeholder="JSON 类型：https://your-search.example.com/search；网页类型：https://your-searx.example.com/search" style="width:100%" /></div>
    <div class="field-row">
      <div class="field"><label>API Key（可选）</label>
        <input type="password" id="new-sp-apikey" placeholder="多数自建服务留空即可" autocomplete="new-password" style="width:100%" /></div>
      <div class="field"><label>模型名（可选）</label>
        <input type="text" id="new-sp-model" placeholder="Responses API 风格才需要" /></div>
    </div>
    <div style="display:flex;gap:8px;align-items:center;margin:8px 0">
      <button class="btn btn-small" id="add-search-provider-btn">＋ 添加并选中</button>
      <span id="add-search-provider-hint" class="muted" style="font-size:12px"></span>
    </div>
  `;
}

export function renderImageSourceSection(c) {
  const s = c.imageSource || {};
  const trace = s.traceMoe || {};
  const sauce = s.sauceNao || {};
  const baidu = s.baidu || {};
  return `
    <h3>图片来源识别</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-image-source-enabled" ${s.enabled ? 'checked' : ''} /><label for="cfg-image-source-enabled">启用图片来源识别</label></div>
    <div class="hint">由模型结合上下文判断何时查询；调用次数受下方频率上限约束（护住第三方接口配额）。按图片类型先问专属引擎：动画截图用 trace.moe，插画/漫画用 SauceNAO；专属引擎没结果或超时后自动再用百度识图兜底一次。</div>
    <div class="settings-divider"></div><h3>trace.moe</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-trace-enabled" ${trace.enabled !== false ? 'checked' : ''} /><label for="cfg-trace-enabled">启用 trace.moe</label></div>
    <div class="field-row"><div class="field"><label>请求超时（毫秒）</label><input type="number" id="cfg-trace-timeout" value="${esc(trace.timeoutMs ?? 15000)}" /></div><div class="field"><label>最小置信度（0–1）</label><input type="number" step="0.01" id="cfg-trace-similarity" value="${esc(trace.minSimilarity ?? 0.87)}" /></div><div class="field"><label>最大结果数</label><input type="number" id="cfg-trace-results" value="${esc(trace.maxResults ?? 3)}" /></div></div>
    <div class="settings-divider"></div><h3>SauceNAO</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-sauce-enabled" ${sauce.enabled !== false ? 'checked' : ''} /><label for="cfg-sauce-enabled">启用 SauceNAO</label></div>
    <div class="field"><label>API Key</label><input type="password" id="cfg-sauce-key" value="${sauce.hasApiKey ? '******' : ''}" placeholder="${sauce.hasApiKey ? '已配置；留空不修改' : '未配置'}" autocomplete="new-password" /></div>
    <div class="field-row"><div class="field"><label>请求超时（毫秒）</label><input type="number" id="cfg-sauce-timeout" value="${esc(sauce.timeoutMs ?? 20000)}" /></div><div class="field"><label>最低相似度（0–1）</label><input type="number" step="0.01" id="cfg-sauce-similarity" value="${esc(sauce.minSimilarity ?? 0.8)}" /></div><div class="field"><label>最大结果数</label><input type="number" id="cfg-sauce-results" value="${esc(sauce.maxResults ?? 3)}" /></div></div>
    <div class="settings-divider"></div><h3>百度识图（一般向兜底）</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-baidu-enabled" ${baidu.enabled !== false ? 'checked' : ''} /><label for="cfg-baidu-enabled">启用百度识图</label></div>
    <div class="field-row"><div class="field"><label>请求超时（毫秒）</label><input type="number" id="cfg-baidu-timeout" value="${esc(baidu.timeoutMs ?? 15000)}" /></div><div class="field"><label>最大结果数</label><input type="number" id="cfg-baidu-results" value="${esc(baidu.maxResults ?? 3)}" /></div></div>
    <div class="hint">不需要 API Key。它只在专属引擎没给出结果（或超时、或结果没过门槛）之后才被问到，所以它给出的第一条就直接采用——该引擎不返回置信度，因此没有"最低相似度"这一项。</div>
    <div class="settings-divider"></div><h3>通用</h3>
    <div class="field-row"><div class="field"><label>图片最大大小（MiB）</label><input type="number" id="cfg-image-source-max-mib" value="${esc(Math.round(Number(s.maxImageBytes || 8388608) / 1048576))}" /></div><div class="field"><label>队列最大长度</label><input type="number" id="cfg-image-source-queue" value="${esc(s.maxQueueLength ?? 5)}" /></div><div class="field"><label>总任务超时（毫秒）</label><input type="number" id="cfg-image-source-total-timeout" value="${esc(s.totalTimeoutMs ?? 35000)}" /></div></div>
    <div class="field-row"><div class="field"><label>每群每小时上限</label><input type="number" id="cfg-image-source-chat-hourly" value="${esc(s.maxCallsPerChatPerHour ?? 5)}" /></div><div class="field"><label>全局每日上限</label><input type="number" id="cfg-image-source-daily" value="${esc(s.maxCallsPerDay ?? 30)}" /></div></div>
    <div class="hint">调用次数超限时工具会直接失败并告知原因；上限只统计"发起了几次查询"，命中缓存的重复图片同样计数。</div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-image-source-cache" ${s.cacheEnabled !== false ? 'checked' : ''} /><label for="cfg-image-source-cache">启用内存缓存（最多 100 条，默认 24 小时；不保存图片）</label></div>
    <div style="display:flex;gap:8px;margin-top:10px"><button class="btn btn-small" id="test-image-source-btn" type="button">测试连接</button><span id="image-source-test-result" class="muted"></span></div>`;
}

export function renderMemorySettingsSection(c) {
  const mem = c.memory || {};
  const comp = c.compact || {};
  const providers = state.providers || [];
  const useChat = mem.useChatModel !== false;
  const selP = providers.find((p) => p.id === mem.provider);
  const currentDisplay = selP ? `${selP.displayName || selP.id} · ${mem.model || '未选模型'}` : (mem.model || '未选模型');
  return `
    <h3 id="settings-memory">记忆整理</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-mem-consolidate" ${mem.consolidateEnabled !== false ? 'checked' : ''} />
      <label for="cfg-mem-consolidate">启用记忆自动整理</label></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-mem-usechat" ${useChat ? 'checked' : ''} />
      <label for="cfg-mem-usechat">使用与聊天机器人相同的模型</label></div>
    <div id="mem-model-box" style="${useChat ? 'display:none' : ''}">
      <div class="field"><label>记忆整理模型（点击选择）</label>
        <div style="display:flex;gap:8px">
          <input type="text" id="cfg-mem-model-pick" readonly placeholder="点击选择模型" value="${esc(currentDisplay)}" style="flex:1;cursor:pointer" />
        </div>
        <div class="hint" id="mem-model-hint">${selP ? `当前：${esc(selP.displayName)} @ ${esc(selP.baseURL)}` : '尚未选择专用模型'}</div>
        <input type="hidden" id="cfg-mem-provider" value="${esc(mem.provider || '')}" />
        <input type="hidden" id="cfg-mem-model" value="${esc(mem.model || '')}" />
      </div>
    </div>
    <div class="field"><label>整理冷却时间（毫秒）</label><input type="number" id="cfg-mem-interval" min="1800000" step="600000" value="${esc(mem.consolidateMinIntervalMs ?? 21600000)}" /></div>
    <div class="hint">条数超过阈值且距上次整理超过该冷却时间后，才会在运行结束后后台整理。默认 6 小时（21600000 毫秒）。</div>

    <h3>聊天记录压缩</h3>
    <div class="hint" style="margin-bottom:8px">
      长期运行的群里存档只增不减。压缩把最老的一段交给模型摘要成一段纪要写回存档，
      <b>原文不会被删除</b>，只是移到 <code>data/messages/archive/&lt;会话&gt;.jsonl</code> 冷归档。
      摘要在存档页显示为一条「历史摘要」，页顶还会单独列出它有没有进提示词。<br />
      <b>它默认进不了提示词</b>：压缩把它插在"最近 N 条"之前（N = 下方「最近多少条原样保留」，默认 300），
      而【过去状态】只按独立历史深度读最近若干条，摘要压根够不着。要不要带上、带多少，
      去「聊天设置 › 历史摘要」里开。
    </div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-compact-enabled" ${comp?.enabled ? 'checked' : ''} />
      <label for="cfg-compact-enabled">启用定时压缩（会调用模型，产生费用）</label></div>
    <div class="field-row">
      <div class="field"><label>巡检间隔（毫秒）</label><input type="number" id="cfg-compact-interval" min="300000" step="60000" value="${esc(comp?.checkIntervalMs ?? 3600000)}" /></div>
      <div class="field"><label>同一会话冷却（毫秒）</label><input type="number" id="cfg-compact-cooldown" min="600000" step="600000" value="${esc(comp?.minIntervalMs ?? 86400000)}" /></div>
      <div class="field"><label>一次巡检最多处理几个会话</label><input type="number" id="cfg-compact-chats" min="1" max="10" value="${esc(comp?.maxChatsPerSweep ?? 1)}" /></div>
    </div>
    <div class="field-row">
      <div class="field"><label>存档条数超过多少才压</label><input type="number" id="cfg-compact-minmsgs" min="50" value="${esc(comp?.minMessagesToCompact ?? 800)}" /></div>
      <div class="field"><label>最近多少条原样保留（下限 100）</label><input type="number" id="cfg-compact-keep" min="100" value="${esc(comp?.keepRecentMessages ?? 300)}" /></div>
      <div class="field"><label>单轮最多摘要多少条</label><input type="number" id="cfg-compact-perround" min="20" value="${esc(comp?.maxMessagesPerRound ?? 400)}" /></div>
    </div>
    <div class="field"><label>喂给模型的原始文本上限（字符）</label><input type="number" id="cfg-compact-chars" min="2000" step="1000" value="${esc(comp?.maxContextChars ?? 24000)}" /></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-compact-memory" ${comp?.compactMemory !== false ? 'checked' : ''} />
      <label for="cfg-compact-memory">压缩后顺带整理一次本群记忆（走它自己的冷却）</label></div>
    <div class="hint">
      「最近多少条原样保留」是这里最关键的旋钮：它同时是记忆引擎的证据来源
      （判断"谁在活跃/该不该发现新人"要数最近的发言），设得太小会让这些判断悄悄失灵。
      建议不低于 200。冷却与门槛没到就什么都不做，不会白花钱。
    </div>`;
}

export function renderPersonaSection(c) {
  return `
    <h3>人设</h3>
    ${renderPersonaPicker(c)}
    <div class="field-row">
      <div class="field"><label>机器人名字</label><input type="text" id="cfg-botname" value="${esc(c.persona.botName)}" /></div>
      <div class="field"><label>群内展示名（可选）</label><input type="text" id="cfg-selfnick" value="${esc(c.persona.selfNickname || '')}" /></div>
      <div class="field"><label>参与度</label>
        <select id="cfg-participation">
          <option value="low" ${c.persona.participation === 'low' ? 'selected' : ''}>安静型</option>
          <option value="medium" ${c.persona.participation === 'medium' ? 'selected' : ''}>普通群友</option>
          <option value="high" ${c.persona.participation === 'high' ? 'selected' : ''}>活跃型</option>
        </select></div>
    </div>
    <div class="field"><label>角色设定</label>
      <textarea id="cfg-roletext" class="persona-role-text" placeholder="例如：你是运维群里的老油条……">${esc(c.persona.roleText || '')}</textarea></div>
    <div class="field"><label>管理员附加规则（可选，追加到系统提示）</label>
      <textarea id="cfg-customrules" class="persona-role-text" style="min-height:100px">${esc(c.persona.customRules || '')}</textarea></div>
    ${renderPersonaSaveBar()}`;
}

export function renderAllowSection(c) {
  return `
    <h3 id="settings-allow">聊天白名单</h3>
    <div class="hint" style="margin-bottom:10px">白名单为空时机器人不会在任何群聊/私聊内运行。</div>
    <div class="field"><label>从 QQ 账号直接勾选</label>
      <div style="display:flex;gap:8px">
        <button class="btn btn-small" id="pick-groups-btn">选择群</button>
        <button class="btn btn-small" id="pick-friends-btn">选择好友</button>
        <span id="pick-result" class="muted" style="align-self:center"></span>
      </div></div>
    <div class="field-row">
      <div class="field"><label>允许的群号（逗号分隔）</label><input type="text" id="cfg-allowgroups" value="${esc((c.allow.groups || []).join(','))}" /></div>
      <div class="field"><label>允许的 QQ（逗号分隔）</label><input type="text" id="cfg-allowprivate" value="${esc((c.allow.private || []).join(','))}" /></div>
    </div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-allowallwhenempty" ${c.allowAllWhenEmpty === true ? 'checked' : ''} />
      <label for="cfg-allowallwhenempty">白名单留空时允许所有会话</label></div>
    <div class="hint">说明：勾选后，若上方两个列表都为空，机器人会在<b>所有</b>群聊和私聊中运行；只要填了任意一项，就只按名单过滤。</div>`;
}

export function renderHotSearchSection(c) {
  const cronMatch = String(c.hotSearchCron || '0 9 * * *').match(/^(\d{1,2}) (\d{1,2}) \* \* \*$/);
  const time = cronMatch
    ? `${String(cronMatch[2]).padStart(2, '0')}:${String(cronMatch[1]).padStart(2, '0')}`
    : '09:00';
  const selectedGroups = new Set((c.hotSearchTargetGroupIds || []).map(String));
  const platformLabels = { weibo: '微博', zhihu: '知乎', bilibili: 'B站', tieba: '百度贴吧' };
  const selectedPlatforms = new Set(c.hotSearchPlatformFilter || []);
  const allowedGroups = (c.allow?.groups || []).map(String);
  return `
    <h3>每日热搜播报</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-hotsearch-enabled" ${c.hotSearchEnabled === true ? 'checked' : ''} />
      <label for="cfg-hotsearch-enabled">启用每日全网热搜播报</label></div>
    <div class="field-row">
      <div class="field"><label>极数本源 API Key</label>
        <input type="password" id="cfg-hotsearch-key" value="${c.hasHotSearchApiKey ? '******' : ''}"
          placeholder="可留空匿名调用；输入新 Key 可替换" autocomplete="new-password" />
        <div class="hint" id="hotsearch-key-hint">${c.hasHotSearchApiKey
          ? '已配置 Key（不会返回浏览器或写入日志）'
          : '未配置 Key：仍会尝试匿名请求，但匿名额度与 QPS 较低。也可通过 HOT_SEARCH_API_KEY 注入。'}</div>
      </div>
      <div class="field"><label>每日时间</label><input type="time" id="cfg-hotsearch-time" value="${esc(time)}" /></div>
      <div class="field"><label>时区</label><input type="text" id="cfg-hotsearch-timezone" value="Asia/Shanghai" readonly /></div>
    </div>
    <div class="field-row">
      <div class="field"><label>目标 QQ 群（Ctrl/Command 可多选）</label>
        <select id="cfg-hotsearch-groups" multiple size="6">
          ${allowedGroups.map((id) => `<option value="${esc(id)}" ${selectedGroups.has(id) ? 'selected' : ''}>${esc(id)}</option>`).join('')}
        </select>
        <div class="hint" id="hotsearch-groups-hint">只显示当前 QQ 中存在且位于发送白名单范围内的群。</div>
      </div>
      <div class="field"><label>每次收录条数（3～20）</label>
        <input type="number" id="cfg-hotsearch-limit" min="3" max="20" value="${esc(c.hotSearchItemLimit ?? 10)}" />
        <label style="margin-top:12px">平台筛选（全不选 = 全平台）</label>
        ${Object.entries(platformLabels).map(([id, label]) => `
          <div class="checkbox-row"><input type="checkbox" data-hotsearch-platform="${id}" id="cfg-hotsearch-platform-${id}" ${selectedPlatforms.has(id) ? 'checked' : ''} />
            <label for="cfg-hotsearch-platform-${id}">${label}</label></div>`).join('')}
        <div class="checkbox-row"><input type="checkbox" id="cfg-hotsearch-links" ${c.hotSearchIncludeLinks === true ? 'checked' : ''} />
          <label for="cfg-hotsearch-links">附带原始榜单链接（默认关闭）</label></div>
      </div>
    </div>
    <div class="settings-divider"></div>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <button class="btn btn-small" id="hotsearch-preview-btn" type="button">立即测试拉取</button>
      <button class="btn btn-small btn-primary" id="hotsearch-broadcast-btn" type="button">立即播报一次</button>
      <span id="hotsearch-action-hint" class="muted"></span>
    </div>
    <div class="field" style="margin-top:12px"><label>最近一次任务状态</label>
      <div id="hotsearch-status" class="hint">正在读取…</div>
      <pre id="hotsearch-preview" style="display:none;white-space:pre-wrap;max-height:420px;overflow:auto;margin-top:10px"></pre>
    </div>`;
}

export function renderTranscriptionSection(c) {
  const t = c.transcription || {};
  const mib = 1024 * 1024;
  const enabled = t.enabledFromEnvironment ? t.effectiveEnabled === true : t.enabled === true;
  const appIdHint = t.appIdFromEnvironment
    ? '当前由环境变量 TENCENTCLOUD_APP_ID 提供；在这里填写会改为配置文件优先。'
    : (t.hasAppId ? 'AppID 已配置。' : '未配置 AppID。');
  const credentialHint = t.hasSecretId && t.hasSecretKey
    ? `腾讯云凭证已配置${t.secretIdFromEnvironment || t.secretKeyFromEnvironment ? '（至少一项来自环境变量）' : '（保存在服务端配置中）'}；浏览器不会读取原值。`
    : '腾讯云凭证尚未完整配置；可以在这里输入新值，或使用 TENCENTCLOUD_SECRET_ID / TENCENTCLOUD_SECRET_KEY。';
  return `
    <h3>音视频转写</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-transcription-enabled" ${enabled ? 'checked' : ''} ${t.enabledFromEnvironment ? 'disabled' : ''} />
      <label for="cfg-transcription-enabled">启用转写：QQ 命令 <code>/转写 &lt;视频URL&gt;</code>，以及模型自主调用 <code>transcribe_video</code></label></div>
    <div class="hint" style="margin-bottom:10px">${t.enabledFromEnvironment
      ? `启用状态由环境变量 QQ_AGENT_TRANSCRIPTION_ENABLED 固定为“${enabled ? '启用' : '停用'}”；如需页面控制，请先移除该环境变量并重启。`
      : '保存后新入队的任务读取最新配置。FFmpeg 路径发生变化后建议重启服务，以重新执行启动可用性检查。'}</div>

    <h3>腾讯云录音文件识别极速版</h3>
    <div class="field-row">
      <div class="field"><label>腾讯云 AppID</label>
        <input type="text" id="cfg-transcription-appid" inputmode="numeric" value="${esc(t.appId || '')}"
          placeholder="${t.appIdFromEnvironment ? '已由环境变量提供；留空保持' : '纯数字 AppID'}" />
        <div class="hint">${esc(appIdHint)}</div></div>
      <div class="field"><label>识别引擎</label>
        <input type="text" id="cfg-transcription-engine" value="${esc(t.engineType || '16k_zh')}" placeholder="16k_zh" />
        <div class="hint">默认 <code>16k_zh</code>：16k 中文普通话。</div></div>
    </div>
    <div class="field-row">
      <div class="field"><label>SecretId</label>
        <input type="password" id="cfg-transcription-secretid" value="${t.hasSecretId ? '******' : ''}"
          placeholder="输入新 SecretId；留空或保持掩码则不修改" autocomplete="new-password" /></div>
      <div class="field"><label>SecretKey</label>
        <input type="password" id="cfg-transcription-secretkey" value="${t.hasSecretKey ? '******' : ''}"
          placeholder="输入新 SecretKey；留空或保持掩码则不修改" autocomplete="new-password" /></div>
    </div>
    <div class="hint">${esc(credentialHint)} 输入框是只写的，不提供“显示原密钥”。</div>

    <h3>本地处理与限制</h3>
    <div class="field"><label>FFmpeg 可执行文件</label>
      <input type="text" id="cfg-transcription-ffmpeg" value="${esc(t.ffmpegPath || 'ffmpeg')}" placeholder="/usr/bin/ffmpeg" />
      <div class="hint">必须包含 <code>libmp3lame</code> 编码器；用户 URL 始终通过本地安全代理传给 FFmpeg。</div></div>
    <div class="field-row">
      <div class="field"><label>FFmpeg 总超时（毫秒）</label><input type="number" id="cfg-transcription-ffmpeg-timeout" min="10000" max="10800000" step="1000" value="${esc(t.ffmpegTimeoutMs ?? 900000)}" /></div>
      <div class="field"><label>腾讯云请求总超时（毫秒）</label><input type="number" id="cfg-transcription-flash-timeout" min="10000" max="1800000" step="1000" value="${esc(t.flashTimeoutMs ?? 300000)}" /></div>
    </div>
    <div class="field-row">
      <div class="field"><label>最长音视频时长（秒，最高 7200）</label><input type="number" id="cfg-transcription-max-duration" min="1" max="7200" value="${esc(t.maxDurationSeconds ?? 7200)}" /></div>
      <div class="field"><label>最大临时 MP3（MiB，最高 100）</label><input type="number" id="cfg-transcription-max-audio-mib" min="1" max="100" value="${esc(Math.round(Number(t.maxAudioBytes || 100 * mib) / mib))}" /></div>
      <div class="field"><label>最大源数据流量（MiB）</label><input type="number" id="cfg-transcription-max-source-mib" min="1" max="1024" value="${esc(Math.round(Number(t.maxSourceBytes || 256 * mib) / mib))}" /></div>
    </div>
    <div class="field"><label>QQ 内直接回复的最大字符数（200～4000）</label>
      <input type="number" id="cfg-transcription-result-chars" min="200" max="4000" value="${esc(t.resultMaxChars ?? 3500)}" />
      <div class="hint">超过后会截断消息，并尝试把完整 UTF-8 文本作为文件发送。</div></div>
    <div class="field-row">
      <div class="field"><label>模型自主调用：每群每小时上限</label><input type="number" id="cfg-transcription-chat-hourly" min="1" max="60" value="${esc(t.maxCallsPerChatPerHour ?? 3)}" /></div>
      <div class="field"><label>模型自主调用：全局每日上限</label><input type="number" id="cfg-transcription-daily" min="1" max="1000" value="${esc(t.maxCallsPerDay ?? 10)}" /></div>
    </div>
    <div class="hint">转写按次计费，所以模型自主调用时受这两项限制（<code>/转写</code> 命令不受限）。超限时工具直接失败并说明原因。</div>`;
}

export function renderPythonSection(c) {
  const p = c.python || {};
  return `
    <h3>Python 工具</h3>
    <div class="hint" style="margin-bottom:10px">
      项目里有两个 Python 工具，<strong>共用这一个解释器</strong>：漫画下载
      （<code>python-tools/jmcomic_download.py</code>）与搜图 worker
      （<code>python-tools/pic_image_search_worker.py</code>）。两个工具的依赖也合并成一份
      <code>python-tools/requirements.txt</code>，装一次即可。
    </div>
    <div class="field"><label>Python 解释器路径</label>
      <input type="text" id="cfg-python-path" value="${esc(p.path || '')}"
        placeholder="留空则自动探测；例如 E:\\anaconda\\envs\\my_bot\\python.exe" />
      <div class="hint">
        填<strong>解释器可执行文件</strong>的完整路径，不是环境目录。这个解释器里需要装好上面那份依赖：
        <code>&lt;上面的路径&gt; -m pip install -r python-tools/requirements.txt</code>
      </div>
      <div class="hint">
        留空时的探测顺序：环境变量 <code>QQ_AGENT_PYTHON</code> → Windows 固定环境
        <code>E:\\anaconda\\envs\\my_bot\\python.exe</code> → <code>conda run -n my_bot python</code>。
        依赖缺失时搜图 worker 会在启动日志里给出确切的安装命令。
      </div>
      <div class="hint">
        下面两个按钮都<strong>先保存本页、再按已保存的值探测</strong>（所以填完直接点即可）。
        「测试解释器」只看解析层级与两个库装没装；「跑一遍依赖自检」才是权威检查——它真的把
        搜图 worker 跑起来解释自己的库，输出原文照登。
      </div>
      <div style="display:flex;gap:8px;align-items:center;margin-top:8px;flex-wrap:wrap">
        <button class="btn btn-small" id="cfg-python-test" type="button">测试解释器</button>
        <button class="btn btn-small" id="cfg-python-selfcheck" type="button">跑一遍依赖自检</button>
        <span id="cfg-python-test-result" class="muted"></span>
      </div>
      <pre id="cfg-python-selfcheck-output" style="display:none;white-space:pre-wrap;max-height:420px;overflow:auto;margin-top:10px"></pre>
    </div>`;
}

// 表情包积极程度档位：[值, 显示名]
export function renderDesktopSection(c) {
  return `
    <h3>桌面端</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-autostart" ${c.server?.autoStart ? 'checked' : ''} />
      <label for="cfg-autostart">开机自启</label></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-closetray" ${c.server?.closeToTray !== false ? 'checked' : ''} />
      <label for="cfg-closetray">点关闭时最小化到托盘</label></div>
    <h3>界面</h3>
    <div class="field"><label>主题</label>
      <div class="theme-picker" id="theme-picker">
        ${['dark', 'light', 'system', '?'].map((t) => `
          <div class="theme-option${getThemePref() === t ? ' on' : ''}" data-theme-opt="${t}" role="button" tabindex="0">
            <span class="t-ico">${THEME_ICON[t]}</span>
            <span>${THEME_LABEL[t]}</span>
          </div>`).join('')}
      </div>
    </div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-showvision" ${c.ui?.showVision !== false ? 'checked' : ''} />
      <label for="cfg-showvision">模型目录显示“支持图片输入/不支持图片输入”徽标</label></div>
    <div class="field"><label>界面刷新间隔（毫秒）</label><input type="number" id="cfg-refreshms" min="1000" step="1000" value="${esc(c.ui?.refreshMs ?? 15000)}" /></div>
    <h3>版本</h3>
    <div class="field"><label>当前版本 <b id="update-current">…</b><span class="muted">（本机 package.json）</span></label></div>`;
}

export function renderOnebotSection(c) {
  return `
    <h3 id="settings-onebot">OneBot（SnowLuma）</h3>
    <div class="hint" style="margin-bottom:10px">SnowLuma 的启动、关闭与日志已移动到顶部「SnowLuma」页签。此处只保留连接配置。</div>
    <div class="field"><label>SnowLuma 程序目录（留空 = 自动使用项目内 snowluma/ 文件夹）</label>
      <div style="display:flex;gap:8px">
        <input type="text" id="cfg-snowlumadir" value="${esc(c.snowluma.dir || '')}" style="flex:1" />
        <button class="btn btn-small" id="open-snowluma-btn">打开文件夹</button>
      </div>
      <div class="hint" id="snowluma-hint"></div></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-snowlumalaunch" ${c.snowluma.autoLaunch ? 'checked' : ''} />
      <label for="cfg-snowlumalaunch">QQ Agent 启动时自动拉起 SnowLuma（未运行时）</label></div>
    <div class="field-row">
      <div class="field"><label>WebSocket 地址（收消息）</label><input type="text" id="cfg-wsurl" value="${esc(c.snowluma.wsUrl)}" /></div>
      <div class="field"><label>HTTP 地址（发消息）</label><input type="text" id="cfg-httpurl" value="${esc(c.snowluma.httpUrl)}" /></div>
      <div class="field"><label>WebSocket 令牌</label><input type="password" id="cfg-obtoken" value="${esc(c.snowluma.accessToken || '')}" /></div>
      <div class="field"><label>HTTP 令牌（与 WS 不同时填；SnowLuma 默认分开）</label><input type="password" id="cfg-obhttptoken" value="${esc(c.snowluma.httpAccessToken || '')}" /></div>
    </div>
    <div class="hint">改完 OneBot 地址需要重启应用生效；模型/人设/白名单即时生效。</div>`;
}

export function renderPersonaPicker(c) {
  const currentId = Object.entries(state.personaTemplates || {}).find(([, p]) => p.text === (c.persona?.roleText || ''))?.[0] || '';
  const currentName = state.personaTemplates[currentId]?.name || '';
  return `
    <div class="field-row" style="align-items:flex-end">
      <div class="field">
        <label>选择人设</label>
        <div style="display:flex;gap:8px">
          <input type="text" id="cfg-persona-pick" readonly placeholder="点击选择人设" value="${esc(currentName)}" style="flex:1;cursor:pointer" />
          <button class="btn btn-small" id="new-persona-btn">＋ 添加人设</button>
          <button class="btn btn-small btn-danger hidden" id="del-persona-btn">删除当前自定义人设</button>
        </div>
        <span id="persona-pick-hint" class="muted" style="font-size:12px"></span>
      </div>
    </div>`;
}

export function renderPersonaSaveBar() {
  return `
    <div class="persona-save-row">
      <button class="btn btn-primary" id="save-persona-btn">保存人设修改</button>
      <span id="persona-save-result" class="muted"></span>
    </div>`;
}
