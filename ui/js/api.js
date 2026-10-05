export const CONSOLE_MARKER = 'qq-agent-console';

export async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(path, {
      headers: { 'content-type': 'application/json', 'x-console-token': CONSOLE_MARKER, ...(options.headers || {}) },
      ...options
    });
  } catch (cause) {
    // 浏览器的 `TypeError: Failed to fetch` 只说"请求没拿到响应"，不说为什么 ——
    // 对用户（以及排查的人）等于没说。这里换成一句能指向下一步的话，
    // 并**保留原始信息**：连接被拒 / 隧道断了 / 服务重启，排查方向完全不同。
    // 注意不要把异常吞掉后当成"操作成功"：调用方仍需按失败处理。
    throw new Error(`连不上管理端（${cause && cause.message ? cause.message : cause}）。`
      + '检查机器人是否还在运行、面板端口是否可达，然后重试。');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}
