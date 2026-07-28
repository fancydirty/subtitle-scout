import { tool } from 'ai'
import { z } from 'zod'
import { existsSync } from 'node:fs'
import type { LibraryRepo } from '../v2/libraryRepo.js'
import type { TmdbDetails } from '../adapters/providers/tmdb.js'
import { seriesId, episodeId } from '../v2/ownIds.js'
import { coercibleNullableInt } from './coerce.js'

// 注意：embeddedLangs 刻意**不是**输入参数——agent 可能幻觉出 ['chi'] 把条目永久打成
// 'embedded'（terminal covered 态，字幕搜索从此沉默）。权威源是 parked_paths.embedded_langs
// （摄取层 ffprobe raw 数据），由 execute 内部读取。
/** 🔴 identityEval 六轮血案的真根因（2026-07-27）：这个 schema 原本用
 *  `z.number().int().nullable()` 收 season/episode——只接受 JSON null 和真数字。真模型的
 *  实际发法有六种，五种被拒（省略键 / "None"（Python 风格）/ "null" / "" / 字符串数字），
 *  于是 agent **想调写库工具却调不进去**：它试了、被 schema 拒了、把失败写进 finalize 的
 *  reason（实测原话："write_identified_media could not be called because the season/episode
 *  null parameters fail serialization (Python None becomes ...)"）。
 *
 *  我连续六轮把这个现象误判为"agent 不听话"，往 skill 里加了三轮措辞（"不是可选记账"/
 *  "是 FAILED run"/"没字幕也必须写库"），全打在空处——工具的门本来就是关着的。
 *
 *  本仓早有现成解法：coerce.ts 的 coercibleNullableInt 就是为"模型把数字发成字符串/发
 *  None/省略键"写的（见该常量的头注释）。新工具写 schema 时必须复用它，不要重新发明一个
 *  更窄的门。 */
/** 🔴 identityEval 第七轮发现的第二个同类缺陷（2026-07-27）：这个参数原本叫 `path`，要求
 *  agent 交出视频文件的**绝对路径**——而 prompt 出于沙盒纪律**刻意只给相对目录段和
 *  basename**（findSubtitleWorker 的 dirBlock/targetsBlock 都走 relative(task.mediaRoot, …)，
 *  就是为了不泄漏 mediaRoot 以外的路径）。于是 agent 拿不到绝对路径却被要求提供，只能编：
 *  实测 14 次写库调用里 13 次的 path 是 `../../../../../../../../../../Users/...` 这种拼接
 *  幻觉，唯一"对"的那次也是碰巧。
 *
 *  这与 season/episode 的血案是**同一个缺陷类**：向模型索要它按设计根本没有的数据。措辞
 *  再强也补不出信息——所以改成让它报**文件名**（prompt 里确实给了的事实），真实路径由
 *  worker 从 task.targets 解析（resolveTargetPath）。模型只报它知道的，路径由代码给。 */
export const WriteIdentityInputSchema = z.object({
  tmdbId: z.string().regex(/^\d+$/),
  isTv: z.boolean(),
  title: z.string().min(1),
  season: coercibleNullableInt,
  episode: coercibleNullableInt,
  /** 视频文件名（prompt 的 `file:` 段原文）。容忍模型多给路径前缀——resolveTargetPath 按
   *  basename 匹配 task.targets，绝对路径永远来自代码而非模型。 */
  file: z.string().min(1),
})

interface WriteIdentityDeps {
  lib: LibraryRepo
  tmdb: {
    getDetails: (mediaType: 'tv' | 'movie', tmdbId: string) => Promise<TmdbDetails | null>
    getChineseTitles: (mediaType: 'tv' | 'movie', tmdbId: string) => Promise<string[]>
    getExternalIds: (mediaType: 'tv' | 'movie', tmdbId: string) => Promise<{ imdbId: string | null } | null>
    getOriginLanguage: (mediaType: 'tv' | 'movie', tmdbId: string) => Promise<string | null>
  }
  /** 本次 run 的 target 路径表（真实绝对路径，来自 task.targets）。模型报 file 名，代码
   *  在这里解析出路径——绝对路径永不经过模型。 */
  resolveTargetPath: (file: string) => string | null
  /** 行劫持三分支（下方 classifyExistingRow）里"旧文件是否还在磁盘"的判据。测试注入点；
   *  默认真实 existsSync（同 ingest/subtitlePropagation 的既有 fileExists 注入口径）。 */
  fileExists?: (path: string) => boolean
}

