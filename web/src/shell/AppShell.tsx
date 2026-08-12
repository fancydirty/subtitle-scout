// web/src/shell/AppShell.tsx：新外壳组装——自绘壳（Task 28 卸 AstryxAppShell）+ Sidebar + Topbar
// + CommandK + tab 路由分发。数据面只发一次 GET /api/v2/workflow/pending，顶栏新鲜度行用它
// （后端契约：meta.roots/lastScanAt/files，见 api/types.ts 注释；响应里的 parked 随甄别角标
// 一起雪藏，字段本身仍在）。
//
// dashboard-F3：Library tab 落地为真页面（SeriesGrid 列表 / SeriesPage 详情），二级路由
// #/library/:id 命中时，剧集详情请求在这一层发起并同时喂给 Topbar（面包屑二级：剧名）和
// SeriesPage（页面主体）——避免面包屑和页面各发一次 GET /api/v2/library/series/:id。
//
// 2026-07-31：Workflow tab 换成活动页（ActivityPage）。旧的 Lanes 三泳道是**账目**视图
// （回答"系统都干了什么"）；用户裁决把这个 tab 重新定义为**运行态展示**（回答"现在怎么样了，
// 我可以不管了吗"，Steam 下载页那种）。Lanes 一族暂时保留在 workflow/ 下未删——RunDetail 与
// RerunDialog 仍被活动页复用，且删除是独立的清理动作，不该和上线混在一个改动里。
// 历史注释（Lanes：三泳道桌面主视图 + 移动端折叠 stack），
// 自己发三个请求（workflow/pending 复用上面这一份、workflow/passes、workflow/workers），
// 不像 Library 详情那样需要 Shell 这一层协调共享——三份数据只服务 Workflow 区自己，跟 Topbar/
// Sidebar 无关，因此整个组件收在 workflow/Lanes.tsx 内部自洽。
//
// 2026-08-07（spec §5）：Triage tab 本轮雪藏——这一层的 route.tab === 'triage' 分支与
// TriagePage import 移除，侧栏也不再收 parked 角标。TriagePage 源码仍在 web/src/triage/ 下
// （测试也全留着），将来重启用时把 import + 分支 + Sidebar 的 parked={workflow.data?.parked}
// 三处加回即可。历史注释（dashboard-F5：TriagePage 四区单列收件箱 Pending/Excluded/Timing/
// Dormant，自己发 GET /api/v2/triage，跟外壳只共享侧栏 parked 角标）。
//
// ── 2026-08-12（Task ⑦）：新导航四项 + 两个旧路由并存 ────────────────────────
// 本层现在有 **5 个** route.tab 分支族：library（含二级路由）/ workflow / settings +
// 新增的 activity / notifications / media。
//
// **library 与 workflow 的分支一行没动，这是用户裁决**（见 route.ts 头注释的完整论证）：
//  · `#/workflow` 渲染的 ActivityPage 是今天仓里**唯一能用的活动视图**，新活动页要
//    Task ⑨ 才填肉。现在删 = 在两个 task 的窗口期里把它变成不可访问。
//  · activity/ 有 7 处 import workflow/（RunDetail / RerunDialog / rerun / phrases ×3 /
//    useLiveTrail），判「删 workflow」会**立刻编译失败**。
// 两个旧 tab 只是从侧栏与 ⌘K 里消失了（tabs.ts 的 TABS 不再列它们），路由直达照常工作。
// 旧页面下架（移入 _legacy）是 Task ⑪ 的独立动作。
import { useState } from 'react'
import { useWorkflowPending, useLibrarySeriesDetail, useLibraryMovieDetail, useMediaLibraryDetail } from '../api/hooks.js'
import { useShellRoute } from './route.js'
import { Sidebar } from './Sidebar.js'
import { Topbar } from './Topbar.js'
import { CommandK } from './CommandK.js'
import { EngineBanner } from './EngineBanner.js'
import { SeriesGrid } from '../library/SeriesGrid.js'
import { SeriesPage } from '../library/SeriesPage.js'
import { MovieDetailPage } from '../library/MovieDetailPage.js'
import { ActivityPage } from '../activity/ActivityPage.js'
import { SettingsTabsPage } from '../settings/SettingsTabsPage.js'
import { ActivityPlaceholder, NotificationsPlaceholder } from './placeholders.js'
import { MediaLibraryPage } from '../media/MediaLibraryPage.js'
import { MediaDetailPage } from '../media/MediaDetailPage.js'
import { EventsProvider } from '../events/EventsProvider.js'
import { cn } from '../lib/utils.js'

