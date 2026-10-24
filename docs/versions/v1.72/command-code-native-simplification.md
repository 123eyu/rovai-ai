---
document_type: implementation-report
source_version: v1.72
last_updated: 2026-10-24
---

# Command Code 1.88 原生接入简化

当前实现以[启动合同 v72](../../contracts/runtime-launch-and-verification-v72.md)为准。
只保留原生 HOME、官方 Mod、标准 ACP 与共享 Fleet。公开状态仍为所有平台 NotQualified。

## 实际减少

删除 Command 原生 auth/provider/settings/Mod/项目 MCP 的遍历与摘要、HOME 与 `.commandcode` 镜像/链接、
原生 projects/sessions 补偿目录、私有 settings/mcp 合并、nonce 文件、重复 readiness 读取与每轮 `mcp list`。
新 Adapter 投影的两个兼容性摘要为 null，Command 退出 Native Session key 摘要和 ACP runtime digest 生成。
Fleet 的显式 Native Binding 策略与其配置摘要策略互斥；不以字段缺失默认为可复用。旧数据保持可读。

启动准备在进程创建前清理目录；实际 child 从底层启动失败也能交回清理 owner。Host 构造期间 owner 同时
持有进程/材料，确认停止与 reap 后清理，不能确认则保留诊断。Host 成功接管后继续已有 shutdown；没有改写
pending/stdin/取消/退出的锁顺序。

## 与其他 Runtime 对照

| 边界 | Command 本轮结果 | 已有 Runtime 的职责 |
| --- | --- | --- |
| 原生 HOME | 用户 HOME；不镜像或代管历史 | 与 Codex 原生 Home 原则一致 |
| MCP | 新建/恢复的 ACP mcpServers，原生处理同名 | 与共享 ACP 直接投递路径一致；Cline 的原生配置路径独立保留 |
| Bootstrap | 每 Host 小 Mod + 每 Session 不可变 binding | 与 Cline/MiniMax 启动文件不同，Command 必须按实际 Session ID 选 B |
| Host 复用 | 所属身份 + cwd + 存活/健康/租约 | 仍由同一 Fleet 管理；其他 Runtime 的配置摘要策略不变 |
| 恢复预检 | 仅完整原生目录确认精确 ID/cwd | 1.88 静默接受缺失 ID，因此该差异仍有真实依据 |
| stdio cwd | 现有 argv 包装，不生成脚本 | ACP stdio 无 cwd 字段带来的必要适配 |
| env/header | 一次 wire 转义，服务器得到原解析值 | 1.88 在 ACP 后仍做变量展开，不能当作通用 ACP 行为推广 |

没有为共享一个小 Mod 新建资源缓存，没有专属锁、进程池、配置快照、文件监听器或回收队列。
Bootstrap 冻结内容、system/user 角色及证据轴未变，因而无需新增模型上下文 revision。

## 验证记录

自动验收使用新建私有 fixture，官方 npm 1.88.0；日常 1.66 安装、配置和 App 未修改。
原生控制探针确认 `--mod` ready 的 revision/nonce/PID，随后删除 ready；原生同名定义优先，stdio 自定义
cwd 正确。未转义 ACP `$${literal}` 被原生变为 `${literal}`；wire 转义一次后 stdio env 与 HTTP header
均原样收到 `$${literal}`、反斜杠、引号和 shell 字面字符。load/resume 对随机不存在 UUID 仍成功，故保留
精确目录预检，删除配置兼容性预检。

真实 sub2api/gpt-6-sol 经官方 Mod + ACP stdio/HTTP 两组，各实际调用工具一次、返回本次随机 receipt，
receipt 回到后继模型输入并由最终 ACP 答复返回。两组各 3 次前台模型请求均 HTTP 200；所有前台请求的
System 包含 Bootstrap，user 不含。HTTP 组另有 1 次无工具的后台请求在 fixture 关闭时中断，单独记账。
原生使用 codemode 调 MCP，不能以 tools 数组缺少直接 MCP schema 判失败；证据关联原生工具调用 ID、
目标引用、服务器实际请求和随机回执。

本记录不声称隔离 App 或 Windows/Linux 资格通过。完整资格仍按现有流程补齐。
