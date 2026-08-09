// src/v2/subtitleScheduler.ts：字幕调度器（新架构阶段 4）。
// 职责：从 files 表挑"需要字幕的一簇"（一个作品）→ 组装 FindSubtitleTask → 调字幕 worker。
//
// 字幕 agent 的输入（用户裁决）：一个作品的全部 needs_subtitle 文件。
// 它不需要看目录树、不需要判断身份、不需要管字幕放哪——系统 harness 它。
import type { ScoutDb } from './db.js'
import type { FindSubtitleTask, FindSubtitleTargetFact } from '../agent/findSubtitleWorker.schemas.js'
import type { LanguageModel } from 'ai'
import { makeFindSubtitleWorker } from '../agent/findSubtitleWorker.js'
import { traceBus } from '../core/traceBus.js'

export interface SubtitleQueueItem {
  workId: string
  title: string
  originalTitle: string | null
  year: number | null
  overview: string | null
  chineseTitles: string[]
  mediaType: string
  files: Array<{ path: string; filename: string; season: number | null; episode: number | null; dir: string; durationSec: number | null; embeddedLangs: string[] | null }>
}

/** 字幕队列：一个作品的一簇（needs_subtitle=1 的全部文件）。
 *  🔴 2026-08-08 实测：必须按守备目录过滤——files 表可能含已移除根的残留数据
 *  （如 115 测试目录），只读挂载上建 staging 沙盒会 ENOENT。
 *
 *  谓词是 `sub_status IS NULL`（spec §2 阶段 3 的口径，3-2 收紧到位）。它同时承担两件事：
 *   · **排除 covered**（D8 / C27）：judge 的 sidecar 规则已被删除——"磁盘上当前有没有外挂
 *     中文字幕"这个事实不再投影到 needs_subtitle（两列都判同一个事实会造出永久卡死态，
 *     论证见 subtitleJudge.ts 顶部）。于是"磁盘已有外挂中字的文件不许被送进字幕流白烧一轮
 *     付费 LLM"这个正确行为的**唯一保证者**就是扫描写的 sub_status='covered'（R24）。
 *   · **排除停牌两态**（C14 两工作台互斥）：`handoff_translate` 归翻译工作台、`unsolvable`
 *     归阶段 2.6 复查闸（D13）。同一轮内一个文件不得同时出现在两个工作台的快照里，
 *     否则翻译跑到一半被字幕流改了状态，D10 的乐观守卫匹配 0 行 → 退避不写 → 热循环。
 *
 *  为什么现在才敢从"排除 covered"收紧到 `IS NULL`（1b-5 时刻意留的偏差，已按计划关闭）：
 *  这条更严的谓词有两个**前置条件**，两者都已在本步之前落地——
 *   ① v33 迁移把存量 `sub_status='unavailable'` 洗成 NULL（D19 / C44）
 *   ② 本文件里那个写 `unavailable` 的点已按 R17 拆掉（改为 NULL + sub_attempt+1 + 退避）
 *  少了任一条，这批行会立刻既不在字幕工作台、又攒不到 7 次 → **永久出局**（C15/C44）。
 *
 *  🔴 2026-08-08 实测：必须按守备目录过滤——files 表可能含已移除根的残留数据
 *  （如 115 测试目录），只读挂载上建 staging 沙盒会 ENOENT。 */
