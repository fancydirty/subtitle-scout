/** 规范集号 SxxExx。集号补零到至少 2 位但不截断（上千集动画如 One Piece E1050）。 */
export function formatEpisodeCode(season: number, episode: number): string {
  const s = String(season).padStart(2, '0')
  const e = String(episode).padStart(2, '0')
  return `S${s}E${e}`
}

/** 一季中的一集（由 PlayerAdapter 枚举给出，路径已映射为本地）。 */
export interface SeasonEpisode {
  itemId: string
  seasonNumber: number
  episodeNumber: number
  episodeCode: string
  videoPath: string      // 本地路径（已过 MEDIA_PATH_MAPPINGS）
  videoFilename: string
  needsChinese: boolean
}
