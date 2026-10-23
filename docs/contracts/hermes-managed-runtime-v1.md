---
document_type: contract
name: Hermes Managed Runtime
version: v1
status: accepted
source_version: v1.72
last_updated: 2026-10-23
---

# Hermes Managed Runtime v1

`hermes-cli` 复用 [Runtime Launch v71](runtime-launch-and-verification-v71.md)、共享 ACP Host、Fleet、
Run 队列、Replay Quarantine、CLI lease 与 Explicit Send。以下补充只适用于 Hermes。

## 安装与进程

最低支持官方 source install **0.22.4**，不按 commit、dirty 状态或版本上界锁死。
`ROVAI_HERMES_BIN` 与通用启动设置选择入口。通过官方 `--print-runtime-command` 保留安装绑定的
绝对解释器、`-I` 与 bootstrap，只替换最终入口为 Core 私有 controller。不修改安装源码，不构造或覆盖
原生 Agent、SessionManager 和工具执行器。实际执行入口为未改写的 `hermes --profile default acp`
与 `hermes --profile default gateway run --force --no-supervise --external-supervisor`。

每个 binding 拥有私有持久 Hermes Home；每 Run 新建独占 Gateway、ACP viewer 和 controller，结束后
全部停止，下次精确冷恢复原 Session。Fleet/ManagedProcess 拥有整棵树，Core 启动也恢复 binding 目录的
owned-processes 记录。controller 独占 storage lock，并核对 Gateway 的 PID、Home 和 external supervisor；
禁止连接日常共享 Gateway，只结束 viewer 不算结束执行。
外部 supervisor 每次只启动一次、没有自动 respawn 循环；专用子进程通过官方
`HERMES_GATEWAY_MAX_STARTS=0` 关闭守护进程的重启风暴退避，避免正常连续 Run 被延迟至启动超时。

`_rovai/ready` 核对受管 revision、最低版本和 controller PID；Gateway 必须提供 durable admission、
event replay、ACP edit policy 与 session MCP 能力。未知 launcher、缺失能力或实际不兼容须明确失败；
最低版本策略不等于所有新版已验收。

私有 Home 使用选中原生 Home 的 config、`.env`、auth 与 Skills。auth 及其锁、已准备 installs、用户
Skills 连接到原生路径，Run 内禁用隐式依赖下载。相对 Skills 配置仍以原生 Home 为基准，变量按原生 dotenv
环境展开。私有 config 关闭消息平台、profile multiplex、auto-resume、cronjob、原生 memory 注入、
后台 memory review 和标题模型调用。SessionDB、控制 socket 与 Gateway 锁不共享。
原生配置/凭据与受管代码摘要参与兼容性；秘密不进入公开配置和日志，不借用其他 Runtime 的凭据。

## Session 与输入

`session/new` 返回原生 ID；`session/resume` / `session/load` 精确恢复。原生 not_found 映射为
`-32001`、`data.code=HERMES_SESSION_NOT_FOUND` 和目标 `data.sessionId`，只有对应恢复请求可触发
共享 Core 的目标丢失处理；不静默新建，不从错误文本猜测缺失。历史 replay 留在既有隔离阶段。
存在未结算执行、待处理 admission 或 permission 时拒绝新 prompt。

采用 Hermes 专属 `first_payload`：Core 为成员准备的完整 Bootstrap B 原样放在第一条实际普通任务
P 前，使用 `[Rovai 协作规则]` 分隔，同一次 `session/prompt` 提交；不增加确认调用。
规则变化使用“规则更新”块；原生压缩完成后的下一普通输入使用“规则恢复”块。准确字节见
[已确认 R1](../versions/v1.72/model-context-change-hermes-first-input.md)。B/P 的内容来源、Formatter 和共享选择不变。
这是 **user 层协作规则**，不提供 system/developer 层优先级。controller 不解析或覆盖 personality、
agent.system_prompt、HERMES_EPHEMERAL_SYSTEM_PROMPT；这些值继续由原生 Gateway 自行解析。

“首次”按 Native Binding/generation 对应的原生 Session 和 `runtime_input_delivery.status=accepted`
判断，进程重启不重复。完整 B 的 SHA-256 包含成员身份，下一普通输入接受后才推进已投递状态。
Hermes envelope v1 在既有输入账本增加 nullable `hermes_rules_envelope_version`、`hermes_rules_digest`、
`hermes_rules_delivery_kind`（initial/update/compaction_recovery/none）与 `hermes_runtime_payload_blob_id`。
最终正文复用 Managed Blob 冻结，引用随 prepared 原子持久化，并进入原有 request digest；恢复原字节。
prepared、dispatch、delivery_unknown 均不代替 accepted；未知原任务不得因补规则自动重放。
此处是 Hermes 对“完整身份不进入 Delivery digest/Blob”的明确例外，其他 Runtime 保持原合同。

