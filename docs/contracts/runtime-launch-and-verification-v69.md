---
document_type: contract
name: Runtime Launch and Verification
version: v69
status: accepted
source_version: v1.72
last_updated: 2026-10-21
---

# Runtime Launch and Verification v69

继承 [v68](runtime-launch-and-verification-v68.md)。本版为 Rovai 托管的 Claude Code、CodeBuddy
固定原生后台执行策略。前台命令、前台原生子 Agent 和平台同伴协作继续可用。

## 固定启动策略

| Runtime | 环境变量 | 值 |
| --- | --- | --- |
| Claude Code | `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` | `1` |
| CodeBuddy | `CODEBUDDY_CODE_DISABLE_BACKGROUND_TASKS` | `1` |
| CodeBuddy | `CODEBUDDY_BASH_AUTO_BACKGROUND_DISABLED` | `1` |
| CodeBuddy | `CODEBUDDY_BASH_ASSISTANT_BUDGET_MS` | `0` |

这些值在 Runtime／成员环境和设置合并后写入私有 settings，并再次固定在最终子进程环境。
Windows 同名键按大小写不敏感语义处理；用户原生配置文件和 Core 进程环境不改写。
关闭显式后台执行，以及已确认的超时、响应预算自动转后台入口；不宣称所有原生内部中断路径均已证明不可转后台。
长命令仍遵循原生前台超时，失败／超时结果由当前任务处理，不自动重复业务操作。

## CodeBuddy 设置优先级

CodeBuddy 2.133.1 的默认来源为 user、project、local；较高层定义的 `env` 整体替换低层对象。
Rovai 先按实际子进程 HOME／CODEBUDDY_CONFIG_DIR 与 workspace 读取原本胜出的 env，再覆盖三个策略键。
高层不含 env 时继续使用下层；空对象与 null 清除下层 env，不能把低层被覆盖的键补回来。
原生设置支持 JSON/JSONC；无法可靠读取／解析时在启动前报告不含配置值的错误，不用空对象吞掉未知有效配置。

额外 `--settings` 私有文件只包含最终 env，其余模型、权限、Hooks、MCP 等原生配置继续由 CLI 按原优先级处理。
路径进入 argv，环境值不进入 argv 或公开诊断。文件由现有 ACP Host 私有目录生命周期拥有；确定未进入 spawn 的准备失败或 Host
确认退出后沿现有流程清理。可能存在进程时保留资源，沿用现有回收边界。外部 MCP 的提前返回不跳过该策略。

## Host 与 Session

CodeBuddy 的 Host compatibility 添加 `nativeBackgroundPolicy=disabled-v1`。未加载策略的旧 Host
不再符合后续获取的复用条件，已经接受的输入不因本次策略被强行重放或中断。
标记不进入 Native Session binding／session compatibility，原生会话历史沿既有恢复机制保留。
Claude 每次 one-shot 新建进程时应用同一策略。

## 完成规则

Claude Code、CodeBuddy 的普通会话与 Single Chat 在用户指令／授权规则之后加入同一条：

> Do not background required finite commands or native subagents. If a tool backgrounds them, collect results and complete authorized follow-up before your final response. Do not assume background completion will resume your work.

此规则只约束任务所需的有限命令与原生子 Agent。Rovai 同伴等待、授权、当前输入、进度说明和 Single Chat
私有输出规则继续有效。其他 Runtime 的章程保持原字节；不建立后台完成自动唤醒机制。
本条替代 [Single Chat v9](single-chat-v9.md) 中对这两个 Runtime 的“专用 Charter 保持原字节”限制，
其余 Single Chat 输入、权限和历史边界不变。

验证与已确认的完整前后对照见 [v1.72 实施记录](../versions/v1.72/model-context-change-native-background-policy.md)。
