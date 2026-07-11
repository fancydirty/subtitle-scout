// web/src/components/EpisodeGrid.tsx：按季分节的集覆盖格子，照设计稿 CSS 类名
// （cov/emb/miss/work/unav/review——review 是 task 2 新增的 ask_user 待确认态）。
import type { SeriesSeasonDTO } from '../api/types.js'
import { episodeCellState } from '../lib/episode.js'
import { unavailableTooltip, needsReviewTooltip } from '../lib/detail.js'

export function EpisodeGrid({
  season,
  jobActive,
  now,
}: {
  season: SeriesSeasonDTO
  jobActive: boolean
  now: number
}) {
  return (
    <div className="season">
      <h3>第 {season.season} 季</h3>
      <div className="eps">
        {season.episodes.map((ep) => {
          const state = episodeCellState(ep, jobActive)
          const title =
            state === 'unav' ? unavailableTooltip(ep, now)
            : state === 'review' ? needsReviewTooltip(ep, now)
            : undefined
          return (
            <div className={`ep ${state}`} key={ep.id} title={title}>
              {ep.episode}
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function Legend() {
  return (
    <div className="legend">
      <span><i className="sw cov" />已补齐</span>
      <span><i className="sw emb" />自带中字</span>
      <span><i className="sw miss" />缺字幕</span>
      <span><i className="sw review" />找到候选，待确认</span>
      <span><i className="sw unav" />暂时没找到（会定期复查）</span>
    </div>
  )
}
