import path from 'node:path';
import cron, { type ScheduledTask } from 'node-cron';
import type { AppConfig } from '../../core/config.js';
import { DATA_DIR } from '../../core/paths.js';
import { fetchHotSearch, sanitizeHotSearchError } from './api-client.js';
import { normalizeHotSearchResponse } from './normalize.js';
import { dedupeHotSearchItems } from './dedupe.js';
import { formatHotSearchPages } from './formatter.js';
import { HotSearchStateStore } from './state-store.js';
import type {
  HotSearchPreview, HotSearchState, HotSearchStatusView, HotSearchTrigger
} from './types.js';

const TIMEZONE = 'Asia/Shanghai';
const DEFAULT_CRON = '0 9 * * *';

interface SchedulerDependencies {
  getConfig(): AppConfig;
  updateConfig(patch: Record<string, unknown>): AppConfig;
  sender: {
    sendTextBatch(chatKey: string, texts: string[]): Promise<unknown>;
  };
  log?: (...args: unknown[]) => void;
  stateStore?: HotSearchStateStore;
  fetchFeed?: typeof fetchHotSearch;
  now?: () => Date;
}

export interface HotSearchBroadcastResult extends HotSearchPreview {
  sentGroupIds: string[];
  skipped: boolean;
}

function uniqueNumericIds(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((value) => String(value).trim()).filter((value) => /^\d+$/.test(value)))];
}

export function resolveHotSearchApiKey(config: AppConfig): string {
  return String(config.hotSearchApiKey || process.env.HOT_SEARCH_API_KEY || '').trim();
}

export function validateDailyHotSearchCron(value: unknown): string {
  const expression = String(value || DEFAULT_CRON).trim().replace(/\s+/g, ' ');
  const match = expression.match(/^(\d{1,2}) (\d{1,2}) \* \* \*$/);
  if (!match || !cron.validate(expression)) throw new Error('Cron 必须是每日固定时间，格式为“分 时 * * *”');
  const minute = Number(match[1]);
  const hour = Number(match[2]);
  if (minute > 59 || hour > 23) throw new Error('Cron 中的小时或分钟超出范围');
  return expression;
}

function zonedParts(date: Date): { date: string; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '00';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    minutes: Number(get('hour')) * 60 + Number(get('minute'))
  };
}

function eligibleTargetGroups(config: AppConfig): string[] {
  const configured = uniqueNumericIds(config.hotSearchTargetGroupIds);
  const allow = new Set(uniqueNumericIds(config.allow?.groups));
  if (allow.size === 0 && config.allowAllWhenEmpty !== true) return [];
  return configured.filter((id) => allow.size === 0 || allow.has(id));
}

function messageMaxChars(config: AppConfig): number {
  const hard = Math.round(Number(config.send?.hardSplitAt) || 0);
  return hard > 0 ? Math.min(3_500, Math.max(500, hard)) : 3_500;
}

export class HotSearchScheduler {
  #deps: SchedulerDependencies;
  #stateStore: HotSearchStateStore;
  #task: ScheduledTask | null = null;
  #inFlight: Promise<unknown> | null = null;
  #stopped = true;

  constructor(deps: SchedulerDependencies) {
    this.#deps = deps;
    this.#stateStore = deps.stateStore ?? new HotSearchStateStore(path.join(DATA_DIR, 'hot-search-state.json'));
  }