export function Shell() {
  const route = useShellRoute()
  const workflow = useWorkflowPending()
  const [isCmdKOpen, setCmdKOpen] = useState(false)

  // 三处（Shell 自己判断渲染哪个组件 / Topbar 面包屑二级 / SeriesPage 页面主体）共享同一次
  // GET /api/v2/library/series/:id——route.libraryId 为 null 时 hook 内部直接跳过请求
  // （见 api/hooks.ts 的 useLibrarySeriesDetail 注释），不在剧集详情页时不会白白 404。
  // Topbar 只在真的处于二级路由时才需要看到这份数据（否则它会把 hook 的"未请求"态误读成
  // "还在 loading"，第二级面包屑永远转圈）——用 route.libraryId 再收一道口子传给它。
  const seriesDetail = useLibrarySeriesDetail(route.libraryId)
  const activeSeriesDetail = route.libraryId ? seriesDetail : null

  // Plan B：电影详情——同 seriesDetail 的口径，route.movieId 为 null 时 hook 不发请求。
  const movieDetail = useLibraryMovieDetail(route.movieId ?? null)

  // Task ⑧：媒体库详情（#/media/:workId）——同上口径，mediaWorkId 为 null 时 hook 不发请求。
  // 与 seriesDetail 不同的是它**只喂给页面本体**，不喂 Topbar：新导航的面包屑只有一级
  // （TABS 里的 tab 名），媒体库详情页自己在页头画了返回链接与作品名。给 Topbar 加二级
  // 面包屑是独立的产品动作，不在本 task 范围。
  const mediaDetail = useMediaLibraryDetail(route.mediaWorkId ?? null)

  return (
    // Task ⑦：EventsProvider 包在最外——四层 SSE Context（activity/found/health/progress）
    // 对全树可用。包在这里而不是各页面内部：R-F10 约束 3 要求**整个 app 只有一条 SSE 连接**
    // （HTTP/1.1 每源 6 连接上限），每页各包一个 Provider 会各开一条。
    // ⚠️ 连接是**惰性**的：eventsBus 只在有人 subscribe 时才 new EventSource（引用计数），
    // 所以本 task 挂上 Provider 但没有任何页面订阅 = **一条连接都不会开**。这是有意的：
    // 占位期不该去敲一个端点。Task ⑨⑩ 的页面一 useActivityEvent/useFoundEvent，连接自动建立。
    <EventsProvider>
      {/* 自绘壳，结构逐值复刻 AstryxAppShell（node_modules/@astryxdesign/core/src/AppShell/
          AppShell.tsx:769-811 + Layout.tsx:283-296，height="fill" 路径）：根 flex column
          满高（h-screen；Astryx 用 100dvh，桌面端等价，本应用桌面优先）→ 顶栏全宽在最前
          （DOM 序＝焦点序）→ 中间行 [侧栏 | 内容]。
          skip-to-content 链接与 role="main" 是 Astryx 壳的真实无障碍件（无测试覆盖），
          保留成本一行；样式在 styles.css 的 shell 段（.skip-to-content）。 */}
      <div className="flex h-screen flex-col">
        <a href="#scout-app-main" className="skip-to-content">
          Skip to content
        </a>
        <Topbar
          tab={route.tab}
          workflow={workflow}
          seriesDetail={activeSeriesDetail}
          onOpenCmdK={() => setCmdKOpen(true)}
        />
        <div className="flex flex-1 overflow-hidden">
          <Sidebar tab={route.tab} />
          {/* contentPadding 0/4 → p-0/p-4 条件类（Astryx --spacing-4=16px=Tailwind 4）。
              library 的 p-0 下 EngineBanner 就是全宽出血细条，正好。 */}
          <main
            id="scout-app-main"
            role="main"
            className={cn('flex-1 overflow-y-auto', route.tab === 'library' ? 'p-0' : 'p-4')}
          >
            {/* 引擎关闭 banner 压所有主屏顶（spec A §5.6）。 */}
            <EngineBanner />
            {route.tab === 'library' &&
              (route.page === 'movie-detail' && route.movieId ? (
                // Plan B：电影详情页（key=movieId 同 SeriesPage 的强制重挂载口径）
                <MovieDetailPage key={route.movieId} detail={movieDetail} />
              ) : route.libraryId ? (
                // key=libraryId：切换到另一部剧时强制重挂载，SeriesPage 内部的格阵选中态
                // （EpisodeDetail 开合）不会带着上一部剧的选中集号跨剧残留。
                <SeriesPage key={route.libraryId} detail={seriesDetail} />
              ) : (
                <SeriesGrid />
              ))}
            {route.tab === 'workflow' && <ActivityPage />}
            {route.tab === 'settings' && <SettingsTabsPage />}
            {/* ── Task ⑦ 新导航三页（占位壳，⑧⑨⑩ 填肉）──────────────────────
                ⚠️ 这一族分支是**静默失效点**：漏一条不报错，只是那个 tab 渲染一片空白
                （侧栏还高亮着，用户以为页面坏了）。AppShell.nav.test.tsx 里有一条
                "TABS 里每一项都必须渲染出可识别内容"的遍历用例守它——加 tab 时忘了加
                分支，那条会红。 */}
            {route.tab === 'activity' && <ActivityPlaceholder />}
            {route.tab === 'notifications' && <NotificationsPlaceholder />}
            {route.tab === 'media' &&
              (route.mediaWorkId ? (
                // key=mediaWorkId：切换到另一部作品时强制重挂载（同 SeriesPage 的既有口径），
                // 避免上一部作品的 MediaPoster 失败态（useState failed）跨作品残留 —— 那会让
                // 一部有海报的作品显示成首字母占位。
                <MediaDetailPage key={route.mediaWorkId} detail={mediaDetail} />
              ) : (
                <MediaLibraryPage />
              ))}
          </main>
        </div>
      </div>
      <CommandK isOpen={isCmdKOpen} onOpenChange={setCmdKOpen} />
    </EventsProvider>
  )
}
