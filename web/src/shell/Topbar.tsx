// web/src/shell/Topbar.tsx：顶栏——面包屑（当前 tab 名，dashboard-F3 起 Library 剧集页有二级
// 面包屑：Library / 剧名）+ mono 灰新鲜度行（DESIGN.md §0：存活感来自数据新鲜度，不是"● 守护
// 运行中"式标语）+ ⌘K 键帽触发器。
import { TopNav } from '@astryxdesign/core/TopNav'
import { Breadcrumbs, BreadcrumbItem } from '@astryxdesign/core/Breadcrumbs'
import { HStack } from '@astryxdesign/core/HStack'
import { Text } from '@astryxdesign/core/Text'
import { Kbd } from '@astryxdesign/core/Kbd'
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
    <TopNav
      label="Breadcrumb and status"
      startContent={
        <Breadcrumbs>
          {seriesCrumb ? (
            <BreadcrumbItem href="#/library">{rootLabel}</BreadcrumbItem>
          ) : (
            <BreadcrumbItem isCurrent>{rootLabel}</BreadcrumbItem>
          )}
          {seriesCrumb ? <BreadcrumbItem isCurrent>{seriesCrumb}</BreadcrumbItem> : null}
        </Breadcrumbs>
      }
      endContent={
        <HStack gap={3} vAlign="center">
          <Text type="code" color="secondary">
            {freshness}
          </Text>
          <button type="button" className="cmdk-trigger" onClick={onOpenCmdK}>
            <Text type="supporting" color="secondary" as="span">
              {t('cmdk_trigger')}
            </Text>
            <Kbd keys="mod+k" />
          </button>
        </HStack>
      }
    />
  )
}
