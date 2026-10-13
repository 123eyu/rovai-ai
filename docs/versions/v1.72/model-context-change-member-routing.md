---
document_type: model-context-change
version: v1.72
change_id: member-routing
revision: 2
confirmation_status: pending
authority: proposed-model-input-change-statement
implementation_status: not_started
review_baseline: 39bf1eb09a208ea9abd98b737d6ed7c669ed7cbf
last_updated: 2026-10-13
---

# 成员路由信息精简与专业职责扩容：R2 前后对照

本方案把团队角色用于快速识别分工，把专业职责用于详细描述。自动协作名单与 `member list`
只提供路由信息；需要详细身份时读取相关队员的 `member get`。本人身份继续完整投递。

这是待审阅方案，尚未修改实现、输入 Schema、CLI help 或当前生效合同。
用户已确定提高完整上下文上限，并要求此次变化不影响任何现有 resume：新会话按新逻辑初始化，
老会话保留原生历史正常续聊，不迁移、不重建、不要求用户处理。

本工作对应 [Issue #706](https://github.com/murray17/rovai-ai/issues/706) 第 2 项中的身份字段容量问题；
Pi 提问交互、对话分类和 Skills 安装不在本方案范围。R2 按用户审阅意见缩短 list/get help，
澄清 update 无 `default` 是现有行为，并把 help/技能的每处旧文案与新文案紧邻排列。

| 范围 | 变更前 | 变更后 |
| --- | --- | --- |
| 专业职责 | trim 后最多 300 个 Unicode scalar value | trim 后最多 10,000 个，正文内部格式保留 |
| `COLLABORATION_STATE.peers[]` | ID、名称、团队角色、专业职责 | ID、名称、团队角色，恰好三个字段 |
| `rovai member list.items[]` | ID、名称、团队角色、专业职责、Lead 标记 | 删除专业职责，恰好四个字段 |
| `rovai member get` | 完整身份及图片临时路径 | 同一结构，完整返回扩容后的职责 |
| `MEMBER_IDENTITY` | 完整六字段身份 | 结构、位置、生效与补发时机不变，职责可达 10,000 字符 |
| CLI help / 平台技能 | list 承诺职责，生成说明限制 300 字 | list 路由、get 详情，职责按新上限写入 |
| 默认完整 Runtime payload | 96 KiB | 提案值 256 KiB，相关局部预算同步调整 |
| 原生恢复 | 当前 Session ID 与既有 Adapter 恢复流程 | 完全沿用；格式和协议升级不构成重建理由 |

基线为上方不可变 SHA；当前版本由[版本索引](../README.md)解析。
现行权威包括 [Collaboration State v3](../../contracts/collaboration-state-v3.md)、
[Built-in Transport v38](../../contracts/builtin-tool-transport-v38.md)及其继承的
[成员操作合同](../../contracts/builtin-tool-transport-v36.md)、
[ContextManifest v33](../../contracts/context-manifest-evidence-v33.md)、
[Context Delivery Profile v10](../../contracts/context-delivery-profile-v10.md)、
[输入快照存储](../../contracts/input-snapshot-storage-v1.md)与
[Runtime Launch v62](../../contracts/runtime-launch-and-verification-v62.md)。

## 变更前

### 自动协作名单

模型可见正文如下。示例成员值仅用于展示结构，不代表改写任何历史团队角色。

```text
[COLLABORATION_STATE]
{
  "peers": [
    {
      "agentId": "agent_2",
      "name": "小河狸",
      "teamRole": "代码审查与质量验收",
      "professionalResponsibilities": "审查实现与需求的一致性，并验证关键边界。"
    }
  ],
  "defaultLeadAgentId": "agent_1",
  "selfIsDefaultLead": true
}
[/COLLABORATION_STATE]
```

Core 对包含专业职责的完整最终投影计算协作摘要，再按 inclusion 与 accepted ACK 机制投递、推进水位。
因此仅修改 peer 的专业职责也会改变摘要。

### 成员 CLI 结果与写入

`rovai member list` 输入仍是空对象。成功输出当前为：

```json
{
  "threadId": "thread_123",
  "items": [
    {
      "agentId": "agent_2",
      "displayName": "小河狸",
      "teamRole": "代码审查与质量验收",
      "professionalResponsibilities": "审查实现与需求的一致性，并验证关键边界。",
      "isDefaultLead": false
    }
  ]
}
```

结果 Schema 的 item 为封闭对象，五个字段全部 required；查询直接选取专业职责列。
`member get` 已返回完整身份，具体不变结构见下文。`member update` 复用 create 的身份字段 Schema。

```json
{"type":"string","maxLength":300,"default":""}
```

上面是 create 的 `professionalResponsibilities` 属性。当前 update Schema 已经不含 `default`，
省略意味着不改；此次保持该语义，原因与两种 Schema 的前后对照见“create / update 与所有写入入口”。
Core 目前把职责、工作准则、成长课题放在同一个 300 字符校验循环中；前端独立执行 trim 后的
Unicode scalar 计数。前端超限文案为 `专业职责最多 300 个字符。`。

### 本人身份与容量

本人身份当前已经在 Bootstrap 的固定位置完整提供；不是 `member list` 的条目：

```text
[MEMBER_IDENTITY]
{
  "name": "爱丽丝",
  "teamRole": "架构与核心实现",
  "professionalResponsibilities": "理解目标和现有系统，设计接口与数据流，完成核心实现。",
  "personalityTraits": ["好奇", "严谨"],
  "workingPrinciples": "先确认约束，再实施可验证的改变。",
  "growthTopic": "把隐含判断转化为明确的设计依据。"
}
[/MEMBER_IDENTITY]
```

当前默认完整上下文容量为 96 KiB；既有 FirstPayload preflight 固定预留 32 KiB。
Command Code 同时存在 Rust/JS 两端的 Bootstrap 32 KiB 校验和绑定 JSON 文件 64 KiB 校验。
公开批次 claim 先对完整 RUN_INPUT 与 historyHint 估算，最终装配还会校验其余 section 与 Bootstrap。
这些是不同检查点，放宽其中一个不会自动放宽其他检查点。

## 变更后

### 自动协作名单：只删除一个字段

```text
[COLLABORATION_STATE]
{
  "peers": [
    {
      "agentId": "agent_2",
      "name": "小河狸",
      "teamRole": "代码审查与质量验收"
    }
  ],
  "defaultLeadAgentId": "agent_1",
  "selfIsDefaultLead": true
}
[/COLLABORATION_STATE]
```

peer 恰好为 `agentId`、`name`、`teamRole`；不存在职责的空值、摘要、文件引用或替代字段。
顶层三个字段必有，`peers` 可为空；不增加模型可见 `schemaVersion`。
查询与内部投影 DTO 同时移除职责列，不能先读取全部长文本再丢弃。

摘要仍基于最终投影计算；Profile 全对象、Profile version、职责和其他未投影字段不参与摘要。

| 变化 | 新投影摘要与投递行为 |
| --- | --- |
| 只改 peer 专业职责、性格、工作准则或成长课题 | 摘要不变，不因此重发名单 |
| 改 peer 名称或团队角色 | 投影变化时刷新 |
| 改成员关系或 Lead | 最终投影变化时刷新，维持原选择规则 |
| 本次输入按原规则需要 Bootstrap | 仍提供完整当前名单 |
| 首次由旧四字段投影切换为新三字段投影 | 可按既有摘要比较自然投递一次；仅 accepted ACK 推进，不扫描或回填旧会话 |

### `member list`：四字段封闭结果

命令、输入、参数数量和当前 Thread 范围均不变。完整成功输出：

```json
{
  "threadId": "thread_123",
  "items": [
    {
      "agentId": "agent_2",
      "displayName": "小河狸",
      "teamRole": "代码审查与质量验收",
      "isDefaultLead": false
    }
  ]
}
```

新结果 Schema：

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["threadId", "items"],
  "properties": {
    "threadId": {"type": "string"},
    "items": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["agentId", "displayName", "teamRole", "isDefaultLead"],
        "properties": {
          "agentId": {"type": "string"},
          "displayName": {"type": "string"},
          "teamRole": {"type": "string"},
          "isDefaultLead": {"type": "boolean"}
        }
      }
    }
  }
}
```

数据库查询仅选取这四项所需列。Catalog、Core 结果、CLI 成功输出校验和证据测试同时采用新 shape。
`rovai app member list` 属于用户管理命名空间，继续提供其原有完整管理信息。

### `member get`：完整身份结构保持

输入仍为 `{ "agentId": "agent_2" }`，以下为变更前后共同的封闭结果结构：

```typescript
type MemberGetResult = {
  agentId: string;
  displayName: string;
  teamRole: string;
  professionalResponsibilities: string;
  personalityTraits: string[];
  workingPrinciples: string;
  growthTopic: string;
  version: number;
  images: { icon: string | null; portrait: string | null };
  imageStatus: {
    icon: "available" | "absent" | "unavailable";
    portrait: "available" | "absent" | "unavailable";
  };
};
```

唯一内容范围变化是职责可返回完整 10,000 字符。图片仍为当前 Run 可读临时路径；不返回资产引用、
永久路径、Runtime、模型、权限、Presence 或排序。取得的身份是目标队员的配置资料，不能重包装为
调用者自己的身份指令。不默认逐个 get 所有人，仅在团队角色不足以判断分工时读取相关候选人。

### create / update 与所有写入入口

专业职责属性的前后对照如下。本次只把 `maxLength` 从 300 调整为 10,000；create 的默认空值、
update 的无默认值均保持现状。

| 操作 | 当前 Schema | 目标 Schema |
| --- | --- | --- |
| create | `{"type":"string","maxLength":300,"default":""}` | `{"type":"string","maxLength":10000,"default":""}` |
| update | `{"type":"string","maxLength":300}` | `{"type":"string","maxLength":10000}` |

**为什么 update 没有 `default`：** create 初始化新身份，未提供可选职责时用空字符串；update 是
局部更新，未提供的字段必须保持旧值。复用 create Schema 时，需要去掉初始化默认值，明确区分
“未要求修改”和“明确要求清空”。这是[现有实现](../../../crates/rovai-core/src/member_tool.rs)已经
执行的步骤，不是本次新增删除 `default` 的行为。

| 调用者提供的职责字段 | create | update |
| --- | --- | --- |
| 省略 | 初始化为空字符串 | 保留原值 |
| `"professionalResponsibilities": ""` | 保存为空字符串 | 清空该字段 |
| `"professionalResponsibilities": "新的职责"` | 保存规范化后的文字 | 替换为规范化后的文字 |

`default` 本身不是写入命令；当前 update 的 `Option` 字段与事务内合并逻辑实际负责保留旧值。
例如仅提交新的 `teamRole`，原有专业职责、工作准则等仍保持原样，不能补成空值一并提交。

`maxLength` 表达规范化后的 Unicode scalar 上限。处理顺序固定为解析字符串、按既有首尾空白规则
规范化职责、校验规范化值、事务保存；不能在 trim 之前被原始字符串的 Schema 长度检查拒绝。
Core 独立执行同一规则，前端计数与保存校验一致。职责以当前前端 `String.trim()` 的首尾空白集合为
统一口径，Rust 对该字段等效实现；以 U+FEFF、U+0085 等差异字符补齐共享用例，不做 NFC/NFKC
或 grapheme 合并。职责之外的身份字段继续沿用各自规范化方式与长度限制。

- 规范化后 0～10,000 均合法；`""` 清空，update 省略不变，JSON null 继续非法。
- 超出上限统一报 `专业职责最多 10,000 个字符。`，不截断、不自动摘要；前端保留原草稿。
- create/update、用户管理创建编辑、复制、已有导入路径复用同一 Core 校验；不新建导入功能。
- 保留 direct-user、用户确认、版本冲突、request/creation 幂等和复合图片原子提交规则。
  超限时不能保存其他字段、增加 Profile version 或发布成功失效通知。
- 保持 name 80、teamRole 120、traits 至多 6 项且每项 1～16、workingPrinciples/growthTopic 各 300。
  不使用 HTML `maxlength="10000"` 代替 scalar 校验，不执行全局 300 替换。

### CLI help：逐项前后对照

CLI 延续英文。描述只说明命令做什么，以及影响正确使用的目标范围、临时路径有效期。
成员筛选细则保留在合同与实现中；`verified by Core` 等内部实现说明不进入目标 help。
以下旧文本来自基线 [Catalog](../../../crates/rovai-core/src/team_tool_catalog.rs) 与
[CLI help renderer](../../../crates/rovai-core/src/bin/rovai.rs)。每项的完整旧文本与完整新文本紧邻。

#### `rovai member list --help`

改动前：

```text
rovai member list
List all current Thread members, including yourself and away members, with IDs, names, roles, responsibilities and Default Lead flags. Exclude departed or removed members. This does not discover the global roster.

