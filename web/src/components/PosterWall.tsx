// web/src/components/PosterWall.tsx：首页海报墙：topbar（品牌+事实+过滤 tabs）+ 分区海报墙。
import { useState } from 'react'
import { useLibrary } from '../api/hooks.js'
import { coverageBadge, matchesFilter, type LibraryFilter } from '../lib/badge.js'
import { libraryFacts, factLine } from '../lib/summary.js'
import type { LibraryItemDTO } from '../api/types.js'
import { Brand } from './Brand.js'
import { PosterCard } from './PosterCard.js'
import { WallSkeleton, ErrorState, EmptyState } from './states.js'
import { ReconcileButton } from './ReconcileButton.js'
import { go } from '../lib/hashRoute.js'

const TABS: { id: LibraryFilter; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'missing', label: '缺字幕' },
  { id: 'working', label: '处理中' },
  { id: 'done', label: '已补齐' },
]

// 已知分区块序：剧集 → 动漫 → 电影 → 其他（未知目录名排在已知之后，按名称）
const KNOWN_ORDER = ['剧集', '动漫', '电影']
function sectionRank(s: string): number {
  const i = KNOWN_ORDER.indexOf(s)
  return i === -1 ? KNOWN_ORDER.length : i
}

/** 按 section 分块并排序（空块不产出）。 */
function groupBySection(items: LibraryItemDTO[]): { section: string; items: LibraryItemDTO[] }[] {
  const groups = new Map<string, LibraryItemDTO[]>()
  for (const it of items) {
    const key = it.section || '其他'
    const bucket = groups.get(key)
    if (bucket) bucket.push(it)
    else groups.set(key, [it])
  }
  return [...groups.keys()]
    .sort((a, b) => {
      const ra = sectionRank(a)
      const rb = sectionRank(b)
      return ra !== rb ? ra - rb : a.localeCompare(b, 'zh')
    })
    .map((section) => ({ section, items: groups.get(section)! }))
}

export function PosterWall() {
  const { data, loading, error, reload } = useLibrary()
  const [filter, setFilter] = useState<LibraryFilter>('all')

  const facts = data ? libraryFacts(data) : null
  const visible = (data ?? []).filter((it) =>
    matchesFilter(coverageBadge(it.coverage, it.job), filter)
  )
  const sections = groupBySection(visible)

  return (
    <div className="frame">
      <div className="topbar">
        <Brand />
        <div className="fact">{facts ? factLine(facts) : ''}</div>
        <ReconcileButton />
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
        <div className="sections">
          {sections.map(({ section, items }) => (
            <section key={section} className="wall-section">
              <div className="section-head">
                {section} <span className="section-count">· {items.length} 部</span>
              </div>
              <div className="wall">
                {items.map((it) => (
                  <PosterCard key={it.id} item={it} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}
