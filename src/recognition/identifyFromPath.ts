import { posix } from 'node:path'
import { parseFilename, BARE_CJK_EPISODE_SOURCE, type ParsedName } from './parseFilename.js'

/** Recognition-ready shape for a full video path. Consumed by C3 (TMDB resolution) — keep the
 *  field names stable, they are the contract. */
export interface PathIdentity {
  title: string | null
  year: number | null
  season: number | null
  episode: number | null
  absoluteEpisode: number | null
  isTv: boolean
  embeddedTmdbId: string | null
}

/** Deliberately a loose `{ park: string }` (not an enum) — C2 only ever produces 'no-signal';
 *  other park reasons (e.g. 'ambiguous') belong to C3's TMDB disambiguation step. */
export interface Park {
  park: string
}

/**
 * Splits a video path into its raw string segments, tolerant of Windows-style backslash
 * separators, a leading slash (absolute path), and a stray trailing slash. This function is pure
 * string handling — no `fs`, so it can't know the real platform a path came from (a video path
 * may describe an SMB/Windows share even while this process runs on Linux/macOS) — so behavior
 * must not depend on the host OS. We deliberately do NOT use the platform-dependent `path` module
 * for splitting (its separator varies by OS); `node:path`'s `posix` variant is used below only for
 * the extension-stripping helper, once slashes are already normalized to '/'.
 */
function toSegments(videoPath: string): string[] {
  const normalized = videoPath.replace(/\\/g, '/')
  return normalized.split('/').filter((segment) => segment.length > 0)
}

/** Our only metadata source is TMDB (YAGNI) — `[tvdbid-...]`/`[imdbid-...]` tags are ignored by
 *  construction: this regex only ever matches the `tmdbid` tag. Matches the folder convention this
 *  project itself emits (see `buildTargetShowDir` in libraryRealign.ts: `Show (Year) [tmdbid-N]`)
 *  and the same convention Sonarr/Radarr/Jellyfin use. */
const TMDB_ID_PATTERN = /\[tmdbid-(\d+)\]/i

function findEmbeddedTmdbId(segments: string[]): string | null {
  for (const segment of segments) {
    const match = segment.match(TMDB_ID_PATTERN)
    if (match) return match[1]
  }
  return null
}

/**
 * @ctrl/video-filename-parser (wrapped by parseFilename, C1) cannot recognize a bare season-folder
 * segment: `parseFilename('Season 2')` finds no season and just echoes 'Season 2' back as a
 * literal movie title. Worse, a zero-padded form like 'Season 02' gets swallowed by the lib's
 * anime-absolute-episode pattern (title 'Season', absoluteEpisode 2) — actively wrong, not just
 * empty. So season-folder detection runs on the RAW segment with our own regex, and (see below)
 * season-folder-shaped segments are never handed to parseFilename at all.
 */
const SEASON_FOLDER_PATTERNS: RegExp[] = [
  /^(?:season|series)[\s._-]*(\d{1,3})$/i,
  /^s(\d{1,3})$/i,
  // 中文季目录：第N集 / 第N季 / 第N部（莉可丽丝"第1集"此前被误判成标题，root cause）
  /^第\s*(\d{1,3})\s*[集季部]$/,
]

/** 季目录形态判定：`Season NN`/`Series NN`/`S01`/`第N季|集|部` → 季号，`Specials` → 0，
 *  其余 → null。
 *
 *  Exported（作品单元管线 B0，2026-08-07）：`v2/workUnit.ts` 的作品根推导要判"这一层是不是
 *  季目录，是就继续上爬"，必须与识别层用**同一份**形态定义。复制一份正则必然漂移（本项目
 *  已有先例：VIDEO_EXT 在三处各写一份，见 daemon/selfScan.ts 头注释的自陈），故这里加导出而
 *  不是让调用方另写。加 export 是零行为改动：三个既有内部调用点（下方 isCanonicalEpisodePath
 *  与 identifyFromPath 主体）逐字不动。 */
