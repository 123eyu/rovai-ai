---
document_type: protocol-contract
contract: camp-message-send
version: 27
status: accepted
authority: user-message-runtime-delivery-selection
source_version: v1.72
last_updated: 2026-10-14
---

# Camp Message Send v27

继承 [v26](camp-message-send-v26.md) 的正文、附件、引用、幂等、成员与发布规则。
`thread.messages.send` 的 User inline 请求新增可选 `deliveryMode: "start" | "steer"`，缺省 start。
可选 `steerTargets: [{agentRunId, executionEpoch}]` 限定发起操作时可插话的执行；空数组表示没有目标。
Desktop/Web 根据提交时的同一发送预览传入目标，失效目标走普通队列，不改投后继 Run。
API 未给 targets 时由 Core 在发布事务捕获当前符合条件的目标。后续投递仍严格绑定该 Run／epoch。

一次请求发布一条普通用户消息，每位接收者独立按 [Delivery v13](message-delivery-v13.md) 路由。
多提及、广播、引用、Skill、文字附件和纯附件保持普通输入能力；不拆出纯文本，附件错误归本条投递。
Agent 工具不暴露 Steer 参数，普通 API、Automation、私聊、渠道与既有 waiting 消息的语义保持。

CampOpen 的 AgentRun 可选 `canSteer` 表示当前支持且已有初始接受证据，前端不从模型名猜能力。
MessageDelivery 增加可选 requestedMode 与 inputDeliveryStatus，正文和消息身份保持。
普通结束后的 fallback 安静更新回执；未知状态仅核对，不把重新发送藏在核对操作中。
