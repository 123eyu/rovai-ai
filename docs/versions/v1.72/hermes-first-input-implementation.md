---
document_type: implementation-plan
version: v1.72
authority: implementation-status
last_updated: 2026-10-23
---

# Hermes 首次输入规则实施与验证

按 [R1](model-context-change-hermes-first-input.md) 和 User sequence 31 实施。
Core 继续拥有完整 B；Hermes 在首次、更新或可靠完成通知后的下一普通输入携带一份规则。
官方 ACP/Gateway 与逐 Run lease 不变；原生 system/personality/环境变量不再被 Adapter 解析或覆盖。

Migration 215 / schema 165 保留旧记录，仅增加 nullable 输入证据；初次交付 controller revision v4（下节补修升至 v5），Hermes
outer envelope v1；共享 Bootstrap v6、Charter 25、Dynamic 40/42 与 Profile 15/16 不变。
历史 system Evidence 不改写。prepared/unknown 不消费规则或补发 revision，也不自动重放旧业务任务。

## 生产 Core 与实际请求

[受控 Core 证据](../../research/hermes-runtime/first-input-core-acceptance-2026-10-23.json)：
`protect_first_n=3` 和 `0` 各运行七个成功 Run，同一 Native Session，投递类型均为
`initial → none → none → update → compaction_recovery → compaction_recovery → none`。
第三轮和第七轮都重启 Core；第七轮在两次补发已接受后冷恢复，不重复规则。
原生完成 Hook 使 requested revision 从 0→1→2，输入 ACK 分别消费 1、2；较早 ACK 不清理较晚通知。
每轮同一任务只发一次实际 `session/prompt`，主模型为一次 terminal Send 加一次 final，未增加规则确认调用。

使用生产 Core/CLI、未修改的官方 ACP/Gateway、确定性 loopback Responses 和真实请求捕获。
测试窗口 65536、阈值 0.5、尾部保护 2，第三/四轮合成 input usage 60000 触发原生自动摘要；
它证明运输、事件、账本与恢复链路，不冒充真实模型质量或原生默认配置验收。
Gateway 原生会 trim 消息首尾空白，模型请求与冻结输入经这一原生规范化后相等，B 内部完整原文不变。
源配置手写 system prompt 仍位于 system 层，B 位于 user 层。

初版验收遇到原生最小窗口 64000 的明确拒绝，已改正测试窗口；未把失败 Run 计为通过。
另有新 Home 的原生 `--version` 被同步联网更新检查拖到 15 秒超时，尚未提交任务。
loopback fixture 使用原生 `updates.check=false` 关闭这项联网行为；未放宽生产超时或版本门槛。

## 真实模型自动压缩

[真实请求/完成事件证据](../../research/hermes-runtime/first-input-automatic-compression-2026-10-23.json)：
官方 0.22.4 / source `4d04303818b61bf3aa09278af48356315515965b`，Sub2API `gpt-6.1-sol`。
正常文件读取触发两次已提交 summarize，分别来自 pre_api 与 post_tool；没有主动 compact 或压缩器补丁。
保持原生配置 protect_first_n=3 / protect_last_n=20 / threshold=0.5；原生实际窗口 272000，
实际阈值 204000，以原生日志为准，没有把配置比例直接乘作有效阈值。
官方 pre_api_request 观察完整规则正文是否在 user 历史、是否进入 system；post_compaction 只观察完成事实。
下一普通输入补发后及原 Session 冷恢复后的请求均有完整规则，未进入 system，冷恢复没有新增规则输入。
这一层使用较小的合成规则块，完整 Core B 的证据由上节拥有。

原生摘要可能逐字保留规则，历史中也可能仍有旧副本；本方案按可靠完成通知补发一次，
不编辑或清除原生历史。不能从某次摘要保留推导所有路径永远保留，亦不宣称同 Run 内立即恢复。
旧 system 层压缩报告不作为此次 user 规则永久保留证据。

## 回归、限制与复现

Controller 4 个确定性回归通过。wire fixture `rovai-hermes-wire-NdYZkg` 的 7 个实际请求通过：
user 规则、原生 env/config/personality 各按优先级生效一次、控制命令、并发拒绝、失败与 usage delta。
原生 `gateway: null` 配置启动兼容已修复并随 wire 验证。
experience fixture `rovai-hermes-experience-dFMn8a` 通过文件片段、reasoning、问卷关闭及同 Session MCP 增改撤销。

[真实 Core 回归](../../research/hermes-runtime/first-input-core-recovery-2026-10-23.json)通过同 Run Steer、
唯一公开 Send、文件证据和冷续轮的真实终端取消。但强杀 Core 后的继续执行**未通过**：
原生 admission 留在 `unknown`，controller 拒绝 unsettled Session；Core 保留
`accepted_input_outcome_unknown`，没有自动重放旧任务、清理原生未知记录或换 Session 绕过。
这限制强杀后的即时续接，不混同已通过的正常冷恢复。所有已记录后代均退出；临时凭据副本已清除。

