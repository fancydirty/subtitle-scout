// src/v2/notificationsRepo.ts —— R-F3 通知页的持久化数据源。
//
// ── 与 SSE 的分工（这是本文件存在的全部理由）─────────────────────────────────
// 上一个 commit（32ceaeb）的 ScoutEventBus 里 `found` 事件是通知页的**实时**来源，但它的
// 续传缓冲是进程内环形缓冲（50 条、非持久）。R-F3 要求通知**保留一周**，两者差的不是容量而是
// 生命周期：浏览器关着的那 23 小时里找到的字幕在进程内缓冲里全部丢失，容器重启同样清零。
// scoutEvents.ts 的注释自己划过界——那条缓冲"**不是账目**"。于是分工是：
//   · SSE      = 把**新的**推给**正在看的人**（实时性，允许丢）
//   · 本表     = 一周的成果流水（账目，不许丢）
// 两者的写入点刻意**同一处**（装盘成功那一刻），故任何一侧漏发都能被另一侧的用例照出来。
// 为什么不能从既有表推导出这条流水（files.updated_at / subtitles / runs / jobs 逐个排除，
// 全部实测过）：见 db.ts 的 v39 migration entry 头注释，不在这里复述第二份。
//
// ── 保留一周怎么实现：读时过滤 **+** dbMaintenance 顺手清（两条都要，不是二选一）──
// 读时过滤是**正确性**的保证：清理是周期性的，容器刚起来/维护循环还没轮到时表里必然躺着
// 陈年数据，只靠清理的话那一刻通知页会漏出三个月前的成果（用例「一周窗是读时过滤，不依赖
// 清理跑过」钉的就是这条）。清理是**空间**的保证：只读时过滤的话表会无界增长——一年后一张
// 几万行的表里只有几十行会被读到，且每次读都要扫过全部历史。
// 清理挂在既有的 dbMaintenance 循环里（那里已经在跑 VACUUM/checkpoint），**不新起定时器**：
// 多一个定时器就多一处"谁来触发"的接线，而本仓栽过 6 次"有能力没人触发"。
import type { ScoutDb } from './db.js'

/** 保留期（R-F3「保留一周」）。**读窗与清理共用这一个常量**——两处各写一份的话，
 *  漂移的形态是"清理删掉了还该显示的"（清理更短）或"留下一批永不显示的垃圾"（清理更长），
 *  两种都不会有任何断言自然报红。 */
export const NOTIFICATION_RETENTION_MS = 7 * 24 * 3600_000

/** 字幕的来路。对用户而言"从哪来的"是次要信息（结果都是"这一集现在有中文字幕了"，故通知页
 *  **不分两个池子** / 同 daemonV2 的 found 事件口径），但仍要存：抓来的和机翻的质量期望不同，
 *  用户看到「翻译完成」时对字幕质量的预期应该被如实告知。 */
export type FoundVia = 'fetch' | 'translate'

export interface FoundInput {
  workId: string
  title: string
  /** NULL = 电影（R-F3「电影就是已找到字幕」）。 */
  season: number | null
  episode: number | null
  via: FoundVia
}

export interface FoundRow extends FoundInput {
  foundAt: number
  /** 这条通知所属作品的类型。
   *
   *  🔴 2026-08-13：`season IS NULL` 在 notifications 表里有**两个含义**——
   *   ① 真电影（`recordFound` 的入参注释写的那个：「NULL = 电影」）
   *   ② **剧集，但那个文件的季没解析出来**（生产实测：112 个文件 season/episode 为 NULL，
   *      其中 79 个属于 TV 作品）。装盘成功时 `f.season` 原样写进来，就是 NULL。
   *  前端此前判 `isMovie = season === null`，于是 ② 被渲染成电影行——**把剧集说成电影**。
   *
   *  这一列就是那个歧义的消解：类型是 `works` 的结构事实，不是展示快照，
   *  故用 LEFT JOIN 现取（与 title「写入时快照、不 join 纠正」的裁决不冲突：
   *  那条护的是**改名**这种展示层变化，而一部作品不会从剧集变成电影）。
   *
   *  ⚠️ `'unknown'` 是真实的第三态，不是兜底噪音：`works` 行可能已被删（用户移除了守备
   *  目录，而通知还在一周窗内）。此时我们**确实不知道**它是电影还是剧集——
   *  渲染层必须走一条不声称任何一边的路，绝不许 `?? 'movie'`。 */
  mediaType: 'tv' | 'movie' | 'unknown'
}

