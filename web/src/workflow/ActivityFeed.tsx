// web/src/workflow/ActivityFeed.tsx：宽列 Activity 主体（验收修复轮一 Task V4，design §B）——
// Now working 卡（原 WorkerCard 的替身：人话卡头 + phraseMode 直播）→ recent 完成行的人话句子流
// （原 RecentRunRow 的替身：主语=剧名/片名，短语=decisionPhrase，铁律①③④⑤）→ 底部 Collapsible
// 「Orchestrator log」默认收起，展开才见回执 chip（原 PassCard 内容整体收纳，工程师内容零删除，
// 只是不再糊脸）。RunDetail/SSE/traceStream/useLiveTrail 机制零改动，这里只是换了一层渲染。
import { Collapsible } from '@astryxdesign/core/Collapsible'
import { StatusDot } from '@astryxdesign/core/StatusDot'
import { Text } from '@astryxdesign/core/Text'
import { VStack } from '@astryxdesign/core/VStack'
import type { Async } from '../api/hooks.js'
import type {
  WorkflowWorkersDTO, WorkflowPassDTO, WorkflowRunningWorkerDTO, WorkflowRecentRunDTO,
} from '../api/types.js'
import { useT } from '../i18n/useT.js'
import { useLiveTrail } from './useLiveTrail.js'
import { TraceRows } from './TraceRows.js'
import { decisionPhrase, type DecisionTone } from './phrases.js'
import { relativeAgo } from './time.js'
import { truncate, receiptChips } from './text.js'

interface Props {
  workers: Async<WorkflowWorkersDTO>
  passes: Async<WorkflowPassDTO[]>
  now: number
  onOpenRun: (row: WorkflowRecentRunDTO) => void
  onOpenPass: (pass: WorkflowPassDTO) => void
}

const TONE_VARIANT: Record<DecisionTone, 'success' | 'neutral' | 'error'> = {
  ok: 'success', neutral: 'neutral', bad: 'error',
}

/** 卡头主语=剧/片名（铁律①：句子主语=内容，不是"worker/job"），名字查无/为空时降级显示 id
 *  ——诚实兜底（收官补刀：running 行的 name join 已在后端补齐，与 recent 行同款待遇）。
 *  realign 任务读作"整理"，find_subtitle 读作"搜索字幕"。 */
function nowWorkingTitle(
  w: Pick<WorkflowRunningWorkerDTO, 'taskType' | 'seriesId' | 'movieId' | 'seriesName' | 'movieName'>,
): string {
  const target = w.seriesName ?? w.movieName ?? w.seriesId ?? w.movieId ?? '?'
  return w.taskType === 'realign' ? `Tidying up ${target}` : `Searching subtitles for ${target}`
}

function NowWorkingCard({ worker, now }: { worker: WorkflowRunningWorkerDTO; now: number }) {
  const trail = useLiveTrail(worker.jobId, worker.trail)
  return (
    <div className="wf-now-card">
      <div className="wf-now-header">
        <span className="wf-dot-active" aria-hidden="true" />
        <span className="wf-now-title">{nowWorkingTitle(worker)}</span>
        <span className="wf-now-elapsed">{relativeAgo(now - worker.startedAtLease)}</span>
      </div>
      <TraceRows events={trail} live phraseMode />
    </div>
  )
}

function NowWorkingSection({ workers, now }: { workers: Async<WorkflowWorkersDTO>; now: number }) {
  const { t } = useT()
  if (workers.loading && !workers.data) {
    return <Text type="code" color="secondary">loading…</Text>
  }
  if (workers.error && !workers.data) {
    return <Text type="code" color="secondary">{workers.error}</Text>
  }
  if (!workers.data) return null
  const { running } = workers.data
  return (
    <VStack gap={2}>
      <Text type="supporting" color="secondary" as="div">
        {t('workflow_workers_running_heading')}
      </Text>
      {running.length === 0 ? (
        <Text type="supporting" color="secondary">
          {t('workflow_workers_running_empty')}
        </Text>
      ) : (
        running.map((w) => <NowWorkingCard key={w.jobId} worker={w} now={now} />)
      )}
    </VStack>
  )
}

