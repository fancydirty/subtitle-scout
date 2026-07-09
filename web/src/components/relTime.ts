export function relTime(ts: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000))
  if (s < 60) return '刚刚'
  const m = Math.floor(s / 60); if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60); if (h < 24) return `${h} 小时前`
  return `${Math.floor(h / 24)} 天前`
}
