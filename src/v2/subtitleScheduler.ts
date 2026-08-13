// src/v2/subtitleScheduler.ts：字幕调度器（新架构阶段 4）。
// 职责：从 files 表挑"需要字幕的一簇"（一个作品）→ 组装 FindSubtitleTask → 调字幕 worker。
//
// 字幕 agent 的输入（用户裁决）：一个作品的全部 needs_subtitle 文件。
// 它不需要看目录树、不需要判断身份、不需要管字幕放哪——系统 harness 它。
import type { ScoutDb } from './db.js'
import type { FindSubtitleTask, FindSubtitleTargetFact } from '../agent/findSubtitleWorker.schemas.js'
// 2026-08-13 清理：这里原有 `import type { LanguageModel } from 'ai'` 与
// `import { makeFindSubtitleWorker } from '../agent/findSubtitleWorker.js'`，两个都零调用。
// 本文件**不组装 worker**：`runSubtitleWorkDir` 的第二参就是已经造好的 worker
// （`(task) => Promise<FindSubtitleBatchReport>`），由 cmdWatch 在 holder 代际里
// 统一 makeFindSubtitleWorker 一次、整轮巡检复用（见 cli/index.ts 的 subtitleWorkerV2：
// "一轮巡检会连着跑几十个作品，每个作品重建一整套 provider adapters 纯属白付"）。
// 调度器拿 model 自己造 worker 会正面违反那条口径，故这两个 import 不该复活——
// 需要换 worker 实现时改的是注入点，不是这里。
import { traceBus } from '../core/traceBus.js'
import { clusterDueNow, clusterEarliestRetryAt } from './backoffCluster.js'
import { recordFound } from './notificationsRepo.js'

export interface SubtitleQueueItem {
  workId: string
  title: string
  originalTitle: string | null
  year: number | null
  overview: string | null
  chineseTitles: string[]
  mediaType: string
  files: Array<{
    path: string; filename: string; season: number | null; episode: number | null
    dir: string; durationSec: number | null; embeddedLangs: string[] | null
    /** `files.recheck_after` 原值。NULL = 不在退避窗里（现在就能取）。
     *
     *  🔴 只有 `includeBackoff: true` 的调用方**可能**看到未来时刻——默认调用（daemon 派活）
     *  下这一列必然满足 `IS NULL OR <= now`，因为 SQL 已经把不满足的行滤掉了。
     *  它存在的唯一理由是让**界面**能说出"最早什么时候重试"，而那句话在默认模式下问不出来
     *  （默认模式看不见那些行）。派活侧不读它，读了也没意义。 */
    recheckAfter: number | null
  }>
}

/** `listSubtitleQueue` 的取件谓词——**全仓唯一一份**（C30：两份判据必漂移）。
 *
 *  ── 为什么第三条要参数化，而不是分裂出第二个函数 ────────────────────────────
 *  前两条（`needs_subtitle = 1` / `sub_status IS NULL`）回答的是「这个文件**在不在**
 *  字幕工作台上」——这是一个与时间无关的归属事实，daemon 与界面的答案必须字节一致。
 *  第三条（`recheck_after` 退避窗）回答的是「**现在**该不该动它」——这是调度问题，
 *  两个调用方要的答案本来就不同：
 *    · daemon 问「现在该取哪件」→ 退避中的**该滤**（不滤就是 C26 付费 LLM 热循环）
 *    · 界面问「还有什么在等」  → 退避中的**不该滤**（滤了就是"已排队 0 / 没有排队的作品"，
 *      而库里 33 个文件正在等——生产实测 2026-08-13，全部在退避窗，最早约 16h 后到点）
 *
 *  🔴 参数化而不是复制：三条 WHERE 仍然只有这**一份**文本，`includeBackoff` 只是把第三条
 *  短路掉。有人改前两条时，两个调用方**同时**跟着变，不可能漂移。若改成"界面自己写一份
 *  两条的 WHERE"，那正是 activityApi 头注释禁的那件事，且漂移形态是界面把 covered /
 *  停牌两态的行也算成"在等"——用户看到的队列比 daemon 会跑的长，还是一句假话。 */