export function listSubtitleQueue(db: ScoutDb, roots?: string[], now = Date.now()): SubtitleQueueItem[] {
  const rows = db.prepare(`
    SELECT w.id AS work_id, w.title, w.original_title, w.year, w.overview, w.chinese_titles, w.media_type,
           f.path, f.filename, f.season, f.episode, f.dir, f.duration_sec, f.embedded_langs
    FROM files f JOIN works w ON f.work_id = w.id
    WHERE f.needs_subtitle = 1
      AND f.sub_status IS NULL
      AND (f.recheck_after IS NULL OR f.recheck_after <= ?)
    ORDER BY w.id, f.season, f.episode
  `).all(now) as Array<{
    work_id: string; title: string; original_title: string | null; year: number | null;
    overview: string | null; chinese_titles: string | null; media_type: string;
    path: string; filename: string; season: number | null; episode: number | null; dir: string; duration_sec: number | null; embedded_langs: string | null
  }>

  const byWork = new Map<string, SubtitleQueueItem>()
  for (const r of rows) {
    if (roots && roots.length > 0) {
      const inside = roots.some((root) => r.path === root || r.path.startsWith(root + '/'))
      if (!inside) continue
    }
    let item = byWork.get(r.work_id)
    if (!item) {
      let chinese: string[] = []
      try { chinese = r.chinese_titles ? JSON.parse(r.chinese_titles) : [] } catch { chinese = [] }
      item = {
        workId: r.work_id, title: r.title, originalTitle: r.original_title, year: r.year,
        overview: r.overview, chineseTitles: chinese, mediaType: r.media_type, files: [],
      }
      byWork.set(r.work_id, item)
    }
    let langs: string[] | null = null
    if (r.embedded_langs) { try { langs = JSON.parse(r.embedded_langs) } catch { langs = null } }
    item.files.push({ path: r.path, filename: r.filename, season: r.season, episode: r.episode, dir: r.dir, durationSec: r.duration_sec, embeddedLangs: langs })
  }
  return [...byWork.values()]
}

/** 一个作品的字幕任务的 jobId，同时也是它 staging 沙盒的**目录名**
 *  （`<root>/.subtitle-staging/<jobId>/`，见 files/stagingSandbox.ts allocate）。
 *
 *  抽出来导出是 C34 的刚性需求：gcOrphans 靠这个目录名判"这个工作台是不是正在被使用"，
 *  daemon 侧必须能算出与 buildSubtitleTask **字节一致**的同一个字符串。两边各自手写一份
 *  `subtitle:${workId}` 的话，任何一侧改了格式，GC 的保护就静默失效——沙盒会在 agent 正在
 *  往里写的时候被 rm 掉，而测试里两边都自洽、全绿。本仓已因"留两份漂移实现"栽过多次。 */
export function subtitleJobId(workId: string): string {
  return `subtitle:${workId}`
}

/** 组装 FindSubtitleTask（一个作品的一簇）。 */
export function buildSubtitleTask(item: SubtitleQueueItem, targetLanguage: string): FindSubtitleTask {
  // INNER 沙盒根：所有文件所在目录的公共祖先（同一作品通常同根，安全）
  const dirs = item.files.map(f => f.dir)
  const mediaRoot = commonDir(dirs)
  // 🔴 2026-08-08 实测修正：itemId 必须从 work_id 派生（tmdb:95897/s1e1），不能传 null——
  // findSubtitleWorker 的 prompt 对 itemId:null 渲染"unidentified — identify first"，worker 会
  // 直接 no_safe_match 跳过而不搜索（Overflow 2 步退出的根因）。新架构里文件已识别（work_id
  // 有值），itemId 是"已识别"的信号。
  const targets: FindSubtitleTargetFact[] = item.files.map(f => ({
    itemId: item.workId + (f.season != null && f.episode != null ? `/s${f.season}e${f.episode}` : ''),
    videoPath: f.path,
    videoFilename: f.filename,
    season: f.season,
    episode: f.episode,
    absoluteEpisode: null,
    imdbId: null,
    runtimeMinutes: null,
    dirName: f.dir,
    durationSec: f.durationSec,
    embeddedLangs: f.embeddedLangs,
    embeddedTmdbId: null,
  }))
  return {
    jobId: subtitleJobId(item.workId),
    mediaRoot,
    workUnitKind: 'work-dir',
    title: item.title,
    originalTitle: item.originalTitle,
    year: item.year,
    alternativeTitles: item.chineseTitles,
    overview: item.overview,
    runtimeMinutes: null,
    providerIds: { tmdb: item.workId.replace('tmdb:', '') },
    targetLanguage,
    hardsubMode: 'off',
    localCandidates: [],
    targets,
  }
}

function commonDir(dirs: string[]): string {
  let candidate = dirs[0]
  while (!dirs.every(d => d === candidate || d.startsWith(candidate + '/'))) {
    const idx = candidate.lastIndexOf('/')
    if (idx <= 0) break
    candidate = candidate.slice(0, idx)
  }
  return candidate
}

