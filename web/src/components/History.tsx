// web/src/components/History.tsx：全局运行历史：runs 分页列表（上一页/下一页），人话摘要。
import { useState } from 'react'
import { useRuns, RUNS_PAGE_SIZE } from '../api/hooks.js'
import { relTime } from '../lib/time.js'
import { ErrorState, EmptyState } from './states.js'
import { Brand } from './Brand.js'
import { go } from '../lib/hashRoute.js'

function ListSkeleton() {
  return (
    <div className="runs pad" aria-busy="true">
      {Array.from({ length: 8 }).map((_, i) => (
        <div className="run" key={i}>
          <div className="rt skel-line" />
          <div className="rd skel-line wide" />
        </div>
      ))}
    </div>
  )
}

export function History() {
  const [page, setPage] = useState(0)
  const { data, loading, error, reload } = useRuns(page)
  const now = Date.now()
  const atLast = !data || data.length < RUNS_PAGE_SIZE

  return (
    <div className="frame">
      <div className="topbar">
        <Brand />
        <div className="fact">运行历史</div>
        <div className="tabs">
          <div className="tab" onClick={() => go('/')} role="link" tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter') go('/') }}>返回海报墙</div>
        </div>
      </div>

      {loading && !data ? (
        <ListSkeleton />
      ) : error && !data ? (
        <div className="pad"><ErrorState message={error} onRetry={reload} /></div>
      ) : data && data.length === 0 && page === 0 ? (
        <EmptyState text="还没有运行记录" />
      ) : (
        <>
          <div className="runs pad">
            {(data ?? []).map((r) => {
              const ok = r.decision === 'download' || r.decision === 'partial' || r.decision === 'realigned'
              return (
                <div className="run" key={r.id}>
                  <div className="rt">{relTime(r.startedAt, now)}</div>
                  <div className={`rd ${ok ? 'ok' : 'no'}`}>
                    {r.detail ?? r.decision ?? '无摘要'}
                  </div>
                </div>
              )
            })}
          </div>
          <div className="pager">
            <button className="btn" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
              上一页
            </button>
            <span className="pageno">第 {page + 1} 页</span>
            <button className="btn" disabled={atLast} onClick={() => setPage((p) => p + 1)}>
              下一页
            </button>
          </div>
        </>
      )}
    </div>
  )
}
