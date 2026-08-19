import { basename, sep } from 'node:path'
import { walkVideoFiles } from '../daemon/selfScan.js'
import { tmdbIdFromOwnId } from './ownIds.js'
import type { LibraryRepo } from './libraryRepo.js'
import type { RealignLibraryPort } from './realignExecutor.js'

/**
 * Port for realigning media-library paths without a media-server dependency:
 * RealignLibraryPort（C-B3 改名前旧名 RealignJellyfinPort）的库原生实现——realign 不再打
 * Jellyfin API，改读自有库行 + 直接走盘。
 *
 * realignExecutor.ts 的 5 重安全层（restructuring/manifest/reveal/rollback + GAP-A 崩溃恢复
 * 纪律）全部零改动——本文件只换 port"读什么"，不碰 realignExecutor.ts"怎么用读到的东西"。
 * 每个方法的注释都先点名了 realignExecutor.ts 里唯一消费它的代码行 + 实际读取的字段，只满足
 * 真被读取的那部分，不为未被消费的字段编造语义。
 */

export interface RealignLibraryPortDeps {
  /** series 行读取——getItem 用它把 seriesId 换回 Name/ProductionYear/TMDB id。 */
  lib: LibraryRepo
  /** MEDIA_ROOTS（已解析出的本地库根列表，与 cli/index.ts 的 mediaRoots() 输出同源）——
   *  getItemsPage 的磁盘走盘范围，getVirtualFolders 的库清单来源。 */
  roots: string[]
  /** "让库看见新结构"——refreshLibrary 的库原生等价操作，顶替 Jellyfin 的
   *  /Items/{id}/Refresh。
   *
   *  2026-08-13 换绳子（原字段名 `runIngest`，接的是 v2/ingest.ts 的 makeIngestPass）：
   *  ingest 整条链已退役，且它本来就写错了表——realign 搬完文件后需要被重新记账的是
   *  `files`（新路径进库、旧路径退出），而 ingest 一行 files 都不写。现在接的是
   *  daemonV2 的带外扫描请求（`requestScan`），那才是写 files 的那个。
   *
   *  **同步、不返回 promise**（这是与 runIngest 的第二处不同）：requestScan 只给 daemon
   *  主循环置一个标志，扫描在主循环里异步发生。refreshLibrary 因此不再"等扫描跑完"——
   *  但那个等待本来也不是它要的：realignExecutor 紧接着调 waitForIngestIdle 轮询
   *  getScheduledTasks（见下方），那才是"等扫描真的做完"的机制，且它现在等的是对的东西。 */
  requestScan: () => void
  /** "现在有没有扫描在跑"——getScheduledTasks 的数据源，realignExecutor 的
   *  waitForIngestIdle 轮询它来实现"扫描中不许挪文件"。
   *
   *  2026-08-13：原先读的是 `ingestLock.held`（v2/ingest.ts 的模块级单例）。现在读
   *  `daemonV2.isScanning()`——旧锁守的是 ingest，而真正会与 realign 抢同一批路径的是
   *  daemonV2 的 scanOnce，那把锁从一开始就守错了对象。 */
  isScanning: () => boolean
  /** R8-6：走盘缓存窗口的时钟（默认 Date.now）——此前声明了却没人用（死依赖），
   *  现在 getItemsPage 的 100ms 缓存窗口两端都走它，测试可注入可控时钟。 */
  now?: () => number
  /** 测试注入：walkVideoFiles 的替换实现（默认 daemon/selfScan.ts 的真实走盘）。 */
  walkVideoFiles?: (root: string) => string[]
}

/** buildTargetSeasonDir（libraryRealign.ts）的产出格式：`Season NN`（全拼零填充，但填充位数
 *  不封顶——padStart(2,'0') 对三位数季号原样通过）。按路径分段精确匹配，从文件名往上找最近
 *  的匹配段——不用子串搜索，避免库根路径本身恰好含 "Season" 字样时误配到不属于这一集的
 *  外层段。 */
const SEASON_SEGMENT_RE = /^Season\s?(\d{1,4})$/i

/** 找不到任何 "Season NN" 段（尚未整理的旧平铺目录残留、隔离文件、库根路径本身之类）→ null。
 *  verifyRealignedCounts 的 `item.ParentIndexNumber != null` 门天然把这类条目排除出验收统计
 *  ——不需要在这里额外过滤，交给消费方的既有门控。 */
