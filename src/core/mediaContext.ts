import { resolve, sep } from 'node:path'
import { writeFileSync, unlinkSync } from 'node:fs'

export interface PathMapping { from: string; to: string }

export function parsePathMappings(raw: string | undefined): PathMapping[] {
  if (!raw) return []
  return raw.split(',').filter(Boolean).map(pair => {
    const [from, to] = pair.split('=')
    if (!from || !to) throw new Error(`invalid MEDIA_PATH_MAPPINGS pair: ${pair}`)
    return { from, to }
  })
}

export function mapPath(path: string, mappings: PathMapping[]): string {
  // 最长前缀优先，避免 /media 抢了 /media/movies 的活
  const hit = [...mappings].sort((a, b) => b.from.length - a.from.length)
    .find(m => path.startsWith(m.from))
  return hit ? hit.to + path.slice(hit.from.length) : path
}

/** path 是否位于任一 root 之下（或恰为 root）。roots 为空 → 视为不限制，返回 true */
export function isUnderRoots(path: string, roots: string[]): boolean {
  if (roots.length === 0) return true
  const p = resolve(path)
  return roots.some(r => {
    const root = resolve(r)
    return p === root || p.startsWith(root + sep)
  })
}

/** roots 里包含 path 的那一个根（最长前缀命中，避免嵌套配置时 /media 抢了 /media/tv 的活）。
 *  一个都不包含（越出所有根，或 roots 为空）返回 null——调用方自行决定安全兜底，这里不替
 *  调用方猜。供 stagingSandbox.allocate 的调用方判定"哪个媒体根装下了这段视频"：沙盒必须
 *  挂在根一级而不是视频所在的深层目录（见 files/stagingSandbox.ts allocate() 的注释——
 *  gcOrphans 按根非递归扫描，沙盒不在根一级就永远不会被启动时的孤儿回收扫到）。 */
export function containingRoot(path: string, roots: string[]): string | null {
  const p = resolve(path)
  const hits = roots
    .map(r => resolve(r))
    .filter(root => p === root || p.startsWith(root + sep))
  if (hits.length === 0) return null
  return hits.sort((a, b) => b.length - a.length)[0]
}

let writeProbeCounter = 0

/**
 * 目录是否可写:在 dir 下真实试写一个隐藏临时文件再删除。成功→true,任何异常→false
 * (目录不存在也会因写失败返回 false)。不用 fs.access(W_OK)——网络挂载(WebDAV/rclone/CIFS)
 * 上 W_OK 会撒谎,且容器内 root 会绕过权限位;真实试写走 sidecar 将来同一条写路径,是唯一可信信号。
 */
export function isDirWritable(dir: string): boolean {
  const probe = resolve(dir, `.subtitle-scout-writetest-${process.pid}-${writeProbeCounter++}`)
  try {
    writeFileSync(probe, '')
    unlinkSync(probe)
    return true
  } catch {
    try { unlinkSync(probe) } catch { /* 写失败时无残留;写成功删失败的边界尽力清理 */ }
    return false
  }
}
