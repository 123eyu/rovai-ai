---
document_type: implementation-proposal
authority: proposed-task-capability-design
status: proposed
revision: 2
confirmation_status: pending
implementation_status: not_started
review_baseline: 81bb808c72721f67e2f07ead49fa4aca2ad64c02
last_updated: 2026-10-16
---

# 会话 Task 能力开关方案

推荐采用一个 Core 持久管理、默认关闭的实例级开关。Bootstrap 与平台 Skill 的通用教学统一去掉
Task 专用内容；动态上下文、CLI 发现与解析、业务准入、客户端投影分别读取同一个能力状态。
开启后仍提供现有 Task 工作流和数据，关闭后保留数据但不提供 Task 功能。

本稿是待审阅的 R2 提案，尚未修改实现、Schema 或当前合同。当前版本从
[版本索引](../versions/README.md)解析。后续确认实施时，将本稿确认过的完整模型输入对照和兼容规则
纳入该版本独立的 `model-context-change-task-capability.md`，记录确认的 revision，再进行编码；
本稿不代替[模型上下文变更治理](../development/model-context-change-governance.md)。

## 上下文审阅方式

每个改动项均列出“变更前、变更后、说明”。“变更前”来自 `review_baseline` 的源码，
不是上一版提案；示例 ID 仅代替真实数据。写明“删除/不输出”表示对应字节不存在，不是向模型发送这几个字。
Bootstrap 用 B 编号，动态上下文用 D 编号，CLI 用 C 编号，Skill 用 S 编号。

R2 补齐逐项对照，并将 R1 的 Task family help 新增教学从七行压为两行。
提示词只保留会改变操作选择的规则；字段、权限与状态细节留在精确命令帮助，不重复放入通用上下文。
不新增“Task 已关闭”、开关原因或内部实现说明；同一项教学只维护一个文本来源。

## 方案选择

| 项目 | R2 建议 |
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

### B01：Charter 的职责句

变更前：

```text
- The User owns the Thread objective. The User or current Default Lead defines Task responsibilities; other Agents execute assigned Tasks.
```

变更后，开启/关闭共用：

```text
- The User owns the Thread objective. The User or current Default Lead coordinates member responsibilities.
```

说明：保留 User 的目标权威和 Lead 的分工职责，删除对 Task 对象的依赖。
来源：[context.rs](../../crates/rovai-core/src/context.rs) 的 `build_session_charter`。

### 完整替换后的公开基础 Charter

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

渠道与 Mission 后缀、Single Chat 专用 Charter、身份保持。
平台 Skill 索引的 `cli-operations.desc` 使用 S01 的同一描述；索引形状与顺序不变。

Task 开启时，用户/Lead 的创建权限、Assignee 的更新权限、状态规则由 Task help 和 Core 授权表达。
通用 Charter 不需要重复这些操作规则。

### B02：Memory Entrypoint 的关系条目选择

来源：`context.rs::load_memory_counterparty_order`。这是选择规则变化，不是新增提示词。

| 变更前 | 变更后 | 说明 |
| --- | --- | --- |
| 关系对手方优先级：A2A 来源 → 当前 Task 的 assignee、Agent 创建者 → 本轮参与者 → Default Lead → 按成员顺序兜底；去重且仅保留当前成员 | 开启时保持；关闭时跳过 Task 查询与该优先级组，其余组顺序不变 | Task 不再隐式影响关闭模式的关系 Memory 选择 |
| 每个关系对手方最多 12 条，按上述组序轮转选出共 24 条；Hearth 最多 16 条、Companion 最多 32 条 | 数量、条目内部排序与轮转算法保持；只有移除 Task 优先级可能改变关系条目顺序或最终入选项 | 明确这会影响选择结果，不把它误写成“Memory 内容完全不变” |

Memory 条目的内容、访问授权、表格 shape、末尾发现提示和空索引提示不变，不删除用户 Memory。
新 Run 采用上述规则，同一 Run 的已冻结索引保持原样。

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

### D01：公开输入的 SELF_ACTIVE_TASKS

变更前，有活跃任务且能放入预算时：

