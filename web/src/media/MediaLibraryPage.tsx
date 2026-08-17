// web/src/media/MediaLibraryPage.tsx：媒体库页列表（#/media）——海报墙。
//
// 这一屏回答的问题（FRONTEND-SPEC §一）：「每部剧应该有哪些集、磁盘上实际有哪些、
// 字幕是什么情况」。**列表层只给概览数字**，逐集状态在详情页（#/media/:workId）。
//
// ── R-F2 在这一屏的体现 ─────────────────────────────────────────────────
// 后端已按 `work_id` 合并（两个「绝命毒师」目录 → 一张卡），且「任一份有字幕就算已获取」
// 的口径体现在 `subtitledEpisodeCount` 上。这一屏**如实呈现后端给的数字，不再自己算**——
// 前端做第二遍聚合就是把 R-F2 的判据复制一份到浏览器里（C30 的原型）。
//
// ── R-F5 在这一屏的体现 ─────────────────────────────────────────────────
// "12/24 集"里的分母是 `expectedEpisodeCount`（tmdb_seasons 行数 = 应有集）。
// ⚠️ expected=0 有**两种**含义：电影（本来就没有季集）与"应有集缓存还没回填"。
// 两种都**不许显示 "N/0"** —— 那会让用户以为这部剧应该有 0 集。见 coverageLine。
//
// ── 🔴 守备目录健康度（终局审计 🔴-1）─────────────────────────────────────
// 这一页多打一个 GET /api/v2/health，只为 `roots[]` 那一条提示（RootHealthNote）。
// 为什么这一页需要它：R8 三道闸在某个根读不到时会**跳过该根的删除清理**，于是海报墙上
// 那些卡片照常在场、数字照常是上一轮的——页面看上去完全正常，而它描述的磁盘已经不在了。
// ⚠️ useHealth 在这一页**只喂 roots**（RootHealthNote）。found / current 从有变无的
// 再拉在 useMediaLibrary 里订 SSE，不在本页、也不轮询 health。
//
// ── 视觉（R-F11 / DESIGN.md）────────────────────────────────────────────
// 四层 surface 阶梯 + 发丝线、**拒绝投影**。token 用**本仓真实存在的**那套
// （--color-card / --color-border / --color-secondary），**不是** DESIGN.md 写的
// surface-1 / hairline —— 后者在本仓 grep 零命中，写 `var(--color-surface-1, transparent)`
// 会静默 fallback 成透明（Task ⑦ 的实施者踩过并在 PlaceholderPage 头注释里记了这条）。
import { Section } from '../components/ui/section.js'
import { Skeleton } from '../components/ui/skeleton.js'
import { EmptyState } from '../components/ui/empty-state.js'
import { Button } from '../components/ui/button.js'
import { AspectRatio } from '../components/ui/aspect-ratio.js'
import { useMediaLibrary, useHealth } from '../api/hooks.js'
import { useT } from '../i18n/useT.js'
import { localizeError } from '../lib/errorText.js'
import { mediaItemHref } from '../shell/route.js'
import { RootHealthNote } from '../shell/RootHealthNote.js'
import { MediaPoster } from './MediaPoster.js'
import type { MediaLibraryItemDTO } from '../api/types.js'

/** 一张卡底部那行覆盖读数。
 *
 *  三种形状，对应三种**不同的事实**（不是三种排版偏好）：
 *   · 电影（mediaType==='movie'）：没有季集，说"有字幕 / 没字幕"就够了。
 *   · 剧集且 expected>0：`已配 3 / 磁盘 12 / 应有 24` —— R-F5 的实有 vs 应有在这里露出。
 *   · 剧集但 expected===0：应有集缓存还没回填。**只说磁盘上有多少**，绝口不提应有集
 *     ——显示 "12/0" 是在报一个我们并不知道的数字。
 *
 *  ── 🟡-3：`missingEpisodeCount` 的读取点（终局审计）──────────────────────
 *  这个字段后端算了（mediaLibraryApi.ts:461）、DTO 声明了，而此前**只在测试 fixture 里
 *  出现过**——变异 `missingEpisodeCount: 0` → 前端 0 红。本函数是它的第一个读取方。
 *
 *  🔴 **原样取 DTO，绝不在浏览器里算 `expected - onDisk`**。看上去那是同一个数字，
 *  但后端那一行是 `Math.max(0, expected - onDisk)`——夹 0 是一个**判据**（应有集缓存
 *  缺失时裸减法得负数），在前端复制一份就是把判据变成两份，任一侧改动都会静默漂移出
 *  "缺 -12 集"。同 subtitledEpisodeCount「前端不做第二遍聚合」的既有纪律。
 *
 *  🔴 **`missing === 0` 时返回 null，整段不渲染**（沉默即好消息，同 RootHealthNote /
 *  wb-perm-line 的既有口径）。一部齐全的剧不该在卡片上挂一个"缺 0 集"——那是噪音，
 *  而这一行的全部价值就是让不齐全的那几张卡在海报墙上跳出来。
 *  ⚠️ 顺带封住 expected===0 那一支：后端此时给 missing=0（夹 0 的结果），于是
 *  "应有集未知"的卡片自动不显示缺集——与上面"绝口不提应有集"保持一致，
 *  不需要在这里再写一次 expected 的条件（写了就是第三份判据）。 */
