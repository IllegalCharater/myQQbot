// 查询词清洗。单独一个文件是因为它被**两条**互不相关的路用：工具入参（`webSearch`）
// 与 provider 入参。挂在哪一边都会让另一边反向引用。

/** 查询词清洗：去 CQ 码、控制字符、超长截断。 */
export function sanitizeQuery(query: unknown): string {
  return String(query ?? '')
    .replace(/\[CQ:[^\]]*\]/gi, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}
