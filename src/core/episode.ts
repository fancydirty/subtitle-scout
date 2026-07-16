/** 规范集号 SxxExx。集号补零到至少 2 位但不截断（上千集动画如 One Piece E1050）。 */
export function formatEpisodeCode(season: number, episode: number): string {
  const s = String(season).padStart(2, '0')
  const e = String(episode).padStart(2, '0')
  return `S${s}E${e}`
}

/** 从形如 "S02E05" 的规范集号拆出 season/episode 数值。集号可超过两位（长篇动画如 One Piece E1050）。 */
export function parseCanonicalEpisodeCode(code: string): { season: number; episode: number } | null {
  const m = /^S(\d{1,4})E(\d{1,4})$/i.exec(code.trim())
  if (!m) return null
  return { season: Number(m[1]), episode: Number(m[2]) }
}

/**
 * 容错集号匹配：候选文件名/元数据里的集号写法五花八门——大小写不敏感的 SxxEyy，以及 NxM 记法
 * （如 "2x05"）。原先 f.name.includes(assignment.episode_code) 是大小写敏感的精确子串匹配，会把
 * 常见的全小写发布命名（"show.s02e05.chs.srt"）误判为"无匹配"而跳过——相对 main 的覆盖率倒退。
 *
 * 边界防护：用非数字前瞻/后顾包住整个数字序列，防止 "s02e05" 误配 "s02e050"（长集号截断出的假阳性），
 * 也防止 NxM 记法里季号被吞进更大的数字（如目标季 2，误配 "12x05" 里的 "2x05" 子串）。
 *
 * 有意不支持的记法（收窄以控制误伤面，而非遗漏）：
 * - 裸 "E05"（无季号）——候选池经常跨季，无季号时指代不明，认领错季的代价远大于漏检一个候选。
 * - 中文"第N集"——分季语义不明确（"第5集"可能是第几季的第5集未说明），且"话/集/合集"等变体
 *   混杂，数字边界不如 SxxEyy/NxM 可靠，误伤率评估下来高于收益。
 *
 * 复用点：agent/findSubtitleWorker.tools.ts 的候选文件名安全性判定（下载前校验 filename 里的
 * 集号确实是这一集）。历史上还服务过旧管线 pipeline.ts 的季横扫/季包升格 assignment 校验、
 * rankCandidates.ts 的 compactCandidates() relevance-aware filelist 预筛——两者均已随旧管线
 * 退役删除，但当年促成这条函数收窄记法（非数字前瞻/后顾边界）的真实事故仍值得记录：
 * assrt:635301 一个 72 文件的 True Detective S3 全季包，filelist 被盲截前 30 条喂给 rank 的
 * LLM，E05-E08 的文件全部落在截断线之外、永远不可见——LLM 只能吐 file_index:null，gate 判
 * "out of range" 永久卡死后半季（gate.ts 同样已随旧管线退役删除，此处只留事故本身的教训）。
 */
export function matchesEpisodeCode(text: string, episodeCode: string): boolean {
  if (!text) return false
  const parsed = parseCanonicalEpisodeCode(episodeCode)
  if (!parsed) return false
  const { season, episode } = parsed
  const patterns = [
    new RegExp(`(?<![0-9])s0*${season}e0*${episode}(?![0-9])`, 'i'), // SxxEyy（大小写不敏感，零填充不定）
    new RegExp(`(?<![0-9])0*${season}x0*${episode}(?![0-9])`, 'i'),  // NxM，如 "2x05"
  ]
  return patterns.some(re => re.test(text))
}
