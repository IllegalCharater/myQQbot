// 面板静态接线检查：把 ui/index.html、ui/js 模块树、ui/style.css 当文本读，
// 断言"新加的 DOM id、页签、缓存路径"都对得上。
//
// 为什么值得单独一个套件：仓库没有 DOM 环境（也没装 jsdom），任何
// "$('#x').addEventListener" 写错 id 的 bug，只能靠人在浏览器里点到那一页
// 才会发现。这里用最笨的办法覆盖最常犯的那几类：
//   1. 绑到不存在的 id（静态骨架里没有，也不是模板串渲染出来的）
//   2. 新增页签漏了 switchTab 分支 / 漏了 view- 容器（点上去永远空白）
//   3. 过滤/分页的账本又跑回未过滤的 state.chatMessages（"还有 N 条"永远算不对）
import fs from 'node:fs';
import path from 'node:path';
import { readUI, uiFile, stripComments, readSrc } from './lib/src.mjs';

const html = readUI('index.html');
const jsRoot = uiFile('js');
const js = fs.readdirSync(jsRoot, { recursive: true })
  .filter((name) => String(name).endsWith('.js'))
  .sort()
  .map((name) => fs.readFileSync(path.join(jsRoot, name), 'utf8'))
  .join('\n');
const css = readUI('style.css');
const chatJs = readUI('js/views/chats.js');
const memoryJs = readUI('js/views/memory.js');
const stickerJs = readUI('js/views/stickers.js');
const settingsJs = readUI('js/views/settings/index.js');
const agentRunnerTs = fs.readFileSync(path.join(process.cwd(), 'src/agent/runtime/agent-runner.ts'), 'utf8');

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
// 页签条的纵向滚动条：`overflow-x: auto` 会把 `overflow-y` 的 `visible` **计算成 `auto`**，
// 而 `.tab` 的 `margin-bottom: -1px`（下划线与 nav 下边框对齐用的）恰好造成 1px 纵向可滚内容
// —— 于是最右边常年挂着一根纵向滚动条（实测 11px，**实测反馈**）。显式 `hidden` 才收得掉。
// ⚠️ 断言只能证明声明存在；「下划线看起来没变」是截图逐像素比出来的，不是这里证得了的。
ok('#tabs 显式 overflow-y: hidden（否则最右侧挂着 1px 溢出引出的纵向滚动条）',
  /#tabs \{[^}]*overflow-x:\s*auto[^}]*overflow-y:\s*hidden/.test(css));
ok('没有靠删掉 .tab 的 margin-bottom: -1px 来消那 1px（那会让下划线与下边框之间空一条）',
  // 锚在 `.tab` 真规则的首行（`background: none;`）上，免得先匹配到上面那条注释里的 `.tab { … }`
  /^\s*\.tab \{\r?\n\s*background: none;[\s\S]*?margin-bottom:\s*-1px/m.test(css));
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
const segmentOf = (source, from, to) => {
  const a = source.indexOf(from), b = source.indexOf(to);
  if (a < 0 || b < 0 || b < a) throw new Error(`模块切片边界找不到: ${from} … ${to}`);
  return source.slice(a, b);
};

console.log('\n═══ 音视频转写设置 ═══');
ok('设置侧栏有独立的音视频转写入口并接到渲染函数',
  /\['transcription', '音视频转写'\]/.test(js)
  && /transcription: \(\) => renderTranscriptionSection\(c\)/.test(js));
for (const id of [
  'cfg-transcription-enabled', 'cfg-transcription-appid', 'cfg-transcription-engine',
  'cfg-transcription-secretid', 'cfg-transcription-secretkey', 'cfg-transcription-ffmpeg',
  'cfg-transcription-ffmpeg-timeout', 'cfg-transcription-flash-timeout',
  'cfg-transcription-max-duration', 'cfg-transcription-max-audio-mib',
  'cfg-transcription-max-source-mib', 'cfg-transcription-result-chars',
  'cfg-transcription-chat-hourly', 'cfg-transcription-daily'
]) {
  ok(`#${id} 已加入设置模板`, new RegExp(`id="${id}"`).test(js));
}
const transcriptionSave = seg("if (sec === 'transcription')", "if (sec === 'chat')");
ok('音视频转写保存分支生成 patch.transcription', /patch\.transcription = \{/.test(transcriptionSave));
ok('SecretId/SecretKey 保持只写：掩码或空值不会覆盖服务端原值',
  /secretId && secretId !== '\*\*\*\*\*\*'/.test(transcriptionSave)
  && /secretKey && secretKey !== '\*\*\*\*\*\*'/.test(transcriptionSave));
ok('页面保存时钳制极速版 7200 秒 / 100 MiB 硬上限',
  /maxDurationSeconds: clampInt\([^\n]+, 1, 7200, 7200\)/.test(transcriptionSave)
  && /maxAudioBytes: clampInt\([^\n]+, 1, 100, 100\) \* 1048576/.test(transcriptionSave));

console.log('\n═══ Python 工具设置（解释器路径） ═══');
// 这个字段是整个仓库里唯一能让用户从"Python 环境不对"里自救的旋钮，而它此前
// 一条断言都没有：id 改名、保存分支被删、被好心兜一个非空默认值（把"留空走自动
// 探测链"变成"写死一个路径"）—— 四套件全绿，症状是搜图/漫画悄悄不可用。
ok('设置侧栏有独立的 Python 工具入口并接到渲染函数',
  /\['python', 'Python 工具'\]/.test(js)
  && /python: \(\) => renderPythonSection\(c\)/.test(js));
for (const id of [
  'cfg-python-path', 'cfg-python-conda-env', 'cfg-python-test', 'cfg-python-selfcheck',
  'cfg-python-test-result', 'cfg-python-selfcheck-output'
]) {
  ok(`#${id} 已加入设置模板`, new RegExp(`id="${id}"`).test(js));
  ok(`#${id} 可解析`, resolves(id));
}
const pythonSave = seg("if (sec === 'python')", "if (sec === 'chat')");
// 把 `val('#id', <实参>)` 的**实参**单独取出来再判，不直接对整段做"有没有非空字面量"的扫描。
//
// 为什么要多这一步（实测踩到的）：先前那两条反向断言写的是 `![^)]*'[^']+'`，而 `[^']+` **能吃掉
// `)`** —— 它一路啃到后面某个成对的引号上就成立了。老代码里它看着是绿的，只是因为段尾恰好没有
// 下一个引号；段里一旦多出一个引号（比如注释里写个 `'my_bot'` 举例），它立刻假红，而**被验的
// 性质其实没变**。判据必须是"实参长什么样"，不是"整段里有没有引号"。
const pyArg = (id) => {
  const m = new RegExp(`val\\('#${id}',([^)]*)\\)`).exec(pythonSave);
  return m ? m[1] : '';
};
const noLiteralDefault = (arg) => /p\.\w+ \|\| ''/.test(arg) && !/'[^']+'/.test(arg) && !/"[^"]+"/.test(arg);
ok('Python 保存分支生成 patch.python.path',
  /patch\.python = \{[\s\S]*?path: val\('#cfg-python-path'/.test(pythonSave));
// 空串是合法值（含义是"没配，走自动探测链"，见 core/python-runtime.ts）。兜一个
// 非空默认值会把"留空"变成"填一个写死的路径"，而用户根本看不出自己没配。
ok('python.path 的兜底必须仍是空串：不许出现非空字符串默认值',
  noLiteralDefault(pyArg('cfg-python-path')),
  `实参是 ${JSON.stringify(pyArg('cfg-python-path'))}`);
ok('Python 保存分支生成 patch.python.condaEnv（conda 那一级的环境可配置）',
  /patch\.python = \{[\s\S]*?condaEnv: val\('#cfg-python-conda-env'/.test(pythonSave));
// 同上：conda 环境栏的空串**也是合法语义**（= 不带 -n/-p，用 conda 当前环境），
// 所以兜底只能是"当前值或空"，不能塞 'my_bot'——那会把"留空"悄悄变成"指定 my_bot"。
ok('python.condaEnv 的兜底同样是空串：不许出现非空字符串默认值',
  noLiteralDefault(pyArg('cfg-python-conda-env')),
  `实参是 ${JSON.stringify(pyArg('cfg-python-conda-env'))}`);
// 出厂默认值是**跨边界的两份字面量**：后端那份（`core/config.ts` 的 DEFAULT_CONFIG）是权威，
// UI 这份只是模板里的兜底。漂移的表现是"面板显示 A、后端实际用 B"，而没人会去逐字核对两个
// 文件 —— 所以钉死，失败时把两个值都印出来（同 TEST_QUERY_DEFAULT 那条的待遇）。
{
  const beConda = (/condaEnv:\s*'([^']+)'/.exec(readSrc('core/config.js')) || [])[1];
  const uiConda = (/id="cfg-python-conda-env" value="\$\{esc\(p\.condaEnv \?\? '([^']+)'\)\}"/.exec(readUI('js/views/settings/sections.js')) || [])[1];
  ok('conda 环境名的出厂默认值在 core 与 UI 两边逐字相同',
    Boolean(beConda) && beConda === uiConda, `后端 ${beConda} / 前端 ${uiConda}`);
}
// 删除回潮：那一行写死的 `E:\anaconda\envs\my_bot\python.exe` 与它对应的来源档位都不该再出现。
ok('设置页不再有「Windows 固定环境」那一档（源码里那行写死的绝对路径已删除）',
  !/windows-direct/.test(js) && !js.includes('Windows 固定环境'));

const pythonBlock = segmentOf(settingsJs, '// ── Python 工具：解释器探测 / 依赖自检 ──', '// ── 每日热搜播报 ──');
ok('「测试解释器」按钮绑了 click 监听',
  /\$\('#cfg-python-test'\)/.test(pythonBlock) && /pythonTest\.addEventListener\('click'/.test(pythonBlock));
ok('「跑一遍依赖自检」按钮绑了 click 监听',
  /\$\('#cfg-python-selfcheck'\)/.test(pythonBlock) && /pythonCheck\.addEventListener\('click'/.test(pythonBlock));
// 后端有意**拒绝从请求体取可执行文件路径**（否则等于凭空开一个"用 HTTP 启动任意
// 本机程序"的一步接口），所以"先存本页再探测"不是体验选择而是唯一通路：不保存，
// 探的就是"刚敲进输入框的字符串"，而它跟后端真正会用的那个值可以不一样。
ok('两个按钮都先保存本页再探测',
  (pythonBlock.match(/await saveConfig\(\{ quiet: true \}\)/g) || []).length === 2
  && pythonBlock.indexOf('await saveConfig({ quiet: true })') < pythonBlock.indexOf('/api/system/python-probe'));
ok('探测请求不带路径（路径只能经鉴权过的 POST /api/config 写入）',
  /api\('\/api\/system\/python-probe', \{ method: 'POST', body: '\{\}' \}\)/.test(pythonBlock)
  && !/JSON\.stringify\(\{[^}]*path/.test(pythonBlock));
ok('自检请求同样不带路径，且走的是同一个「已保存配置」入口',
  /api\('\/api\/system\/python-selfcheck', \{ method: 'POST', body: '\{\}' \}\)/.test(pythonBlock)
  && pythonBlock.indexOf('await saveConfig({ quiet: true })') < pythonBlock.indexOf('/api/system/python-selfcheck'));
ok('自检原文用 textContent 照登（不拼 HTML、不截断：worker 的映射表要靠原文做回归对账）',
  /pre\.textContent = r\.output \|\| /.test(pythonBlock) && !/pre\.innerHTML/.test(pythonBlock));
ok('自检按钮跑完会复位（finally 里恢复 disabled，否则一次失败就永久禁用）',
  /finally \{\s*\r?\n\s*pythonCheck\.disabled = false;/.test(pythonBlock));

console.log('\n═══ 联网搜索：网页收藏夹与调用阀门 ═══');
// 这一段的四个 id 此前一个都不存在，而它们在 save.js 里全是 `$('#…')?.value` 的形式：
// id 写错**不会报错**，只会让收藏夹静默保存成空数组（`?.` 兜住 undefined），
// 表现为"填了收藏夹但搜索完全不理会它"—— 与"功能本身没生效"长得一模一样。
for (const id of ['cfg-search-bookmarkmode', 'search-bookmarks-body', 'add-search-bookmark-btn', 'cfg-search-chat-hourly', 'cfg-search-daily']) {
  ok(`#${id} 已加入设置模板`, new RegExp(`id="${id}"`).test(js));
  ok(`#${id} 可解析`, resolves(id));
}
const searchSave = seg("if (sec === 'search')", "if (sec === 'image-source')");
// 渲染那一段（`renderBookmarkRows`）在 sections.js 里，`js` 是全部 UI 文件拼起来的，
// 单独读它才能断言"渲染有没有写 dataset"。
const sectionsSrc = readUI('js/views/settings/sections.js');
// 收藏夹用 `data-bm-*` 标记每一格。
// 这些属性名是 save.js 逐行取值的**唯一接口**：改名只改一端会静默读出 undefined，
// 于是每一项都因"不全"被丢弃 —— 表现为"收藏夹存不进去"，而没有任何报错。
//
// ⚠️ `data-bm-searchurl` **已经不存在了**：它与 `data-bm-url` 合并成一栏（见下面那条）。
// 收藏夹每一行还额外带 `data-bm-req-json` / `data-bm-params-json` 两个 dataset
// （由「请求结构」弹窗写入，save.js 从这里读），它们是属性不是元素，所以单独断言。
for (const attr of ['data-bm-key', 'data-bm-url', 'data-bm-purpose', 'data-bm-resultclass', 'data-bm-probe', 'data-bm-status', 'data-bm-req']) {
  ok(`${attr} 在渲染里出现（save.js 与自动检测靠它取值）`, new RegExp(attr).test(js));
}
// 「网页地址」与「站内搜索地址」合并：**不能再有一个独立的 searchurl 输入框**，
// 否则两栏会各自写一个值，而后端只认一个 —— 那种"两处口径不同"最难查。
ok('合并那一栏：没有独立的 searchUrl 输入框了（旧 data-bm-searchurl 已移除）',
  !/data-bm-searchurl/.test(js));
ok('「请求结构」入口存在，且读数走 dataset（弹窗写、save.js 读）',
  /data-bm-req-json/.test(searchSave) && /dataset\.bmParamsJson/.test(searchSave));

// ── 「请求结构」弹窗里的静态参数编辑器 ──
// 形状与设置页「模型 API」那套**故意一致**：`type="password"` 的输入框 + 旁边的「显示」按钮，
// 用户不必学第二种交互。改成"一行一个参数"（而不是一个 `名字: 值` 的多行 textarea）正是
// 为了让**密钥能单独切换显示** —— textarea 里没法给某一行加按钮。
const reqModalSrc = readUI('js/parts/bookmark-request.js');
ok('参数值是 password 输入框（与「模型 API」同一形状，密钥默认不明文）',
  /type="password" data-bqp-value/.test(reqModalSrc));
ok('每个参数旁有「显示」按钮，且按 type 切换 password ⇄ text',
  /data-bqp-toggle/.test(reqModalSrc) && /input\.type = toText \? 'text' : 'password'/.test(reqModalSrc));
ok('按钮文案随状态切换「显示」/「隐藏」',
  /toggle\.textContent = toText \? '隐藏' : '显示'/.test(reqModalSrc));
ok('参数可增可删，且走事件委托（动态插入的行不会漏绑）',
  /bqr-add-param/.test(reqModalSrc) && /del\.closest\('\[data-bqp-row\]'\)\?\.remove\(\)/.test(reqModalSrc)
  && /paramsBox\.addEventListener\('click'/.test(reqModalSrc));
ok('保存时从**行**里收参数（不再读一个 textarea 的文本）',
  /querySelectorAll\('\[data-bqp-row\]'\)/.test(reqModalSrc) && /collectParams\(overlay\)/.test(reqModalSrc));

// ── 检测到 JSON 接口 → 把地址搬进「请求结构」并弹窗 ──
// 这一栏只解析 HTML，JSON 接口填这里**永远**通不过；但能力早就有（就是「请求结构」）。
// 不加这步，用户看到的就是一句"没通过检测"然后**卡住**，还得自己换按钮 + 手抄地址（**实测反馈**）。
// 判据必须是后端给的**机器可读标记**，不许匹配 note 文案（文案改过，匹配文案会静默失效）。
ok('检测结果按 detectedJson 标记分流，**不匹配 note 文案**',
  /res\.detectedJson/.test(js) && !/note[^\n]*JSON 接口数据/.test(js));
ok('检测到 JSON 时打开「请求结构」并预填地址',
  /openRequestModalFor\(row, \{[\s\S]{0,200}buildJsonRequest\(res\.jsonApiUrl\)/.test(js));
ok('弹窗的打开与回填只有**一份**实现（点击与预填共用，否则会"看 A 写 B"）',
  (js.match(/function openRequestModalFor\(/g) || []).length === 1
  && /openRequestModalFor\(reqBtn\.closest\('tr'\)\)/.test(js));
ok('预填只在**该行还没配过**请求结构时生效（不顶掉已有配置）',
  /if \(!request && prefill\?\.request\)/.test(js) && /!row\.dataset\.bmReqJson/.test(js));
// 地址必须**逐字照抄**：new URL() 会做归一化（默认端口、主机大小写、中文路径），
// 搬过去与用户填的不一致会让人以为"检测改了我的配置"。
ok('预填的地址由字符串切出、逐字保留（不用 new URL 重建）',
  /function buildJsonRequest\(template\)/.test(js) && /m\[1\] \+ m\[2\]/.test(js));
ok('弹窗支持 prefillNote（说明"这地址是哪来的"），没预填时与原来完全一样',
  /prefillNote/.test(reqModalSrc) && /\$\{prefillNote \?/.test(reqModalSrc));

// ── 「请求结构」弹窗里的「测试」按钮 ──
// 这一栏填的东西**除了保存没有别的验证手段**（地址拼错 / 占位符没填值 / 密钥不对 /
// 该用 POST 却填了 GET），都要等模型真去搜、在群里答不出话时才暴露。
// 「网页地址」那一栏早有「检测」按钮，这一栏一直没有（**实测反馈**）。
ok('弹窗里有「测试」按钮与结果区', /id="bqr-test"/.test(reqModalSrc) && /id="bqr-test-out"/.test(reqModalSrc));
ok('测试打的是专用端点 /api/search-bookmark/test-request',
  /\/api\/search-bookmark\/test-request/.test(reqModalSrc));
ok('测试把当前**行里的**配置一起送过去（请求头与静态参数都要带上）',
  /params: collectParams\(overlay\)/.test(reqModalSrc) && /textToHeaders\(\$\('#bqr-headers', overlay\)\.value\)/.test(reqModalSrc));
ok('测试按钮有 try/finally 复位，失败也能再点（与「检测」同一判据）',
  /finally \{[\s\S]{0,120}testBtn\.disabled = false;/.test(reqModalSrc));
ok('结论里回显实测细节与样本标题（只说"成功/失败"用户没法判断结果对不对）',
  /实测：\$\{detail\.join/.test(reqModalSrc) && /sampleTitles/.test(reqModalSrc));
// 测试查询词可自己指定
ok('弹窗里有「测试用的查询词」输入框，留空回落默认词',
  /id="bqr-test-query"/.test(reqModalSrc) && /placeholder="\$\{esc\(TEST_QUERY_DEFAULT\)\}"/.test(reqModalSrc));
ok('查询词随测试请求发给后端（后端已有 sampleQuery 参数）',
  /sampleQuery: rawQuery/.test(reqModalSrc));
ok('在查询词框里回车 = 点「测试」', /e\.key === 'Enter'[\s\S]{0,60}testBtn\.click\(\)/.test(reqModalSrc));
// ⚠️ 默认词是**两边各留一份字面量**（`ui/` 够不着 `dist/`，没有打包器也没有取值端点）。
// 漂移的表现是"提示说会用 A、实际发了 B"—— 这种不一致没人会去核对，所以钉住。
{
  const uiDefault = (/const TEST_QUERY_DEFAULT = '([^']+)'/.exec(reqModalSrc) || [])[1];
  // 路径跟着实现走：它已搬进 `media/web-search/`（写旧路径在陈 dist 下仍解析得到，
  // 于是搬家当场不红 —— 只有清空 dist 重建才炸）。
  const beDefault = (/export const TEST_QUERY_DEFAULT = '([^']+)'/.exec(readSrc('media/web-search/bookmark-request.js')) || [])[1];
  ok(`测试默认查询词前后端逐字一致（UI=${JSON.stringify(uiDefault)} / 后端=${JSON.stringify(beDefault)}）`,
    !!uiDefault && uiDefault === beDefault);
}

// ── 抓取正文长度是配置项：设置页 ↔ 保存 ↔ 后端钳制 三处口径必须一致 ──
// 判据是三段的**数字**要对得上（500 下限 / 200000 上限 / 默认值）。任何一段漂了，
// 表现都是"我填了 50000 却按别的数走"——用户不可能想到去比三处源码。
for (const [id, key, dflt] of [
  ['cfg-search-fetch-chars', 'fetchTextMaxChars', 20000],
  ['cfg-search-flatten-chars', 'flattenMaxChars', 4000]
]) {
  ok(`设置页有 ${id} 输入框（默认 ${dflt}）`,
    new RegExp(`id="${id}"[^>]*value="\\$\\{esc\\(c\\.webSearch\\?\\.${key} \\?\\? ${dflt}\\)\\}"`).test(sectionsSrc));
  ok(`保存时按 ${key} 写回并钳制（500–200000，回落 ${dflt}）`,
    new RegExp(`${key}: clampInt\\(\\$\\('#${id}'\\)\\?\\.value, 500, 200000, ${dflt}\\)`).test(js));
  ok(`后端对 ${key} 用同一组钳制（500–200000，回落 ${dflt}）`,
    new RegExp(`w\\.${key} = Math\\.round\\(clamp\\(w\\.${key}, 500, 200000, ${dflt}\\)\\)`).test(readSrc('core/config.js')));
}

// ⚠️ **渲染也必须把请求结构写进 dataset** —— 这是"刷新后还能看到已配的请求结构"的唯一途径。
// 初版只有弹窗会写它、渲染从不写，于是刷新后行上没有该属性，弹窗一打开就是空的
// （**实测反馈**）；更糟的是此时再点「保存设置」（哪怕只改了别的行），这一行的请求结构
// 会被当成"没配"而从配置里删除，**静默丢数据**。渲染是回显的唯一真相来源。
ok('渲染把请求结构写进 dataset（否则刷新后弹窗为空 + 再保存会丢数据）',
  /data-bm-req-json="\$\{jsonAttr\(request\)\}"/.test(sectionsSrc)
  && /data-bm-params-json="\$\{jsonAttr\(params\)\}"/.test(sectionsSrc));
ok('属性值经过 esc 转义（JSON 里的引号不转义会把 HTML 撑坏）',
  /const jsonAttr = \(value\) => \{[\s\S]{0,400}return esc\(text\);/.test(sectionsSrc));
// 第二道防线：dataset 万一缺了，回退到服务端当前那一份，别静默删掉用户的配置
ok('save.js 有兜底：dataset 缺请求结构时回退到服务端当前值（防静默丢数据）',
  /const originalByKey = new Map\(/.test(searchSave) && /prevItem\?\.request/.test(searchSave));
// **独立的密钥区已经删掉了**：密钥改走「静态参数」（请求头里写 `{API Key}`，参数里填值）。
// 一条机制覆盖"固定参数"与"密钥"，不必再有一套独立的落盘/脱敏/回显规则。
// 这条断言是防回潮的：那套 UI 一旦长回来，就会与静态参数形成两套实现。
ok('不再有独立的接口密钥配置区（已并入静态参数）',
  !/data-bmc|search-credentials-body|renderCredentialRows/.test(js) && !/credentials/.test(searchSave));
ok('配置层也不再有 credentials 键（并有显式 delete 迁移，避免旧键永远留着）',
  !/credentials:/.test(readSrc('core/config.js')) && /delete w\.credentials;/.test(readSrc('core/config.js')));

// 自动检测按钮：必须有 try/finally 复位 disabled，否则一次失败就永久点不动
ok('「检测」按钮绑了 click 且跑完会复位 disabled',
  /closest\('\[data-bm-probe\]'\)/.test(js) && /\.finally\(\(\) => \{ probeBtn\.disabled = false; \}\)/.test(js));
// 检测请求：**必须同时带上 searchUrl**，后端的"填了就只测这一个"全靠它。
// 只发 hint 的话后端拿不到"用户已填"这个事实，会退化成"拿他的输入当线索去猜别的" ——
// 那正是要修掉的旧行为（点完检测，框里的地址被悄悄换掉）。
// 合并成一栏之后，`site` 还得是**域名**（后端拿它做 URL 校验与找入口），所以要拆开发。
ok('检测请求带上 searchUrl，且 site 拆成域名（合并那一栏带来的额外一步）',
  /api\('\/api\/search-bookmark\/probe', \{ method: 'POST', body: JSON\.stringify\(\{ site, hint, searchUrl: filled\.includes\('\{q\}'\) \? filled : '' \}\) \}\)/.test(js)
  && /new URL\(filled\)\.hostname/.test(js));
ok('填了地址时提示语说的是"测试你填的"，空着时说的是"自动查找"（两种行为对用户可见）',
  /测试你填的地址/.test(js) && /正在自动查找/.test(js));
// 检测出的类名**只在有值时才覆盖**：检测不出类名不代表用户原来填的是错的
ok('检测出的 resultClass 只在有值时才写入（不覆盖用户手填的值）',
  /if \(clsInput && res\.resultClass\) clsInput\.value = res\.resultClass;/.test(js));
ok('检测结果就地显示在按钮下方（不用去别处找结论）',
  /row\?\.querySelector\('\[data-bm-status\]'\)/.test(js));
// 可选列的**空值必须整键不写**（而不是写空串）。写空串会让后端拿到一个"存在但无意义"
// 的值，而 bookmarkList() 按"非空才带"处理 —— 两处口径不同时，配置页显示有值、
// 运行期当没有，正是那种查半天的问题。
// 「站内搜索地址」与「网页地址」合并成一栏之后，这一条变成"含 `{q}` 才写 searchUrl"：
// 判据必须与后端 `normalizeConfigShape` 逐字同形。
ok('合并那一栏：含 {q} 才写 searchUrl（空值仍不写键）',
  /if \(\/\^https\?:\\\/\\\/\/i\.test\(input\) && input\.includes\('\{q\}'\)\) item\.searchUrl = input;/.test(searchSave));
ok('可选列空值时不写键（避免"存在但无意义"的空串）',
  /if \(resultClass\) item\.resultClass = resultClass;/.test(searchSave));
ok('保存分支按行读三列（缺一列那一条就丢）',
  /querySelector\('\[data-bm-key\]'\)/.test(searchSave)
  && /querySelector\('\[data-bm-url\]'\)/.test(searchSave)
  && /querySelector\('\[data-bm-purpose\]'\)/.test(searchSave));
// 过滤判据：**有用途、或填了搜索模板、或配了请求结构**都保留。
// 不能退回"三空就丢" —— 后端对"只配了请求结构/模板、用途还空着"的条目是收的
// （那是迁移来的老数据，丢掉等于删用户的收藏），前端先丢会让它静默消失。
ok('保存过滤与后端同形（只配了请求结构/模板的条目也保留）',
  /\.filter\(\(item\) => item\.key && item\.url && \(item\.purpose \|\| item\.searchUrl \|\| item\.request\)\)/.test(searchSave));
// ⚠️ 这条**偏离**了原来的"前端不做域名归一"约定，是合并那一栏带来的：
// 一个 input 里可能填域名、也可能填带 `{q}` 的整条地址，而 `url` 必须存域名
// （它是提示词里给模型看的站点，也是拼 `site:` 的依据）。所以前端必须从输入里取出域名。
// 枚举值校验（isBookmarkKey）仍然只在 core/config.ts —— 那一半没动。
ok('前端只做"从合并输入里取域名"，不重复实现枚举值校验',
  !/isBookmarkKey/.test(stripComments(searchSave)) && !/replace\(\/\^\[\^a-z0-9_\]\//.test(stripComments(searchSave)));
ok('收藏夹增删走 DOM 操作 + 事件委托（不重渲染整页，否则会冲掉未保存的其它输入）',
  /add-search-bookmark-btn'\)\?\.addEventListener\('click'/.test(js)
  && /search-bookmarks-body'\)\?\.addEventListener\('click'/.test(js)
  && /closest\('\[data-bm-del\]'\)/.test(js));
// 废弃的旧键**不得**再出现在面板里：它会由后端迁移成 bookmarkMode，前端若还写回一个
// 废弃键，那个键就会永远留在用户的 config.json 里当一个没人读的旋钮。
ok('废弃的 bookmarkFirst 复选框已从面板移除',
  !/cfg-search-bookmarkfirst/.test(js), '面板里仍有旧键控件');
ok('搜索保存分支生成 patch.webSearch', /patch\.webSearch = \{/.test(searchSave));
// 前端**不做**域名归一化：唯一实现在 core/config.ts 的 hostnameOf。前端再写一份必然漂移，
// 而两边规则不一致时"用户看到的名单"与"实际参与检索的名单"会不一样。
// ⚠️ 必须 stripComments 后再扫：这条断言的靶子是**注释里那个词**（上面几行就写着
// "hostnameOf"），不剥注释会永远假红 —— 反向的坑（一句注释把已删的调用伪装成还在用）
// 在 t-ports.mjs 第 2 段踩过，判据是"扫有没有 X"和"扫还有没有人在用 X"都要剥。
const searchSaveCode = stripComments(searchSave);
ok('前端不重复实现域名归一化（剥 scheme/路径只由后端做）',
  !/replace\(\/\^https\?/.test(searchSaveCode) && !/hostname/.test(searchSaveCode));
ok('阀门两个数值都走 clampInt，且与后端钳制口径一致（1-200 / 1-5000）',
  /maxCallsPerChatPerHour: clampInt\([^\n]+, 1, 200, 20\)/.test(searchSave)
  && /maxCallsPerDay: clampInt\([^\n]+, 1, 5000, 200\)/.test(searchSave));
ok('收藏夹默认行为由下拉框决定，且只接受两个档位之一',
  /bookmarkMode: val\('#cfg-search-bookmarkmode'[^\n]*===\s*'web'\s*\?\s*'web'\s*:\s*'prefer'/.test(searchSave),
  '脏值会被钳成 prefer，不能让运行期拿到一个两条路都不走的字符串');
// 只在**代码**里查：上面那行注释刻意解释了"旧键不再写入"，不剥注释会永远假红
ok('保存分支不再写废弃的 bookmarkFirst', !/bookmarkFirst/.test(stripComments(searchSave)));
// 动态列表不能随表单提交被覆盖（这条是既有的有意设计，本次新增字段不得把它挤掉）
ok('自定义搜索服务列表仍不被表单覆盖', /providers: c\.webSearch\?\.providers \|\| \[\]/.test(searchSave));

// Yandex 抓公开页面：没有 Key，只有地址与四个选择器。**四个选择器都必须能在设置页改** ——
// 这是这条链唯一的自救通路（Yandex 会改页面结构，SearXNG 的同名引擎 2021 年因此被删除）。
// 任何一栏漏出模板，用户在页面改版时就没有恢复手段，而症状是"搜索永远没结果"。
for (const id of ['cfg-yandex-baseurl', 'cfg-yandex-serp', 'cfg-yandex-url', 'cfg-yandex-title', 'cfg-yandex-text']) {
  ok(`#${id} 已加入设置模板`, new RegExp(`id="${id}"`).test(js));
  ok(`#${id} 可解析`, resolves(id));
}
ok('搜索提供方下拉里有 yandex 选项', /<option value="yandex"/.test(js));
// Yandex 的选择器有两组（各自成 field-row），显隐必须把两组都覆盖到。
// 判据写成"两个 id 都出现在同一个遍历数组里"，而不是各查一次 `$('#…')` ——
// 实现是 `for (const sel of [...]) $(sel)` 的数组驱动写法，按字面查两次会假红。
ok('Yandex 的两组选择器都纳入了显隐切换',
  /for \(const sel of \['#yandex-selector-fields', '#yandex-selector-fields2'\]\)/.test(js));
ok('Yandex 保存分支生成 patch.webSearch.yandex 且五个字段齐全',
  /yandex: \{/.test(searchSave)
  && /baseUrl: val\('#cfg-yandex-baseurl'/.test(searchSave)
  && /serpClass: val\('#cfg-yandex-serp'/.test(searchSave)
  && /urlClass: val\('#cfg-yandex-url'/.test(searchSave)
  && /titleClass: val\('#cfg-yandex-title'/.test(searchSave)
  && /textClass: val\('#cfg-yandex-text'/.test(searchSave));
// 空输入框必须回落到可用值：留空会让 `new URL('')` 抛错、这条路静默不可用
ok('Yandex 每个字段都有非空兜底（清空输入框不会把这条路弄坏）',
  !/val\('#cfg-yandex-\w+',\s*c\.webSearch\?\.yandex\?\.[\w]+\)/.test(searchSave));

const REGIONS = {
  '表情包页': stickerJs,
  '存档页': chatJs,
  '记忆详情': memoryJs,
  // 顶部「历史印象」块自己读一串 id（骨架建在 renderChatMessages 里，这里读的是它），
  // 单独切一段才扫得到。
  '历史印象块': chatJs,
  // 分群设置接线读的是「聊天设置」模板里渲出来的那批控件
  '历史摘要分群接线': segmentOf(settingsJs, '// ── 分群「历史摘要」', '// ── 屏蔽名单 ──')
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
ok('agent-runner 把活 session 传给提示词构建器（否则实际历史条数永远无法回写）',
  /buildUserPrompt\(\{[\s\S]{0,500}?memory: host\.memory,\s*\n\s*session,/.test(agentRunnerTs));
ok('存在 chatVisibleMessages()', /function chatVisibleMessages\(\)/.test(js));
ok('滚动加载按过滤后的长度判断', /const total = chatVisibleMessages\(\)\.length;/.test(js),
  '若用 state.chatMessages.length，搜索态下会永远以为"后面还有"');
ok('表格填充用过滤后的列表',
  /const newestFirst = chatVisibleMessages\(\);\r?\n  \/\/ 有查找词时/.test(js));
ok('过滤态一次性显示全部命中（分页账目才不会和"匹配 K 条"打架）',
  /state\.chatMsgLimit = String\(state\.chatQuery \|\| ''\)\.trim\(\)/.test(js));
ok('排序缓存仍按引用记忆（没被改成每次重排）', /chatMsgSortCache\.src !== src/.test(js));
ok('每行渲染出 改 / 删 两个操作', /data-op="edit"/.test(js) && /data-op="del"/.test(js));
// 「不给改」的三种 kind 由同一个判断守着：摘要 + 两种机器任务结果。
// 分别断言各自的禁用理由文案，删掉任何一支都会红。
const noEditGuard = /const ops = \(isDigest \|\| isTranscript/.test(js);
ok('摘要行不给"改"（后端也会 400，前端不该给个点了报错的按钮）',
  noEditGuard && js.includes('摘要由模型生成，不能手改'));
ok('转写结果行同样不给"改"（面板的「改」走的是插人工备注那条路，会把机器正文悄悄变成手写批注）',
  noEditGuard && js.includes('转写结果由任务生成，不能手改') && /const isTranscript = m\.kind === 'transcript'/.test(js));
ok('漫画完成回调同样不给"改"，并有独立 kind 判定',
  noEditGuard && js.includes('漫画下载结果由任务生成，不能手改')
  && /const isJmcomicResult = m\.kind === 'jmcomic-result'/.test(js));
ok('出图结果同样不给"改"，并有独立 kind 判定',
  noEditGuard && js.includes('出图结果由任务生成，不能手改')
  && /const isImageResult = m\.kind === 'image-result'/.test(js));
ok('摘要行仍然给"删"（后端 DELETE 不拦摘要，只拦 PATCH）',
  /\+ '<button class="btn btn-small btn-danger" data-op="del"/.test(js)
  && !/title="摘要由模型生成，不能手改；可以删除"/.test(js));
ok('删除确认里不把摘要/备注/转写结果说成"我"发的（senderName 为空串）',
  /const who = m\.kind === 'digest' \? '摘要'/.test(js)
  && /m\.kind === 'transcript' \? '转写'/.test(js)
  && !/m\.senderName \|\| '我'\}:\\n/.test(js));
ok('对人工备注不谎称"原文可能仍在冷归档"（它从没收发过）', /if \(m\.kind !== 'note'\) warn \+= '· 消息原文/.test(js));
ok('删摘要时换成"下次压缩会重新生成"的说法', /m\.kind === 'digest'\s*\n?\s*\? '· 这是压缩摘要/.test(js));
ok('操作走事件委托（轮询会换掉 tbody 的 innerHTML）',
  /\$\('#chat-msg-body'\)\.addEventListener\('click'/.test(js) && !/\.ops.*addEventListener/.test(js));
ok('切换会话时清空查找词', /state\.chatQuery = '';/.test(js));
ok('备注行有独立样式 .note-row', css.includes('.archive-table .note-row'));
ok('转写结果行有独立样式 .transcript-row', css.includes('.archive-table .transcript-row'));
ok('漫画完成回调行有独立样式 .jmcomic-result-row', css.includes('.archive-table .jmcomic-result-row'));
ok('出图结果行有独立样式 .image-result-row', css.includes('.archive-table .image-result-row'));

// ── 会话日志的横向滚动 ──
// 这条链有**两层**，缺哪层都是"横向滚动条一根都不出现"，且都不报任何错：
//   ① 根因层：`.view` 是 row flex 的子项，`min-width` 默认 `auto` = 内容最小宽度，
//      所以一行折不了的长内容会把 `.view` → `.detail-pane` 整条链撑宽，而
//      `body { overflow: hidden }` 把多出来的部分静默裁掉 —— 里面所有 `overflow-x`
//      都**永远等不到溢出**。**实测**（Electron 自带 Chromium，1280 窗口）：600 字符的
//      token 让 `.detail-pane` 从 960px 撑到 4558px、四块日志的滚动条全是 0px；
//      补上 `min-width: 0` 后同样的夹具立刻给出 11~12px 的滚动条、面板回到 960px。
//   ② 声明层：这几块是 `pre-wrap`（自然语言照常软换行）**加** `overflow-x`，不是二选一。
// ⚠️ 这里的断言**只能证明声明存在**，证明不了它生效（被后续规则覆盖同样红不了）。
//    布局本身要靠真浏览器量，重做办法：造一个只含这些块的静态页 + 一个 Electron
//    BrowserWindow，量 `scrollWidth > clientWidth` 与 `offsetHeight - clientHeight - 边框`。
//    正因如此，① 那行（光看声明完全无从判断的根因）必须由下面第一条断言钉住。
ok('.view 有 min-width: 0（flex 子项默认 auto 会被长内容撑宽 → 面板里所有 overflow-x 失效）',
  /\.view \{[^}]*min-width:\s*0/.test(css));
for (const sel of ['.collapsible .coll-body', '.tool-args', '.tool-result', '.bubble', '.sent-badge', '.session-error']) {
  const esc2 = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  ok(`${sel} 有 overflow-x: auto（否则长行被截、看不到后半截）`,
    new RegExp(`${esc2}[^{]*\\{[^}]*overflow-x:\\s*auto`, 's').test(css));
}
// `.sent-badge` 是 flex 子项、宽度按 max-content 算，**光有 overflow-x 是空转的**
// （实测：仍是 4499px、0px 滚动条），必须同时把盒子压回容器宽度。
ok('.sent-badge 有 max-width: 100%（缺了它，上面那条 overflow-x 永远不生效）',
  /\.sent-badge \{[^}]*max-width:\s*100%/.test(css));
ok('横向滚动**没有**用 `white-space: pre` 换掉软换行（那会让普通文本长到没法读）',
  /\.collapsible \.coll-body \{[^}]*white-space:\s*pre-wrap/.test(css));

console.log('\n═══ 历史摘要：设置项 ↔ 接线 ↔ 保存分支 ═══');
// 一、顶部块：刷新钩子挂对了地方
ok('顶部块的刷新挂在 updateChatMessagesBody 末尾（轮询/SSE/查找/翻页都汇到这里）',
  /updateChatMessagesMeta\(newestFirst\);\r?\n(?:.*\r?\n)*?\s+updateChatDigestBlock\(\);/.test(js));
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
ok('「注入时合并摘要展示」开关默认勾上', /id="cfg-digest-merge" \$\{c\.digest\?\.merge !== false \? 'checked' : ''\}/.test(js)
  && js.includes('注入时合并摘要展示'));
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
ok('每分钟发送频率只有一个设置入口', /id="cfg-maxpermin"/.test(js)
  && !js.includes('cfg-reply-maxpermin'));
ok('响应档位保存只提交滑条事实源，不提交派生字段', /contextSliderPos:/.test(saveSeg)
  && !/\bcontextTier:/.test(saveSeg) && !/\brandomPercent:/.test(saveSeg));
ok('历史深度只有一个独立设置，旧四套输入已删除', /id="cfg-history-count"/.test(js)
  && /historyCount: clampInt\(val\('#cfg-history-count'/.test(saveSeg)
  && !/cfg-(?:atcount|kwcount|randcount|allcount)/.test(js));
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

console.log('\n═══ 三处手动删除与两处存储上限的接线 ═══');
// 三个按钮分别落在三个视图里，且都必须**先确认再删** —— 它们都是不可撤销的数据删除。
{
  const fsMod = await import('node:fs');
  const pathMod = await import('node:path');
  const root = pathMod.resolve(import.meta.dirname, '..');
  const read = (p) => fsMod.readFileSync(pathMod.join(root, p), 'utf8');
  const sessions = read('ui/js/views/sessions.js');
  const chats = read('ui/js/views/chats.js');
  const memory = read('ui/js/views/memory.js');
  const chatSettings = read('ui/js/parts/chat-settings.js');
  const save = read('ui/js/views/settings/save.js');

  // ① 会话页：单条删除
  ok('会话列表每行有删除按钮', /data-del-session="\$\{s\.id\}"/.test(sessions));
  ok('删除按钮 stopPropagation（不做就会被同行的"选中"事件抢走，看起来点了没反应）',
    /event\.stopPropagation\(\)/.test(sessions));
  ok('删会话前先 confirm，并说清只删这次运行的记录、不动存档与记忆',
    /确定删除这条会话记录/.test(sessions) && /不影响消息存档和记忆/.test(sessions));
  ok('删的是当前正在看的那条时，右侧详情也一起清掉（否则留着一份已不存在的会话）',
    /state\.currentSessionId === id/.test(sessions));

  // ② 存档页：整个会话的存档
  ok('存档页有"清空本会话存档"按钮', /id="chat-clear-btn"/.test(chats));
  ok('清空存档的确认里点名会删掉冷归档（archive）——只删主文件的话原文会留在磁盘上',
    /冷归档（archive）/.test(chats));
  ok('清空存档的确认里说明会留一份备份', /自动留一份最近一次的备份/.test(chats));
  ok('清空存档走 DELETE /api/chats/<key>', /api\(`\/api\/chats\/\$\{key\.replace\(':', '_'\)\}`, \{ method: 'DELETE' \}\)/.test(chats));

  // ③ 记忆页：整个会话的记忆
  ok('记忆页有"清空本会话记忆"按钮', /id="mem-clear-all-btn"/.test(memory));
  ok('清空记忆的确认里给出群友数与印象数（让人知道自己要删掉多少）',
    /个群友的 \$\{total\} 条印象/.test(memory));
  ok('清空记忆的确认里点明粒度区别、并指向成员级的「删」',
    /全部记忆/.test(memory) && /用那个人那一行的「删」按钮/.test(memory));
  ok('清空记忆走 DELETE /api/memory-files/<key>（不是成员级那条）',
    /api\(`\/api\/memory-files\/\$\{chatKey\.replace\(':', '_'\)\}`, \{ method: 'DELETE' \}\)/.test(memory));

  // ④ 删除后**列表与详情都刷新**（用户明确要求）。只刷列表的话右侧会继续显示
  //    那个已经不存在的会话/存档/记忆，看起来就是"删了没反应"。
  ok('清空存档后同时刷新列表与详情',
    /await loadChats\(\{ quiet: true \}\)[\s\S]{0,200}await loadChatMessages\(state\.currentChatKey/.test(chats));
  ok('删会话后列表刷新，并在仍有选中项时补刷详情',
    /await loadSessions\(\{ quiet: true \}\)[\s\S]{0,300}loadSessionDetail\(state\.currentSessionId, \{ quiet: true \}\)/.test(sessions));
  ok('删会话/清空存档后，若那个会话已不在列表里就清掉选中并复位详情面板',
    /state\.currentSessionId = null[\s\S]{0,400}选择左侧会话查看完整过程/.test(sessions)
    && /state\.currentChatKey = null[\s\S]{0,400}选择会话查看消息存档/.test(chats));
  ok('清空记忆后同时刷新列表与详情',
    /await loadMemoryView\(\)[\s\S]{0,200}loadMemoryDetail\(state\.currentMemoryChatKey\)/.test(memory));

  // ⑤ 新建会话入口：两个页签各一个按钮，指向同一个弹窗与同一个接口
  const newChat = read('ui/js/parts/new-chat.js');
  const html = read('ui/index.html');
  const main = read('ui/js/main.js');
  ok('存档页与记忆页各有一个「新建会话」按钮',
    /id="chat-new-btn"/.test(html) && /id="memory-new-btn"/.test(html));
  ok('两个按钮都接到同一个弹窗（从哪一页进去结果一样）',
    /for \(const id of \['#chat-new-btn', '#memory-new-btn'\]\)/.test(main) && /openNewChatModal/.test(main));
  ok('弹窗走 POST /api/chats/<key> 且一次建出两份',
    /api\(`\/api\/chats\/\$\{chatKey\.replace\(':', '_'\)\}`, \{ method: 'POST'/.test(newChat));
  ok('弹窗里说明了会建出空存档与空记忆、且不覆盖已有内容',
    /空存档/.test(newChat) && /空记忆/.test(newChat) && /已经存在的不会被覆盖/.test(newChat));
  ok('号码在前端只做"纯数字"的提示性校验（唯一判据仍在服务端）',
    /\^\\d\+\$\/\.test\(id\)/.test(newChat) && /服务端仍会独立校验/.test(newChat));
  ok('拉群/好友列表失败时不阻塞创建（仍能手填号码）',
    /也可以直接手填号码/.test(newChat));

  // ④ 两个存储上限的配置项：输入框与保存读取必须成对出现
  //    —— 只有 save 没有 input 的话，`val()` 取到 undefined 会**静默回退成当前值**，
  //    用户改了没反应却看不到任何报错。
  for (const [id, key] of [['cfg-maxmsgs-perchat', 'maxMessagesPerChat'], ['cfg-keepsessionfiles', 'keepSessionFiles']]) {
    ok(`存储上限 ${key}：输入框与保存读取都在`,
      chatSettings.includes(`id="${id}"`) && save.includes(`val('#${id}'`),
      `input=${chatSettings.includes(`id="${id}"`)} save=${save.includes(`val('#${id}'`)}`);
  }
  ok('存档上限的 hint 说清它与"动态上下文窗口"的区别（磁盘 vs token）',
    /磁盘上的存档上限/.test(chatSettings) && /一次运行读多少条/.test(chatSettings));
  ok('会话记录上限的 hint 说清它不影响存档与记忆',
    /不影响消息存档和记忆/.test(chatSettings));
}

console.log('\n═══ 扩展能力：设置页 ↔ 保存 ↔ 后端钳制 ═══');
// 与上面「网页收藏夹」那几条同型：这条链的失败形态是"设置页改了没反应"，或者
// "界面按一个数走、后端按另一个数走"，而**两边都不会报错**。所以钉三件事：
// 控件成对存在、开关的 id 两端同形、两个数字的钳制口径前后端一致。
const extrasSectionSrc = (() => {
  const src = readUI('js/views/settings/sections.js');
  const at = src.indexOf('export function renderExtrasSection');
  if (at < 0) return '';
  const end = src.indexOf('\nexport function ', at + 10);
  return end < 0 ? src.slice(at) : src.slice(at, end);
})();
const extrasSave = seg("if (sec === 'extras')", "if (sec === 'transcription')");

ok('设置侧栏有「扩展能力」入口并接到渲染函数',
  /\['extras', '扩展能力'\]/.test(js) && /extras: \(\) => renderExtrasSection\(c\)/.test(js));
ok('区块渲染出两个数字输入框', /id="cfg-extras-idle-sec"/.test(extrasSectionSrc) && /id="cfg-extras-maxloads"/.test(extrasSectionSrc));
// 只列"标题（id）"是不够的：管理员看不出这个扩展是干什么的。描述来自 `/api/extras`
// 的 `description`（它**不是**模型看到的那段工具描述，见 src/extra/types.ts），
// 而两端有一端漏了都**不会报错** —— 面板只是少一行字。
ok('每一行渲染了 title、id 与给人看的 description',
  /\$\{esc\(item\.title\)\}/.test(extrasSectionSrc)
  && /\$\{esc\(item\.id\)\}/.test(extrasSectionSrc)
  && /\$\{esc\(item\.description\)\}/.test(extrasSectionSrc));
// 只有 input 没有 save 时，`val()` 取到 undefined 会**静默回退成当前值** —— 用户改了没反应，且不报错。
ok('保存分支真的读了这两个输入框', /#cfg-extras-idle-sec/.test(extrasSave) && /#cfg-extras-maxloads/.test(extrasSave));
// 每个扩展一个开关：渲染写 `data-extra-id`，保存按同一个属性收集。两端不同形的话，
// 开关会"保存了但其实没写进去"，或者写到了别的 id 上。
ok('扩展开关的 id 两端同形（渲染写 data-extra-id，保存按 data-extra-id 收集）',
  /data-extra-id=/.test(extrasSectionSrc) && /\[data-extra-id\]/.test(extrasSave));
// "改动需重启"是这条设计知情的代价（工具表是请求前缀的一部分）。只写在源码注释里不够 ——
// 用户看到的是一个点一下就生效的开关，不说清就是仓库最忌讳的"填了、看着生效、实际用的是别的"。
ok('界面上写明了开关改动需要重启', /需要重启/.test(extrasSectionSrc));

// 钳制口径：设置页按**秒**、后端按**毫秒**，所以不能逐字比字符串 —— 比换算后的值。
const uiIdleSec = Number((/clampInt\(val\('#cfg-extras-idle-sec',\s*\d+\),\s*0,\s*(\d+),/.exec(extrasSave) || [])[1]);
const beIdleExpr = (/e\.idleUnloadMs = Math\.round\(clamp\(e\.idleUnloadMs,\s*0,\s*([^,]+),/.exec(readSrc('core/config.js')) || [])[1];
const beIdleMs = beIdleExpr ? Function(`return (${beIdleExpr});`)() : NaN;
ok('空闲卸载的上限：设置页（秒）×1000 与后端（毫秒）指的是同一个值',
  Number.isFinite(uiIdleSec) && Number.isFinite(beIdleMs) && uiIdleSec * 1000 === beIdleMs,
  `设置页 ${uiIdleSec}s → ${uiIdleSec * 1000}ms，后端 ${beIdleMs}ms`);
const uiLoads = (/clampInt\(val\('#cfg-extras-maxloads',\s*\d+\),\s*(\d+),\s*(\d+),\s*(\d+)\)/.exec(extrasSave) || []).slice(1).join(',');
// 后端那一段是源码里的写法（`1, 200, 20`，带空格），逐字比会因空格假红 —— 去掉空白再比。
const beLoads = ((/e\.maxLoadsPerHour = Math\.round\(clamp\(e\.maxLoadsPerHour,\s*([^)]+)\)\);/.exec(readSrc('core/config.js')) || [])[1] || '').replace(/\s+/g, '');
ok('每小时装载上限的钳制：设置页与后端是同一组数',
  uiLoads.length > 0 && beLoads === uiLoads, `设置页 ${uiLoads}，后端 ${beLoads}`);
// 注册表只能经端点出来（ui/ 够不着 src/），所以这个端点不存在的话整个区块会一直是空的。
ok('后端有 /api/extras 端点且已注册进路由表',
  /\/api\/extras/.test(readSrc('web/routes/extras.js')) && /extrasRoutes/.test(readSrc('web/routes/index.js')));

console.log('\n═══ SSE 事件名：发射端与订阅端必须同名 ═══');
// 两边分居两层两种写法（`src/core/events.ts` 是 TS 常量表，`ui/js` 是裸字符串），
// 改名时最容易只改一边：帧照发、面板却再也不刷新，而且**不会报任何错**。
// S4 拆 'status' 时的真实风险就是这个，所以在这里做一次跨边界比对。
// （发射端不许出现字面量由 t-events.mjs 守，这边只管"订阅的名字得有出处"。）
const eventsTs = fs.readFileSync(path.join(process.cwd(), 'src/core/events.ts'), 'utf8');
const eventNames = [...eventsTs.matchAll(/^\s+\w+: '([\w-]+)',?$/gm)].map((m) => m[1]);
const subscribed = [...js.matchAll(/es\.addEventListener\('([\w-]+)'/g)].map((m) => m[1]);
const unknownEvents = [...new Set(subscribed)].filter((n) => !eventNames.includes(n));
ok('UI 订阅的每个事件名都在 core/events.ts 的词表里',
  eventNames.length > 0 && unknownEvents.length === 0,
  unknownEvents.length
    ? `${unknownEvents.join('、')} 不在 EVENTS 里 → 发射端改了名而订阅端没跟上，或拼错了`
    : `词表里一个名字都没解析出来（长度 ${eventNames.length}）`);
ok("S4 拆出的两个名字 UI 都订上了：config-applied / orchestrator-pause",
  subscribed.includes('config-applied') && subscribed.includes('orchestrator-pause'));
ok("旧的 'status' 事件名订阅端已不再出现", !subscribed.includes('status'));

// ── 跑团工作台（剧本与规则表的列表 + 删除） ────────────────────────────────
//
// 用户明确划的界是"面板只能删，不能编辑、不能上传"，所以这一节钉两件事：
// 那一栏真的挂上了，以及**删除是破坏性动作、必须先说清再动手**。
// ⚠️ 这些是**源码文本**断言（`ui/` 是浏览器原生 ES Module，套件跑不了它）—— 它们证明接线在，
// 证明不了点下去真的对。
{
  const sectionsSrc2 = readUI('js/views/settings/sections.js');
  ok('设置页导航里有「跑团」那一栏', /\['trpg', '跑团'\]/.test(settingsJs));
  ok('那一栏真的接到了渲染函数（导航项加了、section 没接是"点了没反应"的经典形态）',
    /trpg: \(\) => renderTrpgSection\(/.test(settingsJs)
    && /export function renderTrpgSection/.test(sectionsSrc2));
  ok('工作台只读列表 + 删除：**没有**编辑或上传的入口',
    /data-trpg-del=/.test(sectionsSrc2) && !/data-trpg-edit|data-trpg-upload/.test(sectionsSrc2));

  ok('删除按钮**先 confirm**（破坏性动作不能点一下就没了）',
    /if \(!confirm\(/.test(settingsJs) && /data-trpg-del/.test(settingsJs));
  ok('确认文案说清删的是什么 —— **三类各一句话**，不是笼统的"确定删除吗？"',
    /confirm: \(id\) => `删除剧本「\$\{id\}」/.test(settingsJs)
    && /confirm: \(id\) => `删除规则表「\$\{id\}」/.test(settingsJs)
    && /confirm: \(id\) => `删除战报「\$\{id\}」/.test(settingsJs));
  ok('剧本与规则表的确认文案都说清**正在跑的那一局不受影响**（否则没人敢点）',
    (settingsJs.match(/正在跑的那一局不受影响/g) ?? []).length >= 2,
    `${(settingsJs.match(/正在跑的那一局不受影响/g) ?? []).length} 处`);
  ok('战报那份说的是**相反**的话：删掉就没了（它是三类里唯一不可逆的 —— 另外两样都能再写一份出来）',
    /这一份删掉就没了/.test(settingsJs));
  ok('删完**重新拉一次**列表（只改内存里的 state 会让页面与服务端不一致）',
    /await loadSettings\(\)/.test(settingsJs));
  ok('坏文件在面板上**看得见问题**（跳过它只会让管理员看到"少了一个"）',
    /problems/.test(sectionsSrc2) && /item\.problems/.test(sectionsSrc2));
  ok('内置规则表在列表里标出来（可以删，但要看得出它是内置的）', /item\.builtin/.test(sectionsSrc2));
  // 战报（P6）是这一栏的**第三类**：数据来自同一个端点，行与删除按钮与另外两类同形。
  // 漏掉它的接线不会有任何报错，只是那一栏永远空着 —— 而"空着"与"还没有战报"在界面上一样。
  ok('战报那一栏真的挂上了（第三类，与剧本、规则表同形）',
    /data-trpg-row="journal"/.test(sectionsSrc2) && /data-trpg-del="journal"/.test(sectionsSrc2));
  ok('战报的取数与另外两类**同一个端点**，且失败时的兜底里也有 `journals`',
    /\/api\/trpg\/workshop/.test(settingsJs) && /journals: \[\]/.test(settingsJs),
    /\/api\/trpg\/workshop/.test(settingsJs) ? '兜底缺 journals' : '没接端点');
  ok('战报那一栏把"只追加"与"删掉就没了"写在明面上（那是它区别于另外两类的地方）',
    /只追加/.test(sectionsSrc2) && /删掉就没了/.test(sectionsSrc2));
}

console.log(`\n════ 通过 ${pass} / 失败 ${fail} ════`);
process.exit(fail === 0 ? 0 : 1);
