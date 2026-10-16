---
document_type: implementation-proposal
authority: proposed-task-capability-design
status: proposed
revision: 1
confirmation_status: pending
implementation_status: not_started
review_baseline: 81bb808c72721f67e2f07ead49fa4aca2ad64c02
last_updated: 2026-10-16
---

# 会话 Task 能力开关方案

推荐采用一个 Core 持久管理、默认关闭的实例级开关。Bootstrap 与平台 Skill 的通用教学统一去掉
Task 专用内容；动态上下文、CLI 发现与解析、业务准入、客户端投影分别读取同一个能力状态。
开启后仍提供现有 Task 工作流和数据，关闭后保留数据但不提供 Task 功能。

本稿是待审阅的 R1 提案，尚未修改实现、Schema 或当前合同。当前版本从
[版本索引](../versions/README.md)解析。后续确认实施时，将本稿确认过的完整模型输入对照和兼容规则
纳入该版本独立的 `model-context-change-task-capability.md`，记录确认的 revision，再进行编码；
本稿不代替[模型上下文变更治理](../development/model-context-change-governance.md)。

## 方案选择

| 项目 | R1 建议 |
| --- | --- |
| 开关范围 | 一个 Core 数据实例；Desktop、Web、渠道和全部 Thread 共用 |
| 默认值 | `false`；新安装与升级后缺少配置都关闭，已有 Task 不自动开启功能 |
| Bootstrap | 所有开关状态使用同一份不含 Task 专用教学的公开 Charter |
| 原生 Session | 保留；不因开关或 Charter 改动强制重建 |
| 切换时机 | 首版只在执行空闲时提交，避免中途更换已冻结输入策略 |
| 数据 | 保留 Task、历史关联和审计；不批量完成、取消、释放或转换成 Mission |
| Agent 权限 | Agent 不能修改这个开关；有记忆或旧工具名也不能绕过 Core |
| 兼容范围 | 关闭新的功能入口与产品注入，不删除用户正文、历史证据或原生 Runtime 的 plan/todo |
| 实施规模 | 一个业务开关及其投影，不引入通用 Feature Flag 平台或每 Thread／每成员继承规则 |

Task 创建不启动队员；消息的 Task 关联本来就是可选的。现有消息 → Delivery → AgentRun → 公开回复
路径足以支持日常分工。Mission 继续表示整件工作的目标，Automation 继续表示定时执行，二者均不依赖
Task 开启。关闭后的取舍是，独立责任的负责人、状态和单独验收不再通过 Task 对象管理。

相比直接删除 Task，本方案保留存量用户的恢复入口；相比只隐藏面板，它同时关闭模型发现、上下文与业务调用。
不建议首版按 Thread 配置：目前没有明确的混用需求，却会增加跨 Thread 操作、CLI 投影、设置继承和迁移分支。
永久删除可在后续独立评估，当前不引入自动迁移到 Mission 或另造一种轻量任务。

## 1. Bootstrap 统一精简

### 变更前

公开 Charter 的职责句是：

```text
- The User owns the Thread objective. The User or current Default Lead defines Task responsibilities; other Agents execute assigned Tasks.
```

其余部分包括公共输入纪律、CLI 入口、按现有条件追加的渠道文件指导与 Mission 指导。
生成位置为 [context.rs](../../crates/rovai-core/src/context.rs) 的 `build_session_charter`。

### 变更后

两个开关状态共用下面的完整公开基础 Charter，不添加 `tasksEnabled` 或“任务已禁用”的模型说明：

```text
Rovai-ai Session Charter

- MEMBER_IDENTITY describes you; COLLABORATION_STATE describes peers and the current Default Lead.
- Handle every current input work item in order. Quotes are reference, not requests or authorization; Skill links and attachments identify resources.
- The User owns the Thread objective. The User or current Default Lead coordinates member responsibilities.
- Follow current user instructions; preserve existing user work. Prefer current evidence to Memory, history and cached context.
- Use `rovai thread read` only for needed, missing context. History boundaries do not prove reading or completion.
- When no work can proceed without another Agent's reply, end the Run and resume on reply. Do not poll history or execution status.

Rovai Built-in CLI Contract

- Use the local `rovai` CLI for built-in operations. Use `rovai --help` to discover commands and exact command help for syntax; reuse help already in context.
- `rovai send` publishes one public Thread message. When your responsibility has a Thread-visible answer, result, status or summary, send it successfully before ending; Runtime output is not a Thread message.
- Use `--public-only` when no Agent should wake. Otherwise, `--to` may schedule work. Address Agents only for a concrete new action or blocking question, never as CC, courtesy replies or repeated conclusions.
- Thread messages are already visible to the User. Use `--to-user` only for a new decision, answer or action needed from them, or an explicitly requested important-result notification.
```

