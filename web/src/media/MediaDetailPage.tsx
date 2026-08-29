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
import { useState } from 'react'
import { Section } from '../components/ui/section.js'
import { Skeleton } from '../components/ui/skeleton.js'
import { EmptyState } from '../components/ui/empty-state.js'
import { Button } from '../components/ui/button.js'
import type { Async } from '../api/hooks.js'
import type {
  MediaLibraryDetailDTO,
  MediaLibrarySeasonDTO,
  MediaLibraryMovieDTO,
  MediaSubtitleDot,
  EpisodeState,
} from '../api/types.js'
import { backdropUrl } from '../api/client.js'
import { useT } from '../i18n/useT.js'
import { localizeError } from '../lib/errorText.js'
import { EpisodeCell } from './EpisodeCell.js'
import { EpisodeMark } from './EpisodeMark.js'
import { EPISODE_STATE_LABEL, LEGEND_STATES } from './episodeStateMeta.js'
import { displayTitle } from '../workbench/displayTitle.js'

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

// ── Hero D（2026-08-28）：metadata 行的「就绪 N/M」聚合 ──────────────────────────
/** 一格是否算「就绪」。**逐字复刻海报卡列表的 ready 口径**——后端 buildMediaLibrary 里
 *  `ready = subtitled(dot='green') + embedded(dot='blue') + originLanguage(dot='none'∧origin-skip)`
 *  （mediaLibraryApi.ts）。判据只读后端**已经算好**的 dot / episodeState 两个字段，前端不重判
 *  语言、不碰 target_languages。
 *
 *  🔴 为什么这是「同一口径」而非「另造第二份判据」（任务书铁律）：详情 DTO 里每一格的
 *  dot/episodeState 与列表里那一格是**同一份 aggregateDot 的产出**（同一后端函数、同一 workId）。
 *  这里只是把列表按格做的那三段 filter 计数，在详情的同一批格上再做一遍算术——判据本身
 *  （green/blue/none·origin-skip 算就绪）没有第二个定义点，后端改口径这里跟着变，不漂移。 */
function isReadyCell(cell: { dot: MediaSubtitleDot; episodeState: EpisodeState }): boolean {
  return (
    cell.dot === 'green' ||
    cell.dot === 'blue' ||
    (cell.dot === 'none' && cell.episodeState === 'origin-skip')
  )
}

/** 整部作品的「就绪 N / 本地 M」聚合（hero 进度条 + 「就绪 N/M」文字共用这一个数）。
 *  onDisk = 实线格（虚线格 onDisk=false 不算）+ 有文件的电影格；口径与列表 `onDiskEpisodeCount`
 *  （去重格数）一致。 */
export function readyTally(detail: MediaLibraryDetailDTO): { ready: number; onDisk: number } {
  let ready = 0
  let onDisk = 0
  for (const s of detail.seasons) {
    for (const e of s.episodes) {
      if (!e.onDisk) continue
      onDisk++
      if (isReadyCell(e)) ready++
    }
  }
  // 电影那一格：fileCount>0 = 磁盘上有（与列表 cells.size 同口径；零文件电影 absent 不算）。
  if (detail.movie && detail.movie.fileCount > 0) {
    onDisk++
    if (isReadyCell(detail.movie)) ready++
  }
  return { ready, onDisk }
}

/** 秒 → 「1h48m」/「45m」。ffprobe 时长是整秒量级，四舍五入到分钟即可。 */
export function formatDuration(sec: number): string {
  const total = Math.max(0, Math.round(sec))
  const h = Math.floor(total / 3600)
  const m = Math.round((total % 3600) / 60)
  return h > 0 ? `${h}h${m}m` : `${m}m`
}

/** 字节 → 「1.4 GB」/「700 MB」。≥1 GiB 走 GB 一位小数，否则 MB 整数。 */
export function formatSize(bytes: number): string {
  const gb = bytes / 1024 ** 3
  if (gb >= 1) return `${gb.toFixed(1)} GB`
  return `${Math.round(bytes / 1024 ** 2)} MB`
}

/** hero 简介：两~三行截断 + 「更多」原地展开（非弹窗）。短简介（≤100 字符）直接全显、不挂按钮。 */
function HeroOverview({ text }: { text: string }) {
  const { t } = useT()
  const [expanded, setExpanded] = useState(false)
  const long = text.length > 100
  const clamped = long && !expanded
  return (
    <div className="media-detail-hero-overview">
      <p
        data-testid="media-detail-overview"
        className={clamped ? 'media-detail-overview-text media-detail-overview-clamp' : 'media-detail-overview-text'}
      >
        {text}
      </p>
      {long ? (
        <button
          type="button"
          className="media-detail-overview-toggle"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? t('media_detail_overview_less') : t('media_detail_overview_more')}
        </button>
      ) : null}
    </div>
  )
}

