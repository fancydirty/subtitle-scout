import type { SummaryDTO } from '../api/types.js'
export function SummaryHeader({ s }: { s: SummaryDTO | null }) {
  if (!s) return <div className="head"><div className="big">正在读取…</div></div>
  return (
    <div className="head">
      <div className="big">今天下好了 <em>{s.todayReady}</em> 部字幕</div>
      <div className="sub">{s.queuePending} 部在排队等待 · 后台持续留意新入库</div>
    </div>
  )
}
