---
document_type: implementation-record
version: v1.72
lifecycle: current
authority: implementation-evidence
last_updated: 2026-10-22
---

# 地平线、经典红与余烬实施

User 在主题设计 Thread sequence 18 确认使用独立 worktree 实施第六版配色与六项紧凑选择器，
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

## Worktree handoff

- Work item: 三款新主题与六项紧凑选择器。
- Worktree: `/Users/murray.xue/.codex/worktrees/theme-horizon-red-ember/rovai-ai`
- Branch: `rovai/theme-horizon-red-ember`
- Base: `origin/main` / `186d1cfcf0c0cfff342aa36282b35d75436613c5`
- Governance: none；当前 User 已确认配色与实现，UI 合同随同提交。
- Status: ready
- Next: 提交并推送独立分支供 User 验收；保留 worktree。按 User 既有偏好不自动创建 PR。
