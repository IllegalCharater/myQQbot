import type { IncomingMessage } from 'node:http';
import type { AppContext, HttpMethod, Reply, Route, RouteMatch } from './types.js';

const METHODS = new Set<HttpMethod>(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

export function asHttpMethod(value: string | undefined): HttpMethod | null {
  return METHODS.has(value as HttpMethod) ? value as HttpMethod : null;
}

export function matchRoute(routes: readonly Route[], method: string | undefined, pathname: string): RouteMatch | null {
  const normalized = asHttpMethod(method);
  if (!normalized) return null;
  for (const route of routes) {
    if (route.method !== normalized) continue;
    if (typeof route.path === 'string') {
      if (route.path === pathname) return { route, match: null };
      continue;
    }
    route.path.lastIndex = 0;
    const match = route.path.exec(pathname);
    if (match) return { route, match };
  }
  return null;
}

export async function dispatchRoute(routes: readonly Route[], ctx: AppContext, req: IncomingMessage, url: URL): Promise<Reply | null> {
  const found = matchRoute(routes, req.method, url.pathname);
  return found ? found.route.handle(ctx, req, found.match, url) : null;
}
