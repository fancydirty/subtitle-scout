// web/src/workflow/Lanes.tsx：Workflow tab 主体——验收修复轮一 Task V4（design §B）重排为两列：
// 窄列 Gaps（原 Pending 泳道原样，泳道标题改"Gaps"）| 宽列 Activity（SummaryLine 顶部人话总览句
// → Now working 卡 → recent 完成行的人话句子流 → 底部 Collapsible「Orchestrator log」默认收起，
// 原 Passes/Workers 两条泳道折叠进 ActivityFeed 一个组件）。移动端（<768px）降级两段折叠 stack
// （沿用既有 Collapsible 单列手法，defaultIsOpen）。
//
// 数据面不变：useWorkflowPending/useWorkflowPasses/useWorkflowWorkers 三个既有轮询 hook（15s、
// 后台不可见暂停）。SSE 直播（TraceRows）走 traceStream.ts 的单例连接，这里只负责在"断线重连"时
// 主动补拉一次 workers 端点（onTraceReconnect），弥补断线窗口期可能漏掉的事件——这条机制零改动。
import { useEffect, useState } from 'react'
import { Collapsible } from '@astryxdesign/core/Collapsible'
import { EmptyState } from '@astryxdesign/core/EmptyState'
import { VStack } from '@astryxdesign/core/VStack'
import { useWorkflowPending, useWorkflowPasses, useWorkflowWorkers } from '../api/hooks.js'
import type { WorkflowPassDTO, WorkflowRecentRunDTO } from '../api/types.js'
import { useT, type TKey } from '../i18n/useT.js'
import { onTraceReconnect } from './traceStream.js'
import { PendingLane } from './PendingLane.js'
import { SummaryLine } from './SummaryLine.js'
import { ActivityFeed } from './ActivityFeed.js'
import { RunDetail, type RunDetailSource } from './RunDetail.js'
import { RerunDialog } from './RerunDialog.js'
import type { RerunRequest } from './rerun.js'

const PASSES_LIMIT = 20
const MOBILE_QUERY = '(max-width: 767px)'

function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(MOBILE_QUERY).matches,
  )
  useEffect(() => {
    if (typeof window === 'undefined') return
    const mql = window.matchMedia(MOBILE_QUERY)
    const onChange = () => setIsMobile(mql.matches)
    onChange()
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])
  return isMobile
}

// 列 eyebrow——uppercase 小号灰 mono（DESIGN.md §3/§6），跟 EpisodeCell/PosterCard 那批
// "组件语言表达不了"的技术级原子样式同一挂：Text 组件没有 className 逃生口（只有 xstyle，
// 项目未装 StyleX 编译插件用不了），这里直接用手写 CSS 类而不是 <Text>。
function LaneHeading({ labelKey }: { labelKey: TKey }) {
  const { t } = useT()
  return <div className="wf-lane-heading">{t(labelKey)}</div>
}

export function Lanes() {
  const { t } = useT()
  const isMobile = useIsMobile()
  const pending = useWorkflowPending()
  const passes = useWorkflowPasses(PASSES_LIMIT)
  const workers = useWorkflowWorkers()
  const now = Date.now()

  // R2D-1（R2 复审）：selectedPass 泛化为 selectedRun——两种来源（pass/worker run）共用同一块
  // RunDetail 右侧板（见 RunDetail.tsx 的 RunDetailSource 判别式联合）。ActivityFeed 内部点开
  // recent 行 / Orchestrator log 里的 pass 行都回调到这里，构造同一个 RunDetailSource——
  // RunDetail 组件本身在这次改动里零改动。
  const [selectedRun, setSelectedRun] = useState<RunDetailSource | null>(null)
  const [rerunRequest, setRerunRequest] = useState<RerunRequest | null>(null)
  const onOpenRun = (run: WorkflowRecentRunDTO) => setSelectedRun({ kind: 'worker', run })
  const onOpenPass = (pass: WorkflowPassDTO) => setSelectedRun({ kind: 'pass', pass })

  // 断线重连补拉：SSE 自动重连成功后主动刷新一次 workers 端点，弥补断线窗口期可能漏掉的直播
  // 事件（server.ts trace-stream 端点注释里的既定约定）。workers.reload 引用稳定
  // （useCallback([load])，load 本身 useCallback([])），这个 effect 只挂载一次。
  useEffect(() => onTraceReconnect(() => workers.reload()), [workers.reload])

  // R2D-4：parked 也是"有事可做"的事实——parked>0 时不许整页宣告 "No active work"（否则与侧栏
  // 甄别角标 N 同屏自相矛盾），改为在空态里给一条通往甄别台的事实句。
  const parkedCount = pending.data?.parked ?? 0
  const allEmpty =
    pending.data != null && pending.data.series.length === 0 && pending.data.movies.length === 0 &&
    passes.data != null && passes.data.length === 0 &&
    workers.data != null && workers.data.running.length === 0 && workers.data.recent.length === 0

  if (allEmpty) {
    return (
      <VStack gap={2}>
        <EmptyState title={t('workflow_empty_title')} description={t('workflow_empty_desc')} />
        {parkedCount > 0 ? (
          <div className="wf-parked-note">
            <a href="#/triage">{`${parkedCount} parked · triage →`}</a>
          </div>
        ) : null}
      </VStack>
    )
  }

  const activityColumn = (
    <VStack gap={4}>
      <SummaryLine pending={pending} workers={workers} />
      <ActivityFeed workers={workers} passes={passes} now={now} onOpenRun={onOpenRun} onOpenPass={onOpenPass} />
    </VStack>
  )

  return (
    <>
      {isMobile ? (
        <VStack gap={6}>
          <Collapsible trigger={<LaneHeading labelKey="workflow_lane_pending" />} defaultIsOpen>
            <PendingLane pending={pending} now={now} onRerun={setRerunRequest} />
          </Collapsible>
          <Collapsible trigger={<LaneHeading labelKey="workflow_lane_activity" />} defaultIsOpen>
            {activityColumn}
          </Collapsible>
        </VStack>
      ) : (
        <div className="wf-lanes">
          <div className="wf-lane">
            <LaneHeading labelKey="workflow_lane_pending" />
            <PendingLane pending={pending} now={now} onRerun={setRerunRequest} />
          </div>
          <div className="wf-lane">
            <LaneHeading labelKey="workflow_lane_activity" />
            {activityColumn}
          </div>
        </div>
      )}

      {selectedRun ? (
        <RunDetail source={selectedRun} now={now} onClose={() => setSelectedRun(null)} onRerun={setRerunRequest} />
      ) : null}
      <RerunDialog request={rerunRequest} onClose={() => setRerunRequest(null)} />
    </>
  )
}
