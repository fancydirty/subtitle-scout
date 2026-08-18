// web/src/notifications/NotificationRow.tsx：一条通知（= 一个 work+season 组）。
//
// 形态（R-F3 原文）：「XX 剧找到了 S01 的第 3/5/7 集」；电影就是「已找到字幕」。
//
// ── 🔴 2026-08-13：`season === null` **不再**是"这是电影"的判据 ──────────────
// 那个判据在 notifications 表里是**二义**的，生产上正在把剧集渲染成电影行：
//   ① 真电影（recordFound 的入参注释：「NULL = 电影」）
//   ② **剧集，但那个文件的季没解析出来**——装盘时 `f.season` 原样写进来就是 NULL。
//      生产实测：112 个文件 season/episode 为 NULL，其中 79 个属于 TV 作品。
// 两者在这张表里长得一模一样，于是 ② 被说成「已找到字幕」的电影行——一句当场可见的假话
// （用户点进去看到的是一部剧的季集网格）。
//
// 判据改成后端新给的 `mediaType`（LEFT JOIN works 现取的结构事实，三态）：
//   · 'movie'   → 「已找到字幕」（原电影形态，一字未改）
//   · 'tv'      → 走剧集形态；此时 season 若仍为 null，说明**季没解析出来**，
//                 那就说"这一集没能归入季集"，**绝不**渲染 "S null"，也绝不谎称电影
//   · 'unknown' → works 行已被删（用户移了守备目录，通知还在一周窗内）。我们**确实
//                 不知道**它是哪种，故走一条不声称任何一边的话：只报"已找到字幕"这个
//                 确实发生过的事实，不提季、不提集、也不说它是电影。
//                 🔴 绝不 `?? 'movie'` 兜底——那正是这次要修的那句假话原地复活。
//
// ── 三种形状对应三种**不同的事实**（不是三种排版偏好）──────────────────────
//  · 电影（mediaType==='movie'）：没有季集，说"已找到字幕"就够了，绝不显示 "S null"。
//  · 剧集有季且有集号：`S01 · 第 3/5/7 集`（集号折叠见 notifText.formatEpisodes）。
//  · 剧集但 episodes 为空：理论上不该发生（后端只在 episode !== null 时 push），
//    但它是**跨进程的数据形状假设**，不是本地不变式。此时退化成只报季——绝不渲染
//    一个空的"第  集"（那看起来像页面坏了）。
//
// ── title 是快照，这里如实照搬 ────────────────────────────────────────────
// 后端存的是**写入那一刻**的作品名。作品在一周窗内改过名的话，历史行会与媒体库页
// 显示的当前名不一致。**不去 join 当前名纠正它**：通知是"当时发生了什么"的账目，
// 而且要纠正就得再打一个媒体库端点、为一周内极少发生的改名给每次渲染加一次往返。
//
// ── 视觉（R-F11 / DESIGN.md）──────────────────────────────────────────────
// 四层 surface 阶梯 + 发丝线，**拒绝投影**。token 只用本仓真实存在的那套
// （--color-card / --color-border / --color-secondary）——DESIGN.md 写的 surface-1 /
// hairline 在本仓 grep 零命中，写 `var(--color-surface-1, transparent)` 会静默 fallback
// 成透明（Task ⑦ 的实施者踩过并记在 PlaceholderPage 头注释里）。
import type { FoundGroupDTO } from '../api/types.js'
import { backdropUrl } from '../api/client.js'
import { useT } from '../i18n/useT.js'
import { mediaItemHref } from '../shell/route.js'
import { displayTitle } from '../workbench/displayTitle.js'
import { SplitHero } from '../workbench/WorkbenchCards.js'
import { buttonVariants } from '../components/ui/button.js'
import { formatClock, formatEpisodes } from './notifText.js'

/** via → 文案键。**穷尽 Record**：后端将来加第四种来路时 tsc 立刻红
 *  （写成 if/else 链的话新来路会静默渲染成空白）。 */
const VIA_LABEL = {
  fetch: 'notif_via_fetch',
  translate: 'notif_via_translate',
  mixed: 'notif_via_mixed',
} as const satisfies Record<FoundGroupDTO['via'], string>

/** 这一条该画成哪种形状。**三态，不是布尔**——见文件头对 `season === null` 二义性的论证。
 *
 *  导出是为了让测试能直接钉这张判据表（渲染层的断言只覆盖得到最终 DOM，
 *  而"tv + season=null 该走哪一支"是判据本身，值得单独一条）。 */
export type NotifShape =
  /** 真电影：「已找到字幕」。 */
  | 'movie'
  /** 剧集且季号已知：`S01 · 第 3/5/7 集`。 */
  | 'season'
  /** 剧集但**季没解析出来**：说这一集没能归入季集。绝不谎称电影、绝不画 "S null"。 */
  | 'tv-unplaced'
  /** 作品身份查不到（works 行已删）：只报"已找到字幕"，不声称是电影还是剧集。 */
  | 'unknown'

export function notifShape(group: Pick<FoundGroupDTO, 'season' | 'mediaType'>): NotifShape {
  // 🔴 `mediaType` 缺席（老后端）→ 'unknown'，**不是**回落到旧的 season 判据。
  // 回落等于让这个 bug 在混版部署下静默续命，而 'unknown' 那句话在任何情况下都是真的。
  if (group.mediaType === 'movie') return 'movie'
  if (group.mediaType !== 'tv') return 'unknown'
  return group.season === null ? 'tv-unplaced' : 'season'
}

export function NotificationRow({ group }: { group: FoundGroupDTO }) {
  const { t, lang } = useT()
  const shape = notifShape(group)
  const episodes = formatEpisodes(group.episodes)
  const title = displayTitle(lang, group.title, group.chineseTitle ?? null)

  return (
    <SplitHero
      as="a"
      href={mediaItemHref(group.workId)}
      className="notif-row wb-run-card wb-hero-bleed"
      testId="notif-row"
      src={backdropUrl(group.backdropPath ?? null)}
      aria-label={title}
      data-via={group.via}
      data-shape={shape}
    >
      <span className="font-mono text-[11px] leading-4 text-weak tabular-nums">
        {formatClock(group.latestAt)}
      </span>
      <span className="wb-card-title">{title}</span>
      <div className="wb-card-sub">
        {shape === 'movie' ? (
          <span>{t('notif_movie_found')}</span>
        ) : shape === 'unknown' ? (
          <span data-testid="notif-unknown">{t('notif_found_generic')}</span>
        ) : shape === 'tv-unplaced' ? (
          <span data-testid="notif-unplaced">{t('notif_season_unplaced')}</span>
        ) : (
          <>
            <span>S{String(group.season).padStart(2, '0')}</span>
            {episodes !== '' && (
              <span>
                {t('notif_episodes_prefix')} {episodes}
                {t('notif_episodes_suffix')}
              </span>
            )}
          </>
        )}
        <span className="text-faint">·</span>
        <span>{t(VIA_LABEL[group.via])}</span>
      </div>
      <span className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
        {t('notif_open_library')}
      </span>
    </SplitHero>
  )
}
