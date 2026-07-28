import { dirname, basename } from 'node:path'
import type { Job, JobsRepo } from './jobsRepo.js'
import type { LibraryRepo } from './libraryRepo.js'
import type { RunsRepo } from './runsRepo.js'
import { traceBus } from '../core/traceBus.js'
import type { TmdbClient, TmdbDetails } from '../adapters/providers/tmdb.js'
import { isDirWritable, isUnderRoots, containingRoot } from '../core/mediaContext.js'
import { candidateKey, type SubtitleCandidate } from '../core/schemas.js'
import type { FindSubtitleTask, FindSubtitleBatchReport } from '../agent/findSubtitleWorker.schemas.js'
import { resolveAbsoluteTable, absoluteFor } from '../agent/absoluteEpisodes.js'
import { tmdbIdFromOwnId } from './ownIds.js'

/** runs.detail is a human-readable summary the dashboard shows directly (src/v2/runsRepo.ts) —
 *  trim/cap so a raw agent reason or thrown error message (which can run long) doesn't blow out
 *  the timeline UI. Exported (Task 12): the unidentified-scope runner (cli/unidentifiedFindSubtitle.ts)
 *  shares the same dashboard-detail discipline. */
export function capDetail(s: string, max = 200): string {
  const trimmed = s.trim()
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed
}

// R-11（用户裁决 2026-07-16）：seasons 承载主代理裁量后的派活范围——数组=季子集，null=全剧
// （有缺口的季全部覆盖），可选键缺席=存量行（v11 迁移前写入，season 身份列有值）按旧语义单季
// 推导。三态而非二态：`undefined`（键缺席）与显式 `null` 携带不同语义，故字段类型必须允许两者
// 都出现，不能用 `?: number[] | null` 简化成默认值——mapper 靠 `'seasons' in payload` 之外的
// JSON.parse 后 `payload.seasons !== undefined` 检测来区分（见下方 mapWorkerTaskToFindSubtitleTask）。
// F-R2-4（R2 复审，审计定罪：停牌提前重派的管道缺失）：includeThrottled 承载 orchestrator 的
// "这次要不要连未到期的停牌行也一起重查"判断（dispatch_find_subtitle_task 的同名参数写下来
// 的落点）——省略键=false（既有窗口语义锁，见 mapWorkerTaskToFindSubtitleTask 的解析）。
export interface FindSubtitleWorkerTaskPayload {
  taskType: 'find_subtitle'
  reason: string
  seasons?: number[] | null
  includeThrottled?: boolean
  /** Task 12（agent-first 识别主链路）：'unidentified' = 目标不是库行（已识别条目），而是
   *  parked_paths 里的未识别文件——CLI 的 find_subtitle 分支据此改走
   *  cli/unidentifiedFindSubtitle.ts（从 parked_paths 读 raw data 建 targets，worker 挂
   *  write_identified_media 让 agent 自己识别写库）。缺席/其它值 = 既有库行缺口语义。 */
  scope?: 'unidentified'
}

/** Deps needed to turn a claimed `worker_task` row (payload.taskType==='find_subtitle') into a
 *  concrete FindSubtitleTask. 去 Jellyfin 化 P4: this used to round-trip through a live Jellyfin
 *  item (deps.jf.getItem) and buildMediaContext (core/mediaContext.ts) to assemble the task; both
 *  are gone. episodes.path/movies.path are ALREADY local filesystem paths (T3's ingest layer walks
 *  the filesystem directly — no Jellyfin path remapping was ever needed for these rows, so no
 *  mapPath() call here either), and every other field (title/original_title/year/chinese
 *  titles/overview/runtime/provider_ids) comes straight off the series/movie library row plus a
 *  live TmdbClient.getDetails/getChineseTitles enrichment call keyed by tmdbIdFromOwnId(row.id) —
 *  see src/v2/ownIds.ts for why that extraction is a pure, zero-I/O string parse now that the row's
 *  own id IS its TMDB identity.
 *
 *  2026-07-16 架构事故修复：这个 mapper 曾经藏着 representativeEpisodeId()——一条
 *  `ORDER BY episode ASC LIMIT 1` 的私有查询，把主代理本该整季派发的一批缺口机械降解成
 *  "只查一集"的单集指令，注释还抄自旧管线，是本次事故的直接病灶。representativeEpisodeId /
 *  representativeMovieId 已处决。mapper 现在是纯信使：零目标选择、零顺序决策——季级缺口
 *  事实清单由 LibraryRepo.listMissingEpisodesInSeason 产出（ORDER BY episode 只是清单排序，
 *  不是执行顺序指令），mapper 只负责把整批事实清单原样装进一个 FindSubtitleTask.targets
 *  数组，连同该批目标共同的展示元数据（title/originalTitle/alternativeTitles/overview/…）
 *  一次性上车；哪个目标先处理、跳过哪个、算不算完成，通通是 worker/orchestrator 的判断，
 *  不是这层的活。 */
