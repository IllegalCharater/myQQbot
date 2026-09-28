import { getConfig } from '../../core/config.js';
import { listOfficialPrices, resolveOfficialPrice } from '../../llm/model-prices.js';
import { priceFeedStatus, refreshPriceFeed } from '../../llm/price-feed.js';
import { errorMessage } from '../http/http.js';
import type { Route } from '../types.js';

export const usageRoutes: Route[] = [
  {
    method: 'GET',
    path: '/api/usage/stats',
    async handle(ctx, _req, _match, url) {
      try {
        const range = String(url.searchParams.get('range') || url.searchParams.get('days') || '7');
        return { status: 200, body: { ok: true, ...ctx.buildUsageStats({ range }) } };
      } catch (error) {
        return { status: 500, body: { ok: false, error: errorMessage(error) } };
      }
    },
  },
  {
    method: 'GET',
    path: '/api/usage/breakdown',
    async handle(ctx, _req, _match, url) {
      try {
        const range = String(url.searchParams.get('range') || '7');
        const dim = String(url.searchParams.get('dim') || '');
        const key = String(url.searchParams.get('key') || '');
        const by = String(url.searchParams.get('by') || '');
        return { status: 200, body: { ok: true, ...ctx.buildUsageBreakdown({ range, dim, key, by }) } };
      } catch (error) {
        return { status: 500, body: { ok: false, error: errorMessage(error) } };
      }
    },
  },
  {
    method: 'GET',
    path: '/api/model-prices',
    async handle(_ctx, _req, _match, url) {
      const model = String(url.searchParams.get('model') || getConfig().api?.model || '');
      return {
        status: 200,
        body: { prices: listOfficialPrices(), current: resolveOfficialPrice(model), remote: priceFeedStatus() },
      };
    },
  },
  {
    method: 'POST',
    path: '/api/model-prices/refresh',
    async handle() {
      const state = await refreshPriceFeed(getConfig().api?.priceRemoteUrl || '');
      return {
        status: 200,
        body: {
          ok: state.ok,
          remote: state,
          prices: listOfficialPrices(),
          current: resolveOfficialPrice(getConfig().api?.model || ''),
        },
      };
    },
  },
];
