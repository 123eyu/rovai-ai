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

采用 ManagedSystemPrompt。Core prepared Bootstrap B 随 Run 启动写入私有文件，再由
`HERMES_EPHEMERAL_SYSTEM_PROMPT` 传给新 Gateway，与原生 overlay 并存。`_rovai/bind` 核对 Session、
B 原文与 SHA-256，128 KiB 上限；空值、摘要不符和活动执行拒绝。ACK 匹配才发送 P；P 保持原始普通
输入，不重拼 Profile、不提升 RUN_INPUT 权限，不把 B 写入用户 Home 或聊天历史。
Probe 的晚绑定会重启 Gateway 并恢复同 Session；生产在启动时提供 B，不需要这次额外重启。

每 Run 冷启动同步更新 B 与 Built-in CLI lease；终端通过原生 env_passthrough 获得本 Run 的 ROVAI 环境。
禁止暖 Gateway 只换 viewer 却保留旧 B/lease。不改变共享 B/P 文案、选择、Formatter、Manifest 或版本。
只依赖原生阈值自动压缩；`_rovai/compact` 返回不支持，不新增手动压缩按钮。
`_rovai/session_info` 只读窗口、压缩次数与历史条数；尚未建立模型状态时窗口可未知。系统 overlay
在 API 调用层生效，不因压缩丢失。

Steer 携带 Session、Core prompt ID 与 input ID。controller 在 prompt 前取得 replay 基线，关联唯一
message.start admission 与 execution generation，再调用公开 `session.steer`。只有 queued 且 generation
匹配才 ACK 接受；明确未投递、错轮、迟到和 idle 返回未接受。传输未知或不明结果不能伪造未送达。
取消调用同一 generation 的 `session.interrupt`，不能打断后继轮。共享 Core 拥有 epoch 与输入账本；
事件 epoch 变化、replay gap 或事件流失败不能编造成功终态。

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
路径一致、完整 hunk 和大小检查后投影为 reported_mutation 片段。每工具最多 64 路径、diff 最多 2 MiB；
截断、NUL、未知路径、失败、no-change 不准入。禁止扫描磁盘/Git 补证，禁止升级为完整 before/after。
显示层可能规范化 CRLF，不能证明缺失文件与空文件的区别；move/空文件没有文本片段时只保留操作和结果。
历史 hermes_file_states 继续可读，当前入口不再生产它。

原生 usage 是 Session 累计，按每 prompt 前后基线求差；cache read 计入输入总量。终态 usage 用于消耗
账本，usage_update 保持上下文 gauge。缺失 cache write、费用或请求数保持未知。
ACP 图片原样交给原生媒体流程；pixels/预解析选择及识图效果由 Hermes 配置和模型决定，不能仅凭
image=true 宣称具体模型的识图验收通过。

## 准入

macOS arm64 为 Preview，其他平台 Not Qualified。Ready 只证明当前安装/认证/协议探测。
能力证据与限制见 [Hermes 验证记录](../research/hermes-runtime/README.md)。Migration 214 / projection
schema 164 仅扩展 Runtime、Skill group 闭集，保留既有 Run、Binding、成员与历史。
