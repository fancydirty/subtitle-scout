# 设置页 Provider 卡「Vercel 风」重构（B 方案）

## 1. 背景

当前已配置的 Provider 卡（TMDB / LLM / AI 翻译 / ASSRT / …）在视觉上是 MVP：

- 状态徽章孤立右上，与标题/内容无关联
- 测试 / 编辑按钮 与 lastTest 状态点、时间戳挤在同一行，三个语义层级硬塞
- 密钥清单是松散 `<div>label + masked</div>` 列表，没有键值对排版纪律；TMDB 1 行、LLM 3 行、翻译 3 行，视觉结构完全不一致
- masked token 是技术读数，却没走 mono 字体

用户裁决（2026-08-18）：采用 visual companion 展示的 **B 方案（Vercel 风）** 重构。

## 2. 范围

**只改已配置 rest 态的视觉结构**。以下不动：

- 编辑表单的字段、校验、提交流程
- 未配置（unconfigured）时的摊开表单
- AI 翻译卡的开关逻辑、配额说明、dedicated note
- 状态判据（allConfigured → configured / unconfigured）
- i18n key（不增新 key 以外的；已有 key 文案不动）

涉及组件：`ProviderCard.tsx`、`TranslateCard.tsx`、`SettingsCard.tsx`。

## 3. 设计

### 3.1 三段式结构

```
┌─────────────────────────────────────────────────┐
│ ● Title          [description]        [badge]   │  Header
├─────────────────────────────────────────────────┤
│ Base URL    https://api.openai.com/v1           │
│ API 密钥    sk-••••e10                          │  Credentials (dl KV)
│ 模型        deepseek-chat                       │
├─────────────────────────────────────────────────┤
│ [测试连接] [编辑凭据]        ○ 2 天前通过        │  Actions
└─────────────────────────────────────────────────┘
```

### 3.2 SettingsCard 扩展

- Header 左侧加 `statusDot?: 'success' | 'error' | null`：与 badge 同语义但视觉权重平衡（点贴标题，徽章在右）
- Header 右侧 badge 保留，文案去掉 ✓ 前缀（点已经承担了"OK"的视觉信号）
- 新增 `footer?: ReactNode` 槽，渲染在 `<CardContent>` 之后、用 hairline 分隔（Linear 三段式）

### 3.3 KV 栅格

密钥清单改成 `<dl>`：

```tsx
<dl className="sp-kv">
  <dt>Base URL</dt><dd>https://api.openai.com/v1</dd>
  ...
</dl>
```

CSS（styles.css 新增 `.settings-kv` 段）：

- `display: grid; grid-template-columns: 110px 1fr; row-gap: 8px; column-gap: 14px`
- `dt`：11px、muted 色（label）
- `dd`：12px、mono 字体（masked token / URL 是技术读数）

TMDB 1 行 / LLM 3 行 / 翻译 3 行 自动对齐。

### 3.4 操作行

- 独立成行（footer 槽）
- 左：`[测试连接] [编辑凭据]`（primary + secondary；buttonVariants 的 default + secondary）
- 右：lastTest 状态——`<StatusDot variant>` + 相对时间（复用 relDuration，与活动页同粒度）
- 绝对时间戳 `toLocaleString()` 移到 title 属性 hover 显示

### 3.5 i18n 新增

| key | en | zh |
|---|---|---|
| `settings_provider_test_connect` | Test connection | 测试连接 |
| `settings_provider_edit_credentials` | Edit credentials | 编辑凭据 |
| `settings_provider_last_test_ago` | {ago} ago | {ago}前 |
| `settings_provider_last_test_passed_ago` | passed {ago} ago | {ago}前通过 |
| `settings_provider_last_test_failed_ago` | failed {ago} ago | {ago}前失败 |

旧的 `settings_provider_test` / `settings_provider_edit` / `settings_provider_last_test_ok` / `_fail` 保留（仍被 wizard / 编辑态用）。

## 4. 测试锁（RED → GREEN）

新增 `web/src/settings/settingsCard.visual.test.tsx`：

1. SettingsCard 接受 `statusDot`，header 渲染对应 StatusDot
2. SettingsCard 接受 `footer`，渲染在 CardContent 之后，中间有 hairline div
3. ProviderCard rest 态渲染 `<dl>`，dt/dd 数量与 secrets 长度一致
4. ProviderCard rest 态的 dd 元素 className 含 `font-mono`（或 computed style font-family 包含 mono，但 jsdom 不算样式——断言 class）
5. ProviderCard rest 态按钮文案是 "Test connection" / "Edit credentials"（不是 "Test" / "Edit"）
6. lastTest 行在 footer 区，不在 credentials 区（用 within 判）
7. TranslateCard rest 态同样渲染 `<dl>`，按钮文案同上
8. 反向禁令：rest 态**不再**渲染 `toLocaleString()` 格式的绝对时间（只相对时间）

`SettingsCard.test.tsx` 既有用例保留（兼容 status/badge 不传 footer 的旧用法）。

## 5. 不做

- 不动 ProviderToggleCard / ZimukuVisionCard（开关型源）
- 不动 BehaviorSection / RootsManager / SecuritySection / SystemSection
- 不改后端契约
- 不动移动端 media query（grid 列宽走 px 已是最小适配）

## 6. 自审

- 占位：无 TBD
- 内部一致：三段式与 KV 栅格互斥于旧的"按钮行 + 密钥列表"二合一布局
- 范围：单组件树重构 + CSS 一段 + i18n 五条
- 歧义已钉：footer 槽语义、KV 列宽 110px、相对时间粒度复用 relDuration
