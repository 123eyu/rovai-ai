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

## 与其他 Runtime 的资源与复杂度对照（2026-10-25）

本次基于 `942219d36` 再检查生产调用链，随后只修改 stdio wire 的目录分支。比较重点是额外常驻进程、
每轮重复工作、磁盘开销、后台任务与锁；其他 Runtime 也存在某个步骤，不能单独作为保留依据。

| 关注点 | Command 当前行为／成本 | 其他 Runtime 对照 | 处理结论 |
| --- | --- | --- | --- |
| 默认目录 stdio MCP | 修复前所有投影的 stdio 都多一个常驻 Node，因为共享投影将缺省 cwd 补为 execution_root。本次相同 Session cwd 直接传原命令。 | Codex 的 Session MCP 配置直接携带 cwd；Cline 用原生配置字段，不由 Rovai 为每个 stdio 加 Node。 | **已减量**：每个实际启动的默认目录 stdio 少一个包装进程；HTTP 原本没有。 |
| 不同目录 stdio MCP | ACP 无 cwd 字段，仍保留 `node --eval` spawn 包装；该 Node 与子进程同时存活。 | ZCode 也按 cwd 包装；Unix 使用 shell `exec` 替换进程，Windows 使用 Node。Pi 未支持外部分配 MCP，不能把其零 MCP 开销当等价实现。 | 保留现有必要适配；不引入 Shell 拼接、缓存或守护进程。 |
| 原生配置与 HOME | 沿用用户 HOME；不扫描/复制 auth、settings、Mods 或原生 MCP。 | Codex 同样使用原生 HOME；部分 ACP 的私有配置文件来自各自协议需求。 | 无可删除的 Command 配置镜像；不为对齐其他 Runtime 增加文件。 |
| Run 级 MCP 投影 | 仍走共享 prepare：读取冻结投影，必要时生成 `runtime/mcp/.../canonical.json`、同步并重新读取校验。 | 所有消费共享投影的 Adapter 均承担该成本，不取决于最终交给原生的是文件还是 ACP 参数。 | 有 I/O，但不是 Command 私有原生配置副本。本 PR 不改，也不增加内存模式旁路。 |
| 新 Host 的 Bootstrap | 一个 Mod；一次 ready 写入、校验、删除；Session 首次绑定原子写一个正文文件。 | Cline 用原生 System Rule；Pi 用受管扩展和 binding。物理交付渠道不同。 | 保留现有文件布局和握手，不建立共享资源缓存。 |
| warm Bootstrap | Rust 检查 binding 是否存在后返回；原生每次调用 System hook 仍读 JSON、检查正文与 SHA。 | Pi 的 `before_agent_start` 同样读取并校验 binding。Codex 等走原生 Session 输入接口，不等于可以直接替代 Command Mod。 | 有文件读取与正文计算；没有证据证明是瓶颈，不加缓存/失效标记。SHA 不参与恢复或 Host 选择。 |
| warm 启动准备 | Fleet 复用成功时，不执行 cold callback 中的入口验证、环境解析、Built-in 进程上下文创建及 spawn。 | 继续使用共享 acquire/spawn 边界；其他 Runtime 保持原兼容策略。 | 未发现仍可直接删除的 Command 冷启动重复工作。 |
| 进程池与锁 | 使用共享 Fleet 和 ACP 的 stdin/pending/Session 状态；Run map 锁只做对象取放。 | Cline、Kimi 等使用相同 Host；DSH 另有原生 Session 锁对应的旧 Host 退役等待，Command 没有该分支。 | 无 Command 专属池、账号锁或新锁；不改 pending 的终态/退出顺序。 |
| 启动失败清理任务 | 未交接 child 的 owner Drop 启动一次停止、reap、进程树确认任务；无法确认则留材料诊断。 | 来自共享 `PreparedAcpProcess`，不是 Command 常驻任务。 | 保留；删除会留下取消/构造失败的资源所有权空档。 |
| 原生用量观察 | Command 不启用 `NativeUsageReader` 日志尾读路径。 | Kimi、Qoder、Codebuddy、MiniMax、TRAE 等按原生数据源启用；Cline 有自己的观察来源。 | 没有可删的 Command 用量轮询；不能误报为每个 ACP 都有后台日志扫描。 |
| 压缩与后台监控 | Command 当前没有启用专属 compaction relay/outbox；也没有配置 watcher。 | 部分 Runtime 有已接通的 best-effort 原生压缩策略。 | 没有新增资源候选；缺少压缩能力不等于资格已经完成。 |
| cold 恢复确认 | 仅 cold 查询官方 Session 目录，确认精确 ID/cwd；warm 不做。 | 能可靠拒绝缺失 ID 的 Runtime 直接恢复；Codebuddy 也有针对原生缺口的目标确认。 | 1.88 已实测会接受不存在的 ID，故保留；不查历史正文或配置。 |
| 模型／权限 RPC | 沿共享 Session 方法应用当前 Run 设置，模型 ID 原样传递。 | 其他 ACP 也应用冻结 Run 的权限和选择。 | 不为省一次 RPC 新增“上次值”缓存；没有额外登录探针。 |
| env/header 与工具事件 | 一次 wire 转义；工具初始/完成事件沿共享关联 map 补全输入和编辑片段。 | 1.88 会再次展开 env/header；稀疏事件关联与 Cline 共用。 | 均有原生回执或协议缺口依据，不扩展成配置缓存、额外锁或文件扫描。 |