/** 满几次真实尝试后移交（R10：用户裁决的"7 次"）。 */
const HANDOFF_THRESHOLD = 7

/** 停牌后交给阶段 2.6 复查闸的间隔（R25「每周找一次」/ D13）。 */
const PARK_RECHECK_MS = 7 * 24 * 60 * 60 * 1000

/** 把 report 里的一个 itemId / installedPath 反解成 files 表里的 path。
 *
 *  🔴 为什么按 **path** 反解而不是照旧用 itemId 正则（C15，spec 点名的"最致命的一条"之一）：
 *  三处旧实现都是 `/^tmdb:.*?\/s(\d+)e(\d+)$/`，**只认剧集**。电影的 season/episode 为 NULL，
 *  buildSubtitleTask 拼出来的 itemId 是裸 `tmdb:603`（见该函数里的三元表达式）→ 正则匹配失败
 *  → 该文件进不了对应的桶 → 落到别的分支去。于是同一个"找不到"，电影与剧集走了两条不同的
 *  回写轨、留下两种不同的状态：一边攒得到 7 次、另一边攒不到（或反之）。
 *
 *  归属反解本来就该按 path：本簇的文件清单（item.files）已经在手上，itemId 只是我们自己
 *  按 workId+season+episode 拼出来喂给 agent 的**派生值**，拿它去反查数据库是绕远路且会丢信息。
 *  故这里先按 itemId 与本簇文件逐一比对（同一套拼法，字节一致），再回退 installedPath 前缀。 */
function resolvePath(item: SubtitleQueueItem, itemId: string | null, installedPath?: string): string | null {
  if (itemId != null) {
    // 用**与 buildSubtitleTask 完全相同**的拼法反推，而不是解析正则——两处共用一条规则，
    // 电影（无 season/episode）与剧集自然同轨，不需要为电影另开一个分支。
    for (const f of item.files) {
      const id = item.workId + (f.season != null && f.episode != null ? `/s${f.season}e${f.episode}` : '')
      if (id === itemId) return f.path
    }
  }
  if (installedPath) {
    // 回退：按"去掉扩展名后的主干"匹配（字幕与视频同名不同扩展）。
    const base = installedPath.replace(/\.[^.]+$/, '')
    for (const f of item.files) {
      if (f.path.replace(/\.[^.]+$/, '') === base.replace(/\.[^.]+$/, '')) return f.path
    }
  }
  return null
}

/** 跑一个作品的字幕任务（复用现有 findSubtitleWorker）。
 *  worker = makeFindSubtitleWorker({ model, adapters, cacheRoot, tmdb }) 的返回值
 *  （runFindSubtitleTask），直接调用，返回 batch report。
 *
 *  🔴 死循环修复（spec docs/design/2026-08-08-deadloop-fix-v2.md）：
 *  - B-1：run 前 snapshot 清缓冲（traceBus 的 buf push 追加不重置，第二次跑同一
 *    workId 时 peek 会看到第一次的 search_source，编造被误判"有证据"）
 *  - B-2：无结局文件（不在任何桶）回写 recheck_after，不能残留 needs=1
 *  - B-3：catch-all——超时（TimeoutError）与其它抛错都回写，不能死循环
 *  - 反编造门：no_safe_match 必须有 search_source 证据才算"真的搜过"，
 *    零证据 = 编造 → 同样退避但记 fabricated-no-match 以便排障
 *  - 退避：全部"明天"（24h）——巡检模型下瞬时故障也是等下一轮（M-1）
 */
