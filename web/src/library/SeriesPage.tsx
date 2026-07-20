// web/src/library/SeriesPage.tsx：剧集页（#/library/:id）——渐变 hero 头部（SeriesHero，含 TMDB
// 剧集简介 + 背景大图）+ 跨季覆盖事实栏（FactsRail）+ 每季手风琴（SeasonAccordion，逐集行内展开
// 该集简介，超长季回落格阵）。详情页重设计 item B：移除旧的右侧滑入详情面板（EpisodeDetail）与
// 点格选中态。detail 数据由 Shell 传入（跟 Topbar 面包屑共用同一次 GET /api/v2/library/series/:id，
// 见 shell/AppShell.tsx 顶部注释），这里不自己再发一次请求。
import { Section } from '@astryxdesign/core/Section'
import { VStack } from '@astryxdesign/core/VStack'
import { HStack } from '@astryxdesign/core/HStack'
import { Text } from '@astryxdesign/core/Text'
import { EmptyState } from '@astryxdesign/core/EmptyState'
import { Skeleton } from '@astryxdesign/core/Skeleton'
import { Button } from '@astryxdesign/core/Button'
import type { Async } from '../api/hooks.js'
import type { LibrarySeriesDetailDTO } from '../api/types.js'
import { useT } from '../i18n/useT.js'
import { buildGridCells, tallyGridCells } from './episodeState.js'
import { SeriesHero } from './SeriesHero.js'
import { FactsRail } from './FactsRail.js'
import { SeasonAccordion } from './SeasonAccordion.js'

interface Props {
  detail: Async<LibrarySeriesDetailDTO>
}

// 未找到判定（dashboard 审计 #1）：series-detail 端点 404 时后端 body 是 {error:'not found'}
// （router.ts），client.ts 对 4xx 优先取 body.error → 错误串就是 'not found'。SeriesPage 的
// detail 只来自这一个端点（其 4xx 仅 'bad id'/'not found'），故这两种信号唯一对应真 404；
// '… → 404' 是非 JSON body 的兜底形态，一并认。
function isNotFoundError(error: string): boolean {
  return error === 'not found' || error.endsWith('→ 404')
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

export function SeriesPage({ detail }: Props) {
  const { t } = useT()

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
  const now = Date.now()
  // 顶部覆盖汇总喂 FactsRail：跨季合计（沿用 buildGridCells/tallyGridCells 同一事实源）。
  const totals = seasons.reduce(
    (acc, s) => {
      const ta = tallyGridCells(buildGridCells(s, now))
      return { covered: acc.covered + ta.covered, total: acc.total + ta.total, embedded: acc.embedded + ta.embedded }
    },
    { covered: 0, total: 0, embedded: 0 },
  )
  const langs = [...new Set(seasons.flatMap((s) => s.coverage.map((c) => c.lang)))].sort()

  return (
    <Section padding={4}>
      <VStack gap={6}>
        <SeriesHero
          name={title}
          originalName={originalName}
          year={series.year}
          seriesId={series.id}
          posterPath={series.posterPath}
          backdropPath={series.backdropPath}
          overview={series.overview}
        />
        {series.layoutNonstandard ? (
          <Text type="supporting" color="secondary">{t('library_detail_layout_nonstandard')}</Text>
        ) : null}
        <FactsRail covered={totals.covered} total={totals.total} embedded={totals.embedded} langs={langs} />
        <VStack gap={6}>
          {seasons.map((season) => (
            <SeasonAccordion key={season.season} season={season} now={now} defaultOpen={seasons.length === 1} />
          ))}
        </VStack>
      </VStack>
    </Section>
  )
}