可核对的代码入口：[Command wire 与 Bootstrap](../../../crates/rovai-core/src/command_code_acp.rs)、
[共享 ACP](../../../crates/rovai-core/src/acp.rs)（`ensure_agent_run_runtime`、`native_usage_selected`、
`PreparedAcpProcess`）、[共享投影](../../../crates/rovai-core/src/mcp_projection.rs)、
[Codex Session MCP](../../../crates/rovai-core/src/codex.rs)（`codex_mcp_session_config`）、
[Cline](../../../crates/rovai-core/src/cline.rs)、[ZCode](../../../crates/rovai-core/src/zcode.rs)、
[Pi Host](../../../crates/rovai-core/src/pi/managed-host.ts)和[压缩策略](../../../crates/rovai-core/src/compaction.rs)。

其中共享投影在 Unix 发布新文件时，依次同步文件、临时目录和 rename 后的 Run 父目录；冻结与恢复校验
仍有消费者。warm 不重写 Bootstrap **不代表整轮没有磁盘 I/O**。上述锁与任务结论只限当前接入差异，
不声称整个共享 ACP 已证明无死锁；也未测量 CPU／内存，不给出 MB 节省数字。

没有为共享一个小 Mod 新建资源缓存，没有专属锁、进程池、配置快照、文件监听器或回收队列。
Bootstrap 冻结内容、system/user 角色及证据轴未变，因而无需新增模型上下文 revision。

### stdio 默认目录的最小减量

旧报告将包装范围写成“自定义 cwd”并不准确：共享 `resolve_definition` 会补全缺省 cwd，旧适配只判断
`Some(cwd)`，因此每个经 Rovai 投递的 stdio 都会包装。现在把已有 Session 执行目录传入 wire 适配，
沿共享路径比较处理相同目录与 Windows 前缀表示；相同就保留 command/args，不同才继续原包装。
项目选择与 Mission 工作区已有 canonical 路径约束，本次不增加 realpath 扫描或新的目录准入检查；显式
配置其他路径别名时仍可沿原包装运行，不为消除所有等价拼写增加解析机制。

官方 1.88 在原生 `bindAgentSession` 中先进入 Session cwd，再连接 editor MCP。隔离原生控制探针将
CLI 初始目录设为 `host space`、ACP 目录设为不同的 `session space`，直接 MCP 自报后者且父进程就是 CLI；
不同目录用生产 `mcp-cwd.cjs`，回执为 `custom space`，进程链仍为 CLI → Node → Server。
该事实分别在 `session/new` 与同 ID 的 `session/load` 验证，不是从 Host 启动目录推测。

两条路径的空参数、空格、引号、中文、shell 字面字符及 env 原样到达；关闭 stdin、执行夹具进程组清理后，
所有已记录进程退出。该结果不单独证明原生仅靠 EOF 就会回收全部子进程。
首次夹具用 JavaScript 字符串替换时误用 replacement 的 `$$` 语义，env 检查失败；改用回调返回字面值后
两条路径通过，生产 Rust wire 转义没有修改。失败及修正一并保留在证据中。
本次只发送 initialize、Session 与 MCP discovery 控制请求，没有 `session/prompt` 或 `tools/call`，
不声称重新通过模型工具回执、历史内容恢复或 Windows/Linux 资格。原生凭据只传给隔离子进程，
没有复制到验收证据；日常安装、App 与原生历史未改动。