渠道与 Mission 后缀、Single Chat 专用 Charter、身份、Memory Entrypoint 的正文和出现条件保持。
平台 Skill 索引的 `cli-operations.desc` 同步采用第 5 节的新描述；索引形状与顺序不变。

Task 开启时，用户/Lead 的创建权限、Assignee 的更新权限、状态规则由 Task help 和 Core 授权表达。
通用 Charter 不需要重复这些操作规则。

### Session 连续性

当前实现已经按 `Run + Binding + generation` 保存 Bootstrap 准备结果；新 Run 读取当前模板，
同一 Run 的恢复复用已冻结材料。是否实际投递仍由 Adapter delivery mode、Charter digest、补发要求与
accepted ACK 决定。参见 `prepare_session_bootstrap_evidence_for_snapshot` 和
[Session 不变量](../architecture/foundational-invariants.md#context-session-bootstrap)。

因此，本方案不把开关加入 Native Binding compatibility digest，也不以删除 Task 文案为由重建原生
Session。这修正了初轮调研中“切换后更换 Session”的过重建议。各 Runtime 的热续接、冷续接和补发仍要
验证真实投递；已进入原生历史的旧说明允许保留，调用权限由当前 Core 裁决。

## 2. 唯一配置与提交边界

建议新增窄接口，名称在确认后作为实施合同冻结：

```text
preferences.tasks.get
  request: {}
  response: { enabled: boolean }

preferences.tasks.set
  request: { enabled: boolean }
  response: { enabled: boolean }
```

这两个接口属于已认证 User 的 Host/Desktop 设置操作，不注册到 Agent 内置工具目录。
配置使用 Core 数据库的一条 singleton 记录，缺行按关闭解析；不保存在 Electron
`general-preferences.json`、浏览器 localStorage、Agent Profile 或每个 Thread 中。
设置保存与业务准入共用数据库串行事务，因此不存在各客户端各存一份的授权状态。

设置保存按以下顺序执行：

1. 校验 User 调用和布尔输入；相同值是幂等读取，不产生变化事件。
2. 在同一事务中确认没有非终态 Run、未结算 Runtime Input、等待/已领取的 Delivery 或尚未结算的
   旧 A2A 投递；同时与新消息/claim 准入串行。普通空闲的 Native Session 不算占用。
   唯一豁免是第 8 节因 `task.feature_disabled` 已停稳的恢复记录：必须证明无活跃 lease、
   无在途请求、无 accepted/unknown 输入，且调度器不会自动投递；否则仍按忙处理。
3. 忙时返回 `task.setting_busy`，保持原值；不停止执行、不取消消息、不保存隐藏的“待生效”状态。
4. 空闲时提交新值，发布设置/读侧失效信号，刷新所有客户端。后续 claim 使用新值。
5. 下一次绑定 Run lease 时写入新的 CLI 能力投影。无活跃 lease 的进程不发布 Task 能力。

上述豁免使用户能够重新开启并恢复原记录，不形成“恢复需要开启、开启又要求恢复先结束”的死锁。
提交开启只解除能力阻断；原有恢复资格、Binding/epoch 校验和输入防重仍然适用。

这里的“忙”是执行占用，不是 Task 的 `pending/in_progress/blocked` 状态。大量未完成 Task
不能阻止关闭功能。首版采用实例空闲门槛，代价是存在后台工作时需等工作结束后切换；
不为低频设置增加 desired/effective 双状态和后台切换 worker。
历史终态 Run 及其仅供审计的 accepted/unknown 证据不算占用；仍有结算、清理或在途投递责任的记录才算。

配置损坏不得自动解释成开启；返回明确读取错误，界面不显示已保存成功，原文件/记录不被修复覆盖。

## 3. 动态上下文按能力选择

现有路径至少包括：

- [context/input.rs](../../crates/rovai-core/src/context/input.rs)：
  `DynamicInputContext::prepare`，普通 public 输入与 Steer 共用；
- [context/claim.rs](../../crates/rovai-core/src/context/claim.rs)：
  claim 冻结、FIFO 预算与 `payload_len`；
- [context.rs](../../crates/rovai-core/src/context.rs)：
  非 batch 物化、旧 A2A preflight、Run Facts 与最终 formatter。

在共同选择入口读取 Core 状态，在现有 claim/frozen-context DTO 中携带本次的内部布尔选择结果；
渲染、容量检查与物化使用同一个结果，不分别重新取设置。旧 DTO 的缺失字段仅在历史解码分支解释，
不能让新请求用字段缺省恢复为开启。不新增模型可见 capability section。

### SELF_ACTIVE_TASKS 前后对照

| 情形 | 当前行为 | 变更后 |
| --- | --- | --- |
| Task 开启，有活跃任务 | 最多 8 项，按更新时间与 ID 排序 | 保持 |
| Task 开启，没有活跃任务 | 输出 `{"tasks":[]}` 清除旧责任认知 | 保持 |
| Task 开启，预算淘汰全部任务 | 整个 section 省略，保留既有 omission 语义 | 保持 |
| Task 关闭 | 目前没有此模式 | 不查 Task 表，不选择任务，不渲染 section |
| Single Chat | 当前物化路径可产生空 Task section，Run Facts 有禁用字段 | 统一省略 Task section 与 Task 专用字段，无论全局开关如何 |

例如当前公开输入的任务区段：

```text
[SELF_ACTIVE_TASKS]
{"tasks":[{"taskId":"task_example","title":"验证改动","status":"in_progress"}]}
[/SELF_ACTIVE_TASKS]
```

关闭后这个区段完全不存在；不替换成空数组、`null`、`disabled` 或提示句。
`COLLABORATION_STATE`、`RUN_FACTS`、`WORKSPACE`、Skills、`RUN_INPUT` 等其余区段保持原有顺序和语义。

必须区分三种内部状态：能力关闭、开启但没有候选、开启但预算淘汰。建议用
`Option<SelfActiveTaskProjection>` 配合明确的选择原因表达；不能只清空 `Vec`，因为当前
`self_active_task_projection([], 0)` 会重新生成空 section。
也不要把 `maxSelfActiveTasks` 改成 0：当前 Profile 要求它为 8，功能状态不是容量上限。

### Run Facts 前后对照

公开 batch 通常没有 `taskContext`。现存非 batch/A2A 生成路径还可输出：

```json
{
  "taskContext": {
    "taskId": "task_example",
    "referenceMode": "frozen",
    "laterChangesRetargetRun": false
  }
}
```

关闭后，新生成的 Run Facts 不含此字段；关闭状态也不再创建新的 Task-linked Run。
开启模式保留原有结构。Single Chat 的 `RUN_FACTS.singleChat.taskMutationAllowed: false`
在新格式中统一删除，其余 Single Chat 字段与真实 operation policy 保持，不改变单聊权限。

Task 不再参与关闭模式的 Memory counterparty 优先顺序推导。
保留最终动态输入 Managed Blob 与必要来源；不恢复已经退役的 Task evidence JSON、
独立 digest、Profile JSON 或另一套输入副本。历史已物化载荷不重算，详见第 8 节。

## 4. CLI help 与执行入口

### 当前问题及推荐控制位置

[bin/rovai.rs](../../crates/rovai-core/src/bin/rovai.rs) 目前先处理根 help、Task family help、
operation help，再调用 `load_context()`。仅在 Router 拒绝操作不会改变这些帮助。
[工具目录](../../crates/rovai-core/src/builtin_tool_transport.rs) 的 `OnceLock` 缓存也是全量静态目录。

建议在 `BuiltinToolCliContext` 增加一个 Core 投影字段：

```json
{"tasksEnabled": false}
```

这只是本进程的帮助/解析投影，不是授权凭证。Core 在绑定 Run lease 时由实例状态与运行模式计算它：
public Run 且功能开启才是 `true`；Single Chat、未绑定、无法确认状态都是 `false`。
不把它作为单独环境变量，不让 CLI 读取日常数据库或自行扫描配置目录。

流程调整为：

```text
读取 CLI 上下文中的能力投影（不要求执行认证，也不为 help 发 IPC）
    → 按能力选择目录/Schema
    → root help / family help / operation help / 参数解析
    → 真正执行时才校验 active lease 并发送 IPC
    → Core 使用当前状态重新准入
```

没有上下文、旧上下文缺字段、格式损坏或版本不支持时，帮助只显示不依赖 Task 的公共目录；
真实执行仍保留原有上下文/版本错误。脱离受管 Runtime 的终端默认不展示 Task，
不会为了 help 唤醒或连接一个猜测的 Core 实例。

实现上保留一个完整的静态基础 catalog，增加按当前能力生成的窄视图。
根 help、family、精确 help、参数解析共用这个视图。不要让 `OnceLock` 缓存第一次读取的开关值；
也不要维护一份手写的开关后命令名单。
`builtin_tool_list`、`builtin_tool_description` 以及可对外返回的目录/描述路径也必须经过同一视图。
关闭时，Send 的描述错误表不列出 `message.task_recipient_ambiguous`、`message.invalid_task`；
服务端保留这些原有错误的识别能力，用于历史证据与开启模式。

### 关闭状态的完整根 help

```text
Rovai CLI

Agent operations:
  rovai send
  rovai member list|get|create|update
  rovai thread list|search|read|runs
  rovai history search
  rovai memory view|search|read|write
  rovai automation list|get|create|run|close|update|delete
  rovai mission list|get|update|status

Run an Agent operation's exact `--help` for its closed inputs.
```

普通非受管终端继续按现有规则追加 User Automation 段。
开启时只在原位置加入 `rovai task create|get|list|update`；其余命令不受影响。
Task family 和四个 operation 的 help 在关闭时不返回说明或 Schema，
使用“operation unavailable”类结构化错误；不输出“如何开启 Task”的 Agent 教学。

### Send 的字段与教学

关闭时，从 Send Schema 移除 `taskId`，从参数表移除 `--task-id`。
JSON stdin、完整 JSON 文件、direct flags 都用同一份有效 Schema，包含旧字段即拒绝；
即使字段值是 `null` 也不能默默忽略。Core 对旧客户端绕过本地解析的请求再次检查。
字段存在性检查在解码为 `Option` 之前执行，不能让显式 `null` 与缺字段合并后绕过这条规则。

以下两处通用文案在两个模式中统一精简：

| 位置 | 变更前 | 变更后 |
| --- | --- | --- |
| User attention help | `It creates no Agent Delivery, does not represent approval, and may be combined with --public-only. User attention is message-local and is never inherited by replies, Tasks, or downstream A2A work.` | `It creates no Agent Delivery, does not represent approval, and may be combined with --public-only. User attention is message-local and is never inherited.` |
| public-only help | `Do not combine this option with --to or --task-id. It may be combined with --to-user.` | `Do not combine this option with --to. It may be combined with --to-user.` |

public-only Schema 描述统一改为：

```text
Guarantee that this public Thread message addresses no Agent. When true, explicit Agent recipients are invalid, effectiveRecipients and deliveryIds are empty, and no Agent is woken. This may be combined with mentionUser because User attention is not Agent routing.
```

开启时，`--task-id` 自己的帮助承担完整限制，不再把 Task 教学散到其他参数：

```text
Link a current Task assigned to exactly one effective Agent recipient.
Invalid with --public-only. User attention does not count as an Agent recipient.
```

真实业务仍执行 public-only 与 Task 关联互斥；删掉重复教学不改变校验。
正文、附件、文件输入选择、发送结果和用户注意力规则保持。

另将 `automation.list` 通用描述尾句从 `This read does not run or modify a task.` 改成
`This read does not run or modify an Automation.`，避免在无 Task 的工具目录中混用产品名。
这是术语澄清，不改变 Automation 的功能。

### 开启状态的 Task 专用教学

将原 Task reference 的规则收敛到 `rovai task --help` 与精确命令帮助：

```text
rovai task

Use Tasks for responsibility that survives Runs and needs independent handoff or acceptance.
Use messages for one-time coordination, answers, progress and questions. Prefer an existing Task.
Put scope and requirements together in description. Read current Task state when needed or stale.
Submit only the fields you intend to change; do not poll.
User/Default Lead defines content and assignment; an assignee may update only its own execution state.
Task operations do not notify or start work. Use rovai send --task-id with one Agent recipient.
Bring the Task to the appropriate state before publishing a required handoff, request or result.

  create  Create a durable task.
  get     Read task details.
  list    List task summaries.
  update  Update an existing task.

Use rovai task <command> --help for arguments.
```

四个精确命令继续保留现有状态、字段和权限说明，不为“开启模式”再建立一套领域实现。

## 5. 平台 Skill 使用一套通用文本

`cli-operations` 的新 description 为：

```text
Choose among Rovai messages, Missions, history and Memory; coordinate parallel member requests, multi-step operations or recovery. For one known operation, use its command help directly.
```

其余改动逐项如下；未列出的段落保持，所有状态用同一套资源。

| 文件 | 变更前 | 变更后 |
| --- | --- | --- |
| `cli-operations/SKILL.md` 选择表 | `Responsibility that survives Runs and can be handed off and accepted independently → Task` | 删除这一行 |
| 同文件选择表后 | `Choose the smallest object that fully serves the request. Tasks own durable responsibilities; project sources and history own their facts.` | `Choose the smallest object that fully serves the request. Project sources and history own their facts.` |
| 同文件 References | `[Task](references/task.md): durable responsibility and Task-linked messages.` | 删除这一项 |
| `references/send.md` attention 段首句 | `Attention belongs to this message; replies, Tasks and downstream work do not inherit it.` | `Attention belongs to this message and is not inherited.` |
| 同文件一次性协作段 | `A one-time answer, update, question or request uses a message. Use a [Task](task.md) only for durable, independently transferable responsibility. A Task-linked Send requires exactly one effective Agent recipient; User attention does not count.` | `A one-time answer, update, question or request uses a message.` |
| `references/mission.md` 定位句 | `A Mission owns the shared objective; a Task owns independently transferable responsibility. Do not automatically create a duplicate Task. Edit only the established objective and requirements.` | `A Mission owns the shared objective. Edit only the established objective and requirements.` |
| `references/memory.md` 权威句 | `Tasks, temporary plans, project facts and historical evidence belong to their existing authoritative sources.` | `Temporary plans, project facts and historical evidence belong to their existing authoritative sources.` |
| `cli-operations/agents/openai.yaml` 简介 | `在 Send、Task、检索与 Memory 之间选择并安全协调` | `在消息、Mission、检索与 Memory 之间选择并安全协调` |
| `memory-stewardship/references/authority-and-safety.md` 适用条件 | `belong in Memory rather than Tasks, history, project documents, code, tests, approval or audit records;` | `belong in Memory rather than temporary work records, history, project documents, code, tests, approval or audit records;` |
| `memory-stewardship/references/content-and-keys.md` 示例 | `Agreement: Include the goal, verified state, evidence, open issues and next action in durable Task handoffs.` | `Agreement: Include the goal, verified state, evidence, open issues and next action in work handoffs.` |
| `cli-operations/references/task.md` | 提供 Task 教学 | 从当前发布集合退役；规则已迁入开启后的 CLI help |

[managed_skills.rs](../../crates/rovai-core/src/managed_skills.rs) 的 `sync_directory` 目前只复制和覆盖，
不会清除源目录已移除的文件。因此需要一项明确、窄范围的旧受管文件退役：

- 只处理这个已知官方路径，验证实际目录、非 symlink 和已发布内容身份；
- 已知旧官方文件安全删除；未知或用户改写内容保留并给维护者明确诊断，不递归清理未知文件；
- 断开的旧官方引用和原生缓存的旧说明不能提供权限，Core 仍拒绝调用；
- 更新打包资源、历史 bundle 引用与资源校验，避免编译期 `include_str!` 或恢复同步重新放回旧文件；
- 不修改第三方 Skill、用户 Memory、成员身份或 Runtime 原生技能库。

这里退役的是 Rovai Task 能力的操作指导；自然语言中的普通 `task`（当前工作）不做机械字符串清除。

## 6. Core 在同一准入位置拒绝

UI 和 CLI 的过滤只负责发现与呈现。业务操作要在 Core 最终调用路径再次检查：

| 入口 | 关闭时行为 |
| --- | --- |
| `team.create_task/get_task/list_tasks/update_task` | 拒绝，既不读任务正文也不产生业务写入 |
| `tasks.create/update/list/get` | Desktop/Web 同样拒绝 |
| Agent Send 的 `taskId` | 在发布消息或创建 Delivery 之前拒绝整个请求 |
| User 发送里的 `execution.taskId` | 同样在发布前拒绝 |
| 旧 Run 的“继续执行” | 检查全部原输入关联；存在 Task link 时不给新执行准入 |
| 旧客户端/手写 IPC/JSON | 不能依靠静态 catalog、历史 capability 或旧 DTO 绕过 |
| 成员离队、永久删除 Thread | 继续维护保留数据的外键、assignment 和清理不变量 |

建议统一业务拒绝为 `task.feature_disabled`，消息为 `Task operations are unavailable.`，
恢复动作 `stop`。关闭的 CLI 本地 Task 命令可沿现有 unavailable/invalid-command 错误通道退出；
Core 的领域错误独立保持可识别。不返回任务正文，不提示 Agent 自行修改设置。

Task CRUD 的最终 guard 放到 [collaboration.rs](../../crates/rovai-core/src/collaboration.rs) 中的
业务入口，发送关联在 [message_delivery.rs](../../crates/rovai-core/src/message_delivery.rs) 与
User publication 的共用准入处理；Router 再做早期拒绝。设置切换与这些判断共享事务顺序，
避免“先读开关，释放锁，稍后仍写入”的竞态。

检查先于新的 Task 操作执行和 Agent 工具 Replay，防止关闭后返回缓存的 Task 详情。
已经提交的命令回执、历史审计不改写成失败；Web 原有显式 command reconciliation 仍可核对
“此前是否提交”，但不得重新派发原命令或借回执重新挂载 Task 面板。
历史回执读取不是新的 Task 查询/操作，其历史 payload 按原审计合同保留。

不禁用整个 CollaborationService、Scheduler 或 AgentRun。它们继续承担普通消息和执行职责。

## 7. UI、读侧与通知

设置入口位于通用设置的会话区域，使用现有开关样式：

```text
会话任务
启用任务面板和队员任务工具；关闭后保留已有任务。
```

保存成功才应用新状态。忙时在该行说明“执行结束后可切换”，旧值保持。
Desktop 与 Web 使用 Host 设置，远程连接切换时重新读取对应实例，不继承另一实例或浏览器缓存值。

读侧应在同一读事务中投影 `tasksEnabled`。关闭时，常规界面投影不执行 Task 内容/计数查询，
`ThreadSnapshot.tasks`、`ThreadOpenProjection.tasks`、`coverage.tasks` 和列表 `openTaskCount`
省略；客户端通过能力字段区分“不提供”与“开启但为空”。开启后保持原完整度语义。
不要返回假的零计数来表示未提供，也不要在前端拿到全部任务后再 CSS 隐藏。

[read_model.rs](../../crates/rovai-core/src/read_model.rs) 的 `load_events` 还会通过 Task 表归属
历史事件，并把 Task 事件送进 presentation 流。关闭模式的普通 Thread 打开/增量读取应直接排除
Task presentation 事件与对应关联查询，分页和覆盖范围一起调整；数据库事件和显式历史审计读取仍保留。
Run/Delivery 的旧关联可作为历史证据保留，不再据此查询实时 Task 详情或生成可操作入口。

| UI 入口 | 关闭时处理 |
| --- | --- |
| 标题栏/手机菜单 | 移除 Task 按钮与计数，保持其他入口顺序 |
| 任务面板/详情/Dialog | 不挂载；已打开时收起并移回有效焦点，未保存草稿不自动提交 |
| 时间线 | 不构建实时 Task 卡；普通历史消息、执行过程和工具审计保留 |
| 快捷键 | 不注册 Task 动作，隐藏设置行；保留既有绑定值，避免重新开启时丢失配置 |
| 旧路由/通知焦点 | 回到 Thread 的有效阅读位置，不重新打开任务区 |
| 起步建议 | “整理成任务”改为“梳理步骤”；仅填入普通消息，不创建替代对象 |
| 成员移出/删除预览 | 关闭模式不展示可操作的任务入口；内部仍执行已定义的数据收口 |

Task 通知从当前列表、计数、heads-up 和可操作路由中一起过滤，过滤必须在分页/统计边界一致执行；
保留通知记录、已读位置和用户的任务通知偏好。重新开启可以恢复历史 Inbox 项，
但不能把设置切换当成新状态事件批量弹出历史通知。任务提醒设置行关闭时隐藏。

事件订阅、客户端缓存与多窗口需要一起失效。离线旧客户端暂时显示旧入口不能构成权限；
重新连接先读取当前能力，再接受缓存页面。关闭中的请求结果到达时，不得重新填回已隐藏任务缓存。

主要落点是 [ThreadWorkspace.tsx](../../apps/desktop/src/renderer/src/ThreadWorkspace.tsx)、
[共享快捷键](../../apps/desktop/src/shared/shortcuts.ts)、
[通知设置](../../apps/desktop/src/renderer/src/NotificationSettings.tsx)与 Core 通知投影，
不能只改 Desktop 的一个按钮。

## 8. 存量、冻结输入与升级

“关闭”保证新的发现、上下文和调用不提供 Task；它不承诺擦除原生模型历史。
用户正文、引用、旧消息和历史工具结果保持原样，不按字符串 `task` 过滤。

| 存量状态 | 处理规则 |
| --- | --- |
| 既有 Task 行、Task/消息关联、审计 | 原样保留；重新开启恢复 |
| 空闲 Native Session | 正常 resume；新 Run 使用当前统一 Bootstrap 与当前动态选择 |
| 设置切换时仍有非终态执行/待投递 | 拒绝切换并保持原值，等既有工作结算 |
| 升级后的普通 waiting 消息，尚无冻结输入/Task link | 按默认关闭策略正常 claim，业务消息不改变 |
| 升级后仍 waiting 的 Task-linked 消息 | 在 claim 前以能力未启用明确结算该目标的投递失败；保留消息/关联，不悄悄丢掉 Task ID 继续执行 |
| 历史已准备但尚未发送、仍需投递的 Task 上下文 | 保留原 Blob，进入明确的恢复阻断；证明已停稳后不阻止重新开启，开启后按原恢复规则使用原证据，或用户通过现有停止/新消息入口另行继续 |
| accepted/unknown 输入 | 沿原有结算与隔离规则处理，不重发、不裁剪、不把状态改成未接受 |
| 关闭后继续一个旧 Task-linked Run | 在继续准入处拒绝；检查所有原始消息关联，不能只看 batch Run 的 `task_id` |
| 关闭后继续普通旧 Run | 创建新的 Run，读取当前无 Task 上下文，不复制历史冻结输入作为新载荷 |

升级不能简单依赖“设置保存时必须空闲”：升级启动仍可能存在旧队列和恢复记录。
识别 Task-linked waiting 时同时覆盖 User publication event 与历史 A2A 关联；
不能只查新 batch Run 的 `task_id`，该字段可能本来就是 NULL。
投递失败需通过现有消息回执显示，不能只在日志记录后无限 waiting。

历史输入恢复需区分“已存在的证据供人核对”和“准备再次发送给模型”。
只读证据原样可用；需要再次投递的旧 Task 内容在关闭时不发送。
判定依据是对应格式的结构化 section/关联与保存的输入元数据，不搜索用户正文里是否出现 Task 单词。
同一 Run 的 Blob 不变；后续用户新指令创建的新 Run 使用新格式。
该负向路径是实现验收重点，不能以删除所有旧 Binding/Manifest 作为迁移捷径。

## 9. 合同与版本轴

基线的 public Formatter/Manifest 为 39、Profile 为 14、Run Facts 为 10；
non-batch 为 37/12/6；Bootstrap 为 5、Charter revision 为 23；
Built-in transport/command 为 41、Agent output 为 14、IPC 为 3。

| 轴 | 本方案处理 |
| --- | --- |
| Charter revision | 推进一个新 revision，所有状态共用文本 |
| Bootstrap wrapper/formatter | 形状不变，保持；平台索引描述与精确 bytes 按新文本冻结 |
| Native Binding compatibility | 保持，开关不进入兼容摘要，不强制换 Session |
| Public 与 non-batch Formatter/Manifest | 各推进新版本，记录 Task section 的能力条件；旧载荷仍用原版本解释 |
| Profile | 新版本记录 selector 规则改变；开启时上限仍为 8，不用 0 冒充关闭 |
| Run Facts | 对 `taskContext` 条件和单聊删除字段推进相应版本 |
| Built-in transport/command | 推进新版本，覆盖 context 能力字段、可用目录、Send Schema 与错误 |
| Agent output/IPC | Task 成功结果形状和 IPC framing 保持；是否需推进以最终字段差异核对，不能把新 Schema 冒称旧合同 |
| Read-side/Host | 为能力字段和可选 Task 投影推进对应当前 Schema/协议 |
| 数据库 | 仅增加配置及必要接口支持；不重建 Task 表，不改写旧快照与事件 |

具体新整数在正式说明中按合入基线分配，不预占并行工作的版本号。
当前权威同步范围包括 Durable Task、Built-in Transport、Context/Profile/Run Facts、Send、
Camp Open、Notification、Single Chat、Host Web、UI 与相应架构。
本稿阶段仅链接这些影响，不把当前合同提前改成已接受行为。

## 10. 实施顺序与验证

1. 确认本 R1 的语义与逐项文案，在当时 current 版本保存独立模型变更说明及确认记录。
2. 实现 Core 配置、业务准入与 Desktop/Web Host 路由；先证明关闭无法产生 Task 业务副作用。
3. 接入 CLI 能力视图、各级 help、有效 Schema 与旧客户端负向路径。
4. 统一 Bootstrap/Skill 教学，接入共用动态 selector、claim 预算与恢复检查。
5. 收敛读侧、任务卡/入口、通知、快捷键与客户端失效刷新。
6. 验证开启模式保真、真实上下文对照与升级恢复，再考虑发布。

已有相关测试位于 `context.rs` 的 self-active selection/empty/budget 场景、
`team_tool.rs` 的 Task 权限/幂等/不唤醒场景，以及 `delivery_queue.rs` 的 continuation Task links 场景。
实现时优先扩展现有行为测试，Rust 测试增删遵循
[准入与退役门槛](../development/testing.md#rust-测试准入与退役门槛)。

| 验收组 | 必须证明 |
| --- | --- |
| 默认与保存 | 新库、旧库无配置均关闭；忙时原值不变；两个客户端一致；同值保存幂等 |
| 发现与解析 | 根/family/operation help、目录/描述、Schema、错误表、直接参数与 JSON 输入一致；无 context/旧 context 不泄露 Task 目录；通用 Skill 无 Task 操作指导 |
| 服务端拒绝 | 旧 CLI、直接 IPC、四个领域入口与 Task-linked Send 无业务副作用，Replay 不能绕过 |
| 上下文 | on/off × 有/无任务 × 首轮/热续接/冷续接/Steer/补发/单聊；关闭时既无空 section，也不查 Task |
| 预算 | FIFO claim 与实际渲染共用选择结果，开关不改变完整用户输入和超限失败规则 |
| 存量 | Task 数据可恢复；旧未发送输入被明确阻断且不会造成重新开启死锁；accepted/unknown 不重放；继续执行检查全部关联 |
| UI/通知 | Desktop/Web/手机均无任务入口；旧焦点、快捷键、迟到请求不会恢复面板；计数与分页一致 |
| 数据生命周期 | 关闭时成员离队/永久移除/Thread 删除仍正确收口；重新开启没有悬空负责人 |
| 无关主路径 | 普通消息协作、Mission、Automation、审批、停止、附件和 Runtime-native plan/todo 保持 |

上下文与共享 `cli-operations` 改动适用
[12 Case 通用 Gate](../development/evaluation.md#上下文改动-gate)，在实施前冻结基线、候选、
Case、Judge、预算和判定标准。Task 关闭时的缺失能力按该模式解释，不能把“没有创建 Task”
自动算成协作失败；保留对实际分工、交接、结果和副作用的判断。
模型/Runtime/预算配置须在正式执行计划中明确，本提案不把尚未运行的评测写成通过。

本 R1 文档完成只代表方案可审阅；产品实现、真实 Runtime Gate、升级与 UI 验收均在确认后的实施阶段。
