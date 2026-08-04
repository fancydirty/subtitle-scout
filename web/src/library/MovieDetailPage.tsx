// web/src/library/MovieDetailPage.tsx：电影详情页——hero（模糊海报降级）+ 六段（状态/副本/字幕/校验/对照/活动）。
// 用 Spec C 栈（Tailwind/shadcn 自绘件），仿 SeriesPage 布局粒度，无 backdrop（恒降级）、
// 无 overview、无 genres。subStatus 七值人话句映射（复用活动页措辞族）。
import { posterUrl } from '../api/client.js'
import { Section } from '../components/ui/section.js'
import { Skeleton } from '../components/ui/skeleton.js'
import { EmptyState } from '../components/ui/empty-state.js'
import { Button } from '../components/ui/button.js'
import type { Async } from '../api/hooks.js'
import type { MovieDetailDTO } from '../api/types.js'
import { useT } from '../i18n/useT.js'
import { PosterThumb } from './PosterThumb.js'

interface Props {
  detail: Async<MovieDetailDTO>
}

// 未找到判定（同 SeriesPage 的既有口径）：404 时后端返回 {error:'not found'}，
// client.ts 对 4xx 优先取 body.error，所以错误串就是 'not found' 或 '... → 404'。
function isNotFoundError(error: string): boolean {
  return error === 'not found' || error.endsWith('→ 404')
}

