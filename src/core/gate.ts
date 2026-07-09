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

  if (failures.length > 0) return { ok: false, decision: 'no_safe_match', failures }

  if (rank.confidence < prefs.auto_download_min_confidence) {
    return {
      ok: false, decision: 'ask_user',
      failures: [`confidence ${rank.confidence} below threshold ${prefs.auto_download_min_confidence}`],
    }
  }
  return { ok: true, decision: 'download', failures: [], candidate }
}