/** 按作品+季聚合的一条通知——**这是前端真正要渲染的形状**
 *  （R-F3：「XX 剧找到了 S01 的第 3/5/7 集」）。 */
export interface FoundGroup {
  workId: string
  title: string
  /** NULL = 电影（此时 episodes 为空数组）。 */
  season: number | null
  /** **升序**（展示用"第 3/5/7 集"）。电影为空数组。 */
  episodes: number[]
  /** 组内最近一次找到的时刻——组间倒序的锚点。 */
  latestAt: number
  /** 组内来路：全 fetch / 全 translate / 混合。混合时必须如实报 'mixed'，
   *  不许取第一条充数（一季里有抓来的也有机翻的时，谎报单一来源会误导用户对质量的预期）。 */
  via: FoundVia | 'mixed'
  /** 同 FoundRow.mediaType（组内同一 workId，恒等）。
   *
   *  🔴 渲染层判"这是不是电影"**只许读这个字段**，不许再用 `season === null`——
   *  那个判据在本表里是二义的（真电影 / 剧集但季没解析出来），生产上正把剧集渲染成
   *  「已找到字幕」的电影行。完整论证见 FoundRow.mediaType。 */
  mediaType: 'tv' | 'movie' | 'unknown'
}

/**
 * 记一条"找到了字幕"。**两个调用点**：subtitleScheduler 的装盘回写（via='fetch'）与
 * applyTranslateOutcome 的 installed 分支（via='translate'）——恰好也是 SSE `found` 事件的
 * 两个发出点。
 *
 * ── 幂等：冲突时**刷新**而不是追加（这是本文件唯一需要论证的行为选择）──
 * 幂等键 = (work_id, season, episode)。同一集重复装盘的真实成因有三个，**全都不是新成果**：
 *  ① 用户手删字幕 → 扫描回退 NULL → 重新找到（对用户是同一件事的重演）
 *  ② worker 报 installed 但文件没落地 → 下轮重找（R24 下的既有形态）
 *  ③ 抓取装盘后翻译轨又装一遍（两个 via 命中同一集）
 * 若逐次追加，一个"每天被重找一次"的文件一周内往通知页灌 7 条同文，把真正的新成果挤出屏幕
 * ——而 R-F3 明令**不做已读状态**，用户没有任何手段清掉它们。故重复只刷新 found_at 与 via
 * （它确实是"最近一次找到"，在倒序流水里该往前排）。
 *
 * ── 整体 try/catch，绝不向调用方抛错 ──
 * 与 ScoutEventBus.publish 完全同一口径（那里的注释：推送是增益，SSE 挂了绝不能影响巡检）。
 * 这里更硬性：调用方是**装盘回写路径**，一次通知写失败若掀翻它，代价是文件不出队 →
 * 下一轮重选 → C26 付费 LLM 热循环。通知是增益，绝不许反噬主流程。
 */
export function recordFound(db: ScoutDb, input: FoundInput, now: number): void {
  try {
    db.prepare(
      `INSERT INTO notifications (work_id, title, season, episode, via, found_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(work_id, ifnull(season,-1), ifnull(episode,-1))
       DO UPDATE SET found_at = excluded.found_at, via = excluded.via, title = excluded.title`,
    ).run(input.workId, input.title, input.season, input.episode, input.via, now)
  } catch {
    // 吞掉：见函数头注释。表缺失/约束意外/磁盘满都不许打断装盘回写。
  }
}

/** 倒序流水（R-F3），一周窗内。`now` 可注入——同本仓 deps.now() 的既有口径。
 *  读失败返回空数组而不抛错：通知页挂掉不许把整个 dashboard 带走。
 *
 *  🔴 LEFT JOIN works 只为 `media_type`（见 FoundRow.mediaType）。**必须 LEFT**：
 *  INNER 会让"作品行已被删、通知还在一周窗内"的成果**整条消失**——用户前天确实收到了
 *  那条字幕，把它抹掉比说不清它是电影还是剧集更糟。查不到 → 'unknown' 三态。 */
