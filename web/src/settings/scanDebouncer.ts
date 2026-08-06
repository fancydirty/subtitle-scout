// web/src/settings/scanDebouncer.ts：目录增删的扫描触发防抖器（R6 实现 DIRBROWSER_RESEARCH.md
// 推荐方案）。研究结论：Plex/Sonarr/Radarr 成熟模式是 webhook 触发部分扫描 + 2 秒防抖避免
// "猴子动作"（快速增删目录）重复触发全库扫。核心策略：
//  1. **2 秒防抖**——添加目录后 2 秒内无新操作才真正触发扫描
//  2. **路径累积**——2 秒内多次添加不同目录 → 只触发一次扫描（ingest 本就是全库增量）
//  3. **删除取消**——添加后又删除 → 从待扫队列移除，避免扫不存在的目录
//
// 使用模式：
//   const debouncer = createScanDebouncer(api.triggerScan)
//   debouncer.requestScan('/media/tv')    // 添加目录时调用
//   debouncer.cancelScan('/media/tv')     // 删除目录时调用

export interface ScanDebouncer {
  /** 请求扫描（添加目录时调）——路径放进待扫队列，2 秒后无新请求才真正触发 */
  requestScan: (path: string) => void
  /** 取消扫描（删除目录时调）——从待扫队列移除该路径；若队列空了则取消整个定时器 */
  cancelScan: (path: string) => void
  /** 立即触发（"立即扫描"按钮用）——清空队列和定时器，绕过防抖直接调 API */
  triggerNow: () => Promise<void>
  /** 测试用：返回当前待扫路径数量 */
  getPendingCount: () => number
}

/** 防抖窗口：2 秒（研究结论 200-500ms 适合 UI 交互，1-2s 适合文件系统操作；这里取 2s 上限，
 *  给用户足够反悔时间）。 */
const SCAN_DEBOUNCE_MS = 2000

export function createScanDebouncer(triggerScanFn: () => Promise<unknown>): ScanDebouncer {
  const pendingPaths = new Set<string>()
  let debounceTimer: ReturnType<typeof setTimeout> | null = null

  const executeScan = async () => {
    if (pendingPaths.size === 0) return
    // 触发前清空队列（幂等：即使 API 调用失败，也不重试——下一次添加目录会自然触发新一轮）
    pendingPaths.clear()
    try {
      await triggerScanFn()
    } catch (e) {
      // 静默吞掉错误：触发失败不应该让整个防抖器炸掉（下一次操作会自然重试）。
      // 调用方（DirBrowser/RootsManager）各自有自己的错误处理，这里不重复展示。
      console.warn('[scanDebouncer] trigger failed:', e)
    }
  }

  return {
    requestScan(path: string) {
      pendingPaths.add(path)

      if (debounceTimer) clearTimeout(debounceTimer)

      debounceTimer = setTimeout(() => {
        debounceTimer = null
        executeScan()
      }, SCAN_DEBOUNCE_MS)
    },

    cancelScan(path: string) {
      pendingPaths.delete(path)

      // 队列空了 → 取消定时器（避免无谓的空扫描请求）
      if (pendingPaths.size === 0 && debounceTimer) {
        clearTimeout(debounceTimer)
        debounceTimer = null
      }
    },

    async triggerNow() {
      // 清空防抖状态，立即执行（"立即扫描"按钮绕过防抖）
      if (debounceTimer) {
        clearTimeout(debounceTimer)
        debounceTimer = null
      }
      pendingPaths.clear()
      await triggerScanFn()
    },

    getPendingCount() {
      return pendingPaths.size
    },
  }
}
