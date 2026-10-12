---
document_type: contract
contract: project-directory-registry
version: v1
status: accepted
last_updated: 2026-10-12
---

# Project Directory Registry v1

项目入口的持久状态由 Core SQLite 登记决定。登记功能故障时允许当前窗口临时展示旧会话分组与新选目录，不据此改变持久状态或访问权限。Thread/Camp 继续绑定规范目录路径，不增加 Project ID、外键或目录搬移。
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
| `projects.set` | `{ browserScopeId?, commandId, command: { projectPath, removed, expectedVersion } }` | 既有命令网关回执，成功 payload 为登记快照；不存在版本为 0；目标已满足时无操作成功，真正的版本冲突拒绝 |

显式添加/恢复在写入前沿用现有规范路径并检查目录。移除保存 tombstone，不删除磁盘目录或会话。
不接受全量快照覆盖；旧 expectedVersion 不得覆盖较新的移除。回执丢失使用相同 commandId 和原请求重试，
Web 使用既有 `commands.reconcile`；不自动刷新版本后重发恢复。Renderer 不接受较低 revision 的迟到快照。冲突后重新读取若目标已满足，可以无操作完成；最新状态为已移除时旧添加仍失败。
Desktop 的 Skill 访问投影与登记在同一事务改变，移除后的清理沿用既有延迟机制；Web 移除没有 Host 全局访问副作用。
旧 JSON 移除/恢复 IPC 和旧 `skills.projectAccess.*` 写入口退出，启动参数中的旧移除清单不再改变访问状态。

## 一次性初始化与后续入口

客户端在启动恢复会话之前同步保留可识别的旧选中目录，不等待 Core 或阻塞会话恢复；只有在
`initialized=false` 时读取旧导航偏好并使用这份保留值。成功读取的旧顺序、项目置顶和名称路径作为候选，
旧移除路径优先导入；Core 在同一事务读取完整的可见 Camp 目录元数据，保持旧活动顺序。
不扫描磁盘或消息正文，不以分页的 Renderer 列表判断导入完整。读失败或事务失败不写完成标记，合法空结果可以完成。
表已存在不代表旧偏好已导入。完成后的旧导入请求不能覆盖较新登记或移除，旧 JSON 字段仅作兼容输入，停止更新移除状态。

初始化输入通过 `navigationPreferences.getProjectInitialization()` 读取目录身份和移除决定。
可选显示名称、排序、置顶时间、移除时间和选中项损坏不阻断已知目录导入；有效名称键仍可识别目录，
有效移除路径不因时间字段异常而丢弃。无法读取原文、不支持的结构版本或不可识别的移除路径返回 `complete: false`，并保留能可靠识别的身份用于临时显示；不能因此完成初始化。完整、成功的结果省略此字段。
每次重试重新读取磁盘或浏览器存储，不缓存读取错误。界面读取使用安全归一化值；损坏原文不自动回写，
自动顺序同步跳过保存且不阻断目录使用，显式偏好写入仍保留失败保护。SQLite 添加、移除和恢复不依赖偏好写入成功。

正常创建路径优先登记新目录；已有正常登记不重复调用 `projects.set`。会话失败保留已经保存的目录。
普通 Active Camp 创建、Pending 首次激活、渠道和定时任务在业务事务内尝试向已初始化作用域补充新目录，
只插入缺失路径，已有 tombstone 永不由这些入口撤销。

自动登记用局部 savepoint 隔离所有作用域写入。仅登记语句产生的 SQLite constraint 错误、外层事务仍活跃、
且 `ROLLBACK TO` / `RELEASE` 成功时允许继续原业务。`RAISE(ROLLBACK)`、I/O、磁盘满、busy、权限、schema
和其他未分类错误继续失败；业务行、事件和回执仍由命令网关真实提交后才成功。显式登记写入的局部约束错误
映射为 `project_registry_unavailable`；路径检查、访问投影或业务/提交错误不转换成此错误码。

