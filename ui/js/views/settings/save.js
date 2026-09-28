import { actions } from '../../actions.js';
import { api } from '../../api.js';
import { $, esc } from '../../dom.js';
import { state } from '../../state.js';
import { getThemePref } from '../../theme.js';
import { clampInt } from '../../parts/chat-settings.js';

export function parseList(s) {
  return String(s || '').split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean);
}

export async function saveConfig({ quiet = false } = {}) {
  const c = state.config;
  // 只在当前区块的元素存在时才读取，避免“每个区块保存时读取其他区块元素”导致的 null 报错。
  const el = (sel) => document.querySelector(sel);
  const val = (sel, fallback = '') => {
    const node = el(sel);
    return node ? node.value : fallback;
  };
  const chk = (sel, fallback = false) => {
    const node = el(sel);
    return node ? node.checked : fallback;
  };
  const sec = state.settingsSection || 'api';

  const patch = {};

  if (sec === 'memory') {
    patch.memory = {
      ...(c.memory || {}),
      consolidateEnabled: chk('#cfg-mem-consolidate', c.memory?.consolidateEnabled !== false),
      useChatModel: chk('#cfg-mem-usechat', c.memory?.useChatModel !== false),
      provider: val('#cfg-mem-provider', c.memory?.provider || '').trim(),
      model: val('#cfg-mem-model', c.memory?.model || '').trim(),
      consolidateMinIntervalMs: Number(val('#cfg-mem-interval', c.memory?.consolidateMinIntervalMs ?? 21600000)) || 21600000
    };
    // 聊天记录压缩。保存后由后端按 enabled 决定是否拉起/停掉巡检循环。
    patch.compact = {
      ...(c.compact || {}),
      enabled: chk('#cfg-compact-enabled', !!c.compact?.enabled),
      checkIntervalMs: clampInt(val('#cfg-compact-interval', c.compact?.checkIntervalMs), 300000, 86400000, 3600000),
      minIntervalMs: clampInt(val('#cfg-compact-cooldown', c.compact?.minIntervalMs), 600000, 2592000000, 86400000),
      maxChatsPerSweep: clampInt(val('#cfg-compact-chats', c.compact?.maxChatsPerSweep), 1, 10, 1),
      minMessagesToCompact: clampInt(val('#cfg-compact-minmsgs', c.compact?.minMessagesToCompact), 50, 100000, 800),
      // 下限钳到 100：它同时是记忆引擎的证据来源，设太小会让"发现新人"静默失灵
      keepRecentMessages: clampInt(val('#cfg-compact-keep', c.compact?.keepRecentMessages), 100, 100000, 300),
      maxMessagesPerRound: clampInt(val('#cfg-compact-perround', c.compact?.maxMessagesPerRound), 20, 5000, 400),
      maxContextChars: clampInt(val('#cfg-compact-chars', c.compact?.maxContextChars), 2000, 200000, 24000),
      compactMemory: chk('#cfg-compact-memory', c.compact?.compactMemory !== false)
    };
  }

  if (sec === 'api') {
    patch.api = {
      vision: chk('#cfg-vision', c.api.vision !== false),
      temperature: Number(val('#cfg-temperature', c.api.temperature)) || 0.8,
      maxRounds: Number(val('#cfg-maxrounds', c.api.maxRounds)) || 12,
      // 成本核算：官方价开关（走中转站时通常要关掉开关自己填）
      useOfficialPrice: chk('#cfg-useofficialprice', c.api.useOfficialPrice !== false),
      // 远程价格表 URL：留空 = 只用内置表
      priceRemoteUrl: val('#cfg-price-remote-url', c.api.priceRemoteUrl || '').trim(),
      // 全局兜底单价：仅当没有模型级价格时生效
      priceInputPerM: Number(val('#cfg-price-in', c.api.priceInputPerM ?? 0)) || 0,
      priceOutputPerM: Number(val('#cfg-price-out', c.api.priceOutputPerM ?? 0)) || 0,
      priceCachedPerM: Number(val('#cfg-price-cached', c.api.priceCachedPerM ?? 0)) || 0
    };
    // 把当前模型的单价存进 modelPrices[模型]（只影响这一个模型，不动内置官方表）。
    // 若开关是打开的，则不应写入 —— 那时输入框是禁用的，读到的值就是官方价，
    // 写进去会凭空产生一条自定义价。
    //
    // ⚠️ 模型名与开关状态都必须读**界面实时值**（c.api 是上次保存的旧值）：
    // 用户可能改了模型/开关但还没保存过，用旧值会把价格存到错误的模型名下。
    const curModel = String(($('#cfg-model')?.value ?? c.api?.model) || '').trim();
    const officialOn = ($('#cfg-useofficialprice')?.checked) ?? (c.api?.useOfficialPrice !== false);
    if (curModel) {
      const isLocked = officialOn;   // 锁定只跟开关绑定
      if (!isLocked) {
        const nextMap = { ...(c.api?.modelPrices || {}) };
        const i = Number(val('#cfg-price-in', 0)) || 0;
        const o = Number(val('#cfg-price-out', 0)) || 0;
        const ca = Number(val('#cfg-price-cached', 0)) || 0;
        if (i || o || ca) {
          nextMap[curModel] = { in: i, out: o, cached: ca || i };
        } else {
          delete nextMap[curModel];   // 全 0 = 清除自定义，回落到官方表
        }
        // 同样需要整体替换，否则 delete 掉的那一项会在合并时复活
        patch.api.modelPrices = { __replace__: nextMap };
      }
    }
    // 当前 API Key：只有用户在框里输入了非掩码的新值才走 /api/providers/set-key；
    // 掩码/留空都表示不改。
    const apiKeyInput = $('#cfg-apikey');
    const enteredApiKey = (apiKeyInput?.value || '').trim();
    if (enteredApiKey && enteredApiKey !== '******') {
      const pid = c.api?.provider;
      if (pid) {
        // 目录提供商的 Key 单独存（不能覆盖别的提供商的 Key）
        await api('/api/providers/set-key', {
          method: 'POST',
          body: JSON.stringify({ providerId: pid, apiKey: enteredApiKey })
        });
      } else {
        patch.api.apiKey = enteredApiKey;
      }
    }
  }

  if (sec === 'search') {
    // 搜索 API Key：****** = 保持原 Key 不变；明文或新输入才更新
    const enteredDsKey = val('#cfg-ds-searchkey', '').trim();
    const enteredZhipuKey = val('#cfg-zhipu-key', '').trim();
    const enteredBochaKey = val('#cfg-bocha-key', '').trim();
    const enteredBaiduKey = val('#cfg-baidu-key', '').trim();
    const enteredMetasoKey = val('#cfg-metaso-key', '').trim();
    patch.webSearch = {
      ...c.webSearch,
      enabled: chk('#cfg-websearch', c.webSearch?.enabled !== false),
      provider: val('#cfg-searchprovider', c.webSearch?.provider || 'bing'),
      searchUrl: val('#cfg-searchurl', c.webSearch?.searchUrl || 'https://cn.bing.com/search').trim() || 'https://cn.bing.com/search',
      deepseek: {
        ...(c.webSearch?.deepseek || {}),
        ...(enteredDsKey && enteredDsKey !== '******' ? { apiKey: enteredDsKey } : {}),
        model: val('#cfg-ds-searchmodel', c.webSearch?.deepseek?.model || 'deepseek-v4-flash').trim() || 'deepseek-v4-flash'
      },
      zhipu: {
        ...(c.webSearch?.zhipu || {}),
        ...(enteredZhipuKey && enteredZhipuKey !== '******' ? { apiKey: enteredZhipuKey } : {}),
        engine: val('#cfg-zhipu-engine', c.webSearch?.zhipu?.engine || 'search_std')
      },
      bocha: {
        ...(c.webSearch?.bocha || {}),
        ...(enteredBochaKey && enteredBochaKey !== '******' ? { apiKey: enteredBochaKey } : {})
      },
      baidu: {
        ...(c.webSearch?.baidu || {}),
        ...(enteredBaiduKey && enteredBaiduKey !== '******' ? { apiKey: enteredBaiduKey } : {})
      },
      metaso: {
        ...(c.webSearch?.metaso || {}),
        ...(enteredMetasoKey && enteredMetasoKey !== '******' ? { apiKey: enteredMetasoKey } : {})
      },
      // 自定义搜索服务走 webSearch.providers 数组（由「添加自定义搜索服务」按钮维护），
      // 不在这里随表单提交 —— 避免每次保存都把动态列表覆盖掉。
      providers: c.webSearch?.providers || []
    };
  }

  if (sec === 'image-source') {
    const old = c.imageSource || {};
    const key = val('#cfg-sauce-key', '').trim();
    patch.imageSource = {
      enabled: chk('#cfg-image-source-enabled', false),
      traceMoe: { enabled: chk('#cfg-trace-enabled', true), timeoutMs: Number(val('#cfg-trace-timeout', 15000)), minSimilarity: Number(val('#cfg-trace-similarity', 0.87)), maxResults: Number(val('#cfg-trace-results', 3)) },
      sauceNao: { ...(old.sauceNao || {}), enabled: chk('#cfg-sauce-enabled', true), timeoutMs: Number(val('#cfg-sauce-timeout', 20000)), minSimilarity: Number(val('#cfg-sauce-similarity', 0.8)), maxResults: Number(val('#cfg-sauce-results', 3)), ...(key && key !== '******' ? { apiKey: key } : {}) },
      maxImageBytes: Number(val('#cfg-image-source-max-mib', 8)) * 1048576,
      maxQueueLength: Number(val('#cfg-image-source-queue', 5)), totalTimeoutMs: Number(val('#cfg-image-source-total-timeout', 35000)),
      cacheEnabled: chk('#cfg-image-source-cache', true), cacheTtlMs: old.cacheTtlMs || 86400000
    };
  }

  if (sec === 'persona') {
    patch.persona = {
      botName: val('#cfg-botname', c.persona.botName).trim() || '小鲸鱼',
      selfNickname: val('#cfg-selfnick', c.persona.selfNickname || '').trim(),
      participation: val('#cfg-participation', c.persona.participation),
      roleText: val('#cfg-roletext', c.persona.roleText || ''),
      customRules: val('#cfg-customrules', c.persona.customRules || '')
    };
  }

  if (sec === 'allow') {
    patch.allow = {
      groups: parseList(val('#cfg-allowgroups', (c.allow?.groups || []).join(','))),
      private: parseList(val('#cfg-allowprivate', (c.allow?.private || []).join(',')))
    };
    patch.deny = { groups: [], private: [] };
    // 原先这里硬编码 false：只要点过保存就把该开关永久重置，
    // 而 UI 里根本没有输入控件 —— 只能手改 JSON，改完一保存就丢。改为读取复选框。
    const allowAllBox = $('#cfg-allowallwhenempty');
    patch.allowAllWhenEmpty = allowAllBox ? !!allowAllBox.checked : (c.allowAllWhenEmpty === true);
  }

  if (sec === 'hotsearch') {
    const enteredKey = val('#cfg-hotsearch-key', '').trim();
    const time = val('#cfg-hotsearch-time', '09:00');
    const match = time.match(/^(\d{2}):(\d{2})$/);
    const groups = [...(el('#cfg-hotsearch-groups')?.selectedOptions || [])].map((option) => option.value);
    const platforms = [...document.querySelectorAll('[data-hotsearch-platform]')]
      .filter((node) => node.checked)
      .map((node) => node.dataset.hotsearchPlatform);
    patch.hotSearchEnabled = chk('#cfg-hotsearch-enabled', c.hotSearchEnabled === true);
    patch.hotSearchCron = match ? `${Number(match[2])} ${Number(match[1])} * * *` : '0 9 * * *';
    patch.hotSearchTimezone = 'Asia/Shanghai';
    patch.hotSearchTargetGroupIds = groups;
    patch.hotSearchItemLimit = clampInt(val('#cfg-hotsearch-limit', c.hotSearchItemLimit), 3, 20, 10);
    patch.hotSearchPlatformFilter = platforms;
    patch.hotSearchIncludeLinks = chk('#cfg-hotsearch-links', c.hotSearchIncludeLinks === true);
    if (enteredKey && enteredKey !== '******') patch.hotSearchApiKey = enteredKey;
  }

  if (sec === 'transcription') {
    const t = c.transcription || {};
    const appId = val('#cfg-transcription-appid', t.appId || '').trim();
    if (appId && !/^\d+$/.test(appId)) throw new Error('腾讯云 AppID 必须为纯数字');
    const secretId = val('#cfg-transcription-secretid', '').trim();
    const secretKey = val('#cfg-transcription-secretkey', '').trim();
    patch.transcription = {
      enabled: t.enabledFromEnvironment ? t.enabled === true : chk('#cfg-transcription-enabled', t.enabled === true),
      appId,
      engineType: val('#cfg-transcription-engine', t.engineType || '16k_zh').trim() || '16k_zh',
      ffmpegPath: val('#cfg-transcription-ffmpeg', t.ffmpegPath || 'ffmpeg').trim() || 'ffmpeg',
      ffmpegTimeoutMs: clampInt(val('#cfg-transcription-ffmpeg-timeout', t.ffmpegTimeoutMs), 10000, 10800000, 900000),
      flashTimeoutMs: clampInt(val('#cfg-transcription-flash-timeout', t.flashTimeoutMs), 10000, 1800000, 300000),
      maxDurationSeconds: clampInt(val('#cfg-transcription-max-duration', t.maxDurationSeconds), 1, 7200, 7200),
      maxAudioBytes: clampInt(val('#cfg-transcription-max-audio-mib', Math.round(Number(t.maxAudioBytes || 104857600) / 1048576)), 1, 100, 100) * 1048576,
      maxSourceBytes: clampInt(val('#cfg-transcription-max-source-mib', Math.round(Number(t.maxSourceBytes || 268435456) / 1048576)), 1, 1024, 256) * 1048576,
      resultMaxChars: clampInt(val('#cfg-transcription-result-chars', t.resultMaxChars), 200, 4000, 3500),
      ...(secretId && secretId !== '******' ? { secretId } : {}),
      ...(secretKey && secretKey !== '******' ? { secretKey } : {})
    };
  }

  if (sec === 'chat') {
    patch.wakeDelayMs = Number(val('#cfg-wakedelay', c.wakeDelayMs)) || 2000;
    patch.drainDelayMs = Number(val('#cfg-draindelay', c.drainDelayMs)) || 1200;
    patch.maxConcurrentRuns = Number(val('#cfg-maxruns', c.maxConcurrentRuns)) || 2;
    patch.send = {
      ...c.send,
      minGapMs: Number(val('#cfg-mingap', c.send?.minGapMs)) || 1000,
      maxGapMs: Number(val('#cfg-maxgap', c.send?.maxGapMs)) || 3000,
      // 回退值必须与 config.js 的 DEFAULT_CONFIG.send.maxPerMinute 一致（80）
      maxPerMinute: Number(val('#cfg-maxpermin', c.send?.maxPerMinute)) || 80,
      maxPerHour: Number(val('#cfg-maxperhour', c.send?.maxPerHour)) || 500,
      byLengthMs: Number(val('#cfg-bylength', c.send?.byLengthMs)) || 20,
      hardSplitAt: Number(val('#cfg-hardsplit', c.send?.hardSplitAt)) || 0
    };
    patch.proactive = {
      ...c.proactive,
      enabled: chk('#cfg-proactive', !!c.proactive?.enabled),
      checkIntervalMinMs: Number(val('#cfg-pro-min', c.proactive?.checkIntervalMinMs)) || 1800000,
      checkIntervalMaxMs: Number(val('#cfg-pro-max', c.proactive?.checkIntervalMaxMs)) || 5400000,
      probability: Number(val('#cfg-pro-prob', c.proactive?.probability)) || 0.25
    };
    patch.sticker = {
      ...c.sticker,
      enabled: chk('#cfg-sticker', c.sticker?.enabled !== false),
      // 先取界面实时值（没这个控件时才退回已保存配置），再钳到 0~3
      encourage: Math.min(3, Math.max(0, Number(
        $('#cfg-sticker-encourage') ? $('#cfg-sticker-encourage').value : (c.sticker?.encourage ?? 1)
      ) || 0)),
      // 0 = 不限（与 digest.maxKeepChars 同一方向：默认绝不删用户数据）
      maxKeepCount: clampInt(val('#cfg-sticker-maxkeep', c.sticker?.maxKeepCount), 0, 5000, 0)
    };
    // 读取历史档位（替代原来的「最多条数 + 字符预算」两个固定值）
    patch.store = {
      ...(c.store || {}),
      // 滑条位置存下来，重开设置页能还原到用户拖动的位置
      contextSliderPos: (() => {
        const sl = $('#ctx-tier-slider');
        return sl ? Number(sl.value) : (c.store?.contextSliderPos ?? 95);
      })(),
      keywords: String($('#cfg-keywords')?.value || '')
        .split('\n').map((x) => x.trim()).filter(Boolean),
      historyCount: clampInt(val('#cfg-history-count', c.store?.historyCount), 0, 5000, 80),
      // 运行时动态上下文窗口（条）；0 = 不限。与 maxMessagesPerChat（存档留多少条）无关。
      maxContextMessages: clampInt(val('#cfg-maxctx', c.store?.maxContextMessages), 0, 5000, 0),
      promptContextMaxChars: clampInt(val('#cfg-prompt-context-maxchars', c.store?.promptContextMaxChars), 0, 1000000, 32000),
      // 统一开关 + 分群滑条表（__replace__：删掉的群设置要真删，深合并做不到）
      unifiedTier: chk('#cfg-unifiedtier', c.store?.unifiedTier !== false),
      groupSliderPos: {
        __replace__: (() => { try { return JSON.parse($('#tier-group-json')?.value || '{}'); } catch { return {}; } })()
      }
    };
    // 清掉已废弃的两个字段，避免残留配置误导后来读代码的人
    delete patch.store.pastStateLimit;
    delete patch.store.pastStateMaxChars;

    // 回复态节奏。发送频率统一由 send.maxPerMinute 管，这里只保留等待窗口与限频等待策略。
    // patch.reply 必须建在这个分支里 —— saveConfig 只提交当前 section 的键。
    patch.reply = {
      ...(c.reply || {}),
      maxWaitMs: clampInt(val('#cfg-reply-maxwait', c.reply?.maxWaitMs), 0, 3600000, 0),
      maxLimitWaitMs: clampInt(val('#cfg-reply-limitwait', c.reply?.maxLimitWaitMs), 0, 300000, 20000)
    };

    // 历史摘要注入（压缩产物的消费端）。注意它不是 store 的子项 —— 生成摘要是
    // compact 的事，怎么把摘要送进提示词是独立的一件事，定时压缩关着也要生效。
    patch.digest = {
      ...(c.digest || {}),
      injectEveryRound: chk('#cfg-digest-everyround', c.digest?.injectEveryRound === true),
      merge: chk('#cfg-digest-merge', c.digest?.merge !== false),
      // 0 = 不注入（不是"不限"，理由见设置页那段 hint）
      maxChars: clampInt(val('#cfg-digest-maxchars', c.digest?.maxChars), 0, 200000, 8000),
      // 摘要存档的字数上限（0 = 不限）。全局限定：不参与按群覆盖，
      // 上面那个 perChat 表里也不带它（它管磁盘占用）。
      maxKeepChars: clampInt(val('#cfg-digest-keepchars', c.digest?.maxKeepChars), 0, 200000, 0),
      unified: chk('#cfg-digest-unified', c.digest?.unified !== false),
      // 分群覆盖表。__replace__ 才能真删群设置（普通深合并删不掉键）——
      // 「清除该群的单独设置」正是靠它把键从 config.json 里抹掉。
      perChat: {
        __replace__: (() => { try { return JSON.parse($('#digest-group-json')?.value || '{}'); } catch { return {}; } })()
      }
    };
  }

  if (sec === 'desktop') {
    patch.server = {
      ...c.server,
      autoStart: chk('#cfg-autostart', !!c.server?.autoStart),
      closeToTray: chk('#cfg-closetray', c.server?.closeToTray !== false)
    };
    patch.ui = {
      ...(c.ui || {}),
      // 主题在点选项时就已应用并写入 localStorage，这里把它一并存到后端以便跨设备保留
      theme: getThemePref(),
      showVision: chk('#cfg-showvision', c.ui?.showVision !== false),
      refreshMs: Number(val('#cfg-refreshms', c.ui?.refreshMs ?? 15000)) || 15000
    };
    patch.memberNotes = {
      ...(c.memberNotes || {})
    };
  }

  if (sec === 'onebot') {
    patch.snowluma = {
      dir: val('#cfg-snowlumadir', c.snowluma?.dir || '').trim(),
      autoLaunch: chk('#cfg-snowlumalaunch', !!c.snowluma?.autoLaunch),
      wsUrl: val('#cfg-wsurl', c.snowluma?.wsUrl || '').trim(),
      httpUrl: val('#cfg-httpurl', c.snowluma?.httpUrl || '').trim(),
      accessToken: val('#cfg-obtoken', c.snowluma?.accessToken || '').trim(),
      httpAccessToken: val('#cfg-obhttptoken', c.snowluma?.httpAccessToken || '').trim()
    };
  }

  const data = await api('/api/config', { method: 'POST', body: JSON.stringify(patch) });
  state.config = data.config;
  if (!quiet) $('#model-label').textContent = `模型：${state.config.api.model || '未设置'}`;
  return data;
}

// ── 屏蔽名单 ──
// 左栏选白名单群聊，右栏拉取群成员逐个勾选；勾选 = 屏蔽。
// 弹窗内的改动只落在 pending 工作副本上，点「保存设置」才一次性 POST。