export function detectSeasonFolder(rawSegment: string): number | null {
  const trimmed = rawSegment.trim()
  if (/^specials?$/i.test(trimmed)) return 0
  for (const pattern of SEASON_FOLDER_PATTERNS) {
    const match = trimmed.match(pattern)
    if (match) return Number(match[1])
  }
  return null
}

/** 分类目录黑名单——这些段是"装剧的桶"，不是剧名（tv/movies/anime/shows/series/电影/剧集/动漫/电视剧）。
 *  Rule 5 的 fallback 用目录名当标题前，先过这张表：命中即该目录不提供标题信号。
 *  （根因：此前 'tv/Witch Watch S01E02.mkv' 把分类目录 "tv" 当标题，系统性误识别。） */
/** 分类目录名（"装剧的桶"，不是作品名）。
 *  Exported（作品单元管线 B2c，2026-08-07）：作品根推导要跳过这些层——`TV/Show/E01.mkv` 的
 *  作品根是 `TV/Show` 而不是 `TV`。与识别层共用同一份名单，不复制第二份（复制必漂移）。 */
export const CATEGORY_DIR_NAMES = new Set([
  'tv', 'tvshows', 'tv shows', 'shows', 'series', 'movies', 'movie', 'films', 'film',
  'anime', 'animation', 'cartoons',
  '电视剧', '剧集', '电视', '电影', '动漫', '动画', '番剧', '番组', '美剧', '日剧', '韩剧', '英剧',
])

/** 文件名 title 清洗：剥掉尾部的季/集/质量/来源标记，只留剧名本体。
 *  "Teach You a Lesson S01E01 2160p WEB-DL" → "Teach You a Lesson"
 *  "Lycoris Recoil S01E01" → "Lycoris Recoil"
 *  只剥尾部连续的技术标记段，不动中间的词（"Hero 2002" 的 2002 是 year，由调用方单独处理）。
 *  清洗后若是裸集数标记（"ep 1"、"第3话"、"01"），返回空串——它们不是剧名，不能当 title。 */
function cleanFileTitle(title: string): string {
  let t = title
  // 反复剥尾部的技术标记，直到没有可剥的（S01E01 / E01 / 2160p / WEB-DL / BluRay / x265 / HDR / REMUX / AAC / 5.1 ...）
  const techTail = /[\s._-]+(?:s\d{1,2}e\d{1,3}(?:e\d{1,3})?|e\d{1,3}|ep\d{1,3}|\d{3,4}p(?:\d{1,2})?|(?:web[._-]?dl|webrip|bluray|bdrip|remux|hdtv|hdrip|dvdrip|brrip|x26[45]|h\.?26[45]|hevc|avc|hdr10\+?|hdr|dv|10bit|8bit|aac|ac3|ddp?5\.1|dts[._-]?hd|truehd|atmos|lpcm|flac|mp3|repack|proper|internal|limited|complete|multi|dual[._-]?audio|eng|english)\b.*)$/i
  let prev = ''
  while (prev !== t) {
    prev = t
    t = t.replace(techTail, '')
  }
  t = t.trim()
  // 剥掉可能残留的扩展名（第三方轮子 movie mode 对 "ep 1.mp4" 会把扩展名留在 title 里）
  t = t.replace(/\.(?:mkv|mp4|avi|ts|m2ts|wmv|flv|webm|mov|mpg|mpeg|m4v)$/i, '').trim()
  // 裸集数标记（ep 1 / ep1 / 第3话 / 第3話 / 第3集 / 01）不是剧名——返回空串，让调用方走目录 fallback
  // ⚠️ 同 BARE_EPISODE_PATTERNS 的债务标记：其中的 CJK 分支当前不可达（前置条件是
  //    fileParsed.title 非 null，而裸 `第N話` 经 parseFilename 后 title 恒为 null）。
  //    变异实测删掉该分支零条测试变红。保留 + 统一字符类，删除另行立项。
  if (new RegExp(`^(?:ep(?:isode)?[\\s._-]*\\d{1,3}|${BARE_CJK_EPISODE_SOURCE}|\\d{1,3})$`, 'i').test(t)) return ''
  return t
}

