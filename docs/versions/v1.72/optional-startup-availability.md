---
document_type: implementation-record
version: v1.72
status: in_progress
last_updated: 2026-10-31
---

# 可选启动与历史维护减重

## 范围

User sequence 31 授权六项同轮，优先保证健康数据库打开原会话、健康 Runtime 在原会话原队员下继续工作。分支 `rovai/optional-startup-availability`，基线 `87576ee9487f1550fa9fc1f2999af430287a0e5d`，独立 worktree；主 checkout 的并行改动保留。无 schema、持久队列或发布版本变化。

## 实现

- 旧 Runtime Files 根只检查实例路径派生；标记、旧物理身份和目录遍历不再决定 Core 启动。任务输出使用现有独立输出目录，旧视图读写/删除按具体目标处理。
- Blob 恢复在 ready 后锁外枚举并逐条解析，短锁做引用复核及原子交接；无法证明归属、坏 JSON 与不完整写入保留。周期 GC 选择后再次检查候选及全部引用，唯一临时路径交接后锁外删除。
- Runtime 设置逐项加载，损坏保留错误与 revision，显式 CAS 修正；通用环境变量损坏也可在原编辑入口明确替换并保留旧密文版本。
- 外部 MCP 读取/迁移失败保留原文件，用既有 invalid/warnings 投影；普通任务不等待全局 MCP。既有冻结快照保持，内置工具门禁独立。
- Claude、ACP 初始化取消历史 MCP/输入遍历；当前文件 Drop 清理保持。后台只处理已有终态与真实停止确认能证明安全的 MCP 根，未知目录保留。
- Runtime 发现、当前可选服务和历史维护分别调度。维护实际循环有条数/时间/诊断预算，重试不重复启动历史扫描；Pending 空壳最多选取 32 个启动前候选，逐项事务退役，未知物理文件保留。文件变化补投影有界、逐 Run 持锁，并保留完成通知。

## 回归归属

扩展现有 Rust owner，无新增独立测试函数。Blob owner 验证坏条目不阻断有效恢复、未知写入保留、选中后重新挂接取消回收；Runtime/native-config 与 common-environment owner 覆盖原值保留、CAS 拒绝与显式修正；MCP owner 覆盖坏文件保留、冻结投影与当前文件释放；附件 owner 保留内容/路径安全和按需重建，旧根标记不再要求迁移。

随生产历史扫描退役，删除 Skill `startup_gc_skips_missing_tree_and_removes_only_uuid_shaped_orphans` 测试；不再验证凭目录名删除未知 Skill。根标记迁移子断言退役，改由原 owner 验证未知内容保留；Grok 前缀清理断言改为只清理当前任务文件。Windows 权限 owner 改为管理读取不自动修改 ACL，显式修复仍按原边界测试。没有永久 disable 的测试或专用门禁例外。

既有 Core RPC 测试覆盖原数据读取、功能局部错误与原进程重试；旧脚本中已退役的 `camp.composerDraft`/`camp.pendingInputs` 两个场景不属于本轮回归 owner，不能把其全文件结果标为通过。Runtime 设置场景同步到现行通用环境变量/显式检查接口。

## 验收状态

已完成 macOS 针对性 owner：附件 25 项、Blob 3 项、MCP projection 9 项、当前 MCP 文件 2 项、Runtime 设置保存 1 项、通用环境变量 4 项、启动配置 2 项、共享执行门禁 2 项、MCP 管理 11 项、冻结 MCP 跨重开 1 项。UI 4 个测试文件共 35 项、TypeScript 与三项文档门禁通过。实际日志保留在本轮验收目录，后续原生结果继续追加。

Core RPC 相关场景 11 项通过；macOS 的隐藏系统 Pi 不适用场景按原平台条件跳过。组合故障受控 ACP 夹具已通过：旧附件标记与不可读子目录、坏 Blob intent、Pi 坏配置、不可读外部 MCP、不可删除旧 MCP 输入与大量历史进程文件并存；原夹具 Thread 重开读取 80ms，原队员继续及新增任务成功，MCP exposure 保留 invalid，Pi 在同一 Core 修正并检查 Ready。原任务 Stop 112ms；Mission 清理及 Thread 删除通过，历史缺 ACK 未补写。夹具位于 `/private/tmp/rovai-optional-combined-mv50sq8v`，保留故障文件供复核；这是合成现场及受控协议进程，不能冒充真实用户副本或真实模型任务。

