// 面板静态接线检查：把 ui/index.html、ui/app.js、ui/style.css 当文本读，
// 断言"新加的 DOM id、页签、缓存路径"都对得上。
//
// 为什么值得单独一个套件：仓库没有 DOM 环境（也没装 jsdom），任何
// "$('#x').addEventListener" 写错 id 的 bug，只能靠人在浏览器里点到那一页
// 才会发现。这里用最笨的办法覆盖最常犯的那几类：
//   1. 绑到不存在的 id（静态骨架里没有，也不是模板串渲染出来的）
//   2. 新增页签漏了 switchTab 分支 / 漏了 view- 容器（点上去永远空白）
//   3. 过滤/分页的账本又跑回未过滤的 state.chatMessages（"还有 N 条"永远算不对）
import fs from 'node:fs';
import { readUI } from './lib/src.mjs';

const html = readUI('index.html');
const js = readUI('app.js');
const css = readUI('style.css');

let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ' → ' + extra : ''}`); }
};

console.log('\n═══ 表情包页签 ═══');
ok('导航里有 data-tab="stickers"', html.includes('data-tab="stickers"'));
ok('有 id="view-stickers" 容器', html.includes('id="view-stickers"'));
ok('switchTab 里有 stickers 分支', /if \(name === 'stickers'\) loadStickerView\(\)/.test(js));
// 页签与视图靠 `view-${name}` 约定配对，漏一个就点上去空白
const tabs = [...html.matchAll(/data-tab="([\w-]+)"/g)].map((m) => m[1]);
const views = [...html.matchAll(/id="view-([\w-]+)"/g)].map((m) => m[1]);
ok(`每个页签都有对应的 view- 容器（${tabs.join('/')}）`,
  tabs.every((t) => views.includes(t)) && views.every((v) => tabs.includes(v)),
  `页签 ${tabs} vs 视图 ${views}`);
ok('switchTab 覆盖了全部页签（漏一个就永远加载不出内容）',
  tabs.every((t) => new RegExp(`name === '${t}'`).test(js)), tabs.filter((t) => !new RegExp(`name === '${t}'`).test(js)).join(','));
// 只准有一处点绑：switchTab 里那次 $$('.tab') 是切 active 类，不算第二份逻辑。
// 判定"第二份逻辑"的特征是有人绕过 switchTab 自己拼一套 if。
ok('页签点击只绑了一次，且直接交给 switchTab',
  (js.match(/\$\$\('\.tab'\)\.forEach\(\(?tab\)? => \{\s*\n\s+tab\.addEventListener\('click', \(\) => switchTab\(tab\.dataset\.tab\)\);/g) || []).length === 1);
ok('switchTab 内部只切 class，没自己拼视图逻辑',
  /classList\.toggle\('active', t\.dataset\.tab === name\)/.test(js));

console.log('\n═══ 新代码引用的 DOM id 全部可解析 ═══');
// 静态骨架里的 id + app.js 模板串里的 id + JS 里 .id = '...' 动态建的
const staticIds = new Set([...html.matchAll(/id="([\w-]+)"/g)].map((m) => m[1]));
const tplIds = new Set([...js.matchAll(/id="([\w-]+)"/g)].map((m) => m[1]));
const dynIds = new Set([...js.matchAll(/\.id\s*=\s*'([\w-]+)'/g)].map((m) => m[1]));
const resolves = (id) => staticIds.has(id) || tplIds.has(id) || dynIds.has(id);

// 只查本次新增的三段代码。全局扫会让 banner-goto-settings / model-dd /
// model-pick-btn 这三个"初始提交就存在、ID 早被删但引用还留着"的历史遗留
// （都是 null 卫语句包着的死代码）把这条断言永远钉在红色，真正的新漏绑就看不见了。
const seg = (from, to) => {
  const a = js.indexOf(from), b = js.indexOf(to);
  if (a < 0 || b < 0 || b < a) throw new Error(`切片边界找不到: ${from} … ${to}`);
  return js.slice(a, b);
};
const REGIONS = {
  '表情包页': seg('const STICKER_SOURCE_LABEL', '编辑/添加某个群友的印象'),
  '存档页': seg('function renderChatMessages', 'function chatMessagesNewestFirst'),
  '记忆详情': seg('async function loadMemoryDetail', 'const STICKER_SOURCE_LABEL'),
  // 顶部「历史印象」块自己读一串 id（骨架建在 renderChatMessages 里，这里读的是它），
  // 单独切一段才扫得到。
  '历史印象块': seg('function updateChatDigestBlock', 'function chatVisibleMessages'),
  // 分群设置接线读的是「聊天设置」模板里渲出来的那批控件
  '历史摘要分群接线': seg('// ── 分群「历史摘要」', '// ── 屏蔽名单 ──')
};
const IDRE = /\$\('#([\w-]+)'\)|getElementById\('([\w-]+)'\)/g;
let idTotal = 0;
for (const [name, code] of Object.entries(REGIONS)) {
  const ids = [...new Set([...code.matchAll(IDRE)].map((m) => m[1] || m[2]))];
  const miss = ids.filter((i) => !resolves(i));
  idTotal += ids.length;
  ok(`${name}：${ids.length} 个 id 全部有归属`, miss.length === 0, `解析不到 ${miss.join(', ')}`);
}
ok('三段合起来确实扫到了东西（防止正则失效后空跑全绿）', idTotal >= 15, `只扫到 ${idTotal} 个`);

// 逐个点一遍本次新增的 id，避免上面那条被"同段里别的 id 都对"掩盖
for (const id of ['sticker-items', 'sticker-count', 'sticker-search', 'sticker-sync-btn', 'sticker-cache-btn', 'sticker-detail', 'cfg-sticker-maxkeep', 'chat-msg-body', 'memory-detail', 'chat-search', 'chat-note-btn', 'mem-search',
  // 历史摘要：顶部块 + 聊天设置
  'chat-digest-panel', 'chat-digest-details', 'chat-digest-summary', 'chat-digest-list', 'chat-digest-more', 'chat-digest-meta',
  'cfg-digest-everyround', 'cfg-digest-merge', 'cfg-digest-maxchars', 'cfg-digest-keepchars', 'cfg-digest-unified',
  'digest-unified-wrap', 'digest-pergroup-wrap', 'digest-group-select', 'digest-group-json', 'digest-group-note', 'digest-group-clear-btn',
  'cfg-digest-everyround-g', 'cfg-digest-merge-g', 'cfg-digest-maxchars-g']) {
  ok(`#${id} 可解析`, resolves(id));
}

