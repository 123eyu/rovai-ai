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

最低支持官方 source install **0.22.4**；接受更高版本，不按 source commit、dirty 状态或上界锁死。
无法解析的 launcher 或实际不兼容的协议仍须明确失败。`ROVAI_HERMES_BIN` 和 Runtime 通用启动设置可选择入口。
调用选中 launcher 的 `--print-runtime-command`，保留它的绝对解释器、`-I` 与 native bootstrap，
仅替换已知的最终 module entry，执行 Core 私有目录内的受管 Host。禁止安装时以外的隐式依赖同步。

Host 使用同发行物的 `HermesACPAgent(SessionManager())` 与真实 `AIAgent`，不启动共享 Gateway。
`_rovai/ready` 必须返回匹配的受管 revision、满足最低要求的版本和实际 child PID。Fleet 拥有这一执行进程及其树。
公开 `hermes acp` 在已验版本默认构造无 SessionManager 的 Gateway viewer；不是协议不可用，而是
该入口无法把实际执行者的生命周期交给 Fleet。受管入口继续使用 ACP；Python 覆盖仅存在于该子进程，
不修改安装源码。内部 API 变化由探测、绑定与真实执行失败显式暴露，不把最低版本策略误写成全部新版已验收。
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
正常 Run 依赖原生阈值自动压缩，不调用此入口。`_rovai/session_info` 只读报告原生窗口、阈值、压缩次数
和历史条数，供验收观察，不能改变压缩策略或历史。

Steer 使用 `_rovai/steer`，携带精确 Session、Core prompt ID、input ID；仅当前活动轮且未取消时调用
原生 `AIAgent.redirect`。ACK 必须回显 input ID 与目标 prompt ID；idle、迟到、错轮返回未接受，不能
创建下一轮。执行 epoch、原始输入与补充输入账本继续由共享 Core 负责；传输未知不伪造未送达。

## 模型、权限与 MCP

目录来自原生 ACP model state。`session/set_config_option(model)` 由受管桥调用原生
`set_session_model` / resolver，并返回实际 config state；Core 核对请求值，不接受原生通用配置的空 ACK。
`reasoning_effort` 使用原生 `route_supported_efforts` 提供选项，成员通用参数 UI 保存后通过 ACP 设置并核对 ACK。
`runtime_default` 代表跟随原生 `agent.reasoning_effort` / `agent.reasoning_overrides`；显式成员值仅作用于
该 Session，模型重建重放该值，不写用户 config。原生按 Provider/模型进一步处理思考能力；不制造 Fast 开关。
其他未实现的 config ID 拒绝。

原生 `default / accept_edits / dont_ask` 是文件编辑策略，`session/set_mode` 必须 ACK 相同模式。
不代替命令审批，也不宣称 OS sandbox。CoreEnforced 的 read-only 工作区启动明确拒绝。
问卷没有本轮专属 UI，不自动代答；沿共享 ACP 的不支持处理路径。
原生默认 ACP toolset 不带 `clarify`；即使自定义 toolset 启用它，原生配置
`agent.disabled_toolsets: [clarify]` 也能排除 `clarify` / `ask_user`，受管桥不重新启用。

Skills 候选采集遵循原生 Home 的 `skills`、`skills.create_dir`、`skills.external_dirs` 与禁用列表。
`~/.agents/skills` 必须通过 external_dirs 显式加入；项目最近 Git 根下 `.hermes/skills` 与 `.agents/skills`
只在原生 project discovery 开启且该根在 `skills.trusted_project_dirs` 中时采集。Skills 设置页仅用户来源，
Thread 候选可包含已信任项目来源；路径身份保留，不把同名候选或索引存在宣称为实际加载。

ACP `mcpServers` 在构建 AIAgent 前冻结为进程内 overlay，合并原生 MCP，Rovai 同名优先；原生后台发现、
重连及显式注册读取同一合并结果。实际注册失败即拒绝 Session。一个 Host 的 assignment 不可变；
变更/撤销由共享兼容性产生新 Host，桥也拒绝同 Host 的不同 assignment，禁止前一 Session 的授权泄漏。

## 结果与观测

原生 executor 错误不得被 ACP 包装成成功 `end_turn`。共享终态/输入防重放保持；无成功 Send 时使用既有恢复规则。
失败保留原生脱敏后的有界详情于 JSON-RPC `data.error`，由共享 Core Run 错误与 Renderer 呈现。
工具更新保留有界结构化 raw input/result 和原生失败判定；所有编辑预览 diff 被过滤。
本地原生文件执行边界观察 bounded UTF-8 before，并以实际 atomic write 字节和原生 verified hash 确认 after；
完成回调将进程内证据绑定到精确 tool call，放入私有 metadata，不注入模型历史。支持新增、覆盖、patch、
删除和移动（删除源＋新增目标）、多文件；null 与空字符串分别代表文件不存在和空文件。
Core 只接收 completed 结果的 `hermes_file_states`，持久化 `full_before_after` 并重建 Diff；不事后扫描磁盘/Git
补证。每文件状态上限 1 MiB，每工具 64 条、合计 4 MiB；二进制、不可读、越界、失败、no-change 不伪造完整状态。
远端 backend 等无法取得完整状态时，只允许原有成功 `patch` 的完整有界、路径一致原生 hunks 投影为
`reported_mutation` 片段。终端任意写入不因此自动获得完整 Diff；原生编辑预览仍不准入。

Hermes 原始 token counters 为 Session 累计；受管桥按真实 turn 前后基线求差。Core 只用终态 prompt usage
记账，native usage_update 仍为上下文 gauge。输入包含 cache read，output、reasoning 按原生字段处理；
缺失 cache write、费用、请求数保持未知，不重复累计暖会话。

## 准入

macOS arm64 为 Preview；macOS x64、Windows x64、Linux x64 均 Not Qualified。
Ready 只证明当前安装/认证/协议探测，不等于十四轴和各平台验收完成。边界与证据见
[Hermes 验证记录](../research/hermes-runtime/README.md)。数据库 Migration 214 / projection schema 164
只扩展 Runtime、Skill group 闭集；保留既有 Run、Binding、成员和历史数据。
