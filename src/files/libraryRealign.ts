import { readdirSync } from 'node:fs'
import { join } from 'node:path'

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