const SUBTITLE_QUEUE_WHERE = `
      f.needs_subtitle = 1
      AND f.sub_status IS NULL
      AND (? = 1 OR f.recheck_after IS NULL OR f.recheck_after <= ?)`

/** `listSubtitleQueue` 的可选行为。 */
export interface SubtitleQueueOpts {
  /** true = 连**退避窗未到**的行一起返回（界面用："还有什么在等"）。
   *  默认 false = daemon 的取件语义（"现在该取哪件"）。
   *
   *  🔴 daemon 侧**绝不许**传 true：那会让退避中的文件当轮就被重选，
   *  即 C26 的付费 LLM 热循环。这条由 subtitleScheduler.test.ts 的守卫用例钉着。 */
  includeBackoff?: boolean
}

/** 这一项现在**会不会被 daemon 取走**（至少一个文件到点）。
 *
 *  判据本身（`.some()` 而不是 `.every()`，以及与 earliestRetryAt 的同向收口）住在
 *  `backoffCluster.ts`——**两个工作台共用那一份**。2026-08-14 翻译台补同型的洞时，
 *  照抄一份到那边就意味着以后有人改判据只改得到一处，两个 tab 静默劈叉（C30）。
 *  这里只负责把字幕轨自己的那一列（`files.recheck_after`）喂进去。
 *
 *  默认模式下恒 true（SQL 已滤）；`includeBackoff` 模式下才有信息量。
 *  界面拿它区分"33 个在等，其中 0 个会动"与"33 个在等、daemon 却没动"
 *  ——**这两件事对用户的含义完全相反**，共用一句"已排队 33"就是把它们混成半真的话。 */
export function queueItemDueNow(item: SubtitleQueueItem, now: number): boolean {
  return clusterDueNow(item.files.map((f) => f.recheckAfter), now)
}

/** 这一簇里**最早**的重试时刻；只要有任一文件已到点（即 `queueItemDueNow` 为真）→ null。
 *  判据同上，住在 backoffCluster.ts。 */