官方 `post_compaction` Hook 只在私有 Home 配置，并只准入已提交、同 Session 的 `summarize`；
原生 Session 旋转、失败、started、其他 kind 不猜测为当前 Session 的完成事件。
通过既有 CLI observer、Host/relay lease、Binding/generation 与 outbox 去重产生 Redelivery Requirement。
下一条尚未物化的普通输入附带一份当前 B 和本次 P；Steer 不携带规则，也不消费 Requirement。
仅输入 accepted ACK 消费选定 revision，较晚完成事件保持 pending。**不保证当前 Run 内立即补回**，
不额外创建 Run、提示词调用或重放旧任务。通知不可用时不能宣称已恢复。

只依赖原生阈值自动压缩；`_rovai/compact` 返回不支持，不新增手动压缩按钮。
`_rovai/session_info` 的窗口、次数与历史条数只是观测，不作为补发信号；protect_first_n 不是永久保留保证。
每 Run 仍创建新的进程树并刷新 Built-in CLI lease，终端通过原生 env_passthrough 获得本 Run 的 ROVAI 环境。
旧 managed_system_prompt Evidence 保留原义；既有 Session 下一条新普通任务带一次更新，旧冻结输入不重写。
controller revision v4 删除 bootstrap 文件、system 注入、`_rovai/bind` 及仅用于重绑 B 的 Gateway 重启。
Ready 能力声明为 `context.charter.first_payload`、`context.compaction.signal_driven` 与
`context.compaction.best_effort`；不宣称 managed system 或 native system 保留。模型配置与结构化权限能力保留。
旧 Ready 快照在发现／检测入口失效为 installed_unverified，移除旧保证；下一次显式检测重新生成能力。
不因为 controller 升级而轮换原生 Session，也不把静态发现当成重新验证通过。

Steer 携带 Session、Core prompt ID 与 input ID。controller 在 prompt 前取得 replay 基线，关联唯一
message.start admission 与 execution generation，再调用公开 `session.steer`。只有 queued 且 generation
匹配才 ACK 接受；明确未投递、错轮、迟到和 idle 返回未接受。传输未知或不明结果不能伪造未送达。
取消调用同一 generation 的 `session.interrupt`，不能打断后继轮。共享 Core 拥有 epoch 与输入账本；
事件 epoch 变化、replay gap 或事件流失败不能编造成功终态。

ACP 终态不证明 controller 已消费 Gateway 通道。收尾先按同 epoch/sequence 回放未消费后缀，与实时
消费者共用去重投影；普通执行须已关联 admission、消费 message.complete 前的工具/文件证据，并核对
同 Session/admission/generation 的 terminal receipt，才能释放 active。明确未提交的原生拒绝、取消或
已答复控制命令在无新 generation、无待结算执行时单独收尾；普通 end_turn 缺少执行归属不能算成功。
无法确认执行归属的错误标记 `HERMES_EXECUTION_UNCERTAIN`；Core 不把它声明为可安全重发的未接受输入。

## 用户明确处理未知执行

controller revision v5 增加独立的用户维护入口。Core 已失败收口、旧进程清理确认后，用户可在普通终端执行：

```sh
rovai app agent-run hermes-inspect --agent-run-id <原中断任务ID> > hermes-inspection.json
cat hermes-inspection.json
rovai app agent-run hermes-discard --inspection-file hermes-inspection.json --acknowledge-effects
```

App 必须已运行。首条只查询原会话 snapshot 与精确 `prompt.receipt`；返回执行身份与警告：
**原任务可能已产生文件修改、公开消息或其他外部效果**。确认文件含 Run/version/epoch、Thread/member、
当前 binding/generation、原生 Session/admission/execution generation；不含业务正文、凭据或原始历史。
没有唯一 unknown 时不提供确认对象。Agent 受管进程继续禁止 `rovai app`，不开放 Built-in Tool 代确认。

第二条须显式 acknowledgeEffects，Core 重验来源、绑定、成员及清理状态，先持久化用户意图，再启动
Fleet 拥有的一次性控制进程。该进程复用原 binding 的持久 Home，不创建 Run、CLI lease、Session 或
`session/prompt`，不通过普通恢复的 idle gate 投递 `/discard` 文本。普通任务的恢复检查保持不变。
任何 running、permission、queued 或多个 unknown 均拒绝处理；不顺便释放另一个原生排队任务。

确认后再次查询精确 receipt：已有 terminal 时只报告原生事实；仍为同一 unknown 时调用官方
`prompt.resolve_unknown(session_id, admission_id, execution_generation)`，再核对 terminal receipt
与空闲 Session。官方可能保存同 owner 已捕获的结果，或把丢失执行标为 interrupted；Rovai 不伪造
completed，不把旧 Run 改为成功。用户意图和原生结果分别写入既有 Command 账本，历史输入与效果证据保留。
响应未知时复用原确认文件，按相同身份重查／幂等处理，不能生成新任务或挑选“最新 admission”替代。

