---
document_type: ui-theme
authority: renderer-theme
status: accepted
theme_id: horizon
mode: light
last_updated: 2026-10-23
---

# 地平线

## Identity and mode

稳定 `ThemeId` / `ThemePreference` 为 `horizon`，明暗模式为 `day`，
`color-scheme: light`。与原有主题共享生产组件、页面、能力与状态。

## Design intent

以暖瓷白阅读区、浅岩灰侧栏和 Steel 蓝灰强调色形成温和的冷暖与深浅对比。
User 在主题设计 Thread sequence 25 明确参照 `rovai-theme-refined-v3.html` 中点击「看原版」后的地平线；
配色直接来自该稿的 `baselineOptions.horizon.tokens`，而非精修版的灰绿配色。
执行台沿用 sequence 20 减暖修订的中性白，避免大面积泛黄。
沿用 sequence 18 的交互边界，不加入生产没有的聚焦效果或功能。

## Surface hierarchy and color responsibilities

会话区 `#fcfbf7`、侧栏 `#eae7e1` 与气泡 `#eeeae2` 恢复参照稿的表面层次，
强调色 `#4e6c7e` 与正文 `#252a2d` 保留蓝灰方向。
执行台通过 `--execution-surface: #ffffff` 与会话底色分离；输入与浮层使用原稿的近白色 `#fffefb`，
代码块 `#f0f1ed` 与 Evidence 使用原稿的低饱和灰色。消息气泡使用生产几何与同色边线。
品牌、状态、身份、证据色保持独立；Memory 专用工作区沿用无彩色面。
实心操作与表面上的操作文字分别由 `--conversation-action` 与 `--conversation-action-ink` 拥有。

## Complete semantic token assignments

以下为完整配色 Token；布局、阅读字号与尺寸继续继承共享生产规则。

