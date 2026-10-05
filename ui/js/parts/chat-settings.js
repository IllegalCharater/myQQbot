import { esc } from '../dom.js';
import { state } from '../state.js';

const STICKER_LEVELS = [
  [0, '0 · 不鼓励（只在很贴切时偶尔用）'],
  [1, '1 · 偶尔（合适时配一张）'],
  [2, '2 · 较积极（优先考虑配图）'],
  [3, '3 · 很积极（表情包爱好者）']
];

// 读取历史档位：名称与说明（档位制，累积生效）
/** 把输入钳制到 [min,max]，非法值退回 fallback。 */
/**
 * 取会话的群名（群聊才有）。
 * 群名由后端 /api/chats 附带（走 OneBot get_group_info，带缓存与超时保护），
 * 拿不到就返回空串 —— 调用方会自动退回只显示群号。
 */
export function chatNameOf(chatKey) {
  const c = (state.chats || []).find((x) => x.key === chatKey);
  return String(c?.chatName || '').trim();
}

/**
 * 会话标题：群名（群号） / 群 群号 / 私聊 号
 * 拿到群名时显示"群名（群号）"，既好认又能确认身份；拿不到就退回原来的"群 群号"。
 */
export function formatChatTitle(chatKey, name = '') {
  const m = /^group:(\d+)$/.exec(String(chatKey || ''));
  if (m) return name ? `${name}（${m[1]}）` : `群 ${m[1]}`;
  const p = /^private:(\d+)$/.exec(String(chatKey || ''));
  if (p) return name ? `${name}（${p[1]}）` : `私聊 ${p[1]}`;
  return String(chatKey || '');
}

export function clampInt(raw, min, max, fallback) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/*
 * 滑条换算（前端显示用）。
 *
 * ⚠️ 必须与 src/tier-slider.js 保持完全一致 —— 后端保存配置时会用它
 *    **重新权威换算**档位与概率，所以前端即使算错也不会影响实际行为；
 *    但两边不一致会让"界面显示的档位"和"实际生效的档位"对不上，造成困惑。
 *    这段映射是 UI 展示契约，保留在前端模块中以避免浏览器依赖后端源码。
 */
const TIER_SLIDER_BANDS = { tier1End: 10, tier2End: 20, tier3End: 90 };

export function sliderToTierUI(pos) {
  const b = TIER_SLIDER_BANDS;
  const raw = Number(pos);
  if (!Number.isFinite(raw)) return { tier: 4, randomPercent: 100 };
  const p = Math.min(100, Math.max(0, raw));
  if (p <= b.tier1End) return { tier: 1, randomPercent: 0 };
  if (p <= b.tier2End) return { tier: 2, randomPercent: 0 };
  if (p <= b.tier3End) {
    const pct = ((p - b.tier2End) / (b.tier3End - b.tier2End)) * 100;
    return { tier: 3, randomPercent: Math.round(pct * 10) / 10 };
  }
  return { tier: 4, randomPercent: 100 };
}

/** 已保存配置 → 滑条位置。旧配置由后端迁移，这里只读取唯一事实源。 */
export function sliderToTierUI_tierToSlider(st) {
  const saved = Number(st?.contextSliderPos);
  if (Number.isFinite(saved)) return Math.min(100, Math.max(0, saved));
  return 95;
}

/** 滑条位置 → 一句话说明（给用户的即时反馈）。 */
export function sliderDesc(pos) {
  const { tier, randomPercent } = sliderToTierUI(pos);
  if (tier === 1) return '<b>1 档 · 仅艾特</b>：只有被 @ 时才响应，其余消息标记已读、不调模型（最省）';
  if (tier === 2) return '<b>2 档 · +关键词</b>：被 @ 或命中关键词时响应';
  if (tier === 3) return `<b>3 档 · +随机</b>：被 @ / 关键词必响应；此外每批普通消息有 <b>${randomPercent}%</b> 概率响应`;
  return '<b>4 档 · 全响应</b>：任何消息都响应，且艾特/关键词/随机的判定全部失效';
}