export interface FindSubtitleTaskMapperDeps {
  lib: LibraryRepo
  /** null when TMDB_API_KEY isn't configured — getDetails/getChineseTitles enrichment is a
   *  gain-path: originalTitle/overview/runtimeMinutes/chinese alternative titles/absoluteEpisode
   *  all degrade to null/[] rather than failing the mapping. */
  tmdb: TmdbClient | null
  /** CRIT#1 (mirrors makeRunEpisode's opts.mediaRoots / realignExecutor's deps.mediaRoots):
   *  configured MEDIA_ROOTS/MEDIA_PATH_MAPPINGS whitelist — the OUTER sandbox boundary an admin
   *  configures. Distinct from FindSubtitleTask.mediaRoot, the tighter INNER per-task sandbox
   *  (this episode/movie's own containing directory) makeFindSubtitleWorker enforces on the agent
   *  itself ("each worker gets ONLY its series' media dir", phase ⑦ instructions). */
  mediaRoots: string[]
  /** A4 (spec-review fix #1): the PRIMARY configured target subtitle language. R2D-12 (R2 复审,
   *  stale-comment fix): cli/index.ts wires
   *  `resolveTargetLanguages(process.env, settingsRepo.get('target_languages')).targetLanguages[0]`
   *  — the old one-arg mention here predates dashboard G4's behavior-level settings override
   *  (settings.target_languages takes precedence over the deploy-layer TARGET_LANGUAGES env; see
   *  resolveTargetLanguages's own second-arg doc comment). FindSubtitleTask.targetLanguage is
   *  single-valued, so a multi-language TARGET_LANGUAGES config tasks only its first entry;
   *  per-item multi-language tasking is future work (the per-item coverage model — one sub_status
   *  per item — can't express "covered for zh but missing for en" yet). Optional/defaulted to
   *  'zh' (the historical default) so existing tests/callers predating the config keep working. */
  targetLanguage?: string
  /** 救援R5：hardsub_mode，同 targetLanguage 的既有先例——mapper 直接透传进 FindSubtitleTask，
   *  真正的"每次派发新鲜读 settings"发生在 cli/index.ts 的派发覆写处（见该文件注释）。 */
  hardsubMode?: 'off' | 'agent' | 'aggressive'
}

/** Parses series/movies.provider_ids (JSON, written by T3's ingest layer as `{"tmdb":"<id>"}` —
 *  see src/v2/ingest.ts) into the plain lowercase-keyed record FindSubtitleTask.providerIds
 *  expects (same lowercase-key convention the old buildMediaContext used for Jellyfin ProviderIds).
 *  NULL column / malformed JSON / non-object → {} (this field is prompt-display enrichment only,
 *  never a control-flow input — see findSubtitleWorker.ts's own use of it). */
function parseProviderIds(json: string | null): Record<string, string> {
  if (!json) return {}
  try {
    const parsed: unknown = JSON.parse(json)
    return parsed && typeof parsed === 'object' ? parsed as Record<string, string> : {}
  } catch {
    return {}
  }
}

/** Mirrors the old buildMediaContext's alternative_titles combination: TMDB's own official variants
 *  (getChineseTitles, an ordered list) first, the DB-cached single chinese_title appended last as a
 *  fallback source — de-duped and stripped of anything blank or equal to the primary title / TMDB
 *  original title (no point surfacing a "variant" that's actually the title already shown). */
function buildAlternativeTitles(
  tmdbChineseTitles: string[], cachedChineseTitle: string | null, title: string, originalTitle: string | null,
): string[] {
  return [...tmdbChineseTitles, cachedChineseTitle]
    .filter((t): t is string => !!t && t.trim().length > 0 && t !== title && t !== originalTitle)
    .filter((t, i, arr) => arr.indexOf(t) === i)
}

/** 重复源 P4：本地候选构造——对本任务的每个 itemId，若它是多文件条目（item_files 有副本）且
 *  覆盖不一致（partial：有文件已覆盖、有文件缺字幕），把每个已覆盖文件的现有字幕行转成一个
 *  provider:'local' 候选，前置注入 search_source 结果集（resultHandles.ts）。providerId 直接
 *  编码字幕文件的绝对路径（encodeURIComponent，避开路径里的特殊字符）——download_candidate 的
 *  本地分支解码回路径直接读盘，不需要额外的旁路查找表；path 恒在本任务的 mediaRoot 沙盒内
 *  （同一条目的文件天然同目录），download_candidate 侧仍会做 isUnderRoots 复核（defense in
 *  depth，同 install_subtitle 的既有先例）。单文件条目（没有副本）或全覆盖/全缺口（没有"该
 *  传播给谁"的缺口）都不产生候选——绝大多数任务这里是空数组，零额外查询开销。 */
