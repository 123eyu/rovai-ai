---
document_type: implementation-record
version: v1.72
lifecycle: current
authority: implementation-evidence
last_updated: 2026-10-23
---

# 地平线、经典红与余烬实施

User 最初在主题设计 Thread sequence 18 确认使用独立 worktree 实施第六版配色与六项紧凑选择器，
并明确不加入生产没有的功能、输入框聚焦装饰或原型专属行为。

## Scope and decisions

- 新增地平线（暖瓷白/浅米灰）、经典红（白/朱砂红）与余烬（石墨黑/正红），原有 system/day/night 保留。
- `ThemeId` 表示具体配色，`ResolvedTheme` 保留 day/night 明暗模式；没有新增持久化字段或 Core 事件。
- Desktop 继续使用 Main 的原子 schema-v2 偏好存储和 snapshot；Web 使用既有 Host/Owner 本地偏好。
- 消息、Composer、焦点、页面与 Dialog 沿用生产组件。仅主题选择器缩小卡片尺寸并按容器宽度排列。
- 新增动作文字 Token，避免暗色主题把按钮红底直接当作导航文字；原有日夜数值不变。
- 更新当前 UI/theme 文档；不改变模型上下文、数据库 schema、发布版本或 Runtime 能力。无需新 Version Decision。

当前规则由[主题注册](../../ui/themes/README.md)、[设计系统](../../../DESIGN.md)及
[设置 brief](../../../apps/desktop/.impeccable/surfaces/settings-workspace.md)拥有。

## Validation

- `pnpm typecheck`：通过。
- `pnpm exec vitest run`：252 个文件通过；2884 项通过、2 项既有跳过。
- `pnpm build:desktop`：Web、execution-web、Electron Main/preload/Renderer 构建通过。
- 新增持久化恢复、固定配色与 OS 模式独立、切回 system、主题标题与完整 Token/对比度回归。
- `theme-tokens.test.ts` 最终对比度复验：41 项通过。
- `pnpm docs:test`、`pnpm docs:check`、以本 worktree base 为 `DOCS_BASE_REF` 的 `pnpm docs:check:ci`：通过。
- 生产 `ThreadWorkspace` / `AppearanceSettings` 隔离浏览器验收：六项切换、明暗模式、当前主题名称与原生方向键选择通过；返回会话后草稿保留。
- 三款新主题的用户/队员消息均为生产气泡与同色边线；Composer 聚焦前后边框和阴影一致，没有原型专属聚焦变化。
- 1512×769 常规窗口、1040×700 小窗口与 720×700 窄容器分别显示六/三/两列，无横向溢出；浏览器无 warning/error。
- 已保存三款新主题的会话截图、六项选择器常规/小窗口截图。临时 viewport 已恢复；预览仅用于验证生产组件。

完整 Windows/macOS 原生 UI、系统明暗切换、IME 与辅助技术矩阵未在本次浏览器 fixture 中实测；
隔离 fixture 不启动 Core 或 Runtime，也不读写日常 App 数据。构建与单元测试不替代原生平台实测。

## 地平线减暖修订（Thread sequence 20）

User 指出实现稿的暖色面积过大、执行台比原稿更暖，要求重新调整。配色以低饱和石灰和轻暖白为主，
执行台、输入与浮层收回中性白，代码和证据收回近中性灰；六项选择器与生产交互继续沿用。

| 表面 | 上版 | 本次修订 |
|---|---|---|
| 会话阅读区 | `#fcfaf5` | `#fdfcf9` |
| 侧栏 | `#f0ece3` | `#f3f1ec` |
| 消息气泡 | `#f0ebe2` | `#f0efeb` |
| 执行台 | 会话底色 `#fcfaf5` | 独立 `--execution-surface: #ffffff` |
| 代码块 | `#faf7f0` | `#f5f6f5` |

执行台的外壳、卡片、头像状态背板与滚动渐隐共用新语义 Token，覆盖浮层、底部与右侧位置。
其余四套配色的既有 Token 值与实际执行台底色保持不变；手机执行台仍由既有 `--mobile-page` 覆盖。

