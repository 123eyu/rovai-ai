---
document_type: implementation-record
version: v1.72
last_updated: 2026-10-12
---

# 异步执行收尾与停止后继续

范围为用户确认的第 1–4 项：正文定稿及 Usage 移出同步关键路径；第 3、4 项仅验收已有停止／继续。
第 5、6 项不实施，不增加强制放行、自动重试、空闲超时或结果对账。CLI 原生 turn_end 不足以确认
Core 收到了 ACP prompt response，本改动不宣称已定位或彻底修复报告中的完成回包缺失。

分支 `rovai/async-run-finalization`，基线 `7973c7ffd1b0a360dea02c936458fb69f591c11e`，worktree 为
`/Users/murray.xue/.codex/worktrees/async-run-finalization/rovai-ai`。无前置治理分支、无模型输入变化。

## 测试归属

- 扩展既有 `execution_text::slow_tests::text_blocks_preserve_interleaving_live_reads_and_shutdown_without_fragment_writes`：
  注入定稿失败，命令成功、回执幂等、后台退避后持久化正文。旧实现会在提交后返回错误。
- 扩展既有 Usage 分批 owner 与累计 checkpoint owner：终态后刷盘失败恢复、迟到数据去重及跨 epoch 基线。
- 扩展既有 `codex_native_terminal_controls_host_independently_of_business_delivery`：持有 Usage 刷盘锁，
  仍完成终态与后继 lease。旧实现会等待该锁；进程边界由原 owner 保留。
- 新增扩展层 `async_usage_migration_preserves_checkpoints_and_rolls_back_with_receipt`：旧 schema 升级、
  receipt 失败回滚、数据保留与重开。现有旧版本迁移测试不拥有新增 trigger/receipt 的原子边界，纯函数不足以验证。
- `node scripts/smoke-stop-continue.mjs`：独立 Core/Skill Library/MCP/Home，合成 Copilot ACP 子进程
  留存正文但不返回完成回包，并忽略取消通知。通过公开 RPC 停止，确认进程清理后继续，新 Run 成功。
  SQLite 只读取证，无重启、查库修状态或强制放行。

最小 Rust 命令：`cargo test -p rovai-core --features slow-tests --lib text_blocks_preserve_interleaving`、
`cargo test -p rovai-core --features slow-tests --lib monitoring::tests`、
`cargo test -p rovai-core --features slow-tests --lib codex_native_terminal_controls_host`、
`cargo test -p rovai-core --features extended-tests --lib async_usage_migration`。
Smoke 前执行 `cargo build -p rovai-core --bins`。没有删除原 owner；原生尾读 owner 改为确定性的迟到采样，
保留历史偏移、重复调用、文件截断与后继 prompt 基线断言。

## 验证结果

- `pnpm test:rust:pr`：465 passed、1 ignored，默认 workspace 门禁通过。
- `cargo check --workspace`、`cargo fmt --all --check`、`pnpm typecheck`：通过。
- `pnpm test`：242 个 Vitest 文件、2,639 个断言通过；Node 阶段 339 passed、2 skipped；文档及 Skill 门禁通过。
- `--features slow-tests --lib usage`：17 passed，含新迁移、原生 reader；`monitoring::tests`：13 passed。
- 文本故障注入 owner：1 passed；占用 Usage 锁的原生终态／后继 lease owner：1 passed。
- `member_environment::tests`：3 passed；当前／未来数据版本准入 owner：1 passed。
- 停止／继续 Smoke：通过。Core 已记录正文，但 input 未 accepted；停止确认旧进程消失后，
  继续产生一条新 prompt，新 Run succeeded/accepted。旧 Run cancelled 与旧 delivery_unknown 保持原值。
- `DOCS_BASE_REF=7973c7ffd1b0a360dea02c936458fb69f591c11e pnpm docs:check:ci`：通过。

验收修正两项旧假设：Codex 原生终态 fixture 补上当前冻结环境 hydrate；合成 Runtime 使用公开检查和
成员配置命令，不依赖旧辅助函数将所有成员就绪状态限定为 ready。没有修改生产停止／继续策略。

本地 journal 的早期/尾部统计可能缺失，短于 4 秒周期的 Run 可能没有这些统计；正常 wire 上报仍会
后台保存。本次没有复现原报告的 route/owner 竞态，不宣称自动消除了完成回包缺失。

Status：ready（待 PR review）；Next：按 PR review 修订，保留 worktree。