function buildLocalCandidates(lib: LibraryRepo, itemIds: string[]): SubtitleCandidate[] {
  const out: SubtitleCandidate[] = []
  for (const itemId of itemIds) {
    const files = lib.itemFileCoverage(itemId)
    if (files.length <= 1) continue
    const hasCovered = files.some((f) => f.covered)
    const hasUncovered = files.some((f) => !f.covered)
    if (!hasCovered || !hasUncovered) continue
    for (const f of files.filter((f) => f.covered)) {
      for (const sub of lib.listSubtitlesForFile(itemId, f.path, f.isMain)) {
        out.push({
          provider: 'local',
          providerId: encodeURIComponent(sub.path),
          videoName: basename(f.path),
          nativeName: null,
          language: sub.language,
          subtype: null,
          releaseSite: null,
          fileList: [],
        })
      }
    }
  }
  return out
}

/** Concurrent, gain-path TMDB enrichment for one (mediaType, tmdbId) — both calls silently degrade
 *  (getDetails via .catch, getChineseTitles already swallows its own failures internally) so a TMDB
 *  outage or a non-conforming id (tmdbId null) never fails the mapping, only impoverishes the task. */
export async function fetchTmdbEnrichment(
  tmdb: TmdbClient | null, mediaType: 'tv' | 'movie', tmdbId: string | null,
): Promise<{ details: TmdbDetails | null; chineseTitles: string[] }> {
  if (!tmdb || !tmdbId) return { details: null, chineseTitles: [] }
  const [details, chineseTitles] = await Promise.all([
    tmdb.getDetails(mediaType, tmdbId).catch(() => null),
    tmdb.getChineseTitles(mediaType, tmdbId).catch(() => []),
  ])
  return { details, chineseTitles }
}

/** OUTER (MEDIA_ROOTS) 沙盒边界检查 + 写权限探测，两连 throw——processed 前的既有防线，从
 *  movie/series 两个分支各自的重复代码里抽出的模块内私有 helper。错误文案逐字保留：两条
 *  message 是既有测试锁（sandbox/unwritable 两类调用方都靠这段文案定位问题）。
 *  Exported (Task 12): the unidentified-scope runner applies the same gate to parked-path dirs. */
export function assertDirSafe(dir: string, roots: string[]): void {
  if (!isUnderRoots(dir, roots)) {
    throw new Error(`拒绝在媒体根目录之外写入: ${dir} — 检查 MEDIA_ROOTS 配置（或 dashboard 设置页的守备目录）`)
  }
  if (!isDirWritable(dir)) {
    throw new Error(`Media dir not writable: ${dir} — sidecar 无法写入，检查挂载读写权限（只读网盘/WebDAV?）`)
  }
}

/** H4（2026-07-18 数据安全审计——gcOrphans 盲区修复）：求 FindSubtitleTask.stagingRoot——
 *  deps.mediaRoots 里包含 dir（这批目标的收窄 INNER 沙盒根）的那一个配置根，供
 *  files/stagingSandbox.ts 的 allocate/cleanup 对齐（gcOrphans 只在配置根一级非递归扫描，见该
 *  文件 allocate 的头注释）。复用 core/mediaContext.ts 的 containingRoot（它的文档注释本就是为
 *  这个场景写的）而不是另起一个同类 helper。找不到匹配根（典型场景：deps.mediaRoots 为空——
 *  未配置 MEDIA_ROOTS 的开发态/测试态，此时 isUnderRoots 自己也把"空=不限制"当特例，containingRoot
 *  在这种输入下必然返回 null）——安全退化为 dir 本身并 console.error 告警：这批任务的 staging
 *  目录不再受 gcOrphans 保护，但不阻塞派发（宁可退化保护，不阻塞主流程）。
 *  Exported (Task 12): the unidentified-scope runner derives its stagingRoot identically. */
export function stagingRootFor(dir: string, roots: string[], jobId: number): string {
  const root = containingRoot(dir, roots)
  if (!root) {
    console.error(
      `[find-subtitle-worker-task] job ${jobId}: no configured mediaRoot contains ${dir} — ` +
        `this task's staging dir will not be swept by gcOrphans`,
    )
    return dir
  }
  return root
}

/** 全部目标目录的公共祖先（INNER 沙盒根推导）。目录相等视为 under（isUnderRoots 既有语义）——
 *  同季目标通常共享同一 Season 目录，一步命中；只有磁盘布局不规范（同季文件散落多个子目录）
 *  时才需要真的逐级上探。Exported (Task 12): the unidentified-scope runner derives the INNER
 *  sandbox root from its parked targets' dirs with the same rule. */
export function commonDir(dirs: string[]): string {
  let candidate = dirs[0]
  while (!dirs.every((d) => isUnderRoots(d, [candidate]))) {
    const parent = dirname(candidate)
    if (parent === candidate) break
    candidate = parent
  }
  return candidate
}

