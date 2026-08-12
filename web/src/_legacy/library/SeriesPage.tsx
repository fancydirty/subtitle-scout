// web/src/library/SeriesPage.tsx：剧集页（#/library/:id）——渐变 hero 头部（SeriesHero，含 TMDB
// 剧集简介 + 背景大图）+ 跨季覆盖事实栏（FactsRail）+ 每季手风琴（SeasonAccordion，逐集行内展开
// 该集简介，超长季回落格阵）。详情页重设计 item B：移除旧的右侧滑入详情面板（EpisodeDetail）与
// 点格选中态。detail 数据由 Shell 传入（跟 Topbar 面包屑共用同一次 GET /api/v2/library/series/:id，
// 见 shell/AppShell.tsx 顶部注释），这里不自己再发一次请求。
import { Section } from '../../components/ui/section.js'
import { Skeleton } from '../../components/ui/skeleton.js'
import { EmptyState } from '../../components/ui/empty-state.js'
import { Button } from '../../components/ui/button.js'
import type { Async } from '../../api/hooks.js'
import type { LibrarySeriesDetailDTO } from '../../api/types.js'
import { useT } from '../../i18n/useT.js'
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
    <div className="flex gap-4" aria-busy="true" aria-label="loading series">
      <div className="library-detail-header-poster">
        <Skeleton className="h-full w-full rounded-control" />
      </div>
      <div className="flex w-full flex-col gap-2">
        <Skeleton className="h-5 w-[40%] rounded-[4px]" />
        <Skeleton className="h-[13px] w-[60%] rounded-[4px]" />
      </div>
    </div>
  )
}

export function SeriesPage({ detail }: Props) {
  const { t } = useT()

  if (detail.loading && !detail.data) {
    return (
      <Section>
        <HeaderSkeleton />
      </Section>
    )
  }

  if (detail.error && !detail.data) {
    if (isNotFoundError(detail.error)) {
      return (
        <Section>
          <EmptyState title={t('library_detail_not_found_title')} description={t('library_detail_not_found_desc')} />
        </Section>
      )
    }
    return (
      <Section>
        <EmptyState
          title={t('library_detail_error_prefix') + detail.error}
          actions={
            <Button variant="secondary" onClick={detail.reload}>
              {t('library_retry')}
            </Button>
          }
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
    <Section>
      <div className="flex flex-col gap-6">
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
          <span className="text-[11px] leading-4 text-muted-foreground">{t('library_detail_layout_nonstandard')}</span>
        ) : null}
        <FactsRail covered={totals.covered} total={totals.total} embedded={totals.embedded} langs={langs} />
        <div className="flex flex-col gap-6">
          {seasons.map((season) => (
            <SeasonAccordion key={season.season} season={season} now={now} defaultOpen={seasons.length === 1} />
          ))}
        </div>
      </div>
    </Section>
  )
}