定向 Rust：Hermes 4、Bootstrap 11（另 1 个 Command Code 原生用例未启用）、compaction 16、redelivery 2、
CLI hook 1、catalog migration 1、迁移准入矩阵 1、数据库打开准入 1、Managed Blob 3 均通过；筛选间有重叠。
迁移夹具跟进 schema 165；缺当前 receipt/规则字段拒绝，历史可选统计缺失仍可重开。
新增最终 Blob 纳入现有 FK 引用保护与 Thread 删除回收。
`pnpm typecheck`、文档测试 10 项、通用/diff-aware 文档门禁、Rust fmt、脚本语法和 whitespace 检查通过。

复现入口：`scripts/smoke-hermes-first-input.mjs --compression` 与 `--compression --unprotected`；
真实模型使用 `scripts/smoke-hermes-auto-compression.mjs`。均声明独立 Home、data-dir、Skill Library 与 MCP。

## 合入前补修与显式恢复

按 User sequence 34 / [D61](decisions.md#v1-72-d61) 实施，保持 FirstPayload。生产 Ready 能力独立声明
`context.charter.first_payload`、`context.compaction.signal_driven`、`context.compaction.best_effort`，
移除 Hermes 的两个旧 system 保证；模型、effort、权限和 session.load 保留。
普通目录映射测试修复前实际失败，现已改正。静态发现使旧 Ready 变为 installed_unverified；
深检缓存也拒绝旧合同，运行检查后回到新 Ready，不为刷新能力而轮换原生 binding。

新增用户 CLI 查询和明确确认入口，合同见 [Hermes Managed Runtime](../../contracts/hermes-managed-runtime-v1.md#用户明确处理未知执行)。
Core 持久记录精确 Run/binding/admission/generation 的用户同意，再调用官方 `prompt.resolve_unknown`；
controller v5 使用独立控制连接，不加载普通 ACP Session，不发送任务。确认结果未知时重用同一检查文件，
先查询精确 receipt；同一个 commandId 不可更换确认目标。原 Run、输入和公开发送证据均不改为成功。
维护 Host 仍由 Fleet 回收；复用逐 Run 的原始 Session 存储，不复用旧 CLI lease。

[受控与真实恢复摘要](../../research/hermes-runtime/explicit-unknown-recovery-2026-10-23.json)分开保存：

- `rovai-hermes-first-input-566fmf`：官方原生执行＋loopback Responses，六阶段覆盖首次、后继、冷恢复及旧 Ready
  升级、规则更新、Core 强杀和显式处理后的新任务。错误 binding/generation、缺少确认和 commandId 换目标均拒绝；
  检查不消除 unknown，恢复零模型调用、零额外业务 Run，Core 再重启后的同确认重试幂等，旧任务失败且执行一次。
- `rovai-hermes-core-h3UHnB`：生产 Core/CLI＋真实 Sub2API `gpt-6.1-sol`。同 Run Steer、文件证据、公开 Send 和
  真实终端取消通过；同时强杀专用 Gateway 与 Core，明确得到 unknown；用户确认后原 Session 的新任务成功，
  旧任务仍失败、旧输入未重放、公开 marker 各一次，受管进程全部退出。

三个先行尝试保留为诊断：旧 Ready 升级首次未命中静态发现分支，现已修正；一次 Host 启动身份校验遇到
`try_lock` 读 PID 的竞争，改为只在 Hermes Ready 校验处等待 child 锁，保留 PID/revision/version 校验；
一次仅强杀 Core 的真实模型运行已经由原生结算为空闲，不计入 unknown 恢复通过。
后续 `--force-unknown` 明确同时强杀独占 Gateway，避免把原生正常结算路径冒充未知执行处理。
这批验收的凭据/config 副本已清理，源 Home 未改，保留脱敏摘要和隔离执行证据。

普通 Rust 全量回归单独执行；首次发现兼容性文档证据 hash 过期（431 passed / 1 failed / 1 ignored），
按实际文档更新 hash 后重跑，不跳过原断言。补修与主线合并提交 `2cdadec68` 的
`cargo test --workspace -j 2 -- --test-threads=1` 为 **478 passed / 0 failed / 1 ignored**；
最后将缓存校验严格限定为 Hermes，最终提交的同命令复核结果记录在 [PR #878](https://github.com/murray17/rovai-ai/pull/878)。
CI 的 fmt/check 不替代 Rust 单测。
Controller 确定性回归 5 项、User Automation 定向测试 10 项与 TypeScript 检查通过。
本次不重跑已记录的自动压缩矩阵，不把显式恢复当作同 Run 压缩恢复；未新增 Renderer 按钮或日常 App 安装验收。
