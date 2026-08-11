// src/dashboard/mediaLibraryApi.ts —— R-F2 / R-F5 媒体库页的只读数据层。
//
// ── 为什么是新文件、新 DTO，而不是改 apiV2.ts 那 4 个 builder ──────────────────
// buildLibrary / buildSeriesDetail / buildLibraryMovieDetail / buildLibrarySeriesDetail
// 整个长在**旧表**（series / episodes / movies / subtitles）上。生产实测：
// `series` 0 行、`works` 110 行、`files` 1290 行、`tmdb_seasons` 2144 行 —— 那 4 个 builder
// 对新架构一条数据都读不出来（海报墙不是"显示旧数据"，是整个空的）。
// 而旧 `LibraryItemDTO` 里 `job: LibraryJobDTO` 挂着已死的 jobs 表、`coverage` 是旧覆盖率
// 模型，原地改会让同一个 DTO 同时背两套语义。故：新建端点 + 新 DTO，旧的原样留着不动，
// 等前端替换完成后再一并删（那是后续的事，本文件不碰它们）。
//
// ── 字段命名铁律（本仓今天栽过三次「把中间量说成结论量」）───────────────────
// 每个计数字段名都必须与它真实统计的东西逐字对应：
//   expectedEpisodeCount  = tmdb_seasons 的行数（应有集，R-F5）
//   onDiskEpisodeCount    = 磁盘上真有的**去重后**集数（实有集）
//   missingEpisodeCount   = 应有但没有 = 虚线卡片数
//   subtitledEpisodeCount = 已获取中文字幕的集数（R-F2 口径，见下）
// 绝不出现一个含混的 `episodeCount`。
import type { ScoutDb } from '../v2/db.js'
import { langOf, tagsForLanguage } from '../agent/languages.js'

// ---- 圆点三态（R-F2 用户裁决）----

/** 卡片右上角小圆点。
 *  · 'none'  = 没有中文字幕
 *  · 'blue'  = 内嵌中文轨（不需要处理）
 *  · 'green' = 外挂中文 sidecar（磁盘上真有一份可换可删的字幕文件） */
export type SubtitleDot = 'none' | 'blue' | 'green'

/** 一个语言标签是否算中文。
 *
 *  🔴 C30（本仓栽过"两套字幕标签集漂移"）：**必须**复用 agent/languages.ts 的现成表，
 *  不许在这里写第二份中文标签集。
 *
 *  🔴 为什么不能只用 `langOf(tag) === 'zh'`（实测定罪）：`langOf` 只折叠
 *  ZH_ORIGIN_CODES = {zh, cn, chi, zho, cmn}，对 'chs' / 'cht' 是纯透传 ——
 *  实测 `langOf('chs') === 'chs'`，不等于 'zh'。ffprobe 的 MediaStream Language 字段
 *  在生产里 chs/cht 都出现过（db.ts 的 CHINESE_LANG_TAGS 历史注释记的就是这五种形态），
 *  只认 langOf 会让一批带简繁内嵌轨的片子丢掉蓝点。
 *
 *  🔴 也不能只用 `tagsForLanguage('zh').includes(tag)`：那张表是"sidecar 文件名 tag"集合，
 *  未来若有人往里加/减一项，单臂判据会静默改变含义。
 *
 *  两臂并列（与 v2/subtitleJudge.ts 的私有 isLang 同构——那份没导出，且它服务的是
 *  "需不需要找字幕"的判定语义，这里服务的是"呈现哪种圆点"，刻意不去 export 一个跨语义
 *  的共享函数，但**判据的两条腿完全一致**，两边任一侧扩表都能覆盖到）。 */
function isChineseTag(tag: string | null | undefined): boolean {
  if (!tag) return false
  const t = tag.toLowerCase()
  return tagsForLanguage('zh').some((x) => x.toLowerCase() === t) || langOf(tag) === 'zh'
}

/** `files.embedded_langs`（JSON 数组串）解析。
 *  · NULL      = 没探过 → null
 *  · '[]'      = 探过、确认零轨 → []
 *  · 坏 JSON   = 按"没探过"处理（同 cli/unidentifiedFindSubtitle.ts 的既有口径），不抛。 */
