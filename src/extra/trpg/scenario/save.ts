// 抽取结果 → 落进剧本库（从 `scenario.ts` 拆出，2026-10-16）。
//
// ⚠️ **"字节 → 文本"这一步不在这里**，它由通用能力 `media/document/` 做（而且要起 Python
// 子进程）。这一层刻意保持**同步、纯**（同 `scenario/parse.ts`），于是它能在不启动任何
// 解释器的前提下被测。分开的判据是"**要不要碰外部世界**"：写盘要（在 store 里）、解字节不要。
//
// 剧本因此可以直接传 `.pdf` / `.docx`。**判断"这是不是规定格式"也不在这里**（那是
// `isFormattedScenario` 的事，而且它的答案决定接下来要不要走 `scenario/format.ts` 那次模型调用）——
// 本函数只管一件事：把一份**已经确定能解析**的正文写进去。
import type { DocumentText } from '../../../media/document/index.js';
import type { ScenarioLookup } from './parse.js';
// ⚠️ **类型导入**（不是值导入）：`store/scenario-store.ts` 反过来要 import `./parse.js`，
// 值导入会让这两个文件成环。这里只需要那个类的形状，`import type` 在编译后消失。
import type { ScenarioStore } from '../store/scenario-store.js';

/** 写一份剧本（名字即 id）。`doc` 是抽取器给的文本。 */
export function saveScenarioText(name: string, doc: DocumentText, store: ScenarioStore): ScenarioLookup {
  // 抽取器会按自己的上限截断。**截断过的正文必须当场拒**，不能落库 ——
  // 截断是在人还能改的时候不说、跑起来才少半段，而那时没人知道少了什么
  // （同 `MAX_SCENARIO_CHARS` 那条约定的理由）。
  if (doc.truncated) {
    return {
      ok: false,
      message: `这份文件太长了（共 ${doc.chars} 字，超过单份剧本能读的上限）—— `
        + '剧本只放世界观与主线，细节请拆成旗标与人物卡，或者换一份短一点的'
    };
  }
  return store.write(name, doc.text);
}
