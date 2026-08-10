/**
 * 字幕校验的巡检扫描——把检测链接到 daemon 的周期 tick 上，让功能对用户真正可见。
 *
 * ## 为什么需要这一层
 *
 * 检测链（verifySubtitle.ts）与三个 API 端点（dashboard/subtitleVerifyApi.ts）做完之后，
 * 全库仍然一个芯片都不显示：`correct` / `revert` 两条**写**路径会调用 `verifyAndRecord`，
 * 但它们的前置是"库里已有一行检测结论"（那两个端点的 locate() 没有结论就 404）。
 * 换句话说，唯二的检测调用点都只能给**已检测过**的条目重检——**没有任何地方给"从未
 * 检测过"的条目做首次检测**。GET 端点于是对整个库如实回报 `checked:false`，
 * 用户永远看不到任何东西。本模块补的就是这条"首次检测"的接线。
 *
 * ## 为什么必须有预算上限（不是优化，是可行性前提）
 *
 * 参考源 ① 层要 spawn ffmpeg 抽内嵌轨：`extractEmbeddedSub.ts:42` 实测注明 4K 长片可超
 * 30s（Astronaut ~90s+），`referenceSource.ts` 因此已有 `EMBEDDED_TOTAL_BUDGET_MS`=60s 的
 * **单条目**软预算。单条目 60s 意味着"扫全库"在 394 项的真实库上是 6.5 小时量级——
 * 那不是一次巡检，那是一次事故。所以这里再加一层**批次**预算（条数 + 墙钟，两个都要，
 * 见 VERIFY_SWEEP_MAX_ITEMS / VERIFY_SWEEP_BUDGET_MS 各自的注释：两者封住的是不同的失控方向）。
 *
 * ## 为什么串行（绝不并行）
 *
 * 目标机器是软路由（Intel N100）。ffmpeg 抽轨是 IO 密集，并行会同时 spawn 多个进程抢盘，
 * 在弱 IO 环境下总墙钟不降反升——`referenceSource.ts:13` 对①层内部多轨抽取已经做过同一
 * 判断（"串行是刻意的"）。这里刻意**不用** probeConcurrency.ts 的 mapWithConcurrency：
 * 那个工具服务的是云盘 ffprobe（每请求 302 到 CDN、瓶颈是网络延迟而非本地 IO，实测真并行
 * 有收益），与本场景的物理约束相反。
 *
 * ## 云盘条目怎么处理（如实交代：无检测手段，用超时兜住）
 *
 * spec §3.3 明确云盘且无内嵌轨/同目录字幕时不做。查过了，**代码库里没有任何"判断路径是
 * 云盘还是本地"的现成手段**：`media_roots.type` 列是 `NOT NULL DEFAULT 'local'`、db.ts:174
 * 注明"存储协议战役预留"，`settingsRepo.addRoot` 写死 `'local'`，全仓库没有第二个写入点；
 * `core/mediaContext.ts` 只有 roots 归属判断，不含协议概念。于是本模块**不按挂载类型区分**，
 * 改用协议无关的一道门：`itemTimeoutMs` 单条目超时 + 批次墙钟预算。
 *
 * 这样做的正当性：referenceSource 的 ①② 两层本身都不碰音频（不做 VAD 正是因为云盘随机读
 * 每 seek 付 ~12s CDN 延迟），云盘上①层要么读头部秒回、要么返回 null；真正没有实测数据的
 * 未知是"ffmpeg 抽**整条**内嵌轨在云盘上有多慢"。超时对这个未知是正确的形状——它按"实际
 * 有多慢"止损，而不是按"我猜它是什么盘"预判；一条真的很慢的本地 4K 长片同样该被止损，
 * 一条其实很快的云盘条目也不该被无故跳过。代价是慢条目每 6h 白付一次超时；换来的是不引入
 * 一个我无法验证的挂载类型探测器。
 *
 * ## 只检测，绝不校正（spec 铁律③）
 *
 * 本模块唯一的写动作是 `verifyAndRecord` 落一行结论。发现偏移只落库（verdict='shifted'），
 * 红芯片亮起来等用户点——**是否校正是用户的选择**。这里没有、也绝不能有 shiftTiming 的
 * 调用点：巡检自动改写用户的字幕文件是本仓库风险最高的越权。
 */