function parseEmbeddedLangs(raw: string | null): string[] | null {
  if (raw == null) return null
  try {
    const arr: unknown = JSON.parse(raw)
    return Array.isArray(arr) ? (arr as string[]) : null
  } catch {
    return null
  }
}

/** 一个**文件**是否有外挂中文 sidecar。
 *
 *  判据是 `files.sub_status === 'covered'` —— R24 把这一列的唯一写入者收归扫描
 *  （"磁盘上真有同名中字"这个事实观察）。
 *
 *  ⚠️ 只认 'covered' 这一个值，**不许**用 `sub_status IS NOT NULL`：
 *  'handoff_translate'（已移交翻译流）与 'unsolvable'（判定无解）都是**流程中间态**，
 *  不是磁盘事实 —— 把它们算成"有字幕"会让排队中的集提前变绿点，正是"把中间量说成结论量"。
 *
 *  ── 「我们配的」与「用户手放的」要不要区分：**不区分**（决策与理由）────────────
 *  covered 同时包含两者（R24 是磁盘观察，不问来路）。新加的 notifications 表确实能区分
 *  （它只记我们装的），但媒体库页是**磁盘现状**的视图，不是成果账本：
 *   ① 用户视角"这一集有没有中文字幕"就是全部问题，来源不改变任何可执行动作；
 *   ② 若按 notifications 区分，用户手放的字幕会显示成"无点" → 系统看起来要去补一份
 *      它其实已经有的字幕，正是 R24 要消解的那类"库与磁盘不一致"；
 *   ③ notifications 只有一周窗（NOTIFICATION_RETENTION_MS），拿它当颜色判据会让
 *      八天前配上的字幕**自己变回无点**——一个纯粹由保留期造出的假状态变化。
 *  「我们配的成果」这条叙事归通知页（R-F3），不该挤进媒体库页的圆点。 */
function fileHasSidecar(subStatus: string | null): boolean {
  return subStatus === 'covered'
}

/** 一个**文件**是否有内嵌中文轨。没探过（NULL）→ false（没有证据就没有蓝点）。 */
function fileHasEmbeddedChinese(embeddedLangs: string[] | null): boolean {
  return embeddedLangs != null && embeddedLangs.some(isChineseTag)
}

// ---- R-F2「不管来源」的聚合 ----

/** 一格（一集，或电影的那一格）在**聚合后**的字幕事实。 */
interface DotAggregate {
  /** 该格下的文件份数（同一集在两个目录各一份 → 2）。 */
  fileCount: number
  /** 其中有外挂中文 sidecar 的份数（R-F2 原话"另一处那份仍要单独去配"的可见依据）。 */
  subtitledFileCount: number
  dot: SubtitleDot
}

/** 🔴 R-F2 防猴子用户核心条款：**任一份**有字幕 → 该格算已获取。
 *
 *  用户原话：两个「绝命毒师」目录，只要有一处 S01E03 有字幕，媒体库就显示这一集已获取
 *  ——即使另一处那份仍要单独去配。合并键 = work_id（TMDB id）。
 *
 *  实现要点（每一条都有用例钉着）：
 *   · 用 `.some()` 跨该格的**全部**文件求或，绝不能取"第一行"——取首行的实现会因入库
 *     顺序不同给出相反结论，而测试若恰好按"有字幕的在前"写就永远绿。
 *   · 绿点优先于蓝点：外挂那份是用户能换能删的可操作对象，内嵌轨不是。
 *   · fileCount / subtitledFileCount 如实呈报，"另一处仍要单独去配"这个事实不许被聚合吞掉。 */
function aggregateDot(files: readonly FileRow[]): DotAggregate {
  const subtitledFileCount = files.filter((f) => fileHasSidecar(f.sub_status)).length
  const anyEmbedded = files.some((f) => fileHasEmbeddedChinese(parseEmbeddedLangs(f.embedded_langs)))
  const dot: SubtitleDot = subtitledFileCount > 0 ? 'green' : anyEmbedded ? 'blue' : 'none'
  return { fileCount: files.length, subtitledFileCount, dot }
}

// ---- 行形状 ----

