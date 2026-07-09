import type { LlmRuntime } from './runtime.js'
import { MediaIdentitySchema, type MediaContext, type MediaIdentity } from '../core/schemas.js'
import type { CallStructuredResult } from './llm.js'

export async function identifyMedia(
  llm: LlmRuntime, ctx: MediaContext,
): Promise<CallStructuredResult<MediaIdentity>> {
  const m = ctx.media
  const prompt = [
    'You are a media librarian. Identify the exact movie or TV episode from the evidence below.',
    'Be precise about edition/cut (director\'s cut, extended, remaster) if the filename indicates one.',
    '',
    `player title: ${m.title}`,
    `original title: ${m.original_title ?? 'unknown'}`,
    `year: ${m.year ?? 'unknown'}`,
    `type hint: ${m.type}`,
    `season/episode: S${m.season ?? '-'} E${m.episode ?? '-'}`,
    `filename: ${m.filename}`,
    `full path: ${m.path}`,
    `provider ids: ${JSON.stringify(m.provider_ids)}`,
    `chinese/alternative titles: ${m.alternative_titles.length ? m.alternative_titles.join(', ') : 'none'}`,
    `overview: ${m.overview ?? 'none'}`,
    `runtime minutes: ${m.runtime_minutes ?? 'unknown'}`,
    '',
    'Report canonical_title in the title\'s original language, list concrete evidence strings,',
    'and give confidence in [0,1]. year, season, episode MUST be JSON numbers (not strings); use null when unknown or not applicable. For episodes, season/episode MUST match the values given above.',
  ].join('\n')
  return llm.call({
    name: 'report_identity',
    description: 'Report the identified media', prompt, schema: MediaIdentitySchema,
  })
}
