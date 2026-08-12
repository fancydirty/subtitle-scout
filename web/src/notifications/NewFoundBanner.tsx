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
    <div className="notif-new-banner" role="status" aria-live="polite" data-testid="notif-new-banner">
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

/**
 * 🟡 「实时更新没有开着」——**通知页的诚实性提示**（终局审计 🟡-2）。
 *
 * ── 为什么通知页必须有这条（Task ⑨ 当时判"低一档"，现在重判）────────────────
 * 这一页 `useEventsStatus()` 读了，但**只用于重连补拉**（useResumeEdge 的边沿）。
 * 而 `unavailable` 是 503 **终态**——eventsBus.ts:262 明写一次都不会再重连，
 * 那条边沿**永远不会触发**。于是用户盯着的是一个：
 *   · 永远不会亮"有新字幕"的页面（提示条的唯一点亮源是 found 事件，而事件收不到了）
 *   · 永远不会自动补拉的列表（重连补拉的触发条件永不成立）
 *   · 而且**看上去完全正常**（一周流水好好地摆在那儿，只是停在了打开页面的那一刻）
 * 「没有新字幕」与「我听不见有没有新字幕」是两件事，而这一页此前只说得出前者——
 * 那正是 §4.4「错误态绝不显示空态文案」那条纪律的同一形态。
 * Task ⑨ 判它"是遗漏不是谎报，低一档"——遗漏与谎报的界线在**用户会不会据此做出错误
 * 判断**：一个不会更新的通知页会让用户以为"这周就是没找到东西"，那已经越过界了。
 *
 * ── 为什么复用这个文件而不是新建组件（"最省修法"的执行）──────────────────
 * 形态与 NewFoundBanner 完全同构（一条 banner + 一个按钮），共用同一段 CSS
 * （`.notif-new-banner`）。两条提示长得像是**有意的**：它们占同一个槽位、说的是
 * 同一件事的两面（有新的了 / 我可能不知道有没有新的）。
 *
 * ── 与活动页那两句的关系 ────────────────────────────────────────────────
 * 文案**直接复用** `wb_live_unavailable` / `wb_live_retrying`（i18n 键不新增）。
 * 两页说同一件事必须逐字相同——各写一份文案是本仓最常见的漂移形态，而这两句里
 * "刷新页面才会更新"是一句**可执行的指示**，两页说得不一样会让用户以为是两回事。
 * ⚠️ 但**按钮只有这一页有**：活动页那条在状态条里（没有按钮，因为它旁边的卡片会被
 * 下一条 SSE 自动纠正），这一页的列表**只能靠手动重拉**——给按钮是因为这里真的
 * 有一个能解决问题的动作。
 *
 * `live === 'live'` 时返回 null（调用方也可以不渲染，两层都判是为了本组件自足）。
 */
export function LiveOffBanner({
  live, onRefresh,
}: {
  live: 'live' | 'retrying' | 'off'
  onRefresh: () => void
}) {
  const { t } = useT()
  if (live === 'live') return null
  return (
    <div
      className="notif-new-banner"
      data-live={live}
      data-testid="notif-live-banner"
      role="status"
      aria-live="polite"
    >
      {/* Carbon 双通道：**空心**点（形状差异，不是另一种颜色）——逐字照活动页状态条里
          那个 wb-status-dot-hollow 的做法。旁边 NewFoundBanner 的点是实心的，
          两条 banner 同时出现时形状就能分开（色觉障碍与灰度打印下信息不丢）。 */}
      <span className="notif-new-dot notif-new-dot-hollow" aria-hidden="true" />
      <span className="flex-1 text-[13px] leading-[1.5385] text-foreground">
        {live === 'off' ? t('wb_live_unavailable') : t('wb_live_retrying')}
      </span>
      {/* 手动重拉。⚠️ `unavailable` 那一档刷新按钮**照样给**：文案说的是"刷新页面"，
          而这个按钮是重拉列表——两者都能让用户看到新数据，且后者代价更小。
          文案不改成"重拉列表"是因为 unavailable 时 SSE 通道本身要靠整页刷新才可能恢复，
          只重拉列表的话下一批新字幕仍然不会有提示。两句话说的是两个不同层次的补救，
          都如实给出。 */}
      <Button variant="secondary" size="sm" onClick={onRefresh}>
        {t('notif_refresh')}
      </Button>
    </div>
  )
}
