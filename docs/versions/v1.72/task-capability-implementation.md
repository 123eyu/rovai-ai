---
document_type: research-report
authority: task-capability-implementation-evidence
status: implemented-gate-insufficient
last_updated: 2026-10-17
---

# 会话 Task 开关实施与验证

按 User 消息 `fd9bee73-2ea8-4798-9d3d-dbb9ca067963` 授权，在独立 worktree 的
`rovai/task-capability` 分支实施 [R4](model-context-change-task-capability.md)。主分支基线为
`c69a97fbff1e986bbd1ff12ecfa55797b73e0553`；交互依据为
[现有风格设计稿](../../research/task-capability-ui.md)。本页记录实际实现及证据，不改变已确认的模型输入方案。
功能实施与隔离界面验收完成；真实 Runtime 上下文 Gate 为证据不足，不能视为完整验收通过。

## 已实现行为

| 范围 | 结果 |
| --- | --- |
| 设置 | Core 实例级持久开关，默认关闭。设置位于通用 → 会话 → 世界地图下方；保存失败只影响这一行，并可重试 |
| 旧任务 | 关闭后也不再允许新读取或更新，数据保留；重新开启后恢复管理 |
| 执行可用性 | 随时切换，不等待任务结算，不取消 Run、消息或队列；实际操作在同一锁/事务内检查当前开关 |
| Bootstrap / Skill | 开关两态共用精简教学；去掉 Task 对象依赖，不增加关闭说明。Native Session compatibility 仍为 16 |
| 动态上下文 | 关闭时不选择或输出 SELF_ACTIVE_TASKS；新 Run Facts 移除 taskContext、singleChat.taskMutationAllowed；已冻结输入保持原字节 |
| CLI / 工具 | 关闭时 help、目录、schema 不发现 Task。CLI help 只读本地能力投影，不发 IPC；缺失、损坏、未知或未绑定投影按关闭处理 |
| Task 直接调用 | 返回 task.feature_disabled / recovery stop，CLI exit 2；只拒绝该次操作，不中止当前执行 |
| Send | 开关两态共用无 Task 关联的定义。合法旧 taskId（含 null）兼容为普通发送；不推导接收者，不检查任务负责人/状态 |
| 读侧 / 通知 | 关闭时省略 Task 数据、覆盖率及计数；通知在 SQL LIMIT 前过滤，未读数排除任务；关闭期间不新建任务提醒，旧通知导航退回来源会话 |
| 会话界面 | 真实 DOM 顺序为执行、队员、单聊、任务；任务为可选第 4 项。关闭时卸载 Task 面板/弹窗，保留消息草稿与阅读状态 |
| 快捷键 | v1→v2 一次性统一执行/队员/单聊/任务为 Mod+1/2/3/4；清除其他操作对这四键的占用，保留其余键位、侧键和发送方式 |
| 快捷键关闭态 | 隐藏并停用任务键位和侧键；不消费输入。隐藏任务键位被其他操作使用时原子转移，重开不抢回；迁移失败保留磁盘原值并提供重试 |
| Host Web | 同步 Core 的开关事件；切换 Host 或重连时先按未知/关闭处理，旧响应不能恢复旧 Host 的能力 |

Task 历史消息、审计、旧关联、已提交回执仍可按原有历史/恢复规则保留。领域 commandId 重试遵循
既有“返回首次提交结果”语义；CLI 的 requestId 另外校验原始请求摘要，旧 taskId 仍参与该摘要。
这两个幂等边界保持各自原语义，没有为了兼容旧 Send 丢弃身份字段。

## 合同与迁移

Migration 205 将 schema 从 154 升到 155，只新增设置及新输入格式准入，不重写旧任务或冻结输入。
新公开输入使用 ContextManifest 40 / Profile 15 / Facts 11；非批量输入使用 41 / 16 / 12。
旧 Steer 输入唯一性、来源关联和不可变约束继续参与数据库准入；迁移故障回滚后可重试。

本次继任合同为 Durable Task v6、Built-in Transport v42、Context Manifest v40、Context Delivery Profile v15、
Run Facts v9、Send v28、Continuation v4、Camp Open v30、Notification Episode v10、Desktop Shortcuts v2、Host Web v6。
当前权威入口已更新，历史合同不追改。

## 已完成检查

| 检查 | 实际结果与范围 |
| --- | --- |
| Renderer / shared / Main Vitest | 246 文件、2729 测试通过 |
| 通知最终定向回归 | App 与通知 owner 共 203 测试通过；随后 typecheck 与 Desktop 构建通过 |
| Node 包测试组 | 375 通过，2 个既有 Windows 专属项跳过；总数 377 |
| Rust 默认 workspace | 473 通过，1 个既有人工验收项忽略；Core lib 为 427 通过 |
| Rust 扩展 workspace | Core 1026 项：1010 通过、8 个既有忽略、8 处旧 fixture/版本断言失败；修正后八个失败 owner 全部定向复验通过。完整扩展命令在 Core 失败后停止，未重跑全套，不写作一次全绿 |
| TeamTool owner | 56 通过；覆盖旧 taskId、不推导接收者、publicOnly 和既有回执 |
| Steer 与迁移 owner | Steer 3 通过，来源布局收敛 1 通过，当前库准入 1 通过；当前 schema 两项、成员路由及 v95/v98/v172 历史升级 owner 复验通过 |
| Pending 邀请 / Task 升级 / 续做 owner | 首次发送接受合法旧 taskId 且保持邀请原子性；Task 迁移 owner（extended + slow）通过；续做按当前开关读取 Task，同时保留原冻结输入 |
| Single Chat owner | 15 通过 |
| CLI | 单元 31 通过；真实 CLI 文件输入/能力投影进程 owner 通过，帮助零 IPC |
| 通知分页 owner | 通过：任务不占分页、不计未读，关闭不新增任务提醒，重开恢复原条目 |
| 通知 Electron fixture | 两个 owner 分别通过：设置偏好保留、任务提醒关闭撤下/重开不补弹、普通提醒保留、执行/任务/使命来源定位；旧 fixture 补齐显式开启与当前 snapshot schema 后复验 |
| 快捷键 Electron fixture | Darwin / Windows 分支通过；真实键盘输入、浅/深色、中英文、冲突及保存失败路径覆盖 |
| 类型 / 构建 / 桥接 | typecheck、build:desktop、cargo check workspace、cargo fmt check、Desktop request bridge 通过 |
| 文档与 Skills | docs:check、docs:check:ci（基线 c69a97f）、docs:test、skills:check 通过 |

