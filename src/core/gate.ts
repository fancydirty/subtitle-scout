import type { SubtitleCandidate, MediaIdentity, RankDecision, IdentityMatch } from './schemas.js'
import { candidateKey } from './schemas.js'
import { formatEpisodeCode, matchesEpisodeCode } from './episode.js'

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

    let resolvedFileIndex = item.file_index ?? null

    // position-vs-i 混淆兜底（生产事故：LLM 把展示位置和条目自带的 i 值搞混，装错成相邻的
    // 另一集）。截断后 prompt 里展示顺序（"第几条"）不再等于条目的 i 值（截断丢了中间条目，
    // 剩下的 i 值不连续）。上面 63-68 行的范围校验只保证 file_index 落在 [0, fileList.length)
    // 之内——这挡不住"in-range 但选错位置"这种越界，模型偶尔会报出一个恰好在范围内、但实际
    // 指向邻集（如报 E04 的位置却以为在报 E05）的 file_index，静默通过并在下游按数组下标
    // （index === array position，见 schemas.ts SubtitleFileSchema）装错文件。
    // 用完整（未经 rank 精简/截断）fileList 反查目标集号是否存在于这个候选里：
    //  - 目标集号在这个候选里查无实据（如裸文件名 "简体.srt"）→ 兜底不介入，维持原行为；
    //  - 选中的条目本身就匹配目标集号 → 放行，不干预；
    //  - 不匹配，且只有一个条目匹配目标集号 → 唯一解，自动纠偏 file_index 并在 failures 记一笔；
    //  - 不匹配，且 2+ 条目匹配目标集号 → 无法安全判定选的是哪个，整项拒绝而非瞎猜（fail-closed，
    //    队列继续尝试下一候选）。
    if (identity.type === 'episode' && identity.season != null && identity.episode != null && candidate.fileList.length > 1) {
      const targetCode = formatEpisodeCode(identity.season, identity.episode)
      const matchingFiles = candidate.fileList.filter(f => matchesEpisodeCode(f.name, targetCode))
      if (matchingFiles.length > 0) {
        const chosen = resolvedFileIndex != null ? candidate.fileList[resolvedFileIndex] : undefined
        const chosenMatches = chosen != null && matchesEpisodeCode(chosen.name, targetCode)
        if (!chosenMatches) {
          if (matchingFiles.length === 1) {
            const remap = matchingFiles[0]
            failures.push(`candidate ${item.candidate_id}: file_index ${resolvedFileIndex} ("${chosen?.name ?? 'n/a'}") does not match target episode ${targetCode}; auto-remapped to the only filelist entry that does — file_index ${remap.index} ("${remap.name}")`)
            resolvedFileIndex = remap.index
          } else {
            failures.push(`candidate ${item.candidate_id}: file_index ${resolvedFileIndex} does not match target episode ${targetCode}, and ${matchingFiles.length} other filelist entries do — rejecting rather than guessing which one was meant`)
            continue
          }
        }
      }
    }

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
