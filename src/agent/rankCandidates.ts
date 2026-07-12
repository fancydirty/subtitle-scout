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
    'Order these multi-source Chinese subtitle candidates (fields: id = "<provider>:<providerId>") from',
    'most to least likely to be a correct match for this media, or refuse all of them.',
    'This is a PRELIMINARY ordering, not a final verdict — every candidate you keep will later be',
    'downloaded, opened, and inspected before anything is written. Your job here is triage: keep',
    'everything that is plausibly usable, in the order you would try them.',
    '',
    'FORMAT — which candidates are usable:',
    '- Text subtitles (srt / ass / ssa, including those extensions inside filelist) are ALL usable.',
    '- subtype=None or missing is NOT a reason to drop — it is usually an effect/styled .ass.',
    '- Only truly graphic-only packs (PGS .sup, VobSub .idx+.sub) are unusable, and those have already',
    '  been filtered out before you see them; assume every candidate here has text.',
    '',
    'IDENTITY VERDICT — set identity_match per candidate:',
    '- confirmed = the SAME work + correct season +（for a single-episode subtitle）the correct episode,',
    '  or（for a pack）the pack covers the target episode. An exact or equivalent title match (including',
    '  translated-title variants) together with a matching season/episode number IS confirmed.',
    '- mismatch = it is definitively a DIFFERENT work, a different season, or a different episode.',
    '  DROP mismatch candidates entirely — do not put them in order[], list them in rejected[] instead.',
    '- uncertain = plausible but the candidate itself does not carry enough evidence to be sure (e.g. its',
    '  entry name carries no season/episode and its filelist is empty). Keep uncertain candidates in',
    '  order[] — do not refuse just because you are not sure; a closer look downstream will decide.',
    '  Only mismatch gets dropped here.',
    '- Source, resolution, release-group, codec and version differences MUST NOT lower the identity',
    '  verdict — they never change WHICH work / season / episode a subtitle is for.',
    '',
    'If a candidate is a pack (filelist has multiple files), pick the specific file_index whose filename',
    'matches THIS media. A trilogy pack whose files are other movies is a trap.',
    'file_index is the 0-based index into the candidate\'s filelist array; null for non-pack candidates.',
    'Report candidate_id as the candidate\'s id string EXACTLY as shown (e.g. "assrt:673114" or "opensubtitles:7174766").',
    'If the filelist was truncated (filelist_truncated present), only pick from the shown entries.',
    '',
    'Put your best-guess candidate first in order[]. Give a short reason per candidate. List every',
    'seriously-considered-but-dropped (mismatch, or genuinely unusable) candidate in rejected[] with a',
    'concrete reason. Do not report any numeric certainty rating anywhere — you are ordering candidates,',
    'not scoring them.',
    '',
    `identified media: ${JSON.stringify(identity)}`,
    `media filename: ${ctx.media.filename}`,
    `candidates: ${JSON.stringify(compact)}`,
  ].join('\n')
  return llm.call({
    name: 'report_rank_order',
    description: 'Order candidates by how likely each is the correct subtitle, or refuse them all',
    prompt, schema: RankDecisionSchema,
  })
}