interface WorkRow {
  id: string
  title: string
  year: number | null
  media_type: string
  poster_path: string | null
  chinese_titles: string | null
}

interface FileRow {
  work_id: string
  season: number | null
  episode: number | null
  sub_status: string | null
  embedded_langs: string | null
}

/** `works.chinese_titles` 是 JSON 数组（中文译名变体）；取首个作为展示名。
 *  坏 JSON / 空数组 / NULL → null（前端回落到 title）。 */
function firstChineseTitle(raw: string | null): string | null {
  if (raw == null) return null
  try {
    const arr: unknown = JSON.parse(raw)
    return Array.isArray(arr) && typeof arr[0] === 'string' && arr[0] !== '' ? arr[0] : null
  } catch {
    return null
  }
}

/** 只有 tv/movie 两种；库里理论上不会有别的，防御性收敛到 'tv'。 */
function mediaTypeOf(raw: string): 'tv' | 'movie' {
  return raw === 'movie' ? 'movie' : 'tv'
}

/** 一集的分组键。season/episode 均非空才成格 —— 见 buildMediaLibraryDetail 的 unplaced 说明。 */
const epKey = (season: number, episode: number): string => `${season}\u0000${episode}`

// ---- 列表页 ----

export interface MediaLibraryItemDTO {
  /** works.id（'tmdb:<id>'）。**这就是详情页的路由 id**，也是 R-F2 的合并键。 */
  workId: string
  title: string
  /** works.chinese_titles 的首个译名；无则 null（前端回落 title）。 */
  chineseTitle: string | null
  year: number | null
  /** TMDB poster_path（如 '/abc.jpg'），前端自拼 image.tmdb.org 前缀；无海报 null。 */
  posterPath: string | null
  mediaType: 'tv' | 'movie'
  /** 应有集数 = tmdb_seasons 行数（R-F5）。**电影恒 0**（没有季集）；
   *  剧集为 0 表示该剧的应有集缓存还没回填 —— 不是"这剧只有 0 集"。 */
  expectedEpisodeCount: number
  /** 实有集数 = 磁盘上有文件的**去重后**集数（同一集两份文件只算 1）。
   *  电影是文件份数去重后的格数（恒 0 或 1）。 */
  onDiskEpisodeCount: number
  /** 虚线卡片数 = max(0, 应有 - 实有)。
   *  夹 0 是必需的：应有集缓存缺失（expected=0）而磁盘有 12 集时，裸减法得 -12，
   *  前端会显示"缺 -12 集"。 */
  missingEpisodeCount: number
  /** 已获取中文字幕的格数（R-F2「任一份有就算」口径；绿点 + 蓝点都计入 ——
   *  用户视角"这一集有中文字幕"不分内嵌外挂）。 */
  subtitledEpisodeCount: number
}

/** GET /api/v2/mediaLibrary：海报墙列表。
 *
 *  🔴 R-F2「识别失败的孤儿不露出」：`files.work_id IS NULL` 的行在 SQL 谓词层就被滤掉
 *  （INNER JOIN works + work_id NOT NULL），不进任何聚合。那是用户的命名问题，
 *  底线是按 `title (year)` 命名。
 *
 *  🔴 用 INNER JOIN 而非 LEFT JOIN：一个文件都没有的 works 行（用户移除了守备目录后
 *  残留的空壳）不该在海报墙上冒出一张空卡片 —— 媒体库页描述的是"磁盘上有什么"。 */
