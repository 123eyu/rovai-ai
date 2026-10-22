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
Run 队列、Replay Quarantine、CLI lease 与 Explicit Send。以下补充只适用于 Hermes；其他 Adapter 的行为不变。

## 安装与进程

支持官方 source install 0.22.4 / commit `4d04303818b61bf3aa09278af48356315515965b`，拒绝 dirty source、
其他版本及无法解析的 launcher。`ROVAI_HERMES_BIN` 和 Runtime 通用启动设置可选择入口。
调用选中 launcher 的 `--print-runtime-command`，保留它的绝对解释器、`-I` 与 native bootstrap，
仅替换已知的最终 module entry，执行 Core 私有目录内的受管 Host。禁止安装时以外的隐式依赖同步。

Host 使用同发行物的 `HermesACPAgent(SessionManager())` 与真实 `AIAgent`，不启动共享 Gateway。
`_rovai/ready` 必须返回匹配的 revision、精确 source commit 和实际 child PID。Fleet 拥有这一执行进程及其树。
原生 Home、模型、认证、工具和 SessionDB 由 Hermes 负责；Adapter 不读取其他 Runtime Home 获取凭据。
原生 `.env`、config、auth 及受管代码摘要参与兼容性；秘密只进入摘要，不作为公开配置或日志内容。

## Session 与输入

`session/new` 返回原生 ID；`session/resume` / `session/load` 必须精确恢复。缺失时返回
`-32001` 与 `data.code=HERMES_SESSION_NOT_FOUND`、精确 `data.sessionId`，只有关联恢复请求才允许
共享 Core 判定恢复目标丢失。不接受静默新建，不从错误文本推断缺失。原生 replay 留在既有隔离阶段。

采用已有 ManagedSystemPrompt 投递模式。`_rovai/bind` 接收本 Run 的 Core prepared Bootstrap 原文、
Session ID 与 SHA-256，128 KiB 上限；空值、摘要不符、Session 不存在或忙碌均失败。成功回执必须匹配
revision、ID、摘要；随后才允许普通 `session/prompt`。B 进入 native `ephemeral_system_prompt`，
P 仍为原始普通输入，不重拼 Profile、不升级 RUN_INPUT 权限、不将 B 写入用户 Home 或原生聊天消息。

每次绑定替换旧 B，模型重建重新应用当前绑定；原生系统 overlay 在 API 调用时生效，压缩不移除。
禁用本受管进程的原生 memory 注入、后台 memory review 和后台标题模型调用，Rovai 的既有记忆入口继续来自 Core B。
不修改共享 B/P 文案、选择规则、Formatter、Manifest 或 Delivery Profile 版本。

`_rovai/compact` 是私有结构化原生压缩入口；只在 idle Session 执行，成功保持 ACP ID，取消不提交
新 history 并要求回收 Host。它不是 ACP 标准方法，本轮不增加产品手动压缩按钮；不把 slash 回复当成功证据。

## 模型、权限与 MCP

目录来自原生 ACP model state。`session/set_config_option(model)` 由受管桥调用原生
`set_session_model` / resolver，并返回实际 config state；Core 核对请求值，不接受原生通用配置的空 ACK。
其他未实现的 config ID 拒绝。Reasoning 暂依原生配置；不制造 effort/Fast 选项。

原生 `default / accept_edits / dont_ask` 是文件编辑策略，`session/set_mode` 必须 ACK 相同模式。
不代替命令审批，也不宣称 OS sandbox。CoreEnforced 的 read-only 工作区启动明确拒绝。
问卷没有本轮专属 UI，不自动代答；沿共享 ACP 的不支持处理路径。

ACP `mcpServers` 在构建 AIAgent 前冻结为进程内 overlay，合并原生 MCP，Rovai 同名优先；原生后台发现、
重连及显式注册读取同一合并结果。实际注册失败即拒绝 Session。一个 Host 的 assignment 不可变；
变更/撤销由共享兼容性产生新 Host，桥也拒绝同 Host 的不同 assignment，禁止前一 Session 的授权泄漏。

## 结果与观测

原生 executor 错误不得被 ACP 包装成成功 `end_turn`。共享终态/输入防重放保持；无成功 Send 时使用既有恢复规则。
工具更新保留有界结构化 raw input/result 和原生失败判定；所有编辑预览 diff 被过滤。
Core 也拒绝 Hermes 通用 ACP diff 和参数推导的 before/after，只接受 completed `patch` 的原生
`success=true`、单一 `files_modified`/`resolved_path` 一致、完整有界 unified hunks，投影为
`reported_mutation` 片段。创建/删除、无效/截断 patch、失败和 no-change 不产生该差异。
`write_file` 保留写操作，不伪造完整旧文件、Add 或完整新文件。

Hermes 原始 token counters 为 Session 累计；受管桥按真实 turn 前后基线求差。Core 只用终态 prompt usage
记账，native usage_update 仍为上下文 gauge。输入包含 cache read，output、reasoning 按原生字段处理；
缺失 cache write、费用、请求数保持未知，不重复累计暖会话。

## 准入

macOS arm64 为 Preview；macOS x64、Windows x64、Linux x64 均 Not Qualified。
Ready 只证明当前安装/认证/协议探测，不等于十四轴和各平台验收完成。边界与证据见
[Hermes 验证记录](../research/hermes-runtime/README.md)。数据库 Migration 214 / projection schema 164
只扩展 Runtime、Skill group 闭集；保留既有 Run、Binding、成员和历史数据。
