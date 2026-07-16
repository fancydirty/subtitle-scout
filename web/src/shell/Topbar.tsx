// web/src/shell/Topbar.tsx：顶栏——面包屑（当前 tab 名，二级面包屑留给后续任务加）+ mono 灰
// 新鲜度行（DESIGN.md §0：存活感来自数据新鲜度，不是"● 守护运行中"式标语）+ ⌘K 键帽触发器。
import { TopNav } from '@astryxdesign/core/TopNav'
import { Breadcrumbs, BreadcrumbItem } from '@astryxdesign/core/Breadcrumbs'
import { HStack } from '@astryxdesign/core/HStack'
import { Text } from '@astryxdesign/core/Text'
import { Kbd } from '@astryxdesign/core/Kbd'
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
  const label = activeMeta ? t(activeMeta.labelKey) : ''

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

  return (
    <TopNav
      label="Breadcrumb and status"
      startContent={
        <Breadcrumbs>
          <BreadcrumbItem isCurrent>{label}</BreadcrumbItem>
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
