// web/src/workflow/text.ts：Workflow 区的动态文案组装——纯函数，全部英文（DESIGN.md §7：
// Workflow 区永不本地化），带运行期数字/技术枚举值的拼句故意不进 i18n 表（同 time.ts 的既有
// 理由），集中收纳供 RerunDialog/TraceRows/RunDetail 共用同一份口径，避免多处各拼一套措辞。
import type { DispatchReceiptsDTO, WorkflowRecentRunDTO } from '../../api/types.js'
import type { TKey } from '../../i18n/useT.js'
import { formatNextRecheck } from './time.js'

/** 截断长字符串（detail/argsSummary 一行显示用）——跟 EpisodeDetail 一贯的"截断而不是换行
 *  撑爆卡片"审美一致。 */
export function truncate(s: string, max = 80): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

/** 缺口计数徽标——series/movie 两种 Pending 行共用（movie 的 missing/throttled 是 0|1，同一套
 *  数字格式化口径，"1 missing" 读起来跟"5 missing"一样自然）。 */
export function missingBadge(missing: number): string {
  return `${missing} missing`
}

/** throttled 附加行——"{throttled} throttled · next recheck in {相对}"；throttled<=0 时无这一行
 *  （返回 null，调用方据此决定要不要渲染）。nextRecheckAt 缺失（理论上 throttled>0 时应该总有
 *  值，这里只做防御性兜底）时只给计数，不编造一个假的 recheck 时刻。 */
export function throttledLine(throttled: number, nextRecheckAt: number | null, now: number): string | null {
  if (throttled <= 0) return null
  if (nextRecheckAt == null) return `${throttled} throttled`
  return `${throttled} throttled · ${formatNextRecheck(nextRecheckAt - now)}`
}

const RECEIPT_ORDER: (keyof DispatchReceiptsDTO)[] = ['created', 'revived', 'coalesced', 'blocked_dormant', 'unknown']
const RECEIPT_LABEL: Record<keyof DispatchReceiptsDTO, string> = {
  created: 'created',
  revived: 'revived',
  coalesced: 'coalesced',
  blocked_dormant: 'blocked',
  unknown: 'unparsed',
}

/** receipts 分布 chip 排——非零才出现（`3 created · 1 coalesced` 式），unknown 显示为
 *  "N unparsed"；全零时空数组（调用方据此决定要不要渲染这一排——DESIGN.md 任务规格："receipts
 *  分布 chip 排...非零才显示"）。 */
export function receiptChips(receipts: DispatchReceiptsDTO): string[] {
  return RECEIPT_ORDER.filter((k) => receipts[k] > 0).map((k) => `${receipts[k]} ${RECEIPT_LABEL[k]}`)
}

/** decision 词 → 语义色变体（DESIGN.md 任务规格："decision 语义色点：installed=绿/
 *  no_safe_match=灰/retry_later=灰/error=红"）——排队/中性一律灰（DESIGN.md §2 铁律），只有
 *  installed（成功）和 error（数据异常）才脱离中性色。 */
export type DecisionVariant = 'success' | 'error' | 'neutral'
export function decisionVariant(decision: string | null): DecisionVariant {
  if (decision === 'installed') return 'success'
  if (decision === 'error') return 'error'
  return 'neutral'
}

/** recent 完成行流：输入按 finished_at 降序，连续且 jobId 相同且 decision 相同的行折叠为
 *  一条（row=最新那条，count=折叠数量）；不同 jobId/decision 交错时不跨段折叠。
 *  原消费方是 ActivityFeed（把同一任务连续失败重试刷屏的 N 行压成一条 ×N 角标）——它随活动页
 *  重建在 2bb6d10 退役，本函数暂留且有测试钉着；删除是独立清理，不与注释刷新同改。 */
export function collapseRecentRuns(
  rows: WorkflowRecentRunDTO[],
): { row: WorkflowRecentRunDTO; count: number }[] {
  const result: { row: WorkflowRecentRunDTO; count: number }[] = []
  for (const row of rows) {
    const last = result[result.length - 1]
    if (last && last.row.jobId === row.jobId && last.row.decision === row.decision) {
      last.count += 1
    } else {
      result.push({ row, count: 1 })
    }
  }
  return result
}

/** 四态回执 → i18n 键（redispatch 的四个 outcome 各自一句诚实英文，DESIGN.md §8：不许都写成
 *  success）。回执对象本身的其它字段（pendingState/intentRefreshed/lastError）目前只用于
 *  区分 outcome 分支，不逐字段呈现——四句话本身已经把"发生了什么"说清楚了。 */
export function outcomeMessageKey(
  outcome: 'created' | 'revived' | 'coalesced' | 'blocked_dormant',
): TKey {
  switch (outcome) {
    case 'created':
      return 'workflow_outcome_created'
    case 'revived':
      return 'workflow_outcome_revived'
    case 'coalesced':
      return 'workflow_outcome_coalesced'
    case 'blocked_dormant':
      return 'workflow_outcome_blocked_dormant'
  }
}