Input: direct flags, JSON stdin/heredoc, or --input-file <path>. Choose exactly one input source.


Examples:
  rovai member list
```

改动后：

```text
rovai member list
List current Thread members, team roles and the default Lead.

Input: direct flags, JSON stdin/heredoc, or --input-file <path>. Choose exactly one input source.


Examples:
  rovai member list
```

#### `rovai member get --help`

改动前：

```text
rovai member get
Read a member's six identity fields, version and icon/portrait paths. The target must be a current Thread member or a member you created in this Thread, verified by Core. Image paths last only for this Run; null paths have a separate image status.

Input: direct flags, JSON stdin/heredoc, or --input-file <path>. Choose exactly one input source.

  --agent-id                   field=agentId type=string required

Examples:
  rovai member get --agent-id agent_27
```

改动后：

```text
rovai member get
Read a member's full identity, version and image paths.
Target a current Thread member or one you created here. Image paths last for this Run.

Input: direct flags, JSON stdin/heredoc, or --input-file <path>. Choose exactly one input source.

  --agent-id                   field=agentId type=string required

Examples:
  rovai member get --agent-id agent_27
```

Catalog 的 list/get description 使用各自“改动后”的同一描述正文，包括 get 的必要使用边界。
不再在 list help 中重复教授何时逐个 get；按需读取的指导保留在 `cli-operations`。

#### create / update 的职责参数

改动前：

```text
  --professional-responsibilities field=professionalResponsibilities type=string