export function coverageParts(item: MediaLibraryItemDTO): {
  subtitled: number
  /** null = 没有任何内嵌中文轨的集——调用方**不许**渲染这一段（沉默即好消息，同 unplaced）。
   *
   *  🔴 2026-08-14（用户裁决③「分开显示」）。为什么必须与 subtitled 分开呈现：
   *  后端此前用 `dot !== 'none'` 把外挂 sidecar 与内嵌轨混算进 subtitledEpisodeCount，
   *  生产 53/75 部命中。最刺眼的形态是《翘楚》——列表卡说「已配 5」，点进详情页
   *  24 格**全是**「原生语言不需要字幕」，库里外挂 sidecar 是 **0** 个。
   *  同一件事两个页面给了不同答案，而"已配"描述的是一份**我们并没有做过的工作**。
   *
   *  拆开后列表页「已配」与详情页 `subtitledFileCount > 0` 的格数恒等（后端同名用例钉住），
   *  这条等式就是用户选这个方案而不是"只数外挂"或"维持现状"的唯一理由。
   *
   *  ⚠️ 同 missing/unplaced 的既有纪律：**原样取 DTO，不在浏览器里算**。 */
  embedded: number | null
  onDisk: number
  /** null = 应有集未知（电影，或 tmdb_seasons 还没回填）——调用方**不许**渲染这一段。 */
    expected: number | null
  /** null = 本地字幕齐（或无文件）——调用方**不许**渲染缺口黄字。原样取 DTO。 */
  uncovered: number | null
  /** null = 不缺集（或应有集未知）——调用方**不许**渲染这一段。 */
  missing: number | null
  /** null = 没有进不了网格的文件——调用方**不许**渲染这一段（沉默即好消息）。
   *
   *  🔴 2026-08-13。这一段的存在理由与 missing 那一段**不同**：missing 说的是
   *  "磁盘上少了什么"，这一段说的是"磁盘上有东西我没归到位"。此前这些文件被后端
   *  算进 onDisk（一整批只算 1 集），列表与详情因此差 1 集；现在它们退出集数，
   *  **必须在这里被说出来**——否则它们从"算错了"变成"凭空消失"，那是更糟的一句假话。
   *
   *  ⚠️ 同 missing 的既有纪律：**原样取 DTO，不在浏览器里算**。 */
  unplaced: number | null
} {
  return {
    subtitled: item.subtitledEpisodeCount,
    embedded: item.embeddedEpisodeCount > 0 ? item.embeddedEpisodeCount : null,
    onDisk: item.onDiskEpisodeCount,
    expected: item.expectedEpisodeCount > 0 ? item.expectedEpisodeCount : null,
    uncovered: item.uncoveredEpisodeCount > 0 ? item.uncoveredEpisodeCount : null,
    missing: item.missingEpisodeCount > 0 ? item.missingEpisodeCount : null,
    // `> 0` 而不是真值性：与 missing 同形。后端老版本缺这个字段时 undefined > 0 为 false
    // → 整段不渲染，这是**正确的降级**（宁可少说一句，不许渲染 "NaN 个文件"）。
    unplaced: item.unplacedFileCount > 0 ? item.unplacedFileCount : null,
  }
}