独立开发版使用关闭后的旧测试库 SQLite Backup 副本 `/private/tmp/rovai-optional-native-app-VJeU3w`，不是日常用户数据。真实 Codex 0.165.0 在同一旧 Thread、同一队员及原 conversation 下完成新任务、Stop（222ms 收到真实清理确认）、后继任务；原有 15 条 Run 和 12 条缺 ACK 状态保持。Pi 损坏项在真实设置页显示“配置异常”，未经明确选择不能保存；用户操作路径显式“恢复自动”并保存后，revision 9→10，同一 Core 检查 Ready。外部 MCP 文件依旧不可读，任务 exposure 保持 invalid 与原因。

提交 `c0d0d27955ba513cc869bb4f4e4f1e9d505bc61d` 重建开发版后再次打开同一副本，Core 61ms ready；同一旧 conversation 真实新任务、新 Thread、新 Mission 真实任务通过，Mission 工作区/分支清理及三个 Thread 删除完成。旧历史状态在删除前逐条核对未补写。运行中 Desktop 的 App Updates IPC 与 Core health 都报告 0.5.4。Desktop 启动内嵌 Core 的 Host；开发记录中的独立 `rovai-core` 摘要不作为实际 Host 身份证据，最终构建核对以下文打包 Host 摘要为准。该证据属于开发通道，不能代替安装路径验收。验收脚本首次使用已退役的 Renderer `camps.delete` 名称被拒绝，没有产生删除；改用现行 `threads.delete` 后完成，错误和修正均保留在报告中。

