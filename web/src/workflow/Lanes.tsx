// web/src/workflow/Lanes.tsx：Workflow tab 主体——三泳道桌面主视图（DESIGN.md §6/任务规格：
// 左=pending 活文档 / 中=orchestrator passes / 右=workers 直播），移动端（<768px）降级三段
// 折叠 stack（mockup B 方向，见 .superpowers/brainstorm/…/workflow-page.html 的方案 B）。
//
// 数据面：useWorkflowPending 复用 F2 既有 hook（顶栏新鲜度行同一份轮询口径），
// useWorkflowPasses/useWorkflowWorkers 是本战役新增的同款轮询 hook（15s、后台不可见暂停）。
// SSE 直播（TraceRows）走 traceStream.ts 的单例连接，这里只负责在"断线重连"时主动补拉一次
// workers 端点（onTraceReconnect），弥补断线窗口期可能漏掉的事件。
import { useEffect, useState } from 'react'
import { Collapsible } from '@astryxdesign/core/Collapsible'
import { EmptyState } from '@astryxdesign/core/EmptyState'
import { StatusDot } from '@astryxdesign/core/StatusDot'
import { Text } from '@astryxdesign/core/Text'
import { VStack } from '@astryxdesign/core/VStack'
import { useWorkflowPending, useWorkflowPasses, useWorkflowWorkers, type Async } from '../api/hooks.js'
import type { WorkflowPassDTO, WorkflowWorkersDTO, WorkflowRecentRunDTO } from '../api/types.js'
import { useT, type TKey } from '../i18n/useT.js'
import { onTraceReconnect } from './traceStream.js'
import { relativeAgo } from './time.js'
import { truncate, decisionVariant } from './text.js'
import { PendingLane } from './PendingLane.js'
import { PassCard } from './PassCard.js'
import { WorkerCard } from './WorkerCard.js'
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

// 泳道 eyebrow——uppercase 小号灰 mono（DESIGN.md §3/§6），跟 EpisodeCell/PosterCard 那批
// "组件语言表达不了"的技术级原子样式同一挂：Text 组件没有 className 逃生口（只有 xstyle，
// 项目未装 StyleX 编译插件用不了），这里直接用手写 CSS 类而不是 <Text>。
function LaneHeading({ labelKey }: { labelKey: TKey }) {
  const { t } = useT()
  return <div className="wf-lane-heading">{t(labelKey)}</div>
}

function PassesLaneBody({
  passes, now, onOpen,
}: {
  passes: Async<WorkflowPassDTO[]>
  now: number
  onOpen: (pass: WorkflowPassDTO) => void
}) {
  const { t } = useT()
  if (passes.loading && !passes.data) {
    return (
      <Text type="code" color="secondary">
        loading…
      </Text>
    )
  }
  if (passes.error && !passes.data) {
    return (
      <Text type="code" color="secondary">
        {passes.error}
      </Text>
    )
  }
  if (!passes.data) return null
  if (passes.data.length === 0) {
    return (
      <Text type="supporting" color="secondary">
        {t('workflow_passes_lane_empty')}
      </Text>
    )
  }
  return (
    <VStack gap={2}>
      {passes.data.map((p) => (
        <PassCard key={p.id} pass={p} now={now} onOpen={onOpen} />
      ))}
    </VStack>
  )
}

// R2D-1+9（R2 复审）：Recent 行现在可点开 RunDetail（worker run 详情入口——之前完全没有任何
// 途径查看一条 worker run 的完整 detail/快照回放，审计定罪的入口缺失）；同一次改动顺带修了
// React key 用 jobId 的重复隐患（同一个 job 多行 runs 时 jobId 不唯一，见下方 WorkersLaneBody
// 的 key 改法）——按钮化 + key 改用 runs.id 是同一处代码改动，拆成两次改动反而各自都不完整。
function RecentRunRow({ row, now, onOpen }: { row: WorkflowRecentRunDTO; now: number; onOpen: (row: WorkflowRecentRunDTO) => void }) {
  const variant = decisionVariant(row.decision)
  const label = row.decision ?? 'unknown'
  const at = row.finishedAt ?? now
  return (
    <button type="button" className="wf-recent-row" onClick={() => onOpen(row)}>
      <StatusDot variant={variant} label={label} />
      <span className="wf-recent-decision">{label}</span>
      {row.detail ? <span className="wf-recent-detail">{truncate(row.detail, 70)}</span> : null}
      <span className="wf-recent-time">{relativeAgo(now - at)}</span>
    </button>
  )
}

