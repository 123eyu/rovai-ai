---
document_type: research-note
authority: non-normative
last_updated: 2026-10-23
---

# Hermes 接入与验证

已在 `rovai/hermes-runtime` 实现官方 Hermes **0.22.4** 的 macOS arm64 Preview。
兼容策略为 **>=0.22.4**，无 commit、dirty 或版本上界 fence。实际已验安装的 source commit 为
`4d04303818b61bf3aa09278af48356315515965b`；最低版本策略与新版/十四轴的实际资格分开。
当前规范见 [Hermes Managed Runtime v1](../../contracts/hermes-managed-runtime-v1.md)。

2026-10-23 补充验证了公开 `hermes acp` 与专用官方 Gateway，见
[官方入口实测与代价](official-entry-validation.md)。逐 Run 重启 Gateway 后精确恢复同一个 Session、
刷新系统指令和终端环境已通过真实模型验证；因此不能把公开入口概括为“无法受管”。
当前 PR 仍是进程内实现，切换路线尚需 Core 生命周期、逐 Run 绑定、事件映射与完整准入。

## 安装与交付范围

本机已安装官方 CLI source distribution，入口 `~/.local/bin/hermes`。最初通过 Brew 安装的 0.22.2
不满足接入要求，已解除它的链接，保留安装供回退。没有安装 Hermes Desktop，也没有启动日常共享 Gateway；
官方入口 Probe 仅启动隔离 Home 下的专用 Gateway，结束后已回收。
用户允许真实模型与 BYOK，验收使用隔离 Hermes Home、Sub2API 与 `gpt-6.1-sol`；随后把同一授权的
Provider 配置写入 Hermes 自己的原生配置与私有 `.env`，原文件已私有备份。Adapter 不在运行时借用 Pi 等其他 Home。

代码 worktree：`../rovai-ai-hermes-runtime`；branch `rovai/hermes-runtime`；base
`a995ebe079d2437872b694680b597abbdb6121ac`，交付前已合入主线 `4dfd8c882e7b44f0309a5d2492c2ece03e657a76`。
Hermes 分支尚未合入或安装 Rovai 日常 App。
Migration 214 / schema 164 只扩展 Runtime 与 Skill group 闭集，不清空既有数据。

## 原方案评估与关键调整

原方案识别的 Gateway 所有权、Bootstrap 确认、精确恢复和观测诚实性都成立。
采用同官方发行物保留的 `HermesACPAgent(SessionManager())` + 真实 `AIAgent`，避免只拥有 viewer PID。
由官方 `--print-runtime-command` 解析安装绑定的 Python/bootstrap；只替换最终入口，不另写聊天循环或修改原生源码。
这是继续使用 ACP。已验版本公开入口不传 SessionManager，`HermesACPAgent.__new__` 因而返回 Gateway viewer，
没有公开的进程内开关；关闭该 viewer 不等于关闭真实执行者。受管覆盖只存在于 Fleet 拥有的 Python 子进程。

以下为所选**内部进程内 ACP 路径**实测发现并适配的差异；不能直接推定公开 Gateway ACP 也有相同行为。
例如公开入口已实测精确拒绝不存在的会话，并将模型失败作为失败终态返回。

- 原生 resume 对不存在的 ID 隐式新建，受管入口改为精确结构化拒绝；Core 仅对关联恢复目标执行已有恢复规则。
- 原生通用 set_config_option 接受 model 却不真正切换；改调原生 set_session_model/resolver，返回并核对实际状态。
- 原生 ACP 文件 diff 包含编辑预览，原生 display 快照还会混淆缺失/读取失败及规范化换行。
  改在实际文件 executor 边界采集完整、有限的状态，以 atomic write 原生 verified hash 核对新内容；
  其他无法观测的 backend 仍只接纳成功 patch 的实际完整 hunks，并明确表示为片段。
- 命名 BYOK endpoint 在 AIAgent 中被归一成 custom；保留原生 resolver 传给构造器的 provider，
  交给原生 catalog 生成确认值，避免选择 Sub2API 后得到不同的含糊 model ID。
