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
import { relativeAgo, formatResetsIn } from './time.js'
import { truncate, receiptChips, collapseRecentRuns } from './text.js'

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
 *  realign 任务读作"整理"，find_subtitle 读作"搜索字幕"，translate 读作"翻译"
 *  （审计 UX-P0：此前合成 id 'translate:<itemId>' 被当剧名裸奔）。 */
function nowWorkingTitle(
  w: Pick<WorkflowRunningWorkerDTO, 'taskType' | 'seriesId' | 'movieId' | 'seriesName' | 'movieName'>,
): string {
  const target = w.seriesName ?? w.movieName ?? w.seriesId ?? w.movieId ?? '?'
  if (w.taskType === 'realign') return `Tidying up ${target}`
  if (w.taskType === 'translate') return `Translating subtitles for ${target}`
  return `Searching subtitles for ${target}`
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

/** 债务 D3：provider 配额事实句——中性灰点，不是告警（五铁律：failure/wait 中性措辞）。
 *  数据源=workers.providerQuota（后端已滤过期）；空数组=不渲染任何东西。Workflow 区英文
 *  铁律，不进 i18n。 */
function QuotaFactsSection({ workers, now }: { workers: Async<WorkflowWorkersDTO>; now: number }) {
  const quota = workers.data?.providerQuota ?? []
  if (quota.length === 0) return null
  return (
    <VStack gap={1}>
      {quota.map((q) => {
        const resetMs = q.resetAt != null ? Date.parse(q.resetAt) : NaN
        const suffix = Number.isFinite(resetMs) ? ` · ${formatResetsIn(resetMs - now)}` : ''
        return (
          <div className="wf-quota-fact" key={q.provider}>
            <StatusDot variant="neutral" label={`${q.provider} quota exhausted${suffix}`} />
            <span className="wf-quota-text">{`${q.provider} quota exhausted${suffix}`}</span>
          </div>
        )
      })}
    </VStack>
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

function ActivityRow({ row, count, now, onOpen }: { row: WorkflowRecentRunDTO; count: number; now: number; onOpen: (row: WorkflowRecentRunDTO) => void }) {
  // 2026-07-30 用户裁决（DESIGN.md §7）：decision 人话句跟随 UI 语言。tone 与语言无关，
  // 圆点色因此不受语言影响（铁律④在中英两边同样成立）。
  const { lang } = useT()
  const phrase = decisionPhrase(row.decision ?? 'unknown', lang)
  const at = row.finishedAt ?? now
  return (
    <button type="button" className="wf-activity-row" onClick={() => onOpen(row)}>
      <StatusDot variant={TONE_VARIANT[phrase.tone]} label={phrase.text} />
      <span className="wf-activity-subject">{subjectOf(row)}</span>
      <span className="wf-activity-sep" aria-hidden="true">
        —
      </span>
      <span className="wf-activity-phrase">{phrase.text}</span>
      {row.llmCalls != null && row.llmCalls > 0 ? (
        <span className="wf-activity-count" aria-label={`${row.llmCalls} llm calls`}>
          · {row.llmCalls} calls
        </span>
      ) : null}
      {count > 1 ? (
        <span className="wf-activity-count" aria-label={`${count} retries`}>
          × {count}
        </span>
      ) : null}
      <span className="wf-activity-time">{relativeAgo(now - at)}</span>
    </button>
  )
}

/** 审计 UX-P0:held 区——fail-closed 拦下的翻译不再落库隐身。灰点+下次重试相对时间,
 *  点开复用 RunDetail 现有面板(held job 的最新 run 即其证据)。空数组不渲染。 */
function HeldSection({ workers, now, onOpenRun }: { workers: Async<WorkflowWorkersDTO>; now: number; onOpenRun: (row: WorkflowRecentRunDTO) => void }) {
  if (!workers.data || workers.data.held.length === 0) return null
  const { held, recent } = workers.data
  return (
    <VStack gap={2}>
      <Text type="supporting" color="secondary" as="div">
        Translation held
      </Text>
      {held.map((h) => {
        const run = recent.find((r) => r.jobId === h.jobId)
        return (
          <button
            type="button"
            className="wf-activity-row"
            key={h.jobId}
            onClick={() => run && onOpenRun(run)}
          >
            <StatusDot variant="neutral" label="held" />
            <span className="wf-activity-subject">{h.itemId ?? `job ${h.jobId}`}</span>
            <span className="wf-activity-phrase">{h.reason ?? 'held'}</span>
            <span className="wf-activity-time">
              {h.nextRetryAt != null ? `retry in ${relativeAgo(h.nextRetryAt - now)}` : ''}
            </span>
          </button>
        )
      })}
    </VStack>
  )
}

function RecentSection({ workers, now, onOpenRun }: { workers: Async<WorkflowWorkersDTO>; now: number; onOpenRun: (row: WorkflowRecentRunDTO) => void }) {
  const { t } = useT()
  if (!workers.data) return null // NowWorkingSection 已经呈现了 loading/error 态，这里不重复渲染
  const { recent } = workers.data
  const folded = collapseRecentRuns(recent)
  return (
    <VStack gap={2}>
      <Text type="supporting" color="secondary" as="div">
        {t('workflow_workers_recent_heading')}
      </Text>
      {folded.length === 0 ? (
        <Text type="supporting" color="secondary">
          {t('workflow_workers_recent_empty')}
        </Text>
      ) : (
        // R2D-9 既有先例：key 用 runs.id（恒为主键，唯一），不用 jobId（同一个 job 可能多行 runs）。
        // 折叠后 key 仍用代表行的 id（折叠段以最新那条为代表）。
        folded.map((f) => <ActivityRow key={f.row.id} row={f.row} count={f.count} now={now} onOpen={onOpenRun} />)
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
      <QuotaFactsSection workers={workers} now={now} />
      <NowWorkingSection workers={workers} now={now} />
      <HeldSection workers={workers} now={now} onOpenRun={onOpenRun} />
      <RecentSection workers={workers} now={now} onOpenRun={onOpenRun} />
      <Collapsible trigger={t('workflow_orchestrator_log_heading')} defaultIsOpen={false}>
        <OrchestratorLogBody passes={passes} now={now} onOpenPass={onOpenPass} />
      </Collapsible>
    </VStack>
  )
}