```text
[SELF_ACTIVE_TASKS]
{"tasks":[{"taskId":"task_example","title":"验证改动","status":"in_progress"}]}
[/SELF_ACTIVE_TASKS]
```

变更后：关闭时整个区段不输出；开启时保留上述 shape 和选择规则。
说明：直接消除新输入中的 Task 责任，不添加替代提示词。

同一改动的边界逐项如下：

| 情形 | 变更前 | 变更后 | 说明 |
| --- | --- | --- | --- |
| 有候选且预算足够 | 当前 Thread、本 Agent 的 `pending/in_progress/blocked` Task，按 `updated_at DESC, id DESC`，最多 8 项 | 开启保持；关闭不查询、不输出 | 条目只含 `taskId/title/status`，不开启详情自动注入 |
| 无活跃任务 | `[SELF_ACTIVE_TASKS]` 内为 `{"tasks":[]}` | 开启保持；关闭连空 section 一并删除 | “没有任务”与“不提供任务能力”不是同一状态 |
| 还有未入选任务 | 部分入选时附 `omittedCount`，值为未入选数量；数量为 0 时省略该字段 | 开启保持；关闭连 section 一并删除 | 不留下 Task 遗漏提示 |
| 预算淘汰所有候选 | 整个 section 省略 | 开启保持；关闭不进入 Task 选择与淘汰 | 保持开启模式的原有省略含义 |

### D02：Single Chat 的空 Task 区段

变更前，共用物化路径把单聊的 `(空任务, 0 遗漏)` 渲染为：

```text
[SELF_ACTIVE_TASKS]
{"tasks":[]}
[/SELF_ACTIVE_TASKS]
```

变更后：无论全局开关如何，整个区段不输出。
说明：单聊本来没有 Task 操作，去掉无用区段，不改变权限。

### D03：Run Facts 的 taskContext

变更前，旧 A2A 路径有 Task 关联时，在 `RUN_FACTS` 中包含下面的完整字段；其他字段不在此示例展开：

```json
{
  "taskContext": {
    "taskId": "task_example",
    "referenceMode": "frozen",
    "laterChangesRetargetRun": false
  }
}
```

变更后：关闭时删除 `taskContext` 字段，不输出 `null`；开启时沿用原有条件与内容。
说明：不再从新 Run Facts 提供 Task locator。公开 batch 通常原本就不含此字段，保持省略；
关闭时 Task-linked 执行还会在准入处被阻止，不是只删除字段后继续执行。

### D04：Single Chat 的 taskMutationAllowed

变更前，`RUN_FACTS.singleChat` 完整对象为：

```json
{
  "kind": "single_chat",
  "visibility": "principal_only",
  "responseDelivery": "single_chat_message",
  "operationPolicy": "single_chat_v1",
  "threadPublicationAllowed": false,
  "memberDispatchAllowed": false,
  "taskMutationAllowed": false,
  "memoryMutationAllowed": false
}
```

变更后，无论全局开关如何，该对象为：

```json
{
  "kind": "single_chat",
  "visibility": "principal_only",
  "responseDelivery": "single_chat_message",
  "operationPolicy": "single_chat_v1",
  "threadPublicationAllowed": false,
  "memberDispatchAllowed": false,
  "memoryMutationAllowed": false
}
```

说明：仅删除 Task 专用禁用字段。其余字段和单聊 operation policy 保持，不新增单聊能力。

### D05：选择、预算和已冻结输入

| 项目 | 变更前 | 变更后 | 说明 |
| --- | --- | --- | --- |
| 新公开输入的 Task 选择 | 每次 prepare 选择 Task，claim/FIFO 预算与渲染使用该结果 | 关闭时选择结果明确为“不提供”；开启保持原结果；普通启动与 Steer 共用 | 防止 claim 算了一种输入、实际发送另一种 |
| 容量计算 | Task bytes 参与完整 payload 预算，可能被逐项淘汰 | 关闭时 Task bytes 为零；仍按真实完整 payload 决定 FIFO 能装下多少消息 | 容量上限和完整用户消息规则不变，实际可领取数量可能变化 |
| 新 Run 的材料 | 新 Run 读取当前模板和当时事实 | 新 Run 读取统一模板和当时能力选择 | 不复制旧 Run 的 Task 区段 |
| 同一 Run 的既有冻结载荷 | 恢复使用保存的原字节，accepted/unknown 不自动重发 | 原字节不改；关闭时，尚需发送的旧 Task 载荷按第 8 节阻断；accepted/unknown 沿原结算规则 | 不裁剪历史 Blob，不把开关当作重放许可 |

