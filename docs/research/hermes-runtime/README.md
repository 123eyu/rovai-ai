---
document_type: research-note
authority: non-normative
last_updated: 2026-10-23
---

# Hermes 接入与验证

`rovai/hermes-runtime` 已切换到**未修改的官方 ACP＋专用官方 Gateway**。macOS arm64 仍为 Preview，
兼容策略为 **>=0.22.4**，没有 commit、dirty 或上界 fence。实际验证安装是 0.22.4，source commit
`4d04303818b61bf3aa09278af48356315515965b`。规范见 [Hermes Managed Runtime v1](../../contracts/hermes-managed-runtime-v1.md)，
取舍见 [V1.72-D59](../../versions/v1.72/decisions.md#v1-72-d59)。最低版本策略不代表所有新版/平台取得资格。
本次官方生产入口的 [脱敏证据摘要](official-production-evidence.json) 单独记录通过项和识图失败，不混用早期进程内结果。

## 交付与执行边界

本机采用官方 source distribution，入口 `~/.local/bin/hermes`。早期 Brew 0.22.2 已解除链接并保留供回退；
没有安装 Hermes Desktop，也没有连接日常共享 Gateway。独立 worktree 为 `../rovai-ai-hermes-runtime`，
PR 为 [#878](https://github.com/murray17/rovai-ai/pull/878)，交付前合入主线并保留双方版本记录。
当前分支尚未合入 main 或安装到 Rovai 日常 App。Migration 214 / schema 164 扩展 Runtime/Skill 闭集；
215 / schema 165 增加 Hermes nullable 输入证据。后续 user 层投递变更与本页既有系统层验收分开记录，
见[首次输入实施验证](../../versions/v1.72/hermes-first-input-implementation.md)。

验收使用隔离 dataDirectory、project、Skill Library、MCP 文件、Hermes Home 与 Built-in lease；不访问
日常 Electron userData。真实模型按 User 授权使用 Hermes 自身的 Sub2API / gpt-6.1-sol 配置。
Adapter 不借用其他 Runtime 凭据；临时凭据与原始 wire 不进入仓库或交付证据。

## 官方路径的边界

[切换前 Probe](official-entry-validation.md) 已证明：官方 ACP viewer 本身不拥有执行者；专用 Gateway
可以受管，但暖 Gateway 会继续使用旧系统指令和终端 lease 环境。生产因此采用 binding 独立持久 Home，
每 Run 新建 Gateway＋ACP＋controller，结束回收，下一轮精确冷恢复原 Session。Probe 测得冷重建约 5.5 秒，
这不是所有机器和模型的延迟保证。持久 Session 不因每 Run 的进程重建而新建。

controller 仅借用发行物的连接、发现和纯格式化帮助函数，运行公开 CLI/RPC，不构造 Agent、不覆盖工具，
不修改 installed Python 源码。它核对 storage lock、Gateway PID/Home/external-supervisor，拒绝附着其他
Gateway；Core 也恢复 binding 目录的 owned-processes 记录。config/凭据/用户 Skills 保留原生来源，
SessionDB/socket/锁独立；禁用隐式依赖同步、消息平台、cron 和脱离 Run 的后台模型调用。

B 由 Core 已准备内容前置到首次普通用户输入；接受后不重复，规则更新和完成压缩通知后的下一普通输入
各携带一次当前规则。controller 不再解析或覆盖原生 system/personality/env overlay，新进程仍刷新 CLI 环境。
user 层运输与完整输入账本例外见 [D60](../../versions/v1.72/decisions.md#v1-72-d60)。
公开 RPC 的 admission/generation 与 Core prompt ID 关联，提供精确 Steer/interrupt。MCP 使用原生 editor
assignment，显式 mutation 验证全部发现并处理撤销；私有 config 排除 Rovai 同名服务，源配置不变。
模型切换和 reasoning 以原生实际 ACK 为准，错误由对应 prompt receipt 保留原生脱敏详情。

官方 ACP 不提供原方案的完整文件快照。当前使用 Gateway 完成事件的原生 patch/inline diff，验证成功、
路径、完整 hunk 和限制后持久化 reported_mutation。新增、覆盖、patch、删除和多文件都有实际片段证据；
CRLF 显示被规范化，空文件/纯移动可能没有文本片段。没有扫描磁盘/Git 补证，也没有把预览、失败或截断
内容升级为完整 before/after。历史完整状态仍可读，早期进程内验收不算新路径的完整状态资格。

## 能力与证据

| 能力轴 | 官方路径验证 | 保留边界 |
| --- | --- | --- |
| Auth / Provider / Model | 原生配置和目录，命名 endpoint/model ACK，effort 设置进入真实请求 | 仅已测 Sub2API；OAuth refresh 并发矩阵未执行 |
| Host / Fleet / LRU | 独占 Gateway/ACP 树，binding 持久 Home，正常退出和取消回收 | 未跑满 20 Host LRU / 30 分钟 TTL |
| Native Session | 精确 cold resume、缺失 Session 结构化拒绝；正常重启原 ID 不重复规则；unknown 经用户 CLI 精确确认后原 Session 接受新任务 | 不自动重放或换 Session；原任务仍失败/结果未知；见[显式恢复证据](explicit-unknown-recovery-2026-10-23.json)，[此前失败](first-input-core-recovery-2026-10-23.json)保留 |
| Bootstrap / Context | user 层首条、后继、冷恢复、身份更新与接受账本；原生 env/config/personality 各生效一次 | 不提供 system/developer 优先级；不改共享 B/P 文案和 Formatter |
| Compaction | 原生 272000/204000 窗口/阈值，真实模型两次自动压缩与冷恢复请求观察；Core 验证通知→下一输入→ACK | 不承诺同 Run 立即恢复；历史/摘要可能仍含旧规则，补发不清理原生历史；取消压缩矩阵未验收 |
| Skills | 原生 skill_view 实际读取，用户/受信项目索引规则保留 | `.agents` 用户目录需 opt-in；`.env` 独有目录变量的菜单索引不等价 |
| External MCP | 实际 tool_search/describe/call，精确原 Session 增加、改配置、撤销，同名 Rovai 优先，坏服务拒绝 | HTTP/SSE/OAuth 全矩阵未执行；直接 tools 数组不是全部工具 |
| Tool / Action / Output | 原生 raw input/result，成功文件片段和 Core runtimeDiff 入库，失败/空/移动/二进制/大文件边界 | 无完整 before/after 承诺；terminal 任意写入无自动全量 Diff |
| Narration / Final / Missing-Send | 共享 Explicit SendOnly；实际公开 Send 及修正后唯一 marker | 异常恢复全部组合未穷举 |
| Permission / Workspace | 原生 edit policy ACK；命令审批经 ACP/Core 保留；clarify 不出现在模型工具列表 | 无 OS sandbox；read-only 无法保证则拒绝 |
| Built-in CLI | 真 terminal 的 rovai --help / send，冷 Run 更新 lease | 非全部 CLI 操作验收 |
| Usage / Cache / Cost | Session 累计转 prompt delta；cache read 计入 input；真实暖轮、受控数值与 context gauge | 无原生费用/cache write 时保持未知 |
| Queue / Cancel / Cleanup | 真实终端取消；Core SIGKILL/重启清理全部已记录后代，已接受输入不重放，无重复 Send | 完整 LRU/TTL/多会话竞态矩阵未完成 |
| Steer | 原生 queued＋精确 generation ACK，同一 Core Run 接受修正并实际 Send；错轮/迟到拒绝 | 未知运输不重发；不用并发 prompt 排后继轮 |
| Image | 图片 bytes 到达官方 Gateway 原生缓存，未被 controller 改写 | 本次模型识图不通过，不能从 ACP image=true 推定结果质量 |
| Ready / Version / Platform | >=0.22.4、受管 revision/PID、官方能力探测；FirstPayload 与 signal-driven/best-effort，旧 Ready 升级刷新 | macOS arm64 Preview；其余平台 Not Qualified；无 system 保留保证 |

## 图片与 Skills 的额外评估

四色 PNG 的原生缓存已目视确认与发送内容一致。默认 auto 模式走 Hermes vision 预解析，错误描述为单色
magenta，主模型据此回答无法分辨四象限。隔离 config 显式设 `agent.image_input_mode: native` 后，主模型
识别出 cyan/magenta/yellow，但将蓝色象限误判为 white。因此图片运输成立，当前 Provider/模型组合的
识图准确性未通过；保留独立严格图像断言，不把失败改成通过。产品配置继续尊重原生模式，不全局强制 native。

原生 `.env` 的 Skills 路径变量可进入运行时 dotenv 环境；Rust 菜单索引目前仅展开启动环境变量，不能从
这次运行时调整推定菜单完全等价。直接路径、`~`、启动环境变量、create/external、信任和禁用规则已有 owner
覆盖；真实 skill_view 证明实际加载。用户 `~/.agents/skills` 需显式 external_dirs，项目 `.agents` 需受信最近 Git 根。

## 复现与验收归属

- `test-hermes-controller.py`：纯 controller 状态机/解析器；ACP 先返回、Gateway 队列未消费，回放补齐精确 admission/工具证据且不重复；缺归属、gap、错 epoch/generation 拒绝；原生两个 Update 的空行与 SQL 注释删除，残缺/错路径/NUL 拒绝；unknown 查询/明确确认、已终态只查、错误身份、运行/审批/排队/多 unknown 及恢复后不一致矩阵。
- `smoke-hermes-wire.mjs`：安装的官方执行器＋loopback Responses；user 层规则/普通输入、规则更新、usage delta、错误、无 admission 的 `/help`，env/system prompt/personality 三种原生 overlay 各按原生优先级生效，B 仅在 user 层，无后台模型调用。
- `smoke-hermes-experience.mjs`：同一真实执行器，受控 Responses；reasoning、问卷排除、文件片段/失败边界（包含两个普通 Update 和 SQL 注释删除）、精确 Steer、错误模型详情、MCP 增改撤销/同名/失败。
- `smoke-hermes-failed-usage.mjs`：隔离生产 Core＋原生执行器＋loopback Responses，首调用产生 tool call 和已知 usage，第二次调用 401；断言 Run failed、一次 prompt 用量入账、费用未知。纯 controller 测试不能替代该持久化 seam。
- `smoke-hermes-native.mjs`：真实模型、MCP/Skill、model ACK、暖轮和冷恢复、缺失 Session 与重复 Session 拒绝；`ROVAI_HERMES_SMOKE_IMAGE=1` 独立开启严格识图资格断言。
- `smoke-hermes-auto-compression.mjs`：真实模型，保持原生窗口/阈值，正常文件读取触发自动压缩；以实际请求与完成 Hook 验证下一输入补发和冷恢复。
- `smoke-hermes-first-input.mjs`：隔离生产 Core、官方 ACP/Gateway 与 loopback Provider，检查首条/后继/冷恢复/身份更新的原生请求、接受账本及自动压缩通知后的补发；`--compression` 使用测试窗口/尾部配置与合成 usage，单独记账；`--recovery` 验证强杀后的用户明确恢复及旧 Ready 快照失效／重新检测，不与压缩混用。
- `smoke-hermes-core.mjs`：真实 Core＋模型，首条输入及时 ACK、同 Run Steer/公开 Send、runtimeDiff/context 入库、冷 Run 终端取消及回收；包含隔离 Core SIGKILL/重启恢复检查，`--force-unknown` 另强杀独占 Gateway，确保验收原生未落盘终态后的显式处理。
- `smoke-hermes-official-acp.mjs`：切换前不经过 controller 的官方入口对照 Probe，不替代生产 Core 验收。

以上脚本位于 `scripts/`。native/Core/压缩脚本要求 `ROVAI_HERMES_BIN` 和专用已配置的
`ROVAI_HERMES_SMOKE_HOME`，不发现或复制密钥。受控脚本使用 dummy key；可用
`ROVAI_HERMES_DEPENDENCY_HOME` 复用选中安装的已准备依赖，不让 fixture 隐式安装。

旧路径的 Renderer 验证保留为 UI 证据：effort 保存、原生错误详情、用户/项目 Skill 区分，以及首条输入 ACK
修复后同一 Run Steer。切换未改这些共享 UI，不将旧路径的私有 executor 或完整文件快照结果迁移为新路径证据。

## Rust 测试归属

Rust 仍只有两个新 seam owner：launcher/identity 和成功原生文件证据。官方 file_result 及路径/失败拒绝
扩展原有 `hermes::tests::native_patch_requires_a_successful_corroborated_complete_hunk` 与 runtime_diff owner，
不增加平行重型 fixture。共享 ACP extended owners 67 passed / 2 ignored；迁移、目录闭集和索引继续走原 owner。
自动检查、最终 Core 恢复结果与具体 fixture 摘要随 PR 验证栏记录。
本次修复继续扩展 launcher/identity owner 的失败执行身份负例和 monitoring 原有稀疏 usage owner，
没有增加 Rust 测试函数。最低验证命令为 `python3 scripts/test-hermes-controller.py`、
`cargo test -p rovai-core --lib hermes::tests`、
`cargo test -p rovai-core --features extended-tests --lib runtime_parsers_emit_sparse_usage_without_antigravity_inference`。
受控 smoke 另需官方安装；真实 LLM 不参与上述四项确定性回归。
本轮最终 wire fixture `rovai-hermes-wire-dsIDWL` 的三个 overlay 与 B 各出现一次；体验 fixture
`rovai-hermes-experience-gUPMcr` 的两个普通 Update、SQL 注释删除和既有 MCP/Steer 矩阵通过。
失败用量 fixture `rovai-hermes-failed-usage-F6FEla` 验证 Run failed，输入 100、输出 10、cache read 40、
reasoning 2 仅入账一次，费用/cache write 未知。账本异步投影完成后核对持久值，不把 Run 终态出现当作
账本队列已落盘。连续冷启动同时暴露原生 daemon storm 退避；专用外部 supervisor 关闭该退避后全组通过。

官方生产路径最终 Core fixture `rovai-hermes-core-dISqud`：首轮同 Run Steer 成功，第二轮实际终端取消，
第三轮终端运行中 SIGKILL 隔离 Core，重启后 Run 失败收敛且未自动增加 Run。第四轮显式输入恢复同一
native Session，读取先前文件并用更新 lease 成功 Send；两次公开 marker 各一条，受管后代全部退出。
原生 MCP/Skill/冷恢复最终 smoke 通过；体验 fixture `rovai-hermes-experience-zKX52V` 包含新增服务、
修改凭据、撤销、同名优先与坏服务显式拒绝，全部通过。图片资格失败独立记录于上节。

## 来源

合入前补修的普通 Rust、受控升级/恢复与真实模型强杀结果见
[实施验证](../../versions/v1.72/hermes-first-input-implementation.md#合入前补修与显式恢复)和
[脱敏摘要](explicit-unknown-recovery-2026-10-23.json)。恢复入口只走 User Automation 的固定操作，
不会将 Agent 的普通聊天输入当作未知执行确认，也不创建隐式业务 Run。

- [官方 ACP](https://hermes-agent.nousresearch.com/docs/user-guide/features/acp)与[Gateway local sessions](https://hermes-agent.nousresearch.com/docs/developer-guide/gateway-local-sessions)。
- [官方配置](https://hermes-agent.nousresearch.com/docs/user-guide/configuration)与[Skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills)。
- [本次安装源码](https://github.com/NousResearch/hermes-agent/tree/4d04303818b61bf3aa09278af48356315515965b)：acp_adapter/gateway_server.py、gateway/session_local_mcp.py、agent/image_routing.py、gateway/run_inbound.py。
- Logo 来源仍为同 commit 的 website/static/img/apple-touch-icon.png，仅作 Runtime 产品标识。
