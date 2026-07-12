import type { LlmRuntime } from './runtime.js'
import { VerifyDecisionSchema, type MediaContext, type MediaIdentity, type SubtitleCandidate } from '../core/schemas.js'
import type { InspectSignals } from '../files/subtitleInspect.js'
import type { CallStructuredResult } from './llm.js'

/** staging 沙盒终审:一次 LLM 调用,给定目标身份 + 候选元数据 + 开箱体检信号,
 *  要求 agent 像人一样表态"是/不是"——没有置信度数字。 */
export async function verifySubtitle(
  llm: LlmRuntime, ctx: MediaContext, identity: MediaIdentity,
  candidate: SubtitleCandidate, signals: InspectSignals,
) {
  const prompt = [
    'You are about to install this subtitle file into the user\'s media library. Decide, like a human',
    'who just opened the file, whether it IS the subtitle for this exact movie/episode — not "plausible",',
    'actually is it. A wrong subtitle silently installed is worse than no subtitle: it looks fine until',
    'someone plays the video and the dialogue is wrong. If you cannot tell, that is match=false — a gap',
    'can be filled next time, a wrong install cannot be quietly undone.',
    '',
    'Report match=true or match=false and a short reason, the way a person would explain their judgment',
    'after opening the file. Never invent or state a numeric certainty value anywhere.',
    '',
    `target: ${JSON.stringify({
      title: identity.canonical_title, original_title: identity.original_title, year: identity.year,
      type: identity.type, season: identity.season, episode: identity.episode,
      runtime_minutes: ctx.media.runtime_minutes, filename: ctx.media.filename,
    })}`,
    `candidate metadata: ${JSON.stringify({
      provider: candidate.provider, providerId: candidate.providerId,
      videoName: candidate.videoName, nativeName: candidate.nativeName, releaseSite: candidate.releaseSite,
    })}`,
    `structural inspection of the actual downloaded file: ${JSON.stringify(signals)}`,
    '',
    'Use the inspection signals as evidence, not a formula: cueCount in the low hundreds and spanMs',
    'roughly matching the target runtime are healthy signs for a normal episode/movie; a handful of cues,',
    'or a span wildly shorter than the runtime, suggests a partial or wrong file; an HTML error page',
    '(isHtml=true) or undecodable bytes (decodable=false) is never a real subtitle. detectedScript is a',
    'hint about simplified/traditional/Cantonese, not a hard gate. assTitle, if present, often names the',
    'release — cross-check it against the target. Judge the whole picture like a person would.',
  ].join('\n')
  return llm.call({
    name: 'report_verify_decision',
    description: 'Report whether the downloaded subtitle file is the one for this exact movie/episode',
    prompt, schema: VerifyDecisionSchema,
  }) as Promise<CallStructuredResult<{ match: boolean; reason: string }>>
}
