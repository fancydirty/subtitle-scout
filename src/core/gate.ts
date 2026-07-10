import type { AssrtSub, MediaIdentity, MediaContext, RankDecision } from './schemas.js'

export interface GateResult {
  ok: boolean
  /** ok=false 时的降级 decision */
  decision: 'download' | 'ask_user' | 'no_safe_match'
  failures: string[]
  candidate?: AssrtSub
}

/** 纯代码硬校验 agent 的排序输出。任何一条不过就绝不落盘。 */
export function runGate(
  rank: RankDecision,
  candidates: AssrtSub[],
  identity: MediaIdentity,
  prefs: MediaContext['preferences'],
): GateResult {
  if (rank.decision !== 'download') {
    return { ok: false, decision: rank.decision, failures: [] }
  }
  const failures: string[] = []
  const candidate = candidates.find(c => c.id === rank.assrt_id)
  if (!candidate) failures.push(`assrt_id ${rank.assrt_id} is not in this search's candidate set`)

  if (candidate && candidate.filelist.length > 0) {
    if (rank.file_index == null || rank.file_index < 0 || rank.file_index >= candidate.filelist.length) {
      failures.push(`file_index ${rank.file_index} out of range for filelist of ${candidate.filelist.length}`)
    }
  }

  if (identity.type === 'episode' && (identity.season == null || identity.episode == null)) {
    failures.push('episode media without resolved season/episode cannot be auto-downloaded')
  }

  // 结构性硬校验优先，且身份判决绝不能越过它：LLM 说 confirmed 也不许下载幻觉出的 assrt_id。
  if (failures.length > 0) return { ok: false, decision: 'no_safe_match', failures }

  // 身份三态判决取代标量置信分做主闸（M5b 法条：来源/分辨率/压制组/版本差异不改变身份）。
  // confidence 降级为参考量，仅在 uncertain 兜底路径里仍起作用。
  switch (rank.identity_match) {
    case 'mismatch':
      // 明确错作品/错季/错集——防串号铁律：错字幕比没字幕伤害大。
      return {
        ok: false, decision: 'no_safe_match',
        failures: [`identity verdict: mismatch — candidate is a different work/season/episode`],
      }
    case 'confirmed':
      // 同作品+正确季集（或整包覆盖目标集）：无视标量分直接放行。
      return { ok: true, decision: 'download', failures: [], candidate }
    case 'uncertain':
    default:
      // 信息不足——沿用旧标量门给拿不准的情形兜底。
      if (rank.confidence < prefs.auto_download_min_confidence) {
        return {
          ok: false, decision: 'ask_user',
          failures: [`identity uncertain and confidence ${rank.confidence} below threshold ${prefs.auto_download_min_confidence}`],
        }
      }
      return { ok: true, decision: 'download', failures: [], candidate }
  }
}