进程树回收确认后，用户可在原 Thread 发送一条**新的任务**，沿普通路径恢复原 Session 和新的 CLI lease。
此操作不点击“继续执行”、不创建 continuation Delivery，也不改其他 Runtime 的共享 continuation 会话选择。
当前产品入口为 User CLI，没有新增聊天按钮；普通聊天文本 `/discard` 不能替代它。

## 模型、权限、Skills 与 MCP

目录来自官方 ACP model state。model 设置调用 `session/set_model`，重新读取并核对实际选择。
reasoning_effort 选项来自原生 `route_supported_efforts`，设置调用 revision/generation 约束的
`session.mutate(reasoning)` 并核对 ACK。runtime_default 跟随原生配置，显式值只作用于 Session；
模型按原生能力处理强度，不制造 Fast 开关，未知 config ID 拒绝。

`default / accept_edits / dont_ask` 是文件编辑策略，设置后核对 session.info。它不代替命令审批，也不是
OS sandbox；CoreEnforced read-only 工作区拒绝启动。私有 config 强制禁用 clarify toolset，从模型工具
列表排除问卷，不自动代答。

Skills 索引遵循原生 Home 的 skills、create_dir、external_dirs 与禁用列表。`~/.agents/skills` 必须显式
加入 external_dirs；最近 Git 根的 `.hermes/skills`、`.agents/skills` 只在 project discovery 开启且该根
受信时采集。设置页仅用户来源，Thread 候选可含受信项目来源；保留路径身份，不把索引存在当成实际加载。
仅在原生 `.env` 定义的目录变量尚无 Rust 索引等价保证。

MCP 使用官方 ACP editor assignment 与公开 `session.mutate(editor_mcp)`；后者核对实际发现的 server
名称，原生 partial discovery 不能静默当作全部成功。空 assignment 显式撤销，因为原生 ACP load 空列表
本意是保留。变更/撤销沿 Core compatibility 创建新 Host，恢复原 Session 后重绑。一个 controller
仅接纳一个 Session。Gateway 启动前从私有 config 排除 Rovai assignment 同名的原生 MCP，其他原生服务
保留，源 config 不变。工具可能经 tool_search/tool_describe/tool_call 延迟发现，不能只检查直接 tools 数组。

## 结果与观测

官方 ACP 保留模型内容和 permission 传输；公开 Gateway 的精确 admission/generation 事件补齐工具
raw input/result 和原生 inline diff，过滤 ACP 编辑预览与重复工具更新。原生错误终态和对应 prompt
receipt 的脱敏有界详情进入 JSON-RPC data.error，不把失败包装成 end_turn。

文件证据只来自成功完成的 native result。patch 的实际 diff 或 write_file 的原生 inline diff 经成功、
路径一致、完整 hunk 和大小检查后投影为 reported_mutation 片段。解析先消费 hunk 剩余行数，再识别
下一文件头和原生段间空行；删除 `-- heading` 产生的 `--- heading` 是内容行。每工具最多 64 路径、diff 最多 2 MiB；
截断、NUL、未知路径、失败、no-change 不准入。禁止扫描磁盘/Git 补证，禁止升级为完整 before/after。
显示层可能规范化 CRLF，不能证明缺失文件与空文件的区别；move/空文件没有文本片段时只保留操作和结果。
历史 hermes_file_states 继续可读，当前入口不再生产它。

原生 usage 是 Session 累计，按每 prompt 前后基线求差；cache read 计入输入总量。仅同 admission/
generation 的原生 usage 事件参与该 prompt 消耗，terminal receipt 确认归属。成功由 result.usage 传递；
失败由受管错误中的精确执行证据传递，Core 核对 pending Session/prompt 后在同一终态入账一次，Run 仍失败。
usage_update 保持上下文 gauge，不能替代消耗账本。缺失 cache write、费用或请求数保持未知。
ACP 图片原样交给原生媒体流程；pixels/预解析选择及识图效果由 Hermes 配置和模型决定，不能仅凭
image=true 宣称具体模型的识图验收通过。

## 准入

macOS arm64 为 Preview，其他平台 Not Qualified。Ready 只证明当前安装/认证/协议探测。
能力证据与限制见 [Hermes 验证记录](../research/hermes-runtime/README.md)。Migration 214 / projection
schema 164 扩展 Runtime、Skill group 闭集；Migration 215 / schema 165 仅增加 nullable Hermes 输入证据，保留既有 Run、Binding、成员、输入与历史。