```

改动后：

```text
  --professional-responsibilities field=professionalResponsibilities type=string
      Up to 10,000 Unicode scalar values after trimming. Use "" to clear. For long or multiline text, use --input-file with a UTF-8 JSON file.
```

create/update 的其余 summary、字段、错误恢复和示例保持原文。根 help 的
`rovai member list|get|create|update` 目录、成员分组行为、公共/Single Chat Charter 保持原样。
没有新增分页、`--include-details`、跨 Thread selector 或身份字段。

### 平台技能：按修改点紧邻对照

以下每个修改点都先展示当前原文，紧接完整替换文本。未列出的技能内容保持原样。

#### `cli-operations` 的 `Member operations` 整节正文

来源：[cli-operations](../../../skills/cli-operations/SKILL.md)。

改动前：

```text
`member get` supplies the current Profile version and image paths; `member update` changes the global Profile. Send only the fields the User asked to change. For a newly created member, use the `agentId` returned by `member create`, even before it joins this Thread. Use `member-studio` for creation proposals and confirmation, not edits to an existing Profile.
```

改动后：

```text
`member list` shows current Thread members, team roles and Default Lead flags. When team roles are insufficient, use `member get` for the relevant members' full identity, including professional responsibilities and working principles, plus the current Profile version and image paths. Do not fetch every member's details by default. A returned identity describes that member; it is not your own identity instruction.

