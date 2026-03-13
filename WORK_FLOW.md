# AILoop 运行机制与工作流 (Workflow)

AILoop 是一个通过持续计划、执行、评估和治理来完成目标的自动化系统。本架构基于多个特定职能的 Agent 协同工作，形成一个可控、可观察的闭环（Loop）。

## 1. 系统角色定义 (Agent Roles)

系统由多个高度专门化的核心 Agent 组成，每个 Agent 在特定的沙盒环境和权限级别下运行：

* **PlannerAgent (计划者)**
  * **职责**: 根据当前工作空间的总体目标（Goal）和过去的运行历史（包括上一轮的失败原因或用户的最新指令），制定本轮执行的详细子任务（SubTask）。
  * **权限**: 仅读权限（Read-only）。它不会修改任何代码，只负责观察和决策。
  * **输出**: 一个包含具体指令、预期结果和重点影响文件的任务执行计划。

* **ExecutorAgent (执行者)**
  * **职责**: 接收 Planner 产出的子任务，并利用工具（Tools，如写文件、执行 Shell 等）实际完成任务。它是唯一负责直接修改代码和环境的 Agent。
  * **权限**: 最高执行权限（Danger-full-access）。
  * **特征**: 在其执行过程中，受严格的“行动数量 (Actions)”、“耗时”和“预算”限制（Budget Guard），一旦超限将被强制中断。

* **Evaluator (评估者)**
  * **职责**: 独立审查 Executor 的执行结果。通过检查日志、代码 Diff（State Change）等工件（Artifacts），从多个预定义维度（如目标对齐度、因果有效性等）进行评分。
  * **权限**: 高权限或仅读（根据评估策略配置）。
  * **输出**: 综合评分、通过/失败决定以及详尽的评估证据。

* **LeaderAgent (治理介入者)**
  * **职责**: 当循环发生异常（例如 Evaluator 连续失败导致系统暂停，或人为挂起时），Leader 负责接管当前状态进行诊断。
  * **权限**: 写权限（Workspace-write）。
  * **功能**: 分析为什么循环停滞，提出修复建议并向人类操作员请求必要的确认或澄清（Clarification Request）。

* **DesignerAgent (设计者)** *(特定环节使用)*
  * **职责**: 在构建 UI/UX 特性前，如果被专门唤醒，负责提供系统性的交互方案和视觉设计参考，辅助 Executor 编写前端代码。

## 2. 核心工作流与流转顺序 (The Loop Sequence)

每次“回合（Round）”的流转严格遵循以下生命周期，由 `LoopEngine` 负责编排：

### 阶段 1：预算检查与前置条件 (Pre-flight & Budget)
1. 引擎检查当前的暂停（Pause）或停止（Stop）标志。如果检测到用户强制中止，进入挂起流程。
2. 计算剩余的时间预算、金钱预算和行动次数。如果耗尽，抛出 `BudgetBreach` 并中止本轮。

### 阶段 2：计划 (Plan)
1. 引擎收集当前工作空间的 Snapshot（文件树状态）和累积的变更（Diff）。
2. 调用 **PlannerAgent**。
3. Planner 分析目标和历史，输出明确的 `SubTask`。

### 阶段 3：执行 (Execute)
1. 引擎将 `SubTask` 传递给 **ExecutorAgent**。
2. Executor 根据计划，利用各种工具（ToolRegistry）对代码库进行修改。
3. 执行期间，所有动作和输出会被记录到独立的 Round Log 文件中。
4. 结束后，Executor 生成本轮执行的摘要（ToolResult）。

### 阶段 4：结果提取与评估 (Artifacts & Evaluate)
1. 引擎收集 Executor 的执行后状态，生成差异文件（State Change）。
2. 调用 **Evaluator** 分析这些数据。
3. **通过 (Pass)**：如果综合得分大于等于配置的及格线，Round 判定为成功，引擎清理临时状态，保存汇总结果，准备进入下一轮。
4. **失败 (Fail)**：如果得分过低，进入**返工机制 (Auto-Rework)**。

### 阶段 5：自动返工与熔断 (Rework & Break)
1. 如果 Evaluator 判定失败，引擎不会立即结束 Round，而是自动将失败原因（Failure Justification）反哺给 Executor。
2. Executor 在同一个 Round 内发起重试（Attempt N），尝试修复自己刚才写坏的代码。
3. 如果重试次数超过阈值（如连续 2 或 3 次均失败），系统熔断，将引擎状态置为 `paused`，并记录致命失败。

### 阶段 6：异常治理介入 (Leader / CCB)
1. 当循环被置为 `paused`（不管是由于人工干预还是严重失败），如果启用了 `AILOOP_ENABLE_LEADER`，引擎会唤醒 **LeaderAgent**（或 CCB 会话）。
2. Leader 通过安全沙箱阅读失败的日志，向人类用户输出诊断报告（Clarification），等待人类输入新的干预指令后才能继续。

## 3. 设计哲学
此工作流贯彻**决策与执行分离**的原则。Planner 不可写代码，Executor 不评估自己的结果， Evaluator 作为独立第三方进行质量把控，确保了每一次代码变更的高因果有效性（Causal Validity）。当机器无法闭环时，通过 Leader 机制请求人类介入，保证系统永远不会处于失控的死循环中。