普通回归与专项检查的结果不能替代真实 Runtime 上下文 Gate；下面单独记录。
Windows 快捷键 fixture 在 macOS 执行，只证明 Windows 分支控制流和渲染，未声称 Windows 真机或物理鼠标验收。

## 隔离 App 操作验证

使用 `pnpm dev` 和 worktree 下独立的 `.local/task-capability-ui`，Skill Library 位于同一隔离目录。
没有复制或写入日常数据库，没有停止、升级或部署日常 App。验证结束后已停止该开发实例。

实际通过的交互链路：

1. 默认关闭时检查通用设置位置，开启后四项入口按执行/队员/单聊/任务排列，⌘4 打开任务面板。
2. 在隔离会话创建“任务开关隔离验收”，保留未发送草稿“验收草稿：切换任务开关后保留。”；不启动 Agent Run。
3. 关闭后任务入口、面板、提醒分类、快捷键行消失，⌘4 不打开任务，草稿仍在。
4. 重新开启后同一任务及 pending 状态恢复，数量为 1，草稿仍在。

## 上下文 Gate

基线和候选使用独立二进制、数据目录、Skill Library 与测试项目；固定 Suite 2.12.0 的 12 个通用 Case，
两侧各一轮，三位 Codex CLI 队员，模型 gpt-6.1-sol / medium，最多同时执行两个 Case。
预算及评分标准沿用已冻结的 R4 配置，不因结果修改。

Judge 准备返回 `judge.cli_tools_not_disabled`，未产生合格配置。本轮使用 `judge: null` 验证真实执行与机械规则；
即使它们全部通过，整体也只能报告语义评估证据不足，不能写作完整 Gate 通过。

第一次 attempt 在基线离线检查阶段中断；尚未执行 Runtime Case。中断原因和日志保留在原 campaign，
修复合同 owner 名称与测试版本后使用同一 campaign 的第二次机会，不删除旧尝试或另建 campaign 重置计数。
第二次 `attempt-02` 已结束，CLI exit 2，报告状态为 `insufficient`：

| 检查 | 结果 |
| --- | --- |
| Current Contract Conformance | 基线和候选各 16 项全部通过，进程 exit 0 |
| DEMO-101～112 | 两侧共 24 个 slot，全部在 preflight 结束，`dispatchAccepted: false` |
| 预检原因 | 两侧均为 `frozen member Runtime drifted: agent_1`；Runner 对配置后成员的 readiness、adapter、model、permissions 与冻结计划进行核对时未通过 |
| 语义评价 | Judge 未运行，质量覆盖率 0%；质量分、协作结果与资源比较均不可用 |
| 比较结论 | `regressions` 0、`evaluationFailures` 0、`evidenceGaps` 54；没有可比较的真实执行，不能由空退化列表得出“没有退化” |

已打开原 campaign `index.html` 和 `attempt-02/report.html`，核对版本、两次尝试、结论、逐 slot、
证据缺口及资源比较。第一次不完整尝试仍列为证据不足并保留中断说明。
本 campaign 达到两次上限，按[评测流程](../../development/evaluation.md#上下文改动-gate)停止；
没有删除失败、修改冻结标准、绕过 Runtime 校验或另建同标准 campaign 重置次数。
真实上下文质量与协作验证仍待解决 Runtime 预检和 Judge 工具禁用问题后完成。

本地证据根目录为 `.local/task-capability-validation/campaign`，原始报告与私有测试状态不提交仓库。
冻结 Plan digest 为 `7753863c4bb267bde01c0da1d9764104281dd25e0aeb2026e16620c3e89f2e58`；
候选源码摘要为 `a972a7673704d03d5824f277f9b1dd529bf4bb726b029c4cb39d695fa631cb19`，
Core 摘要为 `f6096353486a30d8a88126894e9d4bd8b172fe3f8e68628c94196c1e97c85e14`。
构建记录的候选 Git HEAD 是提交前的 `d30c1fe`，实际改动由源码摘要冻结；报告完成后再提交实现。
已确认 R4 文档保持冻结版本，最新实施状态由本页提供。

## 交付边界

本分支实施 R4，无每会话覆盖、Agent 改设置、数据清理或自动转换任务。此次不包含主分支合并、发版或日常 App 安装。
历史 Session 可能仍含旧说明，Core 按当前开关执行；已冻结输入继续按原证据恢复，这是有意保留的连续性边界。
