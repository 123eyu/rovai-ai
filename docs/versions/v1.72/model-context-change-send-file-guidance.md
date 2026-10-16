---
document_type: model-context-change
version: v1.72
change_id: send-file-guidance
revision: 1
confirmation_status: pending
implementation_status: proposed
source_commit: 3979e32ec4834ce5fc02cd72309bbd7b5cd800c6
last_updated: 2026-10-16
---

# Send 文件引用、临时正文清理与渠道提示：R1

本稿供 User 审阅精确上下文差异，尚未修改产品提示词、实现或当前合同。
需求来自 Thread `rvcamp_01m51tzyg3emhrkdf78r95pzgt` 消息 5
（`2321c468-93a1-45c8-86eb-9c470dcf6536`）。

## 选择与冲突处理

- 临时正文清理只作用于 Agent 自己创建、用途仅为消息输入的临时文件，并以发送成功为前提。
- 普通文件引用默认使用显式 Markdown 链接；用户要求附件，或外部渠道需要交付文件本身时使用 `--file`。
- ZIP 等归档仅在用户要求或实际交付需要时生成。保留后一条件，因为当前钉钉适配器对普通文件有格式白名单。
- 飞书、Lark、钉钉共用已有渠道提示正文，只扩展注入条件；不增加渠道名称列表或客户端类型字段给模型。
- 操作细节集中到 `send --help`；删除 Send reference 的重复 Files 段，沿用其第一行已有的 exact-help 入口。

“文件引用”和“文件交付”的适用条件在同一句中给出，不依赖两条互相覆盖的绝对指令。
即使用户从 Desktop/WebUI 打开已绑定渠道的 Thread，交付文件本身仍按渠道规则使用 `--file`。
`send` 成功只证明消息提交，不证明渠道已完成后续上传；附件源文件必须继续保留。

| 场景 | 预期行为 |
| --- | --- |
| Desktop/WebUI/MobileUI 指向已有代码、报告或生成文件 | Markdown 文件链接；文件继续保留 |
| 用户明确要求附件 | `--file`，允许同时在正文解释文件 |
| 任一已绑定渠道的收件人需要文件本身 | `--file`；仅贴本地链接不能完成交付 |
| 渠道中的普通进度说明或代码路径引用 | 普通正文；不会因“有渠道”就自动附加文件 |
| 用户要求归档，或渠道格式等实际交付约束需要归档 | 生成归档再交付；不会为普通文件引用默认生成 ZIP |
| 自建临时正文发送成功 | 删除仅用于消息输入的临时文件 |
| 发送失败、结果不明、现有文档、已链接或已附加的文件 | 不因本清理规则删除；继续按现有恢复和文件生命周期处理 |

## 上下文入口

| 入口 | 本稿变化 |
| --- | --- |
| `camp_message_send_teaching.rs` 的 BODY_HELP | 保留现有两句，追加一句成功后清理 |
| 同文件 FILE_HELP | 合并文件选择、按需归档与现有原路径引用语义 |
| 同文件第一个 HELP_EXAMPLE | 明确临时正文，将反引号路径改成 Markdown 链接 |
| `cli-operations/references/send.md` | 删除末尾 Files 段；其余全文不变 |
| `context.rs` 的渠道 Charter 后缀 | 正文逐字不变，active binding 准入从飞书扩到三个现有 provider |
| 公共 Charter 主文、Single Chat、Mission 后缀、其他 Skill、Runtime 专属指导 | 不变 |

## 变更前

下列块分别是受影响的完整正文帮助、附件帮助、首个示例、Send reference 删除段和渠道后缀。
源码位置见 [Send teaching](../../../crates/rovai-core/src/camp_message_send_teaching.rs)、
[Send reference](../../../skills/cli-operations/references/send.md)、
[Context](../../../crates/rovai-core/src/context.rs)。

### 正文帮助

```text
Use --body for simple single-line text; \n remains literal.
For multiline, Markdown, or complex text, use a file-write tool to write the reply text itself, with real newlines, to a UTF-8 file.
```

### 附件帮助

```text
Attach a recipient-facing file or directory at its actual path; repeat to preserve attachment order. Rovai references the current file without copying or changing permissions. Temporary files may become unavailable when their source is cleaned up.
```

### 首个普通发送示例

```text
Write reply.md:
  Result:

  Updated `src/example.rs`.
After the write succeeds:
  rovai send --public-only --input-file reply.md
```

### Send reference 末尾重复段

```markdown
## Files

Use `--file <path>` to publish a file or directory with the message; repeat it to preserve attachment order. No separate upload is required. At least one file can form a message without a body.
```

### 渠道 Charter 后缀及条件

新公共 Session Bootstrap：Camp 存在 `status = 'active'` 且 `provider = 'feishu'` 的绑定时，
在现有 CLI Charter 后、可选 Mission 后缀前追加以下一条；其他 provider、closed 或未绑定不追加。
Single Chat 仍使用专用 Charter，不追加。

