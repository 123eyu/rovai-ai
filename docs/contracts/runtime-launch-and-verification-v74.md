---
document_type: contract
name: Runtime Launch and Verification
version: v74
status: accepted
source_version: v1.72
last_updated: 2026-10-29
---

# Runtime Launch and Verification v74

继承 [v73](runtime-launch-and-verification-v73.md)。本版统一全部 Adapter 的模型目录兼容与执行边界，
替代历史合同中依据模型目录拒绝显式配置、要求 Ready 必须有目录默认项、以及自动过滤覆盖值的规则。

## 目录归一化

共享 Adapter 层按原生模型 ID 合并重复条目，保留原生 ID、显示名称、描述、元数据及可用选项。
同一参数合并去重选项；原生 current/default 值可补充枚举。空 ID、无效单条模型、参数或枚举只在该条
处理，不使其余有效目录失败。兼容处理适用于 ACP、Codex、Claude、Pi 和 Antigravity，不为 Copilot
的重复 `auto` 建立特殊分支。内部 Runtime Default sentinel 不作为可选原生模型。
单条模型的非对象元数据局部忽略，保留模型；重复条目的有效元数据仍参与合并，Adapter 补充字段不整体替换
已有有效元数据。

完整响应无法读取、没有可用目录或查询失败时，不推进目录成功时间，不清空已有有效目录、模型或参数。
沿用现有缓存身份与失效规则；同一身份下的健康检查即使没有目录也不覆盖有效目录。读取目录的成功
与原生 Session 可用分别判断，不凭目录缺少默认项或当前模型否定可用 Session。

## 明确配置由原生 Runtime 接受

模型目录只用于发现和选择，不是保存或执行的准入表。显式模型 ID 与已设置参数按原生协议传递；
不以目录缺失、未枚举 ID／参数／值或 setter 未回显目录阻断执行。不从目录补入默认值，也不按目录
删除用户覆盖值。Runtime Default 仍省略显式模型参数，内部 sentinel 不发送给原生 Runtime。

Adapter 保留原生协议必要的数据映射、真实 RPC/进程错误及原生执行结果；原生拒绝的配置不静默改为
其他模型或参数。无法映射到原生请求的参数键或类型在发送输入前明确报错并指出字段，不静默丢弃。
Codex 将字符串 `reasoning_effort` 原样映射到 `effort`，不按目录枚举限制其值。
不同来源的模型按用户选定来源处理。健康或目录检查不增加模型调用、用户审批或
额外执行流程；单个 Provider／模型的目录补充异常只影响其自身信息。沿用既有错误记录，不新增日志。

## 用户界面

读取失败明确显示“尚未核对”，保留当前模型、参数及有效缓存；不把缺少目录证据显示为“不支持”或
“当前目录未提供”。保存的未枚举参数可更改或清除。同一 Runtime 内切换显式模型时保留显式覆盖值，
切换到 Runtime Default 则按用户选择清除覆盖值。异步目录更新只更新候选项，不改写草稿或已存配置。