[PR #958](https://github.com/murray17/rovai-ai/pull/958) 保持 Draft。PR gate 已通过；[Windows 首轮原生执行](https://github.com/murray17/rovai-ai/actions/runs/41043770825)的编译、进程/数据库/权限、Blob、MCP、附件和 Runtime 设置 owner 通过，但既有环境变量退役测试因仍持有新建密钥文件句柄、删除夹具目录被 Windows 拒绝而失败。补充 `drop(file)` 后本地及[第二轮 Windows owner](https://github.com/murray17/rovai-ai/actions/runs/41045905471)全部通过，保留全部断言。

第二轮实际 Core RPC 发现本轮路径比较的 Windows 回归：普通路径与 `std::fs::canonicalize` 的 `\\?\` 前缀形式被误判为不同实例，导致启动拒绝。复用现有路径等价比较，重叠检查也接受同一表示差异；没有恢复附件树巡检。现有根准入 owner 扩展到 Windows，覆盖普通/扩展表示、超 260 字符路径、交叉表示重叠拒绝以及未创建根的准入。Mac owner 25 项通过，Windows 原生矩阵重新执行；两轮失败均不能记为全绿。

路径修正提交 `ed758df730d9762c2cb3e7ed75f06a18e6e0d1d5` 的[第三轮 Windows 原生验证](https://github.com/murray17/rovai-ai/actions/runs/41049869522)于 2026-10-30 11:57 UTC 完成，`windows-2022` 上 Windows full job 成功。相关 Rust owner 46 项、实际 Core RPC 10 项通过，后续进程、数据库、迁移中断、目录、Skill、Named Pipe 与权限矩阵完成。既有 7 个 subprocess helper 和 1 个手动真实 Runtime smoke 仍按原标记 ignored；本轮没有新增跳过。相关检查移到较早阶段以便先发现入口错误，没有取消后续矩阵。此 CI 证据不包含 Windows Desktop 界面、用户原数据或真实模型 Runtime 验收。

补跑全量 all-targets/all-features Clippy 未通过，包含基线已有的 `cline.rs` 文档空行、`authority_migration.rs` 冗余字段名等告警；本轮引入的无效尾部检查、unit struct 默认调用、Blob 多余引用和 MCP 分支写法已修正，未为通过门禁扩大到无关代码。

`pnpm package:mac:daily` 构建与 App/Host/CLI arm64、ad-hoc 签名门禁通过；这里只构建产物，未安装到日常路径。生产代码对应 `6dd1be3fc823ce332cbbc570cbe9a353c2038786`，Host 0.5.4 的 SHA-256 为 `6d193b225a752cc180f26f4da36d7fa53fa454551adb382869f64d69b665a6ac`。打包 App 在全新隔离目录 `/private/tmp/rovai-optional-packaged-1HcZCs` 打开同一旧测试库副本，Core 25ms ready；真实 Codex 新任务、Stop（219ms）和后继任务通过，Pi 仍局部报损坏、外部 MCP 保持 invalid。Pi 显式 CAS 修正后同一 Core 检查 Ready。正常退出并重开后 Core 23ms ready，修正值保留；同一旧 conversation、新 Thread、新 Mission 的真实任务、Mission 工作区清理及三个 Thread 删除均通过。打包通道与真实原数据、安装路径验收继续分开记录。

路径修正后再次按 `ed758df73` 构建并验签，在新隔离目录 `/private/tmp/rovai-optional-final-packaged-NYKWJ2` 完整复跑上述打包通道：真实 Codex 任务、Stop（210ms）、继续、重开、旧/新 Thread 及新 Mission 任务、清理和删除全部通过；Pi 同 Core 显式修正后 Ready，历史 15 条 Run/12 条缺 ACK 在删除前未改变。运行中 App/Core 均为 0.5.4，最终 Host SHA-256 为 `f469a5862526e4fdaf3bba50545f45dae50412131eb2bd48802f43aa152ee2ac`。隔离 App 已正常退出，测试库和故障文件保留；本轮日常安装版未改变。

以下仍是未完成交付门槛：保留现场的真实用户原会话/原使命副本，及其中同一原队员的真实任务、Stop/重开/清理/删除；Windows 真实原数据/Runtime 与 Desktop 验收；安装路径及 App/Core 构建核对。日常宿主 App 保持运行，未向其数据库或会话发送测试操作。既有关闭后副本规则与当前会话宿主保护仍适用；不能用这里的合成历史副本替代用户原现场。

## P2 可用性收口（User sequence 43）

复用原分支与 worktree，基线 `2bca8e020`；Governance：none；Status：implemented（PR 仍为 Draft）。修复配置 CAS 冲突返回最新基线、取消新使命旧 View 预初始化、接通当前任务 Thread 的旧附件按需恢复、放行 MCP 管理读取，以及终态文件变化的有界轮转。空 `SubsystemInitialization` 类型改用原 `Mutex<()>`，串行初始化语义保留。

扩展现有 Rust owner：`startup_saves_preserve_native_files_and_merge_only_local_preferences` 验证冲突不落盘、更新基线后可修正；`follow_up_without_new_attachments_preserves_published_view` 验证三种未 ready 状态恢复；`source_ref_dispatch_admission_ignores_broken_legacy_view` 验证生产派发前接通旧附件定位且不影响 source-only Thread；`terminal_runs_in_a_non_git_directory_project_independent_replayable_cards` 验证前八项持续失败后第九项仍被处理、末尾轮转仍可重试失败项。无新增 Rust 测试函数或 fixture 文件。

实际 Core RPC 复用 `core-startup-availability.test.mjs` 的使命/Thread 输出、可选初始化与 Runtime 设置场景。修改前的 Core 已分别复现 `.staging` 文件导致使命提交后报错、MCP 管理读取被拒绝、损坏配置 revision 冲突后无法重试；日志保留，不将这些预期失败记为修复验证。

最小验证命令：`cargo test -p rovai-core --features extended-tests,slow-tests --lib <上述 owner>`；RPC 先 `cargo build -p rovai-core --bins`，再按上述场景名称过滤 Node 测试。修复后附件 25 项、其余三个 Rust owner 各 1 项通过；首次初始化用例包含 generation 0、尚未生成目录条目的真实恢复形状。Core 构建通过，选定实际 RPC 场景共 8 项通过（含可选服务的子场景）；格式检查、文档测试及两项文档检查通过。

`pnpm test:rust:pr` 当轮未全绿：Core lib 429 通过、2 失败、1 个原有 ignored，后续 workspace target 未因此获得通过结论。失败为 `mcp_import::tests::import_commit_rehydrates_credentials_and_fences_replacement_before_startup` 与 `storage_layout::tests::standalone_runtime_root_preserves_native_admission_and_owner`。在 `2bca8e020` 复跑只能证明同一个 PR 的旧提交也有问题，不能证明 main 原本失败。User sequence 45 纠正分类：MCP 导入是本 PR 引入的缺陷；目录独占断言与本 PR 的延迟初始化行为不符，应更新原 owner。前后日志保留。

已有真实用户副本、Windows Desktop/Runtime 与安装路径验收缺口不因本轮修复消失，PR 保持 Draft。本轮仅启动隔离 Core 和测试夹具进程，未运行真实模型任务、未退出或替换日常 App。

## 旧附件读取与首次 MCP 导入修正（User sequence 45）

基线 `0a8c95847`；Governance：none；Status：implemented（PR 仍为 Draft）。上一轮整 Thread 恢复虽在后台线程执行，仍持有全局数据库锁并依赖旧清理，现已撤掉。沿用实际输入的消息选择和大小预算，分成锁内候选、锁外单文件校验、锁内记录复核与冻结；复用既有 Authority 原文件和校验器，不复制目录、修复无关 operation 或标记整个 View 已恢复。历史查询也使用具体原文件位置。已冻结输入保留原路径与证据。

MCP 导入读取改为与设置读取、提交一致的按需初始化，保留只读 inspect 和现有冲突检查。目录准入测试改验不创建旧根、不取得旧根独占；原路径、重叠拒绝、token 与日志断言保留，没有恢复启动门槛。

测试归属：扩展原 Context 附件 owner，覆盖 ready 但派生文件丢失、三种未 ready 状态、无关清理未完成及未知文件保留、所选坏源不影响好源、未选择的历史附件不读取。原 View follow-up owner 回归其发布职责，上一轮新增的三状态读取断言由 Context owner 承接；不删除测试函数。Core 派发 owner 持有数据库锁调用文件读取，验证读取不会再取得该锁。MCP 导入 owner 保留真实文件及本地接收进程，覆盖无需先打开设置即可导入。Context owner 的当前格式版本断言改用现行版本常量，历史冻结版本断言保留。派生文件丢失夹具复用跨平台移除权限工具，未新增 Windows 跳过。无新增独立 Rust 测试函数、持久状态或测试豁免。

macOS 验证：Context/派发、旧 View、历史查询、MCP 导入及目录准入共 42 项定向 Rust owner 通过；复用单附件读取器的路径与归属安全 owner 另 1 项通过。`pnpm test:rust:pr` 完整 workspace 477 通过、0 失败、1 个原有 ignored，上一轮两项失败均已修复。Core binary 构建通过；重建后的隔离 Core RPC 场景 8 项通过。文档测试、文档版本/决策检查和以 `0a8c95847` 为基线的变更检查通过。日志按本轮提交保存在附件验收目录。

本轮仅使用独立数据目录及测试夹具，不连接真实模型、不操作日常 App。上述 macOS 结果不代替当前修改的 Windows 原生验证、真实用户原会话/原使命副本与安装路径验收；这些门槛仍待完成，PR 保持 Draft。

## 主线合入授权（User sequence 50）

User 明确要求合入 main，替代此前保持 Draft 的流程安排；未完成的 Windows、真实用户副本与安装路径验收仍按上述记录保留，不以合入代替验证。sequence 47 提出的旧文件链接临界长度修补已按 sequence 48 撤回，未形成提交；本机只读核查发现旧记录存在，但无关联的当前批次或待执行输入，尚未证明该场景实际可达，因此不增加兼容机制。
