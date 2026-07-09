import { appendFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const DAY_MS = 86_400_000

/** stdout 之外的持久日志：按天分文件，写入时惰性清理过期文件 */
export function makeFileLogger(dir: string, retainDays: number, now: () => number = Date.now): (msg: string) => void {
  mkdirSync(dir, { recursive: true })
  let lastCleanupDay = ''
  return (msg: string) => {
    const day = new Date(now()).toISOString().slice(0, 10)
    try {
      appendFileSync(join(dir, `watch-${day}.log`), `${new Date(now()).toISOString()} ${msg}\n`)
      if (day !== lastCleanupDay) {
        lastCleanupDay = day
        const cutoff = now() - retainDays * DAY_MS
        for (const f of readdirSync(dir)) {
          const m = f.match(/^watch-(\d{4}-\d{2}-\d{2})\.log$/)
          if (m && Date.parse(m[1]) < cutoff) rmSync(join(dir, f), { force: true })
        }
      }
    } catch { /* 日志失败绝不影响主流程 */ }
  }
}