export function queueItemEarliestRetryAt(item: SubtitleQueueItem, now: number): number | null {
  return clusterEarliestRetryAt(item.files.map((f) => f.recheckAfter), now)
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
 *  （如 115 测试目录），只读挂载上建 staging 沙盒会 ENOENT。
 *
 *  ── `opts.includeBackoff`（2026-08-13）───────────────────────────────────────
 *  第三条（退避窗）现在可短路，谓词文本仍只有 `SUBTITLE_QUEUE_WHERE` 那一份。
 *  完整论证在那个常量上方。**daemon 侧不传**（默认 false = 原语义，一字未改）。 */
export function listSubtitleQueue(
  db: ScoutDb, roots?: string[], now = Date.now(), opts: SubtitleQueueOpts = {},
): SubtitleQueueItem[] {
  const includeBackoff = opts.includeBackoff === true
  const rows = db.prepare(`
    SELECT w.id AS work_id, w.title, w.original_title, w.year, w.overview, w.chinese_titles, w.media_type,
           f.path, f.filename, f.season, f.episode, f.dir, f.duration_sec, f.embedded_langs, f.recheck_after
    FROM files f JOIN works w ON f.work_id = w.id
    WHERE ${SUBTITLE_QUEUE_WHERE}
    ORDER BY w.id, f.season, f.episode
  `).all(includeBackoff ? 1 : 0, now) as Array<{
    work_id: string; title: string; original_title: string | null; year: number | null;
    overview: string | null; chinese_titles: string | null; media_type: string;
    path: string; filename: string; season: number | null; episode: number | null; dir: string
    duration_sec: number | null; embedded_langs: string | null; recheck_after: number | null
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
    item.files.push({ path: r.path, filename: r.filename, season: r.season, episode: r.episode, dir: r.dir, durationSec: r.duration_sec, embeddedLangs: langs, recheckAfter: r.recheck_after })
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

/** 连续多少轮"源站拒绝回答"（retry_later）折算成一次真实尝试。
 *
 *  量级含义：巡检模型下字幕流**每天跑一次**（M-1，全部退避都是"明天"），所以这个数字读作
 *  「**连续 3 天源站一次都没答上话**」。它不是一个调参出来的魔数，而是"偶发限流"与
 *  "provider 挂了"之间的分界线，两侧各有一个具体的失效形态：
 *
 *   · 取太小（比如 1，即等于不豁免）→ 就是本步在修的那个 bug 本身：撞限流 7 天攒满 7 次 →
 *     移交翻译流/判 unsolvable，而字幕一直在源站上（Peacemaker 实案）。
 *   · 取太大（比如 30）→ provider 永久挂掉（API key 失效、站点关站）的文件要 30×7=210 天
 *     才攒满 7 次额度进翻译流。这半年里它每天烧一次付费 LLM session 而必然失败，
 *     且 UI 上看不出任何异常。
 *
 *  为什么落在 3 而不是 2 或 7：
 *   · **≥3 才排得掉真实的限流周期**。免费档配额普遍按日重置（skill 里点名的"free daily
 *     download allowance, often with a reset time"），而日重置窗口与我们的日巡检**不同相位**——
 *     巡检恰好每天都落在配额已耗尽的时段是完全正常的，连续 2 天并不能区分"我们每天都来晚了"
 *     与"provider 挂了"。3 天是第一个让"每次都恰好撞上"变得不太可能的值。
 *   · **不取 7**：7 已经是 R10 那个额度本身的量级，`7×7=49 天`才移交一次。而且 7 会与
 *     HANDOFF_THRESHOLD 在读代码时混成同一个概念（"到底哪个 7 是哪个"），
 *     两个语义无关的量必须取不同的值，这是可读性上的刚性要求。
 *   · 折算后的长期行为：真挂了的 provider → 每 3 天记一次额度 → **21 天后移交翻译流**。
 *     三周是"用户还没来投诉、但系统已经自己认输"的合理量级，且远小于 R25 的周频复查节奏。
 *
 *  这个数字**只影响折算速度，不影响正确性**：任何 ≥2 的取值都同时满足两条红线
 *  （限流不吃额度 / 长期挂掉仍会移交），改它是安全的。 */
export const RETRY_LATER_STREAK_CAP = 3

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

  /** 一次失败的回写。**两种失败在语义上不同一档**，由 `outcome` 参数（而不是 reason 字符串）
   *  分流——见该参数的论证。
   *
   *  ── `'attempted'`（默认）= 真实尝试过、确实没拿到 ─────────────────────────────
   *  sub_attempt+1 + 退避，满 7 次则按 translatable 分流停牌。
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
   *  再也进不了停牌 → 每天被字幕流重选一次（而非每周），成本回到 D15 想避免的量级。
   *
   *  ── `'unanswered'` = 源站拒绝回答（retry_later）─────────────────────────────
   *  **不递增 sub_attempt**，只递增 sub_retry_streak + 退避；streak 满 CAP 时折算一次
   *  sub_attempt 并把 streak 归零（此时同样按 translatable 分流，与真实失败一条 UPDATE）。
   *
   *  为什么必须豁免（第 5 步下游，R9/R10 的语义修正）：`sub_attempt` 的含义是"真实尝试过、
   *  **确实找不到**的次数"，R10 的"满 7 次移交翻译"整个建立在这个含义上。而 retry_later 是
   *  "**问都没问到**"——429 / 配额耗尽 / 5xx / key 被拒时源站拒绝回答，它没有产生任何关于
   *  "这个字幕存不存在"的信息。把它计入额度是语义错误，且有实案（Peacemaker）：撞限流 7 天
   *  → 攒满 7 次 → 移交翻译流或判 unsolvable 停牌，**而那个字幕一直在源站上**。第 5 步把
   *  skill 改对（撞限流报 retry_later 而不是误报 no_safe_match）之后，这个洞不补则 prompt
   *  改了也白改。v1 轨的口径一直是对的（findSubtitleWorkerTask.ts 注释：retry_later 走
   *  "completeError 的短退避节流轨，R-10 豁免，永不 dormant"），是新架构漏消费了这个区分。
   *
   *  为什么豁免必须**配上限**而不是无条件：provider 长期挂掉（API key 永久失效、站点关站）
   *  的文件会永远攒不到 7 次 → **永不进翻译流** → 永远躺在字幕工作台里每天烧一次付费
   *  session，UI 上毫无异常。那是把一个永久卡死换成另一种形状的永久卡死。
   *
   *  ── 为什么分流靠 `outcome` 参数而不是匹配 reason 字符串 ────────────────────────
   *  reason 是给人看的叙事（'quota' / 'timeout' / `String(e).slice(0,100)` 的任意错误文本），
   *  它的取值集合**不封闭**：catch-all 那条会把 provider SDK 抛出的任意 message 塞进来，
   *  而那些 message 里完全可能出现 'retry' / 'rate limit' 字样（限流在别的层被抛成异常时
   *  正是这个形状）。靠 `reason === 'retry-later'` 判分支，则任何人改一次日志措辞就静默把
   *  豁免弄丢（或反过来把一个真实超时误判成豁免）；而 `outcome` 是**联合类型**，
   *  漏传/拼错在 tsc 就红，新增一个失败桶时编译器会强迫调用者表态走哪一档。 */
  const bump = (
    f: SubtitleQueueItem['files'][number],
    reason: string,
    /** 这一次失败**是否产生了关于"字幕是否存在"的信息**。这是全部判据，不是叙事标签。 */
    outcome: 'attempted' | 'unanswered' = 'attempted',
  ) => {
    const row = db.prepare('SELECT sub_attempt, sub_retry_streak, translatable FROM files WHERE path = ?')
      .get(f.path) as { sub_attempt: number; sub_retry_streak: number; translatable: number | null } | undefined
    const prevAttempt = row?.sub_attempt ?? 0
    const prevStreak = row?.sub_retry_streak ?? 0
    const translatable = row?.translatable ?? null

    // 折算判定：只有 unanswered 这一档会攒 streak；攒满即折算一次额度并归零。
    const streakNow = outcome === 'unanswered' ? prevStreak + 1 : 0
    const redeem = outcome === 'unanswered' && streakNow >= RETRY_LATER_STREAK_CAP
    // 额度只在两种情况下涨：真实尝试，或折算。
    const attempt = outcome === 'attempted' || redeem ? prevAttempt + 1 : prevAttempt
    // 归零的两个来源合成一条：① 折算后重新计数（不归零则下一轮立刻又满上限 → 折算退化成
    // 每轮都折算 = 完全没有豁免）；② **任何非 unanswered 的结局**——源站已经能回答了，
    // 之前那串"问不到"不再是连续的。漏掉 ② 的形态：几个月里零散撞过几次限流的文件慢慢攒到
    // 上限，凭一堆互不相关的瞬时故障折算出一次"真实尝试"，而它每次都被正常回答过。
    const streak = redeem ? 0 : streakNow

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
    //
    // 折算那一轮同样走这条分流（而不是"折算只加计数、分流留给下一轮"）：分两轮的话进程
    // 在两轮之间被杀会留下"计数已到 7、状态还是 NULL"的行，白吃一次额度——与上面 D15/C40
    // 那段是同一个论证，故两档失败共用这一条判定，不为折算另开一条路径。
    if (attempt >= HANDOFF_THRESHOLD && translatable !== null) {
      // translatable=1 → 归翻译流；=0 → 不可救，不给第 8 次机会（R21：O(1) 可判的终局不该
      // 塞在 7 天延迟之后，更不该让翻译流领走一个 100ms 就判 unsupported 的活）。
      const parked = translatable === 1 ? 'handoff_translate' : 'unsolvable'
      // recheck_after=+7天：供阶段 2.6 停牌复查闸取件（D13/R25「每周找一次」）。
      // 若照失败轨写"明天"，复查会退化成日频；不写则停在上一次失败的"明天"，同样日频。
      db.prepare('UPDATE files SET sub_attempt = ?, sub_retry_streak = ?, sub_status = ?, recheck_after = ?, last_error = ?, updated_at = ? WHERE path = ?')
        .run(attempt, streak, parked, now + PARK_RECHECK_MS, tagged, now, f.path)
      return
    }
    // sub_status **一列不动**（保持 NULL）：R17 废止了第五态 `unavailable`——"搜过确实没有"
    // 是普通失败，与其他失败路径同轨。写任何非 NULL 值都会让该行既不在字幕工作台
    // （谓词 `sub_status IS NULL`）、又攒不到 7 次 → 永久出局（C15）。
    //
    // 退避对两档失败都写"明天"（巡检模型 / M-1）：豁免的是**计数**，不是**出队**。
    // 不写退避就是 C26 的付费 LLM 热循环——daemonV2 阶段 3 的 while 下一圈重选同一个作品，
    // 撞着同一个限流反复烧 session。
    db.prepare('UPDATE files SET sub_attempt = ?, sub_retry_streak = ?, recheck_after = ?, last_error = ?, updated_at = ? WHERE path = ?')
      .run(attempt, streak, now + DAY_MS, tagged, now, f.path)
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
  //
  // 但**必须归零 sub_retry_streak**（第 5 步下游）：streak 的语义是"**连续**几轮源站拒绝
  // 回答"，而装盘成功恰是源站不但答了、还给了字幕的最强证据。因为这条路径刻意绕开 bump()，
  // bump 内部那条归零管不到它，只能在这里再写一遍。漏掉的形态：一个"平时装盘成功、偶尔撞
  // 限流"的文件把 streak 一直攒着，最终折算出一次凭空的"真实尝试"额度。
  //
  // 🔴🔴 并且**必须把 sub_recheck_at 拉到"立即到点"**（第 8 步 live test 第五轮实测缺陷）。
  // spec 有 D12/D16/D18 三条裁决管两档调度，却没有任何一条说"worker 刚把字幕放到磁盘上之后，
  // 谁负责立刻观察它"——装盘与观察之间断了一截。刚装了字幕的文件**两档都不在**：
  //   · A 档 = 本轮新增/指纹变化 → 装 sidecar **不改视频文件的 mtime/size** → 指纹没变，不命中
  //   · B 档 = `sub_recheck_at <= now` → 上一轮 A 档检测时已推到 now+7 天 → 不命中
  // 生产实测（第五轮巡检）：sub_recheck_at 未来|61（最早=最晚=08-17，now=08-10）、
  // sub_status (null)|61、而磁盘上实际字幕数 35。两条后果：
  //   ① 界面上这 35 个文件要连续 7 天显示"没有字幕"（用户看到的是假的）
  //   ② 更贵的那条：sub_status 仍为 NULL ⇒ 它们**仍满足 listSubtitleQueue 的谓词** ⇒
  //      下一轮巡检**再找一遍已经有字幕的文件**，白烧付费 LLM（35 文件 × 每轮 × 7 天）。
  //
  // 为什么这个修法不碰三条裁决的任何一条（这是选它而不是"让 worker 写 covered"的理由）：
  //  · **不违反 R24**：仍然只有扫描写 covered。这里表达的是"我改过这个文件旁边的磁盘内容，
  //    请优先复核"——是**复核排期**，不是**结论**。装错/装了个空文件/装了个 0 字节文件时
  //    （用户裁决原文点名的三种形态），扫描照旧观察不到 sidecar、照旧不写 covered。
  //  · **不违反 D12**：两档语义没动，没新增第三档，也没退化成"每轮全量"——被拉到立即到点的
  //    只有**本轮真装了盘的那几个文件**（逐文件粒度），不是全库。失败的桶一律不拉，
  //    否则找不到字幕的文件每轮白烧 60 次 stat（15 标签 × 4 扩展），那正是 D12 存在的理由。
  //  · **不违反 D18**：写的是一个具体数值，**不是 NULL**，谓词 `<= now` 能命中它。
  //
  // 哨兵取 **0** 而不是 `now - 1`（这是本修法唯一的非显然之处，取错就是静默失效）：
  // 这一列的唯一读者是 daemonV2 的 B 档谓词 `WHERE sub_recheck_at <= ?`，它喂的是
  // **`deps.now()`（可注入时钟）**，而这里用的是**真实 `Date.now()`**——两个时钟源不同源。
  // 注入 now=1_000_000_000_000（2001 年，daemonV2 测试的既有口径）时，`Date.now()-1` 写出来是
  // 2026 年，对读者而言是**未来 25 年** → 谓词永不命中 → 修了等于没修，而单元测试全绿
  // （单元测试用真实时钟）。0 在任何时钟源下都已过期，非 NULL，且**天然自清除**——
  // 下一轮 observeSubtitle 观察完就把它推回 now+7 天，不会粘成"每轮都进 B 档"。
  const IMMEDIATE_RECHECK = 0
  const markInstalled = db.prepare('UPDATE files SET sub_retry_streak = 0, recheck_after = ?, sub_recheck_at = ?, updated_at = ? WHERE path = ?')

  const coveredPaths = new Set<string>()
  for (const inst of report.installed) {
    // 归属反解按 path（C15）：电影与剧集同轨，不再有"只认 /sNeM"的正则。
    const p = resolvePath(item, inst.itemId, inst.installedPath)
    if (p) coveredPaths.add(p)
  }
  for (const f of item.files) {
    if (coveredPaths.has(f.path)) {
      markInstalled.run(now2 + DAY_MS, IMMEDIATE_RECHECK, now2, f.path)
      // ── R-F3：通知流水（通知页的持久化数据源）────────────────────────────────
      // 写入点与 SSE `found` 事件**同一口径**（daemonV2 在 runSubtitleWorkDir 返回后按
      // report.installed.length 发一条），但落点不同、缺一不可：SSE 只把新的推给正在看的人
      // （进程内环形缓冲 50 条、非持久），R-F3 要的"保留一周"必须落库——用户关着浏览器的
      // 那 23 小时里找到的字幕在缓冲里全部丢失，容器重启同样清零。论证见 notificationsRepo.ts。
      //
      // 为什么写在**这里**（逐文件、markInstalled 紧邻）而不是在 daemonV2 那条 emit 旁边：
      // 通知要的是**季集号**（"S01 的第 3/5/7 集"），而 daemonV2 那一层手里只有
      // report.installed.length 这个计数——它连哪几集都不知道。季集号取自 `f`（files 行的
      // 事实），**不从 installedPath 猜**：文件名解析在本仓是识别层的活，在这里再来一份
      // 正则就是第二份实现，两份漂移时没人知道该信哪个。
      //
      // recordFound 内部整体 try/catch（绝不抛错），故这里**不需要**再包一层——它与
      // ScoutEventBus.publish 是同一口径。但语义上这仍是"两道"：万一将来有人把 repo 里那层
      // catch 拿掉，notificationsWiring.test.ts 的「通知表被删也不许影响装盘回写」会立刻红。
      recordFound(db, {
        workId: item.workId, title: item.title,
        season: f.season, episode: f.episode, via: 'fetch',
      }, now2)
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

  // retry_later：**源站拒绝回答**（限流/配额耗尽/5xx/key 被拒）。走 bump 的 `'unanswered'`
  // 档——退避照写（明天），但**不吃 sub_attempt 额度**，只攒 sub_retry_streak；连续满
  // RETRY_LATER_STREAK_CAP 轮才折算一次额度。论证见 bump 头注释与该常量的注释。
  for (const rl of report.retry_later) {
    const p = resolvePath(item, rl.itemId)
    if (!p) continue
    const f = item.files.find(x => x.path === p)
    if (f) bump(f, 'retry-later', 'unanswered')
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
    // 补"已排下轮复核"：装盘与观察的衔接靠 sub_recheck_at 被拉到立即到点（见 markInstalled
    // 的论证）。不说这句的话，排障的人看到"等扫描确认"会以为要等 7 天——那正是本条修的缺陷。
    console.error(`[subtitle-scheduler] installed ${coveredCount}/${item.files.length} sidecars for ${item.title}（已排下轮复核，等扫描确认 / R24）`)
  }
  return report
}