import type { SubtitleVerifyRepo } from '../v2/subtitleVerifyRepo.js'
import type { VerifyOutcome } from './verifySubtitle.js'

/**
 * 一次巡检最多处理几条。
 *
 * 取 20 的理由（2026-07-31 按生产实测上调，原为 5）：
 *
 * 原来的 5 是在**不知道真实成本**时定的保守值，理由写的是"5 × 60s 软预算 ≈ 5 分钟"。
 * 部署后拿到真机数字，那个估算高了一个数量级：
 *   - 局域网 CIFS 抽整轨内嵌字幕（23.7 分钟的 4K mkv）= **8 秒**，不是 60 秒
 *   - 对齐检测（646 条 cue，±60s 滑窗）= **160ms**；解析 = 84ms
 *   - 端到端一条（含找参考源 + 检测）实测 **575~614ms**
 * 也就是说一轮 5 条真实耗时是**几秒**，而我给了 5 分钟预算。
 *
 * 更要紧的是它的实际后果：282 个 covered 条目按 6h/5 条推进要 **14 天**才铺满全库——
 * 用户得等两周才能看到这个功能的价值（红芯片）。这不是"保守"，是让功能实质上不可用。
 *
 * 20 条 × 实测单条 ~0.6s ≈ 12 秒/轮；即使全部走最坏的①层软预算(60s)也是 20 分钟，
 * 由下面的墙钟预算(现 8 分钟)拦住。两个上限仍然刻意咬合，任一先到都止损。
 *
 * 为什么条数与墙钟都要（不是重复）：墙钟只在**开新条目之前**检查（同 EMBEDDED_TOTAL_BUDGET_MS
 * 的软预算语义），所以在一个"每条都极快"的库上它压根不会触发——此时限制批量的只有条数上限，
 * 它封住的是"一拍里对几百条快条目连续做几百次文件读+ffprobe"。反过来在慢条目上条数上限
 * 形同虚设（5 条也能跑 25 分钟），此时止损的只有墙钟。两者封的是不同的失控方向。
 */
export const VERIFY_SWEEP_MAX_ITEMS = 20

/**
 * 一次巡检的总墙钟预算。超预算后不再**开新**条目（不中断已在跑的那条——中断需要把
 * AbortSignal 传进 extractEmbeddedSubtitle，它当前不收；单条目自身由 itemTimeoutMs 兜底）。
 * 与 EMBEDDED_TOTAL_BUDGET_MS 同一套"软预算"语义，理由见那边注释。
 *
 * 取 8 分钟（2026-07-31，原 5 分钟）：扫描是 **fire-and-forget** 的（历史调用方
 * ScoutDaemon.tickInner 步骤 2e 不 await 它；tickInner 已随 src/v2/daemon.ts 于第 7 步 B 组
 * 删除），所以它不阻塞 reap/dispatch——原注释里"最多让 20 拍其它分支延后"
 * 的担心不成立，那是把它当同步任务算的。真正的成本是 ffmpeg 抢 IO，而实测一轮 20 条
 * 只有十几秒，离 8 分钟很远。
 *
 * 上调到 8 分钟只为给"20 条里有几条是慢条目"留余量（20 × 实测 0.6s ≈ 12s 是常态，
 * 但云盘/4K 长片的单条可达 30~60s）。它兜的仍然是失控而非常态。
 *
 * 原注释末句"真需要更快铺满全库时靠累积、不靠单拍加量"已被实测推翻：靠累积要 14 天，
 * 而单拍加量的真实成本是十几秒。那句判断是在没有数字时做的。
 */
export const VERIFY_SWEEP_BUDGET_MS = 8 * 60_000