```text
- This Thread is connected to an external channel. Local file paths and Runtime image previews are not delivered there; when the recipient needs the file itself, include `--file <path>` in the corresponding `rovai send` message.
```

## 变更后

### 正文帮助

```text
Use --body for simple single-line text; \n remains literal.
For multiline, Markdown, or complex text, use a file-write tool to write the reply text itself, with real newlines, to a UTF-8 file.
After a successful send, delete files you created solely as temporary message input.
```

`solely as temporary message input` 排除正文引用目标、附件、用户已有文档以及同时承担其他用途的文件。
这是 Agent 清理教学，不给 CLI 增加自动删除行为、目录限制或新选项。

### 附件帮助

```text
Prefer Markdown links for file references; use --file for requested attachments or external-channel file delivery. Archive only when requested or required for delivery. Attach files or directories at their actual paths; repeat to preserve order. Rovai references them without copying or changing permissions; keep source files available.
```

第一句同时给出默认方式和附件适用条件。最后一句保留现有原路径引用语义，并明确源文件需要保留；
与只清理临时正文的规则一致。路径可访问、预览类型、相对路径基准仍由现有文件预览实现决定。

### 首个普通发送示例

```text
Write a temporary reply.md:
  Result:

  Updated [src/example.rs](src/example.rs).
After the write succeeds:
  rovai send --public-only --input-file reply.md
```

仍保留“写入成功后再发送”，清理规则只在正文帮助中说明一次。其余两个示例逐字不变：

```text
rovai send --to agent_5 --body 'Please reproduce on the previous client build and return the version and result.'
rovai send --public-only --to-user --body 'Please choose whether to roll back the client or continue the token investigation.'
```

### Send reference

仅删除变更前的整个 `## Files` 段，不新增替代段。文件止于现有句子：

```text
A successful Send proves publication and its frozen effects, not that a recipient has started or finished.
```

第一行原有 `Read rovai send --help for current inputs.` 的 Markdown 写法及其他正文逐字不变。
纯附件消息仍受原 Schema 和 Core 支持；本稿只移除重复操作教学。

### 渠道 Charter 后缀及条件

新公共 Session Bootstrap：Camp 存在 `status = 'active'` 且 provider 属于
`feishu | lark | dingtalk` 的绑定时，在原位置追加同一条。Single Chat、closed、未绑定和未知 provider 不追加。
Quick Chat/项目会话共用 Camp 级判断，不根据当前使用 Desktop、WebUI 或 MobileUI 分支。

```text
- This Thread is connected to an external channel. Local file paths and Runtime image previews are not delivered there; when the recipient needs the file itself, include `--file <path>` in the corresponding `rovai send` message.
```

| 新 Bootstrap 来源 | 变更前 | 变更后 |
| --- | --- | --- |
| active 飞书绑定 | 追加一条 | 追加同一条 |
| active Lark 绑定 | 不追加 | 追加同一条 |
| active 钉钉绑定 | 不追加 | 追加同一条 |
| closed/无绑定/未知 provider | 不追加 | 不追加 |
| Single Chat | 不追加 | 不追加 |

三个渠道的追加正文完全一致；Lark/钉钉的文件外发能力本来就存在，本稿不修改外发协议。

## 明确不变

- 不增加 `RUN_INPUT`、`RUN_FACTS` 或其他动态字段；不把渠道来源推断交给模型。
- `SESSION_CHARTER` 公共主文、身份、Memory、平台 Skill 索引、Single Chat 和 Mission 后缀不改。
- `--body`、`--input-file` 的正文/合法旧 JSON 请求兼容、32 KiB 正文限制、输入来源和真实换行语义不改。
- `--file` 仍是原路径引用，文件/目录、顺序、权限、生命周期和外部渠道 Outbox/重试规则不改。
- `--public-only`、`--to`、`--to-user`、Task、消息事务、发送回执和幂等/不确定结果处理不改。
- Bootstrap 冻结与恢复、动态 section 顺序、消息选择、预算、既有证据身份和 Native Binding 兼容轴不改。
- 不新增 TMP 目录硬约束、归档工具、自动压缩、正文扫描自动附件或 CLI 自动删文件。

## 版本轴、合同与兼容

| 项目 | R1 计划 |
| --- | --- |
| 当前产品版本 | 沿用版本索引的 v1.72 |
| Session Charter revision | 22 → 23，记录渠道后缀准入扩展 |
| Bootstrap contract / formatter | v5 / 5 不变 |
| Native Binding compatibility | 保持现有 4 / 4 / 16 / 26 / 26；不强制轮换会话 |
| public Context formatter / manifest / profile / facts | 39 / 39 / 14 / 10 不变 |
| non-batch Context formatter / manifest / profile / facts | 37 / 37 / 12 / 6 不变 |
| Transport / CLI / Agent Output / IPC / Envelope | 41 / 41 / 14 / 3 / 2 不变；本次 help 常量不参与输入/输出 Schema |
| 当前规范同步 | 实施时以 Send v27 为基线承接新教学，更新 Built-in Tool Runtime 的注入条件与 Lark 当前合同第 7 节；版本号按实施基线核对，不能继续保留“Lark 不注入”作为当前规范 |
| 数据迁移 | 无；历史消息、Manifest、Bootstrap Blob 和 receipt 不重写 |

