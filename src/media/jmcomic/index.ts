// 漫画能力的桶文件。
//
// 消费方一律 import `media/jmcomic/index.js`（**写全路径**，别依赖目录/index 的隐式解析 ——
// 那只是 `dist/` 里恰好有同名目录时才成立，而陈产物会让它看起来"能跑"）。逐个导出具名文件，
// 不 `export * from` 一个目录。

export * from './types.js';
export * from './commands.js';
export * from './search.js';
export * from './queue.js';


