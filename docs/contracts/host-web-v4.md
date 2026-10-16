---
document_type: protocol-contract
contract: host-web-v4
authority: shared-host-web-transport
status: accepted
version: 4
source_version: v1.67
last_updated: 2026-10-16
---

# Host Web v4

继承 [v3](host-web-v3.md) 的认证、编辑器归属、allowlist、回执、超时和共享页面边界。
Task create/read/update 采用 [Durable Task v5](durable-task-v5.md)：Task read model 没有
`version`，update 输入没有 `expectedVersion`，旧字段由闭合输入拒绝。字段补丁由 Core 在事务中
应用，Web 不代填版本。其他对象的版本规则不变。

登录、票据兑换、Session identity 与 capabilities 的 `protocolVersion` 轮换为 4；新客户端与
Host 拒绝旧版本 Session。旧 Task payload 不进行 reconcile 兼容解码或自动重播。命令 ID 幂等、
`recorded`/`unknown`、用户草稿与恢复行为保持 v3 的非 Task 语义。

## Public Composer 上传恢复

Public Composer 内容按 [Camp Composer Draft v16](camp-composer-draft-v16.md) 保存在客户端。
上传成功回执中的 `source` 是源文件引用；Web adapter 将其投影为含 `availability`、`byteSize`、
`fileCount` 与 `previewKind` 的共享附件视图，不能直接将源引用当成附件视图。

刷新后的恢复通过认证的 `files` 资源动作 `restoreComposerAttachments` 提交
`{threadId, attachmentRefIds}`，单次最多 10 个 ID。Core 按当前已验证 editor、Thread、上传命令 ID
及成功绑定回执取回来源，并检查当前文件类型与可读性，按输入顺序返回附件视图或 `null`。
只有可用来源返回 `sourcePath`；缺失绑定显示为不可用，不接受浏览器保存的路径替代授权。
发送前预览与位置查询使用同一回执归属，不再读取退役的 Public Core Draft。
Thread 进入删除状态后归属即失效；Single Chat 的私有 Draft/Pending 规则保持不变。

## Windows Web 凭据可用性

仅 Windows `web-auth.json` 的创建、读取与保存采用以下局部规则，覆盖本机 Token、开启 Web、
登录/票据兑换、续期、注销、关闭、显式重置与重启。存储格式、位置、认证与会话有效期不变。

- 信任基础是已选定且通过正常准入的 Core 数据目录。可读且有效的普通凭据文件接受正常继承、
  缺少 `SE_DACL_PROTECTED`、额外管理员 ACE 与非模板权限掩码；读取不修改 ACL、内容、Token 或会话，
  不请求文件写入、`WRITE_DAC` 或目录写入权限。目录原有准入、路径/身份、普通文件、重解析点与 64 KiB 内容限制保留。
  Core/Server 仍拥有数据目录的正常准入；凭据 I/O 在此之后重验目录路径、卷及稳定身份，
  不再次把目录的精确可写 DACL 模板施加到只读 Token 查询。
- 保存只用同目录新建 sibling、写入、flush 和既有 Windows 原子替换。新建空 sibling 继承目录权限，
  在写入秘密前尽力施加受限 DACL；只有构造/应用额外 DACL 的失败可忽略。路径、身份、创建、写入、
  flush、替换失败均不能当作加固失败。原子替换是提交点，成功后没有能推翻成功的额外加固步骤。
- 所有持久变更仍在 registry 锁内先保存再发布内存状态。失败保留此前已提交凭据与会话；读取失败
  不能当成文件不存在，只有确实不存在才初始化。升级、重启和权限兼容不触发轮换。
- Host 区分 `HOST_WEB_AUTH_READ_FAILED`、`HOST_WEB_AUTH_SAVE_FAILED`、
  `HOST_WEB_AUTH_INVALID_CONTENT` 与 `HOST_WEB_AUTH_INVALID_PATH`；操作系统拒绝与其他 I/O 原因采用
  有界脱敏文案。HTTP 保存失败保留 503 / `session_storage_unavailable`，附安全 `message`。
  Desktop 用现有可克隆失败 envelope 穿过 IPC，现有错误入口不展示 Electron 前缀或内部错误链。
- 正常继承与加固不可用不产生用户警告，不要求管理员启动、修权、重装或重新登录。
  通用私有存储、其他文件/对象与其他平台的读写策略不变；局部例外由
  [Windows Private Storage v2](windows-private-storage-v2.md#windows-web-credential-exception)组合。