/** 行劫持防御（2026-07-28，全库跑前夜）：同一作品的第二份物理文件（NAS + 云盘双持，如
 *  The Conjuring）被识别时，upsertMovie/upsertEpisode 的 ON CONFLICT(id) DO UPDATE SET
 *  path=excluded.path 会静默把既有行的 path 改写成新文件——旧文件从台账消失 → 下轮 ingest
 *  认不出旧路径 → park → agent 重识别 → path 又翻回去……两个文件互相劫持同一行，每轮白烧
 *  一次 LLM 识别（与 1919f86 修的 re-park 空转同病类：账目内耗永动机）。三分支裁决：
 *    'fresh-or-same' —— 无既有行 / path 相同（幂等重识别）→ 照常 upsert
 *    'promote'       —— 有行但旧 path 的文件已从磁盘消失（删除/改名）→ 新 path 合法继承行,
 *                       照常 upsert（这是晋升，不是劫持）
 *    'replica'       —— 有行且旧文件还在 → 这是同一作品的第二份文件：绝不改行,
 *                       addItemFile 入册副本 + 清 park。字幕传播不在这里直接调
 *                       propagateSubtitleToReplica（那要往写库工具穿 probeDuration，
 *                       不成比例）——ingest 的 B3-3 分支每轮按 getItemFileByPath 命中
 *                       已入册副本并幂等触发同一个传播函数，下一轮 pass 必然补上。 */
function classifyExistingRow(
  existingPath: string | undefined,
  newPath: string,
  fileExists: (p: string) => boolean,
): 'fresh-or-same' | 'promote' | 'replica' {
  if (existingPath === undefined || existingPath === newPath) return 'fresh-or-same'
  return fileExists(existingPath) ? 'replica' : 'promote'
}

