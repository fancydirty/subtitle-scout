import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/** Resource-type axis (test-matrix spec §两轴). Chinese-content types map to assrt as primary
 *  provider; `western` may use opensubtitles. */
export const RESOURCE_TYPES = ['anime', 'cdrama', 'western', 'movie'] as const
export type ResourceType = typeof RESOURCE_TYPES[number]

/** Source-return-form axis (spec §两轴) + the mandatory counter-example. `none` = the source
 *  genuinely returns nothing usable → the worker must honestly finalize no_safe_match
 *  ("不比 Bazarr 烂" floor). */
export const SOURCE_FORMS = ['only-pack', 'only-single', 'mixed', 'season-pack', 'multi-version', 'none'] as const
export type SourceForm = typeof SOURCE_FORMS[number]

/** The expected correct outcome for a cell — asserted by both the in-suite replay test and the
 *  out-of-band matrix runner. No confidence score (north star #1); we assert the *decision* and,
 *  for `installed`, which candidate/file/language is correct. */
export interface CellExpectation {
  decision: 'installed' | 'no_safe_match' | 'retry_later'
  /** installed only: the composite candidate the worker should have chosen. */
  candidateProvider?: string
  candidateProviderId?: string
  /** installed only: the basename that must appear beside the video, and its language tag.
   *  'zh-any' means either Simplified or Traditional is a correct install — coverage-first,
   *  no 简/繁 ranking between them; only used when the cell has no basis to prefer one over
   *  the other (e.g. only one script is actually available, or both are equally valid). */
  installedFilename?: string
  installedLanguage?: 'zh-Hans' | 'zh-Hant' | 'zh-any'
}

/** On-disk `cell.json`'s flat, single-episode task-fact shape — predates the glue-layer repair's
 *  batch `FindSubtitleTask.targets[]` (same flat shape as `EvalFixtureTaskFacts` in
 *  findSubtitleWorker.eval.test.ts). `jobId`/`mediaRoot`/`videoPath` are runtime-supplied by the
 *  consuming test/runner, which also wraps this into a single-target `targets: [...]` array. */
export interface CellTaskFacts {
  videoFilename: string
  title: string
  originalTitle: string | null
  year: number | null
  season: number | null
  episode: number | null
  absoluteEpisode: number | null
  alternativeTitles: string[]
  overview: string | null
  runtimeMinutes: number | null
  providerIds: Record<string, string>
  targetLanguage?: string
}

/** On-disk `cell.json`. */
export interface CellFile {
  task: CellTaskFacts
  expected: CellExpectation
  note: string
}

export interface LoadedCell extends CellFile {
  resourceType: ResourceType
  sourceForm: SourceForm
  dir: string
  responsesDir: string
  responseCount: number
}

/** One row in the matrix. `seeded` gates the in-suite test: only cells whose fixtures actually
 *  exist are asserted; unseeded cells are the auto-research backlog (populate via the runbook). */
export interface CatalogEntry {
  resourceType: ResourceType
  sourceForm: SourceForm
  seeded: boolean
  /** Human note: the concrete resource this cell represents. */
  represents: string
}

/** The A-layer matrix. Seeded = fixtures present in this repo; the rest are the populate-me
 *  backlog. Start with the anchor (anime/only-pack — the live-acceptance cell) and grow.
 *
 *  INVARIANT — never seek a subtitle in the content's own audio language. This project's target
 *  is CHINESE subtitles, so Chinese-audio content (cdrama / 国产剧) is OUT OF SCOPE: a Chinese
 *  viewer watching a Chinese-audio show needs no Chinese subs, making "find a zh subtitle for a
 *  cdrama" a void/meaningless cell. Valid resourceTypes for Chinese-subtitle-finding are therefore
 *  only content whose audio is NOT Chinese: anime (JP), western (EN), movie (non-CN). `cdrama`
 *  remains a defined ResourceType (see RESOURCE_TYPES above) and returns to CELL_CATALOG only
 *  under a FUTURE "find English subs for international users" scenario — that is backlog, not
 *  implemented now, and no cdrama cells should be seeded until it lands.
 *
 *  BACKLOG — assrt is a Chinese-subtitle source. Once English-subtitle / international-user
 *  support lands (see above), assrt must be gated OUT of non-Chinese-subtitle requests even if
 *  configured/available, or it will happily return Chinese subs for a request that wants English.
 *  Not implemented; no provider/adapter code changed for this note. */
export const CELL_CATALOG: CatalogEntry[] = [
  { resourceType: 'anime', sourceForm: 'only-pack', seeded: true, represents: 'Attack on Titan S01E01 — only a Complete-Series pack exists (live-acceptance cell)' },
  { resourceType: 'anime', sourceForm: 'season-pack', seeded: true, represents: 'Attack on Titan S02E01 — S1+S2 pack numbered by ABSOLUTE episode (26), no S02E01 substring anywhere' },
  { resourceType: 'anime', sourceForm: 'only-single', seeded: true, represents: 'Jujutsu Kaisen S03E01 (absolute ep. 48) — per-episode subtitles only, no season pack yet (Scissor Seven has zero assrt hits, substituted)' },
  { resourceType: 'anime', sourceForm: 'mixed', seeded: true, represents: 'Jujutsu Kaisen S02E05 — pack mislabeled "第3季" (invented season), target locatable only via absoluteEpisode (29)' },
  { resourceType: 'anime', sourceForm: 'multi-version', seeded: true, represents: 'Demon Slayer S01E01 — same episode, 简/繁/日 versions (any zh-* correct, 日 is not)' },
  { resourceType: 'western', sourceForm: 'only-single', seeded: true, represents: 'World War II with Tom Hanks S01E01 — genuine single-file upload, no pack (Peacemaker/Young Sheldon all turned out to be season packs, substituted)' },
  { resourceType: 'western', sourceForm: 'mixed', seeded: true, represents: 'Love, Death & Robots S03E01 — both a season pack AND standalone single-episode uploads exist' },
  { resourceType: 'movie', sourceForm: 'multi-version', seeded: true, represents: "Hero (英雄 2002) — Director's Cut (~103min) vs Bluray/theatrical (~93.5min), genuine runtime variants" },
  { resourceType: 'movie', sourceForm: 'none', seeded: true, represents: 'obscure film — no correct subtitle exists (counter-example floor)' },
]

const FIXTURE_ROOT = 'fixtures/v3-live'

export function cellDir(resourceType: ResourceType, sourceForm: SourceForm): string {
  return join(FIXTURE_ROOT, resourceType, sourceForm)
}

export function loadCell(resourceType: ResourceType, sourceForm: SourceForm): LoadedCell {
  const dir = cellDir(resourceType, sourceForm)
  const file = JSON.parse(readFileSync(join(dir, 'cell.json'), 'utf8')) as CellFile
  // Seam default: on-disk cell.json fixtures predate FindSubtitleTask.targetLanguage, and the
  // JSON cast hides the absent field from tsc — without this the worker prompt would interpolate
  // the string "undefined". Defaulting here (not hand-editing every fixture) covers every
  // consumer that spreads a loaded task (replay test, scripts/run-live-matrix.ts).
  if (file.task.targetLanguage == null) file.task.targetLanguage = 'zh'
  const responsesDir = join(dir, 'responses')
  const responseCount = existsSync(responsesDir)
    ? readdirSync(responsesDir).filter(f => f.endsWith('.json')).length
    : 0
  return { ...file, resourceType, sourceForm, dir, responsesDir, responseCount }
}