## 按接入 Checklist 对照其余方案（2026-10-25）

对照基线为 `e1e667905`；范围包括当前[接入 Checklist](../../development/runtime-integration-checklist.md)、
旧 [Command/Cline 14 轴表](../../research/runtime-monitoring/command-cline-checklist-2026-10-05.md)及
[10 月 6 日追加表](../../research/runtime-monitoring/command-cline-native-system-2026-10-06.md)。
旧表是特定版本的研究证据，不能把其中 headless、私有 HOME、原生 MCP 文件合并或 Preview 当成当前方案。
以下把“已实现的接线”与“1.88 已验证的子场景”分开，未验子项不冒称整轴通过。

| Checklist 能力轴 | 其他 Runtime 的代表方案 | 当前 Command 方案与已验范围 | 仍需区分的边界／最小处理 |
| --- | --- | --- | --- |
| Auth / Provider / Model | 各 Runtime 读取自身原生来源；Codex app-server 与 ACP 使用各自目录及选模方法。 | 原生 HOME、真实 ACP 目录、标准 set_model；sub2api 显式选择及 cold 后保存模型本次通过。 | 生产不借用其他 Runtime 凭据。测试使用已有原生认证，不能据此宣称 BYOK 不需要原生认证；全认证方式与凭据轮换未验。无需增加登录探针。 |
| Host / Fleet / LRU | ACP 共享 Fleet；Codex/Pi 等通过同一 Fleet 所有权与租约管理生命周期。 | 按所属范围、成员、Native Binding、cwd 复用；正常生产同一根 Binding 使用自己的 Host。共享冷启动回归已过，本次原生 warm 保持 PID。 | 原生同 PID A→B→A 是 Adapter 隔离证据，不意味着生产要跨 Binding 拼池；1.88 完整 App/LRU 压力未补验。 |
| Native Session / Continuation | Codex 使用 Thread resume，ACP 使用 load/resume；错误目标是否需要补确认由原生行为决定。 | exact ID；本次原生 Host 重启后恢复同 ID、回忆原 receipt，并再次调用 MCP。 | 额外 session/list 只弥补 1.88 接受缺失目标的缺口。Core/App 重启证据仍来自旧版本，不能用本次原生重启替代。 |
| Bootstrap / Context | Codex/Claude 用原生指令入口，Pi/DSH/Cline 用各自受管 System 交付。 | 官方 Mod；本次 11 次前台请求 System 中合成 B 的全文恰好一份，user 为零。 | warm 使用已有 binding，cold 使用该 Run 准备的 B；不重新比较新旧正文，也不增加跨 Host 冻结仓库。成员编辑时点沿本页现状说明。 |
| Compaction continuity | System 原生保留与 Core 补发是不同策略；只有补发正确性需要信号时才接 detector。 | Command 每次 System hook 追加 B，当前 detector 为 Disabled；这不等于原生压缩功能被禁用。 | 旧 1.74 manual/threshold/cold 证据不能替代 1.88 的 manual/threshold/overflow+retry 矩阵。补验 System 保留即可，不为打勾另造 detector/outbox。 |
| Skills | 当前共享来源是平台索引、成员工具箱和 Harness 原址发现；原生目录依 Runtime 不同。 | 使用共享 native_skills 的 `.commandcode/skills` user/project 来源；无 Command 私有投影。Registry 仍标 DocumentationOnly。 | 旧读取/撤销证据不能提升当前整轴；1.88 真实读取、热更新、删除、同名与相邻成员矩阵未完成。不要恢复旧 delivery group 目录复制。 |
| External MCP | Codex Session 配置、Cline 原生配置、其他 ACP 参数交付；同名规则可因原生行为不同。 | 标准 mcpServers，原生同名优先；本次默认目录直启、自定义 cwd 包装、HTTP 均真实调用，cold 后再次直启。 | 默认包装已删；保留共享投影和必要 wire 转义。生产 Assignment 更新/撤销、相邻成员与取消副作用的完整新版本矩阵不能只靠工具调用通过。 |
| Tool / Action / Output | 共享 Tool ID、Action、命令输出与分级 Diff；Cline/MiniMax 也需要关联稀疏事件。 | Command 仅做原生编辑片段转换，原生 codemode ID 与 MCP 回执本次可关联。 | 1.88 的 stdout/stderr/empty/nonzero/large output、编辑形态未全验；旧非零 exit 字段不足不能靠 shell 包装或最终文本猜补。 |
| Narration / Final / Missing-Send | 各协议提供权威终态，公开发送与 Missing-Send 使用共享规则。 | ACP prompt 结果与稀疏事件沿共享路径；本次四轮 end_turn 均回传实际 receipt。 | 原生 final 不等于产品公开消息已发送；本次未运行 Core 的 zero-send/accepted-send/tool→final 全链路。无需新增 Command 终态状态机。 |
| Permission / Approval / Workspace | 唯一原生审批权威；例如 Kimi 用 Session mode，Cline 用 mode 与 auto_approve。 | 五种原生 mode 经 set_mode；Command 不再由 Core 自动允许同一请求，避免第二层审批。本次使用 bypass。 | allow/deny/cancel、只读及实际目录边界仍需独立验；不能把 bypass 的 MCP 成功当作这些选项通过。 |
| Built-in rovai CLI | 当前 bundled CLI、逐 Run binding/lease 和操作目录共享。 | 沿共享 Built-in 进程上下文与租约，没有 Command 专属 CLI 或桥。 | 旧版本公开发送证据保留；本次没有 Core lease，未重跑当前完整 operation 集，不能把 MCP 当 Built-in CLI 资格。 |
| Usage / Cache / Cost | 各原生字段分别归一；Cline 可用观察来源，其他 Runtime 可能有日志 reader。 | `result._meta.usage` 解析 Prompt 四桶，Session gauge 单列；不启用 NativeUsageReader，不把 Session totals 当当前 Run。 | reasoning、request cache hit 与 Run 费用未被声明可用；1.88 字段、重发、retry/compact/cold 归属需核验。不要用额外日志扫描或估算填未知值。 |
| Retry / Queue / Cancel / Cleanup | 公共 accepted-input、epoch、队列与受管进程回收；原生差异保留在协议适配层。 | 共享实现和先回收后清理 owner；本次关闭/进程组清理后记录的 8 个 PID 全部消失。 | 正常清理不代表 in-flight cancel、崩溃、超时或迟到副作用矩阵通过；旧产品故障记录与当前共享测试分别记账，不另建 Command 清理器。 |
| Ready / Version / Platform | discovery/health 与平台资格分开；普通检查不承担全部生成验收。 | 公共版本解析器、1.88 稳定版下限、一次必需 Mod ready；普通错误保留原生分类。 | 所有平台 NotQualified。macOS arm64 本次原生 smoke 不提升 App、Intel、Windows 或 Linux 资格；不因清单增加 warm 每轮探针。 |