export function buildMediaLibrary(db: ScoutDb): MediaLibraryItemDTO[] {
  const works = db
    .prepare(
      `SELECT DISTINCT w.id, w.title, w.year, w.media_type, w.poster_path, w.chinese_titles
       FROM works w JOIN files f ON f.work_id = w.id
       WHERE f.work_id IS NOT NULL
       ORDER BY w.title ASC, w.id ASC`,
    )
    .all() as WorkRow[]
  if (works.length === 0) return []

  const files = db
    .prepare(
      `SELECT work_id, season, episode, sub_status, embedded_langs
       FROM files WHERE work_id IS NOT NULL`,
    )
    .all() as FileRow[]

  const expectedByWork = new Map<string, number>()
  for (const r of db
    .prepare(`SELECT series_id, COUNT(*) AS n FROM tmdb_seasons GROUP BY series_id`)
    .all() as { series_id: string; n: number }[]) {
    expectedByWork.set(r.series_id, r.n)
  }

  // work → 格键 → 该格的文件们。电影/未解析出季集的文件统一落在 '' 这一格
  // （电影本来就一格；剧集里解析不出季集的文件也只能算作"这作品有文件"，
  //  它进不了季集网格，但它的字幕事实仍是真实的）。
  const cellsByWork = new Map<string, Map<string, FileRow[]>>()
  for (const f of files) {
    const key = f.season != null && f.episode != null ? epKey(f.season, f.episode) : ''
    let cells = cellsByWork.get(f.work_id)
    if (!cells) { cells = new Map(); cellsByWork.set(f.work_id, cells) }
    const bucket = cells.get(key)
    if (bucket) bucket.push(f)
    else cells.set(key, [f])
  }

  return works.map((w) => {
    const cells = cellsByWork.get(w.id) ?? new Map<string, FileRow[]>()
    const expected = expectedByWork.get(w.id) ?? 0
    // 🔴 去重后的格数，不是 files 行数：两个目录各一份的库，COUNT(*) 会把"实有 1 集"
    // 报成 2 集，进而算出负的缺集数（missing 的夹 0 会掩盖它，但概览数字就已经错了）。
    const onDisk = cells.size
    const subtitled = [...cells.values()].filter((rows) => aggregateDot(rows).dot !== 'none').length
    return {
      workId: w.id,
      title: w.title,
      chineseTitle: firstChineseTitle(w.chinese_titles),
      year: w.year,
      posterPath: w.poster_path,
      mediaType: mediaTypeOf(w.media_type),
      expectedEpisodeCount: expected,
      onDiskEpisodeCount: onDisk,
      missingEpisodeCount: Math.max(0, expected - onDisk),
      subtitledEpisodeCount: subtitled,
    }
  })
}

// ---- 详情页（季集网格）----

export interface MediaLibraryEpisodeDTO {
  episode: number
  /** 应有集带来的集标题（tmdb_seasons.title）；只在磁盘上有、应有集里没有时为 null。 */
  title: string | null
  /** **实线 vs 虚线的唯一判据**（R-F2）：true=磁盘上真有文件（实线）；
   *  false=TMDB 说这季有、磁盘上没有（虚线）。 */
  onDisk: boolean
  /** 圆点三态。onDisk=false 时恒 'none'（没有文件就没有字幕事实）。 */
  dot: SubtitleDot
  /** 该集在磁盘上的文件份数（同一集在两个目录各一份 → 2）。虚线格为 0。 */
  fileCount: number
  /** 其中有外挂中文 sidecar 的份数。R-F2「另一处那份仍要单独去配」的可见依据：
   *  `subtitledFileCount < fileCount` 即"还有份没配上"。 */
  subtitledFileCount: number
}

export interface MediaLibrarySeasonDTO {
  season: number
  /** 应有 ∪ 实有的并集，按集号升序。 */
  episodes: MediaLibraryEpisodeDTO[]
}

/** 电影那一格（剧集恒 null）。 */
export interface MediaLibraryMovieDTO {
  dot: SubtitleDot
  fileCount: number
  subtitledFileCount: number
}

export interface MediaLibraryDetailDTO {
  work: {
    workId: string
    title: string
    chineseTitle: string | null
    year: number | null
    posterPath: string | null
    mediaType: 'tv' | 'movie'
  }
  /** 季集网格。**电影恒空数组**（R-F5：电影没有季集）。 */
  seasons: MediaLibrarySeasonDTO[]
  /** 电影那一格；剧集恒 null。 */
  movie: MediaLibraryMovieDTO | null
  /** 属于本作品、但 season/episode 解析不出（`parse_confidence='none'`）因而进不了
   *  季集网格的文件数。**必须如实报**：不报的话用户看不出"有文件没进网格"，会以为
   *  系统把文件弄丢了；而按 NULL 分组又会造出一个 season=null 的幽灵季。电影恒 0
   *  （电影的文件本来就不该有季集，它们全部落进 movie 那一格）。 */
  unplacedFileCount: number
}