/** 目录名 title 质量闸：太短/纯符号/被轮子截断的垃圾（"铁."）不采纳当标题。
 *  返回 true = 这个目录名可以当标题候选。 */
function isUsableDirTitle(title: string | null | undefined): boolean {
  if (!title) return false
  const t = title.trim()
  if (t.length < 2) return false
  // 分类目录黑名单
  if (CATEGORY_DIR_NAMES.has(t.toLowerCase())) return false
  // 去掉首尾标点/符号后，剩下的有效字符（字母/数字/中日韩文字）至少要 2 个——"铁." 这种
  // 被轮子从"铁拳教育"截断成 1 个有效字 + 尾点的垃圾，有效字符 < 2，拒收。
  const meaningful = t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
  const meaningfulChars = [...meaningful].filter((c) => /[\p{L}\p{N}]/u.test(c))
  return meaningfulChars.length >= 2
}

/**
 * Minimal fallback for bare-episode FILE segments the lib can't parse — verified empirically:
 * 'ep 1.mp4', 'ep1.mp4', bare '01.mp4' / '1.mp4', and CJK '第3话'/'第3集' all fail to parse via
 * @ctrl/video-filename-parser (echoed back as a literal movie title, no episode/absoluteEpisode).
 * Only called once the lib parse found no season/episode/absoluteEpisode structure at all.
 * Digits capped at 3 (episodes rarely run past 999) so a bare 4-digit filename that's really a
 * year (e.g. a hypothetical 'movies/2016.mp4') doesn't get misread as an episode number.
 *
 * ⚠️ 债务标记（2026-08-14 变异实测）：下面这条 CJK 模式**当前是不可达的**。它的前置条件是
 * `!fileParsed.isTv`，而任何形如 `第N话/話/集` 的裸文件名都会先被 parseFilename 的 R7 吃掉
 * （返回 isTv=true / absoluteEpisode=N），控制流根本走不到这里。实测：把这条模式整行删掉，
 * `npm run verify` 四判据全绿、3305 条用例零失败；穷举 18 种字形（三字符 × 三位数 × 带/不带
 * 空格）全部 reachable=0。
 *
 * 本轮**没有删它**，只贴标记——理由是它与 :113 的守卫是同一份"裸集号"语义的两个副本，
 * 而删除属于行为收窄，应当独立立项、独立回归，不该塞进一个修 bug 的 commit 里搭车。
 * 字符类仍统一到 BARE_CJK_EPISODE_SOURCE：即便不可达，也不能让它成为下一次漂移的种子。
 */
const BARE_EPISODE_PATTERNS: RegExp[] = [
  /^(?:ep|episode)[\s._-]*(\d{1,3})$/i,
  new RegExp(`^${BARE_CJK_EPISODE_SOURCE}$`),
  /^(\d{1,3})$/,
]

function parseBareEpisode(fileNameNoExt: string): number | null {
  const trimmed = fileNameNoExt.trim()
  for (const pattern of BARE_EPISODE_PATTERNS) {
    const match = trimmed.match(pattern)
    if (match) return Number(match[1])
  }
  return null
}

/** 债务D1（realign 出生信号换代）：own-ingest 规范化让真·平铺库的 mirror 永不超 TMDB 季表，
 *  exceedsSeasonTable 只剩误刮季夹层一种形态能点火；"磁盘布局不合规范形"是识别层本来就
 *  看得见的并列事实。规范形 = `Show (Year) [tmdbid-N]/Season NN/<file>`（buildTargetShowDir
 *  自产的形状）。只报事实——判断（要不要 realign）永远归 orchestrator。 */
