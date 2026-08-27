// web/src/shell/AppShell.tsx：外壳——Sidebar + Topbar + 四个页面分支。
// 顶栏只显示当前页；技术读数、⌘K 面板与 workflow/pending 轮询已删除。
import { useMediaLibraryDetail } from '../api/hooks.js'
import { useShellRoute } from './route.js'
import { Sidebar } from './Sidebar.js'
import { BottomTabBar } from './BottomTabBar.js'
import { Topbar } from './Topbar.js'
import { EngineBanner } from './EngineBanner.js'
import { PageBoundary } from './PageBoundary.js'
import { SettingsTabsPage } from '../settings/SettingsTabsPage.js'
import { ActivityPage } from '../workbench/ActivityPage.js'
import { MediaLibraryPage } from '../media/MediaLibraryPage.js'
import { MediaDetailPage } from '../media/MediaDetailPage.js'
import { NotificationsPage } from '../notifications/NotificationsPage.js'
import { EventsProvider } from '../events/EventsProvider.js'
import { useT } from '../i18n/useT.js'

export function Shell() {
  // Task ⑦：EventsProvider 包在最外——四层 SSE Context（activity/found/health/progress）
  // 对全树可用。包在这里而不是各页面内部：R-F10 约束 3 要求**整个 app 只有一条 SSE 连接**
  // （HTTP/1.1 每源 6 连接上限），每页各包一个 Provider 会各开一条。
  // ⚠️ 连接是**惰性**的：eventsBus 只在有人 subscribe 时才 new EventSource（引用计数），
  // 所以本 task 挂上 Provider 但没有任何页面订阅 = **一条连接都不会开**。这是有意的：
  // 占位期不该去敲一个端点。Task ⑨⑩ 的页面一 useActivityEvent/useFoundEvent，连接自动建立。
  return (
    <EventsProvider>
      <ShellBody />
    </EventsProvider>
  )
}

