import { basename, sep } from 'node:path'
import { walkVideoFiles } from '../daemon/selfScan.js'
import { tmdbIdFromOwnId } from './ownIds.js'
import { ingestLock } from './ingest.js'
import type { LibraryRepo } from './libraryRepo.js'
import type { RealignJellyfinPort } from './realignExecutor.js'

/**
 * 去 Jellyfin 化 P5 / Task 7（design: docs/design/2026-07-16-de-jellyfin-design.md §P5，D4）：
 * RealignJellyfinPort 的库原生实现——realign 不再打 Jellyfin API，改读自有库行 + 直接走盘。
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
  /** 一次完整摄取 pass（v2/ingest.ts 的 makeIngestPass 产出）——refreshLibrary 的库原生等价
   *  操作："重新识别 + 写行"顶替 Jellyfin 的 /Items/{id}/Refresh。 */
  runIngest: () => Promise<unknown>
  now?: () => number
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
 * RealignJellyfinPort 的库原生实现（少 deleteItem——D1：declared+wired+mocked 但从未被
 * realignExecutor.ts 调用，随本任务一并从接口删除，见 realignExecutor.ts 的唯一批准 hunk）。
 */
export function makeRealignLibraryPort(deps: RealignLibraryPortDeps): RealignJellyfinPort {
  return {
    /**
     * 消费方：realignExecutor.ts:589 `const seriesItem = await deps.jf.getItem(seriesId)`，
     * 随后只读 ProviderIds?.Tmdb / Name / ProductionYear（:590-592）。
     *
     * "未知 id 的不可区分抛错形状"：realignExecutor.ts 全文这一行调用从无 try/catch 包裹
     * （不是遗漏——见函数顶部大注释 GAP A：崩溃恢复的续走判定被刻意排在这行调用之前，
     * 就是为了让"旧 series item 被裁掉"这类场景永远不必走到这一行），任何抛出都直接冒出
     * executeRealign，被上层 v2/executor.ts 的通用 catch（无 instanceof 检查，全文 grep 确认）
     * 记成 'error' 走短退避重试——JellyfinClient.getItem 抛的 JellyfinItemNotFoundError 也是
     * 同样的下游命运，那个类本身从未被 instanceof 检查过。因此这里用一个语义清晰的库原生
     * plain Error 即可复现完全相同的可观察行为，不需要（也不该）反向 import 正在被移除的
     * Jellyfin 适配层的错误类——那会让"库原生" port 继续耦合它本该替代的东西。
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
     * 最近的 "Season NN" 段解析（见 seasonFromPath）。分页语义：对完整走盘结果的数组切片
     * ——每次调用都重新走盘（不做跨调用缓存），确保验收看到的是调用时刻的磁盘现状。
     */
    async getItemsPage(startIndex, limit) {
      const files = deps.roots.flatMap(root => walkVideoFiles(root))
      return files.slice(startIndex, startIndex + limit).map(path => ({
        Id: path,
        Name: basename(path),
        Type: 'Episode',
        Path: path,
        ParentIndexNumber: seasonFromPath(path) ?? undefined,
      }))
    },

    /**
     * 消费方：waitForJellyfinIdle（realignExecutor.ts:292-304，经 :603/:791/:850/:863 调用）
     * ——只读 isRunning。D4：把"扫描中不许挪文件"这条安全属性原样保留下来的关键——
     * ingestLock.held（v2/ingest.ts 导出，makeIngestPass 的摄取 pass 执行期间为 true，含抛错
     * 路径的 finally 兜底释放）映射成一个 Running 态任务，waitForJellyfinIdle 的既有轮询逻辑
     * 字节不改照常工作，只是现在等的是"我们自己的摄取 pass"而不是 Jellyfin 的扫描任务。
     */
    async getScheduledTasks() {
      return ingestLock.held ? [{ id: 'ingest', name: 'library ingest', isRunning: true }] : []
    },

    /**
     * 消费方：realignExecutor.ts:511（经 folders 透传给 forwardResume 供 :834 复用）——locations
     * 用于 mapPath→containingRoot 匹配库根（:512-513/:835）、段感知匹配目标虚拟库
     * （:576/:845）；enableRealtimeMonitor 只影响一行提示日志（:580-582）。库原生世界没有
     * "虚拟库"这个中间概念——每个 MEDIA_ROOTS 条目本身就是它自己的库，identity 映射：
     * 一个根一个条目，locations=[root] 本身就是落地位置（不再有远程 Jellyfin 视角需要经
     * mapPath 翻译成本地路径——两侧本就是同一个值）。
     */
    async getVirtualFolders() {
      return deps.roots.map((root, i) => ({
        id: `root:${i}`,
        name: basename(root),
        locations: [root],
        enableRealtimeMonitor: false,
      }))
    },

    /**
     * 消费方：realignExecutor.ts:790/:862——整理搬完之后"让库看见新结构"。库原生世界没有
     * 独立刮削服务可踢，等价动作是再跑一次自己的摄取 pass（把 .realign-build 亮相后的新
     * 目录路径重新识别、写回 episodes/movies 行）。libraryId 参数（我们自己 getVirtualFolders
     * 派发的 'root:N'）在库原生世界没有"只刷这一个库"的对应操作——runIngest 本就是全量扫
     * 同一份 deps.roots，传参无意义，忽略不用。
     */
    async refreshLibrary(_libraryId) {
      await deps.runIngest()
    },
  }
}