/**
 * 巡检间隔（时间门）。
 *
 * 取 1h（2026-07-31，原 6h）。原注释说"间隔取短没有收益"，这个判断只在**稳态**下成立
 * ——而它忽略了铺量期：6h × 5 条要 14 天才走完 282 个 covered 条目。
 *
 * 现在 1h × 20 条 ≈ **14 小时**铺满全库，之后自动回到稳态（候选集合单调收缩：检过一次
 * 且哈希不变就不再是候选，见 needsRecheck）。稳态下这个查询是一条走索引的 LEFT JOIN，
 * 每小时空跑一次的成本可以忽略——原注释担心的"空转查询变频繁"是真的，但量级错了。
 *
 * 为什么不干脆 15 分钟：新装字幕的检测延迟不是瓶颈（find-subtitle 装完，下一轮自然捡到），
 * 而 1h 已经让铺量期从 14 天压到半天。再缩短只增加稳态空转，不改善用户可见的任何东西。
 */
export const VERIFY_SWEEP_EVERY_MS = 1 * 3_600_000

/**
 * 单条目超时。超时按"这条检测失败"处理（记 log、继续下一条），不写库——
 * 超时意味着我们不知道结论，落一行假结论比不落更坏。
 *
 * 取 90s：必须**严格大于** referenceSource 的 EMBEDDED_TOTAL_BUDGET_MS(60s)，否则这道门会
 * 常态性地砍掉①层正常跑完最后一条轨的合法路径（那 60s 是软预算，最坏会超出一个单轨时长），
 * 把"能验证"的条目系统性地变成"没验证"。留 30s 余量对应 extractEmbeddedSub.ts:42 实测的
 * 单轨 30s 量级。它兜的是真正的失控（云盘抽整轨、ffmpeg 卡死不返回），不是正常的慢。
 */
export const VERIFY_SWEEP_ITEM_TIMEOUT_MS = 90_000

/** meta 表的时间门键名。同 daemon 既有的 last_ingest_at / last_trace_prune_at 惯例。 */
export const VERIFY_SWEEP_META_KEY = 'last_verify_sweep_at'

/** 一个候选：条目 id + 片源路径 + 待检字幕路径。 */
export interface VerifyCandidate {
  itemId: string
  videoPath: string
  subtitlePath: string
}

/** 最小 DB 接口（只要能 prepare，同 daemon 既有的 lib.db 用法）。 */
export interface SweepDb {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[]
    get(...params: unknown[]): unknown
    run(...params: unknown[]): unknown
  }
}

/**
 * 选候选：`sub_status='covered'` 且挂着外挂字幕文件、且 subtitle_verify 里没有结论的条目。
 *
 * ## 为什么只要 covered
 *
 * - `covered` = 外挂中字已就位，**有一个外挂文件可以被校验、也可以被校正**。只有这一档
 *   同时满足"有东西可检"和"检出问题后用户点校正时有文件可改"。
 * - `embedded` 刻意排除：内嵌中字压根不需要处理，也**没有外挂文件可改**——即便检出偏移，
 *   校正按钮也无从下手（我们绝不改写用户的视频容器）。给它落一行红结论只会产生一个
 *   点不动的红芯片。
 * - `missing` / `unavailable` / `ignored` 排除：没有字幕文件，无从检测。
 * - `hardsub-assumed` 排除：同 embedded，没有外挂文件。
 *
 * ## 为什么 file_path IS NULL
 *
 * `subtitles.file_path` 非 NULL 的行是**副本**文件的字幕（重复源 P4b 的 addReplicaSubtitle，
 * 见 libraryRepo.listSubtitlesForFile 头注释）；NULL 才是主文件的外挂字幕。而
 * `subtitle_verify` 是 `PRIMARY KEY(item_id)` **一行一集**——把副本字幕也选进来，多个副本会
 * 抢同一行、互相覆盖结论，还会让"这行记的是哪个文件"变得不可预期。主文件路径也正是
 * episodes/movies.path（写扳手 locate() 取片源的同一个来源），两侧口径必须一致。
 *
 * ## 为什么用 LEFT JOIN 而不是在应用层调 needsRecheck
 *
 * `verifyAndRecord` 自带 needsRecheck 判据（哈希未变则跳过、返回 null），所以正确性不依赖
 * 这里。但"已检过的条目"在稳态下是全库的绝大多数，若把它们也选成候选，每次巡检都要为每条
 * 白读一遍字幕文件算哈希才发现不用检——这一条 SQL 就把稳态成本压到近零。
 * 代价是"字幕换过、哈希已变"的条目在这里不算候选（它有行），需要重检时由 recheck 通道
 * 覆盖；这是刻意的取舍：本模块的职责是**首次**检测的接线（见文件头），把"重检铺量"也
 * 塞进来会让这条 SQL 反过来失去它唯一的价值。
 */
