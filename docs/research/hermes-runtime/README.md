---
document_type: research-note
authority: non-normative
last_updated: 2026-10-23
---

# Hermes 接入与验证

已在 `rovai/hermes-runtime` 实现官方 Hermes **0.22.4** 的 macOS arm64 Preview。
锁定 source commit `4d04303818b61bf3aa09278af48356315515965b`；这不是任意版本兼容或十四轴完整资格声明。
当前规范见 [Hermes Managed Runtime v1](../../contracts/hermes-managed-runtime-v1.md)。

## 安装与交付范围

本机已安装官方 CLI source distribution，入口 `~/.local/bin/hermes`。最初通过 Brew 安装的 0.22.2
不满足接入要求，已解除它的链接，保留安装供回退。没有安装 Hermes Desktop，也没有启动共享 Gateway。
用户允许真实模型与 BYOK，验收使用隔离 Hermes Home、Sub2API 与 `gpt-6.1-sol`；随后把同一授权的
Provider 配置写入 Hermes 自己的原生配置与私有 `.env`，原文件已私有备份。Adapter 不在运行时借用 Pi 等其他 Home。

代码 worktree：`../rovai-ai-hermes-runtime`；branch `rovai/hermes-runtime`；base
`a995ebe079d2437872b694680b597abbdb6121ac`。尚未合入或安装 Rovai 日常 App。
Migration 214 / schema 164 只扩展 Runtime 与 Skill group 闭集，不清空既有数据。

## 原方案评估与关键调整

原方案识别的 Gateway 所有权、Bootstrap 确认、精确恢复和观测诚实性都成立。
采用同官方发行物保留的 `HermesACPAgent(SessionManager())` + 真实 `AIAgent`，避免只拥有 viewer PID。
由官方 `--print-runtime-command` 解析安装绑定的 Python/bootstrap；只替换最终入口，不另写聊天循环或修改原生源码。

实测发现并适配的差异：

- 原生 resume 对不存在的 ID 隐式新建，受管入口改为精确结构化拒绝；Core 仅对关联恢复目标执行已有恢复规则。
- 原生通用 set_config_option 接受 model 却不真正切换；改调原生 set_session_model/resolver，返回并核对实际状态。
- 原生 ACP 文件 diff 包含编辑预览；只采纳 executor 成功 patch 的实际 hunks，并以片段而非完整文件表示。
- 原生 token result 是 Session 累计；桥在真实 turn 前后求差，避免暖轮重复计费。费用、cache write 等缺失值仍未知。
- 原生 MCP 先连接的同名服务会被复用；在任何 AIAgent 构造前合并进程内 assignment，保证 Rovai 同名优先。
- 原生 ACP 会把部分执行异常包装成 end_turn；受管入口用实际执行结果和保守失败标记拒绝假成功。
- 原生后台标题会额外发起模型请求，脱离 Run usage/terminal；受管进程关闭此调用，Thread 标题仍由 Rovai 拥有。

## 能力清单

| 能力轴 | 当前实现与证据 | 保留边界 |
| --- | --- | --- |
| Auth / Provider / Model | 原生 Home、resolver、真实模型目录和选择 ACK；Sub2API 实测 | 仅验证此 Provider 路径；effort 依原生配置，无 Fast |
| Host / Fleet / LRU | Fleet 拥有实际 Python executor；Core 退出检查后代清理 | 未跑满 20 Host LRU 与 30 分钟 TTL 完整矩阵 |
| Native Session / Continuation | 原生 SessionDB 精确 cold resume、missing target 拒绝；Core 暖续轮 | Core 重启、Eviction 后恢复完整矩阵未执行 |
| Bootstrap / Context | Core 既有 ManagedSystemPrompt；SHA ACK 后才送 P；真实会话隔离 | 不改共享 B/P 文案、选择、Formatter 或版本 |
| Compaction | 原生结构化压缩保持 ACP ID，后续及重启都保留系统指令 | 仅私有验收入口；产品手动压缩与取消压缩矩阵未交付 |
| Skills | 原生用户 Skill 根读取、真实 skill_view；共享 Core 索引 | 自定义 external_dirs、受信项目目录的 Toolbox 索引未覆盖，保留 DocumentationOnly 资格 |
| External MCP | 真实工具调用；原生同名冲突时 Rovai 优先；同 Host assignment 变更拒绝 | 未跑全部 HTTP/SSE/OAuth/增删组合 |
| Tool / Action / Command Output | Core 真实 CLI、读/写/patch 与持久 tool_result；成功 patch 片段 | write_file 无旧文件证据，只有写操作；不制造 Add/完整 diff |
| Narration / Final / Missing-Send | Explicit SendOnly、共享缺失发送恢复；Core 实际 public Send | 全部异常后的恢复组合未穷举 |
| Permission / Workspace | 原生 edit mode ACK；命令审批保留；read-only 无法保证时拒绝启动 | 没有 OS sandbox；问卷不自动代答 |
| Built-in CLI | 真实 terminal 环境继承、rovai --help、send --public-only 与服务端回执 | 不是全部 30 个 CLI 操作验收 |
| Usage / Cache / Cost | 真实暖轮数值；受控端点两轮各 100 input / 10 output / 40 cache read / 2 reasoning | 无费用和 cache write；不估算未报告数量 |
| Retry / Queue / Cancel / Cleanup | Core 队列；真实暖轮终端取消、cancelled 收敛及子进程退出；401 不伪装成功 | crash/LRU/TTL/多会话竞态完整矩阵未验收 |
| Ready / Version / Platform | native version、source commit/dirty fence、revision 与真实 PID ACK | 仅 macOS arm64 Preview，其他平台 Not Qualified |