function WorkersLaneBody({
  workers, now, onOpenRun,
}: {
  workers: Async<WorkflowWorkersDTO>
  now: number
  onOpenRun: (row: WorkflowRecentRunDTO) => void
}) {
  const { t } = useT()
  if (workers.loading && !workers.data) {
    return (
      <Text type="code" color="secondary">
        loading…
      </Text>
    )
  }
  if (workers.error && !workers.data) {
    return (
      <Text type="code" color="secondary">
        {workers.error}
      </Text>
    )
  }
  if (!workers.data) return null
  const { running, recent } = workers.data
  return (
    <VStack gap={4}>
      <VStack gap={2}>
        <Text type="supporting" color="secondary" as="div">
          {t('workflow_workers_running_heading')}
        </Text>
        {running.length === 0 ? (
          <Text type="supporting" color="secondary">
            {t('workflow_workers_running_empty')}
          </Text>
        ) : (
          running.map((w) => <WorkerCard key={w.jobId} worker={w} />)
        )}
      </VStack>
      <VStack gap={2}>
        <Text type="supporting" color="secondary" as="div">
          {t('workflow_workers_recent_heading')}
        </Text>
        {recent.length === 0 ? (
          <Text type="supporting" color="secondary">
            {t('workflow_workers_recent_empty')}
          </Text>
        ) : (
          // R2D-9：key 改用 runs.id（恒为主键，唯一）——旧的 `r.jobId ?? i` 在同一个 job 有多行
          // runs 时（installed/no_safe_match/retry_later 各一行、或同 job 重跑多次）会产出重复
          // key，React 用 index 兜底导致行错配复用（重排序时 StatusDot/detail 文本可能对不上）。
          recent.map((r) => <RecentRunRow key={r.id} row={r} now={now} onOpen={onOpenRun} />)
        )}
      </VStack>
    </VStack>
  )
}

export function Lanes() {
  const { t } = useT()
  const isMobile = useIsMobile()
  const pending = useWorkflowPending()
  const passes = useWorkflowPasses(PASSES_LIMIT)
  const workers = useWorkflowWorkers()
  const now = Date.now()

  // R2D-1（R2 复审）：selectedPass 泛化为 selectedRun——两种来源（pass/worker run）共用同一块
  // RunDetail 右侧板（见 RunDetail.tsx 的 RunDetailSource 判别式联合）。
  const [selectedRun, setSelectedRun] = useState<RunDetailSource | null>(null)
  const [rerunRequest, setRerunRequest] = useState<RerunRequest | null>(null)

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

  return (
    <>
      {isMobile ? (
        <VStack gap={6}>
          <Collapsible trigger={<LaneHeading labelKey="workflow_lane_pending" />} defaultIsOpen>
            <PendingLane pending={pending} now={now} onRerun={setRerunRequest} />
          </Collapsible>
          <Collapsible trigger={<LaneHeading labelKey="workflow_lane_passes" />} defaultIsOpen>
            <PassesLaneBody passes={passes} now={now} onOpen={(pass) => setSelectedRun({ kind: 'pass', pass })} />
          </Collapsible>
          <Collapsible trigger={<LaneHeading labelKey="workflow_lane_workers" />} defaultIsOpen>
            <WorkersLaneBody workers={workers} now={now} onOpenRun={(run) => setSelectedRun({ kind: 'worker', run })} />
          </Collapsible>
        </VStack>
      ) : (
        <div className="wf-lanes">
          <div className="wf-lane">
            <LaneHeading labelKey="workflow_lane_pending" />
            <PendingLane pending={pending} now={now} onRerun={setRerunRequest} />
          </div>
          <div className="wf-lane">
            <LaneHeading labelKey="workflow_lane_passes" />
            <PassesLaneBody passes={passes} now={now} onOpen={(pass) => setSelectedRun({ kind: 'pass', pass })} />
          </div>
          <div className="wf-lane">
            <LaneHeading labelKey="workflow_lane_workers" />
            <WorkersLaneBody workers={workers} now={now} onOpenRun={(run) => setSelectedRun({ kind: 'worker', run })} />
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