来源：`DynamicInputContext::prepare`、`ClaimedBatchContext::payload_len`、
`self_active_task_projection`、`build_run_facts` 与最终 formatter。
上面的“关闭、不提供、阻断”等词仅解释实现行为，不进入模型输入。

必须区分三种内部状态：能力关闭、开启但没有候选、开启但预算淘汰。建议用
`Option<SelfActiveTaskProjection>` 配合明确的选择原因表达；不能只清空 `Vec`，因为当前
`self_active_task_projection([], 0)` 会重新生成空 section。
也不要把 `maxSelfActiveTasks` 改成 0：当前 Profile 要求它为 8，功能状态不是容量上限。

保留最终动态输入 Managed Blob 与必要来源；不恢复已经退役的 Task evidence JSON、
独立 digest、Profile JSON 或另一套输入副本。历史已物化载荷不重算，详见第 8 节。

`COLLABORATION_STATE`、`WORKSPACE`、`RUN_INPUT`、额外 Skill 索引以及 Run Facts 中未列出的字段，
内容、顺序和选择规则不变；`ROVAI_PLATFORM_SKILLS` 的描述改动单列于 S01。

## 4. CLI help 与执行入口

### 当前问题及推荐控制位置

[bin/rovai.rs](../../crates/rovai-core/src/bin/rovai.rs) 目前先处理根 help、Task family help、
operation help，再调用 `load_context()`。仅在 Router 拒绝操作不会改变这些帮助。
[工具目录](../../crates/rovai-core/src/builtin_tool_transport.rs) 的 `OnceLock` 缓存也是全量静态目录。

`BuiltinToolCliContext` 的控制字段对照如下，它不属于发送给模型的 section：

| 变更前 | 变更后 | 说明 |
| --- | --- | --- |
| 无 Task 能力字段，help 使用全量目录 | 增加 Core 生成的 `tasksEnabled: boolean`；缺失或不可信时按 `false` 展示 | 控制发现与解析，不在 Bootstrap 或动态输入中教模型识别这个布尔值 |

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

### C01：根 help 的 Task 行

| 变更前 | 变更后 | 说明 |
| --- | --- | --- |
| `rovai task create\|get\|list\|update` 始终出现在 Agent operations | 关闭时删除这一行；开启时原位置保留 | 关闭时不提供 Task 发现入口，不添加禁用说明 |

关闭后的完整根 help：

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

### C02：四个 Task operation 的发现与精确 help

来源：`builtin_tool_transport.rs` 与 `team_tool_catalog.rs`。下表逐个列出入口；
开启模式的描述、参数和成功结果 Schema 不改写，关闭模式不返回这些内容。

| 入口 | 变更前 | 变更后 | 说明 |
| --- | --- | --- | --- |
| `team.create_task` / `rovai task create --help` | 全量目录可发现，可读创建 help | 关闭时从目录省略，help 不返回说明/Schema；开启保持 | 不教学创建操作 |
| `team.get_task` / `rovai task get --help` | 全量目录可发现，可读详情 help | 关闭时从目录省略，help 不返回说明/Schema；开启保持 | 不教学读取操作 |
| `team.list_tasks` / `rovai task list --help` | 全量目录可发现，可读列表 help | 关闭时从目录省略，help 不返回说明/Schema；开启保持 | 不教学枚举操作 |
| `team.update_task` / `rovai task update --help` | 全量目录可发现，可读更新 help | 关闭时从目录省略，help 不返回说明/Schema；开启保持 | 不教学更新操作 |

关闭时直接请求这些 help 返回 C10 的现有 CLI 短错误，不输出开启方法。

### C03：Send 的 taskId / --task-id