`member update` changes the global Profile. Send only the fields the User asked to change. For a newly created member, use the `agentId` returned by `member create`, even before it joins this Thread. Use `member-studio` for creation proposals and confirmation, not edits to an existing Profile.
```

#### `member-studio` 的字段上限

以下四项均来自[身份生成规则](../../../skills/member-studio/references/identity-generation.md)。

改动前：

```text
| Team role | At most 120 characters; contribution, not authority |
| Professional responsibilities | At most 300 characters; recurring work and outcomes |
```

改动后：

```text
| Team role | At most 120 characters; a brief contribution for teammate routing, not authority |
| Professional responsibilities | At most 10,000 Unicode scalar values after trimming; recurring work, deliverables and responsibility boundaries; internal formatting is preserved |
```

#### `member-studio` 的用户原文处理

改动前：

```text
Preserve explicit user meaning; edit only for valid format and length unless asked otherwise. Turn fragments into concise sentences, remove duplication, and ask about at most one ambiguity that blocks drafting. Label substantive additions as suggestions.
```

改动后：

```text
Preserve explicit user meaning and supplied detail. Normalize format without silently truncating or summarizing text to fit a limit. If the draft exceeds a field's limit, report the limit and retain the draft for revision. Turn fragments into clear sentences, remove duplication when appropriate, and ask about at most one ambiguity that blocks drafting. Label substantive additions as suggestions.
```

#### `member-studio` 的团队角色写法

改动前：

```text
- **Team role:** a clear, stable contribution such as research and evidence synthesis. It confers no rank or Default Lead status.
```

改动后：

```text
- **Team role:** one short statement of the member's stable contribution, used by teammates to identify relevant responsibilities. It confers no rank or Default Lead status. Do not derive it by automatically truncating responsibilities or rewrite existing roles without a request.
```

#### `member-studio` 的专业职责写法

改动前：

```text
- **Responsibilities:** 1-3 sentences covering the problem or object, recurring actions, and expected outcomes. Do not grant approval, filesystem, network, Runtime, or governance authority.
```

改动后：

```text
- **Responsibilities:** describe the problem or object, recurring actions, expected deliverables and responsibility boundaries at the detail the User needs. Preserve supplied long-form structure within the limit; do not pad the field to reach the limit. Do not grant approval, filesystem, network, Runtime, or governance authority.
```

技能文件仍在原有发现/读取路径生效，不把技能正文或队友职责复制到其他动态 section。

### 本人身份与完整容量

`MEMBER_IDENTITY` 的六字段 JSON、section 名称和上面的完整示例均保持；仅职责字符串的合法上限
从 300 扩为 10,000。完整已保存文本仍进入本人身份，不改为按需 get 或文件引用。
Bootstrap 顺序保持 `SESSION_CHARTER → MEMBER_IDENTITY → ROVAI_PLATFORM_SKILLS → MEMORY_ENTRYPOINT?`。

R2 沿用以下容量提案，确认后实现并以真实投递验收；这不是已验证的 Runtime 能力声明。

| 检查点 | 当前值 | 提案值/规则 |
| --- | --- | --- |
| 无显式 capability 的完整 Runtime payload 默认上限 | 96 KiB | 256 KiB（262,144 bytes） |
| 既有 FirstPayload preflight 的 Bootstrap 预留 | 32 KiB | 128 KiB 正文预算，加上实算分隔符/补发 wrapper；只计入实际同包投递的内容 |
| Command Code Bootstrap 正文，Rust/JS 两端 | 32 KiB | 128 KiB；相同字节口径 |
| Command Code 绑定 JSON 文件 | 64 KiB | 256 KiB；对实际外层序列化结果另行校验 |
| 显式 `maxContextPayloadBytes` | 覆盖默认值 | 保持既有显式配置；不能把提高默认值冒充底层真实限制已放宽 |
| 工具结果、IPC、其他 Adapter 限制 | 各自当前规则 | 完整链路核验，只调整实际阻碍 10,000 字符的局部限制 |

默认完整上限增加 160 KiB；既有 FirstPayload 预留后的动态预算从 64 KiB 增为约 128 KiB，
再扣除实际分隔符/补发 wrapper，仍高于原有 64 KiB。
这保证增加身份容量的同时保留原有业务输入余量，而不是用长职责挤占旧额度。
实际预算必须计入所有必需 section、完整消息、技能入口、Memory、分隔符与外层封装；批次 claim
与最终投递使用一致的容量口径。对实际同包投递的 Bootstrap/补发 overlay 预留足额空间，
不能让 claim 把 256 KiB 全部用作 RUN_INPUT，最终再追加 Bootstrap 导致失败。
FIFO、原子完整消息、可选项优先级保持；提高容量可能让一个新批次容纳更多完整消息，这是预期效果。

本轮做了以下离线序列化测算。输入均为 10,000 个 scalar，JSON 使用 UTF-8 非 ASCII 原样输出，
第一层是仅含职责字段的紧凑对象，第二层是 `{"bootstrap": 第一层字符串}`；数值不是整份 Bootstrap。

| 文本样例 | 正文 UTF-8 bytes | 第一层 JSON bytes | 第二层 JSON bytes |
| --- | ---: | ---: | ---: |
| `a` × 10,000 | 10,000 | 10,035 | 10,055 |
| `研` × 10,000 | 30,000 | 30,035 | 30,055 |
| `🌸` × 10,000 | 40,000 | 40,035 | 40,055 |
| `e` + U+0301，重复 5,000 次 | 15,000 | 15,035 | 15,055 |
| `a` + 9,998 个换行 + `z` | 10,000 | 20,033 | 30,051 |
| 双引号与反斜杠交替 | 10,000 | 20,035 | 40,055 |
| U+0000 × 10,000，覆盖现有字段未禁止的 JSON 转义 | 10,000 | 60,035 | 70,055 |

测算依据为 Python `json.dumps(..., ensure_ascii=False, separators=(',', ':'))`，用
`len(text)` 与 `len(serialized.encode('utf-8'))` 分别记录 scalar 与字节。
实施验收必须改用产品实际 Rust/JS formatter，包含其他身份字段、条件 Charter、技能、Memory、
绑定元数据和真实业务输入。若固定模板增长或实际允许文本突破提案值，应先更新容量对照与 revision；
不得通过截断、摘要、文件引用或丢弃必需 section 达标。256 KiB 也不是模型 Token 窗口的声明。

## 明确不变

| 边界 | 保持的规则 |
| --- | --- |
| peer 范围 | 排除 self；active 且非全局 removed；away 与 leave-requested 在正式 left 前仍按既有规则处理 |
| list 范围 | 当前 Thread；包括 self 与 away；排除 leave-requested、left 和全局 removed |
| 顺序与 Lead | 各入口原顺序和 Lead 派生不变，读取不自动指定 Lead；不统一两种筛选规则 |
| get/update 授权 | 当前 Thread 目标或调用者在同一 Thread 创建成员的既有例外；不新增字段级 ACL |
| 写入 | direct-user、明确要求/确认、版本冲突、原子性、幂等与现有错误恢复不变 |
| 自我身份 | 按既有 eligible Bootstrap 边界读取与投递，不随每次 Profile 编辑注入动态补丁 |
| 动态正文 | 除 peers 删除职责外，section 顺序、Task、RUN_FACTS、WORKSPACE、RUN_INPUT/CURRENT_INPUT、Skill/MCP 边界保持 |
| 管理失效通知 | 正常 Profile 更新仍可通知管理 UI 重读，与是否重发协作名单独立 |
| 身份字段 | 不新增 Instructions/能力摘要；其他五个字段的上限及可空语义保持 |
| Single Chat | 不扩大其工具 allowlist，不增加协作名单，保留专用 Charter；涉及完整本人身份时遵守同一容量规则 |

## 版本、历史与 resume

### 版本轴的拟议分配

以下编号以本文件的冻结基线为准，实施时若主线占用编号，只调整至未占用编号并记录差异。
不能把改变后的新生成结果继续标为旧结果版本，也不能在模型正文增加版本字段。

| 版本轴 | 变更前 | 拟议变化 |
| --- | --- | --- |
| Collaboration State 合同 | v3 | v4，peer 删除职责 |
| Agent Output | 10 | 11，封闭 member list 结果变化 |
| Built-in Transport / CLI / capability | 38 / 38 / `builtin_cli.transport.v38` | 39 / 39 / `builtin_cli.transport.v39`；Core/CLI 配套升级 |
| IPC / Envelope | 3 / 2 | 保持，不因业务结果字段删除重建运输框架 |
| 公共 batch Formatter / Manifest | 33 / 33 | 34 / 34，冻结三字段 peers 与新预算语义 |
| 非 batch Formatter / Manifest | 28 / 28 | 35 / 35，避免复用已有 29～33 的历史含义 |
| Delivery Profile | 公共 10，非 batch 7 | 公共 11，非 batch 12；只更新本次容量语义，保留各自字段形状与其他数值 |
| Bootstrap / Bootstrap formatter | v5 / 5 | 保持，六字段身份与 wrapper 结构未变 |
| Charter revision / Run Facts / 补发 envelope | 22 / 公共 9、非 batch 6 / 2 | 保持，不增加本次无关教学或字段 |
| Native Binding / 原生恢复资格 | 当前既有规则 | 保持，以上版本不接入恢复资格判断 |

新 Profile 的公共冻结 JSON 为 `{"profileVersion":11,"maxSelfActiveTasks":8}`；非 batch
保持原字段并改为 `profileVersion:12`，其 15 条历史、24,000 history chars、2,000 body chars、
3 条 reference chain、8 个 Task 的数值保持。预算上限仍由既有 Runtime capability/默认值入口拥有，
不新增第二套配置表或持久化预算系统。

### 切换规则

1. 新会话采用新初始化逻辑；升级后尚未冻结的新 Run 采用新投影，不以 Thread 创建时间分叉。
   老会话的后续动态名单和工具结果可自然采用当前格式，原生历史中已出现的旧字段保留。
2. 同一 Run/Binding/generation 已准备的 Bootstrap、Manifest、业务输入保持原字节。
   已领取但尚未完成 materialization 的旧格式输入继续由其原版本路径处理，不能用新 formatter
   覆盖其格式标记；不得用最新 Profile 重算并覆盖任何历史冻结输入。
3. 不扫描/重写历史 Context、身份、Binding 文件或协作摘要；不让读取、校验或修复旧 Bootstrap
   成为新 Run 续聊前提。老摘要与新投影自然比较，仍仅由 accepted ACK 推进。
4. 原生恢复继续使用当前 Conversation 的原 Session ID 与既有 Adapter 流程，不加兼容性拒绝、
   重置、强制新建或迁移提示；本次不改变现有恢复降级条件、unknown/accepted 防重或权限检查。
5. 同一产品包部署匹配的 Core 与 CLI。旧二进制/新 Core 的不匹配按既有运输版本机制在 dispatch
   前拒绝，不能让写入已执行后才发现结果校验失败；这不等于原生 Session 必须重建。
6. 当前数据库对 Context/Profile 版本有封闭约束，需要按已有迁移机制增加新版本准入。
   只扩展约束及新写入配对；历史行、旧版本准入、Blob 引用和业务数据保留，不做历史内容迁移。
   迁移编号使用实施时下一可用编号，不能复用或回退当前数据库版本。

已有 [v60 继承规则](../../contracts/runtime-launch-and-verification-v60.md)明确：上下文/Bootstrap
格式差异不参与恢复资格，历史 Bootstrap 仅供对应输入审计。不能恢复历史上的“格式变化即换 Session”。

## 涉及文件与实施顺序

本次文档交付只新增本说明及版本概览入口。确认实施后预计修改下列范围；最终以实际 diff 为准。

| 文件/范围 | 修改目的 |
| --- | --- |
| `crates/rovai-core/src/agent_profile.rs`、`member_studio.rs`、`member_tool.rs` | 专业职责共享规范化、独立上限、输入 Schema、窄 list 查询、封闭结果 |
| `apps/desktop/src/renderer/src/member-identity-draft.ts` 及既有创建/编辑/复制/导入消费点 | Unicode 校验、计数、错误和草稿保留；不改其他身份字段 |
| `crates/rovai-core/src/context.rs`、`context_delivery.rs`、`context_contract.rs`、`delivery_queue.rs` | peers 窄投影/摘要、完整字节预算、版本化新生成路径与旧冻结恢复 |
| `crates/rovai-core/src/command_code_acp.rs`、`command_code/bootstrap.mjs` | 同步 Bootstrap 与外层文件局部容量，保持绑定身份/不可变性检查 |
| `crates/rovai-core/src/team_tool_catalog.rs`、`bin/rovai.rs`、`builtin_tool_cli_output.rs`、`builtin_tool_transport.rs` | 统一帮助、新结果校验及匹配的协议版本 |
| `crates/rovai-core/src/builtin_tool_evidence_projection.rs`、`packages/contracts` 对应 DTO/fixtures/tests | 新投影证据与合同校验；历史 fixture 不改写成新格式 |
| 既有数据库版本约束迁移与对应恢复测试 | 增量准入新版本，旧冻结状态继续可读可恢复 |
| `skills/cli-operations/SKILL.md`、`skills/member-studio/references/identity-generation.md` | 上述完整替换文本与生成规则 |
| `docs/contracts`、`docs/architecture`、当前版本实施记录与必要版本决定 | 更新当前权威/路由，保存历史理由，记录真实验证范围 |

顺序：确认本 revision → 共享字段校验与窄结果 → 上下文/容量/历史兼容 → help/技能/合同同步
→ 自动化与真实投递验收 → 提交实际文件清单、协议差异和证据。不得先改当前合同再把提案视为已确认。

## 验证

### 自动化验收

| 检查 | 必须证明 |
| --- | --- |
| scalar 与 trim | 0、10,000 成功；10,001 失败；中文、补充平面、组合字符、内部换行和首尾空白跨前后端一致；额外首尾空白不会提前触发 raw Schema 上限 |
| 写入与失败 | UI 留草稿；创建/编辑/复制/导入、Agent CLI、用户管理入口一致；超限复合 patch 无部分写入/版本增加 |
| 封闭结果 | list item 恰好四字段，get 保留完整职责并符合原图片/版本语义；非法额外字段被结果校验拒绝 |
| 范围与权限 | self/away/leave-requested/left/removed、无 Lead、创建者例外、跨 Thread 拒绝；list 与 peers 差异保持 |
| 摘要与 ACK | 只改职责/人格等摘要不变；名称/角色/有效关系变动会变；未 accepted/unknown 不推进水位 |
| 本人身份 | 10,000 字符首中尾与完整字节一致；不进 peers，不重复进入动态 section；沿用资格边界 |
| 容量 | 全身份、条件段、最坏 JSON 转义、业务输入与外层封装合计校验；claim 与实际组包边界一致 |
| 恢复 | 旧 frozen 字节不变；旧待 materialize 输入维持版本路径；新 Run 采用新版本且继续相同原生 ID；历史 Bootstrap 缺失不新增续聊障碍 |
| 帮助与教学 | Catalog/list/get help、职责参数、技能文本符合本对照；没有默认逐个 get 全队、隐式扩权或旧 300 说明 |

优先扩展现有测试 owner；增加或退役 Rust 测试前执行
[测试准入规则](../../development/testing.md#rust-测试准入与退役门槛)。
拟复用命令包括 `pnpm docs:test`、`pnpm docs:check`、`DOCS_BASE_REF=<base> pnpm docs:check:ci`、
成员字段/CLI/Core owner 测试和 `node --test scripts/lib/command-code-bootstrap.test.mjs`。
实际测试名称、通过数与结果在实施记录补齐，不把本表当作已执行证据。

### 真实投递与上下文 Gate

依照[本地隔离流程](../../development/local-workflow.md)和[双轨评测](../../development/evaluation.md)，
使用独立测试目录/数据，禁止启动指向日常 Electron userData 的验收进程。

- 以已保存职责原文为基准记录长度和摘要，分别核对 `member get`、本人 Bootstrap、Adapter 实际入参
  和接受证据；随机首中尾标记用于确认模型可读到全文，单纯模型复述不能替代字节核对。
- 新会话、同原生 ID 的 warm/cold resume、Core 重启后续聊、原有合格 compaction 补发均覆盖；
  不为不具备补发资格的 Runtime 新造恢复机制。
- 按现有投递模式逐项记录，不用一个 Runtime 的通过外推其他 Runtime。当前映射为：

| 交付模式 | 必须逐项记录的 Runtime | 本轮状态 |
| --- | --- | --- |
| NativeAppend | Codex CLI、Claude Code、Grok Build | 全部未运行 |
| ManagedSystemPrompt | Pi、Deepseek Harness、Command Code、Cline | 全部未运行；后两者保持既有非公开准入状态 |
| FirstPayload | OpenCode、Copilot、Antigravity、ZCode、Kiro、Qoder、CodeBuddy、Qwen Code、TRAE、Cursor、Kimi | 全部未运行 |

真实模型 Gate 固定使用基线 Suite `context-regression@2.12.0` 的 DEMO-101～112，共 12 个 Case；
评分 rubric `generic-task-quality@2.10.0`，一轮重复，基线/候选相同 Runtime/模型/权限，至少三位成员。
计划总时限 14,400 秒、Case 并行度 2、Judge 2,400 秒，每个 campaign 最多两次，保留失败尝试。
Case 单项预算与密封材料沿用 suite，不为通过候选修改标准。
具体可用 CLI/模型/真实 Judge 的版本、配置、构建产物及预算由 `eval:gate freeze` 在首次运行前
冻结；本轮没有启动 Runtime、Judge 或付费模型任务。若没有可用完整配置，记录 `not_run`/证据不足。
通过要求为既有 Gate 完整通过、无关键回归与证据缺口；不拿规则测试通过代替语义 Judge 或真实投递。

### 本轮文档验证记录

已完成：干净主线基线核对、独立 worktree 创建、代码/合同/help 只读核对，以及上表离线字节测算。
产品代码和真实 Runtime 验证尚未执行。2026-10-13 的 R1 文档验证结果：

| 命令/检查 | 结果 |
| --- | --- |
| `pnpm docs:test` | 10/10 通过 |
| `pnpm docs:check:decisions` | 通过，全仓文档链接及决定治理检查完成 |
| `DOCS_BASE_REF=39bf1eb09a208ea9abd98b737d6ed7c669ed7cbf node scripts/check-doc-decisions.mjs --require-base` | 通过，独立完成相对基线的历史冻结与治理检查 |
| `pnpm docs:check` | 按预期阻断，仅本 R1 缺少用户二次确认的四项记录 |
| `DOCS_BASE_REF=39bf1eb09a208ea9abd98b737d6ed7c669ed7cbf pnpm docs:check:ci` | 同样在版本确认检查处阻断；不宣称完整 CI 通过 |
| `git diff --check` | 通过 |

四项记录分别为 `confirmed_revision`、`confirmation_status: confirmed`、`confirmed_by` 和
`confirmed_at`。尚未发生的用户确认不能补填；门禁没有被豁免或修改。

R2 同日复核：`pnpm docs:test` 仍为 10/10 通过；相对上述 base 的
`check-doc-decisions.mjs --require-base` 通过，含链接与历史冻结检查；4 个 JSON 示例可解析，
8 处 help/技能均有紧邻的完整前后文本，目标 help 无 `verified by Core`。
`pnpm docs:check` 和 `pnpm docs:check:ci` 仍只因 R2 未确认的上述四项记录阻断。
`git diff --check` 通过，改动仍仅为本说明和版本概览入口。

## 二次确认

R2 尚未获得用户阅读本文件后的实施确认；`confirmation_status: pending`。
Thread `rvcamp_01m4r7rvjff0svehpr9s78zc16` 中用户已确定需求、resume 边界与提高完整上限，
消息 `c3403579-8f3c-40d6-b705-ccae198fea70` 要求“开启 wt”并先提供上下文、CLI、CLI-help 前后方案。
该消息授权创建本 worktree 与本方案。随后消息 `c10f4185-c894-4eed-a50c-acc41901fc94`
要求精简 help、解释 `default`、把技能前后文案放在一起；本 R2 记录这些修订，不把审阅意见
记为实施确认。R1 原文保留在 Git 提交 `158b333001ba13ed313d9b5f431a69142ef9e50c`。

按[上下文变更治理](../../development/model-context-change-governance.md)：
“未取得确认时可以继续调查和编辑提案文档，但不得修改实现、Schema、当前合同或执行 clean break。”
因此本轮交付停在可审阅方案。阅读后若明确同意实施 R2，再记录真实的确认人、时间、消息和相等的
`confirmed_revision`；语义改变则递增 revision。文档版本门禁在 pending 状态下应保持阻断，不能
伪造确认字段或为此增加 checker 例外。

## Worktree 交接

```text
Work item: 成员路由精简、专业职责扩容与模型上下文/CLI/help 前后方案
Worktree: /Users/murray.xue/VSCodeProjects/opensource/rovai-ai-member-routing-context
Branch: rovai/member-routing-context
Base: origin/main @ 39bf1eb09a208ea9abd98b737d6ed7c669ed7cbf
Governance: none（本 R2 为提案，尚未确认或合入）
Status: ready（方案待审，保留该 worktree 供后续复用）
Validation: 见本文件“本轮文档验证记录”
Next: 审阅 R2；确认后按同一工作区继续实施
```
