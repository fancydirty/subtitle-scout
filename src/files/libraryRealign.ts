import { readdirSync } from 'node:fs'
import { extname, basename, join } from 'node:path'
import { formatEpisodeCode } from '../core/episode.js'
import type { SeasonTableEntry } from '../adapters/providers/tmdb.js'
import type { AnimeListsEntry } from '../adapters/providers/animeLists.js'

export interface EpisodeNumberMatch { absoluteEpisode: number; matchedToken: string }

const CJK_EPISODE_RE = /第\s*(\d{1,4})\s*[话話集]/
const SXXEYY_RE = /S\d{1,4}E\d{1,4}/i
const BRACKET_EPISODE_RE = /\[(\d{1,4})\]/
const E_CODE_RE = /(?<![A-Za-z0-9])E(\d{1,4})(?!\d)/i
// E 前缀范围合集：'E01-E02' / 'E01-02'——一个文件跨多集，取任何单集都是错的，判 null 进隔离区。
// 尾部 (?![0-9A-Za-z]) 防误伤 "E05 - 1080p" 这类"集号 - 画质"写法（1080p 不是范围终点）。
const E_RANGE_RE = /(?<![A-Za-z0-9])E\d{1,4}\s*-\s*E?\d{1,4}(?![0-9A-Za-z])/i

/**
 * 从文件名解析绝对集号——只认三种确定性标记（CJK "第N话/第N集" > 方括号 [NN] > 裸 "E26"），
 * 取不出就返回 null，绝不猜（隔离区伺候）。已经是 SxxEyy 记法的文件不是"绝对编号平铺"问题
 * 的目标（本身已分季），直接判 null。合集/范围记法（"01-02"）三种模式都不命中，天然落入 null。
 *
 * CRITICAL：SxxEyy 守卫必须先于所有提取模式。否则 "Show S02E01 第1话.mkv" 会先被 CJK 模式
 * 命中 → 当成 abs 1 → 四闸门全绿地把 S2 的第一集错误改名成 S1E01（带完美记分卡的错误改名）。
 * 已含季集码即已分季，本函数一律拒绝，交回上层按正常分季路径处理。
 */
export function parseAbsoluteEpisodeNumber(filename: string): EpisodeNumberMatch | null {
  if (SXXEYY_RE.test(filename)) return null
  if (E_RANGE_RE.test(filename)) return null
  const cjk = CJK_EPISODE_RE.exec(filename)
  if (cjk) return { absoluteEpisode: Number(cjk[1]), matchedToken: cjk[0] }
  const bracket = BRACKET_EPISODE_RE.exec(filename)
  if (bracket) return { absoluteEpisode: Number(bracket[1]), matchedToken: bracket[0] }
  const e = E_CODE_RE.exec(filename)
  if (e) return { absoluteEpisode: Number(e[1]), matchedToken: e[0] }
  return null
}

const VIDEO_EXT_RE = /\.(mkv|mp4|avi|ts|m2ts)$/i

export interface ScannedVideoFile { path: string; filename: string; match: EpisodeNumberMatch | null }

export function scanVideoFiles(dir: string, readdir: (d: string) => string[] = d => readdirSync(d)): ScannedVideoFile[] {
  return readdir(dir)
    .filter(f => VIDEO_EXT_RE.test(f))
    .map(f => ({ path: join(dir, f), filename: f, match: parseAbsoluteEpisodeNumber(f) }))
}

export interface AbsoluteMapEntry { season: number; episode: number }

/**
 * TMDB 季表按季号排序后累计——abs 1..N 依次对应各季 1..episode_count。
 * 不变量检查（累计映射的正确性依赖它们，违反即抛，绝不静默算出错位的表）：
 * 非空；每季 season>0（特别篇不该到这里）且 episodeCount>=0；排序后季号从 1 起严格连续
 * （缺季会让缺口之后的所有绝对集号整体错位到错误的季）。
 */
export function buildAbsoluteMap(seasonTable: SeasonTableEntry[]): Map<number, AbsoluteMapEntry> {
  if (seasonTable.length === 0) {
    throw new Error('buildAbsoluteMap: 季表为空，无从累计绝对集号')
  }
  const sorted = [...seasonTable].sort((a, b) => a.seasonNumber - b.seasonNumber)
  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i]
    if (s.seasonNumber <= 0) {
      throw new Error(`buildAbsoluteMap: 非法季号 ${s.seasonNumber}（特别篇/占位季不该参与累计）`)
    }
    if (s.episodeCount < 0) {
      throw new Error(`buildAbsoluteMap: 第 ${s.seasonNumber} 季集数 ${s.episodeCount} 非法`)
    }
    if (s.seasonNumber !== i + 1) {
      throw new Error(`buildAbsoluteMap: 季号不连续（期望第 ${i + 1} 季，实为第 ${s.seasonNumber} 季）——缺季会使累计映射整体错位`)
    }
  }
  const map = new Map<number, AbsoluteMapEntry>()
  let cursor = 1
  for (const s of sorted) {
    for (let e = 1; e <= s.episodeCount; e++) {
      map.set(cursor, { season: s.seasonNumber, episode: e })
      cursor++
    }
  }
  return map
}

