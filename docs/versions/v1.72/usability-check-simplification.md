---
document_type: implementation-record
version: v1.72
status: in_progress
last_updated: 2026-10-31
---

# 局部可用性检查精简

## 范围与工作区

User sequence 53 授权实施 sequence 45 的四项及后续确认的局部边界。基线为
`be7cac82fd878219102c053cafd8d87f22e12024`，分支 `rovai/usability-check-simplification`，
worktree `/Users/murray.xue/VSCodeProjects/opensource/rovai-ai-usability-check-simplification`。
Governance: none；Status: active。四项独立提交；第四项单独验证。只推送工作分支，不创建 PR、合并或安装。
不增加 schema、恢复服务、持久协调状态或用户审批。

## 原路径附件显示名

删除 Source Ref、Main 登记加载、Composer 恢复 IPC 和 Desktop 目标解析中的 120 码点拒绝。
其余校验保持，名称与 sourcePath 不改写；真正创建文件的叶名称规则保持。
原登记仍存在时可按原 ID 恢复；旧版若已过滤并覆盖丢失登记，本项不重建该记录。

扩展既有 `local-composer-attachments`、`attachment-desktop`、Source Ref JSON 和 Single Chat owner，
无新增独立 Rust 测试函数。实际 125 字节 ASCII 文件名用于 prepare、同实例 restore、新实例 restore、
预览字节及打开／定位目标传递；Unicode 121 码点只验证显示元数据，不假设文件系统允许该叶名称。
原有错误归属、无效 ID、相对路径、源失效及类型检查保留。

修复前，Desktop 两项回归失败（新实例恢复 missing、目标解析拒绝）；Rust 单聊和 JSON owner
均因 `Source Attachment display name exceeds 120 characters` 失败。修复后 Desktop 两文件 20 项通过、2 项原有 Windows-only 跳过；
`local_attachment_source::` 5 项和 Single Chat owner 1 项通过；typecheck、fmt 与文档检查通过。
恢复 IPC 和真实 Desktop 验收待最终构建统一执行，不能用目标解析测试替代。

## ACP resume 的收尾等待

最终成功的 RPC 方法从原恢复循环传入现有收尾入口；只有 load 计算 grace/quiet 等待。
resume 复用同一处 owner、epoch、LoadingReplay 校验和 Ready 转换；错误状态不重新 bind。
`-32601` 降级后按实际 load 处理，同 Host 复用不改变。

扩展现有历史隔离及协议异常 owner。先仅传递方法、不改变旧等待行为，确定性首轮 poll 断言
失败为 `session/resume: Pending`；取消计时后该断言立即完成，load 首轮仍 pending。
同一用例覆盖 owner/epoch 错误、ProtocolViolated、错误 phase 和 route 缺失；原 RPC 夹具
追加 resume 降级 load，并继续验证 response 后迟到的 assistant/tool/usage 不进入当前 Run 或 ACK。
协议异常 owner 同时覆盖 resume/load 返回错误 Session ID 或非法协议。历史恢复 3 个 owner 通过。
原生模型设置 owner 与同 Host 复用 owner 各 1 项通过；文档检查通过。
真实 Runtime 的跨 Core 续聊待隔离验收，不能以计时断言替代。