/** Maps a claimed worker_task row to a batch FindSubtitleTask, or null if there is nothing left
 *  to do (every target in the season/movie was already covered by the time this row got claimed
 *  — idempotent no-op, caller completes the job done without ever invoking the worker). Throws on
 *  a genuinely bad/unsafe wiring (library row vanished between claim and mapping, a target's video
 *  dir outside the configured MEDIA_ROOTS, unwritable dir) — callers (runFindSubtitleWorkerTask
 *  below) must treat a throw here the same as a thrown worker invocation: completeError, never
 *  crash the daemon.
 *
 *  2026-07-16 事故修复：this function used to pick ONE representative episode/movie id
 *  (representativeEpisodeId, now deleted — see the file-header note above) and hand the worker a
 *  single-episode task. It now hands over every still-open target in one shot: itemId travels
 *  inside each FindSubtitleTargetFact (task.targets), not as a separate side-channel return value
 *  — the messenger doesn't get to carry a second, undisclosed envelope. */
export async function mapWorkerTaskToFindSubtitleTask(
  job: Job, deps: FindSubtitleTaskMapperDeps, now: number,
): Promise<FindSubtitleTask | null> {
  // F-R2-4（R2 复审，审计定罪：停牌提前重派的管道缺失）：payload 现在提前到两个分支之前统一
  // 解析一次——movie 分支的 stillMissing 判断与 series 分支的 listMissingEpisodesForSeries 调用
  // 都要读 includeThrottled，此前只有 series 分支解析 payload（movie 分支从不看它）。省略键/
  // 非布尔值一律折叠为 false（既有窗口语义锁，不因新字段解析失败而意外放宽）。
  const payload = (() => {
    try {
      return JSON.parse(job.payload ?? '{}') as { seasons?: number[] | null; includeThrottled?: boolean }
    } catch {
      return {} as { seasons?: number[] | null; includeThrottled?: boolean }
    }
  })()
  const includeThrottled = payload.includeThrottled === true

  // ---- movie 分支：单目标批量任务（movies 没有"季"概念，天然只有一个目标） ----
  if (job.movie_id) {
    const movie = deps.lib.getMovie(job.movie_id)
    if (!movie) return null
    const stillMissing =
      movie.sub_status === 'missing' ||
      (movie.sub_status === 'unavailable' && (includeThrottled || (movie.recheck_after ?? 0) <= now))
    if (!stillMissing) return null

    const dir = dirname(movie.path)
    assertDirSafe(dir, deps.mediaRoots)

    const tmdbId = tmdbIdFromOwnId(movie.id)
    const { details, chineseTitles } = await fetchTmdbEnrichment(deps.tmdb, 'movie', tmdbId)
    const originalTitle = details?.originalTitle ?? null
    const providerIds = parseProviderIds(movie.provider_ids)

    return {
      jobId: String(job.id),
      mediaRoot: dir,
      stagingRoot: stagingRootFor(dir, deps.mediaRoots, job.id),
      title: movie.name,
      originalTitle,
      year: movie.year ?? details?.year ?? null,
      alternativeTitles: buildAlternativeTitles(chineseTitles, movie.chinese_title, movie.name, originalTitle),
      overview: details?.overview ?? null,
      runtimeMinutes: details?.runtimeMinutes ?? null,
      providerIds,
      // A4: the primary configured target language (see FindSubtitleTaskMapperDeps.targetLanguage);
      // multi-language per-item tasking is future work.
      targetLanguage: deps.targetLanguage ?? 'zh',
      hardsubMode: deps.hardsubMode ?? 'off',
      localCandidates: buildLocalCandidates(deps.lib, [movie.id]),
      targets: [{
        itemId: movie.id,
        videoPath: movie.path,
        videoFilename: basename(movie.path),
        season: null,
        episode: null,
        // Movies have neither season nor episode — absoluteEpisode is meaningless for this branch.
        absoluteEpisode: null,
        imdbId: providerIds.imdb ?? null,
        // 2026-07-18 事故修复（True Detective S02E08）：电影时长本就是单片级（不像剧集有
        // "剧级典型 vs 单集实际"的分裂）——details.runtimeMinutes 直接就是这部电影自己的
        // 实际时长，原样透传即正确，无需另开一条查询。
        runtimeMinutes: details?.runtimeMinutes ?? null,
        // Task 2（[tmdbid-N] 证据通道）：库行 scope 的 target 身份已定（itemId 非空），标签
        // 这条起点提示对它无意义；且事实来源是 parked_paths.embedded_tmdb_id，已识别的行没有
        // parked 行可读——恒 null，不从路径重算（不编造，同 imdbId 的既有纪律）。
        embeddedTmdbId: null,
      }],
    }
  }

  // ---- series 分支：LibraryRepo 产出的缺口事实清单整批上车，mapper 不做任何取舍 ----
  // R-11（用户裁决 2026-07-16，原文锚点：「到底按季还是按剧，是根据具体情况具体分析的」）：派活
  // 范围是主代理的判断，不是系统常量——payload.seasons 决定这批任务覆盖哪些季：数组=季子集，
  // null=全剧（有缺口的季全部覆盖），键缺席=存量行（v11 迁移前写入）按 job.season 单季推导
  // （原语义，向后兼容）。season 身份列对新 find_subtitle 行恒 NULL，故不再要求它非空。
  if (!job.series_id) {
    throw new Error(
      `worker_task job ${job.id} (find_subtitle) has neither movie_id nor series_id identity`,
    )
  }
  const gaps = payload.seasons !== undefined
    ? deps.lib.listMissingEpisodesForSeries(job.series_id, payload.seasons, now, includeThrottled)
    : deps.lib.listMissingEpisodesInSeason(job.series_id, job.season ?? -1, now)
  // idempotent no-op: 本行被 claim 时范围内已无缺口——含病态"season 列为 null 且 payload 无
  // seasons 字段"的存量行（listMissingEpisodesInSeason(seriesId, -1, now) 恒空，无害兜底）。
  if (gaps.length === 0) return null

  const series = deps.lib.getSeries(job.series_id)
  if (!series) throw new Error(`series row ${job.series_id} not found for job ${job.id}`)

  const dirs = gaps.map((g) => dirname(g.path))
  for (const dir of dirs) assertDirSafe(dir, deps.mediaRoots)
  const mediaRoot = commonDir(dirs)
  if (!isUnderRoots(mediaRoot, deps.mediaRoots)) {
    // 逐目标 assertDirSafe 已经过；这里再兜一层是防"目标分散在多个根各自都合规、但公共祖先
    // 越出了全部根"的边界情形（每个单独的 dir 检查无法拦住这种组合态）。
    throw new Error(`拒绝在媒体根目录之外写入: ${mediaRoot} — 检查 MEDIA_ROOTS 配置（或 dashboard 设置页的守备目录）`)
  }

  // tmdbId comes from the SERIES row's own id (episodes never carry the series' tmdb id
  // separately — the own id space nests episode ids under their series' id, see ownIds.ts).
  const tmdbId = tmdbIdFromOwnId(series.id)
  const { details, chineseTitles } = await fetchTmdbEnrichment(deps.tmdb, 'tv', tmdbId)
  const originalTitle = details?.originalTitle ?? null
  // 取表一次，逐集折算（resolveAbsoluteTable + absoluteFor）——不再是旧 resolveAbsoluteEpisode
  // 逐集各打一次 TMDB 往返（2N 次请求）。取不到表（tmdb 未配置/请求失败）→ 全部 null：
  // absoluteEpisode 是定位 hint 缺席不是 blocker，见 findSubtitleWorker.schemas.ts 的字段注释。
  const absTable = deps.tmdb && tmdbId ? await resolveAbsoluteTable(deps.tmdb, tmdbId) : null
  const providerIds = parseProviderIds(series.provider_ids)

  // 2026-07-18 事故修复（True Detective S02E08，根因见 findSubtitleWorker.schemas.ts 的
  // FindSubtitleTargetFact.runtimeMinutes 字段文档）：逐集实际时长——按 targets 涉及的
  // distinct season 一季一次调用 getSeasonEpisodeRuntimes（不逐集调，同 absTable 取表一次
  // 逐集折算的既有先例），取代 getDetails 的剧级"典型"单集时长。getSeasonEpisodeRuntimes 本身
  // 是增益路径（任何失败静默返回 null），这里 Map 缺席（tmdb 未配置/该季端点失败）即整季
  // 目标的 runtimeMinutes 全 null——绝不因此让整批任务构造失败。
  const seasonRuntimes = new Map<number, Map<number, number> | null>()
  if (deps.tmdb && tmdbId) {
    const seasons = [...new Set(gaps.map((g) => g.season))]
    await Promise.all(seasons.map(async (s) => {
      seasonRuntimes.set(s, await deps.tmdb!.getSeasonEpisodeRuntimes(tmdbId, s))
    }))
  }

  const targets = gaps.map((g) => ({
    itemId: g.id,
    videoPath: g.path,
    videoFilename: basename(g.path),
    season: g.season,
    episode: g.episode,
    absoluteEpisode: absTable ? absoluteFor(absTable, g.season, g.episode) : null,
    imdbId: providerIds.imdb ?? null,
    // 该集实际时长——区别于本函数返回值顶层 runtimeMinutes 的剧级典型值（见下方 return 的
    // 同名字段，那个保持现状作 fallback）。Map 缺席/该集不在 Map 里 → null。
    runtimeMinutes: seasonRuntimes.get(g.season)?.get(g.episode) ?? null,
    // Task 2：同 movie 分支——库行身份已定，标签起点提示无意义，恒 null（不从路径重算）。
    embeddedTmdbId: null,
  }))

  return {
    jobId: String(job.id),
    mediaRoot,
    stagingRoot: stagingRootFor(mediaRoot, deps.mediaRoots, job.id),
    title: series.name,
    originalTitle,
    year: series.year ?? details?.year ?? null,
    alternativeTitles: buildAlternativeTitles(chineseTitles, series.chinese_title, series.name, originalTitle),
    overview: details?.overview ?? null,
    runtimeMinutes: details?.runtimeMinutes ?? null,
    providerIds,
    // A4: the primary configured target language (see FindSubtitleTaskMapperDeps.targetLanguage);
    // multi-language per-item tasking is future work.
    targetLanguage: deps.targetLanguage ?? 'zh',
    hardsubMode: deps.hardsubMode ?? 'off',
    localCandidates: buildLocalCandidates(deps.lib, targets.map((t) => t.itemId)),
    // List order is fact-list order (gaps 已按 episode ASC，见 listMissingEpisodesInSeason),
    // not an execution-order instruction — see FindSubtitleTargetFact's own doc comment.
    targets,
  }
}

