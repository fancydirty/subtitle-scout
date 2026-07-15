// web/src/components/SeriesDetail.tsx：剧详情：大海报 + 中文名主标题 + 状态摘要 +
// 按季集格子 + 图例 + 工作记录（runs detail 直接人话展示，journalPath 不暴露）。
import { useSeries, useLibrary } from '../api/hooks.js'
import { isJobActive } from '../lib/episode.js'
import { tallySeasons, statusSummary } from '../lib/detail.js'
import { relTime } from '../lib/time.js'
import { Poster } from './Poster.js'
import { EpisodeGrid, Legend } from './EpisodeGrid.js'
import { ErrorState } from './states.js'
import { Brand } from './Brand.js'
import { go } from '../lib/hashRoute.js'
import type { SeriesRunDTO } from '../api/types.js'

function DetailSkeleton() {
  return (
    <div className="detail" aria-busy="true">
      <div className="dposter skel" />
      <div>
        <div className="skel-line wide" />
        <div className="skel-line short" />
        <div className="eps skel-eps">
          {Array.from({ length: 9 }).map((_, i) => <div className="ep skel" key={i} />)}
        </div>
      </div>
    </div>
  )
}

function RunRow({ run, now }: { run: SeriesRunDTO; now: number }) {
  const ok = run.decision === 'download' || run.decision === 'partial' || run.decision === 'realigned'
  return (
    <div className="run">
      <div className="rt">{relTime(run.startedAt, now)}</div>
      <div className={`rd ${ok ? 'ok' : 'no'}`}>{run.detail ?? run.decision ?? '无摘要'}</div>
    </div>
  )
}

export function SeriesDetail({ id }: { id: string }) {
  const { data, loading, error, reload } = useSeries(id)
  const { data: library } = useLibrary()
  const now = Date.now()

  const libItem = library?.find((x) => x.id === id) ?? null
  const jobActive = isJobActive(libItem?.job ?? null)

  return (
    <div className="frame">
      <div className="topbar">
        <Brand />
        <div className="tabs">
          <div className="tab" onClick={() => go('/')} role="link" tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter') go('/') }}>返回海报墙</div>
        </div>
      </div>

      {loading && !data ? (
        <DetailSkeleton />
      ) : error && !data ? (
        <div className="pad"><ErrorState message={error} onRetry={reload} /></div>
      ) : data ? (
        <div className="detail">
          <div>
            <div className="dposter">
              <Poster posterPath={data.posterPath} name={data.chineseTitle ?? data.name} />
            </div>
          </div>
          <div>
            <div className="dname">{data.chineseTitle ?? data.name}</div>
            <div className="dorig">
              {data.chineseTitle && data.chineseTitle !== data.name ? data.name : ''}
              {data.year ? `${data.chineseTitle && data.chineseTitle !== data.name ? ' · ' : ''}${data.year}` : ''}
            </div>
            {(() => {
              const summary = statusSummary(tallySeasons(data.seasons, jobActive))
              return summary ? <div className="dstat">{summary}</div> : null
            })()}

            {data.seasons.map((s) => (
              <EpisodeGrid key={s.season} season={s} jobActive={jobActive} now={now} />
            ))}

            <Legend />

            <div className="runs">
              <h3>工作记录</h3>
              {data.runs.length === 0 ? (
                <div className="run"><div className="rd no">还没有运行记录</div></div>
              ) : (
                data.runs.map((r, i) => <RunRow key={i} run={r} now={now} />)
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