function ShellBody() {
  const { t } = useT()
  const route = useShellRoute()

  // Task ⑧：媒体库详情（#/media/:workId）——mediaWorkId 为 null 时 hook 不发请求
  // （见 api/hooks.ts 注释），不在详情页时不会白白 404。
  // 它**只喂给页面本体**，不喂 Topbar：新导航的面包屑只有一级（TABS 里的 tab 名），
  // 媒体库详情页自己在页头画了返回链接与作品名。给 Topbar 加二级面包屑是独立的产品动作。
  // 必须在 EventsProvider 内：useReloadOnFound / useReloadWhenCurrentClears 读 SSE Context。
  const mediaDetail = useMediaLibraryDetail(route.mediaWorkId ?? null)

  // 自绘壳，结构逐值复刻 AstryxAppShell（node_modules/@astryxdesign/core/src/AppShell/
  // AppShell.tsx:769-811 + Layout.tsx:283-296，height="fill" 路径）：根 flex column
  // 满高（h-screen；Astryx 用 100dvh，桌面端等价，本应用桌面优先）→ 顶栏全宽在最前
  // （DOM 序＝焦点序）→ 中间行 [侧栏 | 内容]。
  // skip-to-content 链接与 role="main" 是 Astryx 壳的真实无障碍件（无测试覆盖），
  // 保留成本一行；样式在 styles.css 的 shell 段（.skip-to-content）。
  return (
    <div className="flex h-screen flex-col">
      <a href="#scout-app-main" className="skip-to-content">
        {t('a11y_skip_to_content')}
      </a>
      <Topbar tab={route.tab} />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar tab={route.tab} />
        {/* 2026-08-27 布局 spec 决策 B：留白从 p-4（16px，Astryx contentPadding 4 的遗值）
            升到 p-6 基线 + xl:p-8 宽屏档。**仅此一处**——各页内部间距不跟着连坐。
            分页 max-width 收口（决策 A）在各页顶层容器上，main 只保滚动容器职责不动。
            ⚠️ Task ⑪：原先这里是 `route.tab === 'library' ? 'p-0' : 'p-4'` 条件类——
            p-0 是旧海报墙要的全宽出血。旧页面下架后条件恒假，连同 `cn()` 的 import
            一起删掉（留着就是一条永不成立的分支 + 一个只为它存在的工具函数调用）。
            max-md 的 pb 追加值：<768px 给 fixed 定位的 BottomTabBar 让位——56px 栏高
            + 16px 呼吸 + iOS 安全区；≥md 底部栏不存在，回落 p-6/p-8 不受影响。
            ⚠️ 注释里不要原样写出带方括号的类名字面——Tailwind v4 纯文本扫描会把它
            当 utility 编进产物（实测中过一次）。 */}
        <main id="scout-app-main" role="main" className="flex-1 overflow-y-auto p-6 xl:p-8 max-md:pb-[calc(4.5rem+env(safe-area-inset-bottom))]">
          {/* 引擎关闭 banner 压所有主屏顶（spec A §5.6）。 */}
          <EngineBanner />
          {/* ── 导航四页，每项一条分支 ─────────────────────────────────────
              ⚠️ 这一族分支是**静默失效点**：漏一条不报错，只是那个 tab 渲染一片空白
              （侧栏还高亮着，用户以为页面坏了）。AppShell.nav.test.tsx 里有一条
              "TABS 里每一项都必须渲染出可识别内容"的遍历用例守它——加 tab 时忘了加
              分支，那条会红。 */}
          {/* Task ⑨ 活动页。两个 tab（字幕/翻译）——**只有两个**：识别按 R-F1 降级为
              顶部状态条，不占 tab。本页没有二级路由（同通知页），故是一条光杆分支。
              ⚠️ 组件在 `workbench/`。Task ⑪ 前 `activity/` 是**另一个**同名旧页面
              （#/workflow 渲染的那个），现已移入 `_legacy/activity/`——这个 import
              路径今天不再有歧义，但目录名仍不改回去（改名是独立动作，且 `_legacy`
              整体去留还没裁决）。 */}
          {/* ⚠️ 每条分支都包 PageBoundary（**边界在分支里、不在分支外**）：
              一页渲染时抛出的异常此前会卸载整棵树 = 侧栏顶栏一起消失的全屏白屏
              （实测：SettingsTabsPage 读 setupStatus.data.providers 时 DTO 缺字段）。
              包在这里而不是包在 <main> 外面一条，是因为 name 要区分、且 tab 切换时
              天然换掉边界实例（坏掉的那页不会把 failed 态带到下一页）。
              论证见 PageBoundary.tsx 文件头。 */}
          {route.tab === 'activity' && (
            <PageBoundary name="activity"><ActivityPage /></PageBoundary>
          )}
          {/* Task ⑩：通知页。一周流水、倒序、不做已读；SSE `found` 触发再 GET，
              列表永远只由 GET /api/v2/notifications 出。
              ⚠️ 这一页**没有二级路由**（不像 media 那样有 :workId），所以这里是
              一条光杆分支——route.ts 也刻意不给它加任何段解析。 */}
          {route.tab === 'notifications' && (
            <PageBoundary name="notifications"><NotificationsPage /></PageBoundary>
          )}
          {route.tab === 'media' && (
            <PageBoundary name="media">
              {route.mediaWorkId ? (
                // key=mediaWorkId：切换到另一部作品时强制重挂载，避免上一部作品的
                // MediaPoster 失败态（useState failed）跨作品残留 —— 那会让一部有海报的
                // 作品显示成首字母占位。
                <MediaDetailPage key={route.mediaWorkId} detail={mediaDetail} />
              ) : (
                <MediaLibraryPage />
              )}
            </PageBoundary>
          )}
          {route.tab === 'settings' && (
            <PageBoundary name="settings"><SettingsTabsPage /></PageBoundary>
          )}
        </main>
      </div>
      {/* <768px 的导航形态（md:hidden，fixed 贴底）；≥md 由上面的 Sidebar 接管，
          二者靠断点互斥、永不同屏。main 的 max-md 底部 padding 为它让位。 */}
      <BottomTabBar tab={route.tab} />
    </div>
  )
}
