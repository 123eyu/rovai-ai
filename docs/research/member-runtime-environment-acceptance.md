---
document_type: research-report
status: implemented
last_updated: 2026-10-11
---

# 队员环境变量验收

当前合同为 [Runtime Launch v58](../contracts/runtime-launch-and-verification-v58.md)，在 `e53665264` 基础上收敛为
配置透传、会话创建时固定、显式重置后更新。本轮平台为 macOS arm64；所有验收使用独立目录、合成凭据或
loopback 服务，没有访问日常 Core 数据、原生账号或真实模型服务。

## 当前会话语义

参考了 BotMux 的 [per-bot-env.ts](https://github.com/deepcoldy/botmux/blob/ea76d77455247fc3c7b10bdbe8f1818d23683072/src/core/per-bot-env.ts)
子进程注入方式，以及 [bots-json 文档](https://github.com/deepcoldy/botmux/blob/ea76d77455247fc3c7b10bdbe8f1818d23683072/docs-site/docs/zh/bots-json.md)
的“下个新会话生效”边界。Rovai 沿用自己的 Conversation、私有存储和恢复路径。

- Host＋队员变量合并保存为随机引用的私有快照。保存不会更新原会话；同一 Camp/队员的后续 Run、重试和冷恢复继续读原快照。
- 移除环境内容 digest、地址/凭据确认与认证组合检查。地址独立覆盖而凭据继承属于透传语义，不宣称原 P1 已自动修复。
- 原生会话重置同时解除环境快照关联；下一次准入读取最新配置。历史 Run 引用保留，缺失或损坏的快照明确失败。
- Pi、ZCode 和 Fleet 只允许同一 Camp、队员、当前会话内复用；工作目录兼容、停止例外、租约和后台路由继续保留。
- Camp 队员操作提供“重置队员会话”。紧凑 JSON 编辑器保留遮蔽、显隐、保存/放弃，显示两条固定双语提示，没有检查连接和组合确认。

## 本次验收证据

- `cargo test -p rovai-core --features extended-tests --lib member_environment::tests`：3 个扩展 owner 通过。
  其中实际 ManagedProcess 子进程并行验证不同凭据、字面量、父进程不变；保存后重开 SQLite 再创建新 PID，
  旧会话仍拿到旧值，重置后新 PID 才拿到新值。另覆盖私有存储、快照损坏/缺 key 拒绝、191/192 分别故障回滚。
- `cargo test -p rovai-core --features extended-tests --lib runtime_fleet::tests`：23 项通过，覆盖同会话复用、
  跨队员/Camp/重置后隔离、工作目录兼容及 ZCode 后台任务保护。此处 Host 为模拟对象，不替代各 CLI 的实际运行资格。
- `cargo test -p rovai-core --features slow-tests --lib manual_native_session_restart_keeps_conversation_identity_and_generation`：通过。
  沿用原来 User 权限、活动任务拒绝、版本 CAS、native binding generation 和消息保留断言。
- `cargo build -p rovai-core --bins` 后执行 `node scripts/smoke-member-environment.mjs`：17 项检查通过。
  使用真实 Core RPC 验证遮蔽、私有保存、CAS/重放、透传、旧入口拒绝、目标 Conversation 查询/重置和旧配置迁移确认。
  会话查询 fixture 在 Core 停止后插入惰性 Conversation；会话环境生命周期由上面的 Rust owner 负责。
- `node scripts/smoke-member-environment-ui.mjs`：生产编辑器/重置组件的 Electron fixture 通过。
  覆盖保存刷新竞态、无组合确认、准确 Conversation/version、活动任务禁用、冲突保留弹窗、双语和 390px 布局。
  104px 初始高度、无焦点阴影、移动端 16px 字体及无横向溢出通过；截图复查已完成。仅私有 RPC fixture，无 Core/Runtime。
- `pnpm typecheck`、5 个相关 Vitest 文件（25 项）、Desktop/Web 构建通过。
- `pnpm test:rust:pr`：默认 workspace 465 项通过、1 项既有人工测试忽略。
- `cargo test -p rovai-core --features extended-tests --lib acp::tests`：67 项通过、2 项真实 Runtime 人工测试忽略，
  包含原有 warm/cold、session、权限和消息归属。Qwen 内部目录默认判定也读取已固定环境，不读取变化后的 Host。
- `cargo fmt --all --check`、`cargo check --workspace --all-targets` 与三项文档治理门禁通过。

扩展 workspace 首轮 Core 库结果为 **987 通过、4 失败、8 忽略**；失败后提前结束，未将它记为完整 workspace 通过。
其中 continuation、pending picker、v163 三个历史迁移 fixture 的 schema 准备遗漏已修正并分别定向通过，
原有业务保留和回滚断言没有减弱；没有再次重复整个扩展集合。

剩余 `authority_migration::tests::macos_provenance_added_after_ticket_is_readmitted_without_losing_business_data`
在当前 macOS 上仍返回 `authority_contract_changed`。本机新建/复制的测试数据库已带 `com.apple.provenance`，
尝试删除该属性后再次读取仍存在，不能满足该用例要求的“属性从无到有”初始条件。未修改或跳过该测试，
也未放宽生产数据库身份校验。这一平台测试限制与本次环境生命周期验收分开记录。

## 验证边界

本轮没有重新执行所有 Runtime 的真实模型调用、Windows 真机或打包安装。
原生配置文件仍由各 Adapter 的既有规则管理；环境快照不构成完整原生账号隔离。

## e53665264 的历史验收

以下记录对应 v57，不代表现行生效时机、确认或复用策略。保留原生 Claude 路由实验作为已测试版本的证据；
地址确认、按环境摘要替换进程与跨队员 Warm 共享已由 v58 取代。

### 实际 Claude Code

`python3 scripts/probe-claude-member-environment.py --claude <absolute-cli-path>` 对已安装的
Claude Code **2.1.287** 启动两个并行进程，共享安装和同一份隔离原生设置。

- A 使用 `ANTHROPIC_API_KEY`，B 使用 `ANTHROPIC_AUTH_TOKEN`，各有自己的 URL 和模型。
- 原生设置故意包含错误地址、Auth Token、模型、Vertex 开关和 `apiKeyHelper`。
- 两个端点各收到一个 `/v1/messages?beta=true` 请求；A 只有预期 API Key，B 只有预期 Bearer Token；
  模型分别匹配，各进程正常退出并收到 `fixture-ok`。
- 另一次双 API Key 对照也通过。脚本校验所有请求，不能用一次正确请求掩盖其他串用请求。

这证明上述版本的原生覆盖防护与两种静态认证头，不能推断所有旧版本、托管政策或其他 Runtime 的原生优先级。
脚本只记录匹配布尔值；CLI 输出和凭据不进入公共报告。版本保护范围与缺少凭据时的拒绝由合同定义。

### Core、进程和 Warm

`cargo build -p rovai-core --bins` 后运行 `node scripts/smoke-member-environment.mjs`。
生产 Core RPC 已覆盖私有读取/遮蔽、队员和 Runtime 作用域、命令幂等、Profile/环境原子 CAS、地址确认、
模型冲突、旧 Runtime 保存和检查拒绝、重启恢复、删除覆盖及 SQLite 密文存储。

扩展 Rust owner 验证真正的 ManagedProcess 子进程并行传递字面量、不改变父进程、不用队员 PATH 选择 CLI、
冻结配置跨重启重试、丢失 key 不回退、Migration 191 receipt 故障整体回滚、归档确认与程序路径修改互不影响。
Claude 现有进程 owner 另验证实际 Adapter 收到冻结环境、凭据只进入私有 settings、原权限参数保持、错误脱敏。

既有 fleet owner 的模拟 Host 验证 Pi 原工作区跨 Camp/队员范围不变，相同摘要复用、不同摘要分开。
这是 fleet 与真实子进程边界的分层证据；没有声称本轮已完成所有 warm Runtime 的真实 Provider 端到端验收。

### 界面与回归

浏览器 fixture 使用生产 MemberRuntimeForm 和 LegacyEnvironmentIssue：初始 104px、内容增长至 360px、
清空收缩、无 focus outline/shadow、保存后密钥遮蔽、中英文切换、旧配置显隐与人工确认均通过。
390px 移动视口无横向溢出，JSON 字号为 16px。fixture 没有启动 Electron 或访问日常数据。

已执行 typecheck、五个相关 Vitest 文件（25 项）、Desktop/Web 构建、Rust workspace 默认回归（465 项通过、
1 项既有人工测试忽略），以及环境、迁移、原生配置保存、Check Manager、Warm、Claude、Antigravity 定向回归。
Windows 大小写规则有解析覆盖；Windows 真机、打包安装和各 Runtime 原生账号优先级不属于本轮实测结果。