export interface FindSubtitleWorkerTaskDeps extends FindSubtitleTaskMapperDeps {
  /** The actual worker invocation — makeFindSubtitleWorker(...)'s returned runFindSubtitleTask in
   *  production; a plain vi.fn() in tests. Injected (not constructed in here) so this module's
   *  own tests never need a real LanguageModel/ToolLoopAgent — findSubtitleWorker.test.ts already
   *  covers the agent loop itself in full.
   *  批量收割重写（2026-07-16，R-3）：一次调用返回三桶批量报告（installed/no_safe_match/
   *  retry_later），不再是旧的单一 FindSubtitleDecision——见 findSubtitleWorker.schemas.ts 的
   *  FindSubtitleBatchReportSchema。 */
  runTask: (task: FindSubtitleTask) => Promise<FindSubtitleBatchReport>
  /** 退役T1 (W0-3a): optional so existing callers/tests keep compiling without threading it —
   *  when absent, runFindSubtitleWorkerTask silently skips writing a runs row (no throw). cmdWatch
   *  (src/cli/index.ts) wires the real RunsRepo it already constructs for the old pipeline; the
   *  v3 worker_task runners currently write NOTHING to `runs`, so the dashboard's run-history
   *  timeline (which reads that table) goes dark once the old pipeline is retired without this. */
  runs?: Pick<RunsRepo, 'insert'>
}

