import type { LlmRuntime } from './runtime.js'
import { LooseEpisodesMapSchema, type LooseEpisodesMap, type MediaContext, type MediaIdentity, type SubtitleCandidate, candidateKey } from '../core/schemas.js'
import type { SeasonEpisode } from '../core/episode.js'
import type { CallStructuredResult } from './llm.js'

export async function mapLooseEpisodes(
  llm: Pick<LlmRuntime, 'call'>, ctx: MediaContext, identity: MediaIdentity,
  candidates: SubtitleCandidate[], seasonEpisodes: SeasonEpisode[],
): Promise<CallStructuredResult<LooseEpisodesMap>> {
  const candidateEntries = candidates.map(c => {
    const firstFile = c.fileList.length > 0 ? c.fileList[0].name : ''
    return { candidate_id: candidateKey(c), native_name: c.nativeName || '', videoname: c.videoName || '', first_file: firstFile }
  })
  const episodes = seasonEpisodes
    .filter(e => e.needsChinese)
    .map(e => ({ episode_code: e.episodeCode, video: e.videoFilename }))
  const prompt = [
    'Map loose per-episode subtitle candidates to the correct episodes in a season.',
    'Context: this season has NO whole-season pack, but multiple single-episode subtitle entries exist.',
    'Each candidate entry typically covers ONE episode. Your task is to identify which episode each candidate is for.',
    '',
    'CRITICAL: A wrong mapping shifts subtitles to the wrong episode — worse than leaving gaps. Be conservative.',
    'Rules:',
    '- Read the native_name, videoname, and first_file to decide the episode number.',
    '- Understand patterns like "第3集"=E03, "[Grp] Show - 04.chs.ass"=E04, "S02E05"=E05, etc.',
    '- Each episode can have AT MOST one candidate assigned. If multiple candidates claim the same episode, pick the most confident one (or skip both if unclear).',
    '- If confidence < 0.75, do NOT assign — it\'s safer to leave a gap than to map incorrectly.',
    '- Only emit assignments you are sure of. episode_code MUST be copied verbatim from the known list below (format SxxExx).',
    '- Report candidate_id exactly as shown in the candidates list (e.g. "assrt:673114").',
    '',
    `series: ${identity.canonical_title} ${identity.year ?? ''}`.trim(),
    `known episodes still needing Chinese subs (assign ONLY to these): ${JSON.stringify(episodes)}`,
    `subtitle candidates: ${JSON.stringify(candidateEntries)}`,
  ].join('\n')
  return llm.call({
    name: 'map_loose_episodes',
    description: 'Map loose per-episode subtitle candidates to correct episodes', prompt, schema: LooseEpisodesMapSchema,
  })
}