export async function runSubtitleWorkDir(
  db: ScoutDb,
  worker: (task: FindSubtitleTask) => Promise<import('../agent/findSubtitleWorker.schemas.js').FindSubtitleBatchReport>,
  item: SubtitleQueueItem,
  targetLanguage: string,
): Promise<import('../agent/findSubtitleWorker.schemas.js').FindSubtitleBatchReport | null> {
  const task = buildSubtitleTask(item, targetLanguage)
  const runKey = `job-subtitle:${item.workId}`
  const now = Date.now()
  // 🔴 巡检模型（spec 2026-08-08）：全部"明天"（24h）——瞬时故障在日巡检下
  // 也是等下一轮，1h/15min 短退避是旧 30s tick 思维的残留，与模型矛盾（M-1）。
  const DAY_MS = 24 * 60 * 60 * 1000

  /** 一次**真实失败**的回写：sub_attempt+1 + 退避，满 7 次则按 translatable 分流停牌。
   *
   *  🔴 计数写 `sub_attempt` 而不是 `attempt`（C7，3-2 实测确认过不是推测）：
   *  `attempt` 被识别轨共用，而 identifyScheduler 在识别成功时把它**归零**
   *  （`UPDATE files SET work_id=?, attempt=0 ... WHERE work_dir=?`）。实测：一行攒了 5 次
   *  字幕失败，跑一次识别成功回写后变 0。复用它的话 R10 的"满 7 次移交"永远走不到，
   *  而且反方向也脏（字幕失败顶高识别的退避阶梯）。一列一主。
   *
   *  分流（R21 + D15 + C40）在**同一条 UPDATE** 里连同计数一起写：分两条的话进程在两条之间
   *  被杀（软路由掉电是本项目常态）会留下"计数已到 7、状态还是 NULL"的行，下一轮再失败一次
   *  才停牌 —— 计数被白吃一次。
   *
   *  阈值是 `>= HANDOFF_THRESHOLD` 而**不是 `==`**（D15）：停牌复查闸放回时 sub_attempt
   *  不归零，值必然会超过 7。写 `==` 的话 sub_attempt=8/9 的行永远匹配不上 → 回 NULL 之后
   *  再也进不了停牌 → 每天被字幕流重选一次（而非每周），成本回到 D15 想避免的量级。 */
  const bump = (f: SubtitleQueueItem['files'][number], reason: string) => {
    const row = db.prepare('SELECT sub_attempt, translatable FROM files WHERE path = ?')
      .get(f.path) as { sub_attempt: number; translatable: number | null } | undefined
    const attempt = (row?.sub_attempt ?? 0) + 1
    const translatable = row?.translatable ?? null

    // 🔴 `sub:` 前缀（3-2 后置修复，实测确认过不是推测）：last_error 是识别轨与字幕轨的
    // **共用列**，而 identifyScheduler 的队列谓词是
    // `last_error IS NULL OR last_error != 'tmdb-404'` —— 靠这一列把 404 目录永久排除。
    // 字幕轨裸写 'no-match' 会把那个终态凭据洗掉：实测 404 态时识别队列 0 个目录，
    // 被覆盖后变 1 个 → 该目录重进识别队列，每天白烧一次 TMDB + LLM。
    // 加前缀而不是改 identifyScheduler 的谓词：一列多主时，各轨只认自己的命名空间是
    // 更小的契约（D17 的回填 pass 已用 `probe:` 前缀立过同样的先例）。
    // 前缀加在 bump 内部而不是 4 个调用点上——否则未来新增调用者必然忘。
    const tagged = `sub:${reason}`

    // 满 7 次且**可救性已判定**才停牌。translatable IS NULL 时刻意落到 else 分支
    // （C40 铁律：`translatable IS NULL` 不得判死）——判据不全 ≠ 不可救。judge 还没判到它、
    // 或 embedded_langs 缺失导致判不了，此刻判死会永久埋掉一批一抽轨就能救的日漫。
    // 它继续留在字幕流（sub_status 保持 NULL），计数照涨；待 D17 回填补上证据、judge 重判后，
    // 下一次失败立刻按 >=7 分流。
    if (attempt >= HANDOFF_THRESHOLD && translatable !== null) {
      // translatable=1 → 归翻译流；=0 → 不可救，不给第 8 次机会（R21：O(1) 可判的终局不该
      // 塞在 7 天延迟之后，更不该让翻译流领走一个 100ms 就判 unsupported 的活）。
      const parked = translatable === 1 ? 'handoff_translate' : 'unsolvable'
      // recheck_after=+7天：供阶段 2.6 停牌复查闸取件（D13/R25「每周找一次」）。
      // 若照失败轨写"明天"，复查会退化成日频；不写则停在上一次失败的"明天"，同样日频。
      db.prepare('UPDATE files SET sub_attempt = ?, sub_status = ?, recheck_after = ?, last_error = ?, updated_at = ? WHERE path = ?')
        .run(attempt, parked, now + PARK_RECHECK_MS, tagged, now, f.path)
      return
    }
    // sub_status **一列不动**（保持 NULL）：R17 废止了第五态 `unavailable`——"搜过确实没有"
    // 是普通失败，与其他失败路径同轨。写任何非 NULL 值都会让该行既不在字幕工作台
    // （谓词 `sub_status IS NULL`）、又攒不到 7 次 → 永久出局（C15）。
    db.prepare('UPDATE files SET sub_attempt = ?, recheck_after = ?, last_error = ?, updated_at = ? WHERE path = ?')
      .run(attempt, now + DAY_MS, tagged, now, f.path)
  }

  console.error(`[subtitle-worker] subtitle:${item.workId} task with ${task.targets.length} targets`)

  // B-1：run 前 snapshot 清缓冲（防 stale 事件污染反编造门）
  traceBus.snapshot(runKey)

  let report: import('../agent/findSubtitleWorker.schemas.js').FindSubtitleBatchReport
  try {
    report = await worker(task)
  } catch (e) {
    // B-3：catch-all——超时 vs 其它抛错都回写（不能死循环）
    const isTimeout = (e as Error | undefined)?.name === 'TimeoutError'
    const reason = isTimeout ? 'timeout' : String(e).slice(0, 100)
    for (const f of item.files) bump(f, reason)
    console.error(`[subtitle-scheduler] ${item.title} ${isTimeout ? '超时' : '抛错'}: ${reason}`)
    return null
  }

  // 反编造门：no_safe_match 必须真有 search_source 证据
  const traceTools = traceBus.peek(runKey, 512).map(e => e.tool)
  const hasSearchEvidence = traceTools.includes('search_source')

  // 按桶回写（按文件粒度）
  const now2 = Date.now()

  // ── 装盘成功（R24 + D6 + D8）──────────────────────────────────────────────
  // 🔴 这里曾是本项目正在生产环境造数据损坏的那个 bug（实测复现：listSubtitleQueue 捞到 0 个
  // 作品）。旧实现是一条
  //     UPDATE files SET needs_subtitle = 0, sub_status = 'covered' ...
  // 两列**同时**写错，叠加成一条永久卡死链（C27）：
  //   ① 装盘 → needs_subtitle=0 + sub_status='covered'
  //   ② 下一轮扫描发现字幕其实没落地（worker 声称成功但文件没写成）或用户手删 →
  //      R24 让扫描把 sub_status 回退 NULL（这部分已实现）
  //   ③ 但 needs_subtitle=0 留着 → 既不满足 judge 谓词 `needs_subtitle IS NULL`（不会重判）、
  //      又不满足字幕工作台谓词 `needs_subtitle=1`（不会排它）
  //   ④ → **这一集再也不会被补字幕**，而界面上什么异常都看不出来。
  // 第 2 步让 daemonV2 上生产后，每一次成功装盘都在造一个这样的潜在卡死行。
  //
  // 正确的三件事：
  //  · **不写 covered**（R24）：covered 是"扫描确认磁盘上真有同名中字"这个**事实观察**，
  //    不是 worker 的成功报告。worker 只负责把文件放到磁盘上，磁盘上有没有由扫描说了算。
  //  · **不改 needs_subtitle**（D8）：它只表达"这资源原则上需要中文字幕"（语言事实），
  //    装盘不改变这个事实。一个磁盘事实只许有一个投影列。
  //  · **只写 recheck_after 出队**（D6）：R24 删掉 covered 写入后若无出队凭据，该行仍满足
  //    工作台谓词 → daemonV2 阶段 3 的 while 下一圈重选同一活 → 跑完整 agent session →
  //    一直烧到下次扫描（C26 付费 LLM 热循环）。
  //
  // **不走 bump()**：装盘成功不是失败，不许递增 sub_attempt 吃掉 7 次额度——否则一个"每次都
  // 装盘成功但字幕总没落地"的文件会在 7 轮后被判进停牌，而它一次都没"找不到"过。
  const markInstalled = db.prepare('UPDATE files SET recheck_after = ?, updated_at = ? WHERE path = ?')

  const coveredPaths = new Set<string>()
  for (const inst of report.installed) {
    // 归属反解按 path（C15）：电影与剧集同轨，不再有"只认 /sNeM"的正则。
    const p = resolvePath(item, inst.itemId, inst.installedPath)
    if (p) coveredPaths.add(p)
  }
  for (const f of item.files) {
    if (coveredPaths.has(f.path)) {
      markInstalled.run(now2 + DAY_MS, now2, f.path)
    }
  }

  // ── no_safe_match：「搜过确实没有」──────────────────────────────────────────
  // 🔴 R17：这条是**最常见的失败路径**。旧实现在"有搜索证据"时写 `sub_status='unavailable'`
  // 且**不递增计数** → 该行既不在字幕工作台（sub_status 非 NULL）、又永攒不到 7 次 →
  // **翻译流永远收不到活**（C15，spec 点名"最致命的一条"）。
  // 现在两条支路都走同一个 bump()：sub_status 保持 NULL + sub_attempt+1 + 退避明天，
  // 与其他失败路径同轨。第五态 `unavailable` 就此绝迹（存量行已由 v33 迁移洗成 NULL）。
  //
  // 反编造门保留（零 search_source 证据 = agent 在编造），但它现在**只影响 last_error 的
  // 叙事与告警**，不再影响状态与计数——编造与真没找到都是"这一轮没拿到字幕"，
  // 都该计数+退避。旧实现让编造反而"不计数"，等于奖励撂挑子（违背 R9）。
  const noSafePaths = new Set<string>()
  for (const nsm of report.no_safe_match) {
    const p = resolvePath(item, nsm.itemId)
    if (p) noSafePaths.add(p)
  }
  if (report.no_safe_match.length > 0) {
    const reason = hasSearchEvidence ? 'no-match' : 'fabricated-no-match'
    for (const f of item.files) {
      if (noSafePaths.has(f.path)) bump(f, reason)
    }
    if (!hasSearchEvidence) {
      console.error(`[subtitle-scheduler] ${item.title}: no_safe_match 但 trace 零 search_source —— 编造`)
    }
  }

  // retry_later：与其他失败同轨（限流/配额等瞬时故障，巡检模型下一样是等明天）
  for (const rl of report.retry_later) {
    const p = resolvePath(item, rl.itemId)
    if (!p) continue
    const f = item.files.find(x => x.path === p)
    if (f) bump(f, 'retry-later')
  }

  // B-2：无结局文件（不在任何桶）→ 回写退避，不能残留 needs=1 让它同轮被重选。
  // 归属判断直接用上面三个桶反解出的 path 集合（而不是再拼一遍 itemId 去比对）——
  // 反解已经统一到 resolvePath 这一处，这里再拼一份就又引入了电影/剧集不对称的机会。
  const retryPaths = new Set<string>()
  for (const rl of report.retry_later) {
    const p = resolvePath(item, rl.itemId)
    if (p) retryPaths.add(p)
  }
  for (const f of item.files) {
    const inAnyBucket = coveredPaths.has(f.path) || noSafePaths.has(f.path) || retryPaths.has(f.path)
    if (!inAnyBucket) bump(f, 'no-outcome')
  }

  const coveredCount = coveredPaths.size
  if (coveredCount > 0) {
    // 措辞刻意不是 "marked covered"：这一轮我们只是把文件放到了磁盘上并出队，
    // **covered 由下一次扫描确认**（R24）。日志说"已覆盖"会误导排障的人以为状态已经变了。
    console.error(`[subtitle-scheduler] installed ${coveredCount}/${item.files.length} sidecars for ${item.title}（等扫描确认 / R24）`)
  }
  return report
}

