// web/src/shell/Topbar.tsx：顶栏——面包屑（当前 tab 名）+ mono 灰新鲜度行（DESIGN.md §0：
// 存活感来自数据新鲜度，不是"● 守护运行中"式标语）+ ⌘K 键帽触发器。
//
// Task 28 卸 Astryx：TopNav/Breadcrumbs/HStack/Text 换成语义标记 + Tailwind 类，Kbd 换
// Task 8 自绘件（components/ui/kbd.tsx，keys="mod+k" 零改）。min-h-[46px] 是现网 TopNav 的
// 实测量（padding 8px×2 + 内容 30px），styles.css 的 .wf-rundetail-panel{top:46px} 钉死了
// 这条契约——顶栏矮一像素，RunDetail 固定面板顶上就漏一条滚动内容的缝。
//
// ── 2026-08-12（Task ⑪）：**面包屑回到一级**，二级（剧名）随旧 library 页面下架 ──────
// dashboard-F3 时代这里有个 `seriesDetail` prop：在 `#/library/:id` 剧集详情页上渲染
// 第二级面包屑（Library / 剧名），数据由 Shell 发一次、面包屑与页面主体共享。
// 旧 library 页已移入 `web/src/_legacy/`，那条路由也不复存在（`#/library*` 被
// route.ts 的 LEGACY_REDIRECTS 改写到 `#/media`），于是 prop、它的三态降级分支
// （loading…/unavailable/剧名）与 Shell 里的 `useLibrarySeriesDetail` 调用一并删除。
//
// 🔴 **不是"留着反正为 null"**：留下来的话它是一段永不执行的分支 + 一个每次渲染都白算的
// hook，正是本仓「谁写/谁读/谁触发」缺一的病 A 形态。今天的新媒体库详情页 (#/media/:workId)
// **刻意不复用它**——那页自己在页头画返回链接与作品名（见 AppShell 注释）。将来若要给
// 新页面加二级面包屑，那是一次独立的产品动作，届时按 media 的 id 空间重新接线，
// 而不是把这段旧的 series 接线捞回来。
import { Kbd } from '../components/ui/kbd.js'
import type { Async } from '../api/hooks.js'
import type { WorkflowPendingDTO } from '../api/types.js'
import { useT } from '../i18n/useT.js'
import { formatFreshness } from './freshness.js'
import { TABS } from './tabs.js'
import type { Tab } from './route.js'

interface Props {
  tab: Tab
  workflow: Async<WorkflowPendingDTO>
  onOpenCmdK: () => void
}

export function Topbar({ tab, workflow, onOpenCmdK }: Props) {
  const { t } = useT()
  const activeMeta = TABS.find((m) => m.id === tab)
  const rootLabel = activeMeta ? t(activeMeta.labelKey) : ''

  // 优雅降级：本地无 daemon 时这个请求会失败——data 一直是 null，但绝不许因此整行消失或白屏，
  // 用同样冷静的 mono 灰字给出诚实读数（"data honesty"：呈现事实，不装作"一切正常"）。
  let freshness: string
  if (workflow.data) {
    freshness = formatFreshness(workflow.data.meta, Date.now())
  } else if (workflow.error) {
    freshness = t('common_offline')
  } else {
    freshness = t('topbar_loading')
  }

  return (
    <div className="flex min-h-[46px] items-center justify-between border-b border-border px-4 py-2">
      {/* aria-current 落在 <li> 上的前提：当前页面包屑是纯文本（无链接）——
          Astryx navigation-11 的形状（焦点落在链接上、aria-current 却在父级 li 时不播报）
          在这里不可能发生。哪天有人把当前页包成 <a>，aria-current 必须跟着移到那个 <a> 上。
          min-w-0 + truncate：长标签在窄视口下允许 nav 收缩、当前级省略号截断，右组
          （新鲜度行 + ⌘K 触发器）不被推出屏外——等价于 Astryx TopNav 左段的
          flex:1 1 0 + minWidth:0。truncate 保 textContent 全文，getByText 断言不受影响。 */}
      <nav aria-label={t('a11y_breadcrumb')} className="min-w-0">
        <ol className="flex items-center gap-1 text-sm leading-5">
          <li aria-current="page" className="truncate text-foreground">
            {rootLabel}
          </li>
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
