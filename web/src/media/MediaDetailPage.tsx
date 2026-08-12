// web/src/media/MediaDetailPage.tsx：媒体库详情（#/media/:workId）——季集网格。
//
// ── 页面结构 ──────────────────────────────────────────────────────────────
//   返回链接（#/media）
//   头部：海报缩略 + 标题（中文名优先，与原名不同则副行给原名）+ 年份
//   图例：七个染色态各一枚符号 + 文案（Carbon 双通道的可读性靠它兜底）
//   逐季：季头（"第 1 季 · 应有 24 · 磁盘 12"）+ 集号格阵
//   电影：没有季集，只有一格（movie）
//   unplacedFileCount > 0 时如实报一行（后端注释点名：不报的话用户会以为文件丢了）
//
// ── R-F5 实线/虚线在这里怎么画 ─────────────────────────────────────────────
// 一季的 `episodes[]` 是**应有 ∪ 实有**的并集（后端合并，见 buildMediaLibraryDetail）。
// 逐格 `onDisk` 决定边框：true 实线、false 虚线。前端**不做任何集号推算**——
// 不去比对"应有 24 集所以补 12 个虚线格"，那是把后端的并集逻辑复制第二份。
//
// ── 异常态（§4.4）────────────────────────────────────────────────────────
// 404（作品不存在）与其它错误分开：前者是"这个 id 没有对应作品"（用户点了个坏链接），
// 后者是"我没能问到"（可重试）。两者显示不同文案 —— 给 404 配一个"重试"按钮是骗人。
import { Section } from '../components/ui/section.js'
import { Skeleton } from '../components/ui/skeleton.js'
import { EmptyState } from '../components/ui/empty-state.js'
import { Button } from '../components/ui/button.js'
import { AspectRatio } from '../components/ui/aspect-ratio.js'
import type { Async } from '../api/hooks.js'
import type {
  MediaLibraryDetailDTO,
  MediaLibrarySeasonDTO,
  MediaLibraryMovieDTO,
} from '../api/types.js'
import { useT } from '../i18n/useT.js'
import { EpisodeCell } from './EpisodeCell.js'
import { EpisodeMark } from './EpisodeMark.js'
import { EPISODE_STATE_LABEL, LEGEND_STATES } from './episodeStateMeta.js'
import { MediaPoster } from './MediaPoster.js'

/** 404 判定：后端 404 的 body 是 `{error:'not found'}`（router.ts），client.ts 对 4xx 优先取
 *  body.error → 错误串就是 'not found'。'… → 404' 是非 JSON body 的兜底形态，一并认。
 *  （逐字同 SeriesPage.isNotFoundError 的既有口径——两个页面对同一个后端约定的判读必须一致，
 *   但**不 import 它**：那个文件随 Task ⑪ 走。） */
export function isNotFoundError(error: string): boolean {
  return error === 'not found' || error.endsWith('→ 404')
}

/** 一季的两个概览数字。**应有**不是 episodes.length（那是并集，含磁盘上多出来的集），
 *  也不是前端能推的东西——这里如实数两类格子：
 *   · 磁盘数 = onDisk 为 true 的格数（实线格）
 *   · 应有数 = **不可知**：后端详情 DTO 没有逐季的 expected 字段，而并集里的虚线格数
 *     只是"应有里磁盘没有的那部分"。故这里只报**磁盘数**与**虚线（缺）数**两个能数得出来的量，
 *     绝不把 `episodes.length` 说成"应有 N 集"——那在磁盘多出集时是错的。 */
export function seasonTally(season: MediaLibrarySeasonDTO): { onDisk: number; missing: number } {
  let onDisk = 0
  for (const ep of season.episodes) if (ep.onDisk) onDisk++
  return { onDisk, missing: season.episodes.length - onDisk }
}

function Legend() {
  const { t } = useT()
  return (
    <div className="media-legend" aria-label={t('media_legend_label')}>
      {LEGEND_STATES.map((state) => (
        <span className="media-legend-item" key={state}>
          <span className="media-ep-num" data-state={state}>
            <EpisodeMark state={state} />
          </span>
          <span className="text-[11px] leading-4 text-muted-foreground">
            {t(EPISODE_STATE_LABEL[state])}
          </span>
        </span>
      ))}
    </div>
  )
}

function SeasonBlock({ season }: { season: MediaLibrarySeasonDTO }) {
  const { t } = useT()
  const tally = seasonTally(season)
  return (
    <div className="flex flex-col gap-2">
      <h2 className="text-[13px] font-medium leading-5 text-foreground">
        {t('media_season_prefix')} {season.season}
        <span className="ml-2 font-mono text-[11px] font-normal text-muted-foreground">
          {t('media_card_ondisk')} {tally.onDisk}
          {/* 缺集数只在 >0 时露出——"缺 0 集"是一句噪音，且会让全齐的季看起来也有问题。 */}
          {tally.missing > 0 ? ` · ${t('media_season_missing')} ${tally.missing}` : ''}
        </span>
      </h2>
      <div className="media-ep-grid" role="list">
        {season.episodes.map((ep) => (
          <EpisodeCell key={ep.episode} ep={ep} />
        ))}
      </div>
    </div>
  )
}

