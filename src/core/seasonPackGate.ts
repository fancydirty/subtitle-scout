import { basename } from 'node:path'
import type { SeasonEpisode } from './episode.js'

const SUBTITLE_EXT = /\.(srt|ass|ssa)$/i

export interface SeasonMapPair { filelist_index: number; episode_code: string; reason: string }
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
}

/**
 * 按 episodeCode 集合 join（非位置对齐）+ 逐项校验 + verify-then-commit，产出安全提交集。
 * 防"整季串号"：缺集只是该 code 未覆盖，不会让其余集下滑。逐项软失败进 dropped[]，绝不
 * 整批作废。重复 episode_code 时保留 pairs[] 里先出现的那个——排序本身就是模型的偏好
 * 表达（它把更有把握的排前面），不需要再叠一层数字去比较。
 */
export function runSeasonPackGate(input: SeasonPackGateInput): SeasonPackGateResult {
  const { map, filelist, seasonEpisodes } = input
  const needSet = new Map<string, SeasonEpisode>()
  for (const e of seasonEpisodes) if (e.needsChinese) needSet.set(e.episodeCode, e)

  const commit: SeasonPackCommitItem[] = []
  const dropped: SeasonPackGateResult['dropped'] = []
  const seenCodes = new Set<string>()

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
    if (seenCodes.has(pair.episode_code)) {
      dropped.push({ ...tag, reason: 'duplicate episode_code, kept first occurrence' }); continue
    }
    seenCodes.add(pair.episode_code)
    commit.push({
      episodeCode: pair.episode_code, filelistIndex: pair.filelist_index,
      filename: basename(file.f), downloadUrl: file.url,
      videoPath: episode.videoPath, videoFilename: episode.videoFilename,
    })
  }
  return { commit, dropped }
}
