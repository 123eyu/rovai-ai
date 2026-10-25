---
document_type: implementation-report
source_version: v1.72
last_updated: 2026-10-25
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

2026-10-25 可用性跟进删除 Command 的新旧 Bootstrap 逐字比较和 Rust/Mod 两端的 256 KiB JSON
封装限制。已有 binding 直接返回，warm 不读取旧正文、不序列化新正文；只在该 Host 首次绑定时写入。
正文继续使用共享 128 KiB 预算。cold 按既有 Context 为本轮准备 B，再绑定精确恢复的原生 Session；
这不要求历史 B 相等，也不新增跨 Host 冻结管理器。
成员环境保存将已解析值和继承选项的实际变化传给既有失效入口，格式无变化和命令重放不触发退役。
health probe 删除丢失原始错误的 Command 特例，和其他 ACP 共用错误分类与展示脱敏；未修改 Run 卡片。

后续六项审查修复：启动设置释放 `runtime_search_update`、安装更新释放数据库锁后才等待 Fleet；
字段目标已达到时返回成功，安装命令重放不重复失效，新命令保存相同安装值也不增加 version/generation。
Command 最低版本判断复用通用解析器，接受产品名前缀、`v` 前缀和构建元数据，保留 1.88 稳定版下限。
MCP 成员集合使用实际增减成员；关闭 Server 的定义、分配、删除和导入替换不触发 Host 退役，
`setMembers` 非空分配启用 Server 的原行为保留。共享认证状态和失败摘要使用“认证未通过”，
检查登录状态或凭据配置，仍优先显示现有脱敏原生原因。共享 ACP 仅在策略提供 MCP 摘要时比较它，
Native Binding 不再执行 `None == None`，没有增加 Command 特例或新的复用条件。

## 收口复核（2026-10-25）

User 后续清单引用 `ce140e684`；以下核对的是已推送的 `abf8f4cdc`。前五行已有修复，
本次只补注释和说明，不再扩展 Runtime 行为。

| 问题 | 当前结果与边界 |
| --- | --- |
| 持锁等待 Fleet | `save_runtime_startup` 显式释放 `runtime_search_update`，安装更新结束数据库锁作用域后，才等待 Fleet。安装路径有受控并发回归；启动设置路径由调用链复核，不声称已真实复现原死锁。 |
| 非空设置请求重试 | `prepare_save` 保留字段合法性、重复字段和实际冲突检查，剔除当前值已等于目标的字段；全无变化沿既有返回路径退出，不检查程序文件、不增加 revision/generation、不退役。覆盖 A→B 成功后入口暂时消失再重试。 |
| 安装更新重放 | `execution.replayed` 不触发后续失效；新命令保存相同目标也返回 `adapter_installation.unchanged`，不增加 version/generation。与上一行是两个分别覆盖的入口。 |
| 版本误拒绝 | 使用共享版本解析器；接受 `v`、产品名前缀与 build metadata，仍要求稳定版至少 1.88。 |
| MCP 退役范围 | 已启用 Server 从 A、B 改为 A、B、C，只影响 C；修改前后仍关闭的定义、单成员分配、删除和导入替换不退役。`setMembers` 非空集合会按既有语义启用 Server，此时新分配成员的有效配置确实变化。 |
| 认证文案与 BYOK 注释 | 认证失败沿共享分类和脱敏原因展示，不一律要求网页登录。本次删除代码注释中“Command BYOK 选模仍不支持”的旧结论；原生默认模型占位分支仍处理当前模型未出现在返回目录中的情况，不影响目录内 BYOK 的显式选择。 |

不继续整理空摘要比较或 binding 目录。`session/list` 精确恢复确认、一次 ready 握手、binding 正文
完整性校验、stdio cwd 包装及 wire 转义继续只承担已验证的原生适配职责。没有新增 Runtime 文件、
认证探针或配置比较；Mod 读取 binding 仍是 System 交付，不增加缓存。

### 成员身份与长期指令何时生效