// 历史遗留：不判失败，只打印，免得下次有人以为是自己写坏的
const legacy = [...new Set([...js.matchAll(/\$\('#([\w-]+)'\)|getElementById\('([\w-]+)'\)/g)].map((m) => m[1] || m[2]))]
  .filter((i) => !resolves(i));
if (legacy.length) console.log(`  ℹ️  历史遗留（初始提交就在、null 卫语句包着的死引用，非本次改动）：${legacy.join(', ')}`);

console.log('\n═══ 存档页：过滤 / 分页的账本 ═══');
ok('存在 chatVisibleMessages()', /function chatVisibleMessages\(\)/.test(js));
ok('滚动加载按过滤后的长度判断', /const total = chatVisibleMessages\(\)\.length;/.test(js),
  '若用 state.chatMessages.length，搜索态下会永远以为"后面还有"');
ok('表格填充用过滤后的列表',
  /const newestFirst = chatVisibleMessages\(\);\n  \/\/ 有查找词时/.test(js));
ok('过滤态一次性显示全部命中（分页账目才不会和"匹配 K 条"打架）',
  /state\.chatMsgLimit = String\(state\.chatQuery \|\| ''\)\.trim\(\)/.test(js));
ok('排序缓存仍按引用记忆（没被改成每次重排）', /chatMsgSortCache\.src !== src/.test(js));
ok('每行渲染出 改 / 删 两个操作', /data-op="edit"/.test(js) && /data-op="del"/.test(js));
ok('摘要行不给"改"（后端也会 400，前端不该给个点了报错的按钮）', /isDigest\s*\n?\s*\?\s*'<span class="muted" title="摘要由模型生成，不能手改">—<\/span>'/.test(js));
ok('摘要行仍然给"删"（后端 DELETE 不拦摘要，只拦 PATCH）',
  /\+ '<button class="btn btn-small btn-danger" data-op="del"/.test(js)
  && !/title="摘要由模型生成，不能手改；可以删除"/.test(js));
