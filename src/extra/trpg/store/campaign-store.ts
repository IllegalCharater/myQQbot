// 战役的**落盘**（从 `state.ts` 拆出，2026-10-16）。
//
// 一个会话一个文件：`data/trpg/<会话>.json`。原子替换（tmp + rename），读不到就返回 `null`
// （**不是**空对象 —— "还没有开团"与"开了一场空的团"是两件事，前者要提示模型去开局）。
//
// 这一层只做 I/O：**判据全在 `model/campaign.ts`** —— `read` 把文件内容交给 `normalizeCampaign`、
// `write` 在落盘前也过一遍它。两处都过是有意的：写入那次是"我们不让坏值进文件"，
// 读取那次是"文件里已经有坏值也不让它进提示词"。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../../core/paths.js';
import { normalizeCampaign } from '../model/campaign.js';
import { safeName } from '../model/paths.js';
import type { TrpgCampaign } from '../types.js';

export const TRPG_DIR = path.join(DATA_DIR, 'trpg');

/** 某个会话的战役文件在哪。**只给套件与排查用**（`TrpgStore` 自己按 `this.dir` 算）。 */
export function campaignFile(chatKey: string): string {
  return path.join(TRPG_DIR, `${safeName(chatKey)}.json`);
}

/**
 * 一个会话的战役文件。**读不到返回 `null`**（而不是空对象）——"还没有开团"与"开了一场空的团"
 * 是两件事：前者要提示模型去 `campaign action=start`，后者不该提示。
 *
 * 写是**原子替换**（tmp + rename），与 `chat/store.ts` / `hot-search/state-store.ts` 同形。
 */
export class TrpgStore {
  readonly dir: string;

  constructor(dir: string = TRPG_DIR) {
    this.dir = dir;
  }

  file(chatKey: string): string {
    return path.join(this.dir, `${safeName(chatKey)}.json`);
  }

  read(chatKey: string): TrpgCampaign | null {
    if (!chatKey) return null;
    try {
      const raw = fs.readFileSync(this.file(chatKey), 'utf8');
      return normalizeCampaign(JSON.parse(raw), chatKey);
    } catch {
      return null;   // 没有文件 / 坏 JSON / 读不动，一律当"没有这场团"
    }
  }

  write(campaign: TrpgCampaign): TrpgCampaign {
    const safe = normalizeCampaign(campaign, campaign.chatKey) ?? campaign;
    fs.mkdirSync(this.dir, { recursive: true });
    const target = this.file(campaign.chatKey);
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(safe, null, 1), 'utf8');
    fs.renameSync(tmp, target);
    return safe;
  }

  remove(chatKey: string): void {
    try { fs.rmSync(this.file(chatKey)); } catch { /* 本来就没有 */ }
  }
}