- 原生 token result 是 Session 累计；桥在真实 turn 前后求差，避免暖轮重复计费。费用、cache write 等缺失值仍未知。
- 原生 MCP 先连接的同名服务会被复用；在任何 AIAgent 构造前合并进程内 assignment，保证 Rovai 同名优先。
- 原生 ACP 会把部分执行异常包装成 end_turn；受管入口用实际执行结果和保守失败标记拒绝假成功。
- 原生后台标题会额外发起模型请求，脱离 Run usage/terminal；受管进程关闭此调用，Thread 标题仍由 Rovai 拥有。

## 能力清单

| 能力轴 | 当前实现与证据 | 保留边界 |
| --- | --- | --- |
| Auth / Provider / Model | 原生 Home、resolver、目录和实际选择 ACK；Sub2API 实测；成员页 effort | Provider/模型会按原生规则处理强度；无未经验证的 Fast 开关 |
| Host / Fleet / LRU | Fleet 拥有实际 Python executor；Core 退出检查后代清理 | 未跑满 20 Host LRU 与 30 分钟 TTL 完整矩阵 |
| Native Session / Continuation | 原生 SessionDB 精确 cold resume、missing target 拒绝；Core 暖续轮 | Core 重启、Eviction 后恢复完整矩阵未执行 |
| Bootstrap / Context | Core 既有 ManagedSystemPrompt；SHA ACK 后才送 P；真实会话隔离 | 不改共享 B/P 文案、选择、Formatter 或版本 |
| Compaction | 真实模型、原生 272000 窗口 / 204000 阈值，正常读取触发自动压缩，连续与冷恢复均保留指令/锚点 | 不调用主动压缩；没有产品手动压缩按钮；取消压缩矩阵未验收 |
| Skills | 用户 Home、create_dir、external_dirs、禁用项与受信最近 Git 根的 .hermes/.agents 索引；真实 skill_view | 用户 ~/.agents 是 opt-in；设置页不混入项目来源；不从候选存在推定已加载，保留 DocumentationOnly 资格 |
| External MCP | 真实工具调用；原生同名冲突时 Rovai 优先；同 Host assignment 变更拒绝 | 未跑全部 HTTP/SSE/OAuth/增删组合 |
| Tool / Action / Command Output | Core 真实 CLI、Add/覆盖/patch 与持久 full_before_after；原生删除、移动、多文件、CRLF、空文件及失败边界受控验收 | 二进制/超限/不可读/远端不伪造完整状态；terminal 任意写入无自动全量 Diff |
| Narration / Final / Missing-Send | Explicit SendOnly、共享缺失发送恢复；Core 实际 public Send | 全部异常后的恢复组合未穷举 |
| Permission / Workspace | 原生 edit mode ACK；命令审批保留；read-only 无法保证时拒绝启动 | 没有 OS sandbox；问卷不自动代答 |
| Built-in CLI | 真实 terminal 环境继承、rovai --help、send --public-only 与服务端回执 | 不是全部 30 个 CLI 操作验收 |
| Usage / Cache / Cost | 真实暖轮数值；受控端点两轮各 100 input / 10 output / 40 cache read / 2 reasoning | 无费用和 cache write；不估算未报告数量 |
| Retry / Queue / Cancel / Cleanup | Core 队列；真实暖轮终端取消、cancelled 收敛及子进程退出；401/错误模型原生详情 | crash/LRU/TTL/多会话竞态完整矩阵未验收 |
| Steer | 原生 redirect + 精确 prompt/input ID ACK；首条活动输入提前确认，沿 Core 投递账本 | 迟到或错轮不接受；不以并发 session/prompt 偷排下一轮 |
| Ready / Version / Platform | native >=0.22.4、受管 revision 与真实 PID ACK | 仅 macOS arm64 Preview，其他平台 Not Qualified |

## 与其他智能体的差异

