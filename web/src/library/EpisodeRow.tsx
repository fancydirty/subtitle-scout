// web/src/library/EpisodeRow.tsx：逐集行（详情页重设计 item B）——5px 语义点 + mono 集号 + 标题
// 在左，剧照 + 首播日在右，点击整行行内展开该集 TMDB 简介（同一时刻至多一行开，由父组件管状态）。
// overview 缺失时展开区显示占位文案而非空白。内嵌集在标题旁挂 mono "内嵌" 角标。
import { Text } from '@astryxdesign/core/Text'
import { VStack } from '@astryxdesign/core/VStack'
import type { GridCell } from './episodeState.js'
import { stillUrl } from '../api/client.js'
import { useT } from '../i18n/useT.js'

interface Props {
  cell: GridCell
  expanded: boolean
  onToggle: () => void
}

// grid 语义态 → 5px 点样式类（复用 EpisodeCell 家族的 .ep-dot-* 原子样式）。未知态兜底灰点。
const DOT_CLASS: Record<string, string> = {
  covered: 'ep-dot-covered',
  hardsub: 'ep-dot-hardsub',
  missing: 'ep-dot-missing',
  throttled: 'ep-dot-throttled',
  partial: 'ep-dot-partial',
  error: 'ep-dot-missing',
  dashed: 'ep-dot-missing',
}

export function EpisodeRow({ cell, expanded, onToggle }: Props) {
  const { t } = useT()
  const isEmbedded = cell.onDisk?.subStatus === 'embedded'
  const still = stillUrl(cell.stillPath)
  const epLabel = `E${String(cell.episode).padStart(2, '0')}`
  return (
    <div className={`library-eprow${expanded ? ' library-eprow-active' : ''}`}>
      <button type="button" className="library-eprow-head" onClick={onToggle} aria-expanded={expanded}>
        <span className={`ep-dot ${DOT_CLASS[cell.state] ?? 'ep-dot-missing'}`} aria-hidden="true" />
        <Text type="code" color="secondary">{epLabel}</Text>
        <Text type="label" color="primary">{cell.title ?? epLabel}</Text>
        {isEmbedded ? <span className="library-eprow-tag">{t('library_detail_embedded_short')}</span> : null}
        <span className="library-eprow-spacer" />
        {still ? <img className="library-eprow-still" src={still} alt="" loading="lazy" /> : null}
        {cell.airDate ? <Text type="code" color="secondary">{cell.airDate}</Text> : null}
      </button>
      {expanded ? (
        <VStack gap={1} className="library-eprow-body">
          <Text type="body" color="secondary">{cell.overview ?? t('library_episode_no_overview')}</Text>
        </VStack>
      ) : null}
    </div>
  )
}