| Token | Value |
|---|---|
| `--monitoring-input` | `#393b3d` |
| `--monitoring-output` | `#657f9b` |
| `--monitoring-read` | `#698273` |
| `--monitoring-write` | `#997b4d` |
| `--settings-choice-line` | `#d9d7ce` |
| `--settings-choice-selected-line` | `#a4ada6` |
| `--settings-choice-hover` | `#f2f1eb` |
| `--settings-field-line` | `#c4cbc1` |
| `--settings-switch-off` | `#858f88` |
| `--settings-switch-thumb` | `#fffefb` |
| `--settings-select-arrow` | `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='m4.5 6.25 3.5 3.5 3.5-3.5' fill='none' stroke='%23616b74' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")` |
| `--canvas` | `#e7e4df` |
| `--surface` | `#f8f6f1` |
| `--surface-raised` | `#fffefb` |
| `--surface-subtle` | `#efede7` |
| `--surface-muted` | `#e4e1da` |
| `--surface-selected` | `#dedfdb` |
| `--surface-hover` | `#e6e5df` |
| `--surface-sunken` | `#dddbd4` |
| `--workspace-surface-subtle` | `#f1eee8` |
| `--workspace-surface-raised` | `#fffefb` |
| `--workspace-surface-hover` | `#e8e6df` |
| `--workspace-surface-selected` | `#e1e7e7` |
| `--workspace-line` | `#d3d0c8` |
| `--workspace-line-strong` | `#b9bcb8` |
| `--workspace-steel` | `#4e6c7e` |
| `--workspace-steel-ink` | `#36566b` |
| `--workspace-attention-soft` | `#f1e7d7` |
| `--workspace-faint` | `#687379` |
| `--runtime-logo-surface` | `#ffffff` |
| `--conversation-surface` | `#fcfbf7` |
| `--conversation-user-message-surface` | `#eeeae2` |
| `--conversation-user-message-line` | `#eeeae2` |
| `--execution-running-surface` | `#f3f2ed` |
| `--execution-surface` | `#ffffff` |
| `--conversation-find-match` | `#f4e4c3` |
| `--conversation-find-current` | `#edc66f` |
| `--conversation-find-line` | `#bd8a38` |
| `--inspector-surface` | `#f4f1eb` |
| `--conversation-inspector-line` | `#b9b7b2` |
| `--home-surface` | `#fcfbf7` |
| `--topbar` | `#f8f6f1` |
| `--input` | `#fffefb` |
| `--ink` | `#252a2d` |
| `--muted` | `#5f686d` |
| `--faint` | `#60696e` |
| `--line` | `#d9d5ce` |
| `--resize-line` | `#777777` |
| `--line-strong` | `#b9b7b2` |
| `--control-line` | `#848d87` |
| `--new-camp-picker-surface` | `#fffefb` |
| `--new-camp-picker-soft` | `#e8edec` |
| `--new-camp-picker-hover` | `#edf0ec` |
| `--new-camp-picker-line-strong` | `#81918f` |
| `--brand` | `#4e6c7e` |
| `--brand-hover` | `#3b5566` |
| `--brand-contrast` | `#fffefb` |
| `--brand-soft` | `#e5ecee` |
| `--brand-ink` | `#36566b` |
| `--memory-rail` | `#f3f3f3` |
| `--memory-overlay` | `rgba(24, 24, 24, .42)` |
| `--memory-canvas` | `#ffffff` |
| `--memory-surface` | `#f5f5f5` |
| `--memory-raised` | `#ffffff` |
| `--memory-selected` | `#ededed` |
| `--memory-hover` | `#f3f3f3` |
| `--memory-line` | `#e2e2e2` |
| `--memory-ink` | `#222222` |
| `--memory-muted` | `#626262` |
| `--memory-input-line` | `#dedede` |
| `--neutral-selected` | `#e4e3dd` |
| `--neutral-hover` | `#eeece6` |
| `--conversation-action` | `#303538` |
| `--conversation-action-ink` | `#303538` |
| `--conversation-action-hover` | `#202527` |
| `--conversation-action-contrast` | `#fffefb` |
| `--conversation-control-line` | `#8e938e` |
| `--conversation-focus` | `#303538` |
| `--conversation-focus-soft` | `rgba(48, 53, 56, 0.12)` |
| `--conversation-route-accent` | `#767d7b` |
| `--conversation-unread` | `#1683ff` |
| `--update-progress-fill` | `#2879e8` |
| `--mission-unread-ink` | `#0967d2` |
| `--file-update-marker` | `#b7791f` |
| `--channel-feishu` | `#3370ff` |
| `--channel-dingtalk` | `#0b7cff` |
| `--qr-canvas` | `#ffffff` |
| `--resource-link` | `#2b66d9` |
| `--resource-link-hover` | `#1e4fb8` |
| `--mention-ink` | `#2f61c8` |
| `--mention-ink-hover` | `#244ea7` |
| `--mention-feedback` | `rgba(47, 97, 200, 0.08)` |
| `--mention-popover-portrait-scrim` | `rgba(32, 36, 56, 0.10)` |
| `--mention-popover-label-line` | `rgba(255, 255, 255, 0.45)` |
| `--mention-popover-label-surface` | `rgba(32, 36, 56, 0.34)` |
| `--mention-popover-accent` | `var(--brand)` |
| `--aurora` | `#719d94` |
| `--aurora-soft` | `#e7f0ec` |
| `--violet` | `#9082b4` |
| `--violet-soft` | `#efebf6` |
| `--rail` | `#eae7e1` |
| `--rail-ink` | `#5b656a` |
| `--rail-line` | `#d3cfc6` |
| `--rail-logo` | `#4e6c7e` |
| `--ember` | `#ba8e50` |
| `--ember-soft` | `#f4ead8` |
| `--success` | `#3e775c` |
| `--success-soft` | `#e7f1ea` |
| `--success-contrast` | `#ffffff` |
| `--attention` | `#8a6226` |
| `--attention-soft` | `#f8edda` |
| `--attention-contrast` | `#ffffff` |
| `--danger` | `#a24c46` |
| `--danger-soft` | `#f7e6e3` |
| `--danger-contrast` | `#ffffff` |
| `--info` | `#416c86` |
| `--info-soft` | `#e5eef3` |
| `--info-contrast` | `#ffffff` |
| `--neutral` | `#5f6678` |
| `--neutral-soft` | `#ecefe9` |
| `--focus` | `#4e6c7e` |
| `--focus-soft` | `rgba(78, 108, 126, 0.16)` |
| `--overlay` | `rgba(32, 36, 36, 0.42)` |
| `--shadow-float` | `0 18px 56px rgba(41, 44, 39, 0.14)` |
| `--shadow-menu` | `var(--shadow-float)` |
| `--shadow-dialog` | `var(--shadow-float)` |
| `--shadow-card` | `none` |
| `--approval-line` | `#d8bd87` |
| `--inline-code-canvas` | `#e6e8e4` |
| `--conversation-inline-code-canvas` | `#e9ebe7` |
| `--dialog-field-label` | `#676d6a` |
| `--dialog-field-line` | `#dcdcd4` |
| `--dialog-field-line-hover` | `#b8c0b8` |
| `--conversation-code-block-canvas` | `#f0f1ed` |
| `--conversation-code-line` | `#d3d8d1` |
| `--shell-result-canvas` | `#e9ece7` |
| `--code-block-canvas` | `#eeefeb` |
| `--evidence-canvas` | `#f0f0eb` |
| `--evidence-surface` | `#f8f8f4` |
| `--evidence-ink` | `#2f3437` |
| `--evidence-muted` | `#5d686f` |
| `--evidence-line` | `#cfd3ce` |
| `--diff-add` | `#137333` |
| `--diff-add-soft` | `#d9f1e2` |
| `--diff-remove` | `#b3261e` |
| `--diff-remove-soft` | `#f5dede` |
| `--diff-hunk-soft` | `#eaece7` |
| `--file-change-surface` | `#fcfbf7` |
| `--file-change-hover` | `#eeeee7` |
| `--file-change-selected` | `#e6e8e1` |
| `--file-change-selected-line` | `#cbd0c7` |
| `--file-change-add-soft` | `#ecf7f0` |
| `--file-change-remove-soft` | `#fcf0ef` |
| `--file-change-hunk` | `#eeeee7` |
| `--identity-1` | `#a35d49` |
| `--identity-2` | `#39777a` |
| `--identity-3` | `#74628f` |
| `--identity-4` | `#956730` |
| `--identity-5` | `#4f729b` |
| `--identity-6` | `#8a5c75` |
| `--identity-7` | `#547245` |
| `--identity-8` | `#8c6146` |
| `--mission-label-1` | `#ae4e3e` |
| `--mission-label-2` | `#27777b` |
| `--mission-label-3` | `#71579a` |
| `--mission-label-4` | `#95610f` |
| `--mission-label-5` | `#3f6fa7` |
| `--mission-label-6` | `#914f78` |
| `--mission-label-7` | `#4d752f` |
| `--mission-label-8` | `#98542e` |
| `--attachment-web` | `#a65f4a` |
| `--attachment-code` | `#39777a` |
| `--attachment-notes` | `#5f6678` |
| `--attachment-pdf` | `#9a4b46` |
| `--attachment-word` | `#4e6ea8` |
| `--attachment-sheet` | `#3e775c` |
| `--attachment-slide` | `#9a6a32` |
| `--attachment-image` | `#74628f` |
| `--attachment-archive` | `#8c6146` |
| `--attachment-generic` | `#616a73` |
| `--lightbox-overlay` | `rgb(12 18 24 / 72%)` |
| `--lightbox-surface` | `#10171d` |
| `--lightbox-ink` | `#f7fafb` |
| `--lightbox-line` | `rgb(255 255 255 / 18%)` |
| `--lightbox-control` | `rgb(255 255 255 / 10%)` |
| `--lightbox-shadow` | `0 28px 80px rgb(0 0 0 / 42%)` |
| `--member-avatar-accent` | `var(--identity-1)` |

## Contrast requirements

共享主题测试验证普通正文、静音文字、状态标签、八种身份文字与消息气泡正文至少 4.5:1；
会话控件及选择器强边界至少 3:1。原型配色仅在不满足实际表面对比度时作小幅调整。

## Prohibited substitutions

不使用自动反色，不复制组件，不按主题分叉业务结构，不引入原型的聚焦光晕、额外边框变化或评审工具。

## Implementation and verification

真源：[共享 Token](../../../packages/ui/src/theme.css)、
[主题解析](../../../apps/desktop/src/shared/appearance.ts)、
[对比度测试](../../../apps/desktop/src/renderer/src/theme-tokens.test.ts)。
按[共享矩阵](../qa/theme-matrix.md)验证，当前范围和证据见
[实施记录](../../versions/v1.72/theme-palettes-implementation.md)。
