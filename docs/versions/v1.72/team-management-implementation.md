---
document_type: implementation-plan
version: v1.72
status: implemented-gate-failed
last_updated: 2026-10-19
---

# Team 管理实施记录

- Work item: Issue #504；Thread sequence 29 确认实施中文/英文 V9 交互及上下文 R1。
- Worktree: `/Users/murray.xue/VSCodeProjects/opensource/rovai-ai-team-management`
- Branch: `rovai/team-management`
- Base: `origin/main` / `9a5127ed8a26531808a61c62565c097cf498fd43`
- Governance: 功能分支文档先行，无主线先行要求。
- Status: 功能已实现；通用上下文 Gate 为 `degraded`，不能作为放行通过。
- Validation: Rust、TypeScript、构建、组件交互和五项真实模型定向验证已完成，详见下文。
- Next: 本分支供审阅；通用 Gate 的已知失败、耗时退化与语义证据缺口见下文，不把定向验证外推为语义门禁通过。

## 已确认范围

Team 独立入口、列表与详情、可选指引、下拉添加队员、行内悬停 Make lead/Remove 图标操作、
复制/删除及未保存防护；MCP 风格空态；6/12 人与 Mobile。中英文及双主题沿用生产组件。

General 保留一键创建配置：Team 或 Custom；原偏好保留为 Custom，不自动建 Team，不提供管理跳转。
新对话 Custom 在第一项且可选择队员和队长；保存的 Team 只读选择，不在 Dialog 调整、另存为 Team。
新对话主按钮沿用中性色。Memory 入口移至 Settings，待审核快捷入口和数字保留。

上下文只按 [R1](model-context-change-team-guidance.md)增加可选 Bootstrap 段，无会话级指引编辑。
当前 Thread 的后续成员和 Lead 仍独立于 Team 模板。

## 实施次序

1. Team 持久化、CRUD、版本冲突与共享偏好；旧数据不自动生成 Team。
2. 创建时复验所选 Team，固定启动指引；绑定、恢复、预算与旧版本兼容。
3. Desktop/Web/Mobile 共用 Team 界面、General 和新对话入口；双语与主题检查。
4. 定向测试、迁移、文档门禁、Rust 默认回归、构建和隔离 UI/Runtime 验收。
5. 提交并推送任务分支。按 User 的当前偏好不自动创建 PR，不关闭 Issue，不安装日常 App。

## 测试准入记录

- Team 事务新增独立 owner `teams::tests::templates_preserve_custom_defaults_and_freeze_thread_guidance`：旧代码无 Team 事务入口，不能由现有 Thread 创建测试覆盖 Team CRUD、旧 JSON 导入和删除偏好原子回退。使用 `extended-tests` 与独立数据库克隆；最小命令 `cargo test -p rovai-core --features extended-tests teams::tests::`。
- Bootstrap 格式、字节预算与恢复扩展现有 `bootstrap_formatter_has_fixed_three_section_and_identity_field_order`、`newly_bound_session_bootstraps_on_its_current_generation`、`single_chat_materializes_conversation_input_with_a_memory_free_bootstrap`，不新增同构 fixture。旧失败输入是非空 Team 指引与 Single Chat 同时关联同一 Thread。最小命令分别按上述测试名筛选，DB/Runtime owner 使用既有 `slow-tests`。

## 已实现边界

- [Team Templates v1](../../contracts/team-templates-v1.md)：User 专属 CRUD、版本比较、持久命令回执；删除默认 Team 与清理选择在同一事务，独立 Custom 保留。
- Migration 209 / schema 159：导入旧 JSON 创建偏好，不自动生成 Team；Thread 创建使用同一版本的权威成员、队长和指引，失败整体回滚。
- [Bootstrap v6](../../contracts/native-session-bootstrap-v6.md)：仅非空的创建时指引进入 Bootstrap；旧证据按旧版本恢复，Single Chat 始终省略；实际字节预算与冻结输入包含指引。Charter、Binding、Dynamic Context 和 Profile 版本不变。
- [Team workspace](../../ui/components/team-workspace.md)：生产布局、下拉选人、行内操作、未保存防护、回执未知时原命令重试；Desktop/Web 共用。Memory 移入 Settings，保留待审核快捷入口。
- 复制前选择“保存并继续”会复制刚保存的内容；手机端 Team 保留全局导航入口，Memory 只显示设置页标题。

## 验证记录

测试日志、隔离计划、报告和截图保存在本次 Thread 附件的 `team-management-validation/`，不向仓库提交 Runtime 原始私有证据。
附件根目录为 `/Users/murray.xue/.rovai/instances/v1-ea1b0333b2d3194639a0b5a284275214dc868bf6ebe8bea219653f7c2cd7a4b3/attachments/rvcamp_01m579sezwfgsrrvsmhq203n8e/`。

