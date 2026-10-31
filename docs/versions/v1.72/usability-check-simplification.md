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