变更前，Send Schema 的 `properties.taskId` 完整内容为：

```json
{
  "type": "string",
  "minLength": 1,
  "description": "Optional current Task link; exactly one effective recipient is required."
}
```

CLI 参数表提供 `--task-id`，当前没有为它追加专用参数说明。

变更后：关闭时删除整个 `properties.taskId` 与 `--task-id` 参数行；开启时该 Schema 字段为：

```json
{
  "type": "string",
  "minLength": 1,
  "description": "Link a current Task assigned to the sole Agent recipient. Invalid with --public-only; User attention does not count."
}
```

开启时 CLI 在 `--task-id` 行下输出同一段 description，不维护第二套措辞。
说明：Task 关联限制集中在自己的参数入口，通用 public-only 帮助不再重复 Task 规则。
来源：`team_tool.rs::camp_message_send_input_schema` 与 `bin/rovai.rs` 参数渲染。

Send CLI 保持现有的 direct flags 或 `--input-file` 正文文件加发送 flags，不新增 JSON stdin
或完整 JSON 文件入口。关闭时拒绝 `--task-id`；旧客户端/手写 IPC 的 JSON 请求按相同能力校验，
包含 `taskId` 即拒绝，即使值为 `null` 也不能默默忽略。
字段存在性检查在解码为 `Option` 之前执行，不能让显式 `null` 与缺字段合并后绕过这条规则。

### C04–C06：Send 的通用教学

来源：[camp_message_send_teaching.rs](../../crates/rovai-core/src/camp_message_send_teaching.rs)。
开启/关闭共用以下变更；help 仅替换表中列出的段落，其余段落保持。

| 项目 | 变更前 | 变更后 | 说明 |
| --- | --- | --- | --- |
| C04 · User attention help 末段 | `It creates no Agent Delivery, does not represent approval, and may be combined with --public-only. User attention is message-local and is never inherited by replies, Tasks, or downstream A2A work.` | `It creates no Agent Delivery, does not represent approval, and may be combined with --public-only. User attention is message-local and is never inherited.` | 删除继承对象的枚举，保留注意力仅属于本消息的规则 |
| C05 · public-only help 末段 | `Do not combine this option with --to or --task-id. It may be combined with --to-user.` | `Do not combine this option with --to. It may be combined with --to-user.` | Task 互斥规则移到 C03；其他寻址规则不变 |
| C06 · public-only Schema 完整 description | `Guarantee that this public Thread message addresses no Agent. When true, explicit Agent recipients and taskId are invalid, effectiveRecipients and deliveryIds are empty, and no Agent is woken. This may be combined with mentionUser because User attention is not Agent routing.` | `Guarantee that this public Thread message addresses no Agent. When true, explicit Agent recipients are invalid, effectiveRecipients and deliveryIds are empty, and no Agent is woken. This may be combined with mentionUser because User attention is not Agent routing.` | Schema 中同样删除 Task 专用枚举，保持回执与 User attention 语义 |

真实业务仍执行 public-only 与 Task 关联互斥；删掉重复教学不改变校验。
正文、附件、文件输入选择、发送结果和用户注意力规则保持。

### C07：Send 描述中的 Task 错误目录

| 变更前 | 变更后 | 说明 |
| --- | --- | --- |
| `builtin_tool_description` 的 `errors` 包含 `message.task_recipient_ambiguous` 与 `message.invalid_task`，两者 recovery 均为 `fix_input` | 关闭时删除这两项；开启保持；其他错误条目不变 | 关闭后的可发现描述不再暴露 Task 校验细节；服务端仍识别历史错误 |

这里调整的是可发现的错误目录。旧请求主动调用被禁能力时，仍会得到第 6 节的短错误，不伪装成成功。

### C08：Automation 描述中的术语

| 变更前 | 变更后 | 说明 |
| --- | --- | --- |
| `automation.list` 描述尾句：`This read does not run or modify a task.` | `This read does not run or modify an Automation.` | 明确描述的是 Automation，其功能和其他文案不变 |

### C09：Task family help

变更前，完整 `rovai task --help` 为：