/** Jellyfin 官方口径 + FileBot {jellyfin} 绑定：`剧名 (年份) [tmdbid-XXXX]` —— tmdbid 钉死刮削身份。 */
export function buildTargetShowDir(seriesTitle: string, year: number, tmdbId: string): string {
  return `${seriesTitle} (${year}) [tmdbid-${tmdbId}]`
}

/** `Season NN` 全拼零填充。 */
export function buildTargetSeasonDir(seasonNumber: number): string {
  return `Season ${String(seasonNumber).padStart(2, '0')}`
}

/**
 * 目标文件名：`剧名 (年份) SxxEyy - abs3 - [原文件名去掉集号标记后的残留].ext`。
 * 原绝对集号保留在文件名里（免费的回滚/排障信息，TRaSH 动漫命名同款）；
 * 原画质/组名/CRC 等标记原样保留——做法是把原文件名里"匹配到的集号 token"整体挖掉，
 * 剩下的原样塞进方括号后缀（不重新解析/不重排任何 tag，最大程度保真）。
 */
export function buildTargetFilename(
  seriesTitle: string, year: number, seasonNumber: number, episodeNumber: number,
  absoluteEpisode: number, sourceFilename: string, matchedToken: string,
): string {
  const ext = extname(sourceFilename)
  const base = basename(sourceFilename, ext)
  const remainder = base.split(matchedToken).join(' ').replace(/[_.]+/g, ' ').replace(/\s+/g, ' ').trim()
  const abs3 = String(absoluteEpisode).padStart(3, '0')
  const code = formatEpisodeCode(seasonNumber, episodeNumber)
  const suffix = remainder ? ` - [${remainder}]` : ''
  return `${seriesTitle} (${year}) ${code} - ${abs3}${suffix}${ext}`
}

export interface RealignPlanConfig {
  seriesTitle: string
  year: number
  tmdbId: string
  seasonTable: SeasonTableEntry[]
}

export interface RealignPlanItem {
  sourcePath: string
  sourceFilename: string
  absoluteEpisode: number
  targetSeason: number
  targetEpisode: number
  /** showDir/seasonDir/filename 拼好的相对路径（相对于媒体根）。 */
  targetRelPath: string
}

export type RealignPlanResult =
  | { ok: true; items: RealignPlanItem[]; quarantined: ScannedVideoFile[] }
  | { ok: false; failures: string[] }

/**
 * 确定性闸门(全过才准动一个文件)：映射无重复目标；各季集数 ≤ TMDB 上限（超限的绝对集号
 * 在 absMap 里查不到，直接判失败）；集号集合合理连续。取不出集号的文件进隔离区（quarantined），
 * 不算失败，也不参与后续闸门检查。任一闸门不过 → 整剧不动（ok:false + 全部失败原因）。
 */
export function buildRealignPlan(files: ScannedVideoFile[], config: RealignPlanConfig): RealignPlanResult {
  const quarantined = files.filter(f => f.match == null)
  const parseable = files.filter((f): f is ScannedVideoFile & { match: EpisodeNumberMatch } => f.match != null)
  if (parseable.length === 0) {
    return { ok: false, failures: ['没有任何文件能解析出绝对集号，整理放弃'] }
  }

  const absMap = buildAbsoluteMap(config.seasonTable)
  const showDir = buildTargetShowDir(config.seriesTitle, config.year, config.tmdbId)
  const failures: string[] = []
  const targetSeen = new Map<string, string>()
  const items: RealignPlanItem[] = []

  for (const f of parseable) {
    const mapped = absMap.get(f.match.absoluteEpisode)
    if (!mapped) {
      failures.push(`绝对集号 ${f.match.absoluteEpisode}（文件 ${f.filename}）超出 TMDB 累计集数上限`)
      continue
    }
    const key = `S${mapped.season}E${mapped.episode}`
    if (targetSeen.has(key)) {
      failures.push(`映射目标重复：${key} 同时对应 ${targetSeen.get(key)} 和 ${f.filename}`)
      continue
    }
    targetSeen.set(key, f.filename)
    const filename = buildTargetFilename(
      config.seriesTitle, config.year, mapped.season, mapped.episode,
      f.match.absoluteEpisode, f.filename, f.match.matchedToken,
    )
    items.push({
      sourcePath: f.path, sourceFilename: f.filename, absoluteEpisode: f.match.absoluteEpisode,
      targetSeason: mapped.season, targetEpisode: mapped.episode,
      targetRelPath: join(showDir, buildTargetSeasonDir(mapped.season), filename),
    })
  }
  if (failures.length > 0) return { ok: false, failures }

  const absNumbers = items.map(i => i.absoluteEpisode).sort((a, b) => a - b)
  for (let i = 1; i < absNumbers.length; i++) {
    if (absNumbers[i] - absNumbers[i - 1] > 1) {
      failures.push(`绝对集号不连续：${absNumbers[i - 1]} 之后跳到 ${absNumbers[i]}，疑似缺集或误判，整理放弃`)
    }
  }
  if (failures.length > 0) return { ok: false, failures }

  return { ok: true, items, quarantined }
}

