// web/src/library/SeriesHero.tsx：剧集页 hero 头部（详情页重设计 item B）——渐变压暗的 TMDB
// 背景大图 + 海报缩略 + 名/年份/原名 + 剧集简介。无 backdrop 时降级纯排印头部（scrim 层仍在，
// 但不铺灰空图），无 overview 时不渲染简介段。
import { Text } from '@astryxdesign/core/Text'
import { VStack } from '@astryxdesign/core/VStack'
import { HStack } from '@astryxdesign/core/HStack'
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
      <HStack gap={4} className="library-hero-body">
        <div className="library-detail-header-poster">
          <PosterThumb posterPath={posterPath} name={name} />
        </div>
        <VStack gap={1}>
          <HStack gap={2} vAlign="center">
            <Text type="large" weight="semibold">{name}</Text>
            <Text type="code" color="secondary">{seriesId}</Text>
          </HStack>
          <Text type="supporting" color="secondary">
            {[originalName, year ? String(year) : null].filter(Boolean).join(' · ')}
          </Text>
          {overview ? <Text type="body" color="secondary">{overview}</Text> : null}
        </VStack>
      </HStack>
    </div>
  )
}
