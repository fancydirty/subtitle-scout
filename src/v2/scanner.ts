// src/v2/scanner.ts：新架构阶段 1——机械扫描器。
// spec: docs/design/2026-08-08-new-architecture-design.md §4
// 行为照 Jellyfin：遍历守备目录 → 按扩展名过滤 → ffprobe 探测 → 按约定解析结构 → 落 files 表。
// 零身份判断（work_id 恒 NULL，识别 agent 的事）。不符合约定的静默跳过（非媒体文件）。
//
// 核心职责（三件事）：
//  1. walk：遍历守备目录，找到所有媒体文件（复用 walkVideoFiles）
//  2. parse：按 Jellyfin 约定解析路径结构（work_dir/season/episode/parse_confidence）
//  3. upsert：写入 files 表（指纹 mtime+size 未变则跳过）
//
// parse_confidence 判定（spec-gap M5）：
//  - season+episode 都有 → 'high'（标准 SxxEyy）
//  - 只有 absoluteEpisode → 'low'（季可能丢了，如 "S2 - 07" → abs=7 但 S2 被吞进 title）
//  - 全 null → 'none'（完全没解析出，等 agent 从目录结构推断）
import { parseFilename } from '../recognition/parseFilename.js'
import { detectSeasonFolder } from '../recognition/identifyFromPath.js'
import { walkVideoFiles } from '../daemon/selfScan.js'

export interface ScanResult {
  scanned: number      // 走到的文件数
  upserted: number     // 新插入或更新的行数
  skipped: number      // 静默跳过（非媒体/系统目录）
  unchanged: number    // 指纹未变跳过
}

export interface ScannerDeps {
  roots: string[]
  listVideoFiles?: (root: string) => string[]
  stat?: (p: string) => { mtimeMs: number; size: number } | null
  now?: () => number
}

/** 从文件路径推导 work_dir（作品根）——从文件所在目录向上爬，跳过分类桶与季目录。
 *  spec-gap M1：复用了原 workUnit.ts workRootOf 的思想，但改成"入库时算好"。
 *  分类桶：tv/movies/anime/电视剧 等；季目录：Season NN/S01/第N季 等。 */
export function deriveWorkDir(
  videoPath: string,
  roots: readonly string[],
): string {
  const dir = videoPath.slice(0, videoPath.lastIndexOf('/'))
  const matchingRoot = roots
    .filter((r) => dir === r || dir.startsWith(r + '/'))
    .sort((a, b) => b.length - a.length)[0]
  if (!matchingRoot) return dir // 不在任何根内：退化为文件所在目录
  // 从匹配根往下逐层走，第一个"既非分类桶、也非季目录"的层就是作品根
  const rel = dir.slice(matchingRoot.length).split('/').filter(Boolean)
  let current = matchingRoot
  for (const seg of rel) {
    current = `${current}/${seg}`
    const lower = seg.toLowerCase()
    if (CATEGORY_DIRS.has(lower)) continue
    if (detectSeasonFolder(seg) !== null) {
      // 季目录：作品根在它之上（上一层）
      return current.slice(0, current.length - seg.length - 1)
    }
    return current
  }
  return current
}

/** 分类目录名（"装剧的桶"，不是作品名）——照 CATEGORY_DIR_NAMES（identifyFromPath.ts）的形态。 */
const CATEGORY_DIRS = new Set([
  'tv', 'tvshows', 'tv shows', 'shows', 'series', 'movies', 'movie', 'films', 'film',
  'anime', 'animation', 'cartoons',
  '电视剧', '剧集', '电视', '电影', '动漫', '动画', '番剧', '番组', '美剧', '日剧', '韩剧', '英剧',
])

/** 非媒体扩展名/系统目录的静默跳过判据（spec-gap B1）：
 *  1. 扩展名不在媒体白名单 → 跳过（非媒体）
 *  2. 文件 < 10MB → 跳过（疑似垃圾/探针残留）
 *  3. 路径含系统/隐藏目录段 → 跳过
 *  其余一律入库（parseFilename 解析不出不是跳过理由，那是 confidence 的事）。 */