- 主题对比度、偏好与执行台布局回归：3 个文件、78 项通过。
- `pnpm typecheck` 与 `pnpm build:desktop`：通过。
- 生产组件浏览器预览：执行台三种位置的背景均为中性白，命令结果为中性灰；无横向溢出。
- 截图覆盖浮层、底部与右侧，并保留上版浮层截图用于比较。
- 通用文档测试、版本/决策门禁与以本次修订前提交为 base 的 CI 门禁通过；独立 HTML 默认进入地平线，浏览器无 warning/error。

## 地平线原版配色恢复（Thread sequence 24–25）

User 指出原版的对比色更合适，并在 sequence 25 提供 `rovai-theme-refined-v3.html`，
明确指向该稿「看原版」状态。该状态由 `baselineOptions.horizon.tokens` 拥有，
不能仅把精修版的灰绿强调色替换为蓝灰后称为原版。

本次恢复该参照的 89 个配色角色，包括暖瓷白阅读区 `#fcfbf7`、浅岩灰侧栏 `#eae7e1`、
消息气泡 `#eeeae2`、Steel 蓝灰 `#4e6c7e` 与正文 `#252a2d`；
生产新增的动作文字角色与原稿动作色一致。执行台继续使用 `--execution-surface: #ffffff`，
保留先前针对执行台泛暖的修正。选择器缩略图与完整主题合同同步更新。
其余主题、六项紧凑选择器布局、消息几何与聚焦行为均不变。

- `theme-tokens.test.ts`：41 项通过，覆盖完整 Token 与对比度。
- 生产组件 fixture 构建通过；浏览器确认默认地平线、六项选择器与白色执行台，无横向溢出及 warning/error。
- 保存独立 HTML、会话与外观设置截图；预览仅使用固定数据，不接入 Host 或 Runtime。

## 队员浮层与合入验收（Thread sequence 27–28）

User 在 Thread sequence 27–28 确认其余效果并要求 PR 合入 main，同时指出「队员」浮层底色不符。
地平线的 `--inspector-surface` 收敛为 `#ffffff`，使浮层外壳、置顶摘要与队员列表使用同一中性白；
不改变队员管理交互或其余配色。首帧原生窗口背景同步地平线当前画布色；主线新增的引用功能与翻译已合并保留。

- 同步 `origin/main` 后的 `pnpm typecheck`、`pnpm build:desktop`、`pnpm test`、`pnpm test:rust:pr` 通过。
- Vitest：252 个文件、2886 项通过，2 项既有跳过；完整 Node 门禁通过。
- 首轮完整 Node 门禁中钉钉文件投递用例等待超时；该文件独立复验 73 项通过，随后完整门禁再次通过，没有改动该用例。
- 浏览器实测队员浮层和置顶摘要均为 `rgb(255, 255, 255)`，四位队员完整显示，无横向溢出；截图随 Thread 交付。
- 通用文档测试、版本/决策门禁以及以最新 main 为 base 的 CI 文档门禁通过。

## 地平线恢复 v7（Thread sequence 30）