```text
rovai task

  create  Create a durable task.
  get     Read task details.
  list    List task summaries.
  update  Update an existing task.

Use rovai task <command> --help for arguments.
```

变更后，关闭时不输出此帮助；开启时完整文本为：

```text
rovai task

Use Tasks for responsibility that spans Runs and needs independent handoff or acceptance.
Use messages for one-time coordination. Update Task state before a required handoff, request or result.

  create  Create a durable task.
  get     Read task details.
  list    List task summaries.
  update  Update an existing task.

Use rovai task <command> --help for arguments.
```

说明：只增加“何时用 Task”和“交接前维护状态”两行。复用已有 Task、权限、字段与“不自动唤醒”
已经由 create/update/list 精确帮助拥有；Send 的单一接收者规则由 C03 拥有，不在这里复述。
S12 列出原 reference 每条规则的去向，避免缩短文案时丢失必要行为。

### C10：直接请求禁用能力时的错误文本

这两种错误只回应实际请求，不主动注入上下文。

| 位置 | 变更前 | 变更后 | 说明 |
| --- | --- | --- | --- |
| 新 CLI 的 Task family/operation help 或执行入口 | help 返回当前帮助；执行请求按原规则解析 | 关闭时退出码为 2，返回下方现有 CLI 错误 | 不提供 Task 教程，也不增加一套错误提示词 |
| Core 收到 Task 操作或带 Task 字段的旧客户端请求 | 按原领域规则执行，合法请求返回业务结果 | 关闭时返回下方领域错误，禁止本次业务副作用 | 能识别被禁能力，不引导 Agent 修改设置 |

关闭后的 CLI 返回体（复用 `bin/rovai.rs::print_safe_cli_error`）：

```json
{"error":{"code":"builtin_tool.cli_error","message":"Built-in Tool request could not be completed.","recovery":"stop"}}
```

关闭后的 Core 错误经 Agent 输出投影为：

```json
{"error":{"code":"task.feature_disabled","message":"Task operations are unavailable.","recovery":"stop"}}
```

其他错误和开启模式的成功输出保持原合同。领域拒绝和历史回执的边界见第 6 节。

## 5. 平台 Skill 使用一套通用文本

### S01：cli-operations 的 description 与 Bootstrap 索引

变更前，`skills/cli-operations/SKILL.md` 的完整 description 为：

```text
Choose among Rovai messages, Tasks, Missions, history and Memory; coordinate parallel member requests, multi-step operations or recovery. For one known operation, use its command help directly.
```

变更后，开启/关闭共用：

```text
Choose among Rovai messages, Missions, history and Memory; coordinate parallel member requests, multi-step operations or recovery. For one known operation, use its command help directly.
```

说明：只删去 `Tasks, `。Bootstrap 的
`ROVAI_PLATFORM_SKILLS.skills[name="cli-operations"].desc` 从同一 front matter 读取这段新文字，
`root/name/skills` 结构及其他 Skill 描述保持，不增加能力状态字段或另一份描述。

### S02–S11：通用 Skill 的逐项删改

下面均是开启/关闭共用的完整句子或完整段落替换；未列出的内容保持。
路径以 `skills/` 为根，未写 Skill 名前缀的 reference 属于 `cli-operations/`。