/** Claims-and-runs one worker_task row whose payload.taskType === 'find_subtitle' — the phase ③
 *  find-subtitle worker's counterpart to runRealignWorkerTask (phase ⑥, src/v2/realignWorkerTask.ts).
 *  Maps the row to a batch task, runs the worker once, and posts the resulting batch harvest
 *  report (installed/no_safe_match/retry_later) itself so the caller (cmdWatch's claim-dispatch
 *  switch, phase ⑦) is a thin routing switch, not business logic.
 *
 *  批量收割入账重写（2026-07-16，R-3 裁决——docs/design/2026-07-16-old-world-lineage-registry.md）：
 *  这个函数曾经按旧单决定契约把 mapper 的返回值解构成 `{ task, targetItemId }`（mapper 早在
 *  Task 4 就已经改造成纯信使、返回整批 FindSubtitleTask 本身，那次解构从那时起就在拿
 *  undefined），installed/no_safe_match 分支各自只认一个 itemId、且 no_safe_match 走的是已被
 *  处决的 jobs 侧 dormant 判决（completeNoMatch + 30 天封顶）。R-3 终局改写：
 *
 *  1. 事实先入账——installed 逐项 markCovered、no_safe_match 逐项 markUnavailable，不等队列判
 *     决落定；磁盘上字幕已经在了，队列怎么转都不改变这个事实。
 *  2. 内容退避彻底下沉到 item 事实层（LibraryRepo.markUnavailable 自己的阶梯，见该方法的注释）
 *     ——jobs 状态机从此不持有任何内容判决，completeNoMatch 因此零调用（不删，见该方法头注释）。
 *  3. 队列语义化简：报告落地即收官——installed/no_safe_match 都完成 completeDone；只有
 *     retry_later（瞬时故障的季剩余）走 completeError 的短退避节流轨（R-10 豁免：30s→15min→日，
 *     永不 dormant）。空报告（三桶皆空）视为一次失败的调用，也走 completeError。
 *
 *  Worker-exhaustion (phase ③/⑤ review, phase ⑦ critical instruction): runTask() (or the mapper
 *  above) can THROW — a step-cap/timeout/abort never produces a structured batch report, it throws
 *  out of agent.generate(). The entire body below is wrapped in one try/catch so a thrown worker
 *  fails this job via completeError + backoff instead of propagating up and crashing the daemon's
 *  claim loop. */