User 在 sequence 30 选择恢复 v7。此前三款主题与队员浮层修订已通过
[PR #879](https://github.com/murray17/rovai-ai/pull/879) 合入 main。
本次从该主线创建独立 worktree，将地平线完整配色恢复到 v7 对应提交
`87b9245486aeb1b6031c2475c8726b4438cbbb17`，同步选择器缩略图、原生首帧画布色与主题合同。
阅读区恢复 `#fdfcf9`、侧栏 `#f3f1ec`、气泡 `#f0efeb`、灰绿强调色 `#586e67`；
执行台与队员浮层均继续为 `#ffffff`。其余主题、六项选择器、生产交互与消息几何没有改动。

- 地平线 187 个 Token 与 v7 提交完全一致，主题合同逐项匹配；共享 CSS 的其余部分无变化。
- `pnpm typecheck`、`pnpm test`、`pnpm build:desktop` 通过；Vitest 252 个文件、2886 项通过，2 项既有跳过。
- `pnpm test:rust:pr`：475 项通过，1 项既有忽略。
- `pnpm docs:test`、`pnpm docs:check` 与以本次 main 基线为 `DOCS_BASE_REF` 的 `pnpm docs:check:ci` 通过。
- 生产组件浏览器预览确认地平线色值、六项主题选择器、白色队员浮层及执行台；无横向溢出或 warning/error。
- 保存会话队员浮层、执行台和外观设置截图；隔离 fixture 不接入 Host/Core/Runtime，不改动日常 App 数据。

## 经典红 A「轻红侧栏」（Thread sequence 32–40）

User 要求经典红通过区域配色呈现，避免红色导航文字、改色 Logo 和鲜红选中块，
并在 sequence 40 选择 A「轻红侧栏」。本次使用该稿的 56 项配色赋值，其中 44 项改变既有值：
侧栏 `#f8f5f6`、选中面 `#eee4e6`、中性动作文字 `#373437`、实心动作 `#ce3e4e`，
Logo 恢复 Steel `#526f88` 与 Ember `#d3a45f`。会话、执行台和队员浮层保持白底，消息继续使用生产气泡。

外观选项增加 `--settings-choice-selected-surface` 语义 Token，以复现 A 的轻红选中面。
其余四套配色取各自原有 `--home-surface` 值，既有 Token 均未变化，包括地平线 v7。
同步经典红缩略图、Main 首帧背景和主题合同；没有主题专属组件选择器、额外聚焦装饰或新功能。

- `pnpm typecheck`、`pnpm test`、`pnpm build:desktop` 通过。
- 同步主线 PR #886 的撤回后重新编辑改动后，重新执行 typecheck、完整 `pnpm test` 和桌面构建，均通过。
- Vitest：255 个文件、2947 项通过、2 项既有跳过；完整 Node 门禁通过。
- `pnpm test:rust:pr`：475 项通过、1 项既有忽略。通过本机已安装的 Rust 1.98 工具链运行；
  `rust-objcopy` 因缺少 `libLLVM.dylib` 报告剥离调试信息警告，不影响构建和测试退出结果。
- 主题合同的 188 项 Token 与实现逐项匹配，新增选中面的文字对比度纳入既有测试。
- `pnpm docs:test`、`pnpm docs:check` 与以本次 main 基线为 `DOCS_BASE_REF` 的 `pnpm docs:check:ci` 通过。
- 当前源码的生产组件浏览器 fixture：六项主题切换通过，其他主题的选中面保持原色；切回会话后草稿保留。
- 经典红队员浮层、执行台与 Composer 均为白色，消息气泡为 `#f5f4f4`；输入框聚焦前后边线与阴影一致。
- 1512×772、1440×920 和 1040×700 无整页横向溢出；最小窗口主题卡片为三列、六项完整可达。
- 已保存会话、队员浮层、执行台、外观页及最小窗口截图；浏览器无 warning/error，临时 viewport 已恢复。

本次视觉验收使用固定数据，不启动 Host/Core/Runtime，也不读写日常 App 数据。
未重复原生 Windows/macOS 系统明暗切换、IME 与辅助技术验收；此配色修订不改变这些入口。

## Worktree handoff

- Work item: 按 User sequence 40 实施经典红 A「轻红侧栏」。
- Worktree: `/Users/murray.xue/VSCodeProjects/opensource/rovai-ai-classic-red`
- Branch: `rovai/classic-red-soft-surfaces`
- Base: `origin/main` / `984e82281ee57c5b33ac5ec320d1e4bf52e4cf4a`
- Integrated main: `4fe005decd5eaf54b81265943f71e80a7014f75e`
- Governance: none；User 已授权配色修订与 PR 合入，UI 合同随同提交。
- Status: ready
- Next: 按既有授权创建 PR，CI 通过后合入 main 并清理 worktree。
