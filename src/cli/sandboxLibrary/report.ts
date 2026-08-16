import { readFileSync } from 'node:fs'
import { extname } from 'node:path'
import { tagsForLanguage } from '../../agent/languages.js'
import { parseAssCues, parseSrtCues } from '../../files/subtitleInspect.js'

export type CellVerdict = 'PASS' | 'FAIL-PIPE' | 'FAIL-SOURCE' | 'FAIL-SKIP'

export interface CellResult {
  verdict: CellVerdict
  detail: string
}

export interface FindCellInput {
  expectedTmdbId: number
  actualTmdbId: number | null
  skipReason: string | null
  needsSubtitle: number | null
  /** Informational only (R24: only scan writes covered). */
  subStatus: string | null
  sidecarTags: string[]
  cueCount: number
  findSubtitleRuns: number
  targetLanguage: 'zh' | 'en'
}

export interface SkipCellInput {
  skipReason: string | null
  needsSubtitle: number | null
  findSubtitleRuns: number
  sidecarTags: string[]
}

/** Spec §8 + R24: disk sidecar is source of truth — do not require subStatus === 'covered'. */
export function evaluateFindCell(input: FindCellInput): CellResult {
  if (input.actualTmdbId == null || input.actualTmdbId !== input.expectedTmdbId) {
    return {
      verdict: 'FAIL-PIPE',
      detail: `identity expected tmdb:${input.expectedTmdbId} got ${input.actualTmdbId ?? 'null'}`,
    }
  }

  if (input.skipReason === 'origin-skip') {
    return {
      verdict: 'FAIL-PIPE',
      detail: 'origin-skip: find cell skipped',
    }
  }

  const allowed = new Set(tagsForLanguage(input.targetLanguage))
  const matching = input.sidecarTags.filter((t) => allowed.has(t))

  if (input.sidecarTags.length > 0 && matching.length === 0) {
    return {
      verdict: 'FAIL-PIPE',
      detail: `sidecar language ${input.sidecarTags.join(',')} not in tagsForLanguage(${input.targetLanguage})`,
    }
  }

  if (input.needsSubtitle === 0 && matching.length === 0) {
    return {
      verdict: 'FAIL-PIPE',
      detail: 'needsSubtitle 0: judge said this find cell needs no subs',
    }
  }

  if (matching.length === 0 || input.cueCount <= 10) {
    return {
      verdict: 'FAIL-SOURCE',
      detail: matching.length === 0
        ? 'no target-language sidecar on disk'
        : `cueCount ${input.cueCount} <= 10`,
    }
  }

  return {
    verdict: 'PASS',
    detail: `tmdb:${input.actualTmdbId} sidecar=${matching[0]} cues=${input.cueCount}`
      + (input.subStatus == null ? ' (sub_status null / R24)' : ''),
  }
}

export function evaluateSkipCell(input: SkipCellInput): CellResult {
  if (input.skipReason !== 'origin-skip') {
    return {
      verdict: 'FAIL-PIPE',
      detail: `skipReason expected origin-skip got ${input.skipReason ?? 'null'}`,
    }
  }
  if (input.findSubtitleRuns > 0 || input.sidecarTags.length > 0) {
    return {
      verdict: 'FAIL-SKIP',
      detail: input.findSubtitleRuns > 0
        ? `subtitle worker ran ${input.findSubtitleRuns} time(s)`
        : `unexpected sidecar tags: ${input.sidecarTags.join(',')}`,
    }
  }
  if (input.needsSubtitle !== 0) {
    return {
      verdict: 'FAIL-PIPE',
      detail: `needsSubtitle expected 0 got ${input.needsSubtitle ?? 'null'}`,
    }
  }
  return { verdict: 'PASS', detail: 'origin-skip, no worker, no sidecar' }
}

/** Cue counting for the collector (threshold > 10). */
export function countSidecarCues(sidecarPath: string): number {
  const text = readFileSync(sidecarPath, 'utf8')
  const ext = extname(sidecarPath).toLowerCase()
  if (ext === '.ass' || ext === '.ssa') return parseAssCues(text).cues.length
  return parseSrtCues(text).length
}

export function formatReportTable(
  rows: Array<{ id: string; verdict: CellVerdict; detail: string }>,
): string {
  const lines = ['id\tverdict\tdetail']
  for (const r of rows) lines.push(`${r.id}\t${r.verdict}\t${r.detail}`)
  return lines.join('\n')
}
