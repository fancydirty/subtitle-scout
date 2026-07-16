// web/src/shell/freshness.ts：顶栏新鲜度行——纯函数，故意不进 i18n 表，两个语言下都渲染同一串
// 英文 mono 文本。理由：DESIGN.md §0 把这行钦定为"存活感"信号本身（`watching /media ·
// scanned 2m ago · 568 files`），是技术层读数，跟 Workflow 区的技术值（路径/ID/decision 词表）
// 同一挂：永不翻译（DESIGN.md §7）。
import type { WorkflowFreshnessDTO } from '../api/types.js'

/** 毫秒差 → 短促相对时长（s/m/h/d），跟 DESIGN.md 里 "next recheck in 3d" 一路的粒度。 */
function relAgo(deltaMs: number): string {
  const s = Math.max(0, Math.floor(deltaMs / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  return `${d}d`
}

/** roots 空 → "no media roots"；lastScanAt 为 null（从未摄取过）→ "awaiting first scan"；
 *  否则拼完整三段式。三段固定用 " · " 连接，跟视觉基准一致。 */
export function formatFreshness(meta: WorkflowFreshnessDTO, nowMs: number): string {
  const watching = meta.roots.length > 0 ? `watching ${meta.roots.join(', ')}` : 'no media roots'
  const scanned =
    meta.lastScanAt == null ? 'awaiting first scan' : `scanned ${relAgo(nowMs - meta.lastScanAt)} ago`
  const files = `${meta.files} files`
  return [watching, scanned, files].join(' · ')
}