尚未初始化的客户端在首次成功导入读取既有可见会话。运行中发现的未登记会话目录、或登记失败时新选目录，
仅保存在窗口内存用于兼容；登记恢复后用 `expectedVersion=0` 补缺。已有登记（包括移除记录）优先，不重放旧恢复意图，
不重建全量目录清单，不重复创建会话或发送消息。数据库仍先完成既有 schema 升级，不降版本或绕过准入。

## 展示与失败

共享界面用未移除登记挂载 [Navigation Read v1](navigation-read-v1.md) 的计数、活动和窗口。
同一结果服务侧栏、置顶校验、顺序同步、新建会话与定时任务选择器；当前选中项不承担补造目录的职责。
确认会话读取成功且数量为零才显示“还没有对话”；加载或失败时保留入口并展示对应状态。
SQLite/旧偏好读取失败不以空默认值覆盖记录；目录访问失败保留登记，由原业务动作报错。
移除当前项目沿用既有默认入口切换；明确重新添加同一路径恢复一个入口并挂载仍存在的会话。

有可靠快照时，成功读取的会话窗口立即应用，登记在后台独立刷新。首次无快照时，展示层最多等待 500ms，
然后退回 Core 允许读取的旧会话分组；可靠移除记录继续过滤。不能读全移除状态时提示显示状态未完整恢复，
不把临时展示变成恢复登记，更不重新授予目录或 Skill 权限。登记故障不禁用添加和会话入口。
旧偏好完整读取与初始化失败独立处理；重试真实重读，不缓存错误。

新目录在可隔离登记故障或登记超时下允许临时使用，且继续执行原会话权限、路径与保存检查。主数据库异常、
权限拒绝和路径验证失败不伪造成功；保留原内容和未提交输入。已知移除目录必须明确恢复成功后使用。
降级期间只显示一条可关闭的非阻断提示：“项目列表暂未保存，仍可继续使用；新添加的空目录可能无法在重启后保留。”
每次自动刷新不重复弹窗；降级时不因不完整投影持久清理置顶或项目顺序，不增加管理界面或第二目录库。

## 验证 owner

- `project_registry::tests` 拥有 SQLite 生命周期、作用域、回执重放、版本冲突、读写失败和重启合同；新增扩展 owner `optional_registration_cannot_block_business_or_mask_a_lost_transaction` 独立验证会话创建/首次发送中的局部 ABORT、外层 ROLLBACK、提交失败、草稿保留、回执不重复和跨作用域回滚。修复前登记 ABORT 会阻止业务；原初始化/生命周期 owner 不覆盖此业务事务边界，纯 mock 无法证明事务仍然有效。
- `db::project_registry::tests` 拥有 schema 140 升级、失败回滚与初始化标记分离；既有 Migration owner 继续覆盖旧来源收敛。
- `project-registry.test.ts` 拥有启动前选中项保留、失败重试、迟到快照和丢回执；Main/Web 偏好 owner 覆盖可选损坏隔离、原文保护和真实重读。
- `App.test.ts` 与导航集成夹具拥有展示与交互，后者验证真实 IndexedDB 的浏览器身份稳定性。启动夹具用延迟初始化证明恢复不阻塞且旧值保留，并覆盖首次/缓存登记失败、慢请求、目录选择、原创建请求继续、选中状态和移除过滤。
- `scripts/accept-project-registry.mjs` 使用独立 userData/Skill Library，拥有旧打包 App 数据升级、正常退出/重启、目录生命周期以及真实 SQLite 登记约束故障与恢复验收；不使用日常数据或真实 Runtime。
- 旧 JSON 两阶段恢复与临时当前空项目合同随生产入口退出，等价持久化/失败保护由 SQLite owner 接替。

最小 Rust 命令：`cargo test -p rovai-core --features extended-tests --lib project_registry::`。
UI 和桥接仍执行既有导航、启动展示、Desktop Bridge、类型检查与 Vitest 门禁。执行结果见当前版本实施记录。