| 对比项 | Hermes | Rovai 现有接入对照 |
| --- | --- | --- |
| 执行入口 | 官方包内的内部进程内 ACP，最低版本策略 | 多数 ACP Adapter 直接使用公开 CLI；Hermes 内部 seam 的升级维护成本更高 |
| 系统输入 | 复用 ManagedSystemPrompt，native ephemeral overlay + 每 Run 绑定 ACK | 与 Pi/DSH 的受管系统层思路接近；不是 first_payload，也不改成项目身份文件 |
| 会话恢复 | 额外拦截上游隐式新建，精确缺失码交给 Core | 复用其他 Adapter 的 exact-target、replay quarantine 与恢复流程 |
| 模型选项 | 原生 catalog/resolver；模型切换须桥接确认，成员 effort 覆盖原生默认 | 复用已有推理强度控件；Fast 不照搬 Codex/Pi 的服务档位 |
| 权限 | 文件编辑 mode 与命令审批分开 | 不把 dont_ask 描述成全局 bypass 或只读 sandbox |
| MCP | 构造前进程内 additive overlay；assignment 改变就新 Host | 与已有 additive/Rovai-wins 合同一致，接入点不同 |
| 文件差异 | bounded 原生 executor 完整状态；无法取得时保留真实 patch 片段 | UI 使用同一 Diff 视图；证据来源与 Codex fileChange、DSH 输出、Pi patch 不同 |
| 活动输入 | 受管私有方法调用原生 redirect，锁定目标轮 | 与其他 Runtime 使用同一插话 UI/账本；传输方法及原生执行中断行为不同 |
| Usage | 原生 Session 累计转 turn delta；保留缺失值 | 不从 usage_update 上下文 gauge 反推消耗，也不承诺其他 Runtime 的费用覆盖 |

## 验证与复现

所有真实 Core 运行使用隔离 `dataDirectory`、project、Skill Library、MCP 文件与 Built-in lease，未打开日常 userData。
凭据不进入仓库、日志或证据包。原始私有 wire 留在临时 fixture，仅提交脱敏结果。

- `scripts/smoke-hermes-native.mjs`：真实模型、模型 ACK、MCP/Skill、warm、结构化压缩、冷恢复和 assignment 拒绝。
- `scripts/smoke-hermes-wire.mjs`：真实 native executor + 本地受控 Responses；B 的 system/developer 层、P 的普通输入、替换绑定、数值 delta、401 错误、零后台模型调用。
- `scripts/smoke-hermes-official-acp.mjs`：未改写的官方 CLI + 专用 Gateway；受控模型、真实终端/文件、暖绑定缺口、断线取消、官方 RPC 替代能力与重启后同 Session 恢复。它是候选路线 Probe，不经过当前受管桥。
- `scripts/smoke-hermes-core.mjs`：真实 Core + native executor + 真实模型；首条输入及时 ACK、同 Run 插话与修正后公开 Send、文件操作/差异入库、暖轮实际 terminal 取消及树清理。
- `scripts/smoke-hermes-experience.mjs`：真实 native executor + 本地受控 Responses；命名端点 model ACK、effort 请求、禁用问卷、完整文件状态与边界、精确活动轮 redirect、错误模型详情。
- `scripts/smoke-hermes-auto-compression.mjs`：真实模型，不改窗口/阈值、不调用主动压缩，通过正常文件读取达到阈值，验证压缩后及冷恢复的用户锚点和系统指令。

运行 native/Core smoke 时设置 `ROVAI_HERMES_BIN` 与 `ROVAI_HERMES_SMOKE_HOME`，后者必须是专用、已配置的
验收 Home；脚本不寻找或复制密钥。wire smoke 仅需 executable，自建 dummy 凭据与 loopback 服务。

早期主动压缩只证明原生结构化压缩与连续性，不能作为阈值验收。后续真实自动压缩保持窗口 272000、
阈值 204000，三轮正常读取后 compressionCount 从 0 变为 1；用户锚点和系统指令在压缩后、关闭进程后
精确冷恢复均保留。轮次 Usage 是调用累计量，不把它当作当前上下文占用。
真实 Core 持久化完整文件差异并区分 Add/Write，独立 usage_update 上下文 gauge 入库；公开发送、
后继 `sleep 120` 在终端实际启动后取消、Core cancelled 与进程消失均通过。
Core smoke 额外断言初始输入在活动期已确认、Steer 的 accepted 记录仍属于同一 Run、总 Run 数没有增加，
最终只公开发送修正后的 marker；此次 UI 发现的投递确认问题已形成可重复回归检查。

