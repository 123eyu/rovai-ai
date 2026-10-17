---
document_type: protocol-contract
contract: notification-episode-v10
status: accepted
version: 10
source_version: v1.72
last_updated: 2026-10-17
---

# Notification Episode v10

继承 [notification-episode-v9](notification-episode-v9.md) 未被下述条款替代的规则。

Episode wire schema 9 保持；Task 能力关闭时 Task 来源、inbox、未读计数、changesSince、单项和 heads-up 均不可见。列表过滤发生在分页 LIMIT 前，游标按原变化水位推进，不删除存量 episode。Task 偏好保留，开关不回写这些偏好。

Renderer 关闭时立即去除 Task 浮层与排队项目，丢弃过期变化请求。重新开启建立新的变化基线，不补弹旧 Task 通知；用户原有显式审计仍保留。旧通知 Task 动作退到会话本身，不阻止普通导航。
