---
document_type: contract
name: Runtime Launch and Verification
version: v72
status: accepted
source_version: v1.72
last_updated: 2026-10-24
---

# Runtime Launch and Verification v72

继承 [v71](runtime-launch-and-verification-v71.md)。本版替代 Command Code 的私有 HOME、原生配置
副本和配置兼容性摘要策略；其他 Runtime 保持既有策略。Command Code 的正式接入基线为官方 1.88.0。

## Command Code 所有权与连续性

Adapter 沿用共享启动环境的用户 HOME，不设置 HOME、不镜像或复制 `.commandcode`，不代建原生
projects/sessions、不读取认证/provider/settings/Mod/MCP 来计算兼容性摘要。用户的原生数据由 CLI 自己管理。

共享 Fleet 明确区分配置摘要策略与 Native Binding 身份策略。Command 只选择后者：Camp/Conversation
所属范围、成员、Native Binding ID、canonical execution root 必须一致，并满足既有进程健康、空闲和租约门槛。
缺失摘要或计算失败不会让其他 Runtime 进入身份策略。同 Run 复用仍校验 execution epoch、所属身份和附件执行根，
不比较 Runtime 或 MCP 投影摘要。Binding generation、Conversation version、Run/epoch 和已准备 Binding ID
继续防止跨会话及陈旧提交。

Command 新投影不生成 `hostConfigDigest`、`bindingCompatibilityDigest` 或带摘要的 Native Session key；
共享冻结结构的这两个字段允许 null。历史字符串继续反序列化，不清库、不回填、不因旧值不同换代。
Binding 提交根据冻结 Run 的 Runtime kind 明确选择此策略，忽略旧配置摘要相等条件；完整载荷、幂等请求、
凭据和 Bootstrap 内容完整性校验保留，不能决定 Host 或 Session 选择。

Host 退出、应用重启或容量回收后，新 Host 用精确旧 Session ID 和原冻结 Bootstrap 恢复。原生 1.88.0
`session/load`、`session/resume` 仍接受不存在的 ID，因此仅在冷恢复阶段通过 `session/list` 核验精确 ID 与 cwd；
不扫描历史正文、不选择最近 Session。目录不完整、认证、网络、超时不是目标不存在。只有完整原生目录确认
缺失才进入既有可见的连续性丢失流程；其他错误保留原 ID。

## 生效时机

- 模型 ID 原样传给标准 Session RPC，包括 `provider/model` 和 `@byok-…` 碰撞别名；不用 `acp --model`。
- 模型、权限通过原生动态 RPC 更新，保留 Host/Session。
- Rovai 启动设置、安装、成员启动环境与 MCP 分配/定义的显式成功修改，通过已有 Fleet invalidation 应用。
  空闲 Host 关闭，忙碌 Host 正常结束后退役；后继 Host 恢复原 ID，并传入当前 MCP。
- 已运行 Host 保留启动环境；外部原生配置编辑按原生规则或用户显式重载生效，不触发 Rovai 扫描或隐式重建。
- 自动检测可执行文件指纹变化不能使存活 Command Host 失效。真正启动时继续使用公共启动验证。

## Bootstrap 材料

每个新 Host 只写一次 `rovai-bootstrap.mjs`，通过官方 `acp --mod <absolute-path>` 加载。
初始化局部 nonce 经环境传给 Mod；initialize 后只校验一次 revision、nonce 和实际 PID，删除 `ready.json`
并丢弃预期 nonce。没有 nonce 文件，也没有长期 nonce map/数据库字段。

每个 Session 首次绑定原子写入 `bindings/<native-session-id>.json`，同 Session 内容不可变；warm 不重写。
稳态只有 Mod 与实际使用的 bindings。hook 按 `state.sessionId` 读取目标 binding，校验 schema、ID、预算及
内容 SHA-256；缺少或损坏时在模型请求前退出。冻结 B 仍追加到原生 System 一次，user 只含动态 P。
此交付方式不改变 B/P 字节、选择规则、上下文版本或证据权威。

## ACP MCP

分配的 MCP 只经新建/恢复 Session 的标准 `mcpServers` 传入。用户原生 MCP 由 CLI 加载，1.88.0 已验证
原生同名定义优先；删除额外 `mcp list` 探测和私有 `mcp.json`，warm 不启动额外 CLI。

stdio 自定义 cwd 使用已有 `node --eval` argv launcher，不生成脚本文件或增加代理管理层。
1.88.0 的原生客户端即使从 ACP 接收 env/header pairs，仍调用 `resolveEnvPlaceholders`：字面 `$${x}`
会变成 `${x}`。因此只在 Command ACP wire 边界对已解析值中的 `${` 转义一次为 `$${`；真实 stdio/HTTP
回执须证明到达值与解析值一致。它不是原生文件格式序列化，禁止再叠加第二层转义。

## 失败材料

准备对象在创建进程前负责清理目录；进程创建后到 Host 接管前，局部启动 owner 同时持有进程和材料。
底层进程树初始化失败也必须返回仍持有实际 child 的失败对象。停止并 reap 后才可清理；无法确认完整进程树
结束时保留材料并记录诊断。Host 接管后复用既有 shutdown。共享 stdin、pending、Session、取消、退出排序
不改变；不新增专属锁、进程池、配置缓存、监听器或持久清理队列。

本结构变更不代替真实模型、MCP、App 与各平台资格验收，公开准入仍由现有资格流程决定。