function MediaCard({ item }: { item: MediaLibraryItemDTO }) {
  const { t } = useT()
  const title = item.chineseTitle ?? item.title
  const { subtitled, embedded, onDisk, uncovered, unplaced } = coverageParts(item)
  const covered = subtitled + (embedded ?? 0)

  return (
    <a className="media-card" href={mediaItemHref(item.workId)} aria-label={title}>
      <div className="media-card-frame">
        <AspectRatio ratio={2 / 3} fit="cover">
          <MediaPoster posterPath={item.posterPath} name={title} />
        </AspectRatio>
      </div>
      <div className="media-card-meta">
        <span className="block text-[13px] font-medium leading-5 text-foreground">{title}</span>
        <span
          className={uncovered === null ? 'media-card-frac media-card-frac-done' : 'media-card-frac'}
          data-testid="media-card-coverage"
        >
          {t('media_card_coverage')} {covered}/{onDisk}
        </span>
        {onDisk > 0 ? (
          <span className="media-card-bar" aria-hidden="true">
            <i className="media-card-bar-g" style={{ width: `${(subtitled / onDisk) * 100}%` }} />
            {embedded !== null ? (
              <i className="media-card-bar-b" style={{ width: `${(embedded / onDisk) * 100}%` }} />
            ) : null}
          </span>
        ) : null}
        <span className="media-card-stats" data-testid="media-card-stats">
          <span className="media-card-stat">{t('media_card_subtitled')} {subtitled}</span>
          {embedded !== null ? (
            <span className="media-card-stat">· {t('media_card_embedded')} {embedded}</span>
          ) : null}
        </span>
        {uncovered !== null && (
          <span className="media-card-missing" data-testid="media-card-uncovered">
            {item.mediaType === 'movie'
              ? t('media_card_uncovered_movie')
              : `${t('media_card_uncovered')} ${uncovered} ${t('media_card_uncovered_unit')}`}
          </span>
        )}
        {unplaced !== null && (
          <span className="media-card-missing" data-testid="media-card-unplaced">
            {t('media_card_unplaced').replace('{n}', String(unplaced))}
          </span>
        )}
      </div>
    </a>
  )
}

function LoadingGrid() {
  const { t } = useT()
  return (
    <div aria-busy="true" aria-label={t('a11y_loading_media_library')}>
      <div className="media-grid">
        {Array.from({ length: 12 }).map((_, i) => (
          <div className="flex flex-col gap-2" key={i}>
            <div className="media-card-frame media-card-skel">
              <Skeleton index={i} className="h-full w-full rounded-control" />
            </div>
            <Skeleton index={i} className="h-3 w-[70%] rounded-[4px]" />
          </div>
        ))}
      </div>
    </div>
  )
}

export function MediaLibraryPage() {
  const { data, loading, error, reload } = useMediaLibrary()
  const { data: health } = useHealth()
  const { t, lang } = useT()

  if (loading && !data) {
    return (
      <Section>
        <LoadingGrid />
      </Section>
    )
  }

  // 错误态**绝不显示空态文案**（§4.4：那是谎报——"库里没有东西"与"我没能问到"是两件事）。
  if (error && !data) {
    return (
      <Section>
        <EmptyState
          title={t('media_error_title')}
          description={localizeError(error, lang)}
          actions={
            <Button variant="secondary" onClick={reload}>
              {t('media_retry')}
            </Button>
          }
        />
      </Section>
    )
  }

  const items = data ?? []
  if (items.length === 0) {
    return (
      <Section>
        <div className="flex flex-col gap-3">
          {/* 🔴 空态下这条**尤其**要出：「库里什么都没有」与「守备目录读不到，所以我
              什么都没看见」是两件事，而空态文案自己说不出后者。这正是 §4.4「错误态绝不
              显示空态文案」那条纪律的同一形态——只不过这里的"错误"不在 HTTP 层
              （端点 200、返回 []），而在磁盘层。 */}
          <div className="root-health-strip"><RootHealthNote roots={health?.roots} /></div>
          <EmptyState title={t('media_empty_title')} description={t('media_empty_desc')} />
        </div>
      </Section>
    )
  }

  return (
    <Section>
      <div className="flex flex-col gap-3">
        <div className="root-health-strip"><RootHealthNote roots={health?.roots} /></div>
        <span className="font-mono text-[11px] leading-4 text-muted-foreground">
          {t('media_result_count_prefix')} {items.length}
        </span>
        <div className="media-grid">
          {items.map((it) => (
            <MediaCard key={it.workId} item={it} />
          ))}
        </div>
      </div>
    </Section>
  )
}
