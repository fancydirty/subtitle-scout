// web/src/notifications/NotificationRow.tsx：一条通知（= 一个 work+season 组）。
//
// 形态（R-F3 原文）：「XX 剧找到了 S01 的第 3/5/7 集」；电影就是「已找到字幕」。
//
// ── 三种形状对应三种**不同的事实**（不是三种排版偏好）──────────────────────
//  · 电影（season === null）：没有季集，说"已找到字幕"就够了，绝不显示 "S null"。
//  · 剧集有集号：`S01 · 第 3/5/7 集`（集号折叠见 notifText.formatEpisodes）。
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
import { useT } from '../i18n/useT.js'
import { mediaItemHref } from '../shell/route.js'
import { formatClock, formatEpisodes } from './notifText.js'

/** via → 文案键。**穷尽 Record**：后端将来加第四种来路时 tsc 立刻红
 *  （写成 if/else 链的话新来路会静默渲染成空白）。 */
const VIA_LABEL = {
  fetch: 'notif_via_fetch',
  translate: 'notif_via_translate',
  mixed: 'notif_via_mixed',
} as const satisfies Record<FoundGroupDTO['via'], string>

export function NotificationRow({ group }: { group: FoundGroupDTO }) {
  const { t } = useT()
  const isMovie = group.season === null
  const episodes = formatEpisodes(group.episodes)

  return (
    // 整条可点，落到媒体库详情页——「找到了字幕」之后用户唯一想做的下一件事就是
    // 去看那部剧现在是什么样。**不做已读状态**（R-F3），所以点击不改变这一条的任何外观。
    <a
      className="notif-row"
      href={mediaItemHref(group.workId)}
      data-via={group.via}
      aria-label={group.title}
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium leading-5 text-foreground">
          {group.title}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[11px] leading-4 text-muted-foreground">
          {isMovie ? (
            <span>{t('notif_movie_found')}</span>
          ) : (
            <>
              {/* 季号补零成 S01——与媒体库页/文件命名的既有排印一致。 */}
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
      </div>
      {/* 时刻读数：mono、右对齐、不翻译（同 shell/freshness.ts 的既有口径）。
          日期在段落标题上，这里只给 HH:MM——每行重复一遍日期是噪音。 */}
      <span className="shrink-0 font-mono text-[11px] leading-4 text-weak tabular-nums">
        {formatClock(group.latestAt)}
      </span>
    </a>
  )
}
