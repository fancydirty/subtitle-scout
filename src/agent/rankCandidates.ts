import type { LlmRuntime } from './runtime.js'
import {
  RankDecisionSchema, type MediaContext, type MediaIdentity, type SubtitleCandidate, type SubtitleFile,
  type RankDecision, candidateKey,
} from '../core/schemas.js'
import { formatEpisodeCode, matchesEpisodeCode } from '../core/episode.js'
import type { CallStructuredResult } from './llm.js'

export const MAX_CANDIDATES = 15
/**
 * 生产事故复现（True Detective S3E5-E8 卡死，assrt:635301 是一个 72 文件的 YYeTs 全季 S3 包）：
 * 这个上限本身没错（防单个巨包把 prompt 打爆），错在旧实现是盲的 files.slice(0, N)——纯按原始
 * 顺序砍头，完全不管"这一次 rank 到底要找哪一集"。72 个文件里 E05-E08 的条目排在第 30 条之后，
 * 被砍掉后对 LLM 彻底不可见，rank 只能吐 file_index:null，下游 gate.ts 用 "out of range" 拒绝，
 * 后半季永久卡死（不是"没有候选"，是"候选存在但被截断藏起来了"）。
 *
 * 修复：compactCandidates() 改为 relevance-aware selection——先用 matchesEpisodeCode 把文件名命中
 * 当前 needed episode code 的条目无条件保留（不占用这个上限的"砍头"逻辑），剩余预算才按原顺序
 * 摘一份用于上下文（release group/清晰度等次要线索）的样本。上限值本身不变，只是"选哪 30 条"从
 * "前 30 条"变成"确保需要的那几条在，其余凑数"。
 */
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

/**
 * 当前这次 rank 要找的集号。单集 identify→rank 探测天然只找一集，取 identity 校正后的
 * season/episode（缺失时退回 ctx.media，取值顺序与 pipeline.ts providerSearch 参数一致：
 * `identity.season ?? ctx.media.season`）。非 episode 或 season/episode 任一缺失（电影、
 * 或识别失败）时返回空数组——调用方据此退回"没有 needed 信号"的样子，等价于旧行为。
 */
export function neededEpisodeCodesFor(ctx: MediaContext, identity: MediaIdentity): string[] {
  if (identity.type !== 'episode') return []
  const season = identity.season ?? ctx.media.season
  const episode = identity.episode ?? ctx.media.episode
  if (season == null || episode == null) return []
  return [formatEpisodeCode(season, episode)]
}

/**
 * 从一个候选的 filelist 里选出喂给 prompt 的条目。fileList.length <= MAX_FILELIST_ENTRIES 时原样
 * 返回，不截断。超限时：先用 matchesEpisodeCode 把文件名命中 neededEpisodeCodes 的条目无条件保留
 * （不占用"砍头"预算，也不管它们在原始 filelist 里排第几；但这份"无条件保留"名单本身也封顶在
 * MAX_FILELIST_ENTRIES——病态包（如大量同集号的重编码/多版本条目全部命中）不能靠"都是 needed"
 * 绕过这个上限、把 prompt 打爆），剩余预算才按原顺序摘一份样本，供 LLM 参考同一个候选包里其它
 * 文件的命名风格/发布组信息。返回顺序按原始 index 排序（保持可读性，不代表下游依赖这个顺序——
 * file_index 由每个条目自带的 i 值决定，见下方 prompt 措辞）。
 */
function selectFilelistEntries(
  fileList: SubtitleFile[], neededEpisodeCodes: string[],
): { shown: { i: number; name: string }[]; truncated: number } {
  if (fileList.length <= MAX_FILELIST_ENTRIES) {
    return { shown: fileList.map(f => ({ i: f.index, name: f.name })), truncated: 0 }
  }
  const needed = neededEpisodeCodes.length > 0
    ? fileList.filter(f => neededEpisodeCodes.some(code => matchesEpisodeCode(f.name, code))).slice(0, MAX_FILELIST_ENTRIES)
    : []
  const neededIndexes = new Set(needed.map(f => f.index))
  const rest = fileList.filter(f => !neededIndexes.has(f.index))
  const restBudget = Math.max(0, MAX_FILELIST_ENTRIES - needed.length)
  const kept = [...needed, ...rest.slice(0, restBudget)].sort((a, b) => a.index - b.index)
  return { shown: kept.map(f => ({ i: f.index, name: f.name })), truncated: fileList.length - kept.length }
}

export function compactCandidates(candidates: SubtitleCandidate[], neededEpisodeCodes: string[] = []): Array<{
  id: string
  provider: string
  videoname: string | null | undefined
  native_name: string | null | undefined
  lang: string | null | undefined
  subtype: string | null | undefined
  release_site: string | null | undefined
  filelist: { i: number; name: string }[]
  filelist_truncated?: number
}> {
  return candidates.slice(0, MAX_CANDIDATES).map(c => {
    const { shown, truncated } = selectFilelistEntries(c.fileList, neededEpisodeCodes)
    return {
      id: candidateKey(c),
      provider: c.provider,
      videoname: c.videoName,
      native_name: c.nativeName,
      lang: c.language,
      subtype: c.subtype,
      release_site: c.releaseSite,
      filelist: shown,
      ...(truncated > 0 ? { filelist_truncated: truncated } : {}),
    }
  })
}

export async function rankCandidates(
  llm: LlmRuntime, ctx: MediaContext, identity: MediaIdentity, candidates: SubtitleCandidate[],
): Promise<CallStructuredResult<RankDecision>> {
  const compact = compactCandidates(candidates, neededEpisodeCodesFor(ctx, identity))
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
    'Each filelist entry is { i, name } — file_index is the i value of the entry you pick (NOT its',
    'position in the shown array); null for non-pack candidates.',
    'Worked example: filelist [{"i":2,"name":"a.srt"},{"i":41,"name":"Show.S03E05.srt"}] — the S03E05',
    'pick is file_index: 41 (NOT 1), its position in this shown array.',
    'Report candidate_id as the candidate\'s id string EXACTLY as shown (e.g. "assrt:673114" or "opensubtitles:7174766").',
    'If the filelist was truncated (filelist_truncated present): entries whose filename matches the target',
    'season/episode are always included regardless of truncation, so file_index:null is NOT an acceptable',
    'answer for a pack merely because it is large — only pick from the shown entries, and null means none',
    'of the shown entries (including any that should cover this episode) actually match.',
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
