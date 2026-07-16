// web/src/library/SeriesPage.tsx：剧集页（#/library/:id）——头部（海报缩略 + 名 + 年份 +
// 人话覆盖句）+ 每季 A 式格阵（EpisodeCell）+ 图例 + 点格弹出右侧详情板（EpisodeDetail）。
// detail 数据由 Shell 传入（跟 Topbar 面包屑共用同一次 GET /api/v2/library/series/:id，见
// shell/AppShell.tsx 顶部注释），这里不自己再发一次请求。
import { useState } from 'react'
import { Section } from '@astryxdesign/core/Section'
import { VStack } from '@astryxdesign/core/VStack'
import { HStack } from '@astryxdesign/core/HStack'
import { Text } from '@astryxdesign/core/Text'
import { EmptyState } from '@astryxdesign/core/EmptyState'
import { Skeleton } from '@astryxdesign/core/Skeleton'
import { Button } from '@astryxdesign/core/Button'
import type { Async } from '../api/hooks.js'
import type { LibrarySeasonDTO, LibrarySeriesDetailDTO } from '../api/types.js'
import { useT, type Lang } from '../i18n/useT.js'
import { buildGridCells, tallyGridCells, isCanonicalPending, type GridCell } from './episodeState.js'
import { seasonCoverageSentence } from './text.js'
import { EpisodeCell } from './EpisodeCell.js'
import { EpisodeDetail } from './EpisodeDetail.js'
import { PosterThumb } from './PosterThumb.js'

interface Props {
  detail: Async<LibrarySeriesDetailDTO>
}

interface Selection {
  season: number
  cell: GridCell
}

function isNotFoundError(error: string): boolean {
  return error.endsWith('→ 404')
}

function HeaderSkeleton() {
  return (
    <HStack gap={4} aria-busy="true" aria-label="loading series">
      <div className="library-detail-header-poster">
        <Skeleton radius={2} />
      </div>
      <VStack gap={2} width="100%">
        <Skeleton height={20} width="40%" radius={1} />
        <Skeleton height={13} width="60%" radius={1} />
      </VStack>
    </HStack>
  )
}

function SeasonBlock({
  season, now, lang, isSelected, onSelectCell,
}: {
  season: LibrarySeasonDTO
  now: number
  lang: Lang
  isSelected: (cell: GridCell) => boolean
  onSelectCell: (season: number, cell: GridCell) => void
}) {
  const { t } = useT()
  const cells = buildGridCells(season, now)
  const tally = tallyGridCells(cells)
  const sentence = seasonCoverageSentence(season.season, tally, lang)
  const pending = isCanonicalPending(season)

  return (
    <VStack gap={2}>
      <Text type="body" color="secondary">
        {sentence.prefix}{' '}
        <Text type="body" as="span" weight="semibold" color="primary" size="lg">
          {sentence.emphasis}
        </Text>{' '}
        {sentence.suffix}
        {sentence.clause ? <Text type="body" as="span" color="secondary"> — {sentence.clause}.</Text> : null}
      </Text>
      {pending ? (
        <Text type="code" color="secondary">
          {t('library_detail_canonical_pending')}
        </Text>
      ) : null}
      <div className="ep-grid">
        {cells.map((cell) => (
          <EpisodeCell
            key={cell.episode}
            cell={cell}
            isSelected={isSelected(cell)}
            onSelect={() => onSelectCell(season.season, cell)}
          />
        ))}
      </div>
    </VStack>
  )
}

function Legend() {
  const { t } = useT()
  return (
    <HStack gap={4} wrap="wrap">
      <HStack gap={1} vAlign="center">
        <span className="ep-dot ep-dot-covered" aria-hidden="true" />
        <Text type="code" color="secondary">{t('library_legend_covered')}</Text>
      </HStack>
      <HStack gap={1} vAlign="center">
        <span className="ep-dot ep-dot-missing" aria-hidden="true" />
        <Text type="code" color="secondary">{t('library_legend_missing')}</Text>
      </HStack>
      <HStack gap={1} vAlign="center">
        <span className="ep-dot ep-dot-throttled" aria-hidden="true" />
        <Text type="code" color="secondary">{t('library_legend_throttled')}</Text>
      </HStack>
      <HStack gap={1} vAlign="center">
        <span className="ep-cell-dashed-swatch" aria-hidden="true" />
        <Text type="code" color="secondary">{t('library_legend_dashed')}</Text>
      </HStack>
    </HStack>
  )
}

export function SeriesPage({ detail }: Props) {
  const { t, lang } = useT()
  const [selection, setSelection] = useState<Selection | null>(null)
  const now = Date.now()

  const onSelectCell = (season: number, cell: GridCell) => {
    setSelection((prev) => (prev && prev.season === season && prev.cell.episode === cell.episode ? null : { season, cell }))
  }

  if (detail.loading && !detail.data) {
    return (
      <Section padding={4}>
        <HeaderSkeleton />
      </Section>
    )
  }

  if (detail.error && !detail.data) {
    if (isNotFoundError(detail.error)) {
      return (
        <Section padding={4}>
          <EmptyState title={t('library_detail_not_found_title')} description={t('library_detail_not_found_desc')} />
        </Section>
      )
    }
    return (
      <Section padding={4}>
        <EmptyState
          title={t('library_detail_error_prefix') + detail.error}
          actions={<Button label={t('library_retry')} variant="secondary" onClick={detail.reload} />}
        />
      </Section>
    )
  }

  if (!detail.data) return null

  const { series, seasons } = detail.data
  const title = series.chineseTitle ?? series.name
  const originalName = series.chineseTitle && series.chineseTitle !== series.name ? series.name : null
  const selectedSeason = selection ? seasons.find((s) => s.season === selection.season) : undefined

  return (
    <Section padding={4}>
      <VStack gap={6}>
        <HStack gap={4}>
          <div className="library-detail-header-poster">
            <PosterThumb posterPath={series.posterPath} name={title} />
          </div>
          <VStack gap={1}>
            <HStack gap={2} vAlign="center">
              <Text type="large" weight="semibold">{title}</Text>
              <Text type="code" color="secondary">{series.id}</Text>
            </HStack>
            <Text type="supporting" color="secondary">
              {[originalName, series.year ? String(series.year) : null].filter(Boolean).join(' · ')}
            </Text>
            {series.layoutNonstandard ? (
              <Text type="supporting" color="secondary">
                {t('library_detail_layout_nonstandard')}
              </Text>
            ) : null}
          </VStack>
        </HStack>

        <VStack gap={6}>
          {seasons.map((season) => (
            <SeasonBlock
              key={season.season}
              season={season}
              now={now}
              lang={lang}
              isSelected={(cell) => selection?.season === season.season && selection.cell.episode === cell.episode}
              onSelectCell={onSelectCell}
            />
          ))}
        </VStack>

        <Legend />
      </VStack>

      {selection && selectedSeason ? (
        <EpisodeDetail
          season={selection.season}
          cell={selection.cell}
          coverage={selectedSeason.coverage}
          onClose={() => setSelection(null)}
        />
      ) : null}
    </Section>
  )
}
