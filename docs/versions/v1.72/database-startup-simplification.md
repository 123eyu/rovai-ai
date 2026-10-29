---
document_type: implementation-plan
version: v1.72
status: in_progress
last_updated: 2026-10-29
---

# 数据库启动减重实施与验收

目标来源是 2026-10-29 User 的完整要求：普通用户稳定打开；已有库失败保留数据并可恢复；不再为元数据/普通可用权限
设置自定义启动模板；完成实现、验证、PR Review/CI、合并和遵守当前宿主保护的本地安装。

基线 `4d3aba9a550f2798245a18af403d0cbaa7bea7f8`（最新 origin/main），独立 worktree/分支
`rovai/database-startup-simplify`。原工作目录及其他任务分支保持。当前 v1.72/schema 168/receipt 218；不新增迁移、
不更改业务数据格式/模型上下文/Runtime 平台资格，不调整版本指针或发布版本。

## 阻断条件与数据保护归属

| 原条件 | 保护对象与处置 | 当前承担者 |
| --- | --- | --- |
| Core 目录 OS 排他锁 | 阻止同一库的重复业务执行，保留 | OS 锁 + Core lease |
| 路径类型、reparse/symlink、主文件被替换 | 防止写错对象或失联库，保留基本身份检查 | OS 句柄/NOFOLLOW + Core |
| 两个主库、无主库但有 WAL/journal | 不猜库、不删除可能承载已提交数据的日志，恢复面 | Core 路径选择 |
| main/WAL/journal 时间戳/长度/状态快照 | 正常元数据和 SQLite 恢复不代表数据危险，删除 | SQLite 日志/事务 |
| macOS provenance 特判与再准入预算 | 删除，无平台例外 | 同一读写连接 |
| 只读预审、关闭、重开、重复结构检查 | 删除；版本分类后直接复用连接 | SQLite + Core 版本检查 |
| 当前版本全部历史功能/receipt 校验 | 移到对应升级；当前仅 marker/最终 receipt/无未来 receipt/核心表 | 事务 marker + 最终完成记录 |
| 未知/未来版本、当前缺少完成记录 | 防止错误程序写入不兼容数据，保留拒绝 | Core |
| 逐版本 DDL/DML/marker/receipt | 失败回滚当前步，中断从已提交步骤续跑，保留 | SQLite IMMEDIATE 事务 |
| SQLite 损坏/实际读写失败 | 原库原地保留，诊断/重试，禁止空库替代 | SQLite/OS 实际错误 |
| 新库发布竞态 | 两 namespace 确认无 main/log 后 staging + no-replace | 原子文件发布 |
| Windows 已有 ACL 模板/owner/WRITE_DAC | 数据库/启动必需路径删除模板准入与修权 | OS 实际读写；新对象创建保护 |
| 凭据 private API、Runtime 授权边界 | 不因启动减重放宽，按调用点区分 | 专用存储/平台合同 |
| 旧 manifest identity/state | 仅已存在的旧切换恢复仍需辨别原库/新库，保留 | Legacy recovery |

所有宿主经 `application::run_core` → DatabaseAdmission → Database/AuthorityMigrationRunner，共享锁/连接/迁移策略。
Desktop 窗口由 Electron 独立维持；SQLite 每次锁争用 5 秒等待，Core 不套恢复重试；Desktop 明确瞬时失败最多再启动一次，
间隔 250ms。CLI/Web/Server 原样传递结果。UI 沿用可响应加载画布与恢复入口，不显示技术阶段。

## 外部参考与未采用部分

