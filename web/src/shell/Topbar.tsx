// web/src/shell/Topbar.tsx：顶栏——面包屑（当前 tab 名，dashboard-F3 起 Library 剧集页有二级
// 面包屑：Library / 剧名）+ mono 灰新鲜度行（DESIGN.md §0：存活感来自数据新鲜度，不是"● 守护
// 运行中"式标语）+ ⌘K 键帽触发器。
//
// Task 28 卸 Astryx：TopNav/Breadcrumbs/HStack/Text 换成语义标记 + Tailwind 类，Kbd 换
// Task 8 自绘件（components/ui/kbd.tsx，keys="mod+k" 零改）。min-h-[46px] 是现网 TopNav 的
// 实测量（padding 8px×2 + 内容 30px），styles.css 的 .wf-rundetail-panel{top:46px} 钉死了
// 这条契约——顶栏矮一像素，RunDetail 固定面板顶上就漏一条滚动内容的缝。
import { Kbd } from '../components/ui/kbd.js'
import type { Async } from '../api/hooks.js'
import type { WorkflowPendingDTO, LibrarySeriesDetailDTO } from '../api/types.js'
import { useT } from '../i18n/useT.js'
import { formatFreshness } from './freshness.js'
import { TABS } from './tabs.js'
import type { Tab } from './route.js'

interface Props {
  tab: Tab
  workflow: Async<WorkflowPendingDTO>
  /** dashboard-F3：非 null 时说明当前在 #/library/:id 剧集详情页——渲染二级面包屑。Shell 只在
   *  route.libraryId 命中时才把这份数据传进来（同一次请求也喂给 SeriesPage，不重复发）。 */
  seriesDetail: Async<LibrarySeriesDetailDTO> | null
  onOpenCmdK: () => void
}

export function Topbar({ tab, workflow, seriesDetail, onOpenCmdK }: Props) {
  const { t } = useT()
  const activeMeta = TABS.find((m) => m.id === tab)
  const rootLabel = activeMeta ? t(activeMeta.labelKey) : ''

  // 优雅降级：本地无 daemon 时这个请求会失败——data 一直是 null，但绝不许因此整行消失或白屏，
  // 用同样冷静的 mono 灰字给出诚实读数（"data honesty"：呈现事实，不装作"一切正常"）。
  let freshness: string
  if (workflow.data) {
    freshness = formatFreshness(workflow.data.meta, Date.now())
  } else if (workflow.error) {
    freshness = 'offline'
  } else {
    freshness = 'loading…'
  }

  // 二级面包屑同一套"诚实降级"：剧名没到位前用短促技术词占位（跟新鲜度行的 'loading…'/'offline'
  // 同一挂），不许让面包屑在数据没回来前直接消失或空白跳动。
  let seriesCrumb: string | null = null
  if (seriesDetail) {
    if (seriesDetail.data) {
      seriesCrumb = seriesDetail.data.series.chineseTitle ?? seriesDetail.data.series.name
    } else if (seriesDetail.error) {
      seriesCrumb = 'unavailable'
    } else {
      seriesCrumb = 'loading…'
    }
  }

  return (
    <div className="flex min-h-[46px] items-center justify-between border-b border-border px-4 py-2">
      {/* aria-current 落在 <li> 上的前提：两个分支的当前页面包屑都是纯文本（无链接）——
          Astryx navigation-11 的形状（焦点落在链接上、aria-current 却在父级 li 时不播报）
          在这里不可能发生。哪天有人把当前页包成 <a>，aria-current 必须跟着移到那个 <a> 上。
          min-w-0 + truncate：长剧名（CJK 无空格、min-content 极宽）在窄视口下允许 nav 收缩、
          当前级省略号截断，右组（新鲜度行 + ⌘K 触发器）不被推出屏外——等价于 Astryx TopNav
          左段的 flex:1 1 0 + minWidth:0。truncate 保 textContent 全文，getByText 断言不受影响。 */}
      <nav aria-label="Breadcrumb" className="min-w-0">
        <ol className="flex items-center gap-1 text-sm leading-5">
          {seriesCrumb ? (
            <li>
              <a href="#/library" className="text-muted-foreground hover:underline">
                {rootLabel}
              </a>
            </li>
          ) : (
            <li aria-current="page" className="truncate text-foreground">
              {rootLabel}
            </li>
          )}
          {seriesCrumb ? (
            <>
              <li aria-hidden="true" className="select-none text-muted-foreground">
                /
              </li>
              <li aria-current="page" className="truncate text-foreground">
                {seriesCrumb}
              </li>
            </>
          ) : null}
        </ol>
      </nav>
      <div className="flex items-center gap-3">
        <span className="font-mono text-[13px] leading-5 text-muted-foreground">{freshness}</span>
        <button type="button" className="cmdk-trigger" onClick={onOpenCmdK}>
          <span className="text-xs text-muted-foreground">{t('cmdk_trigger')}</span>
          <Kbd keys="mod+k" />
        </button>
      </div>
    </div>
  )
}