上述实现入口为 [Adapter Registry](../../../crates/rovai-core/src/agent_runtime_adapter.rs)、
[原生 Skills](../../../crates/rovai-core/src/native_skills.rs)、[用量归一](../../../crates/rovai-core/src/monitoring.rs)
与上一节的共享 ACP/Fleet 入口。Checklist 的 process compatibility 可由明确所属身份表达，不等于必须有
配置摘要；“配置更新生效”按当前合同的显式操作或原生加载规则验收，不恢复外部文件扫描和隐式换 Session。

### 主干后来增加的两项方案

- **原生提问**：Claude/Copilot/Qwen/OpenCode V2/ZCode 走已验证的原生禁用；Kimi 等走精确识别后的原生取消。
  Command 目前只有共享 `questionnaire:` option 前缀兜底，没有专属已验证的问卷帧或禁用参数；本次未触发问卷。
  这是待确认的能力差异，不能用普通 permission RPC 或 bypass 成功替代，也不能直接照抄别家 flag、选默认答案。
  下一步只需先取得 1.88 原生请求，再选原生禁用或共享取消，不新增问卷 UI/管理器。
- **原生自动记忆**：当前产品决定专门覆盖 Claude/Codex，采用原生开关且保留会话和工程规则。
  没有依据把它机械复制成 Command 的文件隔离、目录清理或全局配置覆盖；Command 的原生能力与产品要求需分别确认。

