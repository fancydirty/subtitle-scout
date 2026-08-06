// web/src/settings/dirBrowserUtils.ts：目录浏览器工具函数（R6 UX 改进）
//
// 研究结论（DIRBROWSER_RESEARCH.md）：Jellyfin/Plex 等成熟方案都是"自由导航 + 按需加载"，
// 不计算 commonRootStart 限制起点。我们的改进策略：
//  1. 固定起点（根目录 /，而非动态 commonRootStart）
//  2. 允许向上导航到任何父目录
//  3. 过滤系统目录（/dev /proc /sys 等）

/** 系统目录黑名单（Linux/macOS）——这些目录对媒体库管理无意义，且可能包含大量条目导致
 *  列表卡顿。列出时自动过滤，不展示给用户。 */
const SYSTEM_DIR_BLACKLIST = new Set([
  '/dev',
  '/proc',
  '/sys',
  '/tmp',
  '/var',
  '/boot',
  '/run',
  '/lost+found',
])

/** 判断路径是否为系统目录（应被过滤）。macOS 的 /System、/Library、/private 也算。 */
export function isSystemDir(path: string): boolean {
  if (SYSTEM_DIR_BLACKLIST.has(path)) return true
  // macOS 特有
  if (path.startsWith('/System') || path.startsWith('/Library') || path.startsWith('/private')) {
    return true
  }
  return false
}

/** 过滤系统目录：给定目录名列表和父路径，返回去除系统目录后的列表。 */
export function filterSystemDirs(dirNames: string[], parentPath: string): string[] {
  return dirNames.filter((name) => {
    const fullPath = parentPath === '/' ? `/${name}` : `${parentPath}/${name}`
    return !isSystemDir(fullPath)
  })
}

/** 默认浏览起点：根目录 /，让用户自由导航整个文件系统。
 *  研究结论：不再用 commonRootStart 动态计算——那会导致"添加 /media 后只能浏览 /media
 *  子目录，无法回到 / 再添加 /data"的问题。固定起点让用户自由探索。 */
export function getDefaultStartPath(): string {
  return '/'
}