ok('删除确认里不把摘要/备注说成"我"发的（senderName 为空串）',
  /const who = m\.kind === 'digest' \? '摘要'/.test(js) && !/m\.senderName \|\| '我'\}:\\n/.test(js));
ok('对人工备注不谎称"原文可能仍在冷归档"（它从没收发过）', /if \(m\.kind !== 'note'\) warn \+= '· 消息原文/.test(js));
ok('删摘要时换成"下次压缩会重新生成"的说法', /m\.kind === 'digest'\s*\n?\s*\? '· 这是压缩摘要/.test(js));
ok('操作走事件委托（轮询会换掉 tbody 的 innerHTML）',
  /\$\('#chat-msg-body'\)\.addEventListener\('click'/.test(js) && !/\.ops.*addEventListener/.test(js));
ok('切换会话时清空查找词', /state\.chatQuery = '';/.test(js));
ok('备注行有独立样式 .note-row', css.includes('.archive-table .note-row'));

console.log('\n═══ 历史摘要：设置项 ↔ 接线 ↔ 保存分支 ═══');
// 一、顶部块：刷新钩子挂对了地方
ok('顶部块的刷新挂在 updateChatMessagesBody 末尾（轮询/SSE/查找/翻页都汇到这里）',
  /updateChatMessagesMeta\(newestFirst\);\n(?:.*\n)*?\s+updateChatDigestBlock\(\);/.test(js));
ok('删除委托同时挂在表格和顶部块上（复用同一段处理）',
  /\$\('#chat-msg-body'\)\.addEventListener\('click', onRowOp\)/.test(js)
  && /\$\('#chat-digest-list'\)\.addEventListener\('click', onRowOp\)/.test(js));
ok('没有把委托绑在 #chat-detail 上（那元素从不重建，切一次会话叠一个监听器 → 弹两次确认框）',
  !/\$\('#chat-detail'\)\.addEventListener\('click'/.test(js));
ok('折叠状态记在 state 里（切会话重建骨架后能还原）',
  /state\.chatDigestOpen = ev\.currentTarget\.open === true/.test(js) && /state\.chatDigestOpen === false \? '' : ' open'/.test(js));
ok('轮询的内容没变就不重写 innerHTML（否则展开态与滚动每轮被冲）',
  /if \(state\.chatDigestSig === sig\) return;/.test(js));
ok('memo 签名里带了会话号（两个会话的摘要 id 可能撞成一样的数组）',
  /const sig = JSON\.stringify\(\[state\.currentChatKey/.test(js));
ok('切换会话时先清掉上一个会话的注入状态', /state\.chatDigests = null;/.test(js));
ok('删除/编辑后的刷新路径会重取 digestStatus', /state\.chatDigests = data\.digestStatus \|\| null;/.test(js));
ok('有样式类 .digest-panel / 注入徽标', css.includes('.digest-panel') && css.includes('.digest-badge.is-in') && css.includes('.digest-badge.is-out'));

// 二、设置项：三个开关 + 上限 + 统一/分群
ok('「每轮都注入」开关在（默认不勾 = 只在读历史那轮带）', /id="cfg-digest-everyround" \$\{c\.digest\?\.injectEveryRound \? 'checked' : ''\}/.test(js));
ok('「合并新老摘要」开关默认勾上', /id="cfg-digest-merge" \$\{c\.digest\?\.merge !== false \? 'checked' : ''\}/.test(js));
ok('字数上限默认 8000 且回显现值', /id="cfg-digest-maxchars" min="0" max="200000" value="\$\{esc\(c\.digest\?\.maxChars \?\? 8000\)\}"/.test(js));
ok('设置页写明了「0 = 不注入」与本页其它「0 = 不限」相反', js.includes('0 = 不注入') && js.includes('正好相反'));
ok('说明了没压缩过就不会注入（勾了也没用）', js.includes('没压过的会话，勾了也不会注入'));
ok('说明了屏蔽名单清不掉已生成的摘要', js.includes('不能</b>清掉他之前生成的摘要'));
ok('统一/分群开关与包装块都在', /id="cfg-digest-unified"/.test(js) && /id="digest-unified-wrap"/.test(js) && /id="digest-pergroup-wrap"/.test(js));
ok('分群的隐藏 JSON 是唯一真相（不引全局变量）', /id="digest-group-json" value="\$\{esc\(JSON\.stringify\(c\.digest\?\.perChat \|\| \{\}\)\)\}"/.test(js));
ok('统一开关切两块 UI 的显隐', /const digUnified = \$\('#cfg-digest-unified'\);[\s\S]{0,400}?digest-pergroup-wrap/.test(js));
ok('切群 / 改控件 / 清除 三个动作都接了', /digGroupSel\.addEventListener\('change', loadGroup\)/.test(js)
  && /gMax\.addEventListener\('input', storeGroup\)/.test(js)
  && /#digest-group-clear-btn'\)\?\.addEventListener\('click'/.test(js));
ok('清除该群设置是真删键（不是写个空值）', /const m = readMap\(\); delete m\[gid\]; writeMap\(m\); loadGroup\(\);/.test(js));
ok('写入时三个字段一次写全（缺字段会被解析函数按默认值兜底，等于"改一处、悄悄关两处"）',
  /m\[gid\] = \{\s*\n\s+injectEveryRound: !!gEvery\.checked,\s*\n\s+merge: !!gMerge\.checked,\s*\n\s+maxChars: clampInt/.test(js));

// 三、保存分支：控件 → patch.digest 一一对应
const saveSeg = seg("if (sec === 'chat')", "if (sec === 'desktop')");
ok('保存分支里建了 patch.digest', /patch\.digest = \{/.test(saveSeg));
ok('injectEveryRound / merge / maxChars / unified 四项都从控件读',
  /injectEveryRound: chk\('#cfg-digest-everyround'/.test(saveSeg) && /merge: chk\('#cfg-digest-merge'/.test(saveSeg)
  && /maxChars: clampInt\(val\('#cfg-digest-maxchars'/.test(saveSeg) && /unified: chk\('#cfg-digest-unified'/.test(saveSeg));
ok('maxChars 的钳位范围与上方控件一致（0~200000）', /clampInt\(val\('#cfg-digest-maxchars'[^)]*\), 0, 200000, 8000\)/.test(saveSeg));
ok('存档上限默认 0（= 不限）且回显现值 —— 默认值与磁盘保留策略必须对上，写错就是静默删用户数据',
  /id="cfg-digest-keepchars" min="0" max="200000" step="1000" value="\$\{esc\(c\.digest\?\.maxKeepChars \?\? 0\)\}"/.test(js));
ok('存档上限的钳位兜底是 0（跟 maxChars 的 8000 相反：那个不给就"不注入"，这个不给就"不限"）',
  /clampInt\(val\('#cfg-digest-keepchars'[^)]*\), 0, 200000, 0\)/.test(saveSeg));
ok('hint 说清这一项管的是存档、不是提示词（两笔账）',
  js.includes('这一项管的不是提示词') && js.includes('永远保留最新的一条'));
ok('hint 点名了备份后缀，让用户知道后悔药在不在这儿',
  js.includes('.digestgc.bak') && js.includes('.json.bak'));
ok('分群表里不带这个字段（全局限定：它管磁盘占用，不是"这个群怎么说话"）',
  !/m\[gid\] = \{[\s\S]{0,300}?maxKeepChars/.test(js) && js.includes('不参与下面的按群覆盖'));
ok('分群表用 __replace__（普通深合并删不掉键，「清除该群」就永远清不掉）',
  /perChat: \{\s*\n\s+__replace__:/.test(saveSeg));
ok('digest 挂在顶层而不是 store 下（生成摘要是 compact 的事，注入是另一件事）',
  !/patch\.store\.digest/.test(saveSeg) && !/patch\.digest[\s\S]{0,80}?unifiedTier/.test(saveSeg));

// 四、改掉那句假话
ok('不再谎称摘要"在【过去状态】里能看到"（keepRecent 300 > 窗口 80，根本够不着）',
  !js.includes('模型在【过去状态】里也能看到它'));
ok('取而代之的是实话 + 去哪儿开', js.includes('它默认进不了提示词') && js.includes('历史摘要」里开'));

console.log('\n═══ 记忆页：单条印象 ═══');
ok('渲染出 imp-row 行', js.includes('class="imp-row"'));
ok('每行带 改 / 删', js.includes('class="btn btn-small imp-edit"') && js.includes('class="btn btn-small btn-danger imp-del"'));
ok('按 data-idx 定位、正文取自闭包（不把内容塞进 DOM 属性）',
  /data-idx="\$\{idx\}"/.test(js) && /impTarget/.test(js));
ok('点击不会顺手折叠 <details>（preventDefault + stopPropagation 都在）',
  (js.match(/\.imp-edit.*?stopPropagation/s) || []).length > 0 && (js.match(/\.imp-del.*?stopPropagation/s) || []).length > 0);
ok('整理中重绘不会打断输入（挂起 + focusout 补偿）',
  /memRefreshPending/.test(js) && /refreshMemoryViewSoon\(\)/.test(js) && js.includes("addEventListener('focusout'"));
ok('整理状态事件走挂起版刷新', !/es\.addEventListener\('memory-update'[\s\S]{0,2000}?\n\s+loadMemoryView\(\);/.test(js));
ok('样式里有 .imp-row', css.includes('.imp-row'));

console.log('\n═══ 缩略图必须走后端代理 ═══');
// 直连图床会踩两个坑：QQ 防盗链裂图；库被污染成内网地址 = 用户浏览器打内网
ok('卡片用代理端点，不是 s.url',
  /const src = `\/api\/stickers\/\$\{encodeURIComponent\(s\.id\)\}\/image`/.test(js));
ok('整份 app.js 里没有把表情 url 直接塞进 img',
  !/<img[^>]*src="\$\{esc\(s\.url\)\}/.test(js) && !/<img[^>]*src="\$\{s\.url\}/.test(js));
ok('大图也用同一个代理', (js.match(/\/image`/g) || []).length >= 2);
ok('id 进 URL 前做了 encodeURIComponent', (js.match(/encodeURIComponent\(s\.id\)/g) || []).length >= 3);

console.log('\n═══ 表情包：本地缓存 + 收藏上限 ═══');
// 上限这一项是**会删数据**的开关，所以：控件默认值、钳位兜底、hint 的说法，三处都得对上。
ok('上限控件默认 0 且回显现值',
  /id="cfg-sticker-maxkeep" min="0" max="5000" step="10"\s*\n?\s*value="\$\{esc\(c\.sticker\?\.maxKeepCount \?\? 0\)\}"/.test(js));
ok('上限的钳位兜底是 0 = 不限（默认值绝不能是"删用户数据"）',
  /clampInt\(val\('#cfg-sticker-maxkeep'[^)]*\), 0, 5000, 0\)/.test(saveSeg));
ok('hint 说清只数 bot 自己收藏的（QQ 收藏不算也删不掉）',
  js.includes('只数 <b>bot 自己收藏的</b>') && js.includes('QQ 收藏不算进这个数，也删不掉'));
ok('hint 说清 0 = 不限', js.includes('<b>0 = 不限</b>'));
ok('hint 说清"新收藏一个的时候才整理"（调小不会立刻删）',
  js.includes('超上限时在「新收藏一个」的时候才整理') && js.includes('不会</b>立刻删'));
ok('hint 点出这个上限同时管着缓存图片的占用',
  js.includes('data/sticker-cache/') && js.includes('条目被删，它在'));
ok('上限不在分群覆盖里（表情配置本来就全局限定，别让用户以为能按群设）',
  !/m\[gid\] = \{[\s\S]{0,300}?maxKeepCount/.test(js));

ok('「缓存图片」按钮在静态骨架里（列表重绘不会把它冲掉）', html.includes('id="sticker-cache-btn"'));
ok('按钮 POST 到 /api/stickers/cache',
  /\$\('#sticker-cache-btn'\)\?\.addEventListener\('click'[\s\S]{0,500}?api\('\/api\/stickers\/cache', \{ method: 'POST'/.test(js));
ok('下载期间禁用按钮（防连点重复下载）',
  /const btn = e\.currentTarget;\s*\n\s*if \(btn\.disabled\) return;/.test(js) && js.includes("btn.textContent = '缓存中…'"));
ok('结果照实分行报告：新缓存 / 清掉的孤儿 / 没取到的 / 还剩',
  js.includes('新缓存 ${r.cached || 0} 张') && js.includes('清掉 ${r.swept} 个没人认领的旧文件')
  && js.includes('张没取到') && js.includes('还剩 ${r.remains} 张'));
ok('结果写进计数行、由下一次渲染消费掉（不另开一个会残留的提示条）',
  /state\.stickerCacheNote = parts\.join\(' · '\)/.test(js) && /state\.stickerCacheNote = '';/.test(js));
ok('计数行报 bot 收藏数 / 上限（用户要能自己看出离上限多远）',
  /bot 收藏 \$\{state\.stickerOwned\} 个/.test(js) && /上限 \$\{state\.stickerMaxKeep\}/.test(js));
ok('详情页三态都写了：已缓存 / QQ 收藏不进缓存 / 还没有本地图片',
  js.includes('已缓存，发送时直接用本机图片') && js.includes('QQ 收藏不进缓存')
  && js.includes('还没有本地图片'));
ok('详情页说清了缓存会在发送时自动补（用户不必非要点按钮）', js.includes('等它被发送时自动补一份'));

console.log('\n═══ 危险操作的解释文案都在 ═══');
ok('删除存档的确认里说明了冷归档不会跟着删', js.includes('data/messages/archive/'));
ok('删除存档的确认里说明了会留 .panel.bak', js.includes('.panel.bak'));
ok('删除存档的确认里对未读消息额外提醒', js.includes('这条还是未读'));
ok('删掉最后一条印象时提示成员文件也会被删', js.includes('记忆文件'));
ok('QQ 收藏的删除按钮是禁用的并写明原因', /QQ 收藏不能在这里删/.test(js));
ok('表情编辑弹窗说明 desc 不可编辑', js.includes('每次同步都会被源数据盖回来'));
ok('说明了改动只影响下一轮运行', js.includes('下一轮'));

console.log(`\n════ 通过 ${pass} / 失败 ${fail} ════`);
process.exit(fail === 0 ? 0 : 1);