function HeaderSkeleton() {
  return (
    <div className="flex gap-4" aria-busy="true" aria-label="loading movie">
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

// subStatus 七值 → 人话句映射（复用活动页/详情页既有措辞族，spec B §5.3 状态段）
function statusPhrase(
  subStatus: string,
  statusReason: string | null,
  recheckAfter: number | null,
  nativeAudio: boolean,
  lang: 'zh' | 'en',
): string {
  if (subStatus === 'covered') {
    return lang === 'zh' ? '字幕已装好' : 'Subtitles installed'
  }
  if (subStatus === 'missing') {
    return lang === 'zh' ? '缺字幕' : 'Missing subtitles'
  }
  if (subStatus === 'embedded') {
    return lang === 'zh' ? '内嵌字幕' : 'Embedded subtitles'
  }
  if (subStatus === 'hardsub-assumed') {
    return lang === 'zh' ? '假定硬字幕' : 'Hard subtitles assumed'
  }
  if (subStatus === 'unavailable' && recheckAfter != null) {
    const now = Date.now()
    const mins = Math.ceil((recheckAfter - now) / 60000)
    return lang === 'zh' ? `${mins} 分钟后重试` : `Will retry in ${mins} minutes`
  }
  if (subStatus === 'unavailable') {
    return lang === 'zh' ? '暂无可用字幕' : 'No subtitles available'
  }
  if (subStatus === 'ignored' && nativeAudio) {
    return lang === 'zh' ? '母语音频 — 无需字幕' : 'Native audio — no subtitles needed'
  }
  if (subStatus === 'ignored') {
    // rule 1b 的 status_reason 是中文内部串（ingest.ts:336 RULE_1B_REASON），不透传
    return lang === 'zh'
      ? '扫描时标记为无需字幕'
      : 'Marked as not needing subtitles during scan.'
  }
  // 未知态诚实降级
  return subStatus
}

export function MovieDetailPage({ detail }: Props) {
  const { t, lang } = useT()

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
          <EmptyState
            title={t('library_detail_not_found_title')}
            description={t('library_detail_not_found_desc')}
          />
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

  const movie = detail.data
  const title = movie.chineseTitle ?? movie.name
  const originalName = movie.chineseTitle && movie.chineseTitle !== movie.name ? movie.name : null
  const poster = posterUrl(movie.posterPath)
  const status = statusPhrase(movie.subStatus, movie.statusReason, movie.recheckAfter, movie.nativeAudio, lang)

  return (
    <Section>
      <div className="flex flex-col gap-6">
        {/* Hero：模糊海报出血背景（电影恒降级）+ 160px 海报 + 标题 meta */}
        <div className="library-hero">
          {/* 模糊海报当背景（电影恒无 backdrop，spec B §3-2 + ActivityHero 注释 :42-62） */}
          {poster ? (
            <div
              className="library-hero-backdrop"
              style={{
                backgroundImage: `url(${poster})`,
                filter: 'blur(40px) saturate(1.4)',
                transform: 'scale(1.2)',
              }}
              aria-hidden="true"
            />
          ) : null}
          <div className="library-hero-scrim" />
          <div className="flex gap-4 library-hero-body">
            {/* 电影海报 160px（ActivityHero 电影规格 :50 注释） */}
            <div style={{ width: '160px', aspectRatio: '2/3' }}>
              <PosterThumb posterPath={movie.posterPath} name={title} />
            </div>
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <span className="text-[16px] font-semibold leading-6 text-foreground">{title}</span>
                <span className="font-mono text-[13px] leading-5 text-muted-foreground">{movie.id}</span>
              </div>
              <span className="text-[11px] leading-4 text-muted-foreground">
                {[originalName, movie.year ? String(movie.year) : null].filter(Boolean).join(' · ')}
              </span>
              {/* mono 状态行 */}
              <span className="font-mono text-[13px] leading-5 text-muted-foreground">{status}</span>
              {/* 母语标记行（nativeAudio 时，同海报卡文案 spec B §5.2） */}
              {movie.nativeAudio ? (
                <span className="text-[11px] leading-4 text-muted-foreground">
                  {lang === 'zh' ? '母语音频 — 无需字幕' : 'Native audio — no subtitles needed'}
                </span>
              ) : null}
            </div>
          </div>
        </div>

        {/* 副本质检段（多副本才渲染，spec B §5.3） */}
        {movie.files.length > 1 ? (
          <div className="flex flex-col gap-2">
            <h2 className="text-[13px] font-semibold leading-5 text-foreground">
              {lang === 'zh' ? '文件' : 'Files'}
            </h2>
            {movie.files.map((f, i) => (
              <div key={i} className="flex items-center gap-2">
                <span
                  className={`inline-block size-2 shrink-0 rounded-full ${f.covered ? 'bg-fn-green' : 'bg-weak'}`}
                  aria-hidden="true"
                />
                <span className="font-mono text-[13px] leading-5 text-muted-foreground">{f.path}</span>
              </div>
            ))}
          </div>
        ) : null}

        {/* 字幕清单段 */}
        {movie.subtitles.length > 0 ? (
          <div className="flex flex-col gap-2">
            <h2 className="text-[13px] font-semibold leading-5 text-foreground">
              {lang === 'zh' ? '字幕' : 'Subtitles'}
            </h2>
            {movie.subtitles.map((s, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="rounded bg-secondary px-2 py-0.5 font-mono text-[11px] leading-4 text-foreground">
                  {s.language}
                </span>
                <span className="font-mono text-[13px] leading-5 text-muted-foreground">{s.path}</span>
              </div>
            ))}
          </div>
        ) : null}

        {/* 校验段（TODO 占位，spec B §5.3 + Task 11） */}
        {/* itemId 查 verify 结论：shifted → 红点 + Fix/Undo；aligned/unverifiable → 绿点；无记录 → 不渲染本段 */}

        {/* 对照图入口（TODO 接 InspectPanel，Task 14） */}
        <div>
          <Button variant="secondary" disabled>
            {lang === 'zh' ? '检查' : 'Inspect'}
          </Button>
        </div>

        {/* 最近活动段 */}
        {movie.recentJobs.length > 0 ? (
          <div className="flex flex-col gap-2">
            <h2 className="text-[13px] font-semibold leading-5 text-foreground">
              {lang === 'zh' ? '最近活动' : 'Recent activity'}
            </h2>
            {movie.recentJobs.map((j) => (
              <div key={j.id} className="flex items-center gap-2">
                <span className="font-mono text-[13px] leading-5 text-muted-foreground">
                  {new Date(j.updatedAt).toLocaleString()}
                </span>
                <span className="text-[13px] leading-5 text-muted-foreground">{j.state}</span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </Section>
  )
}