新 Bootstrap 使用本稿条件，旧 Binding 继续使用自己的冻结 Charter。旧 Lark/钉钉 Session 不会立即获得新后缀；
下一次正常创建 Binding 时生效，不以本次教学调整中断正在运行的会话。CLI help 和 managed Skill 在后续读取时更新；
不承诺模型主动重读已缓存帮助。回滚恢复相应 help/Skill/条件与版本，已进入原生历史的教学不能撤销。

## 验证

本轮只验证提案文本与当前源码对应关系、文件链接和文档结构，不启动 App、Core 或真实 Runtime。

实施后复用现有测试 owner，优先扩展已有矩阵；新增/删除 Rust 测试前遵循
[测试准入规则](../../development/testing.md#rust-测试准入与退役门槛)：

1. Send help：完整文本、临时正文提示、Markdown 首例、另外两个寻址示例保持；
   命令检查使用 `cargo test -p rovai-core --lib camp_message_send_teaching::tests::` 与
   `cargo test -p rovai-core --bin rovai`。
2. CLI 文件输入：使用 `pnpm test:send-input-file` 确认正文保真及 CLI 不删除输入，避免把 Agent 教学实现成破坏性 CLI 行为。
3. Context：扩展现有 provider × Quick Chat/项目 × active/closed 矩阵；三 provider active 各追加一次，
   inactive/无绑定/未知 provider/Single Chat 不追加。既有 Bootstrap 不因绑定创建、关闭或实现升级被重写。
4. 文案与选择：检查普通引用无需附件/ZIP、请求附件与渠道文件交付仍可用；临时输入清理不能删除交付目标，失败与未知结果不能视为成功。
5. 文档/Skill：`pnpm docs:test`、`pnpm docs:check`、`DOCS_BASE_REF=<实际 base SHA> pnpm docs:check:ci`、`pnpm skills:check`。

本稿同时改变共享 help、`cli-operations` reference 与 Bootstrap 选择，实施后按
[上下文改动 Gate](../../development/evaluation.md#上下文改动-gate)使用通用集：
基线为本稿 source commit，Suite `context-regression@2.12.0` 的 DEMO-101 至 DEMO-112 全部 12 Case，
baseline/candidate 各一次 repetition，使用相同明确冻结的既有 Runtime、模型、权限和 Judge 配置。
计划预算为每 campaign 14,400 秒、Judge 2,400 秒、并行 Case 最多 2、同一 campaign 尝试最多 2 次。
实际模型/Judge 与完整 plan 在执行前冻结；本次文本审阅不启动该评测。
通过条件沿用同一 Suite 的硬性规则、关键协作项及语义 Judge 门槛，未知保持未知，不以模拟、缺失 Case 或 `judge: null` 声称完整通过。
通用集不替代以上渠道矩阵与本次文件选择边界；真实外部平台交付也不能由 Context fixture 冒充。

## 二次确认

状态：待 User 审阅并明确确认 R1。消息 5 要求前后对照，不是对本稿完整文本的二次确认。
确认前只保存本提案，不修改实现、Schema、当前合同或执行 clean break。
依据是[核心模型上下文变更治理](../../development/model-context-change-governance.md)中的：
“未取得确认时可以继续调查和编辑提案文档，但不得修改实现、Schema、当前合同或执行 clean break。”

确认后填写真实 `confirmed_by`、`confirmed_at`、`confirmed_revision: 1` 与来源消息；语义变化则递增 revision。
未确认提案触发文档门禁的 confirmation 检查属于预期状态，不伪造确认或为本次变更加 checker 例外。

## 工作记录

- Work item：Send 文件教学及三渠道 Charter 的 R1 前后对照。
- Worktree：`/Users/murray.xue/VSCodeProjects/opensource/rovai-ai-send-file-guidance`。
- Branch：`rovai/send-file-guidance`。
- Base：`origin/main@3979e32ec4834ce5fc02cd72309bbd7b5cd800c6`；已 fetch 并核对与本次审阅源码一致。
- Governance：本稿待确认；无已合入治理提交。
- Status：active，等待文本审阅；后续沿用此 worktree。
- Validation：正文/附件帮助、首例、删除段及渠道原文逐字匹配源码；`git diff --cached --check` 通过。
  `node --test scripts/lib/doc-decisions.test.mjs` 10/10 通过；带真实 base 的
  `node scripts/check-doc-decisions.mjs --require-base` 通过。
  `pnpm docs:check` 与 `pnpm docs:check:ci` 均只因本稿缺少四项二次确认记录而未通过，符合待审阅状态。
  初次并行 `pnpm` 调用触发依赖自动安装，其中 `docs:test` 启动因安装竞争失败；已用上述相同 Node 测试入口完成验证。
  不宣称产品实现或模型行为已通过。
- Next：按 User 对 R1 的反馈修订或记录明确确认，再进入已确认范围的实施。
