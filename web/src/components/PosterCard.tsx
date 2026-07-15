// web/src/components/PosterCard.tsx：一张海报卡：图 + 覆盖徽章 + 标题副行。
import type { LibraryItemDTO } from '../api/types.js'
import { coverageBadge, jobActive } from '../lib/badge.js'
import { Poster } from './Poster.js'
import { go } from '../lib/hashRoute.js'

const KIND_LABEL = { series: '剧集', movie: '电影' } as const

/** 副行：年份 · 类型（· 第 N 季处理中）。冷峻，仅陈述事实。 */
function subline(item: LibraryItemDTO): string {
  const parts: string[] = []
  if (item.year) parts.push(String(item.year))
  parts.push(KIND_LABEL[item.kind])
  if (item.kind === 'series' && jobActive(item.job) && item.job) parts.push('处理中')
  return parts.join(' · ')
}

export function PosterCard({ item }: { item: LibraryItemDTO }) {
  const badge = coverageBadge(item.coverage, item.job)
  const title = item.chineseTitle ?? item.name
  const open = () => {
    if (item.kind === 'series') go(`/series/${encodeURIComponent(item.id)}`)
  }
  return (
    <div
      className="card"
      onClick={open}
      role={item.kind === 'series' ? 'link' : undefined}
      tabIndex={item.kind === 'series' ? 0 : undefined}
      onKeyDown={(e) => { if (e.key === 'Enter') open() }}
    >
      <div className="poster">
        <Poster posterPath={item.posterPath} name={title} />
        {badge.text || badge.pulse ? (
          <div className={`badge ${badge.kind}`}>
            {badge.pulse && <span className="dot" />}
            {badge.text}
          </div>
        ) : null}
      </div>
      <div className="meta">
        <div className="title" title={title}>{title}</div>
        <div className="sub">{subline(item)}</div>
      </div>
    </div>
  )
}