  async start(): Promise<void> {
    this.#stopped = false;
    await this.refresh();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    const task = this.#task;
    this.#task = null;
    if (task) await task.destroy();
    if (this.#inFlight) await this.#inFlight.catch(() => undefined);
  }

  async refresh(): Promise<void> {
    const previous = this.#task;
    this.#task = null;
    if (previous) await previous.destroy();
    if (this.#stopped) return;

    const config = this.#deps.getConfig();
    if (config.hotSearchEnabled !== true || eligibleTargetGroups(config).length === 0) return;
    let expression: string;
    try { expression = validateDailyHotSearchCron(config.hotSearchCron); }
    catch (error) {
      this.#writeState({
        ...this.#stateStore.read(), status: 'failed', trigger: 'scheduled', updatedAt: this.#now().toISOString(),
        error: sanitizeHotSearchError(error)
      });
      return;
    }

    this.#recordMissedRun(expression);
    this.#task = cron.schedule(expression, async () => {
      try { await this.broadcast('scheduled'); }
      catch (error) { this.#deps.log?.('[hot-search] 定时播报失败:', sanitizeHotSearchError(error)); }
    }, {
      timezone: TIMEZONE,
      name: 'hot-search.daily-broadcast',
      noOverlap: true,
      unref: true
    });
  }

  status(): HotSearchStatusView {
    const config = this.#deps.getConfig();
    const state = this.#stateStore.read();
    const next = this.#task?.getNextRun() ?? null;
    return {
      ...state,
      lastSuccessDate: state.lastSuccessDate || config.hotSearchLastSuccessDate || undefined,
      enabled: config.hotSearchEnabled === true,
      cron: String(config.hotSearchCron || DEFAULT_CRON),
      timezone: TIMEZONE,
      configuredTargetCount: uniqueNumericIds(config.hotSearchTargetGroupIds).length,
      eligibleTargetCount: eligibleTargetGroups(config).length,
      hasApiKey: Boolean(resolveHotSearchApiKey(config)),
      scheduled: Boolean(this.#task),
      nextRunAt: next ? next.toISOString() : null,
      running: Boolean(this.#inFlight)
    };
  }

  preview(): Promise<HotSearchPreview> {
    return this.#exclusive(() => this.#prepare('preview'));
  }

  /**
   * 只取榜单，**不写任何状态**（供模型自主查询）。
   *
   * 不复用 `preview()`：它会把面板的"上次任务"刷成 `status=success / trigger=preview`，
   * 模型每查一次就盖掉一次真实播报记录。`lastSuccessDate` / `deliveryDate` 两处不受影响，
   * 所以播报幂等本身是安全的——被污染的只是给人看的那行状态。
   */
  readTopics(limit?: number): Promise<HotSearchPreview> {
    return this.#exclusive(() => this.#fetch(limit));
  }

  broadcast(trigger: Exclude<HotSearchTrigger, 'preview'> = 'manual'): Promise<HotSearchBroadcastResult> {
    return this.#exclusive(async () => {
      const config = this.#deps.getConfig();
      const today = zonedParts(this.#now()).date;
      const state = this.#stateStore.read();
      const lastSuccess = state.lastSuccessDate || config.hotSearchLastSuccessDate;
      if (lastSuccess === today) {
        if (trigger === 'scheduled') {
          return { generatedAt: undefined, itemCount: state.itemCount, pages: [], authMode: state.authMode ?? 'anonymous', sentGroupIds: [], skipped: true };
        }
        throw new Error(`今天（${today}）已经成功播报过，为避免重复发送，本次未执行`);
      }

      const targets = eligibleTargetGroups(config);
      if (!targets.length) throw new Error('没有合法的目标群：请先选择当前发送白名单内的群');
      const prepared = await this.#prepare(trigger);
      const currentState = this.#stateStore.read();
      const delivered = new Set(currentState.deliveryDate === today ? currentState.deliveredGroupIds : []);
      const pending = targets.filter((id) => !delivered.has(id));
      const failed: string[] = [];
      for (const groupId of pending) {
        try {
          const result = await this.#deps.sender.sendTextBatch(`group:${groupId}`, prepared.pages);
          if (Array.isArray((result as { failed?: unknown[] }).failed) && (result as { failed: unknown[] }).failed.length) {
            throw new Error('部分分页消息发送失败');
          }
          delivered.add(groupId);
          this.#writeState({
            ...this.#stateStore.read(),
            deliveryDate: today,
            deliveredGroupIds: [...delivered],
            targetCount: targets.length
          });
        } catch (error) {
          failed.push(`${groupId}：${sanitizeHotSearchError(error)}`);
        }
      }
      if (failed.length) {
        const summary = `部分目标群发送失败（${failed.length}/${targets.length}）：${failed.join('；')}`;
        this.#writeState({
          ...this.#stateStore.read(), status: 'failed', trigger, updatedAt: this.#now().toISOString(),
          itemCount: prepared.itemCount, targetCount: targets.length, error: summary.slice(0, 240), authMode: prepared.authMode
        });
        throw new Error(summary);
      }

      const success: HotSearchState = {
        ...this.#stateStore.read(),
        lastSuccessDate: today,
        deliveryDate: today,
        deliveredGroupIds: [...delivered],
        status: 'success',
        trigger,
        updatedAt: this.#now().toISOString(),
        itemCount: prepared.itemCount,
        targetCount: targets.length,
        error: undefined,
        authMode: prepared.authMode
      };
      this.#writeState(success);
      try { this.#deps.updateConfig({ hotSearchLastSuccessDate: today }); }
      catch (error) { this.#deps.log?.('[hot-search] 最近成功日期写回配置失败:', sanitizeHotSearchError(error)); }
      return { ...prepared, sentGroupIds: targets, skipped: false };
    });
  }

  async #prepare(trigger: HotSearchTrigger): Promise<HotSearchPreview> {
    const config = this.#deps.getConfig();
    const apiKey = resolveHotSearchApiKey(config);
    const authMode: HotSearchPreview['authMode'] = apiKey ? 'api-key' : 'anonymous';
    this.#writeState({
      ...this.#stateStore.read(), status: 'running', trigger, updatedAt: this.#now().toISOString(),
      error: undefined, authMode
    });
    try {
      const preview = await this.#fetch();
      if (trigger === 'preview') {
        this.#writeState({
          ...this.#stateStore.read(), status: 'success', trigger, updatedAt: this.#now().toISOString(),
          itemCount: preview.itemCount, targetCount: 0, error: undefined, authMode
        });
      }
      return preview;
    } catch (error) {
      this.#writeState({
        ...this.#stateStore.read(), status: 'failed', trigger, updatedAt: this.#now().toISOString(),
        itemCount: 0, targetCount: 0, error: sanitizeHotSearchError(error), authMode
      });
      throw error;
    }
  }

  /**
   * 取榜并排版这一段是纯的：**只有这一个地方**读接口，状态写入全在调用方。
   * `limitOverride` 让模型按需少要几条；越界与非法值都收敛回官方区间。
   */
  async #fetch(limitOverride?: number): Promise<HotSearchPreview> {
    const config = this.#deps.getConfig();
    const apiKey = resolveHotSearchApiKey(config);
    const requested = limitOverride === undefined ? Number(config.hotSearchItemLimit) || 10 : Number(limitOverride);
    const limit = Math.min(20, Math.max(3, Number.isFinite(requested) ? Math.round(requested) : 10));
    const payload = await (this.#deps.fetchFeed ?? fetchHotSearch)({
      apiKey,
      platformFilter: Array.isArray(config.hotSearchPlatformFilter) ? config.hotSearchPlatformFilter : [],
      limit
    }, { log: this.#deps.log });
    const feed = normalizeHotSearchResponse(payload);
    const topics = dedupeHotSearchItems(feed.items).slice(0, limit);
    // 这条同时给播报与"模型自主取榜"两条路用，所以措辞不能带播报口径（如"本次不发送"）。
    if (!topics.length) throw new Error('接口没有返回可用的热搜条目（榜单为空）');
    const pages = formatHotSearchPages(topics, {
      now: this.#now(), timezone: TIMEZONE, generatedAt: feed.generatedAt,
      includeLinks: config.hotSearchIncludeLinks === true,
      maxChars: messageMaxChars(config)
    });
    return { generatedAt: feed.generatedAt, itemCount: topics.length, pages, authMode: apiKey ? 'api-key' : 'anonymous' };
  }

  #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#inFlight) return Promise.reject(new Error('热搜任务正在运行，请稍后再试'));
    const running = operation().finally(() => {
      if (this.#inFlight === running) this.#inFlight = null;
    });
    this.#inFlight = running;
    return running;
  }

  #recordMissedRun(expression: string): void {
    const now = this.#now();
    const parts = zonedParts(now);
    const [minute, hour] = expression.split(' ').map(Number);
    const state = this.#stateStore.read();
    const scheduledToday = state.trigger === 'scheduled' && state.updatedAt
      && zonedParts(new Date(state.updatedAt)).date === parts.date;
    const lastSuccess = state.lastSuccessDate || this.#deps.getConfig().hotSearchLastSuccessDate;
    if (lastSuccess === parts.date || scheduledToday || parts.minutes <= hour * 60 + minute) return;
    this.#writeState({
      ...state,
      status: 'skipped',
      trigger: 'scheduled',
      updatedAt: now.toISOString(),
      error: '服务在今日计划时刻之后启动；按当前策略不补发，等待下一次计划',
      itemCount: 0,
      targetCount: eligibleTargetGroups(this.#deps.getConfig()).length
    });
  }

  #writeState(state: HotSearchState): void {
    this.#stateStore.write(state);
  }

  #now(): Date {
    return this.#deps.now?.() ?? new Date();
  }
}
