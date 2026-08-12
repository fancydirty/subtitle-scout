// web/src/library/PosterCard.tsx：一张海报卡——AspectRatio 2/3 海报 + 覆盖角标（灰 mono 数字
// 或全覆盖绿点，不做彩色大 badge）+ 底部标题行。系列可点进详情页；电影没有详情端点（G5 只做
// series/:id），非交互展示。
//
// hover 发丝线抬升（DESIGN.md §2：深色下零 drop-shadow）：卡片壳是原生 <a>/<div> +
// styles.css 里集中的一小段原子 CSS（.library-poster-card 家族），颜色全读 token。
import { AspectRatio } from '../../components/ui/aspect-ratio.js'
import type { LibraryItemDTO } from '../../api/types.js'
import { posterAngle } from './posterAngle.js'
import { PosterThumb } from './PosterThumb.js'
import { libraryItemHref } from './legacyHref.js'
import { useT } from '../../i18n/useT.js'

function PosterBadge({ item }: { item: LibraryItemDTO }) {
  const angle = posterAngle(item.coverage)
  if (angle.kind === 'full') {
    return <span className="library-poster-dot" aria-hidden="true" />
  }
  if (angle.kind === 'gap') {
    return (
      <span className="library-poster-count">
        {/* type="code" size="2xs"：size 只覆盖 fontSize（8px），leading 仍是 code 的 1.5385 —— */}
        <span className="font-mono text-[8px] leading-[1.5385] text-muted-foreground">
          {angle.text}
        </span>
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
      {/* hasTruncateTooltip 丢掉：它没配 maxLines，本就是死 prop（Text.tsx:245 tooltipEnabled 恒 false、
          :234 无行夹取），标题今天自由换行。翻译成 truncate 会改成单行截断——那是新增行为。 */}
      <span className="block text-[13px] font-medium leading-5 text-foreground">{title}</span>
      <span className="block text-[11px] leading-4 text-muted-foreground">{subline}</span>
      {item.nativeAudio && (
        <p className="text-xs text-weak">Native audio — no subtitles needed</p>
      )}
    </div>
  )

  if (item.kind === 'series') {
    return (
      <a className="library-poster-card" href={libraryItemHref({ kind: item.kind, libraryId: item.id })} aria-label={title}>
        <PosterFrame item={item} title={title} />
        {meta}
      </a>
    )
  }

  return (
    <a className="library-poster-card" href={libraryItemHref({ kind: item.kind, libraryId: item.id })} aria-label={title}>
      <PosterFrame item={item} title={title} />
      {meta}
    </a>
  )
}
