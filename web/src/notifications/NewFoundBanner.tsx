// web/src/notifications/NewFoundBanner.tsx：「有新字幕 · 点击刷新」提示条。
//
// ── 这个组件是「SSE 与列表分工」的**全部**落点（设计文档 §3.4 的裁决）───────────
// 它是 SSE `found` 事件在通知页上**唯一**被允许产生的可见效果：一条提示，加一个按钮。
// 事件里的 message/title/data **一个字都不进列表**——列表永远只由 GET /api/v2/notifications 出。
//
// 为什么（后端 server.ts:814 + notificationsRepo 头注释已论证，此处只记结论）：
// `recordFound` 是**幂等刷新**（同一 work+season+episode 撞键时 ON CONFLICT DO UPDATE，
// 不 INSERT），而 SSE 每次装盘都发一条事件。于是"这一小时发了 5 条 found 事件"与
// "端点这一小时多了几组"**没有任何等式关系**——同一部剧被重找 5 次，事件 5 条、组 0 增。
// 只要前端敢拿事件往列表里插，用户看到的就是同一部剧在流水里出现 6 次。
//
// 为什么连**条数**都不显示（"3 条新字幕"这种写法很自然，但它是在撒谎）：
// 同上——事件条数不是新组数。显示"3 条新字幕"然后刷新出来只多了 1 条，用户会以为
// 系统弄丢了两条。故文案只说**有**（布尔事实，这个我们知道得准），不说**几条**。
//
// 为什么是"点击刷新"而不是自动刷新：用户可能正在读列表，脚下的行突然重排是最讨厌的
// 交互之一（而这一页恰恰会重排——latestAt 变了的组要往前跳）。把时机交给用户。
import { Button } from '../components/ui/button.js'
import { useT } from '../i18n/useT.js'

export function NewFoundBanner({ onRefresh }: { onRefresh: () => void }) {
  const { t } = useT()
  return (
    // role="status" + aria-live="polite"：新成果到达是**增益信息**，不该打断读屏用户
    // 正在读的内容（role="alert" 会抢读，那是留给故障的）。
    <div className="notif-new-banner" role="status" aria-live="polite">
      <span className="notif-new-dot" aria-hidden="true" />
      <span className="flex-1 text-[13px] leading-[1.5385] text-foreground">
        {t('notif_new_found')}
      </span>
      <Button variant="secondary" size="sm" onClick={onRefresh}>
        {t('notif_refresh')}
      </Button>
    </div>
  )
}