## 与其他智能体的差异

| 对比项 | Hermes | Rovai 现有接入对照 |
| --- | --- | --- |
| 执行入口 | 官方包内的内部进程内 ACP，精确 commit fence | 多数 ACP Adapter 直接使用原生公开 CLI 入口；Hermes 升级维护成本更高 |
| 系统输入 | 复用 ManagedSystemPrompt，native ephemeral overlay + 每 Run 绑定 ACK | 与 Pi/DSH 的受管系统层思路接近；不是 first_payload，也不改成项目身份文件 |
| 会话恢复 | 额外拦截上游隐式新建，精确缺失码交给 Core | 复用其他 Adapter 的 exact-target、replay quarantine 与恢复流程 |
| 模型选项 | 原生 catalog/resolver；模型切换须桥接并确认，effort 留在 native config | 不照搬 Codex/Pi 等已经验证的 effort/Fast 控件 |
| 权限 | 文件编辑 mode 与命令审批分开 | 不把 dont_ask 描述成全局 bypass 或只读 sandbox |
| MCP | 构造前进程内 additive overlay；assignment 改变就新 Host | 与已有 additive/Rovai-wins 合同一致，接入点不同 |
| 文件差异 | actual patch reported_mutation；write_file 仅 operation | 不等同 Codex 完整 fileChange、DSH 完整 before/after 或 Pi patch 格式 |
| Usage | 原生 Session 累计转 turn delta；保留缺失值 | 不从 usage_update 上下文 gauge 反推消耗，也不承诺其他 Runtime 的费用覆盖 |

## 验证与复现

所有真实 Core 运行使用隔离 `dataDirectory`、project、Skill Library、MCP 文件与 Built-in lease，未打开日常 userData。
凭据不进入仓库、日志或证据包。原始私有 wire 留在临时 fixture，仅提交脱敏结果。

- `scripts/smoke-hermes-native.mjs`：真实模型、模型 ACK、MCP/Skill、warm、结构化压缩、冷恢复和 assignment 拒绝。
- `scripts/smoke-hermes-wire.mjs`：真实 native executor + 本地受控 Responses；B 的 system/developer 层、P 的普通输入、替换绑定、数值 delta、401 错误、零后台模型调用。
- `scripts/smoke-hermes-core.mjs`：真实 Core + native executor + 真实模型；公开 Send、文件操作/差异入库、暖轮实际 terminal 取消及树清理。

运行 native/Core smoke 时设置 `ROVAI_HERMES_BIN` 与 `ROVAI_HERMES_SMOKE_HOME`，后者必须是专用、已配置的
验收 Home；脚本不寻找或复制密钥。wire smoke 仅需 executable，自建 dummy 凭据与 loopback 服务。

原生压缩本次短对话报告 `compressed`，但 token estimate 从 7472 增至约 11400；只证明压缩执行和身份/指令连续，
不声称短对话省 token。真实 Core 首轮在原生工具完成后成功公开发送，并持久化 `reported_mutation`，
后继 `sleep 120` 在终端实际启动后取消，Core cancelled 与进程消失均通过。

自动检查结果在 PR 验证栏记录；默认 Rust 库测试首次找出 6 个新目录闭集/平台映射遗漏，已补齐原 owner，
不删除失败断言或降低其他 Runtime 资格。既有 ACP extended owners 67 passed / 2 ignored；数据库迁移 owner 通过。

## Rust 测试归属

新增两个最低成本 owner，仅覆盖新 seam：`hermes::tests::managed_entry_requires_the_known_native_launcher_and_execution_identity`
拒绝 bootstrap/解释器形状或执行 PID 错配；`native_patch_requires_a_successful_corroborated_complete_hunk` 拒绝预览、失败、
错路径、截断与多文件，并保留 CRLF/无末尾换行。已有 ACP 传输 owner 无法证明此 Hermes 特有 launcher 或 native patch 格式。

扩展既有 restore error、ACP diff、monitoring parser、catalog/platform/activity/skill/context 闭集及迁移 owner。
Migration owner 覆盖 receipt、数据/触发器/FK 保留和失败回滚，不新增平行 SQLite fixture。
最小命令：`cargo test -p rovai-core --lib hermes::tests`；共享 seam 用
`cargo test -p rovai-core --features extended-tests --lib acp::tests` 和 `runtime_catalog_migrations`。

## 来源

- [官方安装方式](https://hermes-agent.nousresearch.com/docs/getting-started/installation)：source installer、CLI 入口与可选浏览器工具。
- [已验证源码](https://github.com/NousResearch/hermes-agent/tree/4d04303818b61bf3aa09278af48356315515965b)：`acp_adapter/server.py`、`session.py`、`agent/turn_context.py`、`title_generator.py`、`tools/mcp_tool_discovery.py`。
- Logo 来自同 commit 的 `website/static/img/apple-touch-icon.png`，只作既有 Runtime 产品标识。
