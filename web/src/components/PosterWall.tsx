// web/src/components/PosterWall.tsx：首页海报墙：topbar（品牌+事实+过滤 tabs）+ 响应式格子。
import { useState } from 'react'
import { useLibrary } from '../api/hooks.js'
import { coverageBadge, matchesFilter, type LibraryFilter } from '../lib/badge.js'
import { libraryFacts, factLine } from '../lib/summary.js'
import { Brand } from './Brand.js'
import { PosterCard } from './PosterCard.js'
import { WallSkeleton, ErrorState, EmptyState } from './states.js'
import { go } from '../lib/hashRoute.js'

const TABS: { id: LibraryFilter; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'missing', label: '缺字幕' },
  { id: 'working', label: '处理中' },
  { id: 'done', label: '已补齐' },
]

export function PosterWall() {
  const { data, loading, error, reload } = useLibrary()
  const [filter, setFilter] = useState<LibraryFilter>('all')

  const facts = data ? libraryFacts(data) : null
  const visible = (data ?? []).filter((it) =>
    matchesFilter(coverageBadge(it.coverage, it.job), filter)
  )

  return (
    <div className="frame">
      <div className="topbar">
        <Brand />
        <div className="fact">{facts ? factLine(facts) : ''}</div>
        <div className="tabs">
          {TABS.map((t) => (
            <div
              key={t.id}
              className={`tab ${filter === t.id ? 'on' : ''}`}
              onClick={() => setFilter(t.id)}
              role="tab"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter') setFilter(t.id) }}
            >
              {t.label}
            </div>
          ))}
          <div className="tab history-link" onClick={() => go('/history')} role="link" tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter') go('/history') }}>
            记录
          </div>
        </div>
      </div>

      {loading && !data ? (
        <WallSkeleton />
      ) : error && !data ? (
        <ErrorState message={error} onRetry={reload} />
      ) : data && data.length === 0 ? (
        <EmptyState text="起 watch 后这里会出现你的库" />
      ) : visible.length === 0 ? (
        <EmptyState text="这个筛选下暂时没有条目" />
      ) : (
        <div className="wall">
          {visible.map((it) => (
            <PosterCard key={it.id} item={it} />
          ))}
        </div>
      )}
    </div>
  )
}
