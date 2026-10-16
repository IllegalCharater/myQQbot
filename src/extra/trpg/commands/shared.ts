// 跑团命令层共用的两样东西（从 `impl.ts` 拆出，2026-10-16）。
//
// 这一层**只返回回执文本，不碰 sender** —— 发送由 `web/onebot/commands.ts` 的外壳做
// （回执是"引用回复"那条命令消息、抛出的中文原样进群、发送失败不抛，三条都是外壳的事）。
import type { ExtraCommandInput } from '../../types.js';
import type { ScenarioSummary } from '../scenario/parse.js';
import type { ScenarioStore } from '../store/scenario-store.js';

/**
 * 一条命令的处理函数：入参是**命令那个形状**，回一句要发进群里的话。
 *
 * 与工具的 `Handler` 区别很直白：**入口是人**，所以零 LLM 成本、回执直接进群、不用 `ToolResult`
 * 那套（没有 `isError` —— 命令要么回一句话，要么**抛出**，由外壳把 `error.message` 原样发出去）。
 */
export type CommandHandler = (input: ExtraCommandInput) => Promise<string>;

/**
 * 命令后面的**参数词**。
 *
 * 判据是"把命中那个词原样切掉"（而不是"切掉第 N 个词"）：命令词可以是一整个
 * `<命令> <子命令>`（`'.trpg mode'`），切掉它之后剩下的才是参数。这样加一层子命令
 * 不必回来改每一处解析。
 *
 * ⚠️ 与 `.r` 那边**剥前缀**是有意的不同：掷骰的参数是一整条表达式（`3d6 + 2` 里的空格
 * 属于表达式），所以它按"切掉命令词再 trim"取整串；这里按空白切词。两者形状不同，
 * 别统一成一种 —— 统一之后必然有一边的解析错。
 */
export function argsOf(input: ExtraCommandInput, command: string): string[] {
  const rest = String(input.text ?? '').trim().slice(command.length).trim();
  return rest ? rest.split(/\s+/) : [];
}

/** 与 `argsOf` 同源，但参数是**一整串**（表达式、名字里带空格的场合）。 */
export function restOf(input: ExtraCommandInput, command: string): string {
  return String(input.text ?? '').trim().slice(command.length).trim();
}

/**
 * 剧本库里**此刻能用的**那些。
 *
 * 坏文件不进清单（它们本来也选不中），但它们仍然出现在设置页里 —— 那才是能修的地方。
 * 抽成函数是因为**命令层与 `prompt()` 都要**（向导、`.trpg scenario` 的列出、`.trpg start` 的候选、
 * 注入给模型的那份简报）：各写一遍的话，加一种"不能用"的成因时必然漏掉其中一处。
 */
export function usableScenarios(store: ScenarioStore): ScenarioSummary[] {
  return store.list().filter((item) => !item.problems.length);
}

/** 能用那些剧本的 id（顺序即目录顺序）。 */
export function scenarioIds(store: ScenarioStore): string[] {
  return usableScenarios(store).map((item) => item.id);
}