| 项目与位置 | 变更前 | 变更后 | 说明 |
| --- | --- | --- | --- |
| S02 · `cli-operations/SKILL.md` 选择表 | `Responsibility that survives Runs and can be handed off and accepted independently` → `Task` | 删除这一行 | 通用选择表不再引导创建 Task |
| S03 · 同文件选择表后 | `Choose the smallest object that fully serves the request. Tasks own durable responsibilities; project sources and history own their facts.` | `Choose the smallest object that fully serves the request. Project sources and history own their facts.` | 删除 Task 定位，保留最小对象与事实来源规则 |
| S04 · 同文件 References | `[Task](references/task.md): durable responsibility and Task-linked messages.` | 删除这一项 | 不留下被退役文件的入口 |
| S05 · `references/send.md` attention 段首句 | `Attention belongs to this message; replies, Tasks and downstream work do not inherit it.` | `Attention belongs to this message and is not inherited.` | 用一句通则替代对象枚举 |
| S06 · 同文件一次性协作段 | `A one-time answer, update, question or request uses a message. Use a [Task](task.md) only for durable, independently transferable responsibility. A Task-linked Send requires exactly one effective Agent recipient; User attention does not count.` | 删除整个段落 | 消息用法已在本页开头；Task 选择和关联规则分别由 C09、C03 拥有 |
| S07 · `references/mission.md` 定位句 | `A Mission owns the shared objective; a Task owns independently transferable responsibility. Do not automatically create a duplicate Task. Edit only the established objective and requirements.` | `A Mission owns the shared objective. Edit only the established objective and requirements.` | 仅保留 Mission 职责，不教学另一种对象 |
| S08 · `references/memory.md` 权威句 | `Tasks, temporary plans, project facts and historical evidence belong to their existing authoritative sources.` | `Temporary plans, project facts and historical evidence belong to their existing authoritative sources.` | 保留临时计划与项目事实不应进入 Memory 的边界 |
| S09 · `cli-operations/agents/openai.yaml` 的 `short_description` | `在 Send、Task、检索与 Memory 之间选择并安全协调` | `消息、Mission、检索与 Memory 操作` | 同步资源元数据，用短语表达用途 |
| S10 · `memory-stewardship/references/authority-and-safety.md` 适用条件 | `belong in Memory rather than Tasks, history, project documents, code, tests, approval or audit records;` | `belong in Memory rather than history, project documents, code, tests, approval or audit records;` | 只删除 Task；下文已有临时进度排除规则，不另造替代对象名 |
| S11 · `memory-stewardship/references/content-and-keys.md` 示例 | `Agreement: Include the goal, verified state, evidence, open issues and next action in durable Task handoffs.` | `Agreement: Include the goal, verified state, evidence, open issues and next action in handoffs.` | 保留交接内容要求，不绑定 Task 对象 |

### S12：Task reference 退役及规则去向

变更前，`skills/cli-operations/references/task.md` 完整正文为：

```markdown
# Task

Create a Task only for responsibility that needs tracking across Runs and independent handoff or acceptance. Use ThreadMessage for brief coordination, answers, progress and questions.

Choose an operation with `rovai task --help`, then read its exact help. Reuse an existing Task where possible; put scope and requirements together in `description`.

Decide from current Task state; read it when the needed information is missing or stale. Submit only the fields you intend to change.

Tasks preserve responsibility; messages communicate it. Bring the Task to the appropriate state before publishing a required handoff, request or result. A Task-linked Send requires exactly one effective Agent recipient; User attention does not affect that count.
```

变更后：从当前官方发布集合删除这个文件，所有开关状态一致。
说明：规则放在能实际使用该能力的入口；关闭时不再发布独立 Task 教程。

| 原规则 | 变更后的唯一主要入口 | 简短说明 |
| --- | --- | --- |
| Task 与一次性消息如何选择；交接/请求/结果前维护状态 | C09 的两行 family help | 保留使用决策与交接纪律 |
| 先发现命令、再读精确 help | `cli-operations/SKILL.md` 首段，保持原文 | 已有通用规则，无需再迁入一遍 |
| 复用已有 Task；范围和要求放入 `description` | 已有 create help 与 create/update 参数帮助，保持原文 | 与操作参数放在一起 |
| 需要时读取当前状态；只提交要修改的字段 | Skill 的 `Read the authoritative state needed for the decision.` 与已有 get/update help，保持原文 | 不强制每次重复读取 |
| 关联 Send 只有一位 Agent 接收者，User attention 不计入 | C03 的 `taskId` 参数说明 | 一个参数拥有完整关联约束 |

### 受管文件同步

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
恢复动作 `stop`。CLI 提前拒绝时复用 C10 的现有短错误；
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

1. 确认本 R2 的语义与逐项文案，在当时 current 版本保存独立模型变更说明及确认记录。
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

本 R2 文档完成只代表方案可审阅；产品实现、真实 Runtime Gate、升级与 UI 验收均在确认后的实施阶段。