/** 电影那一格。R-F5：电影没有季集，所以没有网格——但它仍然是**同一套染色语言**
 *  （同一个 EpisodeCell 渲染逻辑的一格版），不另造一套视觉。
 *  ⚠️ 后端注释点名：电影格**可能零文件**（空壳 works 直达详情端点），此时 episodeState
 *  是 'absent' —— 走虚线、不染色，与剧集的虚线格完全一致。 */
function MovieBlock({ movie }: { movie: MediaLibraryMovieDTO }) {
  const { t } = useT()
  return (
    <div className="flex flex-col gap-2">
      <h2 className="text-[13px] font-medium leading-5 text-foreground">{t('media_movie_heading')}</h2>
      <div className="media-ep-grid" role="list">
        <div
          className="media-ep-cell media-ep-cell-wide"
          data-ondisk={movie.fileCount > 0 ? 'true' : 'false'}
          role="listitem"
          aria-label={t(EPISODE_STATE_LABEL[movie.episodeState])}
        >
          <span className="media-ep-num" data-state={movie.episodeState}>
            {t(EPISODE_STATE_LABEL[movie.episodeState])}
          </span>
          <EpisodeMark state={movie.episodeState} />
        </div>
      </div>
    </div>
  )
}

function DetailSkeleton() {
  return (
    <div className="flex gap-4" aria-busy="true" aria-label="loading media detail">
      <div className="media-detail-poster">
        <Skeleton className="h-full w-full rounded-control" />
      </div>
      <div className="flex w-full flex-col gap-2">
        <Skeleton className="h-5 w-[40%] rounded-[4px]" />
        <Skeleton className="h-[13px] w-[60%] rounded-[4px]" />
      </div>
    </div>
  )
}

export function MediaDetailPage({ detail }: { detail: Async<MediaLibraryDetailDTO> }) {
  const { t } = useT()

  if (detail.loading && !detail.data) {
    return (
      <Section>
        <DetailSkeleton />
      </Section>
    )
  }

  if (detail.error && !detail.data) {
    if (isNotFoundError(detail.error)) {
      return (
        <Section>
          <EmptyState
            title={t('media_detail_not_found_title')}
            description={t('media_detail_not_found_desc')}
            actions={
              <a className="text-[13px] text-muted-foreground hover:underline" href="#/media">
                {t('media_back')}
              </a>
            }
          />
        </Section>
      )
    }
    return (
      <Section>
        <EmptyState
          title={t('media_error_title')}
          description={detail.error}
          actions={
            <Button variant="secondary" onClick={detail.reload}>
              {t('media_retry')}
            </Button>
          }
        />
      </Section>
    )
  }

  if (!detail.data) return null

  const { work, seasons, movie, unplacedFileCount } = detail.data
  const title = work.chineseTitle ?? work.title
  const originalTitle = work.chineseTitle && work.chineseTitle !== work.title ? work.title : null

  return (
    <Section>
      <div className="flex flex-col gap-6">
        <a className="text-[13px] text-muted-foreground hover:underline" href="#/media">
          {t('media_back')}
        </a>

        <div className="flex gap-4">
          <div className="media-detail-poster">
            <AspectRatio ratio={2 / 3} fit="cover">
              <MediaPoster posterPath={work.posterPath} name={title} />
            </AspectRatio>
          </div>
          <div className="flex flex-col gap-1">
            <h1 className="text-[17px] font-semibold leading-6 text-foreground">{title}</h1>
            {originalTitle ? (
              <span className="text-[13px] leading-5 text-muted-foreground">{originalTitle}</span>
            ) : null}
            {work.year !== null ? (
              <span className="font-mono text-[11px] leading-4 text-muted-foreground">{work.year}</span>
            ) : null}
          </div>
        </div>

        <Legend />

        {/* 剧集：逐季网格。**电影恒空数组**（后端保证），所以这个 map 对电影天然不渲染。 */}
        {seasons.map((s) => (
          <SeasonBlock key={s.season} season={s} />
        ))}

        {movie !== null ? <MovieBlock movie={movie} /> : null}

        {/* 有文件但进不了网格（季集解析不出）——如实报，不报用户会以为文件被弄丢了。 */}
        {unplacedFileCount > 0 ? (
          <p className="font-mono text-[11px] leading-4 text-muted-foreground">
            {t('media_unplaced_prefix')} {unplacedFileCount}
          </p>
        ) : null}

        {/* 剧集但一季都没有：不是错误，是"这部剧的应有集还没回填、磁盘上也没有可解析的集"。 */}
        {seasons.length === 0 && movie === null ? (
          <EmptyState
            title={t('media_detail_no_seasons_title')}
            description={t('media_detail_no_seasons_desc')}
            isCompact
          />
        ) : null}
      </div>
    </Section>
  )
}