export function listRecentFound(db: ScoutDb, now: number): FoundRow[] {
  try {
    const rows = db.prepare(
      `SELECT n.work_id AS workId, n.title, n.season, n.episode, n.via,
              n.found_at AS foundAt, w.media_type AS mediaType
         FROM notifications n LEFT JOIN works w ON w.id = n.work_id
        WHERE n.found_at > ?
        ORDER BY n.found_at DESC, n.id DESC`,
    ).all(now - NOTIFICATION_RETENTION_MS) as Array<Omit<FoundRow, 'mediaType'> & { mediaType: string | null }>
    // 三态收敛在**一处**：SQL 给的是原始列（可能是 NULL / 未来新增的第三种值），
    // 收敛判据只有这一行，渲染层与聚合层都不再各判一次。
    return rows.map((r) => ({
      ...r,
      mediaType: r.mediaType === 'movie' ? 'movie' : r.mediaType === 'tv' ? 'tv' : 'unknown',
    }))
  } catch {
    return []
  }
}

/**
 * 按作品+季聚合（R-F3 的展示形态）。**逐集存、读时聚合**——存聚合会撞上"同一季分两次找到"
 * 的合并问题（先找到 E1、两天后找到 E2：聚合行要么被覆盖丢掉 E1，要么要读-改-写，而两步
 * 之间掉电会留半状态，软路由掉电是本项目常态）。逐集存天然免疫，代价只是读时聚合一次——
 * 一周的量级是几十行。
 *
 * 聚合在 JS 里做而不是纯 SQL 的 GROUP_CONCAT：`episodes` 要的是 number[]，而 GROUP_CONCAT
 * 出来是字符串，还要在这一层再 split+parseInt 一遍（且 NULL 与 '' 的边界要另判）。多一次
 * 字符串往返换不到任何东西。排序仍交给 SQL（索引在 found_at 上）。
 */
export function listRecentFoundGrouped(db: ScoutDb, now: number): FoundGroup[] {
  // 复用 listRecentFound 而不是另写一条 SQL：**两个读口径必须字节一致**，各写一份的话
  // "一周窗"会有两份实现，改了一处另一处静默漂移（聚合页漏出陈年成果，而流水页正常）。
  const rows = listRecentFound(db, now)
  const byKey = new Map<string, FoundGroup>()
  for (const r of rows) {
    // 键必须含季（同一作品的 S01 与 S02 是两条通知），电影用 -1 占位（同唯一索引的 ifnull 口径）
    const key = `${r.workId}/${r.season ?? -1}`
    let g = byKey.get(key)
    if (!g) {
      // rows 已按 found_at DESC，故**首次见到**该组的那一行就是组内最新 → latestAt 直接取它
      g = {
        workId: r.workId, title: r.title, season: r.season, episodes: [],
        latestAt: r.foundAt, via: r.via, mediaType: r.mediaType,
      }
      byKey.set(key, g)
    }
    if (r.episode !== null) g.episodes.push(r.episode)
    if (g.via !== 'mixed' && g.via !== r.via) g.via = 'mixed'
  }
  // 组内集号升序（展示用"第 3/5/7 集"）；组间顺序由 Map 的插入序继承 SQL 的 found_at DESC。
  for (const g of byKey.values()) g.episodes.sort((a, b) => a - b)
  return [...byKey.values()]
}

/** 清掉过保留期的行，返回删除条数。**由 dbMaintenance 顺手调**（不新起定时器）。
 *  失败返回 0 而不抛错：它跑在运维循环里，不许拖垮 VACUUM/checkpoint（同 dbMaintenance
 *  内部逐个 try/catch 的既有口径——一处失灵不许连坐）。
 *
 *  边界用 `<=`，与读窗的 `>` 严格互补：两边都用 `<`/`>` 会在恰好 now-7天 那一微秒留一行
 *  "读不到又删不掉"的幽灵行（它永远不显示，但永远占着幂等键，让那一集再也发不出新通知）。 */
export function pruneFound(db: ScoutDb, now: number): number {
  try {
    return db.prepare('DELETE FROM notifications WHERE found_at <= ?')
      .run(now - NOTIFICATION_RETENTION_MS).changes
  } catch {
    return 0
  }
}