/** GET /api/v2/mediaLibrary/:workId：季集网格详情。作品不存在 → null（404 语义）。
 *
 *  三份数据的合并：
 *   ① 应有集 —— tmdb_seasons（R-F5）。缺失时**优雅降级**：只显示实有集，不崩、不吞数据
 *      （某部剧还没被 boot 回填 pass 轮到时就是这个状态，是常态不是异常）。
 *   ② 实有集 —— files（work_id = 本作品）。
 *   ③ 字幕事实 —— 按 R-F2 逐格聚合（见 aggregateDot）。
 *
 *  季号取**应有 ∪ 实有**的并集：磁盘上有第 3 季而 TMDB 只缓存了第 1 季时（或反之），
 *  两边都不许丢。 */
export function buildMediaLibraryDetail(db: ScoutDb, workId: string): MediaLibraryDetailDTO | null {
  const w = db
    .prepare(
      `SELECT id, title, year, media_type, poster_path, chinese_titles FROM works WHERE id = ?`,
    )
    .get(workId) as WorkRow | undefined
  if (!w) return null

  const files = db
    .prepare(
      `SELECT work_id, season, episode, sub_status, embedded_langs FROM files WHERE work_id = ?`,
    )
    .all(workId) as FileRow[]

  const work = {
    workId: w.id,
    title: w.title,
    chineseTitle: firstChineseTitle(w.chinese_titles),
    year: w.year,
    posterPath: w.poster_path,
    mediaType: mediaTypeOf(w.media_type),
  }

  // 电影：没有季集网格，只有"有没有字幕"这一格（R-F2 同样按任一份算）。
  if (work.mediaType === 'movie') {
    return { work, seasons: [], movie: aggregateDot(files), unplacedFileCount: 0 }
  }

  // 剧集：季集网格。season/episode 任一为 NULL 的文件进不了网格，单独计数。
  const placed = files.filter((f) => f.season != null && f.episode != null)
  const unplacedFileCount = files.length - placed.length

  const onDiskCells = new Map<string, FileRow[]>()
  for (const f of placed) {
    const key = epKey(f.season!, f.episode!)
    const bucket = onDiskCells.get(key)
    if (bucket) bucket.push(f)
    else onDiskCells.set(key, [f])
  }

  const canonical = db
    .prepare(
      `SELECT season, episode, title FROM tmdb_seasons WHERE series_id = ? ORDER BY season ASC, episode ASC`,
    )
    .all(workId) as { season: number; episode: number; title: string | null }[]
  const canonicalTitles = new Map<string, string | null>()
  for (const c of canonical) canonicalTitles.set(epKey(c.season, c.episode), c.title)

  // 季号 = 应有 ∪ 实有，升序。
  const seasonNumbers = new Set<number>()
  for (const c of canonical) seasonNumbers.add(c.season)
  for (const f of placed) seasonNumbers.add(f.season!)

  const seasons: MediaLibrarySeasonDTO[] = [...seasonNumbers]
    .sort((a, b) => a - b)
    .map((season) => {
      // 该季的集号 = 应有 ∪ 实有，升序。
      const nums = new Set<number>()
      for (const c of canonical) if (c.season === season) nums.add(c.episode)
      for (const f of placed) if (f.season === season) nums.add(f.episode!)

      const episodes = [...nums]
        .sort((a, b) => a - b)
        .map((episode): MediaLibraryEpisodeDTO => {
          const key = epKey(season, episode)
          const rows = onDiskCells.get(key)
          // 虚线格（应有但磁盘没有）：没有文件就没有字幕事实，dot 恒 none、两个计数恒 0。
          if (!rows) {
            return {
              episode,
              title: canonicalTitles.get(key) ?? null,
              onDisk: false,
              dot: 'none',
              fileCount: 0,
              subtitledFileCount: 0,
            }
          }
          const agg = aggregateDot(rows)
          return {
            episode,
            title: canonicalTitles.get(key) ?? null,
            onDisk: true,
            dot: agg.dot,
            fileCount: agg.fileCount,
            subtitledFileCount: agg.subtitledFileCount,
          }
        })

      return { season, episodes }
    })

  return { work, seasons, movie: null, unplacedFileCount }
}
