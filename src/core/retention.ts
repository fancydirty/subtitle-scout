import { readdirSync, statSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/** 按 mtime 清理过期子目录（journal 保留策略）。失败静默——清理是尽力而为。
 * 正在写入的 journal 目录 mtime 为当前时间，永远不会命中 90 天阈值——清理与在途写入无竞争。 */
export function pruneOldDirs(root: string, retainDays: number, now: () => number = Date.now) {
  if (!existsSync(root)) return
  const cutoff = now() - retainDays * 86_400_000
  for (const name of readdirSync(root)) {
    const p = join(root, name)
    try {
      const st = statSync(p)
      if (st.isDirectory() && st.mtimeMs < cutoff) rmSync(p, { recursive: true, force: true })
    } catch { /* ignore */ }
  }
}