/** Hero D 头部：全宽 backdrop（无图整块不渲染）+ 实底标题区 + metadata 行 + 简介。 */
function DetailHero({ detail, title, originalTitle }: {
  detail: MediaLibraryDetailDTO
  title: string
  originalTitle: string | null
}) {
  const { t } = useT()
  const { work, seasons, movie } = detail
  const backdrop = backdropUrl(work.backdropPath)
  const { ready, onDisk } = readyTally(detail)

  // metadata 行的文字段（· 分隔）。就绪读数复用海报卡的 media_card_coverage（'就绪'/'Ready'）。
  const facts: string[] = []
  if (onDisk > 0) facts.push(`${t('media_card_coverage')} ${ready}/${onDisk}`)
  if (work.year !== null) facts.push(String(work.year))
  if (work.mediaType === 'movie') {
    facts.push(t('media_movie_heading'))
    if (movie && movie.durationSec !== null) facts.push(formatDuration(movie.durationSec))
    if (movie && movie.sizeBytes !== null) facts.push(formatSize(movie.sizeBytes))
  } else {
    const n = seasons.length
    facts.push(
      n > 0
        ? `${t('media_detail_kind_series')} · ${n} ${t('media_detail_seasons_unit')}`
        : t('media_detail_kind_series'),
    )
  }

  return (
    <div className="media-detail-hero">
      {/* 全宽 backdrop：16:9、圆角上缘、底缘线性渐入页面底色。**无图整块不渲染**（无占位灰块）。 */}
      {backdrop ? (
        <img className="media-detail-hero-backdrop" data-testid="media-detail-backdrop" src={backdrop} alt="" loading="lazy" />
      ) : null}

      {/* 标题区（实底，图外）：中文名 + 原名副行。 */}
      <div className="media-detail-hero-head">
        <h1 className="text-page-title font-semibold leading-6 text-foreground">{title}</h1>
        {originalTitle ? (
          <span className="text-[13px] leading-5 text-muted-foreground">{originalTitle}</span>
        ) : null}

        {/* metadata 行：就绪进度条 + 事实段。 */}
        <div className="media-detail-hero-meta">
          {onDisk > 0 ? (
            <span className="media-detail-hero-bar" aria-hidden="true">
              <i
                className="media-detail-hero-bar-fill"
                data-testid="media-detail-ready-fill"
                style={{ width: `${(ready / onDisk) * 100}%` }}
              />
            </span>
          ) : null}
          <span className="media-detail-hero-facts">{facts.join(' · ')}</span>
        </div>

        {work.overview && work.overview.trim() !== '' ? <HeroOverview text={work.overview} /> : null}
      </div>
    </div>
  )
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
      <h2 className="text-section font-semibold leading-5 text-foreground">
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

/** 电影那一格。R-F5：电影没有季集，所以没有网格。
 *  ⚠️ 后端注释点名：电影格**可能零文件**（空壳 works 直达详情端点），此时 episodeState
 *  是 'absent' —— 走虚线、不染色，与剧集的虚线格完全一致。
 *  有文件时露出磁盘文件名，不再复用拉满整行的集号格（那是给 E01 这种短标签用的）。 */
function MovieBlock({ movie }: { movie: MediaLibraryMovieDTO }) {
  const { t } = useT()
  const label = t(EPISODE_STATE_LABEL[movie.episodeState])
  return (
    <div className="flex flex-col gap-2">
      <h2 className="text-section font-semibold leading-5 text-foreground">{t('media_movie_heading')}</h2>
      <div role="list">
        <div
          className="media-movie-row"
          data-ondisk={movie.fileCount > 0 ? 'true' : 'false'}
          role="listitem"
          aria-label={movie.filename ? `${movie.filename} ${label}` : label}
        >
          {movie.filename ? (
            <span className="media-movie-name">{movie.filename}</span>
          ) : null}
          <span className="media-ep-num" data-state={movie.episodeState}>
            {movie.filename ? null : label}
          </span>
          <EpisodeMark state={movie.episodeState} />
        </div>
      </div>
    </div>
  )
}

function DetailSkeleton() {
  const { t } = useT()
  return (
    <div className="flex gap-4" aria-busy="true" aria-label={t('a11y_loading_media_detail')}>
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
  const { t, lang } = useT()

  if (detail.loading && !detail.data) {
    return (
      <Section className="mx-auto w-full max-w-detail">
        <DetailSkeleton />
      </Section>
    )
  }

  if (detail.error && !detail.data) {
    if (isNotFoundError(detail.error)) {
      return (
        <Section className="mx-auto w-full max-w-detail">
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
      <Section className="mx-auto w-full max-w-detail">
        <EmptyState
          title={t('media_error_title')}
          description={localizeError(detail.error, lang)}
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
  // 作品名跟随 UI 语言（2026-08-18 裁决）：zh 用 chineseTitle ?? title，en 用 title。
  // 副标题 originalTitle 只在 zh 且 chineseTitle ≠ title 时渲染——
  // 用户：「外国人不需要知道它中文名是啥」。副标题存在的理由是补充原文 identity，
  // 不是展示另一种语言。en 时整个槽不渲染（originalTitle === null，JSX 已有 null 闸）。
  const title = displayTitle(lang, work.title, work.chineseTitle ?? null)
  const originalTitle =
    lang === 'zh' && work.chineseTitle && work.chineseTitle !== work.title
      ? work.title
      : null

  return (
    <Section className="mx-auto w-full max-w-detail">
      <div className="flex flex-col gap-6">
        <a className="text-[13px] text-muted-foreground hover:underline" href="#/media">
          {t('media_back')}
        </a>

        <DetailHero detail={detail.data} title={title} originalTitle={originalTitle} />

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