export interface CrossCheckResult { ok: boolean; reason?: string }

/**
 * Fribb anime-lists 交叉验证——按真实数据语义（live anime-list-full.json 实测）：
 * episode_offset.tmdb 是"季内 cour 偏移"，只有 mid-cour 条目才携带；季界条目根本没有该字段。
 * 实测 SPY×FAMILY（tmdb tv 120089）：
 *   anidb 16947（S1 cour 1）→ season.tmdb=1，无 episode_offset；
 *   anidb 17061（S1 cour 2 / Part II）→ season.tmdb=1，episode_offset.tmdb=12（S1 内从第 13 集开始）；
 *   anidb 17784（S2）→ season.tmdb=2，无 episode_offset。
 * 它不是"该季之前的累计集数"，不能拿去对撞累计绝对编号映射——那样会把旗舰验收剧假判冲突。
 * 可行的两源校验是"季内一致性"：带 offset 的条目，其季必须存在于 TMDB 季表，且
 * offset < 该季 episode_count（cour 起点必须落在季内）。S0（特别篇）条目跳过；
 * 无任何可校验条目 = 中性通过（无法交叉验证 ≠ 冲突；非动漫剧种 checkable 恒为空，天然放行）。
 */
export function crossCheckAnimeLists(
  seasonTable: SeasonTableEntry[], animeListsEntries: AnimeListsEntry[], tmdbTvId: number,
): CrossCheckResult {
  const checkable = animeListsEntries.filter(
    (e): e is AnimeListsEntry & { tmdbSeason: number; tmdbEpisodeOffset: number } =>
      e.tmdbTvId === tmdbTvId && e.tmdbSeason != null && e.tmdbEpisodeOffset != null && e.tmdbSeason > 0,
  )
  if (checkable.length === 0) return { ok: true }
  for (const entry of checkable) {
    const season = seasonTable.find(s => s.seasonNumber === entry.tmdbSeason)
    if (!season) {
      return {
        ok: false,
        reason: `anime-lists（anidb ${entry.anidbId}）记录第 ${entry.tmdbSeason} 季存在 cour 偏移 ${entry.tmdbEpisodeOffset}，` +
          `但 TMDB 季表里没有这一季——两源冲突，放弃整理`,
      }
    }
    if (entry.tmdbEpisodeOffset >= season.episodeCount) {
      return {
        ok: false,
        reason: `anime-lists（anidb ${entry.anidbId}）记录第 ${entry.tmdbSeason} 季内 cour 偏移 ${entry.tmdbEpisodeOffset}，` +
          `不小于该季 TMDB 集数 ${season.episodeCount}（cour 起点落在季外）——两源冲突，放弃整理`,
      }
    }
  }
  return { ok: true }
}

/**
 * 可选抽查：实际视频时长 vs TMDB 单集平均时长（episode_run_time），偏差超过 ±10% 才记为失败。
 * getDurationSeconds 拿不到时长（ffprobe 未安装/探测失败）时该文件跳过，不计入 failures——
 * 这是"业界没人做，我们白捡的便宜校验"，抽查性质，不该因为环境缺 ffprobe 就拦掉整理。
 */
export function checkRuntimeTolerance(
  items: Pick<RealignPlanItem, 'sourcePath' | 'sourceFilename'>[],
  expectedRuntimeMinutes: number,
  getDurationSeconds: (path: string) => number | null,
): string[] {
  const failures: string[] = []
  const expectedSeconds = expectedRuntimeMinutes * 60
  for (const item of items) {
    const actual = getDurationSeconds(item.sourcePath)
    if (actual == null) continue
    const diffRatio = Math.abs(actual - expectedSeconds) / expectedSeconds
    if (diffRatio > 0.10) {
      failures.push(
        `文件 ${item.sourceFilename} 实际时长 ${Math.round(actual)}s 与 TMDB 单集时长 ${Math.round(expectedSeconds)}s 偏差超过 10%`,
      )
    }
  }
  return failures
}
