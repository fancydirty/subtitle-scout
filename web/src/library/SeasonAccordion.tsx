// web/src/library/SeasonAccordion.tsx：季手风琴（详情页重设计 item B）——季头恒显卷起汇总（人话
// 覆盖句，大数字嵌句），点头开合。展开后按集数分派：≤50 集逐集行式（EpisodeRow，剧照+行内展开
// 简介），>50 集回落紧凑格阵（SeasonGridBody）。canonical 未缓存时显示提示。行式下同一时刻至多
// 一行展开。
import { useState } from 'react'
import { VStack } from '@astryxdesign/core/VStack'
import { Text } from '@astryxdesign/core/Text'
import type { LibrarySeasonDTO } from '../api/types.js'
import { buildGridCells, tallyGridCells, isCanonicalPending, EPISODE_ROW_CAP } from './episodeState.js'
import { seasonCoverageSentence } from './text.js'
import { EpisodeRow } from './EpisodeRow.js'
import { SeasonGridBody } from './SeasonGridBody.js'
import { useT } from '../i18n/useT.js'

interface Props {
  season: LibrarySeasonDTO
  now: number
  defaultOpen?: boolean
}

export function SeasonAccordion({ season, now, defaultOpen = true }: Props) {
  const { t, lang } = useT()
  const [open, setOpen] = useState(defaultOpen)
  const [expandedEp, setExpandedEp] = useState<number | null>(null)
  const cells = buildGridCells(season, now)
  const tally = tallyGridCells(cells)
  const sentence = seasonCoverageSentence(season.season, tally, lang)
  const useGrid = cells.length > EPISODE_ROW_CAP

  return (
    <VStack gap={2}>
      <button type="button" className="library-season-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className={`library-season-chev${open ? ' open' : ''}`} aria-hidden="true">›</span>
        <Text type="body" color="secondary">
          {sentence.prefix} <Text as="span" weight="semibold" color="primary" size="lg">{sentence.emphasis}</Text> {sentence.suffix}
          {sentence.clause ? <Text as="span" color="secondary"> — {sentence.clause}</Text> : null}
        </Text>
      </button>
      {isCanonicalPending(season) ? <Text type="code" color="secondary">{t('library_detail_canonical_pending')}</Text> : null}
      {open ? (
        useGrid ? <SeasonGridBody cells={cells} /> : (
          <div>
            {cells.map((cell) => (
              <EpisodeRow
                key={cell.episode}
                cell={cell}
                expanded={expandedEp === cell.episode}
                onToggle={() => setExpandedEp((p) => (p === cell.episode ? null : cell.episode))}
              />
            ))}
          </div>
        )
      ) : null}
    </VStack>
  )
}
