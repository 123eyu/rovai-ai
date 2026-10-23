---
document_type: implementation-plan
version: v1.72
authority: thread-reference-implementation-and-verification
status: verified
last_updated: 2026-10-23
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
- 状态：已通过 PR #877 合入 main（`4dfd8c8`），原 worktree 与本地任务分支已清理。
- 环境：worktree 私有 node_modules / target，所有 SQLite 与浏览器验证使用隔离 fixture，未启动日常 App/Runtime。

## 验证记录

全量回归通过后，对审阅修复再运行受影响 owner、类型检查、文档 gate 与浏览器交互验收。

| 验证 | 结果 |
| --- | --- |
| TypeScript | `pnpm typecheck` 通过 |
| 全量前端与脚本 | `pnpm test` 通过；252 个 Vitest 文件、2871 项通过、2 项既有 skip；Node 357 项通过、2 项平台 skip |
| Rust 默认工作区 | `pnpm test:rust:pr` 通过；Core 429、CLI 31、Host 4、Web 11 项通过，1 项既有 ignore |
| Rust 专项 | Composer 内容投影、Pending 邀请/引用回滚与回放、live 目录/分页、owner 撤回清理通过；初始输入/Steer 冻结恢复、引用自动标题通过 |
| 构建 | `pnpm build:desktop` 通过 |
| 文档 | docs:test（随 pnpm test）、docs:check、指定基线 docs:check:ci 通过 |
| 浏览器 | 直接编译生产 ThreadWorkspace/Composer，无源码注入；隔离 Chrome profile 与固定用户目录 API。`scripts/smoke-thread-references.mjs` 的 27 项通过，零浏览器异常；生成 verification.json 与日间/夜间、对话/使命/Skills 截图 |

扩展既有 Steer owner 时发现原 Runtime 支持集合遗漏已实现的 MiniMax；补齐该 fixture 的当前预期，
不改变 Steer 的生产资格。默认全量 Rust 不包含该扩展 owner，因此单独定向运行。
对话自动标题只使用引用的可见标题，不把模型定位 URI 放进导航名称。

Rust 用例准入：优先扩展 Composer 严格校验和 Pending 首发事务既有 owner，覆盖标签伪造、
重复引用、来源删除、命令回放及邀请回滚；目录分页拥有新的游标作用域／完整模糊搜索失败边界，
使用最小内存 SQLite 表验证，不启动 Runtime。完整数据库仅用于真实发布事务及持久回执。


## 合并前审阅与复测

### Standards

发现 2 项，均已修复并复核：合法使命标题的内部换行不能导致整份草稿恢复失败或历史不可读；
搜索结束没有结果时不得吞掉普通文本的 Enter/Tab。来源真实标题保存在结构化内容，只有 Markdown
标签将空白/控制字符转为空格；本机恢复、剪贴板和 Core 读取使用一致合法集合。
该轴最高问题为草稿/历史完整性，已闭合，无遗留阻断。

### Spec

发现 2 项，均已修复并复核：普通 `@` 空结果（含 Escape 关闭后）恢复正常键盘发送；
Core 捕获标题后重新检查正式内容大小。合法 80 字 Thread 标题、650KB 正文和 2,000 个引用可以使
入站内容合法但封存后超限，扩展原 Pending 事务 owner 证明整笔回滚，且改名后仍回放原拒绝。
该轴最高问题为发布后不可读的内容，已闭合，无遗留阻断。

另补齐 Web 前端 allowlist，并通过真实 ConsoleClient + Thread adapter seam 验证 list/resolve 请求可达。
最终定向前端 4 文件 35 项通过；类型检查、目录、Pending 事务、自动标题 owner 与文档 gate 再次通过。
27 项浏览器验收包括队外成员、模糊搜索、单一加载状态、第 55 项键盘选择、定高窗口化、
刷新恢复、浏览器剪贴板事件、撤销重做、CDP 输入法组合事件、迟到响应、普通文本发送、
引用浮层焦点及发布后来源不可用。无真实模型调用、日常数据写入或 App 安装。

复现命令：

```bash
node scripts/fixtures/thread-references/build.mjs /tmp/rovai-references-ui
node scripts/smoke-thread-references.mjs /tmp/rovai-references-ui
cargo test -p rovai-core --features slow-tests --lib pending_invitations_commit_with_first_message_and_roll_back_every_failure
cargo test -p rovai-core --features slow-tests --lib active_inputs_preserve_initial_context_and_unsubmitted_sources
cargo test -p rovai-core --features slow-tests --lib generated_camp_name_removes_only_the_leading_structured_mention_block
cargo test -p rovai-core --lib thread_reference::
```

## 2026-10-23 定向修复

User sequence 20 要求修复审查中确认的问题。修复分支 `rovai/thread-reference-fixes`，
基线 `4dcee9faecde07e06575e99e6221bd78f728b398`，隔离 worktree 为
`/Users/murray.xue/.codex/worktrees/thread-reference-fixes/rovai-ai`。

- 选文：带标点标题会使整条消息 DOM 映射失败，普通标题跨段选择会夹带隐藏链接。
  前端和 Core 只将结构化引用映射为真实标题，保留普通 Text、原始 bodyAtSelection 和旧快照。
- 搜索：SQLite lower() 与 Rust/前端的 Unicode 转换不一致，完整 État、全角 ＡＰＩ 会漏检。
  Core 使用已有 SQLite 标量函数能力执行 NFKC + 默认 Unicode 小写的顺序字符匹配，前端使用同一规则。
  空查询跳过字符匹配；保留现有排序与游标，不增加表、搜索服务或 Context 版本。
- 刷新：只接收相关目录变化，Web 通过现有 SSE 传递 referencesChanged 布尔标记。
  固定刷新截止时间，最多一个读取与一个后续刷新；无关事件、连续事件和慢响应不会产生重复并发或永久推迟。

验证归属：扩展已有 `readable_projection_preserves_selected_text_without_markdown_wrappers`、
`capture_fences_source_identity_and_keeps_literal_instruction_snapshots` 与
`directory_search_pages_all_matches_and_retains_only_public_targets`，没有新增 Rust test owner。
前者复用纯投影及最小内存 SQLite；目录 owner 使用真实 SQL 对 Thread/Mission 运行同一 Unicode fixture。
生产消息组件的浏览器 golden 与 Core 共用引用标题、Unicode 标量、普通 Text 和选区用例；
已有引用菜单验收增加无关事件、持续事件、慢读取、失败、删除及 resync；已有 Host HTTP owner验证真实 SSE。

本次没有真实模型调用。旧原生会话是否会正确调用历史工具仍需单独验收，不能由投影测试代替；
大目录扫描性能仍是观测项，本次未引入索引或搜索基础设施。
