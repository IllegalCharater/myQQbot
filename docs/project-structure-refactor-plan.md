# Agent 结构与提示词文本重构计划

## 本阶段范围

本阶段只完成两项工作：

1. 将 `src/agent` 的实现按运行编排、上下文、提示词、工具、维护任务和共享代码分层。
2. 将所有模型可见的固定指令集中到 `src/core/prompt-catalog.ts`。

全局事件、方法与定时任务注册表延期，不在本阶段引入任何运行时代码。

## 目标结构

```text
src/agent/
├─ runtime/       # 会话编排与运行状态
├─ context/       # 当前窗口、响应策略与历史策略
├─ prompting/     # 提示词动态拼装
├─ tools/         # 工具定义、执行与按领域拆分的工具集合
├─ maintenance/   # 主动冒泡、历史压缩、长期记忆整理
└─ shared/        # Agent 内共享类型与解析器
```

旧路径不保留转发兼容文件。所有源码、测试与文档一次性切换到新路径，并保持 NodeNext 的 `.js` import 后缀。

## 实施顺序

1. 建立模块导出、工具名称/顺序/schema、提示词和维护任务请求的基线断言。
2. 移动共享、上下文、运行与维护模块并更新依赖。
3. 拆分工具模块，由 `tools/index.ts` 按原顺序组装和统一导出。
4. 将动态提示词拼装迁入 `prompting/prompt-builder.ts`。
5. 完成类型检查、层级检查和全量断言。
6. 新增 `src/core/prompt-catalog.ts`，依次迁移默认 persona、system/user 固定段、工具 description、历史压缩与记忆整理指令。
7. 再次执行逐字等价断言与全量检查，更新架构文档。

## 不变量与验收

- 工具名称、顺序、参数 schema、description 和执行行为不变。
- 当前窗口、响应策略、历史策略和 Agent 多轮循环语义不变。
- 默认 system/user prompt、摘要请求和记忆整理请求在固定输入下逐字一致。
- 自定义 persona 仍由用户配置提供，不复制进 Catalog。
- `src/agent` 根目录不再保留大型实现文件或旧路径兼容壳。
- 所有模型可见固定指令仅由 `prompt-catalog.ts` 提供。
- `npm run check` 全部通过。

## 延期事项

任务 3（全局事件、方法与定时任务注册表）仅记录于 `docs/global-registry-roadmap.md`，本阶段不实现。
