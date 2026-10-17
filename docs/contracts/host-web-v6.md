---
document_type: protocol-contract
contract: host-web-v6
status: accepted
version: 6
source_version: v1.72
last_updated: 2026-10-17
---

# Host Web v6

继承 [host-web-v5](host-web-v5.md) 未被下述条款替代的规则。

Host Web protocolVersion **5**，与新 Task 可选读取投影共同配套发布；协议不匹配仍使用既有明确错误，不猜测旧响应字段。

受认证 User allowlist 增加 preferences.tasks.get/set。SSE invalidate 增加可选 tasksChanged:true，resync/重新连接使客户端能力先回到未知 false，再读取当前 Core 设置。不会暴露内部凭据或向 Agent 增加设置权限。
