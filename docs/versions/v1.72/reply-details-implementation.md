---
document_type: implementation-plan
version: v1.72
lifecycle: current
authority: reply-details-implementation
last_updated: 2026-10-21
---

# 回复详情实施记录

User 确认 B 方案，并授权实现、PR 合并 main、安装本机 App。当前合同为
[Thread Replies v1](../../contracts/thread-replies-v1.md)，UI 边界见
[回复详情](../../ui/components/conversation-workspace.md#回复详情)。

## 实现

- `read_model/replies.rs` 按 Thread 内单父关系读取完整链身份，复用回复索引和单页正文 hydration。
  Desktop/Web allowlist、Core 分发与 TypeScript DTO 同步。无迁移、无模型上下文变化。
- `ThreadReplyReader` 拥有最多 8 页缓存、请求合并、水位/代际校验与失效；页面只渲染 50 条。
- `ReplyDetails` 提供只读列表、双向分页、悬浮复制/定位、宽度调整及完整阅读。
  ThreadWorkspace 复用原文定位、结构化正文、附件与精确 Run 执行过程，关闭详情不卸载 Composer。
- 执行来源行采用 B 的 14px 内缩。普通回复块移入现有气泡，回复详情不重复回复块。

## 验证边界与 owner

新增 Rust owner `reply_pages_follow_only_scoped_parent_links_and_hydrate_one_page` 属于
`read_model::camp_open_slow_tests`：直接回复预览的已有 owner 只取一条子消息，不能证明完整后继、
分页、删除父节点穿透、循环终止与链遍历规模，因此新增一个复用原 SQLite fixture 的 owner。
修复前不存在端点，输入“孙回复 + 两个话题 + 删除父节点”不能返回完整且隔离的链。
该合同必须真实 SQLite 才能验证递归索引路径、事务与 hydration；不引入 Runtime 或真实用户数据。
最小命令：`cargo test -p rovai-core --features slow-tests --lib reply_pages_follow_only -- --nocapture`。

Renderer 请求生命周期由 `thread-reply-reader.test.ts` 拥有，覆盖闭合零读取、缓存、翻页、单飞行合并、
迟到响应、卸载、失效立即隐藏、错误/水位/Thread 校验与活动 Run 锚点刷新。界面 fixture 复用
`scripts/fixtures/run-presence`，`?replies=1` / `?replies=long` 提供双话题合批及长链场景。

验收与最终门禁结果在合入前补齐；当前实现不把静态 fixture 误报为真实 Runtime 验证。

## 工作区

Work item: 回复链只读详情

Worktree: `/Users/murray.xue/.codex/worktrees/reply-chain-details/rovai-ai`

Branch: `rovai/reply-chain-details`

Base: `origin/main` / `c83ce446804d5333aa5e7b6fb2b91f25071a491b`

Governance: none（无需主线先行）

Status: active

Next: 完成门禁、PR 合并与隔离验收后的非终止安装。
