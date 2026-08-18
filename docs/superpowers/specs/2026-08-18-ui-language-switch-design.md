# 界面语言切换 + 作品名本地化一致性

## 1. 背景与问题

**问题 A：UI 语言无设置入口**

- `web/src/i18n/useT.ts` 用 `localStorage["scout-lang"]` 存 `'en' | 'zh'`，默认 `navigator.language` 猜
- **唯一修改入口**是首次 setup 向导的 `StepLanguage`——一次性联动，之后 UI 没有切换路径
- 用户想切语言只能清 localStorage 或 DevTools 手改

**问题 B：作品名呈现不一致**

- 活动页 / 通知页 走 `displayTitle(lang, title, chineseTitle)`——`zh` 用中文名、`en` 用原名 ✅
- **媒体库**（`MediaLibraryPage.tsx:111`）写死 `item.chineseTitle ?? item.title`，跟 lang 无关 ❌
- **详情页**（`MediaDetailPage.tsx:187-188`）同上 ❌

切到英文界面时，媒体库/详情页仍显示「黑暗智宅」而不是「Dark Matter」——观感是 UI 没翻完。

**问题 C：详情页副标题语义错误**

- 当前 `originalTitle = chineseTitle && chineseTitle !== title ? title : null`
- 这假设读者是中文用户——中文主 + 英文副
- 英文 UI 下应该是：**只有主标题，没有副标题**（外国人不需要知道作品中文名是什么）

## 2. 用户裁决（2026-08-18）

> 「切换了 UI 语言的话，界面上语言的一切应该都是切换后语言才对」
>
> 「如果切换了 UI 语言，那中文名应该就不是副标题，而是直接不见了才对吧，因为外国人不需要知道它中文名是啥」

**副标题存在的理由是"补充原文 identity"，不是"展示另一种语言"。**

| UI 语言 | 主标题 | 副标题 |
|---|---|---|
| `zh` | `chineseTitle ?? title` | `title`（仅当 chineseTitle 存在且 ≠ title）|
| `en` | `title` | **无**（整个 originalTitle 槽不渲染）|

## 3. 范围

**In：**

1. **设置页「通用」tab 加界面语言切换**：BehaviorSection 新增一行（在 EngineRow 之前，因为语言影响所有其他设置的阅读）
   - SegmentedControl 两个选项：「中文」「English」
   - 调 `useT().setLang()` 即时生效
   - 持久化走 useT 内部的 localStorage（已有），**不走后端 settings PUT**——这是浏览器本地偏好，不是服务器配置
2. **媒体库**：`MediaLibraryPage.tsx:111` 改成 `displayTitle(lang, item.title, item.chineseTitle)`
3. **详情页**：
   - 主标题：`displayTitle(lang, work.title, work.chineseTitle)`
   - 副标题 `originalTitle`：**只在 `lang === 'zh'` 且 `chineseTitle` 存在且 ≠ `title` 时渲染**，值为 `title`
   - `en` 时整个副标题槽不渲染

**Out：**

- agent 工作流的 stepLabel/logLines——已经走 i18n（`stepPhraseKey(tool)` → `wb_step_*` key → `t()`）
- 后端返回的错误消息——已经走 `localizeErrorValue` 的 i18n 化
- 字幕目标语言（`target_languages`）——那是**内容**偏好，不是 UI 语言，不动
- 首次 setup 向导的 `StepLanguage`——保留，仍然是首次入口；新设置行是它的**运行时镜像**

## 4. 设计

### 4.1 BehaviorSection 新增 UiLanguageRow

放在 `EngineRow` **之前**——语言影响下面所有设置项的阅读。

组件形态：

```tsx
function UiLanguageRow() {
  const { t, lang, setLang } = useT()
  return (
    <div className="flex flex-col gap-2">
      <span>{t('settings_ui_language_label')}</span>
      <div role="group" aria-label={t('settings_ui_language_label')}>
        <button
          type="button"
          aria-pressed={lang === 'zh'}
          onClick={() => setLang('zh')}
        >中文</button>
        <button
          type="button"
          aria-pressed={lang === 'en'}
          onClick={() => setLang('en')}
        >English
        </button>
      </div>
      <span className="text-muted-foreground">{t('settings_ui_language_note')}</span>
    </div>
  )
}
```

**不用 shadcn Select**——两个选项的 SegmentedControl 更直白（点一下就换，不用开下拉）；且 `aria-pressed` 是切换语义，`role="group"` 是分组语义，读屏器正确处理。

样式（`styles.css` 新增 `.settings-lang-switch`）：

- 两个按钮并排，中间无 gap（segmented control 视觉）
- 未选中：transparent 底、muted 文字
- 选中：`bg-secondary`、fg 文字
- 整体 1px border + radius-control

**无 commit/error 态**——`setLang` 是同步的 localStorage 写，不会失败（失败也只在隐私模式下静默降级，useT 内部已经处理）。

### 4.2 媒体库一行改

```diff
- const title = item.chineseTitle ?? item.title
+ const title = displayTitle(lang, item.title, item.chineseTitle ?? null)
```

`lang` 从 `useT()` 拿。

### 4.3 详情页三行改

```diff
- const title = work.chineseTitle ?? work.title
- const originalTitle = work.chineseTitle && work.chineseTitle !== work.title ? work.title : null
+ const title = displayTitle(lang, work.title, work.chineseTitle ?? null)
+ const originalTitle =
+   lang === 'zh' && work.chineseTitle && work.chineseTitle !== work.title
+     ? work.title
+     : null
```

`en` 时 `originalTitle === null`——既有 JSX 已经是 `{originalTitle && <...>}`，**整体槽自动不渲染**，不用动 JSX。

## 5. i18n 新增

| key | en | zh |
|---|---|---|
| `settings_ui_language_label` | Interface language | 界面语言 |
| `settings_ui_language_note` | Applies to this browser only | 仅作用于当前浏览器 |

## 6. 测试锁（RED → GREEN）

新增 `web/src/settings/uiLanguageRow.test.tsx`：

1. 渲染两个按钮，aria-pressed 反映当前 lang
2. 点「English」→ `setLang('en')` 被调，localStorage 写入 'en'
3. 点「中文」→ `setLang('zh')`
4. 行在 EngineRow 之前（DOM 顺序断言）

新增 `web/src/media/mediaTitle.i18n.test.tsx`：

5. MediaLibraryPage `lang=zh` → 显示 chineseTitle；`lang=en` → 显示 title
6. MediaDetailPage `lang=zh` 且有 chineseTitle ≠ title → 主 chineseTitle + 副 title
7. MediaDetailPage `lang=en` 且有 chineseTitle → 主 title，**无副标题槽**
8. MediaDetailPage `lang=zh` 且 chineseTitle === title → 主 title，无副标题（现状）

修改 `web/src/workbench/displayTitle.ts` 无——它已经是对的。

## 7. 自审

- 占位：无 TBD
- 内部一致：UI 语言切换行与 StepLanguage 是同一状态的两个写入点，共用 `setLang` 与 localStorage key
- 范围：1 行 BehaviorSection + 2 行媒体库/详情页 + 1 段 CSS + 2 条 i18n + 2 个测试文件
- 歧义已钉：副标题 en 整体不渲染；切换不走后端 PUT；SegmentedControl 不用 Select
