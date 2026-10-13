// `/漫画 <漫画ID>` 命令的解析。
//
// 与 `/转写`、`/画` 同一个分工：**命令自己的语法留在领域模块里**，接入层的命令表
// （`web/onebot/slash-commands.ts`）只负责"认出是哪条命令、按什么顺序处理、回不回执"。

export function parseJmcomicCommand(text: unknown): string | null {
  const value = String(text ?? '').trim();
  const match = /^\/漫画(?:\s+([^\s]+))?$/u.exec(value);
  if (!match) return null;
  const id = String(match[1] || '').trim();
  if (!id) throw new Error('用法：/漫画 <漫画ID>');
  return id;
}

/** 搜索范围。与 Python 侧 `SEARCH_MODES` 的键一一对应。 */
