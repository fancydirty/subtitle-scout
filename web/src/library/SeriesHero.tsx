// web/src/library/SeriesHero.tsx：剧集页 hero 头部（详情页重设计 item B）——渐变压暗的 TMDB
// 背景大图 + 海报缩略 + 名/年份/原名 + 剧集简介。无 backdrop 时降级纯排印头部（scrim 层仍在，
// 但不铺灰空图），无 overview 时不渲染简介段。
import { backdropUrl } from '../api/client.js'
import { PosterThumb } from './PosterThumb.js'

interface Props {
  name: string
  originalName: string | null
  year: number | null
  seriesId: string
  posterPath: string | null
  backdropPath: string | null
  overview: string | null
}

export function SeriesHero({ name, originalName, year, seriesId, posterPath, backdropPath, overview }: Props) {
  const bd = backdropUrl(backdropPath)
  return (
    <div className="library-hero">
      {bd ? <div className="library-hero-backdrop" style={{ backgroundImage: `url(${bd})` }} aria-hidden="true" /> : null}
      <div className="library-hero-scrim" />
      <div className="flex gap-4 library-hero-body">
        <div className="library-detail-header-poster">
          <PosterThumb posterPath={posterPath} name={name} />
        </div>
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="text-[16px] font-semibold leading-6 text-foreground">{name}</span>
            <span className="font-mono text-[13px] leading-5 text-muted-foreground">{seriesId}</span>
          </div>
          <span className="text-[11px] leading-4 text-muted-foreground">
            {[originalName, year ? String(year) : null].filter(Boolean).join(' · ')}
          </span>
          {overview ? (
            <span className="text-[13px] leading-5 text-muted-foreground">{overview}</span>
          ) : null}
        </div>
      </div>
    </div>
  )
}
