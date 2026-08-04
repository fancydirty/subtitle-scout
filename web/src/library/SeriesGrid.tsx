// web/src/library/SeriesGrid.tsx：海报墙列表页（#/library）——顶部筛选 chip 排 + 结果计数
// （mono）+ 分区海报墙（剧集/动漫/电影/其他）。三态齐（loading/error/empty）+ 筛选后零结果
// 单独一态（区别于"库本身是空的"）。
import { useState } from 'react'
import { Section } from '../components/ui/section.js'
import { Segmented } from '../components/ui/segmented.js'
import { Skeleton } from '../components/ui/skeleton.js'
import { EmptyState } from '../components/ui/empty-state.js'
import { Button } from '../components/ui/button.js'
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

function SkeletonGrid() {
  return (
    <div aria-busy="true" aria-label="loading library">
      <div className="library-grid">
        {Array.from({ length: 12 }).map((_, i) => (
          <div className="flex flex-col gap-2" key={i}>
            <div className="library-poster-skel-frame">
              <Skeleton index={i} className="h-full w-full rounded-control" />
            </div>
            <Skeleton index={i} className="h-3 w-[70%] rounded-[4px]" />
          </div>
        ))}
      </div>
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
    <Section>
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <Segmented
            items={LIBRARY_FILTERS.map((f) => ({ value: f, label: t(FILTER_LABEL_KEY[f]) }))}
            value={filter}
            onChange={(v) => setFilter(v as LibraryFilter)}
            label="Library filter"
          />
          {data ? (
            <span className="font-mono text-[13px] leading-5 text-muted-foreground">
              {formatResultCount(visible.length, lang)}
            </span>
          ) : null}
        </div>

        {loading && !data ? (
          <SkeletonGrid />
        ) : error && !data ? (
          <EmptyState
            title={t('library_error_prefix') + error}
            actions={
              <Button variant="secondary" onClick={reload}>
                {t('library_retry')}
              </Button>
            }
          />
        ) : data && data.length === 0 ? (
          <EmptyState title={t('library_empty_title')} description={t('library_empty_desc')} />
        ) : visible.length === 0 ? (
          <EmptyState title={t('library_filtered_empty_title')} description={t('library_filtered_empty_desc')} />
        ) : (
          <div className="flex flex-col gap-6">
            {sections.map(({ section, items }) => (
              <div className="flex flex-col gap-3" key={section}>
                <h3 className="m-0 text-[16px] font-semibold leading-6 text-muted-foreground">
                  {sectionLabel(section, t)}
                </h3>
                <div className="library-grid">
                  {items.map((it) => (
                    <PosterCard key={it.id} item={it} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Section>
  )
}
