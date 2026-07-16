// web/src/library/PosterCard.tsx：一张海报卡——AspectRatio 2/3 海报 + 覆盖角标（灰 mono 数字
// 或全覆盖绿点，不做彩色大 badge）+ 底部标题行。系列可点进详情页；电影没有详情端点（G5 只做
// series/:id），非交互展示。
//
// hover 发丝线抬升（DESIGN.md §2：深色下零 drop-shadow）：ClickableCard/Card 都没留 className/
// hover 的 xstyle 逃生口（xstyle 本身也没接 stylex 编译插件，见 web/package.json——项目里唯一
// 用它的地方是 Sidebar.tsx 的 data-selected 全局选择器手法），所以外层卡片壳用一个原生
// <a>/<div> + styles.css 里集中的一小段原子 CSS（.library-poster-card 家族），颜色全读 token。
import { AspectRatio } from '@astryxdesign/core/AspectRatio'
import { Text } from '@astryxdesign/core/Text'
import type { LibraryItemDTO } from '../api/types.js'
import { posterAngle } from './posterAngle.js'
import { PosterThumb } from './PosterThumb.js'
import { libraryItemHref } from '../shell/route.js'
import { useT } from '../i18n/useT.js'

function PosterBadge({ item }: { item: LibraryItemDTO }) {
  const angle = posterAngle(item.coverage)
  if (angle.kind === 'full') {
    return <span className="library-poster-dot" aria-hidden="true" />
  }
  if (angle.kind === 'gap') {
    return (
      <span className="library-poster-count">
        <Text type="code" size="2xs" color="secondary">
          {angle.text}
        </Text>
      </span>
    )
  }
  return null
}

function PosterFrame({ item, title }: { item: LibraryItemDTO; title: string }) {
  return (
    <div className="library-poster-frame">
      <AspectRatio ratio={2 / 3} fit="cover">
        <PosterThumb posterPath={item.posterPath} name={title} />
      </AspectRatio>
      <PosterBadge item={item} />
    </div>
  )
}

export function PosterCard({ item }: { item: LibraryItemDTO }) {
  const { t } = useT()
  const title = item.chineseTitle ?? item.name
  const kindLabel = item.kind === 'series' ? t('library_kind_series') : t('library_kind_movie')
  const subline = [item.year ? String(item.year) : null, kindLabel].filter(Boolean).join(' · ')

  const meta = (
    <div className="library-poster-meta">
      <Text type="label" color="primary" hasTruncateTooltip display="block">
        {title}
      </Text>
      <Text type="supporting" color="secondary" display="block">
        {subline}
      </Text>
    </div>
  )

  if (item.kind === 'series') {
    return (
      <a className="library-poster-card" href={libraryItemHref(item.id)} aria-label={title}>
        <PosterFrame item={item} title={title} />
        {meta}
      </a>
    )
  }

  return (
    <div className="library-poster-card library-poster-card-static">
      <PosterFrame item={item} title={title} />
      {meta}
    </div>
  )
}
