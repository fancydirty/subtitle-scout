// web/src/notifications/NotificationsPage.tsx：通知页（#/notifications）——完成的成果流水。
//
// 这一屏回答的问题（FRONTEND-SPEC §2.2）：「过去一周找到并装上了哪些字幕」。
// R-F3 三条裁决在这一屏的落点：
//   · **保留一周** → 列表内容就是端点吐的（后端读窗 NOTIFICATION_RETENTION_MS）。
//     前端**不再写第二份一周窗**：两份实现必然静默漂移（后端注释对"读窗与清理共用同一
//     常量"的论证，同一个道理）。前端要做的是**不许自己往列表里塞端点没给的东西**——
//     那才是唯一能让陈年/未来数据混进来的路子，也正是下面 §SSE 分工那条铁律的另一半。
//   · **倒序流水** → 桶间按天倒序、桶内按 latestAt 倒序（notifText.bucketByDay）。
//   · **不做已读状态** → 全页**没有任何写路径**：不发 PATCH/POST，不存 localStorage，
//     不给行加 read/unread 类，点击不改变任何一条的外观。端点本身也是 GET only。
//
// ── 🔴 SSE 与列表的分工（设计文档 §3.4 的裁决，本文件最要紧的一条）─────────────
// **列表只由端点出。SSE 不直接插列表。**
// `useFoundEvent()` 在这里的**唯一**用途是把 `hasNew` 翻成 true → 渲染 NewFoundBanner。
// 事件对象的 message / title / data 一个字段都不参与列表渲染。
// 理由（后端 server.ts:814 已论证）：recordFound 幂等刷新（ON CONFLICT DO UPDATE），
// SSE 每次装盘都发——事件条数与端点组数天然不等，插进去就是重复条目。
//
// 守卫：notifications/sseSeparation.test.tsx 用**运行时探针**钉这条——发 3 条 found 事件
// （带一个端点没返回过的剧名），断言 ① 列表行数一条没变、② 那个剧名一个字都没进 DOM、
// ③ 提示条出现了、④ 期间**没有自动重发请求**（自动刷新等于"SSE 间接插列表"，
// 用户脚下的行会突然重排）。变异（把事件塞进列表）→ 那几条必红。
//
// ── 视觉（R-F11 / DESIGN.md）──────────────────────────────────────────────
// Linear 基准：四层 surface 阶梯 + 三层 hairline，**拒绝投影**。样式在 styles.css 的
// notifications 段——那一段只用本仓真实存在的 token（--color-card / --color-border /
// --color-secondary），一个新变量都不新增（DESIGN.md 写的 surface-1/hairline 在本仓
// grep 零命中，写 var(--color-surface-1, transparent) 会静默 fallback 成透明）。
import { useCallback, useEffect, useRef, useState } from 'react'
import { Section } from '../components/ui/section.js'
import { Skeleton } from '../components/ui/skeleton.js'
import { EmptyState } from '../components/ui/empty-state.js'
import { Button } from '../components/ui/button.js'
import { useNotifications } from '../api/hooks.js'
import { useEventsStatus, useFoundEvent } from '../events/EventsProvider.js'
import { useT } from '../i18n/useT.js'
import { NewFoundBanner } from './NewFoundBanner.js'
import { NotificationRow } from './NotificationRow.js'
import { bucketByDay, formatDayStamp, groupKey, type DayBucket } from './notifText.js'

function DaySection({ bucket }: { bucket: DayBucket }) {
  const { t } = useT()
  // 今天/昨天说人话，更早给 MM-DD 绝对日期（t() 不支持插值，"3 天前"这种拼接在
  // 中英两侧语序都别扭——见 notifText.formatDayStamp 的论证）。
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
          // React key：`workId/season`。**没有稳定的行 id 可用**——后端逐集存、读时聚合，
          // 一个"组"不是表里的一行。这个拼法逐字对齐后端聚合键与表的唯一索引口径
          // （notificationsRepo:127 / ON CONFLICT(work_id, ifnull(season,-1), …)）。
          // 用数组 index 是不行的：刷新后组会因 latestAt 变化重排，index 复用会把
          // A 组的 DOM 状态套到 B 组身上。详见 notifText.groupKey。
          <NotificationRow key={groupKey(g)} group={g} />
        ))}
      </div>
    </section>
  )
}

