// web/src/lib/time.ts：中文相对时间：今天 HH:MM / 昨天 HH:MM / M月D日。
// 全部为毫秒时间戳（后端 Date.now() 落库）。

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`
}
function hm(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}
function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** 相对日期 + 时刻。今天/昨天带时刻，更早只给 M月D日。 */
export function relTime(ts: number, now: number): string {
  const d = new Date(ts)
  const today = startOfDay(new Date(now))
  const dDay = startOfDay(d)
  const dayDiff = Math.round((today - dDay) / 86_400_000)
  if (dayDiff <= 0) return `今天 ${hm(d)}`
  if (dayDiff === 1) return `昨天 ${hm(d)}`
  return `${d.getMonth() + 1}月${d.getDate()}日`
}