export function makeWriteIdentityTool(deps: WriteIdentityDeps) {
  return tool({
    description: 'Write the identified media to the database. Call this immediately after you have verified the identity through TMDB evidence (search + details with two-evidence bar). Pass the video file name exactly as shown in the task facts ("file:"). Embedded subtitle languages are read from the parked row (ffprobe data), not from your input. Returns the own-id you must use for subsequent subtitle installation.',
    inputSchema: WriteIdentityInputSchema,
    execute: async (input) => {
      const { tmdbId, isTv, title, season, episode, file } = input
      const { lib, tmdb } = deps

      // 路径由代码解析（模型只报文件名）——报了本 run 不存在的文件名时明确拒绝，
      // 不去猜"它大概是指哪个 target"。
      const path = deps.resolveTargetPath(file)
      if (path === null) {
        throw new Error(`no target in this task matches file "${file}" - pass the file name exactly as shown in the task facts`)
      }

      const mediaType = isTv ? 'tv' : 'movie'

      // TV validation FIRST——在任何网络调用之前（TMDB 配额敏感，别为必败的请求烧一次 getDetails）
      if (isTv && (season === null || episode === null)) {
        throw new Error('TV identification requires season and episode')
      }

      // embeddedLangs 权威源：parked 行的 embedded_langs 列（ffprobe raw 数据的 JSON 数组串）。
      // parked 行不存在 / 列为 NULL（未探测）→ subStatus='missing'，宁可漏判 embedded 也
      // 不可信 agent 自报（幻觉会把条目锁死在 covered 态）。
      const parked = lib.listParkedPaths().find(p => p.path === path)
      let embeddedLangs: string[] | null = null
      if (parked?.embedded_langs) {
        try {
          embeddedLangs = JSON.parse(parked.embedded_langs) as string[]
        } catch {
          embeddedLangs = null // 坏 JSON 按未探测处理，不阻塞识别落地
        }
      }

      // 🔴 幻觉防线：tmdbId 必须在 TMDB 上真实存在
      let details: TmdbDetails | null = null
      try {
        details = await tmdb.getDetails(mediaType, tmdbId)
      } catch (err) {
        throw new Error(`TMDB getDetails failed for ${mediaType}:${tmdbId}`, { cause: err })
      }

      if (details === null) {
        throw new Error(`TMDB ${mediaType}:${tmdbId} does not exist (404) - refusing to create ghost row from hallucinated id`)
      }
      const meta = details // const 别名——narrowing 才能带进下面的事务闭包

      // Enrich from TMDB (non-fatal if these fail)
      let imdbId: string | null = null
      let chineseTitle: string | null = null
      let originLang: string | null = null

      try {
        const extIds = await tmdb.getExternalIds(mediaType, tmdbId)
        imdbId = extIds?.imdbId ?? null
      } catch (err) {
        // Non-fatal
      }

      try {
        const chineseTitles = await tmdb.getChineseTitles(mediaType, tmdbId)
        chineseTitle = chineseTitles?.[0] ?? null
      } catch (err) {
        // Non-fatal
      }

      try {
        originLang = await tmdb.getOriginLanguage(mediaType, tmdbId)
      } catch (err) {
        // Non-fatal
      }

      const providerIds = JSON.stringify({ tmdb: tmdbId, imdb: imdbId })
      const subStatus = embeddedLangs && embeddedLangs.length > 0 ? 'embedded' : 'missing'

      if (isTv) {
        const ownSeriesId = seriesId(tmdbId)
        const ownEpisodeId = episodeId(tmdbId, season!, episode!)

        // 行劫持检查只针对 EPISODE 行（path 在 episodes 上；series 行没有 path 列，series 级
        // upsert 永远只是元数据刷新，无劫持可言）。episode 行存在 ⇒ series 行必然存在（FK），
        // replica 分支跳过 series upsert 也不会缺元数据。
        const existingEp = lib.getEpisode(ownEpisodeId)
        const verdict = classifyExistingRow(existingEp?.path, path, deps.fileExists ?? existsSync)
        if (verdict === 'replica') {
          lib.db.transaction(() => {
            lib.addItemFile(ownEpisodeId, path, Date.now())
            lib.clearParkedPath(path)
          })()
          return (
            `This file is a duplicate copy of existing library row ${ownEpisodeId} ` +
            `(main file: ${existingEp!.path}). It has been registered as a replica; subtitles ` +
            `will be propagated from the main copy automatically. Do NOT search or install ` +
            `subtitles for this target — report it in no_safe_match with reason ` +
            `"duplicate of ${ownEpisodeId}" and proceed to other targets.`
          )
        }
        // verdict === 'promote'（旧文件已消失，新 path 合法继承行）或 'fresh-or-same'
        // （新行/同 path 幂等）→ 照常 upsert。

        // 多语句写入包在一个事务里：parked 清除与建行同生共死，不留"建了一半"的中间态
        lib.db.transaction(() => {
          // Upsert series
          lib.upsertSeries({
            id: ownSeriesId,
            name: title,
            chineseTitle,
            posterPath: meta.posterPath,
            overview: meta.overview,
            backdropPath: meta.backdropPath,
            year: meta.year,
            providerIds,
            genres: meta.genreIds,
          })

          // Set origin language if we got it
          if (originLang) {
            lib.setSeriesOriginLang(ownSeriesId, originLang)
          }

          // Upsert episode
          lib.upsertEpisode({
            id: ownEpisodeId,
            seriesId: ownSeriesId,
            season: season!,
            episode: episode!,
            name: title,
            path,
            subStatus,
          })

          // 🔴 探针记忆必须无条件落地（挂车修复缺陷 A，2026-07-28 生产实证）：此前只在
          // embeddedLangs 非空时才 setProbeMemo——无内嵌轨/未探测（生产大多数文件）的行建出来
          // 就没有 memo，下一轮 ingest CHEAP PATH 必然 miss → FULL PATH 把刚识别完的路径重新
          // park → agent 重新识别 → 无限空转（tmdb:154494/s1e1 covered 行与 parked 行同时
          // 存在，parked 33→43，每批白烧 ~10 个文件的 LLM token）。
          // langs 语义（见 libraryRepo.setProbeMemo/probeMemo）：null=语言轨未探测（诚实），
          // []=探过确认零轨——embeddedLangs 变量本身就是 parked.embedded_langs 的忠实解析
          // （NULL→null，'[]'→[]），直接透传即是诚实映射。
          if (parked?.probe_mtime && parked?.probe_size) {
            lib.setProbeMemo(ownEpisodeId, parked.probe_mtime, parked.probe_size, embeddedLangs)
          }

          // Clear from parked
          lib.clearParkedPath(path)
        })()

        return `Created series ${ownSeriesId} and episode ${ownEpisodeId}. Use "${ownEpisodeId}" as the itemId for subtitle operations.`
      } else {
        const ownMovieId = seriesId(tmdbId) // movies 复用 seriesId 构造器

        // 行劫持检查（movie 行自带 path）——三分支语义见 classifyExistingRow 头注释。
        const existingMovie = lib.getMovie(ownMovieId)
        const movieVerdict = classifyExistingRow(existingMovie?.path, path, deps.fileExists ?? existsSync)
        if (movieVerdict === 'replica') {
          lib.db.transaction(() => {
            lib.addItemFile(ownMovieId, path, Date.now())
            lib.clearParkedPath(path)
          })()
          return (
            `This file is a duplicate copy of existing library row ${ownMovieId} ` +
            `(main file: ${existingMovie!.path}). It has been registered as a replica; subtitles ` +
            `will be propagated from the main copy automatically. Do NOT search or install ` +
            `subtitles for this target — report it in no_safe_match with reason ` +
            `"duplicate of ${ownMovieId}" and proceed to other targets.`
          )
        }

        lib.db.transaction(() => {
          lib.upsertMovie({
            id: ownMovieId,
            name: title,
            path,
            subStatus,
            chineseTitle,
            posterPath: meta.posterPath,
            year: meta.year,
            providerIds,
          })

          if (originLang) {
            lib.setMovieOriginLang(ownMovieId, originLang)
          }

          // 同 TV 分支：memo 无条件落地（挂车修复缺陷 A，langs 直接透传 parked 行的诚实解析）。
          if (parked?.probe_mtime && parked?.probe_size) {
            lib.setProbeMemo(ownMovieId, parked.probe_mtime, parked.probe_size, embeddedLangs)
          }

          lib.clearParkedPath(path)
        })()

        return `Created movie ${ownMovieId}. Use "${ownMovieId}" as the itemId for subtitle operations.`
      }
    },
  })
}
