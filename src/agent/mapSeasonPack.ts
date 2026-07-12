import type { LlmRuntime } from './runtime.js'
import { SeasonMapSchema, type SeasonMap, type MediaContext, type MediaIdentity } from '../core/schemas.js'
import type { SeasonEpisode } from '../core/episode.js'
import type { CallStructuredResult } from './llm.js'

export async function mapSeasonPack(
  llm: LlmRuntime, ctx: MediaContext, identity: MediaIdentity,
  filelist: { index: number; name: string }[], seasonEpisodes: SeasonEpisode[],
): Promise<CallStructuredResult<SeasonMap>> {
  const files = filelist.map(e => ({ index: e.index, filename: e.name }))
  const episodes = seasonEpisodes
    .filter(e => e.needsChinese)
    .map(e => ({ episode_code: e.episodeCode, video: e.videoFilename }))
  const prompt = [
    'Map each subtitle file in a whole-season subtitle pack to the correct episode.',
    'A WRONG mapping shifts an entire season of subtitles — worse than leaving gaps. Be conservative.',
    '',
    'Read the REAL filenames to decide the episode — you understand "[Grp] Show - 04.chs.ass" is episode 4,',
    '"第3集"=E03, "尝鲜版09"=E09, "[04]"=E04, an "End"/"完"/"Fin" marker = the finale. Do NOT use regex or',
    'suffix tricks — read and judge like a human. Absolute-numbered anime files map to the season episode with',
    'that number.',
    '',
    'For each subtitle file, emit one pair { filelist_index, episode_code, reason } where episode_code',
    'is EXACTLY one of the known episode_codes listed below. If you are not confident which episode a file is,',
    'put its index in unmapped_files instead of guessing. Only emit pairs you are sure of. Order does not',
    'matter for correctness, but if you happen to notice two files could map to the same episode, only',
    'emit the one you trust more — a duplicate will simply have its second occurrence dropped.',
    '',
    `series: ${identity.canonical_title} ${identity.year ?? ''}`.trim(),
    `known episodes still needing Chinese subs (map ONLY to these): ${JSON.stringify(episodes)}`,
    `subtitle files in the pack: ${JSON.stringify(files)}`,
  ].join('\n')
  return llm.call({
    name: 'report_season_map',
    description: 'Map each season-pack subtitle file to its episode', prompt, schema: SeasonMapSchema,
  })
}
