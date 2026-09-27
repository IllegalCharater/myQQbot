export const CONSOLE_MARKER = 'qq-agent-console';

export async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json', 'x-console-token': CONSOLE_MARKER, ...(options.headers || {}) },
    ...options
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}
