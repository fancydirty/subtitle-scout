import type { LlmRuntime } from './runtime.js'
import {
  RankDecisionSchema, type MediaContext, type MediaIdentity, type SubtitleCandidate, type RankDecision,
  candidateKey,
} from '../core/schemas.js'
import type { CallStructuredResult } from './llm.js'

export const MAX_CANDIDATES = 15
export const MAX_FILELIST_ENTRIES = 30

const TEXT_SUB_EXT = /\.(srt|ass|ssa)$/i
const GRAPHIC_SUBTYPE = /pgs|vobsub|pgssub/i

/**
 * 候选是否"仅图形字幕"（本产品只处理文本字幕）。保守判定：
 * - 含任一文本扩展名 → 可用（false），即便包内混有图形文件；
 * - 全非文本且命中图形签名（PGS .sup，或 VobSub .idx+.sub 成对）→ 剔除（true）；
 * - 孤立 .sub / 未知扩展 → 不剔（交 rank）；
 * - filelist 为空时仅当 subtype 明确图形才剔。subtype=None/缺失从不作为剔除依据。
 */
export function isGraphicOnly(c: SubtitleCandidate): boolean {
  const names = c.fileList.map(f => f.name)
  if (names.some(n => TEXT_SUB_EXT.test(n))) return false
  if (names.length > 0) {
    const hasSup = names.some(n => /\.sup$/i.test(n))
    const hasIdx = names.some(n => /\.idx$/i.test(n))
    const hasSub = names.some(n => /\.sub$/i.test(n))
    return hasSup || (hasIdx && hasSub)
  }
  return !!c.subtype && GRAPHIC_SUBTYPE.test(c.subtype)
}

/** 剔除仅图形字幕的候选，保序。 */
export function filterGraphicOnly(candidates: SubtitleCandidate[]): SubtitleCandidate[] {
  return candidates.filter(c => !isGraphicOnly(c))
}

export function compactCandidates(candidates: SubtitleCandidate[]): Array<{
  id: string
  provider: string
  videoname: string | null | undefined
  native_name: string | null | undefined
  lang: string | null | undefined
  subtype: string | null | undefined
  release_site: string | null | undefined
  filelist: string[]
  filelist_truncated?: number
}> {
  return candidates.slice(0, MAX_CANDIDATES).map(c => {
    const files = c.fileList.map(f => f.name)
    const shown = files.slice(0, MAX_FILELIST_ENTRIES)
    return {
      id: candidateKey(c),
      provider: c.provider,
      videoname: c.videoName,
      native_name: c.nativeName,
      lang: c.language,
      subtype: c.subtype,
      release_site: c.releaseSite,
      filelist: shown,
      ...(files.length > shown.length ? { filelist_truncated: files.length - shown.length } : {}),
    }
  })
}

export async function rankCandidates(
  llm: LlmRuntime, ctx: MediaContext, identity: MediaIdentity, candidates: SubtitleCandidate[],
): Promise<CallStructuredResult<RankDecision>> {
  const compact = compactCandidates(candidates)
  const prompt = [
    'Choose the best Chinese subtitle for this media from multi-source candidates (fields: id = "<provider>:<providerId>"), or refuse.',
    'A WRONG subtitle is worse than NO subtitle — but refusing a usable one is also a failure.',
    '',
    'FORMAT — which candidates are usable:',
    '- Text subtitles (srt / ass / ssa, including those extensions inside filelist) are ALL usable.',
    '- subtype=None or missing is NOT a reason to reject — it is usually an effect/styled .ass.',
    '- Only truly graphic-only packs (PGS .sup, VobSub .idx+.sub) are unusable, and those have',
    '  already been filtered out before you see them; assume every candidate here has text.',
    '',
    'MATCHING — what is and is NOT a rejection reason:',
    '- Resolution / source (BluRay vs WEB-DL) / codec / release-group differences are NOT rejection',
    '  reasons. The same film\'s subtitle timing is generally interchangeable across these.',
    '- REAL risks that justify rejection: director\'s-cut vs theatrical runtime gaps, and for episodes',
    '  a season/episode mismatch (season AND episode must match exactly).',
    '- If a candidate is a pack (filelist has multiple files), you MUST pick the specific file_index',
    '  whose filename matches THIS media. A trilogy pack whose files are other movies is a trap.',
    '',
    'DECISION THRESHOLD:',
    '- When a candidate is format-usable + contains Chinese + title/year matches, prefer decision=download.',
    '- Prefer an imperfect source over going empty-handed.',
    '- decision=no_safe_match ONLY when no usable Chinese text subtitle exists.',
    '- decision=ask_user when a match is plausible but genuinely ambiguous.',
    `- User preferences: ${JSON.stringify(ctx.preferences)}`,
    '',
    'IDENTITY VERDICT — set identity_match for your chosen candidate (REQUIRED):',
    '- confirmed = the SAME work + correct season +（for a single-episode subtitle）the correct episode,',
    '  or（for a pack）the pack covers the target episode. An exact or equivalent title match (including',
    '  translated-title variants) together with a matching season/episode number IS confirmed.',
    '- mismatch = it is definitively a DIFFERENT work, a different season, or a different episode.',
    '- uncertain = the candidate genuinely lacks the information to decide (e.g. its entry name carries',
    '  no season/episode and its filelist is empty).',
    '- Source, resolution, release-group, codec and version differences MUST NOT lower the identity',
    '  verdict — they never change WHICH work / season / episode a subtitle is for. Judge identity only',
    '  from title and season/episode, never from provenance.',
    '- When decision=no_safe_match, identity_match must be mismatch or uncertain — never confirmed.',
    '',
    'file_index is the 0-based index into the candidate\'s filelist array; null for non-pack candidates.',
    'Report candidate_id as the candidate\'s id string EXACTLY as shown (e.g. "assrt:673114" or "opensubtitles:7174766").',
    'If the filelist was truncated (filelist_truncated present), only pick from the shown entries.',
    'List every seriously-considered-but-rejected candidate in rejected[] with a concrete reason.',
    '',
    `identified media: ${JSON.stringify(identity)}`,
    `media filename: ${ctx.media.filename}`,
    `candidates: ${JSON.stringify(compact)}`,
  ].join('\n')
  return llm.call({
    name: 'report_rank_decision',
    description: 'Report the chosen subtitle or refusal', prompt, schema: RankDecisionSchema,
  })
}
