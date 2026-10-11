---
document_type: contract
contract: project-directory-registry
version: v1
status: accepted
last_updated: 2026-10-11
---

# Project Directory Registry v1

项目入口由 Core SQLite 登记决定。Thread/Camp 继续绑定规范目录路径，不增加 Project ID、外键或目录搬移。
会话数量只决定展示列表还是空状态；删除最后一个会话、切换、刷新、重启和目录暂时不可访问都不注销目录。
排序、置顶、显示名称及选中项继续属于客户端界面偏好。

## 存储与作用域

Migration 191 / projection schema 141 在现有数据库增加 `project_directory_registry`，主键为
`(scope, project_path)`，记录 `removed` 与单目录 `revision`。空路径保留作作用域头记录，表示旧数据导入
完成，头记录的 revision 是该作用域快照水位；它不是目录。结构升级不创建头记录，也不假定导入完成。

Desktop 使用现有 Host 数据库内的 `desktop` 作用域。Web 使用浏览器保存的随机稳定身份，按现有
origin/Owner 界面作用域分配，Core 命名为 `web:<64 位十六进制身份>`。身份在已有浏览器登录数据库的独立命名 key 中通过 IndexedDB 事务原子分配，支持局域网 HTTP；
跨标签页共享，身份本身留浏览器且不随登录 Session 续期改变，目录与移除记录只在 SQLite。可信 Desktop 请求不能选择 Web 作用域；
经认证的 Web 请求不能选择 Desktop。没有跨 Host、跨设备同步，也不把 Web 的会话编辑器 ID 当成浏览器身份。

## 后端接口

| 方法 | 请求 | 结果与约束 |
| --- | --- | --- |
| `projects.get` | `{ browserScopeId? }` | `{ initialized, revision, projects: [{ projectPath, removed, version }] }`，只读且不访问磁盘目录 |
| `projects.initialize` | `{ browserScopeId?, projectPaths, removedPaths }` | 同一 SQLite 事务导入并写完成标记；已完成时只返回当前登记 |
| `projects.set` | `{ browserScopeId?, commandId, command: { projectPath, removed, expectedVersion } }` | 既有命令网关回执，成功 payload 为登记快照；不存在版本为 0，版本冲突拒绝 |

显式添加/恢复在写入前沿用现有规范路径并检查目录。移除保存 tombstone，不删除磁盘目录或会话。
不接受全量快照覆盖；旧 expectedVersion 不得覆盖较新的移除。回执丢失使用相同 commandId 和原请求重试，
Web 使用既有 `commands.reconcile`；不自动刷新版本后重发恢复。Renderer 不接受较低 revision 的迟到快照。
Desktop 的 Skill 访问投影与登记在同一事务改变，移除后的清理沿用既有延迟机制；Web 移除没有 Host 全局访问副作用。
旧 JSON 移除/恢复 IPC 和旧 `skills.projectAccess.*` 写入口退出，启动参数中的旧移除清单不再改变访问状态。

## 一次性初始化与后续入口

客户端只有在 `initialized=false` 时读取旧导航偏好。成功读取的旧顺序、项目置顶、名称路径及可识别的当前
选中空目录作为候选，旧移除路径优先导入；Core 在同一事务读取完整的可见 Camp 目录元数据，保持旧活动顺序。
不扫描磁盘或消息正文，不以分页的 Renderer 列表判断导入完整。读失败或事务失败不写完成标记，合法空结果可以完成。
表已存在不代表旧偏好已导入。完成后的旧导入请求不能覆盖较新登记或移除，旧 JSON 字段仅作兼容输入，停止更新移除状态。

创建界面先保存目录登记，再提交会话；会话失败保留目录。普通 Active Camp 创建、Pending 首次激活、渠道和定时任务
成功提交时在同一事务向已初始化作用域补充新目录，只插入缺失路径。会话失败不向其他客户端登记空目录；
已有 tombstone 永不由这些入口撤销。
尚未初始化的客户端在首次导入读取既有可见会话；之后的导航刷新只读登记，不从剩余会话反复重建清单。
旧数据整库升级仍先完成既有 Camp 迁移，再进行作用域初始化。

## 展示与失败

共享界面先取得未移除登记，再挂载 [Navigation Read v1](navigation-read-v1.md) 的计数、活动和窗口。
同一结果服务侧栏、置顶校验、顺序同步、新建会话与定时任务选择器；当前选中项不补造项目。
确认会话读取成功且数量为零才显示“还没有对话”；加载或失败时保留入口并展示对应状态。
SQLite/旧偏好读取失败不能转为空默认值覆盖记录；保存失败不得显示已添加成功。目录访问失败保留登记，
由具体访问动作报错。移除当前项目后沿用既有默认入口切换；重新添加同一路径恢复一个入口并挂载仍存在的会话。

## 验证 owner

- `project_registry::tests` 拥有 SQLite 生命周期、作用域、回执重放、版本冲突、读写失败和重启合同；纯函数无法证明落盘与事务回滚。
- `db::project_registry::tests` 拥有 schema 140 升级、失败回滚与初始化标记分离；既有 Migration owner 继续覆盖旧来源收敛。
- `project-registry.test.ts` 拥有严格旧数据读取、迟到快照和丢回执；`App.test.ts` 与导航集成夹具拥有展示与交互，后者验证真实 IndexedDB 的浏览器身份稳定性。
- 旧 JSON 两阶段恢复与临时当前空项目合同随生产入口退出，等价持久化/失败保护由 SQLite owner 接替。

最小 Rust 命令：`cargo test -p rovai-core --features extended-tests --lib project_registry::`。
UI 和桥接仍执行既有导航、启动展示、Desktop Bridge、类型检查与 Vitest 门禁。执行结果见当前版本实施记录。