export async function runFindSubtitleWorkerTask(
  job: Job,
  deps: FindSubtitleWorkerTaskDeps,
  jobs: Pick<JobsRepo, 'completeDone' | 'completeError'>,
  now: () => number,
): Promise<FindSubtitleBatchReport | null> {
  const startedAt = now()
  // 痕迹通道 C 收官快照：runKey 拼法与 findSubtitleWorker.ts 的 onStepEvent 接线处一致
  // （`job-${jobId}`，jobId 即 String(job.id) —— 见 mapWorkerTaskToFindSubtitleTask 的 jobId
  // 赋值），用 job.id（number）走模板字面量与 task.jobId（string）走模板字面量产出同一个字符
  // 串。traceBus.snapshot() 有清空副作用，一次 runFindSubtitleWorkerTask 调用无论最终写几行
  // runs（installed/no_safe_match/retry_later 可能各一行），只应该真正调用一次——下面用惰性
  // 缓存把它钉死在"第一次 recordRun 调用时"，同一次快照原样附到这次调用产生的每一行 runs 上
  // （它们描述的是同一次 agent 跑，不是各自独立的跑）。
  const runKey = `job-${job.id}`
  let traceJsonCache: string | null | undefined
  const traceJsonForThisRun = (): string | null => {
    if (traceJsonCache === undefined) {
      const events = traceBus.snapshot(runKey)
      traceJsonCache = events.length > 0 ? JSON.stringify(events) : null
    }
    return traceJsonCache
  }
  // 退役T1 (W0-3a): one runs row per terminal outcome, mirroring executor.ts's own record()
  // shape (decision + human-readable detail, journalPath null — this runner has no journal).
  // executor.ts itself was deleted in the old-pipeline retirement; this comment only documents
  // where the shape was borrowed from.
  const recordRun = (decision: string, detail: string): void => {
    // 复审修复（可选链短路陷阱）：traceJsonForThisRun() 必须先于可选链求值——留在 insert 实参
    // 位置的话，deps.runs 缺席时可选链连实参求值一起短路，快照永不排空（残留污染同 job 重试
    // 的快照，未排空的 runKey 缓冲还会随 job 数量无上界增长）。runs 缺席=只排空不落账。
    const traceJson = traceJsonForThisRun()
    deps.runs?.insert({
      jobId: job.id, startedAt, finishedAt: now(), decision, detail: capDetail(detail), journalPath: null,
      traceJson,
    })
  }
  try {
    const task = await mapWorkerTaskToFindSubtitleTask(job, deps, now())
    if (!task) {
      // Idempotent no-op: every target already covered by the time this row was claimed. No
      // worker report exists here, so this isn't one of the runs-worthy terminal outcomes —
      // nothing was actually produced.
      jobs.completeDone(job.id, now())
      return null
    }
    const report = await deps.runTask(task)

    // itemId 幻觉防线：清单外 id 一律丢弃告警——markCovered/markUnavailable 都是两表盲 UPDATE，
    // 幻觉 id 可能砸中任何行；宁可漏记一条真报告，不可错标一个非本任务目标（零误触发在入账层
    // 的镜像，同 T4/T4b 事实清单"呈事实不做选择"的既有纪律）。
    // 六轮血案第三例余波（job 34，见 findSubtitleWorker.schemas.ts 的 itemId 头注释）：schema
    // 层现在容忍 itemId:null——本 scope 的 targets 恒带非空 id，模型仍可能漏报；null 不在
    // validIds 里（Set 只装真 id），下面的 filter 天然把它当 alien 丢弃告警，绝不带着 null
    // 进 DB 更新。过滤后的桶类型收窄回 itemId: string。
    const validIds = new Set(task.targets.map((t) => t.itemId))
    const dropAlien = <T extends { itemId: string | null }>(bucket: T[], name: string): (T & { itemId: string })[] =>
      bucket.filter((x): x is T & { itemId: string } => {
        if (x.itemId != null && validIds.has(x.itemId)) return true
        console.error(`[find-subtitle-harvest] job ${job.id}: dropping alien itemId ${x.itemId} from ${name}`)
        return false
      })
    const installed = dropAlien(report.installed, 'installed')
    const noMatch = dropAlien(report.no_safe_match, 'no_safe_match')
    const retryLater = dropAlien(report.retry_later, 'retry_later')
    const hardsubAssumed = dropAlien(report.hardsub_assumed, 'hardsub_assumed')

    // 事实先入账（installed 永远先记——磁盘上字幕已经在了，队列怎么转都不改变这个事实）
    //
    // 🔴 例外（语义反转闸，findSubtitleWorker.schemas.ts 的 identity 字段文档："后者由 runner
    // 层把关"）：identity.outcome==='unidentified' 时 installed 必须为空——agent 自己承认了
    // 身份未定，此时任何 installed 都是把字幕记到一个未核验的身份上（Peacemaker 事故形状，
    // 同 2026-07-26 审计 BLIND SPOT 1 的既有纪律）。丢弃要吼出来，不静默。
    const installedToRecord = report.identity?.outcome === 'unidentified' ? [] : installed
    if (report.identity?.outcome === 'unidentified' && installed.length > 0) {
      console.error(
        `[find-subtitle-harvest] job ${job.id}: DROPPING ${installed.length} installed item(s) — ` +
          `report's identity outcome is 'unidentified' (${report.identity.reason}), ` +
          `so installs would be recorded against no verified identity: ` +
          installed.map((i) => i.itemId).join(', '),
      )
    }
    for (const item of installedToRecord) {
      // W2（装机记账修复批，2026-07-18，审计实证 DxD/HOTD/Gracie 遍地）：candidateProviderId 全链
      // 唯一来源是 finalize 工具的 inputSchema（findSubtitleWorker.schemas.ts），agent 填它时手上
      // 唯一见过的候选标识就是 candidateKey() 复合形态（"provider:providerId"，见
      // findSubtitleWorker.tools.ts 头注释"The agent only ever sees ONE identifier per candidate"）
      // ——candidateProviderId 事实上报上来的就已经是 "assrt:661405" 这种复合形态，不是裸 id。
      // 原代码无条件再拼一次 candidateKey({provider, providerId})，把这个已经带前缀的值当裸 id
      // 用，落库成 "assrt:assrt:661405" 双前缀。真实 providerId（core/schemas.ts 的 PROVIDERS 适
      // 配器）从不含冒号，含冒号即可判定"已经是复合形态"——已含前缀原样使用，没有前缀（真正的裸
      // id，防御性兜底，理论上不会再发生但不假设它绝不会发生）才补一次 candidateKey()。
      const providerRef =
        item.candidateProvider && item.candidateProviderId
          ? item.candidateProviderId.includes(':')
            ? item.candidateProviderId
            : candidateKey({ provider: item.candidateProvider, providerId: item.candidateProviderId })
          : undefined
      // A2: fall back to the task's own target language, not a hardcoded 'zh-Hans' — the worker
      // should always set installedLanguage on an installed item, this is only a defensive last
      // resort, and a Chinese-only default would misrecord a non-Chinese task's language.
      // W3（装机记账修复批）：item.reason 是 finalize 里 agent 给出的判词，落进该行的
      // status_reason——覆盖时留判词，供事后审计"为什么装的是这个"。
      deps.lib.markCovered(
        item.itemId, item.installedPath, 'scout-download', providerRef,
        item.installedLanguage ?? task.targetLanguage, item.reason,
      )
    }
    // R-3：no_safe_match 是 worker 的语义判决，落账为 item 事实；"何时再看"由 item 自己的
    // search_attempts 阶梯决定——jobs 状态机从此不持有任何内容判决。
    for (const item of noMatch) deps.lib.markUnavailable(item.itemId, item.reason, now())
    // 救援R5：hardsub_assumed 是 agent 档的正面判决——诚实标注为覆盖的一种，不进
    // markUnavailable 的内容退避阶梯（markHardsubAssumed 自己的两表尝试模式不碰 search_attempts/
    // recheck_after，见 libraryRepo.ts 该方法头注释）。
    for (const item of hardsubAssumed) deps.lib.markHardsubAssumed(item.itemId, item.reason, now())

    // 队列语义（R-3 终局）：报告落地即入账收官；仅 retry_later（瞬时故障的季剩余）走
    // completeError 节流轨（R-10 豁免：30s→15min→日，永不 dormant）。completeNoMatch 已死。
    // 救援R5：hardsub_assumed 非空视为"这批已完成"的一种（同 installed/noMatch），走
    // completeDone——它不是失败判决，不该被"报告为空"或"待重试"两个分支误吞。
    if (installedToRecord.length === 0 && noMatch.length === 0 && retryLater.length === 0 && hardsubAssumed.length === 0) {
      jobs.completeError(job.id, 'worker returned an empty batch report', now())
      recordRun('error', 'empty batch report')
    } else if (retryLater.length > 0) {
      jobs.completeError(
        job.id, `retry_later ${retryLater.length} item(s): ${capDetail(retryLater[0].reason)}`, now(),
      )
    } else {
      jobs.completeDone(job.id, now())
    }

    // runs：按非空桶各记一行，词表沿用（dashboard 时间线口径不破）
    if (installedToRecord.length) {
      recordRun('installed', `${installedToRecord.length} 集入账: ${installedToRecord.map((i) => i.itemId).join(', ')}`)
    }
    if (noMatch.length) {
      recordRun('no_safe_match', `${noMatch.length} 集判无: ${noMatch.map((i) => `${i.itemId}(${i.reason})`).join('; ')}`)
    }
    if (retryLater.length) {
      recordRun('retry_later', `${retryLater.length} 集待重试: ${retryLater.map((i) => i.itemId).join(', ')}`)
    }
    if (hardsubAssumed.length) {
      recordRun('hardsub_assumed', `${hardsubAssumed.length} 集判定硬字幕假定: ${hardsubAssumed.map((i) => `${i.itemId}(${i.reason})`).join('; ')}`)
    }
    // agent-first 识别的可观测面：识别结论单独一行 runs（dashboard 时间线可见 agent 每轮
    // 识别出了什么/为什么识别不出）——同 runUnidentifiedFindSubtitleWorkerTask 的口径。
    if (report.identity) {
      if (report.identity.outcome === 'identified') {
        recordRun(
          'identity',
          `agent 识别结论：tmdb:${report.identity.tmdbId} (isTv=${report.identity.isTv}, ` +
            `season=${report.identity.season}, episode=${report.identity.episode})；` +
            `名称证据：${report.identity.nameEvidence}；结构证据：${report.identity.structureEvidence}`,
        )
      } else {
        recordRun('identity_unidentified', `agent 未能识别：${report.identity.reason}`)
      }
    }
    return report
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    jobs.completeError(job.id, msg, now())
    recordRun('error', msg)
    return null
  }
}
