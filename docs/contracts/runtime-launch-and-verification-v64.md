---
document_type: contract
name: Runtime Launch and Verification
version: v64
status: accepted
source_version: v1.72
last_updated: 2026-10-15
---

# Runtime Launch and Verification v64

继承 [v63](runtime-launch-and-verification-v63.md) 的启动、恢复、输入保护和进程边界。
本版替换继承自 [v41](runtime-launch-and-verification-v41.md#返回值与诚实展示) 的正式页面版本取值规则；
草稿检查、失败反馈、检查结果的代次围栏与执行准入保持。

## 已知版本的保存与展示

`reportedVersion` 仍为可空字符串，沿用现有快照字段，不新增版本缓存、数据库迁移或轮询。
版本是程序信息，不证明认证、能力、模型目录或本次完整检查成功。

- 正式发现已找到程序时，优先展示该程序本次实际读到的非空版本。
- 本次未读取版本、读取失败或返回空值时，可以复用同一 Installation 的已知版本，但当前发现路径必须
  与 Installation 路径一致，且当前非空 executable fingerprint 必须与保存版本的快照一致。
- 搜索环境代次只隔离检查写回，不单独决定版本展示。检查其他 Runtime 推进代次，不得让版本消失或
  重新显示已经属于另一份程序的历史版本。
- 未找到程序、路径不一致、fingerprint 缺失或变化时，不回退旧版本。尚未完成入口发现时保持未知。
- 快照更新没有带来新版本时，仅在同一 Installation、非空且相同的 executable fingerprint 下保留
  原版本；真正替换程序后不得把旧版本写成新程序的版本。新的非空版本正常替换旧值。
- 健康快照过期或检查失败与程序版本分开判断；身份仍匹配时可显示已知版本，失败原因和本次检查结果
  继续如实返回，不把保留版本包装为本次检查成功。

设置目录和队员配置统一消费 Core 的 `runtimeAvailability.reportedVersion`。Renderer 不再自行从
Installation 快照补齐版本，避免两个页面对同一程序显示不同结果，或重新显示 Core 已排除的旧版本。
高级诊断可以保留原始历史快照。

## 检查与执行边界

启动和 rescan 继续只做既有静态入口发现，不为显示版本运行批量 `--version` 或完整健康检查。
页面打开和普通执行不增加健康探测；已有实际启动需要的有界版本读取保持原语义。
版本未知或读取失败不单独阻止配置、创建 Run 或普通执行，必要的协议、权限和显式模型验证仍由真实 Host 完成。
用户主动检查继续沿用有界 Check Manager、身份复核、失败说明和进程清理。
