// web/src/shell/AppShell.tsx：新外壳组装——Astryx AppShell + Sidebar + Topbar + CommandK +
// 四 tab 路由分发。数据面只发一次 GET /api/v2/workflow/pending，顶栏新鲜度行与侧栏甄别角标
// 共享同一份响应（后端契约：meta.roots/lastScanAt/files + parked，见 api/types.ts 注释）。
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
// dashboard-F5：Triage tab 落地为真页面（TriagePage：两箱 + 认领对话框），同 Lanes 的自洽
// 口径——自己发 GET /api/v2/triage，跟外壳共享的只有侧栏角标（那份 parked 计数来自
// workflow/pending，不是 triage 端点，两者的数据源不同步是可接受的：15s 轮询 vs 手动 reload）。
import { useState } from 'react'
import { AppShell as AstryxAppShell } from '@astryxdesign/core/AppShell'
import { useWorkflowPending, useLibrarySeriesDetail } from '../api/hooks.js'
import { useShellRoute } from './route.js'
import { Sidebar } from './Sidebar.js'
import { Topbar } from './Topbar.js'
import { CommandK } from './CommandK.js'
import { EngineBanner } from './EngineBanner.js'
import { SeriesGrid } from '../library/SeriesGrid.js'
import { SeriesPage } from '../library/SeriesPage.js'
import { ActivityPage } from '../activity/ActivityPage.js'
import { TriagePage } from '../triage/TriagePage.js'
import { SettingsPage } from '../settings/SettingsPage.js'

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

  return (
    <>
      <AstryxAppShell
        contentPadding={route.tab === 'library' ? 0 : 4}
        topNav={
          <Topbar
            tab={route.tab}
            workflow={workflow}
            seriesDetail={activeSeriesDetail}
            onOpenCmdK={() => setCmdKOpen(true)}
          />
        }
        sideNav={<Sidebar tab={route.tab} parked={workflow.data?.parked} />}>
        {/* 引擎关闭 banner 压所有主屏顶（spec A §5.6）；library 的 contentPadding=0 下
            它就是全宽出血细条，正好。 */}
        <EngineBanner />
        {route.tab === 'library' &&
          (route.libraryId ? (
            // key=libraryId：切换到另一部剧时强制重挂载，SeriesPage 内部的格阵选中态
            // （EpisodeDetail 开合）不会带着上一部剧的选中集号跨剧残留。
            <SeriesPage key={route.libraryId} detail={seriesDetail} />
          ) : (
            <SeriesGrid />
          ))}
        {route.tab === 'workflow' && <ActivityPage />}
        {route.tab === 'triage' && <TriagePage />}
        {route.tab === 'settings' && <SettingsPage />}
      </AstryxAppShell>
      <CommandK isOpen={isCmdKOpen} onOpenChange={setCmdKOpen} />
    </>
  )
}
