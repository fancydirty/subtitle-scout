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
import { useMediaLibrary } from '../api/hooks.js'
import { useT } from '../i18n/useT.js'
import { mediaItemHref } from '../shell/route.js'
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
 *  返回结构化片段而非拼好的串：i18n 的三段文案由调用方组合，且测试能逐段断言。 */
export function coverageParts(item: MediaLibraryItemDTO): {
  subtitled: number
  onDisk: number
  /** null = 应有集未知（电影，或 tmdb_seasons 还没回填）——调用方**不许**渲染这一段。 */
  expected: number | null
} {
  return {
    subtitled: item.subtitledEpisodeCount,
    onDisk: item.onDiskEpisodeCount,
    expected: item.expectedEpisodeCount > 0 ? item.expectedEpisodeCount : null,
  }
}

function MediaCard({ item }: { item: MediaLibraryItemDTO }) {
  const { t } = useT()
  const title = item.chineseTitle ?? item.title
  const { subtitled, onDisk, expected } = coverageParts(item)

  return (
    <a className="media-card" href={mediaItemHref(item.workId)} aria-label={title}>
      <div className="media-card-frame">
        <AspectRatio ratio={2 / 3} fit="cover">
          <MediaPoster posterPath={item.posterPath} name={title} />
        </AspectRatio>
      </div>
      <div className="media-card-meta">
        <span className="block text-[13px] font-medium leading-5 text-foreground">{title}</span>
        <span className="block font-mono text-[11px] leading-4 text-muted-foreground">
          {/* mono 读数——同 Topbar 新鲜度行那套"技术性读数"的排印语言。
              三个数字之间用 · 分隔，每个数字自带它的名字，不做无标签的 "3/12/24"
              （那种写法一年后没人记得中间那个是什么）。 */}
          {t('media_card_subtitled')} {subtitled} · {t('media_card_ondisk')} {onDisk}
          {expected !== null ? ` · ${t('media_card_expected')} ${expected}` : ''}
        </span>
      </div>
    </a>
  )
}

function LoadingGrid() {
  return (
    <div aria-busy="true" aria-label="loading media library">
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
  const { t } = useT()

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
          description={error}
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
        <EmptyState title={t('media_empty_title')} description={t('media_empty_desc')} />
      </Section>
    )
  }

  return (
    <Section>
      <div className="flex flex-col gap-3">
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
