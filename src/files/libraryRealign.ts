import { readdirSync } from 'node:fs'
import { extname, basename, join } from 'node:path'
import { formatEpisodeCode } from '../core/episode.js'
import type { SeasonTableEntry } from '../adapters/providers/tmdb.js'

export interface EpisodeNumberMatch { absoluteEpisode: number; matchedToken: string }

const CJK_EPISODE_RE = /第\s*(\d{1,4})\s*[话話集]/
const SXXEYY_RE = /S\d{1,4}E\d{1,4}/i
const BRACKET_EPISODE_RE = /\[(\d{1,4})\]/
const E_CODE_RE = /(?<![A-Za-z0-9])E(\d{1,4})(?!\d)/i

/**
 * 从文件名解析绝对集号——只认三种确定性标记（CJK "第N话/第N集" > 方括号 [NN] > 裸 "E26"），
 * 取不出就返回 null，绝不猜（隔离区伺候）。已经是 SxxEyy 记法的文件不是"绝对编号平铺"问题
 * 的目标（本身已分季），直接判 null。合集/范围记法（"01-02"）三种模式都不命中，天然落入 null。
 */
export function parseAbsoluteEpisodeNumber(filename: string): EpisodeNumberMatch | null {
  const cjk = CJK_EPISODE_RE.exec(filename)
  if (cjk) return { absoluteEpisode: Number(cjk[1]), matchedToken: cjk[0] }
  if (SXXEYY_RE.test(filename)) return null
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

/** TMDB 季表按季号排序后累计——abs 1..N 依次对应各季 1..episode_count。 */
export function buildAbsoluteMap(seasonTable: SeasonTableEntry[]): Map<number, AbsoluteMapEntry> {
  const sorted = [...seasonTable].sort((a, b) => a.seasonNumber - b.seasonNumber)
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