export function selectVerifyCandidates(db: SweepDb, limit: number): VerifyCandidate[] {
  if (limit <= 0) return []
  // episodes 与 movies 是同一个 item_id 空间的两半（db.ts subtitle_verify.item_id 注释），
  // UNION ALL 两侧同形。ORDER BY 只为可预期（稳定的推进顺序），不含优先级语义。
  const rows = db
    .prepare(
      `SELECT item_id, video_path, subtitle_path FROM (
         SELECT e.id AS item_id, e.path AS video_path, s.path AS subtitle_path
           FROM episodes e
           JOIN subtitles s ON s.item_id = e.id AND s.file_path IS NULL
           LEFT JOIN subtitle_verify v ON v.item_id = e.id
          WHERE e.sub_status = 'covered' AND v.item_id IS NULL
         UNION ALL
         SELECT m.id AS item_id, m.path AS video_path, s.path AS subtitle_path
           FROM movies m
           JOIN subtitles s ON s.item_id = m.id AND s.file_path IS NULL
           LEFT JOIN subtitle_verify v ON v.item_id = m.id
          WHERE m.sub_status = 'covered' AND v.item_id IS NULL
       )
       ORDER BY item_id,
         -- 同一条目挂多份字幕时（生产实测 282 个 covered 里有 10 个），优先选**和视频
         -- 同目录**的那份。理由：参考源的 ② 层就是扫字幕所在目录，字幕跟视频不在一起时
         -- 那一层必然空手而归；而且跨目录的那份常常在云盘上（生产上 The Conjuring 的
         -- 4 份字幕里 2 份在 /media/aliyun），云盘既抽不了内嵌轨也没有同目录同伴，
         -- 结果是白判一次 unverifiable —— 明明另一份就在视频旁边、能验。
         -- rtrim(video_path, replace(video_path,'/','')) 取出视频路径的目录前缀（含尾斜杠），
         -- 这是 SQLite 里没有 dirname() 时取目录的惯用法。
         CASE WHEN subtitle_path LIKE rtrim(video_path, replace(video_path, '/', '')) || '%'
              THEN 0 ELSE 1 END,
         subtitle_path`,
    )
    .all() as Array<{ item_id: string; video_path: string; subtitle_path: string }>

  // 一个条目挂多份字幕（简繁两份等）时只取先到的那一份：subtitle_verify 一行一集，
  // 两份都检会互相覆盖同一行。去重必须在 SQL 之后做而不是靠 GROUP BY——哪一份被选中
  // 由上面确定性的 ORDER BY 决定，可预期且跨 pass 稳定（同一条目每次都检同一个文件，
  // 否则 needsRecheck 的 subtitle_path 判据会让它每轮都判"换了文件、要重检"，永不收敛）。
  const seen = new Set<string>()
  const out: VerifyCandidate[] = []
  for (const r of rows) {
    if (seen.has(r.item_id)) continue
    seen.add(r.item_id)
    out.push({ itemId: r.item_id, videoPath: r.video_path, subtitlePath: r.subtitle_path })
    // limit 在这里截断而不是写进 SQL 的 LIMIT：SQL 层的行数与去重后的条目数不是同一个量
    // （一条目多份字幕时 SQL LIMIT 5 可能只对应 3 个条目），会让批次上限低于设定值。
    if (out.length >= limit) break
  }
  return out
}

export interface VerifySweepDeps {
  db: SweepDb
  repo: SubtitleVerifyRepo
  /** 注入点：检测并落库。默认接线在 cli 侧绑 verifyAndRecord（它自带 needsRecheck 跳过判据）。
   *  必须可注入：ESM 无法 spy 模块导出，而真实实现会 spawn ffmpeg，不注入就没法测本模块。 */
  verify: (c: VerifyCandidate) => Promise<VerifyOutcome | null>
  log: (msg: string) => void
  now: () => number
  /** 批次条数上限，默认 VERIFY_SWEEP_MAX_ITEMS。 */
  maxItems?: number
  /** 批次墙钟预算，默认 VERIFY_SWEEP_BUDGET_MS。 */
  budgetMs?: number
  /** 单条目超时，默认 VERIFY_SWEEP_ITEM_TIMEOUT_MS。 */
  itemTimeoutMs?: number
}