共享规则区分“本轮准备了什么”与“Adapter 实际投递什么”，见
[Bootstrap 不变量](../../architecture/foundational-invariants.md#context-session-bootstrap)和
[补发门禁](../../architecture/native-session-bootstrap-redelivery.md#delivery-gate-与-prepared-cutoff)。
`members.update` 只保存成员资料并发布名册事件，不创建 Run、补发要求、Session 或 Fleet 退役。
专业职责、工作原则等完整 self identity 仍只在 Bootstrap；Dynamic Context 的 peers 不代替它。

| 时点 | 当前 Command 行为 |
| --- | --- |
| 身份编辑前已 claim 的公开 Run | 继续使用该 Run 已冻结的身份；编辑不回写既有输入。 |
| 身份编辑后 claim 的公开 Run | 共享 Context 准备新身份；旧／非 batch Run 沿准备时读取规则。准备新 B 本身不等于已向模型投递。 |
| 同一 Host／Session warm 续用 | 使用该 Host 首次绑定的完整 B；身份编辑不重写 binding，模型的这份 System 仍是旧内容。 |
| 后续新 Host 冷恢复，或新 Session 首次绑定 | 写入该 Run 准备的 B。若该 Run 在编辑后取得身份，就使用新内容；冷恢复保留精确原 Session ID，不要求新旧 B 相等。 |

因此，当前 Command **不保证成员编辑在下一次 warm 执行中进入 System**；生效取决于后续新 Host／Session
首次绑定所用的 Run 内容。共享规则没有要求所有 Runtime 在身份编辑后立即热更新，本轮不改变这一产品行为。
若要求“下一轮 warm 也必定使用新指令”，需要另行确定投递规则；不能用隐式重启、摘要或跨 Host 冻结管理器代替该决定。
以上是现有调用链核对，不是新增的真实模型验收。

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

2026-10-25 四项修复的定向回归 5 项 Rust 通过、1 项既有真实账号 smoke 忽略；既有 Mod Node owner 通过。
覆盖 binding 内容变化后继续复用、转义正文、环境保存事实及 Command/Kimi 真实 probe 入口的三类模拟错误；
既有 dispatcher/Fleet 的 MCP 退役回归也通过。成员环境的退役条件通过代码核对，没有为绕过公开资格新增测试入口。
工作区全目标 slow-tests 编译、格式检查及文档门禁通过（文档测试 10 项）；未重跑全套或真实模型/MCP。
该轮零新增仓库文件、生产文件种类和 Rust test owner。

同日六项审查修复的 8 项定向 Rust 回归通过，安装写入/Fleet 并发 owner 在最终代码再次通过。
覆盖数据库锁释放后等待启动、同命令 replay 与相同目标新命令、程序入口暂时移走时旧字段保存重试、
版本文本、有效 MCP 成员变化及关闭状态导入、共享 ACP 复用与认证错误分类。
启动设置的锁作用域由调用链复核；并发夹具使用共享安装写入路径，没有绕过 Command 公开资格。
`pnpm typecheck`、`pnpm test` 通过：Vitest 2992 通过/2 跳过，主 Node suite 358 通过/2 跳过。
`cargo check --workspace` 与格式检查通过。默认工作区为核心 429 通过/1 个相同 Cursor 探针超时/1 忽略，
同一二进制单独复跑 Cursor 通过（1.01 秒）；未修改其实现/超时，也不把整套标绿。
其余工作区目标分开运行 46 项通过，doc-tests 与文档治理通过；失败测试的临时夹具已删除。
本轮没有新增仓库文件或生产文件种类；增加一个无 I/O 的版本解析 owner，其余扩展既有 owner。
未重跑真实模型/MCP 或平台资格，完整证据继续见上面的 JSON 记录。

同日基于 `abf8f4cdc` 的收口复核只修改两处代码注释及既有报告/导航，没有新增文件、测试或 Runtime 行为。
文档治理（含 10 项测试和真实 base 差异检查）、Rust 格式检查通过。提交前默认 workspace 再跑为
核心 429 通过/1 个相同 Cursor 身份探针超时/1 忽略；同一二进制单独复跑通过（0.25 秒），其余目标
46 项及 doc-tests 通过。仅清理本次失败夹具，不改 Cursor 探针或阈值，不把整套标绿。
本次身份生效时机为共享合同与生产调用链核对；没有新增真实模型/MCP 或跨平台验收。
