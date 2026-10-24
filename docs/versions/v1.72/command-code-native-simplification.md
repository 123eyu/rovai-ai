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
pending/stdin/取消/退出的锁顺序。清理只用已有 `Option<root>` 表示材料所有权，删除两个恒真开关。
Native Binding 提交从已有 JOIN 读取 Runtime kind，删除同一行的额外查询。

PR #890 后续审查将 Command 的入口/指纹检查和必要刷新移到 Fleet cold spawn；warm 只保留安装身份、
显式禁用/删除及既有准入。cold 使用当前安装证据启动，冻结 Run 的逻辑选择、Binding 和 Session 不换代，
启动事件使用实际 Host 版本。MCP 修改只将本次受影响成员传到现有失效入口，无变化不退役；warm Session
不再构造不会发送的 MCP wire 参数。没有新增文件或长期状态；保留 `bindings/<session-id>.json`，不为少一层
目录改写不可变 binding 交付。

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
| 编辑工具事件 | 保留 matched-fragment 到 reported mutation 的窄转换 | 与其他 Runtime 的事件归一化职责相同；原生 old/new 字符串不能误报为整文件 diff |

Command 专属模块净减少 398 行，额外删除 health 中 44 行名称探测/解析。仍保留的恢复确认、Mod binding、
wire 适配和编辑事件转换都有原生协议差异依据；没有把它们扩展成生命周期管理层。

没有为共享一个小 Mod 新建资源缓存，没有专属锁、进程池、配置快照、文件监听器或回收队列。
Bootstrap 冻结内容、system/user 角色及证据轴未变，因而无需新增模型上下文 revision。

## 验证记录

脱敏数据见[原生接入证据](evidence/command-code-native-simplification-2026-10-24.json)。

自动验收使用新建私有 fixture，官方 npm 1.88.0；日常 1.66 安装、配置和 App 未修改。
原生控制探针确认 `--mod` ready 的 revision/nonce/PID，随后删除 ready；原生同名定义优先，stdio 自定义
cwd 正确。未转义 ACP `$${literal}` 被原生变为 `${literal}`；wire 转义一次后 stdio env 与 HTTP header
均原样收到 `$${literal}`、反斜杠、引号和 shell 字面字符。load/resume 对随机不存在 UUID 仍成功，故保留
精确目录预检，删除配置兼容性预检。

真实 sub2api/gpt-6-sol 经官方 Mod + ACP stdio/HTTP 两组，各实际调用工具一次、返回本次随机 receipt，
receipt 回到后继模型输入并由最终 ACP 答复返回。两组各 3 次前台模型请求均 HTTP 200；所有前台请求的
System 包含 Bootstrap，user 不含。增加完整字符串出现次数计数后，两组再次各调用工具一次，
每次前台 System 中 B 恰好一份，user 为零。两轮各有 1 次无工具后台请求在 fixture 关闭时中断，单独记账。
原生使用 codemode 调 MCP，不能以 tools 数组缺少直接 MCP schema 判失败；证据关联原生工具调用 ID、
目标引用、服务器实际请求和随机回执。

同一原生 Session 经一次 warm 与两次 cold 仍能精确回忆先前随机回执，保存的 BYOK 模型未被覆盖。
再将该 Session 的分配 MCP 从 stdio 替换为新 HTTP endpoint，冷恢复仍使用原 ID/冻结 binding。
首个探针没有重设权限，客户端拒绝原生 permission 请求，工具零调用；按生产路径调用 `session/set_mode`
后，新 endpoint 实际调用一次并返回新回执。此失败及修正均保留，不把模型返回 UNAVAILABLE 算作成功。

隔离 fixture 的进程已退出，复制的凭据和原生历史随整个 fixture 删除；只导出明确白名单证据。
本记录不声称隔离 App 或 Windows/Linux 资格通过。完整资格仍按现有流程补齐。

PR 后续控制边界回归在隔离夹具中完成：42 项定向 Rust 测试通过，1 项既有真实账号 smoke 按条件忽略。
覆盖 cold callback、Command 入口变动/禁用/删除、MCP 成员范围与 no-op、导入、Fleet 取消/回收及旧 Binding。
两处初始测试预期（setMembers 自动启用、入口验证不额外探测版本）已修正，保留在证据中。
本次跟进未重新调用真实模型；上文原生 1.88 证据与公开资格边界不变。

默认工作区整套两次均为核心 428 通过、1 个既有 Cursor 身份探针超时、1 忽略；该探针在同一个工作区
测试二进制中单独复跑通过（0.32 秒）。其余工作区目标分开运行 46 项通过，doc-tests 通过。保留整套
超时记录，不把单独复跑算作整套全绿，也未修改 Cursor 探针代码或超时阈值。
