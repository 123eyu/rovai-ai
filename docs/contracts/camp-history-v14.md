---
document_type: protocol-contract
contract: camp-history-v14
authority: public-camp-history-read-scope
status: accepted
version: 14
source_version: v1.72
last_updated: 2026-10-14
---

# Camp History v14

继承 [v13](camp-history-v13.md) 的认证、消息正文、显式读取、历史搜索、附件、引用、撤回和分页边界。
仅取消新 Run 的冻结目录，不改变工具参数或输出字段。

## 目录与正文分别确定

新建 ContextManifest 固定 live_history_directory=1；既有行默认为 0，按原目录模式读取与收尾。
新 Run 不捕获其他会话的名称／活动时间，不写 context_manifest_history_camp，也不创建目录 JSON、Blob、
共享／增量快照或持久缓存。SQL trigger 阻止新模式写入目录副本；读取不迁移历史。

新模式的 thread.list 查询当前仍存续、未进入删除的公开 Thread（仍排除调用者当前 Thread），使用当前名称。
目录按最新可见公开消息的发送时间倒序；最新消息撤回或 tombstone 后回退到上一条可见消息；没有消息时
使用 Thread 创建时间；相同时间按稳定 Thread ID 升序。名称 query 仅过滤，不覆盖活动时间顺序。
updated_at 不是消息活动时间，不参与排序。

可见性沿用 v10+ 显式公开历史搜索：消息必须已公开发布，排除 tombstone 和 withdrawn；recallable 或
调用者仍有 waiting Delivery 的已发布消息仍公开可见，读取不领取 Delivery 或关闭撤回。这不改变
RUN_INPUT 和 quote-source 的既有 suppression，也不增加跨 Thread 私有 Conversation 可见性。

global_public_message_boundary 继续冻结为单个标量。跨 Thread thread.search 和 history.search 仍受该正文
边界限制；thread.read 的既有显式当前公开边界保持。实时目录看到改名或新活动，不代表历史搜索能读到
冻结边界之后的消息。旧目录的名称与排序保持原读取行为，既有目录行不删除或回填。

## 存储兼容

migration 201 / schema 151 增加一个固定目录模式标记与新写入约束。没有扩大旧 history_fence_version 的
CHECK，因为那会重建存有历史 Context 内容的表；新字段用默认 0 原位添加，不扫描／改写正文。
不识别 schema 151 的旧 Core 通过既有 authority admission 拒绝写入。新 Run 不依赖活动记录统一的实现。
