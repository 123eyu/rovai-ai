---
document_type: research-note
authority: runtime-probe-evidence
status: in_progress
last_updated: 2026-10-15
---

# Steer 入队回执与阻塞工具实测

本轮由 User seq90–95 触发。以 main `6dcb86f48` 加本次局部修复为代码基线，macOS arm64；
只测试 Rovai 已接入的通道，使用生产 Core、共同 Builder／Formatter、真实 LLM 和每个场景独立的
data／Skill Library／MCP／native 配置副本。日常数据库和原生会话只读，不取消或重发 User 的真实任务。
版本发现／展示与 Pi、Qwen 的启动摘要回归已交独立会话，不由本报告宣称修复。

## User 场景的原因

- ZCode 首次失败：原生 `ProviderBusinessError` 明确报告服务器过载。该 Run 的插话已有消费证据；
  不是插话门禁导致失败。产品只把确认的过载原因映射成固定安全文案，不暴露任意 Provider 错误或重试。
- ZCode 后续等待：`停止等待` 已在原生 `session_input` 入队，但 Rovai 还等 `steerDrained`。
  当时工具是 `sleep 60`，实际从 14:59:33.266Z 运行到 15:00:33.411Z；接收与消费被混作一个门槛。
- TRAE：`_session/steering` 在 14:51:42.823Z 已返回 injected，同一个 Run 随后完成一分钟工具和回复。
  这证明接收发生在本次执行中，也证明该样本没有即时中断等待；不能把“插话”解释成“停止工具”。
- Pi／Kiro 修复前真实复测：15 秒受控工具等待内只形成第一条 prepared 输入，第二条留在 Core；
  工具释放后才依次确认。二者均存在额外消费门禁。
- Kiro 初次调整后暴露第二个边界：两条输入间隔约 100 ms，原生第二条 queued 通知把 A、B 正文合并，
  每次 RPC 却分别返回 queued=true。逐通知正文匹配把第二条误记未知；最终文件实际已执行 B。
  最终采用逐 RPC 回执，不实现正文拼接解析或额外服务。

## 真实测试清单

每个普通场景发送原任务，等真实工具进入受控等待，再连续发送更正 A、B。观察最多 15 秒，再由测试端
释放工具。通过要求是：原 Run 成功、只有一个 Run、三条输入关联正确、最终文件为 B 且 BOTH 标记存在。
“等待期间两条已接收”和“最终要求完成”分别记账；不是每个 Runtime 都会立即发送回执。

| Runtime／本机版本 | 实际观测模型 | 工具释放前回执 | 最终结果 |
| --- | --- | --- | --- |
| Codex 0.162.1 | gpt-6.1-sol | A、B 均已接收 | 单 Run 连续更正通过 |
| Claude Code 2.1.287 | sub2api / gpt-6.1-sol | A 等待原生回显，B 尚未投递 | 工具结束后精确回显，两条均在原 Run 完成 |
| Pi 1.1.0 | sub2api / gpt-6.1-sol | 修复前 A 等消费；修复后 A、B 均已接收 | 修复后通过 |
| CodeBuddy 2.133.1 | gpt-6.1-sol | A、B 均已接收 | 本次样本通过；不关闭既有 #762 |
| Qwen Code 0.25.0 | gpt-6.1-sol (openai-responses) | A 等原生拉取，B 尚未投递 | 工具结束后两条均在原 Run 完成 |
| Grok Build 1.0.50 | gpt-6.1-sol | A、B 均已接收 | 单 Run 连续更正通过 |
| Kiro CLI 2.21.1 | auto（未透露底层模型） | 修复前等消费；逐正文方案仍会误记 B 未确认 | 最终逐 RPC 方案复测中 |
| ZCode App 3.14.5／内核 0.16.9 | new-provider / gpt-6.1-sol | 修复后 A、B 均已接收 | 单 Run 连续更正通过 |
| TRAE CLI CN 0.209.1 | glm-5.3/high | A、B 均已接收 | 单 Run 连续更正通过，工具继续等待至测试端释放 |

Claude 与 Qwen 的等待来自当前原生回显／拉取时机；本轮未发现额外“收到后再等消费”的接线。
不能把 stdin 写入或 Core 内排队伪装成原生已接收。TRAE 没有自动取消工具，本次保留该原生行为。
所有结果只覆盖本机版本与本次场景，不外推其他版本、所有模型遵从或所有附件场景。

## 停止、失败及证据保留

Pi、Kiro、ZCode 分别追加“已入队但工具未结束 → 停止 → 普通新任务”：均已通过；新任务不含任何
忽略旧指令的提示，原禁止文件未出现。原 Run 取消与普通后继成功独立核对，不把全部结束视作通过。
最终 Kiro 回执调整后的停止复测仍需补验。

Kiro 尝试记录完整保留：第一次修复后模型自行 touch release，未形成预定工具边界，属无效场景；
明确 fixture 约束后的第二次及透明协议记录复测，均复现第二条回执未知但 B 结果已完成，不被成功样本覆盖。
协议记录证明第二条通知正文长度为两条输入之和加分隔符，且两条 RPC 各有 queued=true。

私有证据目录使用 `/tmp/rovai-steer-92-*`、`/tmp/rovai-steer-95-*`，不作为公开附件；
只导出版本、模型、输入状态、文件结果和必要的脱敏错误。本轮原始失败与后续通过分开记录。
ZCode 修复批次 Core SHA-256 为 `3f55ae803b918fcf9b1cee003f91843da85d10768baf6434ae8e40399918729e`；
Pi 及初次 Kiro 调整批次为 `68450834c72ecb66a718266ec0909663f5641f59281154ba44581ed14cb84ee4`。
本次只调整内存回执与队列清理；没有迁移、额外正文、持久回执状态或产品提示词变化。
