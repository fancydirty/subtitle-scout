import type { LlmRuntime } from './runtime.js'
import { SearchPlanSchema, type MediaContext, type MediaIdentity, type SearchPlan } from '../core/schemas.js'
import type { CallStructuredResult } from './llm.js'

export async function planSearch(
  llm: LlmRuntime, ctx: MediaContext, identity: MediaIdentity,
): Promise<CallStructuredResult<SearchPlan>> {
  const altTitles = ctx.media.alternative_titles
  const alt = altTitles.length ? altTitles.join(', ') : 'none'
  const year = identity.year ?? ctx.media.year ?? 'unknown'
  const isEpisode = ctx.media.type === 'episode'
  const season = identity.season ?? ctx.media.season ?? null
  const prompt = [
    'Plan 2-3 search queries for ASSRT (assrt.net), a Chinese-language subtitle site.',
    'ASSRT sorts results by upload time, so a bare title buries older releases. ALWAYS include the year to disambiguate.',
    '',
    ...(isEpisode ? [
      'This is a TV/anime EPISODE. ASSRT often has a WHOLE-SEASON subtitle pack (one entry whose file list',
      'covers every episode) indexed at the SEASON level — a per-episode query MISSES it. ASSRT matching is',
      'loose and time-sorted: over-specific queries ("Title Season N Year") often return ZERO, while looser',
      'queries surface the pack. Generate, in order (the pipeline runs the FIRST TWO and unions them):',
      `1. SEASON-level primary, to surface a whole-season pack. Use the BARE title WITHOUT season modifiers:`,
      `   when a Chinese title is known use bare "<Chinese title>" (NO "第N季", NO year). If the context gives`,
      `   no Chinese title but YOU know this show's commonly used Chinese title (official or community —`,
      `   metadata providers often return the English name even for zh-CN), USE YOUR OWN KNOWLEDGE: e.g.`,
      `   "Love, Death & Robots" → 爱，死亡与机器人. Use the full common name, not fan abbreviations`,
      `   (爱死机 finds nothing). Only fall back to the bare "<original/English title>" when you genuinely`,
      `   do not know a Chinese name. The bare title is what actually surfaces season packs on ASSRT — adding`,
      `   "第N季" or "Season N" often returns ZERO due to loose matching (same failure mode for both languages).`,
      `2. Optional SEASON-level secondary: "<Chinese title> 第${season ?? 'N'}季" when Chinese is known`,
      `   (some packs ARE tagged with season modifiers — this supplements the bare query). Otherwise skip.`,
      `3. A per-episode fallback for a single-episode sub: "<Chinese title> 第${season ?? 'N'}季 第<episode>集"`,
      `   when Chinese is known, else "<original title> S${String(season ?? 1).padStart(2, '0')}E<episode>".`,
      'Put the SEASON-level query FIRST — a whole-season pack covers the entire season in one shot.',
    ] : [
      'Query priority (generate in this order):',
      '1. "<Chinese title> <year>" when a Chinese/alternative title is known — ASSRT is a Chinese site,',
      '   so this is the strongest query. If the context gives no Chinese title but YOU know the film\'s',
      '   commonly used Chinese title, USE YOUR OWN KNOWLEDGE (metadata providers often return English',
      '   names even for zh-CN). Use the full common name, not fan abbreviations.',
      '2. "<original/English title> <year>".',
      '3. "<original/English title>" as a fallback (no year).',
      'For a series film you may use the common Chinese numbered title (e.g. "招魂4 2025").',
    ]),
    '',
    'DO NOT generate hyper-specific release-filename queries (full scene names with codec/group);',
    'they push noise to the top of ASSRT\'s time-sorted results.',
    'The pipeline runs the first two queries and unions the results, so make the first two count.',
    '',
    `identified media: ${JSON.stringify(identity)}`,
    `chinese/alternative titles: ${alt}`,
    `year: ${year}`,
    `filename: ${ctx.media.filename}`,
  ].join('\n')
  return llm.call({
    name: 'report_search_plan',
    description: 'Report ordered ASSRT search queries', prompt, schema: SearchPlanSchema,
  })
}