| 检查 | 结果与范围 |
| --- | --- |
| `cargo check --workspace --jobs 4` | 通过 |
| `cargo test --workspace --jobs 4` | 474 通过、0 失败；1 项既有人工检查忽略 |
| Team 独立事务 owner | 1 通过，覆盖迁移兼容、CAS、重复命令、创建回滚、指引固定、删除和 Custom 保留 |
| `context::slow_tests::` | 45 通过，包含 Single Chat、省略、冻结恢复、大小预算 |
| 数据库现态与迁移检查 | current 3 项、contract preflight 1 项、historical rows 1 项通过 |
| `pnpm test` | Vitest 246 文件 / 2782 项通过；Node 357 通过、2 项平台跳过；文档与 Skill 门禁通过 |
| 最后 UI 修正后的定向 Vitest | App、GeneralSettings、创建偏好、Web 偏好四文件 204 项通过 |
| `pnpm typecheck` | 最终修改后通过 |
| `pnpm exec electron-vite build`、`pnpm build:web` | 最终修改后通过；Web 保留既有大 chunk 提示 |
| UI 实测 | 中文日间、英文夜间；4/6/12 人、390×844、空态、下拉选人、设队长、CRUD、未保存提示、Custom 往返保留、Team 只读摘要 |

组件验收入口为 `node scripts/fixtures/team-management/serve.mjs`；用途与限制见
[fixture 说明](../../../scripts/fixtures/team-management/README.md)。截图为 `team-desktop-day.jpg`、
`team-mobile-night.jpg`、`team-empty-day.jpg`。这是生产组件的隔离验收，不表示运行或安装了日常 App。

### 定向真实模型验证

使用独立 `automatic_acceptance` Core，数据、Skill Library、MCP 与运行目录均在
`team-management-validation/guidance-probe-02/`。Codex CLI 真实完成 5 个 Run：

1. 首次启动读取 `TEAM_ALPHA`。
2. Team 修改为 `TEAM_BETA` 后，旧 Thread 中首次启动的另一队员仍读取 `TEAM_ALPHA`。
3. 新 Thread 读取 `TEAM_BETA`。
4. 当轮 User 明确要求 `USER_OVERRIDE` 时按该要求回复。
5. 删除 Team 后，旧 Thread 恢复仍读取 `TEAM_ALPHA`。

全部通过，报告为 `guidance-probe-report-02.json`，Core 已正常退出。候选 Core digest 为
`ee44a43d26534c63b9b63f4e18d46ece230e3ee73c45d9b3bada0e1f1fdccb35`。
该结果只证明上述合成任务的行为，不替代通用语义 Gate。

### 保留的初次失败

- 初次完整 Vitest 在并行编译时出现两项 5 秒超时；定向 79 项及之后完整 2782 项均通过，没有为此放宽超时。
- 两项旧 context fixture 的版本断言在未改动基线也失败：attachment-only 仍期待 39/39/10；legacy claim 实际创建当前 40 却期待 38。修正既有测试的 fixture/断言后 45 项通过，基线原始日志保留。
- Node product contract 仍期待 schema 158，按实际 Migration 209 更新为 159 后全套通过。
- 首次定向驱动未提交 execution admission，却要求 `accepted` 回执，实际收到仅发布消息的 `applied`；当次未执行模型验证，报告 `guidance-probe-report.json` 保留。修正驱动后使用全新 `guidance-probe-02` 数据目录完成五项验证，没有改动产品实现。

## 通用上下文 Gate

基线为同一 base 的独立 detached worktree `rovai-ai-team-baseline`；候选与基线分别构建，
每个 slot 使用独立 `automatic_acceptance` 目录，具体路径预先记录于 `isolation-plan.json`。
固定 common12、每例一次、新旧两侧共 24 slots、最多两个并行 Case；本 campaign 最多两次尝试。
固定计划摘要为 `97bcacba7181132b44fde8d86de53ed744cd1617475d6c5899240bfae1a70778`。

`attempt-01` 已完成全部 24 slots：两侧各 16/16 合同检查通过，硬性任务各 11/12 通过，
24 次均正常收敛并回收 Runtime，无评测器故障。报告最终为 `degraded`：

- `DEMO-105`：新旧版本都未创建要求的 `report.json`，属于已有失败；报告明确 `newRegression: false`。
- `DEMO-112`：两侧产物验收通过，但 dispatch-to-terminal 从 22.520 秒增至 204.424 秒，超过固定耗时门槛。
  候选只有一个 Run、无 A2A、没有超预算或残留进程；主要间隔位于同一原生 Run 的两条工具完成事件之间
  （16:01:08.055 至 16:04:13.389 UTC）。现有证据不足以区分模型决策、提供者等待或其他原生 Runtime 延迟，
  不能认定为 Team 代码导致，也不能取消这项已观测退化。
- Judge 固定为 `null`，因为没有可追溯的固定模型 snapshot；语义评价不完整，通用质量总分为空。
  109 条证据缺口覆盖 12 个 Case；不得把部分规则分数当成完整语义分数。

本次保留一次完整尝试，不改标准、不挑选成功副本。没有已定位的 Team 实现偏差可供修复重跑；
不以重复运行消除现有失败。正式放行仍需解释或解决耗时退化，并补齐合格 Judge 的同标准证据。
通用 Case 不选择 Team，指引的实际模型行为由上面的独立五项验证覆盖。

已核对 `campaign/index.html`、`campaign/attempt-01/report.html` 的本地内容、JSON 的全部 slots、
`regressions`、`evidenceGaps`、`evaluationFailures` 和 `resourceChanges`。浏览器策略拒绝 `file:` URL；
因此报告核对使用本地只读解析，没有绕过策略或宣称完成报告的浏览器渲染验收。产品界面截图来自前述独立 UI fixture。
完整报告、首次失败和原始证据均保留在附件；实现 worktree 与只读基线 worktree 保留供复查，日常 App 未启动或替换。