### 旧方案的文档边界

旧 Checklist 中 one-shot/headless、私有 HOME、MCP 文件合并、BYOK 无显式选模、Preview 均已被后续方案替代。
revision 5 输入说明仍保留初次确认快照中的“再次绑定正文必须相同”“256 KiB 外层预算”与“配置/profile fence”；
本次补充其历史边界和当前 v72 路由，不改写已确认输入快照，也不重新引入已删除的实现。
结论是继续补齐有具体范围的资格证据；本次没有发现需要再增加或删除一套 Command 生命周期机制的理由。

### sub2api 真实回执补验

在 `e1e667905` 的独立 worktree 上，使用官方 `command-code@1.88.0`、Command 自己已有的
`sub2api/gpt-6-sol` 配置与认证、全新隔离 HOME/cwd、合成固定 Bootstrap、当前生产 Mod 和 argv 包装。只将隔离 Provider URL
指向透明 loopback 观察器，模型请求/响应字节不改写，不借用其他 Runtime 的凭据或重写上游工具集合。

| 场景 | 原生 PID／Session | 实际 MCP 调用与结果 |
| --- | --- | --- |
| first：默认目录 stdio | PID 46909；Session `238b1212-7ea9-4a1d-af0d-df4868f8fbd9` | 直启 MCP，父进程为 CLI；调用一次，随机 receipt 回到后继模型输入与最终答复。 |
| warm：不同目录 stdio | 同 PID／Session | 原 argv 包装切换 cwd；调用一次，完整回执闭环通过。 |
| warm：HTTP | 同 PID／Session | 调用一次，header 字面值保持，完整回执闭环通过。 |
| cold：默认目录再次调用并回忆 | 新 PID 47404；同 Session | 先精确目录确认再 load，保存的 BYOK 模型保持；回忆首轮随机 receipt，再实际调用一次取得新 receipt。 |

共 11 次前台模型请求与 1 次无工具后台请求，全部 HTTP 200；无中断请求。前台每次 System 中 B 恰好一份，
user 为零。四次 codemode 调用均以同一原生 Tool ID 关联 ACP completed 和服务器回执；搜索完成不算工具调用。
两次 Host 的 stdio cwd、空参数、空格、引号、中文和 env 字面值正确，HTTP header 正确。
关闭 stdin 并执行夹具进程组清理后，8 个已记录 PID 均不存在，隔离目录已删除；仅导出脱敏结果。
这证明当前原生 ACP 与 Mod/MCP 交付，不冒称已经经过产品 Core/App 的完整 AgentRun、审批取消或跨平台资格。

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

同日 stdio 默认目录跟进：新增的纯 wire owner 通过；最终 `pnpm test:rust:pr` 整套通过，核心 431 通过／
0 失败／1 忽略，其余目标 46 通过，doc-tests 通过。之前超时的 Cursor 身份探针本次在整套中通过，
此前失败记录保留。`cargo check --workspace`、格式检查、10 项文档测试及文档治理通过。
官方 1.88 的新建／恢复 stdio 控制探针见上节；增加一个无 I/O 的 Rust owner，零新增仓库文件或生产文件种类。
未重跑模型工具调用、App 或跨平台资格，也未测量性能。

同日 sub2api / Checklist 跟进仅更新四个已有文档/证据文件，生产逻辑与 Rust test owner 不变。
10 项文档测试、文档治理、格式与差异检查通过。默认 workspace 首跑核心 429 通过／2 失败／1 忽略：
一项为本轮编辑兼容性登记表导致冻结证据字节不匹配，已撤回该处编辑，保持原有资格 revision，
新结果仅写入本页和既有 JSON；同一 workspace 配置重编译后该 owner 通过。
另一项为相同 Cursor 身份探针超时，同一 workspace 二进制单独复跑通过（0.30 秒）；未改其实现或阈值。
其余目标 46 项和 doc-tests 通过；首跑失败记录保留，不将分项复跑描述为整套全绿。
仅清理本轮产生的失败测试夹具；真实 sub2api 的四轮与原生验收清理结果见上节。
