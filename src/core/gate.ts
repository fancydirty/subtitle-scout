import type { SubtitleCandidate, MediaIdentity, RankDecision, IdentityMatch } from './schemas.js'
import { candidateKey } from './schemas.js'

export interface GateQueueItem {
  candidate: SubtitleCandidate
  fileIndex: number | null
  identityMatch: IdentityMatch
}

export interface GateResult {
  ok: boolean
  /** ok=false 时的降级 decision；ok=true 时恒为 'proceed'——真正的下载/验证结论在
   *  pipeline.ts 的候选队列循环里产生，gate 只负责把 rank.order 校验成安全可试的队列。 */
  decision: 'proceed' | 'no_safe_match'
  failures: string[]
  queue: GateQueueItem[]
}

/** 纯代码硬校验 agent 的排序输出，产出一份结构合法、按偏好排序的候选队列。身份判决
 *  保留"是/不是"两态：mismatch 永不进队列（即便 LLM 违反 prompt 把它塞进 order[]，这里
 *  也防御性剔除）；confirmed/uncertain 一视同仁排队待验——"拿不准"不是终态，是"还没看
 *  仔细"，下游一律走 stage→inspect→verify 终审。单项结构失败（candidate_id 找不到/
 *  file_index 越界）只丢弃那一项，不拖垮整个队列；全部候选都被丢弃才是 no_safe_match。 */
export function runGate(
  rank: RankDecision, candidates: SubtitleCandidate[], identity: MediaIdentity,
): GateResult {
  if (identity.type === 'episode' && (identity.season == null || identity.episode == null)) {
    return {
      ok: false, decision: 'no_safe_match',
      failures: ['episode media without resolved season/episode cannot be auto-downloaded'],
      queue: [],
    }
  }

  const queue: GateQueueItem[] = []
  const failures: string[] = []
  const seen = new Set<string>()

  for (const item of rank.order) {
    if (item.identity_match === 'mismatch') {
      failures.push(`candidate_id ${item.candidate_id} identity verdict mismatch — dropped defensively (rank should not have queued it)`)
      continue
    }

    let candidate = candidates.find(c => candidateKey(c) === item.candidate_id)
    // LLM 自愈：模型偶尔丢 "provider:" 前缀只回裸 providerId——不含冒号时按 providerId
    // 兜底匹配。仅恰好一个候选命中才自愈；2+ 命中（跨 provider id 碰撞）视为找不到——
    // fail closed（跳过这一项，不是整个队列）。
    if (!candidate && item.candidate_id != null && !item.candidate_id.includes(':')) {
      const matches = candidates.filter(c => c.providerId === item.candidate_id)
      if (matches.length === 1) {
        candidate = matches[0]
      } else if (matches.length > 1) {
        failures.push(`candidate_id ${item.candidate_id} is ambiguous: matches ${matches.length} candidates across providers (${matches.map(candidateKey).join(', ')})`)
        continue
      }
    }
    if (!candidate) {
      failures.push(`candidate_id ${item.candidate_id} is not in this search's candidate set`)
      continue
    }

    if (candidate.fileList.length > 0) {
      if (item.file_index == null || item.file_index < 0 || item.file_index >= candidate.fileList.length) {
        failures.push(`file_index ${item.file_index} out of range for filelist of ${candidate.fileList.length} (candidate ${item.candidate_id})`)
        continue
      }
    }
    if (candidate.fileList.length === 0 && item.file_index != null && item.file_index !== 0) {
      failures.push(`file_index ${item.file_index} given but candidate ${item.candidate_id} has no filelist`)
      continue
    }

    const resolvedFileIndex = item.file_index ?? null
    // 配额保护：模型可能把同一候选写两次（字面重复行，或全 id + 裸 id 各写一次——
    // 裸 id 自愈后指向同一候选）。按"解析后的候选身份 + fileIndex"去重，保留首次出现的
    // 顺序/理由，防止 tryCandidateQueue 对同一候选重复下载+重复终审，白烧 OpenSubtitles
    // 20/天配额。
    const dedupeKey = `${candidateKey(candidate)}#${resolvedFileIndex}`
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)

    queue.push({ candidate, fileIndex: resolvedFileIndex, identityMatch: item.identity_match })
  }

  if (queue.length === 0) {
    return {
      ok: false, decision: 'no_safe_match',
      failures: failures.length > 0 ? failures : ['rank produced no usable candidates'],
      queue: [],
    }
  }
  return { ok: true, decision: 'proceed', failures, queue }
}
