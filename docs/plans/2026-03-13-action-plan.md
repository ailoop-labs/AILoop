# AILoop 架构优化与文档建设计划 (2026-03-13)

本计划文档基于当前日志痛点、代码复用问题以及文档驱动开发（DoD）的需要，规划了具体的改进和落地步骤。

## Phase 1: 问题分析与架构评估 (Analysis)

### 1.1 日志架构分析
- **现状诊断**：当前的 `.ailoop/prod.server.log` 已经积累了超过 8 万行内容。由于 Codex 的全量 Prompt 和 Response 流与系统的控制层日志（Info/Error）混杂在同一个没有轮转策略的文件中，导致排查问题时需要阅读海量的无用上下文，极大增加了 Token 消耗和人类阅读负担。
- **改进建议**：
  - **短期**：在 `engine.ts` 等核心链路中，减少全量输出冗长的文本，改用简明的状态摘要。
  - **长期架构**：引入日志轮转（Log Rotation，按大小或日期切割）；分离架构，将“模型 I/O 流日志”与“系统运行状态日志（Info/Debug/Error）”写入不同的通道。

### 1.2 `nohup` 与环境变量机制分析
- **疑问**：为什么 `nohup` 启动还需要 `AILOOP_CODEX_BIN`？系统环境变量里不是有吗？
- **分析结果**：虽然终端中直接执行 `nohup` 会继承当前 Shell 的 `$PATH`，但在实际生产场景中，如果守护进程是由非交互式服务（如 IDE、Systemd、或 Web UI 衍生的剥离进程）启动的，其继承的 `PATH` 往往只包含 `/usr/bin:/bin`，会丢失 `~/.bun/bin`。
- **结论**：`AILOOP_CODEX_BIN` 是**必需的**。显式配置绝对路径能保证无论进程是由谁（何种上下文）拉起的，底层系统都能准确找到执行文件，杜绝 `ENOENT` 错误。

---

## Phase 2: 代码重构与清理 (Refactoring & Cleanup)

### 2.1 移除特定环境硬编码 (Issue #2)
- **动作**：从 `src/agent/codex-client.ts` 中彻底删除对 `CRS_OAI_KEY` 的读取和注入逻辑。
- **目的**：保持开源项目代码的纯粹性，不应包含针对特定部署环境的业务逻辑。

### 2.2 增强 Agent 初始化的代码复用度 (Issue #5)
- **现状诊断**：目前每个 Agent（Planner, Executor, Leader 等）在初始化 `CodexClient` 时都需要显式调用 `resolveCodexBin(config.codex)`，一旦遗漏就会导致严重 Bug（如上次的崩溃）。
- **重构动作**：
  - 在入口配置加载层 `src/config/env.ts` 的 `loadConfig` 方法中，**提前统一解析并固化 `bin` 的绝对路径**。
  - 彻底删除 `resolveCodexBin` 这个冗余函数。
  - 简化所有 Agent 的初始化代码，直接使用 `new CodexClient(config.codex)` 即可保证 100% 拿到正确的路径。

---

## Phase 3: 文档建设 (Documentation)

### 3.1 贯彻 DoD 范式 (README.md 更新)
- **动作**：在 `README.md` 的显眼位置增加 DoD (Definition of Done) 声明。
- **内容**：强调本项目采用文档驱动开发（Documentation-Driven Development），文档的进度领先于代码。所有 AI Agents 在执行任务时不能过度依赖当前代码状态，当“代码现状”与“文档预期”发生冲突时，**必须以文档为最终导向**进行修复和对齐。

### 3.2 定义系统流转全貌 (WORK_FLOW.md 建立)
- **动作**：在项目根目录创建 `WORK_FLOW.md`。
- **内容**：
  - **角色定义 (Roles)**：明确定义 Planner (计划)、Executor (执行)、Evaluator (评估)、Leader (介入诊断) 等 Agent 的职能边界。
  - **流转顺序 (Loop Sequence)**：详细描绘 AILoop 一轮 (Round) 的生命周期：
    1. 意图解析与计划阶段 (Planner)
    2. 实际执行与代码修改 (Executor)
    3. LLM 自动化维度评估 (Evaluator)
    4. 返工机制 (Rework)
    5. 异常治理介入 (CCB / Leader) 与挂起状态
