import { basename } from 'node:path'
import type { SeasonEpisode } from './episode.js'

const SUBTITLE_EXT = /\.(srt|ass|ssa)$/i

export interface SeasonMapPair { filelist_index: number; episode_code: string; confidence: number; reason: string }
export interface SeasonMapLike { pairs: SeasonMapPair[]; unmapped_files?: number[]; reasons?: string[] }
export interface SeasonPackFile { f: string; url?: string }

export interface SeasonPackCommitItem {
  episodeCode: string
  filelistIndex: number
  filename: string
  downloadUrl: string
  videoPath: string
  videoFilename: string
}
export interface SeasonPackGateResult {
  commit: SeasonPackCommitItem[]
  dropped: { episodeCode?: string; filelistIndex?: number; reason: string }[]
}
export interface SeasonPackGateInput {
  map: SeasonMapLike
  filelist: SeasonPackFile[]
  seasonEpisodes: SeasonEpisode[]
  minConfidence: number
}

/**
 * 按 episodeCode 集合 join（非位置对齐）+ 逐项校验 + verify-then-commit，产出安全提交集。
 * 防"整季串号"：缺集只是该 code 未覆盖，不会让其余集下滑。逐项软失败进 dropped[]，绝不整批作废。
 */
export function runSeasonPackGate(input: SeasonPackGateInput): SeasonPackGateResult {
  const { map, filelist, seasonEpisodes, minConfidence } = input
  const needSet = new Map<string, SeasonEpisode>()
  for (const e of seasonEpisodes) if (e.needsChinese) needSet.set(e.episodeCode, e)

  const commit: SeasonPackCommitItem[] = []
  const dropped: SeasonPackGateResult['dropped'] = []
  const bestByCode = new Map<string, { pair: SeasonMapPair; item: SeasonPackCommitItem }>()

  for (const pair of map.pairs ?? []) {
    const tag = { episodeCode: pair.episode_code, filelistIndex: pair.filelist_index }
    if (!Number.isInteger(pair.filelist_index) || pair.filelist_index < 0 || pair.filelist_index >= filelist.length) {
      dropped.push({ ...tag, reason: `filelist_index out of range` }); continue
    }
    const file = filelist[pair.filelist_index]
    if (!SUBTITLE_EXT.test(file.f)) { dropped.push({ ...tag, reason: `not a subtitle file: ${file.f}` }); continue }
    if (!file.url) { dropped.push({ ...tag, reason: `no download url for ${file.f}` }); continue }
    const episode = needSet.get(pair.episode_code)
    if (!episode) { dropped.push({ ...tag, reason: `episode_code not in season (or already subbed): ${pair.episode_code}` }); continue }
    if (pair.confidence < minConfidence) { dropped.push({ ...tag, reason: `confidence ${pair.confidence} < ${minConfidence}` }); continue }
    const item: SeasonPackCommitItem = {
      episodeCode: pair.episode_code, filelistIndex: pair.filelist_index,
      filename: basename(file.f), downloadUrl: file.url,
      videoPath: episode.videoPath, videoFilename: episode.videoFilename,
    }
    const prev = bestByCode.get(pair.episode_code)
    if (!prev || pair.confidence > prev.pair.confidence) {
      if (prev) dropped.push({ episodeCode: prev.pair.episode_code, filelistIndex: prev.pair.filelist_index, reason: 'duplicate episode_code, kept higher confidence' })
      bestByCode.set(pair.episode_code, { pair, item })
    } else {
      dropped.push({ ...tag, reason: 'duplicate episode_code, kept higher confidence' })
    }
  }
  for (const { item } of bestByCode.values()) commit.push(item)
  return { commit, dropped }
}
