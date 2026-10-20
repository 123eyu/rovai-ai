---
document_type: interface-contract
contract: input-history
version: 1
status: accepted
authority: user-composer-input-history
last_updated: 2026-10-21
---

# Input History v1

公共 Thread 和私有 Single Chat 共用输入历史缓存与导航。历史用于 User 主动回填编辑器，
不进入模型上下文，不创建附件、回复关系或执行参数，也不拥有命令重试。

## 只读接口

| 接口 | 参数 |
| --- | --- |
| `thread.messages.inputHistory` | `threadId`, `cursor?: string \| null` |
| `singleChat.inputHistory` | `threadId`, `conversationId`, `cursor?: string \| null` |

两者返回 `{ items, nextCursor, hasMore }`。每个 item 为
`{ historyId: string, content: ComposerDocument, cursor: string }`，按新到旧排列。
`content` 为现有 version 2 Text/Atom 文档。Core 生成绑定会话的 opaque cursor，客户端只保存/回传。
刚收到成功提交回执、尚无数据库位置的本地条目可暂存 `cursor: null`。

每页在筛选、归并后查询 **21 条**用户输入，返回前 **20 条**，第 21 条只判断 hasMore。
nextCursor 使用实际返回的末条位置，读取为 exclusive keyset；每条 item 的 cursor 均能独立续读。
有末条时即返回其 cursor，包括 hasMore 为 false 的页面。

读取只允许当前 Host/Owner 范围中的当前 User 输入，不接收客户端声明的 User ID：

- 公共历史读取当前 Thread 的当前 User 消息，按 `sequence DESC` 分页；
- 单聊验证 Thread/Conversation/kind，归并正式 User 消息和 `single_chat_pending_input`；
- 普通正式消息使用自身 ID/创建时间。Pending 始终使用 pending ID/原提交时间；
  published pending 从关联正式消息读取当前正文，不能退回旧 pending 正文；
- 已关联 pending 的正式消息不重复返回。按原提交时间、稳定历史 ID 降序分页；
- 有正文的 queued、needs_repair、cancelled pending 均纳入；
- 纯附件、已清空正文记录跳过。空白判断与客户端 trim 一致；回填保存实际提交的缩进/换行，
  不改变现有单聊发送的 trim 规则；
- 保留 User 文本、Member/All Members/Skill Atom；Core-owned 外部引用段和回复关系不复制。
  无结构化段时回填保存的正文，不推断气泡上派生的默认接收者。

只读取现有表中的回填字段，不加载聊天窗口、Agent 输出或附件正文，不增加历史表。

## 缓存与提交

缓存归属于稳定的 `ThreadClient`（Host/Owner/editor），仅保存在内存：

- 公共键 `thread:{threadId}`，单聊键 `single:{conversationId}`；同 Agent 的不同 Conversation 分开；
- 合计 **8 个 LRU** 会话。进入、聚焦、编辑、浏览或成功提交只更新所属会话的使用顺序；
  重渲染和读取单聊所属 Thread 不更新其他会话；
- 每会话一份新到旧数组，另存首屏初始化、下一 cursor、hasMore 和一个 in-flight Promise；
- 草稿就绪后未初始化则预加载，已初始化直接复用。首个 Up 和预加载共用请求；
  本地提交条目不代表首屏已加载。到缓存尾部才取旧页，重复按键不叠加翻页；
- 首屏合并已有本地条目，旧页按身份归并追加。读取失败保留输入/缓存，后续 Up 可重试；
- 会话输入框保持可用期间不裁剪，离开后只保留最新 **100 条**，不为凑数量补读；
- 裁剪后下一 cursor 取保留末条，hasMore 置 true；末条无 cursor 时重置首屏初始化；
- 裁剪期间已发出的旧页不能覆盖保留末条的续读位置或将被裁范围判为读尽；
- 淘汰不删除草稿，迟到请求不能复活已淘汰缓存。结果先更新所属缓存，仅有效浏览操作可回填；
  编辑、Esc、离开使旧回填失效。失焦取消等待中的移动，不夺回焦点、不丢弃已显示的预览。

现有发送调用成功返回业务回执中的消息/pending ID 后，立即以冻结的实际内容和会话目标加入头部，
在草稿清理、消息刷新前完成，不等 Agent 执行。重放响应及数据库读取按真实 ID 合并；
相同正文的两次成功提交保留两条。没有历史临时 ID、身份转换或专用恢复状态机。

明确接受陈旧：不监听撤回或跨客户端新增，不失效缓存、不逐条复核旧记录。未恢复的成功回执、
其他客户端新增可能直到覆盖最新记录的查询或缓存重建才出现；旧页和暖缓存重入不保证补齐。
已缓存撤回正文仍可能回填，主动发送是新提交；重建后无正文记录不会重新进入。

## 草稿、预览与键盘

草稿继续由现有存储负责，不占历史容量。进入浏览时保留原编辑状态/selection；公共输入保存结构化文档。
导航仅保存选中 ID、原草稿快照和操作代次，不复制历史数组；头部插入不改变选中内容。

| 操作 | 行为 |
| --- | --- |
| 无选区/修饰键、文档绝对起点的 `↑` | 更早一条，回填后光标置于起点 |
| 浏览中、无选区/修饰键、文档绝对终点的 `↓` | 较新一条，回填后光标置于终点 |
| `↓` 越过最新条目 | 恢复原草稿及 selection，退出 |
| 无选区/修饰键的 `Esc` | 恢复原草稿并消费事件，单聊不同时关闭 |
| 编辑正文或显式修改输入路由/引用 | 接管为普通草稿，退出浏览 |
| 发送预览 | 先接管到现有协调器，再 flush/发送捕获的内容 |
| 离开会话 | 结束浏览，保留原会话草稿 |

候选/链接菜单及 IME 优先。有选区、修饰键或不在边界时保留原编辑行为；不测量视觉行。
只有实际接管导航或等待必要读取时消费按键。非浏览中的 Down 不接管。

预览驱动显示、发送/停止按钮、接收者提示和可发送性。自动保存、重试、普通 leave flush 仍处理原草稿；
Public 保存器分别持有原状态与瞬时显示状态，Single Chat 的受控 value 使用预览或原 body draft。
用户编辑/发送才接管，附件、quotes、reply 等字段继续由现有流程管理；不建立第二份持久草稿。
浏览、移动光标、Atom 展示刷新与退出不把预览条目写入 Undo；退出后继续使用原稿的撤销/重做记录。
