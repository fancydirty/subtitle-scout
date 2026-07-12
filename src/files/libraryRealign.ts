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
