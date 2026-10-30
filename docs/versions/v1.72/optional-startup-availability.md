---
document_type: implementation-record
version: v1.72
status: in_progress
last_updated: 2026-10-30
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

提交 `c0d0d27955ba513cc869bb4f4e4f1e9d505bc61d` 重建开发版后再次打开同一副本，Core 61ms ready；同一旧 conversation 真实新任务、新 Thread、新 Mission 真实任务通过，Mission 工作区/分支清理及三个 Thread 删除完成。旧历史状态在删除前逐条核对未补写。运行中 Desktop 的 App Updates IPC 与 Core health 都报告 0.5.4；开发 Core SHA-256 为 `287d508049f65e1e31faa68af51cf8764cd8f052d5742f8f4a53ff95f84a3fb5`。该证据属于开发通道，不能代替安装路径验收。验收脚本首次使用已退役的 Renderer `camps.delete` 名称被拒绝，没有产生删除；改用现行 `threads.delete` 后完成，错误和修正均保留在报告中。

[PR #958](https://github.com/murray17/rovai-ai/pull/958) 保持 Draft。PR gate 已通过；[Windows 首轮原生执行](https://github.com/murray17/rovai-ai/actions/runs/41043770825)的编译、进程/数据库/权限、Blob、MCP、附件和 Runtime 设置 owner 通过，但既有环境变量退役测试因仍持有新建密钥文件句柄、删除夹具目录被 Windows 拒绝而失败。补充 `drop(file)` 后本地同一 owner 通过，保留全部断言并继续 Windows 重跑；不能把首轮矩阵标为全绿。补跑全量 all-targets/all-features Clippy 未通过，包含基线已有的 `cline.rs` 文档空行、`authority_migration.rs` 冗余字段名等告警；本轮引入的无效尾部检查、unit struct 默认调用、Blob 多余引用和 MCP 分支写法已修正，未为通过门禁扩大到无关代码。

`pnpm package:mac:daily` 构建与 App/Host/CLI arm64、ad-hoc 签名门禁通过；这里只构建产物，未安装到日常路径。生产代码对应 `6dd1be3fc823ce332cbbc570cbe9a353c2038786`，Host 0.5.4 的 SHA-256 为 `6d193b225a752cc180f26f4da36d7fa53fa454551adb382869f64d69b665a6ac`。打包 App 在全新隔离目录 `/private/tmp/rovai-optional-packaged-1HcZCs` 打开同一旧测试库副本，Core 25ms ready；真实 Codex 新任务、Stop（219ms）和后继任务通过，Pi 仍局部报损坏、外部 MCP 保持 invalid。Pi 显式 CAS 修正后同一 Core 检查 Ready。打包通道与真实原数据、安装路径验收继续分开记录。

以下仍是未完成交付门槛：保留现场的真实用户原会话/原使命副本，及其中同一原队员的真实任务、Stop/重开/清理/删除；Windows 原生执行的最终结果及真实原数据/Runtime 验收；安装路径及 App/Core 构建核对。日常宿主 App 保持运行，未向其数据库或会话发送测试操作。既有关闭后副本规则与当前会话宿主保护仍适用；不能用这里的合成历史副本替代用户原现场。
