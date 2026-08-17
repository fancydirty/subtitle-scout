// web/src/notifications/NotificationsPage.tsx：通知页（#/notifications）——完成的成果流水。
//
// 这一屏回答的问题（FRONTEND-SPEC §2.2）：「过去一周找到并装上了哪些字幕」。
// R-F3 三条裁决在这一屏的落点：
//   · **保留一周** → 列表内容就是端点吐的（后端读窗 NOTIFICATION_RETENTION_MS）。
//     前端**不再写第二份一周窗**：两份实现必然静默漂移。
//   · **倒序流水** → 桶间按天倒序、桶内按 latestAt 倒序（notifText.bucketByDay）。
//   · **不做已读状态** → 全页**没有任何写路径**。
//
// ── 🔴 SSE 与列表的分工 ─────────────────────────────────────────────────────
// **列表只由端点出。SSE 不直接插列表。** found 事件的职责是再打一次 GET（useNotifications
// 里的 useReloadOnFound）。事件对象的 message / title / data 一个字段都不参与列表渲染。
import { Section } from '../components/ui/section.js'
import { Skeleton } from '../components/ui/skeleton.js'
import { EmptyState } from '../components/ui/empty-state.js'
import { Button } from '../components/ui/button.js'
import { useNotifications } from '../api/hooks.js'
import { useEventsStatus } from '../events/EventsProvider.js'
import { useResumeEdge } from '../events/resumeEdge.js'
import { useT } from '../i18n/useT.js'
import { localizeError } from '../lib/errorText.js'
import { LiveOffBanner } from './NewFoundBanner.js'
import { NotificationRow } from './NotificationRow.js'
import { bucketByDay, formatDayStamp, groupKey, type DayBucket } from './notifText.js'
import { liveFreshness } from '../workbench/inspectFreshness.js'

function DaySection({ bucket }: { bucket: DayBucket }) {
  const { t } = useT()
  const heading =
    bucket.offset === 0
      ? t('notif_day_today')
      : bucket.offset === 1
        ? t('notif_day_yesterday')
        : formatDayStamp(bucket.stampAt)

  return (
    <section className="notif-day" aria-label={heading}>
      <h2 className="notif-day-heading">{heading}</h2>
      <div className="notif-day-rows">
        {bucket.groups.map((g) => (
          <NotificationRow key={groupKey(g)} group={g} compact={bucket.offset !== 0} />
        ))}
      </div>
    </section>
  )
}

function LoadingRows() {
  const { t } = useT()
  return (
    <div aria-busy="true" aria-label={t('a11y_loading_notifications')} className="notif-day-rows">
      {Array.from({ length: 6 }).map((_, i) => (
        <div className="notif-row notif-row-skel" key={i}>
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Skeleton index={i} className="h-3 w-[45%] rounded-[4px]" />
            <Skeleton index={i} className="h-2.5 w-[28%] rounded-[4px]" />
          </div>
        </div>
      ))}
    </div>
  )
}

export function NotificationsPage() {
  const { data, loading, error, reload } = useNotifications()
  const { t, lang } = useT()
  const status = useEventsStatus()
  useResumeEdge(status, reload)
  const live = liveFreshness(status)
  const liveBanner = <LiveOffBanner live={live} onRefresh={reload} />

  if (loading && !data) {
    return (
      <Section>
        <LoadingRows />
      </Section>
    )
  }

  if (error && !data) {
    return (
      <Section>
        <EmptyState
          title={t('notif_error_title')}
          description={localizeError(error, lang)}
          actions={
            <Button variant="secondary" onClick={reload}>
              {t('notif_retry')}
            </Button>
          }
        />
      </Section>
    )
  }

  const groups = data ?? []
  if (groups.length === 0) {
    return (
      <Section>
        <div className="flex flex-col gap-3">
          {liveBanner}
          <EmptyState title={t('notif_empty_title')} description={t('notif_empty_desc')} />
        </div>
      </Section>
    )
  }

  const buckets = bucketByDay(groups, Date.now())

  return (
    <Section>
      <div className="flex flex-col gap-3">
        {liveBanner}
        <span className="font-mono text-[11px] leading-4 text-muted-foreground">
          {t('notif_window_note')} · {groups.length}
        </span>
        <div className="flex flex-col gap-4">
          {buckets.map((b) => (
            <DaySection key={b.offset} bucket={b} />
          ))}
        </div>
      </div>
    </Section>
  )
}
