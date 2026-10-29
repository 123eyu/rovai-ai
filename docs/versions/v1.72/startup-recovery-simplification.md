---
document_type: implementation-record
version: v1.72
status: in_progress
last_updated: 2026-10-29
---

# 历史进程恢复减重

## 范围与故障

User 确认以老用户原会话继续工作为终点。独立 worktree 分支 `rovai/startup-recovery-availability`，
基线 `95c5f5f98019dc53cefef9abb64adc56b4be5798`；不修改主 checkout，无数据库格式、版本指针或发布版本变化。
交付前纳入 `5a229a599`（PR #953 模型目录兼容与原生执行），保留其全部代码与文档；本次 PR 仍只承载历史恢复减重。

前代 PID 被系统进程复用时，libproc 权限错误经 ManagedProcess 整批 `?` 传播到 `authority_recovery_failed`；
Adapter 初始化还会重复执行同一清理。Fleet 构造与 Stop 确认同样带全局历史回收。旧任务的 cleanup ACK 缺失则
继续阻挡工作区准备、消息领取、共享 execution root 和 dispatch，产生“窗口已开但不能工作”的第二层故障。

## 实现取舍

- `run_core` ready 后唯一 `spawn_blocking` 调用，共用三秒预算；每条最多 250ms、最多 16 条诊断、每条 512 字符。
  不持数据库锁，不在 RPC 循环等待，不进入 optional maintenance 或 Adapter 重试。
- ManagedProcess 与 Fleet 历史入口逐条容错。未知身份、权限/I/O/格式错误保持未清理；原进程已消失或 PID 复用不误杀新进程。
  当前 Core 生命周期身份/Fleet generation 排除新任务进程，正常停止原语保持真实。
- Fleet 构造不碰历史目录，实际写新所有权时才准备存储；当前 Stop 不调用历史 sweep。
- 四处门禁共用现有 launch/Fleet/one-shot 所有权快照，精确匹配 Run/epoch。历史未知不阻断；当前仍持有的终态执行
  若请求过清理且缺 ACK，继续只阻挡关联任务。当前清理 worker 不重试前代未知项，不批量补 ACK。
- 数据库打开、迁移、业务恢复保持各自错误。旧输入无自动重投，无新服务、表、持久队列或账本体系。

## 回归归属

扩展既有 Rust 测试，不新增测试函数。Delivery queue 的原门禁 owner 同时覆盖缺 ACK 的历史/当前执行、epoch 不匹配、
共享目录和 Mission workspace；Continuation owner 显式提供当前执行身份。macOS 既有 PID/ledger owner 扩展为
EPERM、损坏混批、格式/权限异常、不可读目录、不能删除、零预算和当前进程保留；Fleet receipt owner 验证构造/Stop
不触发历史 sweep，显式维护才逐条处理。原子数据库/内核身份断言不能由静态文本检查替代。
Windows 既有 owner storage 测试同步改为“构造不阻断、实际新任务写入失败、历史诊断保留”；本机未运行 Windows 用例。

既有 `scripts/smoke-stop-continue.mjs --historical-startup` 扩展真实 Core + 合成 ACP 路径：先产生并停止执行，关闭 Core，
只撤去旧 ACK 并加入脱敏坏记录、8192 条损坏文件与 32768 条已消失的生命周期身份。原 Thread/member/Runtime/输入保留；
重开读原会话、清理预算耗尽前收到新 native prompt 并继续成功；再次功能重试后历史清理只运行一次，旧 ACK 和异常文件不变。
隔离现场保留供复核；它不替代真实 Runtime 或安装 App 验收。

## 验收状态

| 检查 | 结果 |
| --- | --- |
| `cargo check --workspace` | 通过 |
| `pnpm test:rust:pr` | 477 通过，1 项原有手动 Runtime 用例 ignored |
| Delivery 扩展 owner | 28 通过；下述 2 项原有失败在基线复现 |
| macOS PID/ledger、Fleet receipt | 均通过，覆盖异常混批、精确当前所有权与零预算 |
| 历史故障端到端 | 通过；会话读取 93ms，总预算耗尽后保留余项，新 native prompt 在后台清理结束前开始并成功 |
| 未修改基线对照 | 同一脱敏脚本在基线重开时返回 `authority_recovery_failed`，修改后通过 |
| 当前停止/正常退出/重开 | 合成 ACP 通过，正常退出 68ms，已收正文可读且未重放旧输入 |
| 通用文档治理三项 | 通过 |

`pnpm dev` 在独立目录真实启动 Desktop、Host 与 Codex。首次执行 `printf STARTUP_DEV_OK` 成功发布回执；
第二次 `sleep 120` 在命令实际运行时通过 UI Stop，SQLite 记录真实 ACK。正常退出该开发实例后，只移除该 ACK，
加入异常文件和 8192 条坏记录，再重开同一开发会话。第三次 `printf STARTUP_REOPEN_OK` 成功发布回执。
三次 Run 的 Conversation、agent_1 和 codex-cli 相同；原 cancelled Run 的 ACK 仍为空，8194 个已取摘要文件均未改变。
重开日志 Core ready 120ms、会话进入往返约 12ms；页面和输入持续可操作。未把旧已停止任务自动续投。

开发现场保留于 `/tmp/rovai-startup-dev.iu5eiu/`，含隔离 DB、故障摘要与 `development-acceptance.json`；
大批量回归现场 `rovai-stop-continue-UYhQkW` 的 `acceptance.json` 保留 cleanup 计数、预算和读取耗时。
这些均是本次合成或开发验收数据，不包含日常原会话副本。

扩展 Delivery 全组的 `steer_admission_uses_the_frozen_run_and_rejects_stale_or_unknown_capability`（Hermes 1.0.0 预期）
和 `legacy_steer_upgrade_keeps_accepted_unknown_and_unfinished_sources`（迁移冻结行比较）在未修改的基线归档上同样失败。
可选启动矩阵中的 skills `.staging` 故障也在基线同样得到 ready 而非预期 degraded；其余四项通过。
这些既有测试问题未通过改生产行为、移除测试或新增例外掩盖，不计为本次通过项。

User sequence 8 要求先验证开发包，稍后退出日常 App；尚未复制运行中的日常数据库，也未停止当前宿主。
最终仍需保留日常原会话的隔离副本、原队员/原 Runtime 的真实新任务、正常停止/重开，以及安装路径 App/Host 构建核对。
开发包通过不单独代表最终验收完成。