export function isScannable(
  videoPath: string,
  size: number,
): { ok: true } | { ok: false; reason: string } {
  const lower = videoPath.toLowerCase()
  for (const junk of ['.subtitle-staging', '.thumbnails', '@eadir', '/node_modules/', '/.git/']) {
    if (lower.includes(junk)) return { ok: false, reason: `system dir: ${junk}` }
  }
  if (size > 0 && size < 10 * 1024 * 1024) return { ok: false, reason: `too small: ${size}B` }
  return { ok: true }
}

export interface ParsedStructure {
  workDir: string
  season: number | null
  episode: number | null
  parseConfidence: 'high' | 'low' | 'none'
}

/** 解析路径结构（照 Jellyfin 约定 + parse_confidence 判定）。 */
export function parseStructure(
  videoPath: string,
  roots: readonly string[],
  listDir?: (dir: string) => string[],
): ParsedStructure {
  const workDir = deriveWorkDir(videoPath, roots)
  const filename = videoPath.slice(videoPath.lastIndexOf('/') + 1)
  const parsed = parseFilename(filename)
  if (parsed.season != null && parsed.episode != null) {
    return { workDir, season: parsed.season, episode: parsed.episode, parseConfidence: 'high' }
  }
  if (parsed.absoluteEpisode != null) {
    // 裸集号：若 work_dir 下只有一个 Season 目录，可机械安全归到该季（Jellyfin 对
    // Gachiakuta 的实测做法：父目录唯一季 → 裸集号归 S1）。这是"唯一季推导"。
    // 多季目录或季目录与文件同级时无法机械确定，留 low 等 agent。
    const season = singleSeasonOf(videoPath, listDir)
    if (season !== null) {
      return { workDir, season, episode: parsed.absoluteEpisode, parseConfidence: 'high' }
    }
    return { workDir, season: null, episode: null, parseConfidence: 'low' }
  }
  return { workDir, season: null, episode: null, parseConfidence: 'none' }
}

/** 唯一季推导：文件所在目录如果只有一个 Season 目录，返回该季号；否则 null。
 *  这是"从路径结构看，裸集号可以安全归到哪一季"的机械判据（spec-gap M5 的加强）。
 *  两种情况：
 *  ① 文件在 Season XX/ 子目录下 → 该目录本身就是季（无 fs 调用）
 *  ② 文件在作品根下（扁平）→ 数作品根下有几个 Season 目录（需 fs，listDir 注入） */
export function singleSeasonOf(
  videoPath: string,
  listDir?: (dir: string) => string[],
): number | null {
  const dir = videoPath.slice(0, videoPath.lastIndexOf('/'))
  const dirBase = dir.slice(dir.lastIndexOf('/') + 1)
  const seasonFromDir = detectSeasonFolder(dirBase)
  if (seasonFromDir !== null) return seasonFromDir
  if (!listDir) return null // 无 fs 能力（纯字符串场景）→ 无法判
  try {
    const entries = listDir(dir)
    const seasons = entries
      .map((e) => detectSeasonFolder(e))
      .filter((s): s is number => s !== null)
    if (seasons.length === 1) return seasons[0]
    return null
  } catch {
    return null
  }
}

// ---- 扫描主流程：遍历 → 解析 → 探测 → 落 files 表 ----

export interface MediaFileRow {
  path: string
  dir: string
  filename: string
  size: number
  mtime: number
  durationSec: number | null
  embeddedLangs: string[] | null
  audioLangs: string[] | null
  workDir: string
  season: number | null
  episode: number | null
  parseConfidence: 'high' | 'low' | 'none'
}

/** 把一个文件解析成 MediaFileRow（不含探测——探测是异步的，调用方决定何时做）。 */
export function toMediaFileRow(
  videoPath: string,
  stat: { mtimeMs: number; size: number },
  roots: readonly string[],
): MediaFileRow {
  const s = parseStructure(videoPath, roots)
  const dir = videoPath.slice(0, videoPath.lastIndexOf('/'))
  const filename = videoPath.slice(videoPath.lastIndexOf('/') + 1)
  return {
    path: videoPath,
    dir,
    filename,
    size: stat.size,
    mtime: Math.round(stat.mtimeMs),
    durationSec: null,
    embeddedLangs: null,
    audioLangs: null,
    workDir: s.workDir,
    season: s.season,
    episode: s.episode,
    parseConfidence: s.parseConfidence,
  }
}
