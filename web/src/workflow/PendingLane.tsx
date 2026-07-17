// web/src/workflow/PendingLane.tsx：左泳道——机械层产出的缺口事实清单（活文档行），
// DESIGN.md §6："左=待处理事实（活文档行：缺口/停牌计数/nextRecheckAt）"。series 行 hover 出
// Rerun（DESIGN 任务规格："Pending 泳道每 series 行 hover 出 Rerun"——movie 行没有这个扳手：
// POST /api/v2/workflow/redispatch 的请求体只认 seriesId，压根没有 movieId 字段，见
// src/dashboard/apiV2.ts 的 REDISPATCH_SCHEMA，movie 行加一个点不动的按钮既误导又是死代码）。
import { useState } from 'react'
import { Switch } from '@astryxdesign/core/Switch'
import { Button } from '@astryxdesign/core/Button'
import { Text } from '@astryxdesign/core/Text'
import type { Async } from '../api/hooks.js'
import type { WorkflowPendingDTO, WorkflowPendingSeriesDTO, WorkflowPendingMovieDTO } from '../api/types.js'
import { useT } from '../i18n/useT.js'
import { missingBadge, throttledLine, truncate } from './text.js'
import type { RerunRequest } from './rerun.js'

interface Props {
  pending: Async<WorkflowPendingDTO>
  now: number
  onRerun: (request: RerunRequest) => void
}

function SeriesRow({ row, now, onRerun }: { row: WorkflowPendingSeriesDTO; now: number; onRerun: (r: RerunRequest) => void }) {
  const { t } = useT()
  // 初始值按当前行事实判定：0 缺口且纯停牌时，Rerun 不含停牌集就是空派，因此预开；
  // 有真缺口时维持默认关。该初始值仅在首次渲染生效，行数据后续轮询变化不跟随。
  const [includeThrottled, setIncludeThrottled] = useState(row.missing === 0 && row.throttled > 0)
  const throttled = throttledLine(row.throttled, row.nextRecheckAt, now)

  return (
    <div className="wf-pending-row">
      <div className="wf-pending-row-main">
        <span className="wf-pending-row-title">
          {row.seriesName} · S{row.season}
        </span>
        <span className="wf-pending-row-badge">{missingBadge(row.missing)}</span>
      </div>
      {throttled ? (
        <div className="wf-pending-row-throttled">
          <span className="wf-dot-neutral" aria-hidden="true" />
          <span>{throttled}</span>
        </div>
      ) : null}
      {row.sampleReason ? <div className="wf-pending-row-reason">{truncate(row.sampleReason, 70)}</div> : null}
      <div className="wf-pending-row-actions">
        <Switch
          label={t('workflow_rerun_include_throttled_label')}
          description={t('workflow_rerun_include_throttled_desc')}
          value={includeThrottled}
          onChange={setIncludeThrottled}
          labelSpacing="hug"
        />
        <Button
          size="sm"
          variant="secondary"
          label={t('workflow_pending_rerun_label')}
          onClick={() =>
            onRerun({ seriesId: row.seriesId, seriesName: row.seriesName, season: row.season, includeThrottled })
          }
        />
      </div>
    </div>
  )
}

function MovieRow({ row, now }: { row: WorkflowPendingMovieDTO; now: number }) {
  const throttled = throttledLine(row.throttled, row.nextRecheckAt, now)
  return (
    <div className="wf-pending-row">
      <div className="wf-pending-row-main">
        <span className="wf-pending-row-title">{row.name}</span>
        {row.missing > 0 ? <span className="wf-pending-row-badge">{missingBadge(row.missing)}</span> : null}
      </div>
      {throttled ? (
        <div className="wf-pending-row-throttled">
          <span className="wf-dot-neutral" aria-hidden="true" />
          <span>{throttled}</span>
        </div>
      ) : null}
      {row.sampleReason ? <div className="wf-pending-row-reason">{truncate(row.sampleReason, 70)}</div> : null}
    </div>
  )
}

export function PendingLane({ pending, now, onRerun }: Props) {
  const { t } = useT()

  if (pending.loading && !pending.data) {
    return <Text type="code" color="secondary">loading…</Text>
  }
  if (pending.error && !pending.data) {
    return (
      <Text type="code" color="secondary">
        {pending.error}
      </Text>
    )
  }
  if (!pending.data) return null

  const { series, movies, parked } = pending.data
  // R2D-4（spec §5）：左泳道的甄别计数入口——parked 是活文档之外的另一种"待办事实"，在这条
  // 泳道给一行通往甄别台的事实句（Workflow 区恒英文）。
  const parkedNote =
    parked > 0 ? (
      <div className="wf-parked-note">
        <a href="#/triage">{`${parked} parked · triage →`}</a>
      </div>
    ) : null

  if (series.length === 0 && movies.length === 0) {
    return (
      <>
        <Text type="supporting" color="secondary">
          {t('workflow_pending_lane_empty')}
        </Text>
        {parkedNote}
      </>
    )
  }

  return (
    <div className="wf-pending-lane">
      {parkedNote}
      {series.length > 0 ? (
        <div className="wf-pending-group">
          <Text type="supporting" color="secondary" as="div">
            {t('workflow_pending_series_heading')}
          </Text>
          {series.map((row) => (
            <SeriesRow key={`${row.seriesId}-${row.season}`} row={row} now={now} onRerun={onRerun} />
          ))}
        </div>
      ) : null}
      {movies.length > 0 ? (
        <div className="wf-pending-group">
          <Text type="supporting" color="secondary" as="div">
            {t('workflow_pending_movies_heading')}
          </Text>
          {movies.map((row) => (
            <MovieRow key={row.id} row={row} now={now} />
          ))}
        </div>
      ) : null}
    </div>
  )
}