export interface VerifySweepResult {
  /** 实际跑完检测（含判 unverifiable）的条数。 */
  checked: number
  /** verifyAndRecord 返回 null（哈希未变、不必重检）的条数。 */
  skipped: number
  /** 失败/超时的条数。 */
  failed: number
  /** 因墙钟预算耗尽而没被开工的条数。 */
  budgetSkipped: number
}

/** 给一个 promise 套超时。超时**不取消**底层工作（extractEmbeddedSubtitle 不收 AbortSignal），
 *  只是不再等它——它自己有 5 分钟超时兜底。同 cli/doctor.ts withTimeout 的既有形状。 */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} 超时（${ms / 1000}s）`)), ms)
  })
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
}

/**
 * 跑一次巡检扫描：选候选 → 串行逐条检测落库，受条数与墙钟双预算约束。
 *
 * **单条失败绝不阻塞后续**（daemon 的既有纪律）：每条包 try/catch，ffmpeg 挂了、文件消失、
 * 编码怪异都只记一行 log 继续下一条。整个函数自己就该是不抛的，否则"一条坏字幕炸掉整个
 * 后台循环"。（历史口径：曾经的调用方 ScoutDaemon.tickInner 那一侧还会再包一层兜底；
 * tickInner 已随 src/v2/daemon.ts 于第 7 步 B 组删除，且本函数当前**无任何生产调用者**
 * ——巡检注入于 2026-08-07 雪藏，见 cmdWatch 里 `verifyRepo` 构造处的说明。故"自己不抛"
 * 现在是唯一一道防线。）
 */
export async function runVerifySweep(deps: VerifySweepDeps): Promise<VerifySweepResult> {
  const maxItems = deps.maxItems ?? VERIFY_SWEEP_MAX_ITEMS
  const budgetMs = deps.budgetMs ?? VERIFY_SWEEP_BUDGET_MS
  const itemTimeoutMs = deps.itemTimeoutMs ?? VERIFY_SWEEP_ITEM_TIMEOUT_MS
  const result: VerifySweepResult = { checked: 0, skipped: 0, failed: 0, budgetSkipped: 0 }

  const candidates = selectVerifyCandidates(deps.db, maxItems)
  if (candidates.length === 0) return result

  const startedAt = deps.now()
  for (const [index, c] of candidates.entries()) {
    // 只在**开新条目之前**查预算（软预算语义，同 EMBEDDED_TOTAL_BUDGET_MS）。第一条天然
    // 无条件被开工：startedAt 取自循环前一行，index 0 时 elapsed 恒 0 必然小于预算——
    // 这是刻意依赖的性质，预算防的是"多条累加成小时级"，不是"单条慢"（那是 itemTimeoutMs
    // 的职责）；一条都不开就返回会让本分支在慢盘上彻底失效、永不铺量。
    if (deps.now() - startedAt >= budgetMs) {
      result.budgetSkipped = candidates.length - index
      deps.log(
        `verify sweep: 墙钟预算 ${budgetMs}ms 耗尽，本轮剩余 ${result.budgetSkipped} 条留给下一轮`,
      )
      break
    }
    // 串行 await：绝不并行（软路由 IO 抢占，见文件头）。
    try {
      const outcome = await withTimeout(
        deps.verify(c),
        itemTimeoutMs,
        `verify ${c.itemId}`,
      )
      if (outcome === null) {
        result.skipped++
      } else {
        result.checked++
      }
    } catch (error) {
      // 失败不阻塞：记一行继续下一条。刻意**不落库**——超时/异常意味着我们不知道结论，
      // 写一行假的 unverifiable 会让 needsRecheck 认为"检过了"，从此再也不重试。
      result.failed++
      const msg = error instanceof Error ? error.message : String(error)
      deps.log(`verify sweep: item ${c.itemId} 检测失败（隔离，继续下一条）：${msg}`)
    }
  }

  return result
}