/** recent 行主语——剧名/片名优先，缺失（未富化/空名占位）诚实降级为 id（DESIGN.md §8）。 */
function subjectOf(row: WorkflowRecentRunDTO): string {
  return row.seriesName ?? row.movieName ?? row.seriesId ?? row.movieId ?? 'unknown'
}

function ActivityRow({ row, now, onOpen }: { row: WorkflowRecentRunDTO; now: number; onOpen: (row: WorkflowRecentRunDTO) => void }) {
  const phrase = decisionPhrase(row.decision ?? 'unknown')
  const at = row.finishedAt ?? now
  return (
    <button type="button" className="wf-activity-row" onClick={() => onOpen(row)}>
      <StatusDot variant={TONE_VARIANT[phrase.tone]} label={phrase.text} />
      <span className="wf-activity-subject">{subjectOf(row)}</span>
      <span className="wf-activity-sep" aria-hidden="true">
        —
      </span>
      <span className="wf-activity-phrase">{phrase.text}</span>
      <span className="wf-activity-time">{relativeAgo(now - at)}</span>
    </button>
  )
}

function RecentSection({ workers, now, onOpenRun }: { workers: Async<WorkflowWorkersDTO>; now: number; onOpenRun: (row: WorkflowRecentRunDTO) => void }) {
  const { t } = useT()
  if (!workers.data) return null // NowWorkingSection 已经呈现了 loading/error 态，这里不重复渲染
  const { recent } = workers.data
  return (
    <VStack gap={2}>
      <Text type="supporting" color="secondary" as="div">
        {t('workflow_workers_recent_heading')}
      </Text>
      {recent.length === 0 ? (
        <Text type="supporting" color="secondary">
          {t('workflow_workers_recent_empty')}
        </Text>
      ) : (
        // R2D-9 既有先例：key 用 runs.id（恒为主键，唯一），不用 jobId（同一个 job 可能多行 runs）。
        recent.map((r) => <ActivityRow key={r.id} row={r} now={now} onOpen={onOpenRun} />)
      )}
    </VStack>
  )
}

function PassRow({ pass, now, onOpen }: { pass: WorkflowPassDTO; now: number; onOpen: (pass: WorkflowPassDTO) => void }) {
  const chips = receiptChips(pass.receipts)
  const at = pass.finishedAt ?? pass.startedAt
  return (
    <button type="button" className="wf-pass-card" onClick={() => onOpen(pass)}>
      <span className="wf-pass-time">{relativeAgo(now - at)}</span>
      {pass.detail ? <span className="wf-pass-detail">{truncate(pass.detail, 100)}</span> : null}
      {chips.length > 0 ? (
        <span className="wf-chip-row">
          {chips.map((c) => (
            <span className="wf-chip" key={c}>
              {c}
            </span>
          ))}
        </span>
      ) : null}
    </button>
  )
}

function OrchestratorLogBody({ passes, now, onOpenPass }: { passes: Async<WorkflowPassDTO[]>; now: number; onOpenPass: (pass: WorkflowPassDTO) => void }) {
  const { t } = useT()
  if (passes.loading && !passes.data) {
    return <Text type="code" color="secondary">loading…</Text>
  }
  if (passes.error && !passes.data) {
    return <Text type="code" color="secondary">{passes.error}</Text>
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
        <PassRow key={p.id} pass={p} now={now} onOpen={onOpenPass} />
      ))}
    </VStack>
  )
}

export function ActivityFeed({ workers, passes, now, onOpenRun, onOpenPass }: Props) {
  const { t } = useT()
  return (
    <VStack gap={5}>
      <NowWorkingSection workers={workers} now={now} />
      <RecentSection workers={workers} now={now} onOpenRun={onOpenRun} />
      <Collapsible trigger={t('workflow_orchestrator_log_heading')} defaultIsOpen={false}>
        <OrchestratorLogBody passes={passes} now={now} onOpenPass={onOpenPass} />
      </Collapsible>
    </VStack>
  )
}