function seasonFromPath(path: string): number | null {
  const segments = path.split(sep)
  for (let i = segments.length - 1; i >= 0; i--) {
    const m = SEASON_SEGMENT_RE.exec(segments[i])
    if (m) return Number(m[1])
  }
  return null
}

/**
 * RealignLibraryPort 的库原生实现（少 deleteItem——D1：declared+wired+mocked 但从未被
 * realignExecutor.ts 调用，随本任务一并从接口删除，见 realignExecutor.ts 的唯一批准 hunk）。
 */
export function makeRealignLibraryPort(deps: RealignLibraryPortDeps): RealignLibraryPort {
  // R5-5 修复：同一轮验收内的连续分页缓存一次 walk 结果——1000 文件的库此前每页都全量递归
  // 走盘（CIFS/SMB 上极慢），但一次验收内的连续分页用同一份快照完全够（文件在验收期间不变）。
  let walkCache: { at: number; files: string[] } | null = null

  return {
    /**
     * 消费方：realignExecutor.ts:589 `const seriesItem = await deps.jf.getItem(seriesId)`，
     * 随后只读 ProviderIds?.Tmdb / Name / ProductionYear（:590-592）。
     *
     * "未知 id 的不可区分抛错形状"：realignExecutor.ts 全文这一行调用从无 try/catch 包裹
     * （不是遗漏——见函数顶部大注释 GAP A：崩溃恢复的续走判定被刻意排在这行调用之前，
     * 就是为了让"旧 series item 被裁掉"这类场景永远不必走到这一行），任何抛出都直接冒出
     * executeRealign，被上层的通用 catch（无 instanceof 检查，只按 error instanceof Error
     * 取 message）记成 'error' 走短退避重试——今天这个 catch 在 v2/realignWorkerTask.ts 的
     * runRealignWorkerTask 里（旧管线 v2/executor.ts 的等价 catch 服务同一职责，已随旧管线
     * 退役删除）。JellyfinClient.getItem 抛的 JellyfinItemNotFoundError 也是同样的下游命运，
     * 那个类本身从未被 instanceof 检查过。因此这里用一个语义清晰的库原生 plain Error 即可
     * 复现完全相同的可观察行为，不需要（也不该）反向 import 正在被移除的 Jellyfin 适配层的
     * 错误类——那会让"库原生" port 继续耦合它本该替代的东西。
     */
    async getItem(itemId) {
      const row = deps.lib.getSeries(itemId)
      if (!row) throw new Error(`realign: series not found in library: ${itemId}`)
      const tmdbId = tmdbIdFromOwnId(itemId)
      return {
        Id: itemId,
        Name: row.name,
        Type: 'Series',
        ProductionYear: row.year,
        ProviderIds: tmdbId ? { Tmdb: tmdbId } : undefined,
      }
    },

    /**
     * 消费方：verifyRealignedCounts（realignExecutor.ts:313-340，经 :793 调用）——函数签名上的
     * Pick 声明只读 Type / Path / ParentIndexNumber（:314），IndexNumber/SeriesId 不在消费
     * 范围内，不构造。
     *
     * "诚实来源是磁盘"（design §P5）：验收的目的是"搬动是否真的落地"，这一刻 DB 还没被
     * 下一轮摄取重新扫过（重新识别发生在 refreshLibrary→runIngest，而验收紧跟在它之后），
     * 唯一可信来源是 deps.roots 下的真实文件树，不是自己的库行。ParentIndexNumber 从路径里
     * 最近的 "Season NN" 段解析（见 seasonFromPath）。分页语义：对完整走盘结果的数组切片。
     *
     * R5-5 修复：同一轮验收内的连续分页缓存一次 walk 结果——1000 文件的库此前每页都全量递归
     * 走盘（CIFS/SMB 上极慢），但一次验收内的连续分页用同一份快照完全够（文件在验收期间不变）。
     */
    async getItemsPage(startIndex, limit) {
      // 短期缓存：同一轮验收（100ms 窗口内）的连续分页用同一份 walk 结果
      const clock = deps.now ?? Date.now // R8-6：缓存窗口两端统一走这个时钟（此前 deps.now 是死依赖）
      if (walkCache && clock() - walkCache.at < 100) {
        return walkCache.files.slice(startIndex, startIndex + limit).map(path => ({
          Id: path,
          Name: basename(path),
          Type: 'Episode',
          Path: path,
          ParentIndexNumber: seasonFromPath(path) ?? undefined,
        }))
      }
      const files = deps.roots.flatMap(root => (deps.walkVideoFiles ?? walkVideoFiles)(root))
      // R6-5 修复：缓存打点在走盘完成后——此前用走盘开始前的 now，走盘本身 >100ms 时缓存写入即过期，
      // 第二页必然重新全量走盘（正是它要救的 CIFS/SMB 场景）。改为完成后打点，确保 100ms 窗口内
      // 的连续分页命中缓存。
      walkCache = { at: clock(), files }
      return files.slice(startIndex, startIndex + limit).map(path => ({
        Id: path,
        Name: basename(path),
        Type: 'Episode',
        Path: path,
        ParentIndexNumber: seasonFromPath(path) ?? undefined,
      }))
    },

    /**
     * 消费方：waitForIngestIdle（C-B3 改名前旧名 waitForJellyfinIdle；realignExecutor.ts:
     * 292-304，经 :603/:791/:850/:863 调用）——只读 isRunning。D4：把"扫描中不许挪文件"这条
     * 安全属性原样保留下来的关键——`deps.isScanning()`（2026-08-13 起 = daemonV2 的 scanOnce
     * 执行期间为 true，含抛错路径的 finally 兜底释放）映射成一个 Running 态任务，
     * waitForIngestIdle 的既有轮询逻辑字节不改照常工作，等的本来就是"我们自己的扫描"，
     * 不是 Jellyfin 的扫描任务——函数改名前的旧注释把主语错记成了 Jellyfin，C-B3 一并纠正。
     *
     * ⚠️ 2026-08-13 换绳子：原先读的是 `ingestLock.held`（v2/ingest.ts 的模块级单例）。
     * ingest 整条链退役，且那把锁**守错了对象**——它守的是 ingest（不写 files），而真正会
     * 与 realign 抢同一批路径的是 daemonV2 的 scanOnce。安全属性因此比改动前更强。
     */
    async getScheduledTasks() {
      return deps.isScanning() ? [{ id: 'scan', name: 'library scan', isRunning: true }] : []
    },

    /**
     * 消费方：realignExecutor.ts:511（经 folders 透传给 forwardResume 供 :834 复用）——locations
     * 用于 mapPath→containingRoot 匹配库根（:512-513/:835）、段感知匹配目标虚拟库
     * （:576/:845）。库原生世界没有"虚拟库"这个中间概念——每个 MEDIA_ROOTS 条目本身就是它自己
     * 的库，identity 映射：一个根一个条目，locations=[root] 本身就是落地位置（不再有远程
     * Jellyfin 视角需要经 mapPath 翻译成本地路径——两侧本就是同一个值）。C-B2 处决：
     * enableRealtimeMonitor 字段已随 realignExecutor.ts 那条恒死的提示日志分支一并删除——
     * 库原生世界没有 Jellyfin 的"实时监控"概念可言，这里从来只能返回恒定的 false，不是真实
     * 探测结果。
     */
    async getVirtualFolders() {
      return deps.roots.map((root, i) => ({
        id: `root:${i}`,
        name: basename(root),
        locations: [root],
      }))
    },

    /**
     * 消费方：realignExecutor.ts:790/:862——整理搬完之后"让库看见新结构"。库原生世界没有
     * 独立刮削服务可踢，等价动作是请求一次自己的扫描（把 .realign-build 亮相后的新目录路径
     * 重新记账进 `files`）。libraryId 参数（我们自己 getVirtualFolders 派发的 'root:N'）在
     * 库原生世界没有"只刷这一个库"的对应操作——扫描本就是全量扫同一份 deps.roots，
     * 传参无意义，忽略不用。
     *
     * `async` 保留（RealignLibraryPort 接口要求返回 Promise，realignExecutor 会 await 它），
     * 但内部不再有真正的等待——见 deps.requestScan 字段注释末段：等扫描真的做完是紧随其后的
     * waitForIngestIdle 轮询的职责，不是这一行的。
     */
    async refreshLibrary(_libraryId) {
      deps.requestScan()
    },
  }
}
