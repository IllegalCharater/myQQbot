// `.log export` —— 把这一局的战报导出成一份 `.md` 发进群（P6）。零 LLM 成本。
//
// ── 为什么是"导出成文件"而不是"贴进群里" ──
//
// 战报的卖点是**完整**（`data/trpg/journal/<会话>.jsonl` 是 append-only 的），而一局打下来
// 几百条 —— 贴进群就是刷屏，还得被 QQ 的单条长度上限切碎。发一份群文件既完整、又能存档。
//
// ── 三条边界 ──
//
// ⚠️ **它不要求这一局还在**：`.trpg end` 会删掉战役存档，但**战报留着**（"收团不清战报"）。
// 所以这条命令只读战报文件，不看 `store.read(chatKey)` —— 要求"还在局里"就等于把"刚打完
// 那一局想留个纪念"这条最正常的用法堵死。
//
// ⚠️ **筛不筛由写战报的人决定**（`TrpgLogEntry.visible` → `mirrorLog`），文件本身已经是干净的。
// 这里**只再挡一次 `visible === false`** —— 同一条判据、不是第二份逻辑：导出是这条链上
// **唯一一个"把这份文件发出去"的动作**，而漏一次的代价是把暗线/藏着的人物发进群。
// 手改过的文件、以及将来某个绕过 `mirrorLog` 的写入点，都会在这一步被拦住。
//
// ⚠️ **发送由宿主做**（`sendFile` 端口）：这条链要碰 `SendQueue`，而 `extra → web` 是反向依赖。
// 与 `.rh` 的 `sendPrivate`、扩展的 `deliverNote` 是同一条分工 —— 扩展只说"发什么"，怎么发是宿主的事。
import { renderJournal, journalFileName } from '../render/journal.js';
import type { CommandHandler } from './shared.js';
import type { JournalPort } from '../model/campaign.js';
import type { TrpgLogEntry } from '../types.js';

/** 裸 `.log` 的回执。**群友可见文案**，不属于提示词目录（同 `ROLL_USAGE` / `COMBAT_USAGE`）。 */
const LOG_USAGE = '用法：\n'
  + '· `.log export` —— 把这一局的战报导出成一份文件发进群（含每一轮掷骰、检定与剧情记录）';

/**
 * 战报的**读取**侧（`store/journal-store.ts` 的 `JournalStore` 实现它）。
 *
 * 与 `JournalPort`（写侧，住在 `model/campaign.ts` 因为消费它的是 `mirrorLog`）分开：
 * 这一半的消费者是命令层。两半都是**结构性**的（各只有一个方法），所以套件可以传普通对象字面量。
 */
export interface JournalReadPort {
  read(chatKey: string): TrpgLogEntry[];
}

export interface LogCommandDeps {
  /** 战报的读写两半（缺省 = 没接战报，导出会如实说一句）。 */
  journal?: (JournalPort & JournalReadPort) | null;
  /**
   * 把一份文件发进会话。**缺省 = 宿主没接上传通道**：那时如实说一句，不假装导出成功
   * （与 `.rh` 没装私聊端口时的取舍逐字相同）。
   */
  sendFile?: ((chatKey: string, fileName: string, content: string) => Promise<void>) | null;
  /** 这条命令的词（`'.log export'` 这样）—— 子命令就在词里，见下。 */
  command: string;
}

export function createLogCommand(deps: LogCommandDeps): CommandHandler {
  const { journal, sendFile, command } = deps;

  return async (input) => {
    // ⚠️ **子命令从 `command` 里取，不从 `argsOf` 里取**：`argsOf` 切掉的是**整个命令词**
    // （`'.log export'`），所以它后面本来就一个参数词都没有。形状与 `.combat start` 逐字相同
    // （子命令在词里），与 `.trpg mode 助手`（参数在词后）相反 —— 见 `commands/shared.ts` 的 `argsOf`。
    const sub = command.trim().split(/\s+/)[1]?.toLowerCase() ?? '';
    // 认不出的子命令落到**裸 `.log`** 上（`spec.ts` 里它排在子命令之后）。这条守卫因此够不着，
    // 留着只是不让"表里少写一行"变成静默导出。
    if (sub !== 'export') return LOG_USAGE;

    if (!journal) return '这个部署没有接战报 —— 导出不了。';

    const entries = journal.read(input.chatKey).filter((entry) => entry.visible !== false);
    if (!entries.length) {
      return '这个会话还没有战报 —— 战报从这一局开跑之后开始记（掷骰、检定、剧情记录都会进去）。';
    }
    if (!sendFile) {
      return `这台机器没接上传文件的通道，发不了 —— 战报存在本机，管理员能在设置页的「跑团」里看到它（共 ${entries.length} 条）。`;
    }

    const fileName = journalFileName();
    try {
      await sendFile(input.chatKey, fileName, renderJournal(input.chatKey, entries));
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      return `战报导出失败：${why}（战报还在本机，没有丢）。`;
    }
    return `战报已导出：${fileName}（${entries.length} 条）。`;
  };
}

/** 裸 `.log`（**排在子命令之后**，只在它没匹配上时命中）。 */
export function createLogUsageCommand(): CommandHandler {
  return async () => LOG_USAGE;
}
