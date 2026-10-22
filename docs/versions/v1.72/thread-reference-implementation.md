---
document_type: implementation-plan
version: v1.72
authority: thread-reference-implementation-and-verification
status: in_progress
last_updated: 2026-10-22
---

# 对话与使命引用、紧凑 Skills

## 已确认范围

User 在 `rvcamp_01m5hghgrte5rv5za2s20yr6cg` sequence 1、4、6、8、10、12、14
逐步确定 R6 交互，sequence 16 授权独立 worktree 实现、创建 PR 并 merge 到 main。
未采用最初转贴方案中的 Composer V3、`references[]`、上下文版本兼容或自动摘要。

公开 Composer 的 `@` 包含队员／对话／使命，保留原成员邀请语义。模糊查询完整公开目录，
无查询时展示最近 8 条，游标每次追加 8 条；单一搜索中状态、自动命中类别、手动切换固定类别。
列表定高滚动，长列表窗口化；对话／使命为无底色图标、左标题、右项目的 32px 行，无时间与结果数量提示。
Skills 使用 Rovai 图标、名称与描述同行、关联队员头像，保留工具箱／Skills 轻分组。

Composer 保持 version 2 的 Text／Atom 结构，加入显式对话、使命 Atom。目标身份只有 ID，
本机标签仅展示；首次发送事务捕获真实标题，同一 commandId 先回放。正式内容仍由
structured_content_json 拥有，无 schema 迁移、全文快照或强引用。引用不参与邀请和寻址。

新增引用通过现有正文投影生成 `rovai://thread/<id>`、`rovai://mission/<id>` 链接。
没有新增 RUN_INPUT 字段、Bootstrap 说明或 serializer 版本；已有消息与已冻结输入不变。
历史读取、初始输入和 Steer 复用现有正文 projector，预算计算沿用实际序列化路径。
目标历史仍按既有读取操作访问，选择本身不读取历史或创建 Run。

## Worktree

- 分支：`rovai/thread-mission-references`
- 路径：`/Users/murray.xue/.codex/worktrees/thread-mission-references/rovai-ai`
- 基线：`186d1cfcf0c0cfff342aa36282b35d75436613c5`（origin/main）
- 前置治理提交：不适用；已确认交互与授权随本次实施记录交付。
- 状态：active。后续：完成验证、独立审阅、PR/CI、合并后同步主线和安全清理。
- 环境：worktree 私有 node_modules / target，所有 SQLite 与浏览器验证使用隔离 fixture，未启动日常 App/Runtime。

## 验证记录

初轮验证已完成，最终复测结果在合并前补齐。

| 验证 | 结果 |
| --- | --- |
| TypeScript | `pnpm typecheck` 通过 |
| 全量前端与脚本 | `pnpm test` 通过；252 个 Vitest 文件、2871 项通过、2 项既有 skip；Node 357 项通过、2 项平台 skip |
| Rust 默认工作区 | `pnpm test:rust:pr` 通过；Core 429、CLI 31、Host 4、Web 11 项通过，1 项既有 ignore |
| Rust 专项 | Composer 内容投影、Pending 邀请/引用回滚与回放、live 目录/分页、owner 撤回清理通过；初始输入/Steer 冻结恢复复测中 |
| 构建 | `pnpm build:desktop` 通过 |
| 文档 | docs:test（随 pnpm test）、docs:check、指定基线 docs:check:ci 通过 |
| 浏览器 | 直接编译生产 ThreadWorkspace/Composer，无源码注入；隔离 Chrome profile 与固定用户目录 API。完整记录由 `scripts/smoke-thread-references.mjs` 生成，最终结果待补齐 |

扩展既有 Steer owner 时发现原 Runtime 支持集合遗漏已实现的 MiniMax；补齐该 fixture 的当前预期，
不改变 Steer 的生产资格。默认全量 Rust 不包含该扩展 owner，因此单独定向运行。
对话自动标题只使用引用的可见标题，不把模型定位 URI 放进导航名称。

Rust 用例准入：优先扩展 Composer 严格校验和 Pending 首发事务既有 owner，覆盖标签伪造、
重复引用、来源删除、命令回放及邀请回滚；目录分页拥有新的游标作用域／完整模糊搜索失败边界，
使用最小内存 SQLite 表验证，不启动 Runtime。完整数据库仅用于真实发布事务及持久回执。
