// web/src/library/SeriesGrid.tsx：海报墙列表页（#/library）——顶部筛选 chip 排 + 结果计数
// （mono）+ 分区海报墙（剧集/动漫/电影/其他）。三态齐（loading/error/empty）+ 筛选后零结果
// 单独一态（区别于"库本身是空的"）。
import { useState } from 'react'
import { Section } from '@astryxdesign/core/Section'
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl'
import { Grid } from '@astryxdesign/core/Grid'
import { Heading, Text } from '@astryxdesign/core/Text'
import { HStack } from '@astryxdesign/core/HStack'
import { VStack } from '@astryxdesign/core/VStack'
import { EmptyState } from '@astryxdesign/core/EmptyState'
import { Skeleton } from '@astryxdesign/core/Skeleton'
import { Button } from '@astryxdesign/core/Button'
import { useLibrary } from '../api/hooks.js'
import { useT, type TKey } from '../i18n/useT.js'
import { LIBRARY_FILTERS, type LibraryFilter, matchesLibraryFilter, groupBySection } from './filter.js'
import { sectionLabel } from './sectionLabel.js'
import { formatResultCount } from './text.js'
import { PosterCard } from './PosterCard.js'

const FILTER_LABEL_KEY: Record<LibraryFilter, TKey> = {
  all: 'library_filter_all',
  gap: 'library_filter_gap',
  throttled: 'library_filter_throttled',
  full: 'library_filter_full',
}

const GRID_COLUMNS = { minWidth: 150, max: 8 } as const

function SkeletonGrid() {
  return (
    <div aria-busy="true" aria-label="loading library">
      <Grid columns={GRID_COLUMNS} gap={4}>
        {Array.from({ length: 12 }).map((_, i) => (
          <VStack key={i} gap={2}>
            <div className="library-poster-skel-frame">
              <Skeleton radius={2} index={i} />
            </div>
            <Skeleton height={12} width="70%" radius={1} index={i} />
          </VStack>
        ))}
      </Grid>
    </div>
  )
}

export function SeriesGrid() {
  const { data, loading, error, reload } = useLibrary()
  const { t, lang } = useT()
  const [filter, setFilter] = useState<LibraryFilter>('all')

  const visible = (data ?? []).filter((it) => matchesLibraryFilter(it.coverage, filter))
  const sections = groupBySection(visible)

  return (
    <Section padding={4}>
      <VStack gap={4}>
        <HStack gap={3} vAlign="center" wrap="wrap">
          <SegmentedControl value={filter} onChange={(v) => setFilter(v as LibraryFilter)} label="Library filter">
            {LIBRARY_FILTERS.map((f) => (
              <SegmentedControlItem key={f} value={f} label={t(FILTER_LABEL_KEY[f])} />
            ))}
          </SegmentedControl>
          {data ? (
            <Text type="code" color="secondary">
              {formatResultCount(visible.length, lang)}
            </Text>
          ) : null}
        </HStack>

        {loading && !data ? (
          <SkeletonGrid />
        ) : error && !data ? (
          <EmptyState
            title={t('library_error_prefix') + error}
            actions={<Button label={t('library_retry')} variant="secondary" onClick={reload} />}
          />
        ) : data && data.length === 0 ? (
          <EmptyState title={t('library_empty_title')} description={t('library_empty_desc')} />
        ) : visible.length === 0 ? (
          <EmptyState title={t('library_filtered_empty_title')} description={t('library_filtered_empty_desc')} />
        ) : (
          <VStack gap={6}>
            {sections.map(({ section, items }) => (
              <VStack gap={3} key={section}>
                <Heading level={3} color="secondary">
                  {sectionLabel(section, t)}
                </Heading>
                <Grid columns={GRID_COLUMNS} gap={4}>
                  {items.map((it) => (
                    <PosterCard key={it.id} item={it} />
                  ))}
                </Grid>
              </VStack>
            ))}
          </VStack>
        )}
      </VStack>
    </Section>
  )
}
