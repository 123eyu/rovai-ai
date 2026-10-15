---
document_type: protocol-contract
contract: message-delivery
version: 18
status: accepted
authority: public-message-delivery-route-reconciliation
source_version: v1.72
last_updated: 2026-10-15
---

# Message Delivery v18

继承 [v17](message-delivery-v17.md)。以下替代 Pi、Kiro、ZCode 必须等待消费才能确认接收的要求；
版本门槛、既有通道、Run／epoch／Host 归属、停止和未知不重发规则保持。

## 接收不等待消费

`accepted` 统一表示“运行时已接收”。以下原生证据足以结算本条回执并允许顺序提交下一条：

| Runtime | 接收证据 | 不再作为接收前提的事件 |
| --- | --- | --- |
| Pi | 当前 Host 上精确 RPC ID 的成功 `steer` 响应，`disposition: queued` | user `message_start` |
| Kiro | 当前 Prompt／owner 下精确 RPC ID 的成功 `_session/steer` 响应，`queued: true` | 合并正文的 queued 通知及 `AgentExecutionSteeringInjected` |
| ZCode | 当前 Turn 下 inputId、正文、targetTurnId、pendingInputId 匹配的 `turn.steerQueued` | `turn.steerDrained` |

Kiro 连续插话时 queued 通知可能合并正文，不按通知正文重建逐条回执。
ACP 回执归属按 reader 实际观察顺序判断：有效 ACK 后原 Prompt 结束，不因等待方稍后恢复而改为未知；
原 Prompt 已结束后才收到的无归属接收响应，仍保留未知。原生明确拒绝沿用既有未接受处理。
仅写入成功、ZCode 不含目标 Turn 的通用 sendText 响应或模型文字“收到”不能替代上述证据。其他 Runtime 保持既有回执方式；
Qwen 仍需等原生 `craft/drainMidTurnQueue` 拉取才实际投递，未拉取不伪装为原生已接收。

工具执行、消费及业务结果与回执分开。插话不承诺中止正在运行的阻塞工具；收到“停止等待”这样的
消息也不自动变成取消 Run／重启任务。真正停止继续走原有停止动作。

## 停止与结束

Pi 仍关闭准入、协调已准入写入，再由停止路径先 `clear_queue` 后 `abort`，不等待消费或 Steer ACK。
晚到的精确入队 ACK 只说明此前接收，不代表停止失效或允许重发。
ZCode 已确认的 guide 继续在内存中跟踪是否 drained；原执行结束时仍有未消费 guide，先停止原生队列，
再完成原 Prompt。已接收不等于已消费，不因回执已结算而跳过清理。
使用过插话的 Pi／Kiro／ZCode Host 继续回收，不把残留队列交给另一项 Rovai Run。

不新增状态、数据库字段、正文副本、核对服务或提示词；普通消息与 Steer 仍共用 Builder、Formatter、
RUN_INPUT。原生过载错误只映射固定安全文案，不输出任意 Provider 错误或隐式重试。