function LoadingRows() {
  return (
    <div aria-busy="true" aria-label="loading notifications" className="notif-day-rows">
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
  const { t } = useT()

  // ── SSE：只做提示，不进列表 ────────────────────────────────────────────
  // useFoundEvent 给的是**最后一条** found 事件（四层 Context 的 EventSlot 语义）。
  // 这里只看它"变没变过"，事件内容一律不用。
  const found = useFoundEvent()
  const status = useEventsStatus()
  const [hasNew, setHasNew] = useState(false)
  // 挂载时 Context 里可能已经躺着一条**本次会话早些时候**的事件（用户从别的 tab 切过来，
  // Provider 在外壳层，事件早就收下了）。那一条不算"我看这一页之后的新成果"——
  // 拿它点亮提示条会让用户一进页面就看到一个刷不出任何变化的提示。故记下基线，只对
  // **基线之后**的事件反应。用 ref 不用 state：它只是比较基准，变化不该触发重渲染。
  const seenFoundId = useRef<number | null>(null)
  const baselineTaken = useRef(false)
  useEffect(() => {
    if (!baselineTaken.current) {
      baselineTaken.current = true
      seenFoundId.current = found?.id ?? null
      return
    }
    if (found == null) return
    if (seenFoundId.current !== null && found.id <= seenFoundId.current) return
    seenFoundId.current = found.id
    // 🔴 这一行就是 SSE 在本页被允许做的**全部**事：翻一个布尔。
    // 绝不 setList([...list, found])——见文件头 §SSE 分工。
    setHasNew(true)
  }, [found])

  // SSE 断线期间的 found 事件全部丢失（后端环形缓冲"不是账目"，见 notificationsRepo
  // 头注释）。重连回 open 时补拉一次——否则用户会盯着一个既不更新也不提示的列表。
  // ⚠️ 这不是轮询：它由**状态跃迁**触发，不是定时器。
  const prevStatus = useRef(status)
  useEffect(() => {
    const was = prevStatus.current
    prevStatus.current = status
    if (was !== 'open' && status === 'open' && was !== 'connecting') reload()
  }, [status, reload])

  const refresh = useCallback(() => {
    setHasNew(false)
    reload()
  }, [reload])

  const banner = hasNew ? <NewFoundBanner onRefresh={refresh} /> : null

  if (loading && !data) {
    return (
      <Section>
        <LoadingRows />
      </Section>
    )
  }

  // 错误态**绝不显示空态文案**（§4.4：那是谎报——"一周内什么都没找到"与"我没能问到"
  // 是两件事，前者是好消息里的平静，后者是故障）。
  if (error && !data) {
    return (
      <Section>
        <EmptyState
          title={t('notif_error_title')}
          description={error}
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
          {/* 空态下提示条**照样要出**：一周内什么都没找到、然后刚刚找到了一条——
              这恰恰是最该提示的时刻。把 banner 埋在 groups.length>0 分支里的话，
              空态用户永远等不到那个刷新入口。 */}
          {banner}
          <EmptyState title={t('notif_empty_title')} description={t('notif_empty_desc')} />
        </div>
      </Section>
    )
  }

  // now 在渲染时取一次即可：这一页的读数是**日历日**粒度（今天/昨天/MM-DD）与 HH:MM，
  // 没有任何秒级读数需要 interval 推着走（活动页那个每秒自增的 now 是因为它有秒表）。
  const buckets = bucketByDay(groups, Date.now())

  return (
    <Section>
      <div className="flex flex-col gap-3">
        {banner}
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
