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

Renderer 关闭时立即去除 Task 浮层与排队项目，并过滤在途响应中的 Task。Core 在 false→true 的设置事务中将当前通知序号保存为 `headsUpAfterSequence`，与 enabled 一起由设置 get/set 返回。读取、同值保存与重启不移动此边界；再次关闭后开启才建立新边界。

Renderer 直接比较 Task changeSequence 与该固定边界，不另读 Inbox 获取 Task 水位，不等待辅助 Promise，也不用 Infinity 消费未知变化。普通提醒继续按全局游标处理；Task 切换不推进或重置全局游标。旧 Task 不补弹，开启后产生的 Task 不因 Inbox 慢、失败或迟到而被划为旧通知。原启动/reset 的全局基线规则不变。
用户原有显式审计仍保留。旧通知 Task 动作退到会话本身，不阻止普通导航。