export function isCanonicalEpisodePath(videoPath: string): boolean {
  const segments = toSegments(videoPath)
  if (segments.length < 3) return false
  const parentSeg = segments[segments.length - 2]
  const grandparentSeg = segments[segments.length - 3]
  return detectSeasonFolder(parentSeg) !== null && TMDB_ID_PATTERN.test(grandparentSeg)
}

/**
 * Path-aware layer on top of parseFilename (C1): cuts the path's last three segments
 * (file / parent dir / grandparent dir), parses each, and deterministically merges them into one
 * identity — the `Show/Season NN/file` convention Jellyfin/Sonarr/Radarr all rely on. No models,
 * no TMDB, no fs access: a pure function of the path string.
 */
export function identifyFromPath(videoPath: string): PathIdentity | Park {
  const segments = toSegments(videoPath)
  if (segments.length === 0) return { park: 'no-signal' }

  // Rule 1: embedded [tmdbid-N] short-circuits TMDB *searching* (C3's job) but not the
  // season/episode/title structure below, which still gets merged normally.
  const embeddedTmdbId = findEmbeddedTmdbId(segments)

  const fileSeg = segments[segments.length - 1]
  const parentSeg = segments.length >= 2 ? segments[segments.length - 2] : null
  const grandparentSeg = segments.length >= 3 ? segments[segments.length - 3] : null

  // Rule 2: season folders detected on the RAW segment (lib can't do this — see above).
  const parentSeasonFolder = parentSeg !== null ? detectSeasonFolder(parentSeg) : null
  const grandparentSeasonFolder = grandparentSeg !== null ? detectSeasonFolder(grandparentSeg) : null
  const parentIsSeasonFolder = parentSeasonFolder !== null
  const grandparentIsSeasonFolder = grandparentSeasonFolder !== null

  const fileParsed: ParsedName = parseFilename(fileSeg)
  // A season-folder-like segment is NEVER a title candidate (rule 5) and is never worth running
  // through parseFilename at all — see the SEASON_FOLDER_PATTERNS comment for why letting the lib
  // near a string like 'Season 02' is actively harmful, not just unhelpful.
  const parentParsed: ParsedName | null =
    parentSeg !== null && !parentIsSeasonFolder ? parseFilename(parentSeg) : null
  const grandparentParsed: ParsedName | null =
    grandparentSeg !== null && !grandparentIsSeasonFolder ? parseFilename(grandparentSeg) : null

  // Rule 5: title precedence — 文件的 title 优先（清洗季/集/质量后缀），目录名仅作受闸 fallback。
  //  根因修复（此前系统性误识别）：旧逻辑用 `fileParsed.year !== null` 决定信谁，但所有 TV 文件
  //  的 fileParsed.year 恒为 null（TV 模式不带 year），于是**所有 TV 文件都掉到"信目录名"分支**，
  //  而目录名经第三方轮子解析不可靠——'tv'→'tv'、'铁拳教育'→'铁.'、'第1集'→'第1集'，全被当标题。
  //  修正：①文件 title 清洗后优先（文件名是信息最丰富的段）②目录名仅当文件无 title 时作
  //  fallback，且必须过质量闸（isUsableDirTitle：滤掉分类目录/被截断的垃圾）。
  let title: string | null
  let year: number | null
  const fileTitle = fileParsed.title ? (cleanFileTitle(fileParsed.title) || null) : null
  // 文件 title 质量闸：纯数字（"2025"）或含技术标记（"2026 2160p"）的文件 title 不采纳——
  //  这种文件是技术命名（'2025.HDR...'/'2026.2160p...'），剧名在目录段（'招z魂z4'/'后室'），
  //  不该用文件的数字/技术串当 title。（招z魂z4/H）后丨室 实测暴露）
  const fileTitleUsable = fileTitle !== null && !/^\d{4}$/.test(fileTitle) && !/\d{3,4}p|web[ _-]?dl|bluray|hdtv|remux|hdr|x26[45]/i.test(fileTitle)

  if (parentIsSeasonFolder) {
    // Show/Season NN/file layout: the season folder ate the parent slot, so the title lives one
    // level up. 优先用文件自身的 title（清洗后且过质量闸）；没有再用 grandparent（须过质量闸）。
    if (fileTitleUsable) {
      title = fileTitle
      year = fileParsed.year ?? grandparentParsed?.year ?? null
    } else if (grandparentParsed?.title && !grandparentIsSeasonFolder && isUsableDirTitle(grandparentParsed.title)) {
      title = grandparentParsed.title
      year = grandparentParsed.year
    } else {
      title = fileTitleUsable ? fileTitle : null
      year = fileParsed.year
    }
  } else if (fileTitleUsable) {
    // 文件有可用 title（电影/剧集通吃）——文件名是信息最丰富的段，优先信它。
    // year：文件没有就从目录补（TV 文件恒 null，电影文件可能有）。
    title = fileTitle
    year = fileParsed.year ?? parentParsed?.year ?? grandparentParsed?.year ?? null
  } else if (parentParsed?.title && isUsableDirTitle(parentParsed.title)) {
    // Show/file.mkv layout: 文件无 title，用目录名（须过质量闸，滤掉分类目录/截断垃圾）。
    title = parentParsed.title
    year = parentParsed.year
  } else {
    title = fileTitleUsable ? fileTitle : null
    year = fileParsed.year
  }

  // Rule 4: file segment's own season wins; else season-folder parent; else null.
  const season = fileParsed.season ?? parentSeasonFolder ?? null

  // Rule 3: episode/absoluteEpisode. Trust the lib's own season+episode or absoluteEpisode
  // structure as-is when it found one (it already made the season-vs-absolute call). Only for a
  // file segment where the lib found NOTHING do we fall back to our own bare-number regex, and
  // only THERE does season-context decide episode vs absoluteEpisode (a bare number has no
  // inherent season/absolute distinction the way the lib's own parse does).
  let episode: number | null = null
  let absoluteEpisode: number | null = null
  if (fileParsed.episode !== null) {
    episode = fileParsed.episode
  } else if (fileParsed.absoluteEpisode !== null) {
    // 只有**明确的季目录标记**（detectSeasonFolder 识别的 'Season 1'/'第2季'/'Specials'）才把
    //  absoluteEpisode 折算成 episode——'ep 1.mp4' in Season 1 → S01E01，季目录给了毫无疑问的
    //  context。文件名里的季名（'Hero' in 'Hero - 01'）不折算——'01' 是 Hero 季内还是全剧绝对，
    //  有歧义，归 ingest 层的多季守卫判定（北极星红线"绝不误认"）。
    if (parentSeasonFolder !== null) {
      episode = fileParsed.absoluteEpisode
    } else {
      absoluteEpisode = fileParsed.absoluteEpisode
    }
  } else if (!fileParsed.isTv) {
    const bare = parseBareEpisode(posix.parse(fileSeg).name)
    if (bare !== null) {
      if (season !== null) episode = bare
      else absoluteEpisode = bare
    }
  }

  // Rule 6: isTv iff episode/absoluteEpisode/season structure was found — embeddedTmdbId alone
  // doesn't decide it (an embedded id can point at a movie just as easily as a show).
  const isTv = season !== null || episode !== null || absoluteEpisode !== null

  // Rule 7: park on zero signal. Trade-off, deliberate: this parks a year-less flat movie (e.g.
  // 'movies/aaa/bbb.mkv') even though a human could probably still guess the title — zero-signal
  // rescue is out of scope for this mechanical layer (YAGNI), and a wrong tmdbId from guessing is
  // worse than a parked item that gets retried or manually identified later (C3/C4's job).
  const yearAnywhere = fileParsed.year ?? parentParsed?.year ?? grandparentParsed?.year ?? null
  if (embeddedTmdbId === null && !isTv && yearAnywhere === null) {
    return { park: 'no-signal' }
  }

  return {
    title,
    year,
    season,
    episode,
    absoluteEpisode,
    isTv,
    embeddedTmdbId,
  }
}
