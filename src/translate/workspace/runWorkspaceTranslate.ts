import { writeFileSync } from 'node:fs'
import { evaluateTranslationGate, parseSrtCues, type GlossaryTerm as GateGlossaryTerm } from '../qualityGate.js'
import type { TranslationLM } from '../translatePipeline.js'
import { ensureWorkspaceLayout } from './paths.js'
import { materializeAgentView } from './materialize.js'
import { mergeBilingualToSrt } from './merge.js'
import { resolveTranslateSource, type ResolveSourceDeps } from './resolveSource.js'
import type { BilingualRow, GlossaryTerm, WorkspaceMeta } from './types.js'

export interface RunWorkspaceTranslateArgs {
  stagingBase: string
  jobId: string
  videoPath: string
  originLang?: string | null
  itemId?: string
  lm: TranslationLM
  resolveDeps: ResolveSourceDeps
  /** Optional series context docs (P1). */
  context?: { tmdbMd?: string; seriesSubsMd?: string }
  install?: (srtContent: string) => string
  /** Window size for LM batches (default 40). */
  windowSize?: number
}

export type RunWorkspaceTranslateResult =
  | { status: 'installed'; sidecarPath: string; sourceRef: string; jobRoot: string; llmCalls: number }
  | { status: 'held'; reason: string; sourceRef?: string; jobRoot: string; llmCalls: number }
  | { status: 'no-source'; reason: string; jobRoot: string; llmCalls: number }
  | { status: 'extract-failed' | 'probe-failed'; reason: string; jobRoot: string; llmCalls: number }
  | { status: 'write-failed'; reason: string; jobRoot: string; llmCalls: number }

function toGateGlossary(terms: GlossaryTerm[]): GateGlossaryTerm[] {
  return terms.map((t) => ({ en: t.src, zh: t.zh, note: t.note }))
}

function writeJsonl(path: string, rows: object[]): void {
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''))
}

/**
 * P1 deterministic workspace runner: resolve → materialize → glossary → windowed translate
 * into bilingual table → structural gate → merge → install.
 * Full tool-loop agent can wrap the same steps later; this proves the desk model.
 */
export async function runWorkspaceTranslate(args: RunWorkspaceTranslateArgs): Promise<RunWorkspaceTranslateResult> {
  const paths = ensureWorkspaceLayout(args.stagingBase, args.jobId)
  let llmCalls = 0
  const meta: WorkspaceMeta = {
    itemId: args.itemId,
    videoPath: args.videoPath,
    originLang: args.originLang ?? null,
    phase: 'p1-workspace',
  }
  writeFileSync(paths.metaPath, JSON.stringify(meta, null, 2))

  const resolved = await resolveTranslateSource({
    originLang: args.originLang,
    videoPath: args.videoPath,
    deps: args.resolveDeps,
  })
  if (resolved.status !== 'ok') {
    return { status: resolved.status, reason: resolved.reason, jobRoot: paths.jobRoot, llmCalls: 0 }
  }
  meta.sourceRef = resolved.sourceRef
  writeFileSync(paths.metaPath, JSON.stringify(meta, null, 2))

  if (args.context?.tmdbMd) writeFileSync(`${paths.contextDir}/tmdb.md`, args.context.tmdbMd)
  if (args.context?.seriesSubsMd) writeFileSync(`${paths.contextDir}/series_subs.md`, args.context.seriesSubsMd)

  const { rows } = materializeAgentView(paths, resolved.srtText)
  const sourceLangName = resolved.sourceLangName

  // Glossary: use LM on cleaned joined text (not full timed SRT as product — still bounded source).
  const cleanText = rows.map((r) => r.src).join('\n')
  const built = await args.lm.buildGlossary(cleanText, {
    sourceLangName,
    seriesExistingSubs: args.context?.seriesSubsMd ? [args.context.seriesSubsMd] : undefined,
  })
  llmCalls += 1
  const glossary: GlossaryTerm[] = built.map((t) => ({ src: t.en, zh: t.zh, note: t.note }))
  writeFileSync(paths.glossaryPath, JSON.stringify(glossary, null, 2))
  writeFileSync(paths.glossaryFrozenPath, 'frozen\n')

  const windowSize = args.windowSize ?? 40
  const updated: BilingualRow[] = []
  let rolling = ''
  for (let i = 0; i < rows.length; i += windowSize) {
    const chunk = rows.slice(i, i + windowSize)
    const asCues = chunk.map((r) => ({
      index: r.id,
      timing: '00:00:00,000 --> 00:00:01,000', // dummy; pipeline freezes structure from these
      text: r.src.split('\n'),
    }))
    // Use translateSubtitle per window so gates see real source/candidate alignment on text;
    // timings in window are dummy — final merge uses canonical timings only.
    const batchResult = await args.lm.translateBatch(
      asCues,
      toGateGlossary(glossary),
      rolling,
      sourceLangName,
    )
    llmCalls += 1
    rolling = batchResult.summary
    for (let j = 0; j < chunk.length; j++) {
      const tgt = batchResult.cues[j]?.text.join('\n') ?? ''
      updated.push({
        id: chunk[j].id,
        src: chunk[j].src,
        tgt,
        status: tgt.trim() ? 'ok' : 'failed',
      })
    }
  }
  writeJsonl(paths.bilingualPath, updated)
  writeFileSync(paths.summaryPath, rolling ? `${rolling}\n` : '')

  // Structural + term gate on cleaned pairs (no timing dimension).
  const srcCues = updated.map((r) => ({ index: r.id, timing: '00:00:00,000 --> 00:00:01,000', text: r.src.split('\n') }))
  const tgtCues = updated.map((r) => ({ index: r.id, timing: '00:00:00,000 --> 00:00:01,000', text: r.tgt.split('\n') }))
  if (updated.some((r) => !r.tgt.trim())) {
    return {
      status: 'held',
      reason: 'empty translation row(s)',
      sourceRef: resolved.sourceRef,
      jobRoot: paths.jobRoot,
      llmCalls,
    }
  }
  const gate = evaluateTranslationGate(srcCues, tgtCues, toGateGlossary(glossary))
  if (gate.verdict !== 'pass') {
    return {
      status: 'held',
      reason: gate.hardViolations.join('; ') || 'quality gate fail',
      sourceRef: resolved.sourceRef,
      jobRoot: paths.jobRoot,
      llmCalls,
    }
  }

  let merged: string
  try {
    merged = mergeBilingualToSrt(paths)
  } catch (e) {
    return {
      status: 'held',
      reason: e instanceof Error ? e.message : String(e),
      sourceRef: resolved.sourceRef,
      jobRoot: paths.jobRoot,
      llmCalls,
    }
  }

  // Sanity: merged cue count matches
  if (parseSrtCues(merged).length !== updated.length) {
    return {
      status: 'held',
      reason: 'merge cue count mismatch',
      sourceRef: resolved.sourceRef,
      jobRoot: paths.jobRoot,
      llmCalls,
    }
  }

  if (!args.install) {
    return {
      status: 'held',
      reason: 'no install callback configured',
      sourceRef: resolved.sourceRef,
      jobRoot: paths.jobRoot,
      llmCalls,
    }
  }
  try {
    const sidecarPath = args.install(merged)
    return {
      status: 'installed',
      sidecarPath,
      sourceRef: resolved.sourceRef,
      jobRoot: paths.jobRoot,
      llmCalls,
    }
  } catch (e) {
    return {
      status: 'write-failed',
      reason: e instanceof Error ? e.message : String(e),
      jobRoot: paths.jobRoot,
      llmCalls,
    }
  }
}
