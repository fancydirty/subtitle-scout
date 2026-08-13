// web/src/triage/text.ts：甄别 tab 的动态文案组装 + 纯路径处理——纯函数，双语（DESIGN.md §7
// 只豁免 Workflow 区，甄别区正常双语）。带运行期数字的句子走这里而不是 useT.ts 的扁平表（同
// library/text.ts 的既有分工：t() 故意不支持插值）。
import type { Lang } from '../i18n/useT.js'

// relativeClaimedAgo（已认领箱的相对时间）已随认领退役删除——唯一消费方是已退役的 ClaimedBox。
// settings/text.ts 的 relativeTimeLabel 是同手法的独立实现，不受影响。

// ── PendingBox / ExcludedBox 专属的 7 个导出已删除，2026-08-13 ────────────────
// `fileCountLabel` / `moreLabel` / `pathTail` / `dirnameOf` / `DirGroup` /
// `groupPending`（含私有 groupByDir、EXCLUDED_PARK_REASON）/ `groupParkTimeLine`。
// 它们的唯一消费方是随 parked 族一起删掉的那两个区。留下的四个导出
// （agoLabel 私有 + checkedAgoLine / timingRowLabel / dormantReasonLine）服务
// TimingBox / DormantBox 两区，与 parked 族无关，原样保留。
// 正本论证见 web/src/triage/TriagePage.tsx 头注释的「2.5 parked 族的结局」段。

/** 相对"多久以前"——档位与 activity/text.ts 的 relativeFinished 逐字一致，本模块自持（不跨目录耦合）。 */
function agoLabel(deltaMs: number, lang: Lang): string {
  const s = Math.max(0, Math.floor(deltaMs / 1000))
  if (s < 5) return lang === 'zh' ? '刚刚' : 'just now'
  if (s < 60) return lang === 'zh' ? `${s} 秒前` : `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return lang === 'zh' ? `${m} 分钟前` : `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return lang === 'zh' ? `${h} 小时前` : `${h}h ago`
  const d = Math.floor(h / 24)
  return lang === 'zh' ? `${d} 天前` : `${d}d ago`
}

/** "checked 2h ago" / "2 小时前检查"——偏移行的新鲜度（§5.5 新拟，checkedAt 真实字段）。 */
export function checkedAgoLine(checkedAt: number, now: number, lang: Lang): string {
  const ago = agoLabel(now - checkedAt, lang)
  return lang === 'zh' ? `${ago}检查` : `checked ${ago}`
}

/** 偏移行标签——"Peacemaker S2E03"；媒体字段任一 null 时降级 mono itemId（spec §8）。 */
export function timingRowLabel(row: {
  seriesName: string | null; season: number | null; episode: number | null; itemId: string
}): string {
  if (row.seriesName === null || row.season === null || row.episode === null) return row.itemId
  return `${row.seriesName} S${row.season}E${String(row.episode).padStart(2, '0')}`
}

/** dormant 行的英文事实句（§4.2/§5.5 新拟，前端用 attempts 组；中文 reason 内部串不透传）。 */
export function dormantReasonLine(attempts: number, lang: Lang): string {
  return lang === 'zh'
    ? `失败 ${attempts} 次，已停止自动重试。`
    : `Failed ${attempts} times, automatic retries stopped.`
}