- [AionUi 的 AionCore SQLite](https://github.com/iOfficeAI/AionCore/blob/main/crates/aionui-db/src/database.rs)：普通打开、SQLite 超时与迁移；不采用损坏库自动备份后新建的策略。
- [Codeg 数据库入口](https://github.com/spacering-net/codeg/blob/main/src-tauri/src/db/mod.rs)：SQLite WAL/5 秒等待，迁移连接后建立运行连接池；参考其直接操作数据库的原则，不把连接池数误述为一个连接。
- [Multica Server](https://github.com/multica-ai/multica/blob/main/server/cmd/server/main.go)：PostgreSQL 的瞬时故障有界重试，只参考重试归属。
- [Windows Fleet PR #943](https://github.com/murray17/rovai-ai/pull/943)：沿用实际权限原则，数据库/启动目录采用专用调用点，不修改公共 private API。

## 测试归属与退役

优先扩展现有 owner，不新增 Rust 测试函数。`database_admission::confirmed_absence_initializes_and_reopens_a_current_authority`
覆盖首次/当前/原数据、真实 macOS main/WAL xattr、连接间合法提交、短锁等待与持续 busy、未来版本/缺最终 receipt/
双主库/损坏不覆盖；Windows 同一 owner 覆盖继承权限、额外 ACE、可写但无 WRITE_DAC、实际只读失败及 ACL 未改写。
孤立 WAL owner 扩为两 namespace 的 WAL/journal 表驱动；SQLite crash writer 保留真实进程强杀的 DELETE/WAL 恢复和已提交行。
Core lock 原有两个 Windows 拒绝继承 ACL 的 owner 改验正常获取、第二实例拒绝与释放后再获取。

迁移原位 owner 保留所有历史来源矩阵、会话/草稿保留；process-kill owner 保留 reconciliation、提交后续跑和旧 switch 两侧。
路径变动 owner 保留主文件移除/替换/另一 namespace，以及最终迁移后移除/替换不创建空库。
退出的 case 是 sidecar 状态变化与已删除的 reopen 边界，不再以正常日志变化作为身份攻击。

退役 `changing_an_orphan_shm_invalidates_the_ticket_instead_of_deleting_it` 与
`read_probe_tolerates_only_a_new_empty_wal_not_authority_changes`：相应文件状态票据、只读预审与 macOS 特判生产代码已删除，
有价值的日志恢复/原数据保留由上述 crash/metadata/absence owners 继承。
退役 `admitted_migration_rechecks_contract_schema_and_exact_receipts_before_writing`：快照票据/schema-cookie/applied-at
重比合同已退出；源版本合法性、每步事务回滚、未完成迁移续跑及路径保护仍由原位/rollback/kill owners 承担。
既有历史迁移测试未取消或降级；深度验证不移到健康打开。

最小命令：`cargo test -p rovai-core --lib --features extended-tests database_admission::`、
`cargo test -p rovai-core --lib --features extended-tests authority_migration::`、`pnpm test:core-startup`、
`pnpm test:host-startup`、CoreClient Vitest。提交前默认 `pnpm test:rust:pr`、typecheck 和通用 docs gates。
原生 Windows 通过 Full check 的 windows-runtime scope 执行权限/SQLite/迁移 owners，不以跨平台模拟替代。
所有自动 fixture 使用临时 data/Skill Library/MCP 和按实例派生的独立 Runtime Files Root，不连接真实模型。

## 验收与交付记录

正在执行最终定向/默认测试、性能对照、原生 Windows CI 和独立 Review；结果完成后补录。
macOS 已完成真实 setxattr(main/WAL) 与迁移期间来源标记测试，首次打开成功且成员数据保留；已完成旧版本矩阵、
逐步 rollback、实际进程中断与旧 switch 恢复。完整统计以最终提交下的运行结果为准。

日常 App 是当前会话宿主；安装不得自动结束现有 App/Core/Runtime。必须先完成隔离安装包打开验证，再按非终止安装流程
备份并替换 bundle，保留旧运行进程直到用户正常退出。没有新宿主实开证据时明确标为待验证，不把 bundle 安装成功称为重启完成。
回滚使用安装前的 App 备份或同 schema 的基线程序；不回滚/删除数据库或日志。旧程序可能恢复原元数据误阻断。
