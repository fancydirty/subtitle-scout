// web/src/notifications/NewFoundBanner.tsx：LiveOffBanner（实时通道掉线披露）。
// 「有新字幕 · 点击刷新」已删除：found 自动再 GET，不再要用户点刷新。
import { Button } from '../components/ui/button.js'
import { useT } from '../i18n/useT.js'

/**
 * 🟡 「实时更新没有开着」——**通知页的诚实性提示**（终局审计 🟡-2）。
 *
 * ── 为什么通知页必须有这条（Task ⑨ 当时判"低一档"，现在重判）────────────────
 * 这一页 `useEventsStatus()` 读了，但**只用于重连补拉**（useResumeEdge 的边沿）。
 * 而 `unavailable` 是 503 **终态**——eventsBus.ts:262 明写一次都不会再重连，
 * 那条边沿**永远不会触发**。于是用户盯着的是一个：
 *   · found 再也到不了 → 自动再 GET 也不会发生
 *   · 永远不会自动补拉的列表（重连补拉的触发条件永不成立）
 *   · 而且**看上去完全正常**（一周流水好好地摆在那儿，只是停在了打开页面的那一刻）
 * 「没有新字幕」与「我听不见有没有新字幕」是两件事，而这一页此前只说得出前者——
 * 那正是 §4.4「错误态绝不显示空态文案」那条纪律的同一形态。
 * Task ⑨ 判它"是遗漏不是谎报，低一档"——遗漏与谎报的界线在**用户会不会据此做出错误
 * 判断**：一个不会更新的通知页会让用户以为"这周就是没找到东西"，那已经越过界了。
 *
 * ── 为什么复用这个文件而不是新建组件（"最省修法"的执行）──────────────────
 * 形态是一条 banner + 一个按钮，共用 `.notif-new-banner`。
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
          那个 wb-status-dot-hollow 的做法。空心点是这一条独有的形状通道。 */}
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