const TIER_NAME = { 1: '仅艾特', 2: '+关键词', 3: '+随机', 4: '全响应' };
const TIER_HINT = {
  1: '只有被 @ 时才响应，其余消息标记已读、不调模型（最省 token）',
  2: '在 1 档基础上，命中关键词也响应',
  3: '在 2 档基础上，再按概率随机响应一些消息',
  4: '任何消息都响应（改造前的行为，最费 token）'
};

export function renderChatSection(c) {
  const st = c.store || {};
  // 滑条位置是唯一真相；档位与概率都由它派生（与后端 tier-slider.js 同一套规则）
  const sliderPos = sliderToTierUI_tierToSlider(st);
  const { tier: curTier, randomPercent: curPct } = sliderToTierUI(sliderPos);
  // 模板里要按各段占比画刻度条，这里简写成 B 供下方 ${B.xxx} 使用。
  // ⚠️ 这个别名不能删 —— 曾经漏掉它，导致模板里 B 未定义，
  //    整个 renderChatSection 抛 ReferenceError，聊天设置页直接打不开。
  const B = TIER_SLIDER_BANDS;
  return `
    <h3>运行节奏</h3>
    <div class="field-row">
      <div class="field"><label>立即回复时间（毫秒）—— 最后一条新消息之后等这么久没有新消息，就直接回复（原「防抖聚批窗口」）</label><input type="number" id="cfg-wakedelay" min="0" value="${esc(c.wakeDelayMs)}" /></div>
      <div class="field"><label>批次间隔（毫秒）—— 上轮结束到下轮处理的间隔</label><input type="number" id="cfg-draindelay" min="0" value="${esc(c.drainDelayMs)}" /></div>
      <div class="field"><label>同时处理几个会话</label><input type="number" id="cfg-maxruns" min="1" max="8" value="${esc(c.maxConcurrentRuns)}" /></div>
    </div>

    <h3>回复节奏（静默态 ↔ 回复态）</h3>
    <div class="hint" style="margin-bottom:8px">
      机器人判断"这批消息值得回应"之后进入<b>回复态</b>，运行结束即回到静默态。
      上面两个时间旋钮就是这段等待窗口：<b>立即回复时间</b>是尾沿防抖（每条新消息重新计时），
      <b>等待窗口硬上限</b>是不被重置的天花板 —— 群里连着刷屏时，靠它保证不会永远等下去。
    </div>
    <div class="field-row">
      <div class="field"><label>等待窗口硬上限（毫秒，0 = 不限）</label><input type="number" id="cfg-reply-maxwait" min="0" step="500" value="${esc(c.reply?.maxWaitMs ?? 0)}" /></div>
      <div class="field"><label>命中分钟限频时最多等待（毫秒，0 = 直接报错）</label><input type="number" id="cfg-reply-limitwait" min="0" step="1000" value="${esc(c.reply?.maxLimitWaitMs ?? 20000)}" /></div>
    </div>
    <div class="hint">
      硬上限填 0（不限）时行为与从前完全一致：每条新消息都把计时器重置满，连发不停就一直不触发。<br />
      所有状态统一使用下方“每分钟最多发送”。回复态命中该上限时默认“停一下再发”（最多等 20 秒）而不是直接报错 —— 报错会让那条消息被丢掉，
      真人撞到自己的打字速度上限时做的正是等一会儿。
    </div>

    <h3>发送保护</h3>
    <div class="field-row">
      <div class="field"><label>相邻消息最小间隔（毫秒）</label><input type="number" id="cfg-mingap" min="200" value="${esc(c.send.minGapMs)}" /></div>
      <div class="field"><label>最大间隔（毫秒）</label><input type="number" id="cfg-maxgap" min="500" value="${esc(c.send.maxGapMs)}" /></div>
      <div class="field"><label>每分钟最多发送（统一上限）</label><input type="number" id="cfg-maxpermin" min="1" value="${esc(c.send.maxPerMinute)}" /></div>
    </div>
    <div class="field-row">
      <div class="field"><label>每小时最多发送</label><input type="number" id="cfg-maxperhour" min="1" value="${esc(c.send.maxPerHour ?? 500)}" /></div>
      <div class="field"><label>按字数附加间隔（毫秒/字）</label><input type="number" id="cfg-bylength" min="0" value="${esc(c.send.byLengthMs ?? 20)}" /></div>
      <div class="field"><label>QQ 硬限制切分长度（0 = 不切）</label><input type="number" id="cfg-hardsplit" min="0" value="${esc(c.send.hardSplitAt ?? 4000)}" /></div>
    </div>

    <h3>主动开话题</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-proactive" ${c.proactive.enabled ? 'checked' : ''} />
      <label for="cfg-proactive">冷场时按概率主动开话题</label></div>
    <div class="field-row">
      <div class="field"><label>检查间隔下限（毫秒）</label><input type="number" id="cfg-pro-min" min="60000" value="${esc(c.proactive.checkIntervalMinMs)}" /></div>
      <div class="field"><label>检查间隔上限（毫秒）</label><input type="number" id="cfg-pro-max" min="120000" value="${esc(c.proactive.checkIntervalMaxMs)}" /></div>
      <div class="field"><label>触发概率 0~1</label><input type="number" id="cfg-pro-prob" step="0.05" min="0" max="1" value="${esc(c.proactive.probability)}" /></div>
    </div>

    <h3>表情包</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-sticker" ${c.sticker.enabled ? 'checked' : ''} />
      <label for="cfg-sticker">启用表情包（收藏表情同步 + 发送工具）</label></div>

    <div class="field">
      <label>发表情包的积极程度</label>
      <select id="cfg-sticker-encourage">
        ${STICKER_LEVELS.map(([v, label], i) =>
    `<option value="${v}" ${Number(c.sticker?.encourage ?? 1) === v ? 'selected' : ''}>${esc(label)}</option>`
  ).join('')}
      </select>
      <div class="hint">
        这是"引导"不是"强制"，模型仍会自行判断什么时机合适。
      </div>
    </div>

    <div class="field">
      <label>bot 收藏上限（个）</label>
      <input type="number" id="cfg-sticker-maxkeep" min="0" max="5000" step="10"
             value="${esc(c.sticker?.maxKeepCount ?? 0)}" />
      <div class="hint">
        只数 <b>bot 自己收藏的</b>（QQ 收藏不算进这个数，也删不掉）；<b>0 = 不限</b>。<br />
        超上限时在「新收藏一个」的时候才整理：按使用频率最低、保存时间最早整条删掉。<br />
        所以把数字调小<b>不会</b>立刻删东西，要等下一次收藏。<br />
        这一项同时管着本地缓存图片的占用 —— 条目被删，它在 data/sticker-cache/ 里的图一起删。
      </div>
    </div>

    <h3>响应档位</h3>

    <div class="checkbox-row"><input type="checkbox" id="cfg-unifiedtier" ${st.unifiedTier !== false ? 'checked' : ''} />
      <label for="cfg-unifiedtier">统一设置全部响应档位（关掉就能给每个白名单群聊单独拖档位）</label></div>

    <!-- 统一模式：一个滑条管所有会话（原行为） -->
    <div id="tier-unified-wrap"${st.unifiedTier === false ? ' style="display:none"' : ''}>
    <div class="tier-slider-wrap">
      <input type="range" id="ctx-tier-slider" class="tier-slider"
             min="0" max="100" step="0.5" value="${esc(sliderPos)}"
             aria-label="响应档位滑条" />
      <div class="tier-scale" id="tier-scale">
        <span class="tier-seg seg1${curTier === 1 ? ' on' : ''}" data-seg="1" style="flex:${B.tier1End}">仅艾特</span>
        <span class="tier-seg seg2${curTier === 2 ? ' on' : ''}" data-seg="2" style="flex:${B.tier2End - B.tier1End}">+关键词</span>
        <span class="tier-seg seg3${curTier === 3 ? ' on' : ''}" data-seg="3" style="flex:${B.tier3End - B.tier2End}">+随机（概率递增）</span>
        <span class="tier-seg seg4${curTier === 4 ? ' on' : ''}" data-seg="4" style="flex:${100 - B.tier3End}">全响应</span>
      </div>
    </div>

    <div class="hint" id="ctx-tier-note" style="margin-top:8px">${sliderDesc(sliderPos)}</div>
    </div>

    <!-- 分群模式：下拉选群，各拖各的。滑条实时值是 DOM，切换群时先收进隐藏 JSON 再换 -->
    <div id="tier-pergroup-wrap"${st.unifiedTier === false ? '' : ' style="display:none"'}>
      <div class="field"><label>选择要单独设置的群聊（来自白名单）</label>
        <select id="tier-group-select"></select>
      </div>
      <input type="hidden" id="tier-group-json" value="${esc(JSON.stringify(st.groupSliderPos || {}))}" />
      <div class="tier-slider-wrap">
        <input type="range" id="ctx-tier-slider-g" class="tier-slider"
               min="0" max="100" step="0.5" value="${esc(sliderPos)}"
               aria-label="该群响应档位滑条" />
        <div class="tier-scale" id="tier-scale-g">
          <span class="tier-seg seg1" data-seg="1" style="flex:${B.tier1End}">仅艾特</span>
          <span class="tier-seg seg2" data-seg="2" style="flex:${B.tier2End - B.tier1End}">+关键词</span>
          <span class="tier-seg seg3" data-seg="3" style="flex:${B.tier3End - B.tier2End}">+随机（概率递增）</span>
          <span class="tier-seg seg4" data-seg="4" style="flex:${100 - B.tier3End}">全响应</span>
        </div>
      </div>
      <div class="hint" id="ctx-tier-note-g" style="margin-top:8px"></div>
      <div style="margin-top:8px;display:flex;gap:8px;align-items:center">
        <button class="btn btn-small btn-danger" id="tier-group-clear-btn">清除该群的单独设置</button>
        <span class="hint" style="margin:0">没单独设置过的群聊和所有私聊，跟随上方统一档位的滑条位置。</span>
      </div>
    </div>

    <div class="tier-params">
      <div class="tier-param">
        <label>响应关键词（每行一个，不区分大小写）</label>
        <textarea id="cfg-keywords" rows="3" placeholder="小鲸鱼&#10;bot">${esc((st.keywords || []).join('\n'))}</textarea>
        <div class="hint">只影响“是否响应”，不会改变历史读取长度。</div>
      </div>
      <div class="tier-param">
        <label>历史消息深度：读取当前窗口之前最近 <input type="number" id="cfg-history-count" min="0" max="5000" value="${esc(st.historyCount ?? 80)}" /> 条（0 = 不读取历史）</label>
        <div class="hint">这一项完全独立于艾特、关键词、随机概率和响应档位；只控制【过去状态】。</div>
      </div>
      <div class="tier-param">
        <label>动态上下文窗口：一次运行时最多把 <input type="number" id="cfg-maxctx" min="0" max="5000" value="${esc(st.maxContextMessages ?? 0)}" /> 条未读放进【本次唤醒】（0 = 不限）</label>
        <div class="hint">
          每个会话常驻一个只装对方消息的窗口，消息一到就入窗、超出立刻丢最老，所以它看到的聊天<b>一直是最新的</b>。
          与上面的"发未读 + N 条已读"是两回事：那些管<b>读多少历史</b>，这个管<b>一次运行读多少新消息</b>。
          长时间离线或被 @ 唤醒时可能一次积压几百条，靠它兜住 token。
          超出时丢最老的几条 —— 它们不会消失，只是降级成【过去状态】候选（仍受历史深度和字符预算限制），模型会被告知折走了多少条；
          而且它们<b>照样参与"要不要回应"的判定</b>（积压里的 @ 不会被漏掉），改动即时生效、不用重启。
        </div>
      </div>
      <div class="tier-param">
        <label>单次提示词统一字符预算：<input type="number" id="cfg-prompt-context-maxchars" min="0" max="1000000" value="${esc(st.promptContextMaxChars ?? 32000)}" /> 字（0 = 不限）</label>
        <div class="hint">预算覆盖完整 user prompt；【本次唤醒】和本轮决策不会被裁剪。超出时依次收缩表情目录、历史摘要、长期记忆和窗口外的已读历史。</div>
      </div>
      <div class="tier-param">
        <label>单个会话最多保留 <input type="number" id="cfg-maxmsgs-perchat" min="0" max="1000000" value="${esc(st.maxMessagesPerChat ?? 0)}" /> 条存档（0 = 不限）</label>
        <div class="hint">
          这是<b>磁盘上的存档上限</b>，与上面那个"动态上下文窗口"是两件事：那个管<b>一次运行读多少条</b>（token），这个管<b>存档留多少条</b>（占多少磁盘）。
          超限时每次写入都会丢掉最老的那几条，<b>丢掉的不可恢复</b>；机器人自己的发言、摘要和人工备注都算在里面。
          长期运行的群存档只增不减，留着 0 会一直涨；要清理已有的存量，去「消息存档」页用「清空本会话存档」。
        </div>
      </div>
      <div class="tier-param">
        <label>最多保留 <input type="number" id="cfg-keepsessionfiles" min="0" max="100000" value="${esc(st.keepSessionFiles ?? 0)}" /> 个会话记录文件（0 = 不限）</label>
        <div class="hint">
          会话记录是每次运行的过程留档（请求/响应），在「会话」页看。超过这个数量时自动删掉最老的。
          <b>它不影响消息存档和记忆</b>——删掉的只是"那次运行的过程"。想立刻清某一条，去「会话」页点那一行的 ×。
        </div>
      </div>
    </div>

    <h3>历史摘要</h3>
    <div class="hint" style="margin-bottom:8px">
      聊天记录被压缩后会留下一条摘要（工具条上的「立即压缩历史」、或定时压缩）。这一段管的是
      <b>摘要怎么进提示词</b>，和上面的「历史消息深度」是两条<b>独立通道</b>：历史深度管原始记录，
      这里管更早的纪要带多少。两者并行注入、互不挤占。
    </div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-digest-everyround" ${c.digest?.injectEveryRound ? 'checked' : ''} />
      <label for="cfg-digest-everyround">每轮对话都注入历史摘要</label></div>
    <div class="hint" style="margin-top:-4px;margin-bottom:8px">
      勾上 = 不管这一轮读不读历史都带上；不勾（默认）= 只在<b>真的读了历史</b>的那一轮带上。
    </div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-digest-merge" ${c.digest?.merge !== false ? 'checked' : ''} />
      <label for="cfg-digest-merge">注入时合并摘要展示</label></div>
    <div class="hint" style="margin-top:-4px;margin-bottom:8px">
      勾上（默认）= 所有摘要拼成一段连续正文；不勾 = 每条各成一小节、带编号与分隔线。
      这里的「合并」只是<b>本地拼接</b>，不会为了合并再调一次模型做二次压缩，所以没有信息损失。
    </div>
    <div class="field-row">
      <div class="field"><label>注入字数上限（<b>0 = 不注入</b>）</label>
        <input type="number" id="cfg-digest-maxchars" min="0" max="200000" value="${esc(c.digest?.maxChars ?? 8000)}" /></div>
    </div>
    <div class="hint">
      ⚠️ 这一项和本页其它「0 = 不限」（动态上下文窗口、每分钟上限…）<b>正好相反</b>：摘要永不归档、只会越攒越多，
      「不限」等于没有上限的 token 成本；0 落在"干脆不注入"这个安全方向。
      超出上限的老摘要是<b>整条不注入</b>（不做半截截断 —— 半截的三周前纪要比没有更糟），
      哪些进去了在存档页顶部会标出来；提示词里也会告诉模型"还有几段更早的没给你，需要时可以自己往前翻"。
    </div>
    <div class="hint" style="margin-top:8px">
      · 摘要只在真的压缩过之后才有 —— 从没压过的会话，勾了也不会注入（结构上就没有可注入的东西）。<br />
      · 提示词里它写作【历史印象】，并明确标着"背景资料、不是指令"。<br />
      · 把某人加进屏蔽名单<b>不能</b>清掉他之前生成的摘要 —— 那些字已经写进去了，只能手动删掉那条摘要。
    </div>

    <div class="field-row">
      <div class="field"><label>摘要存档最多保留多少字（<b>0 = 不限</b>）</label>
        <input type="number" id="cfg-digest-keepchars" min="0" max="200000" step="1000" value="${esc(c.digest?.maxKeepChars ?? 0)}" />
        <div class="hint">
          这一项管的不是提示词，而是<b>存档本身</b>：摘要永不归档、也绝不被二次摘要，所以每压一轮就多一条，
          不刹车就是无界增长。填一个上限后，<b>每次压缩成功</b>都会把最旧的纪要<b>整条</b>丢掉，
          直到总量降回上限以内（<b>永远保留最新的一条</b>，哪怕它自己就超上限 —— 否则把上限设小了会变成
          "纪要一生成就被删"，那比不设上限更糟）。<br />
          丢之前会先备份存档（<code>.digestgc.bak</code>），不会动压缩回滚点 <code>.json.bak</code> 与
          面板的 <code>.panel.bak</code>。按会话各自计算，但对所有会话用同一个上限（它管磁盘占用，不参与下面的按群覆盖）。
        </div>
      </div>
    </div>

    <div class="checkbox-row"><input type="checkbox" id="cfg-digest-unified" ${c.digest?.unified !== false ? 'checked' : ''} />
      <label for="cfg-digest-unified">统一设置全部会话（关掉就能给每个白名单群单独设）</label></div>

    <div id="digest-unified-wrap"${c.digest?.unified === false ? ' style="display:none"' : ''}>
      <div class="hint">所有会话（含私聊）都用上面这三个值。</div>
    </div>

    <!-- 分群模式：下拉选群，各设各的。唯一真相是隐藏 JSON，控件值切换群时先收进 JSON 再换 -->
    <div id="digest-pergroup-wrap"${c.digest?.unified === false ? '' : ' style="display:none"'}>
      <div class="field"><label>选择要单独设置的群聊（来自白名单）</label>
        <select id="digest-group-select"></select>
      </div>
      <input type="hidden" id="digest-group-json" value="${esc(JSON.stringify(c.digest?.perChat || {}))}" />
      <div class="checkbox-row"><input type="checkbox" id="cfg-digest-everyround-g" />
        <label for="cfg-digest-everyround-g">每轮对话都注入历史摘要</label></div>
      <div class="checkbox-row"><input type="checkbox" id="cfg-digest-merge-g" />
        <label for="cfg-digest-merge-g">注入时合并摘要展示</label></div>
      <div class="field-row">
        <div class="field"><label>注入字数上限（0 = 不注入）</label>
          <input type="number" id="cfg-digest-maxchars-g" min="0" max="200000" /></div>
      </div>
      <div class="hint" id="digest-group-note"></div>
      <div style="margin-top:8px;display:flex;gap:8px;align-items:center">
        <button class="btn btn-small btn-danger" id="digest-group-clear-btn">清除该群的单独设置</button>
        <span class="hint" style="margin:0">没单独设置过的群聊和所有私聊，跟随上面的统一设置。</span>
      </div>
    </div>

    <h3>屏蔽名单</h3>
    <div class="field">
      <button class="btn btn-small" id="blocklist-btn">管理屏蔽名单</button>
      <div class="hint" style="margin-top:6px">被屏蔽群员的消息不会存档、不会触发回复，也不会作为聊天背景发给模型。机器人自己的发言不受影响。</div>
    </div>`;
}
