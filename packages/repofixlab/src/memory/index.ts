/**
 * [脚本级]
 *
 * 定位：RepoFixLab 记忆子系统的公开入口。
 * 负责：导出持久化侧 `RepoFixMemoryStore`、组装侧 `RepoFixContextAssembler` 及生命周期适配器 `RepoFixMemoryRuntime`。
 * 不负责：重新定义契约；L0/L1/L2 数据类型从 `contracts/memory.ts` 统一导出，L3 在 SWE-bench 中固定关闭且当前未实现。
 * 数据流：调用方通过 Store 写入事实，通过 Runtime 声明外部阶段边界，通过 Assembler 得到 Provider Context。
 * 不变量：本入口仅聚合模块，不引入执行决策或隐藏状态。
 */
export * from "./assembler.ts";
export * from "./store.ts";