原生配置支持 `agent.reasoning_effort` 与 `agent.reasoning_overrides`；配置词表含 none/minimal/low/medium/high/xhigh/max/ultra，
受管会话选项来自原生 route 支持列表，本次 Sub2API 路径列表止于 max；不把配置词表全部当作每个模型的有效能力。
显式 `agent.disabled_toolsets: [clarify]` 即使在自定义 ACP toolset 重启 clarify 时，也能使实际模型工具列表不再包含问卷。
默认 ACP toolset 本就排除该工具，受管桥不靠伪造答案关闭问卷。

隔离 `pnpm dev` 的实际 Renderer 验收：成员页下拉选择 low 并保存；真实错误模型返回 HTTP 400，
点击“查看原因”显示含 `invalid-hermes-model` 的原生详情；原生用户 Skill 列表仅含本地与 external 来源，
Thread 候选额外含受信项目 `.agents`。Steer 点击后补充输入的 accepted 记录与原 Run ID 一致，
该 Run 最终仅公开发送修正后的 `HERMES_THIRD_STEER`，没有另开下一轮发送旧 marker。
第一次 UI 验收揭示首条输入未及时 ACK、插话退回后继队列，已通过接入既有活动确认路径修正；
最终判据同时要求原 Run ID、原 input/steer 账本与该 Run 的实际 Send，不能仅靠界面标签或新消息判断成功。

Skills 路径的变量展开目前读取 Runtime 启动环境；仅定义在原生 `.env` 而未进入该环境的目录变量
尚未验证，避免把该场景宣称为完整原生索引等价。直接路径、`~`、启动环境变量及原生信任/禁用规则已有覆盖。

自动检查结果在 PR 验证栏记录；默认 Rust 库测试首次找出 6 个新目录闭集/平台映射遗漏，已补齐原 owner，
不删除失败断言或降低其他 Runtime 资格。既有 ACP extended owners 67 passed / 2 ignored；数据库迁移 owner 通过。

## Rust 测试归属

新增两个最低成本 owner，仅覆盖新 seam：`hermes::tests::managed_entry_requires_the_known_native_launcher_and_execution_identity`
拒绝 bootstrap/解释器形状或执行 PID 错配；`native_patch_requires_a_successful_corroborated_complete_hunk` 拒绝预览、失败、
错路径、截断与多文件，并保留 CRLF/无末尾换行。已有 ACP 传输 owner 无法证明此 Hermes 特有 launcher 或 native patch 格式。

扩展既有 restore error、ACP diff、monitoring parser、catalog/platform/activity/skill/context 闭集及迁移 owner。
本次 follow-up 在已有完整状态 owner 增加缺失/空文件、删除、CRLF、无末尾换行与拒绝边界，在现有 Skill root
owner 增加 external/create/trust/disable 更新，在已有 Steer 准入 owner 增加 Hermes 最低版本与活动输入闭集。
Migration owner 覆盖 receipt、数据/触发器/FK 保留和失败回滚，不新增平行 SQLite fixture。
最小命令：`cargo test -p rovai-core --lib hermes::tests`；共享 seam 用
`cargo test -p rovai-core --features extended-tests --lib acp::tests` 和 `runtime_catalog_migrations`。

## 来源

- [官方安装方式](https://hermes-agent.nousresearch.com/docs/getting-started/installation)：source installer、CLI 入口与可选浏览器工具。
- [官方配置](https://hermes-agent.nousresearch.com/docs/user-guide/configuration)：原生 reasoning 与 toolset 设置。
- [官方 Skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills)：外部目录与项目发现。
- [已验证源码](https://github.com/NousResearch/hermes-agent/tree/4d04303818b61bf3aa09278af48356315515965b)：`acp_adapter/server.py`、`session.py`、`agent/turn_context.py`、`title_generator.py`、`tools/mcp_tool_discovery.py`。
- Logo 来自同 commit 的 `website/static/img/apple-touch-icon.png`，只作既有 Runtime 产品标识。
