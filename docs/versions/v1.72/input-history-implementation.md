---
document_type: implementation-plan
version: v1.72
authority: version-implementation-and-acceptance
status: implemented
last_updated: 2026-10-21
---

# 输入框上下键历史

User 于 2026-10-21 授权创建 worktree 后执行已确认的简化方案。合同为
[Input History v1](../../contracts/input-history-v1.md)。真实 ID 回执后入缓存，允许暖缓存陈旧，
不维护撤回，取消的 pending 有正文即纳入。键盘采用文档绝对起止边界，候选菜单/IME 优先。

Worktree：`/Users/murray.xue/VSCodeProjects/opensource/rovai-ai-input-history`；
分支：`rovai/input-history`；基线：`ce8351dad894a643ce9eabb8fc540385ac8c8d9b`（origin/main）。
无主线治理先行要求。按 User 既有偏好完成后提交并推送分支，PR 由后续显式指示决定。

## 实现边界

- Core `input_history` 直接读取现有 Message/Pending，拥有筛选、稳定身份、排序、opaque cursor；
- Desktop Main、Web operation allowlist、TS contracts 接入两个只读方法；
- Renderer `InputHistoryStore` 负责共享分页/LRU，`InputHistoryNavigation` 负责瞬时浏览；
- Public Lexical/Single Chat textarea adapter 分别处理 selection、预览和草稿接管；
- `ComposerDraftSync` 保留原保存队列，预览只更新有效输入；发送仍由原入口捕获、flush；
- 成功回执后记录实际内容，失败/缺失回执不增加历史恢复流程。

无数据库 schema 迁移、模型上下文、Built-in CLI、Skill、Runtime 或发布版本改变。
局部缓存和输入交互可独立修改，未达到高成本架构决定准入条件，不增加 Version Decision。

## 验证归属

| Owner | 独立失败语义 |
| --- | --- |
| `input_history::tests` | 公共筛选后的 20+1 分页；单聊发布保持身份/时间、cancelled 纳入、清空不复活与会话隔离 |
| `input-history.test.ts` | 请求复用/重试、提交归并/重建顺序、8 会话 LRU、100 条裁剪与迟到旧页续读、异步取消 |
| `composer-draft-sync.test.ts` | 预览驱动接收者，自动保存/leave flush 保留原稿；编辑/发送接管 |
| CampOpen Electron fixture | 生产工作区的键盘、Atom、分页、迟到读取、Undo/Redo、显示/发送一致、重挂载 |
| Single Chat Electron fixture | 原稿、Esc 不关闭、停止/发送切换、pending ID 入缓存和编辑 |

原时间线 owner 没有筛选后分页、pending/正式消息统一身份的路径，所以新增两个 Core 查询测试。
使用最小 in-memory SQLite 表，不启动完整 Database/Runtime；纯函数不能证明 SQL 关联/keyset。
最小命令：`cargo test -p rovai-core --lib input_history::`。前端扩展原保存器及生产 UI fixture，
未建立第二套 App/模型验收环境。

## 验证结果

| 命令/范围 | 结果 |
| --- | --- |
| `cargo test --workspace` | 476 passed，1 个既有 ignored；查询 SQL 调整后两个 `input_history::` owner 再次通过 |
| `pnpm test` | 247 个 Vitest 文件、2,814 项通过；后续 Node 357 passed、2 个平台限定 skip；文档、Skill、sandbox 门禁通过 |
| `pnpm test:composer-input` | 3 项原生 Composer/邀请/Web 链接场景通过，含 IME、光标与长文本输入 |
| CampOpen/Single Chat 相关 Electron 回归 | 8 项通过：两种输入历史、Public 草稿、Steer、Single Chat 布局、撤回恢复、原生/网页链接 |
| `pnpm typecheck`、`pnpm build:desktop` | 通过，包含共享 Renderer 与 Web 构建 |
| `cargo fmt --all -- --check`、`git diff --check` | 通过 |
| `DOCS_BASE_REF=ce8351dad894a643ce9eabb8fc540385ac8c8d9b pnpm docs:check:ci` | 通过 |

验收中修复了裁剪期间迟到空页覆盖游标、无 cursor 条目重建顺序，以及 Atom 展示刷新污染 Undo 的问题。
原 Steer 场景把多接收者按钮断言为“发送”，在未修改基线也同样失败；按现行 UI 合同修正为“优先插话”，
16 个分支、两种主题通过。一次并行构建期间，既有导航偏好测试超过 5 秒；单独 17 项以及之后完整重跑均通过。

Electron 夹具使用脚本生成的独立绝对 userData；输入历史场景不启动 Core、SQLite、Skill Library 或模型。
原 Composer 邀请回归使用其独立 fixture Skill Library。不据此声称真实 Runtime 或跨端实时同步已验证。
