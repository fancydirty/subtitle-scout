// src/v2/scanner.ts：新架构阶段 1——机械扫描器。
// spec: docs/design/2026-08-08-new-architecture-design.md §4
// 行为照 Jellyfin：遍历守备目录 → 按扩展名过滤 → ffprobe 探测 → 按约定解析结构 → 落 files 表。
// 零身份判断（work_id 恒 NULL，识别 agent 的事）。不符合约定的静默跳过（非媒体文件）。
//
// 核心职责：本文件今天只做 2 和 3，**1 不在这里**（见下方 import 处的说明）。
//  1. walk：遍历守备目录，找到所有媒体文件 —— ⚠️ 实际由 daemonV2 直接调 walkVideoFiles 完成
//  2. parse：按 Jellyfin 约定解析路径结构（work_dir/season/episode/parse_confidence）
//  3. upsert：写入 files 表（指纹 mtime+size 未变则跳过）
//
// parse_confidence 判定（spec-gap M5）：
//  - season+episode 都有 → 'high'（标准 SxxEyy）
//  - 只有 absoluteEpisode → 'low'（季可能丢了，如 "S2 - 07" → abs=7 但 S2 被吞进 title）
//  - 全 null → 'none'（完全没解析出，等 agent 从目录结构推断）
import { parseFilename } from '../recognition/parseFilename.js'
import { detectSeasonFolder } from '../recognition/identifyFromPath.js'
// 2026-08-13 清理：这里原有 `import { walkVideoFiles } from '../daemon/selfScan.js'`，零调用。
// 成因不是"删漏了"，而是**本文件的 walk 步骤从未在这里落地**：spec §4 设想的是一个
// scanner 模块自己吃 ScannerDeps{roots, listVideoFiles, stat, now} 跑完整轮扫描，
// 但真正实现出来的只有下面这几个纯函数（deriveWorkDir / isScannable / parseStructure /
// singleSeasonOf / toMediaFileRow），走盘那一层最后长在了 daemonV2 里
// （daemonV2.ts:1232 `this.deps.listVideoFiles ?? walkVideoFiles`）。
//
// ⚠️ 连带残留：下方 `ScanResult` 与 `ScannerDeps` 两个 interface 是同一个未落地设计的
// 遗物——全仓零引用（daemonV2 消费的只有 toMediaFileRow / isScannable 两个函数）。
// 它们是 `export` 的，所以 noUnusedLocals **抓不到**（编译器只管模块内未读，不管
// 导出后无人 import）。本次不删，因为删导出类型属于 API 面变更、且它俩是"scanner 本该
// 长成什么样"的唯一设计残迹；但记在这里，免得下一个人以为它们有消费方。

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

/** C48：**解析逻辑的版本号**。改动任何影响 parseStructure 产物的规则时 +1。
 *
 *  ── 为什么需要它（本仓招牌病 A 的第 13 次，这次治本）─────────────────────────
 *  scanOnce 的指纹闸（`mtime+size 未变 → continue`）挡在 toMediaFileRow **之前**，
 *  于是解析规则的任何改进对**存量行零作用**：文件躺在 NAS 上不动，mtime/size 永远不变。
 *  2026-08-14 的 cf0453c 修好了日文「話」集号与 CRC32 误判，而生产库那 13 行
 *  （12 个 parse_confidence='none' + 1 个被 CRC 里的 E90 误读成 S1E90）部署后**一行不变**。
 *  这不是"改进没上线"，是"改进永远不会上线"——没有任何通路会重跑解析。
 *
 *  版本号把"这一行是用哪套规则解析的"变成**库里的一等事实**，扫描据此判断该不该重算。
 *  没有它的话，唯一的替代方案是"每轮无条件重解析全库"（不收敛）或"手工写一条一次性
 *  UPDATE 迁移"（下次改解析器时又得记得再写一条，而没有任何测试会在忘记时变红）。
 *
 *  ── 谁写 / 谁读 / 谁触发（本仓已栽 12 次"加了列却没定这三者"，故写死在这里）──
 *   · 谁写：daemonV2.scanOnce **独占**——正常 upsert 路径与 C48 重解析路径都写它，
 *     两条路径都恒写 PARSER_VERSION（写的是"我用哪套规则算的"，不是"算出了什么"）。
 *   · 谁读：daemonV2.scanOnce 的重解析判据（`(row.parser_version ?? 0) < PARSER_VERSION`），
 *     全仓唯一读者。它不是给 UI 看的，也不参与任何业务判决。
 *   · 谁触发：每轮巡检的 scanOnce。存量行（迁移后为 NULL）在**下一轮扫描**被重解析一次，
 *     写上当前版本后即收敛，此后与今天的指纹闸行为逐字相同。
 *
 *  ── 递增它的时机 ──
 *  凡改动 parseFilename / identifyFromPath / deriveWorkDir / parseStructure 中**会改变
 *  已有文件名解析结果**的规则，就 +1。改注释、改错误文案、加只影响新形态的规则时不必
 *  （多递增的代价只是全库跑一遍纯函数，漏递增的代价是这条修复对存量库静默失效——
 *  两种错误的伤害不对称，拿不准时就 +1）。
 *
 *  ── v2（2026-08-18，spec §4.4 / F4 四修）─────────────────────────────────
 *  parseFilename 四处规则修复，全部来自 en 目标巡检的生产实案：
 *   ① R3 WxH 边界闸——'1280x720' 不再拆出 s=80 e=720（Overflow 实案）
 *   ② R1/R5 粘连版本后缀——'S01E04v2' 认出 s=1 e=4（Nukitashi / 芬芳实案）
 *   ③ 集号 ≥ 1 全局闸——'AAC2.0' 的 '0' 不再当 episode=0
 *   ④ R8 小数声道闸——'DDP5.1' 的 '1' 不再当 abs=1（电影变剧集）
 *  四修都会改变已有文件名的解析结果 → 必须递增。依赖既有 C48 机制自动重解析全库存量：
 *  指纹不变（mtime/size 未动），只重算 work_dir/season/episode/parse_confidence，不碰字幕状态。
 *  Overflow / Nukitashi / 芬芳的错行全部自愈。
 *
 *  值取小整数（1→2）而非 commit 号/日期：它只需要**单调递增且可比较**，语义是序数不是时刻。 */
export const PARSER_VERSION = 2

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
    // ⚠️ audio_langs 现状（2026-08 定位报告，**待用户裁决，先别当它是活的**）：
    // 全仓**零写入者、零读取者**——除了 db.ts 的 schema 声明（:154 / :529）和这一行恒为 null
    // 的赋值，没有任何代码写它，也没有任何代码读它。这是本仓第 5 例"写了列没定谁写"
    // （前四例：C12 → C35 → D17 → D18）。与 embedded_langs 不同，那一列有 probeNewOrChanged +
    // backfillEmbeddedLangs 两条写入通路和 judge/D9 两个读者；这一列一条都没有。
    // 裁决未定（"接一个写入者（ffprobe 音轨语言）" vs "删列"），本批**不动**。
    // 别照 embeddedLangs 的样子给它接探针——先等裁决，否则又是一列没人读的数据。
    audioLangs: null,
    workDir: s.workDir,
    season: s.season,
    episode: s.episode,
    parseConfidence: s.parseConfidence,
  }
}
