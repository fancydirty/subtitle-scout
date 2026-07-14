import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { FindSubtitleTask } from '../agent/findSubtitleWorker.schemas.js'

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

/** On-disk `cell.json`. `task` omits the three runtime-supplied fields (the runner/test fills
 *  jobId/mediaRoot/videoPath), matching EvalFixture in findSubtitleWorker.eval.test.ts. */
export interface CellFile {
  task: Omit<FindSubtitleTask, 'jobId' | 'mediaRoot' | 'videoPath'>
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
 *  backlog. Start with the anchor (anime/only-pack — the live-acceptance cell) and grow. */
export const CELL_CATALOG: CatalogEntry[] = [
  { resourceType: 'anime', sourceForm: 'only-pack', seeded: true, represents: 'Attack on Titan S01E01 — only a Complete-Series pack exists (live-acceptance cell)' },
  { resourceType: 'anime', sourceForm: 'season-pack', seeded: true, represents: 'Attack on Titan S02E01 — S1+S2 pack numbered by ABSOLUTE episode (26), no S02E01 substring anywhere' },
  { resourceType: 'anime', sourceForm: 'only-single', seeded: true, represents: 'Jujutsu Kaisen S03E01 (absolute ep. 48) — per-episode subtitles only, no season pack yet (Scissor Seven has zero assrt hits, substituted)' },
  { resourceType: 'anime', sourceForm: 'mixed', seeded: true, represents: 'Jujutsu Kaisen S02E05 — pack mislabeled "第3季" (invented season), target locatable only via absoluteEpisode (29)' },
  { resourceType: 'anime', sourceForm: 'multi-version', seeded: true, represents: 'Demon Slayer S01E01 — same episode, 简/繁/日 versions (any zh-* correct, 日 is not)' },
  { resourceType: 'cdrama', sourceForm: 'only-pack', seeded: true, represents: 'Journey to the West (1986 CCTV classic) — whole-series pack (琅琊榜/Nirvana in Fire has zero assrt hits, substituted)' },
  { resourceType: 'cdrama', sourceForm: 'multi-version', seeded: true, represents: 'F4 Thailand: Boys Over Flowers (流星花园 2021) S01E01 — separate 简/繁 season-pack uploads (琅琊榜 has zero assrt hits, substituted)' },
  { resourceType: 'western', sourceForm: 'only-single', seeded: false, represents: 'Peacemaker / Young Sheldon — per-episode' },
  { resourceType: 'western', sourceForm: 'mixed', seeded: false, represents: 'Love Death & Robots — anthology' },
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
  const responsesDir = join(dir, 'responses')
  const responseCount = existsSync(responsesDir)
    ? readdirSync(responsesDir).filter(f => f.endsWith('.json')).length
    : 0
  return { ...file, resourceType, sourceForm, dir, responsesDir, responseCount }
}
