---
document_type: research-note
authority: non-normative
last_updated: 2026-10-25
---

# Hermes 接入与验证

当前接入是 User sequence 56/60 确认的官方 ACP、原生 Home、原生 Session 定位。
CLI 单次业务请求由 Core 查现有 Conversation/活动 Run/lease，不增加表或模型参数。
原生版本 0.22.4，源码 `4d04303818b61bf3aa09278af48356315515965b`；macOS arm64 保持 Preview。
当前合同见 [Hermes Runtime](../../contracts/hermes-managed-runtime-v1.md)，取舍见 [D65](../../versions/v1.72/decisions.md#v1-72-d65)。
最新执行结果见 [实施记录](../../versions/v1.72/hermes-first-input-implementation.md)。
本轮 [原生会话定位验收](native-session-acceptance-2026-10-25.json)记录两个真实成员、12 个受控 Run、
两次原生压缩、原 Session 冷恢复、MCP 部分失败/恢复、取消隔离及 Core 强杀不重放。

## 交付与执行边界

独立分支 `rovai/hermes-runtime`，PR [#878](https://github.com/murray17/rovai-ai/pull/878)。
生产代码直接替换未上线实验，无旧 Home 导入/回退；未修改用户日常 Hermes 安装或日常 App 数据。
验收使用同一测试用户 Home 下的原生 `.hermes`、预先启动的共享 Gateway、独立 Core data/Skill Library/MCP，
未补丁官方源码，Provider 是本地受控端点，不能算真实付费模型或平台资格矩阵。

## 官方路径的边界

关闭 ACP 仅关闭连接，不强杀共享 Gateway；原生取消不承诺已经产生的外部效果可撤销。
MCP resume 空列表不是已确认撤销。原生 memory/Skills/system 配置继续生效，共享 Home 不隔离成员记忆。
首次/真实规则更新仍用 user 层；压缩不补发，不保证完整规则永久保留。
逻辑 chat_id 可定位 ACP Session，物理 session_id 可能旋转；跨轮后台 CLI 按调用时 Run 归属。

此前[客户端环境修复](client-env-feasibility-2026-10-24.md)、[中间件研究](middleware-feasibility-2026-10-25.md)
和[原生边界探针](native-acp-boundaries-2026-10-24.md)均为历史探索，不参与当前生产路径。
其旧逐执行身份目标不再是本方案约束；原 [R2 提案](first-input-r2-proposal.md) 的迁移/插件探索被
[已确认 R2](../../versions/v1.72/model-context-change-hermes-first-input.md)替代。

## 此前实现的能力与证据（历史记录）

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

当前入口为 `node scripts/smoke-hermes-native-session.mjs <official-source> <prepared-python>`。
使用一次性完整用户 Home，实际官方 ACP/Gateway 与同包 Core/CLI，记录原生逻辑标识、模型请求和发送归属。
不连接日常用户 Gateway，不用修改上游或逐 Run wrapper 帮助成功。

旧 controller Python fixture 和私有 Home 的 wire/native/experience/first-input/core/failed-usage/auto-compression
脚本随对应生产路径退役；Git 与已有 JSON/研究文档保留历史证据。旧官方入口对照脚本仍是历史探针。

## Rust 测试归属

扩展现有 Hermes 入口、Adapter Ready、上下文接受账本、compaction policy、lease registry、CLI 断线与
ManagedProcess 取消 owners：初始/真实更新、旧 pending 停止消费、字段/身份、一次派发、根进程清理。
删除 host.py 的 Python tests 与私有维护 CLI tests，因为对应产品功能本轮删除；不删除数据库迁移或历史读取测试。
不新增等价测试 fixture、表、锁或恢复框架。

最小命令：`cargo test --workspace`；`cargo test -p rovai-core --features slow-tests,extended-tests --lib hermes`。
原生真实身份与两个成员调用的跨模块语义由上面的隔离 smoke 拥有，不能仅靠纯函数证明。

## 来源

- [官方 ACP](https://hermes-agent.nousresearch.com/docs/user-guide/features/acp/)
- [原生终端 Session 环境](https://github.com/NousResearch/hermes-agent/blob/4d04303818b61bf3aa09278af48356315515965b/tools/environments/local.py)
- [原生压缩调用方上下文](https://github.com/NousResearch/hermes-agent/blob/4d04303818b61bf3aa09278af48356315515965b/agent/compression_facade.py)
