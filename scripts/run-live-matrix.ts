// Out-of-band matrix runner — NOT part of `npm test`. Real reasoning model + REPLAY provider
// responses (network-free providers; only the LLM is live). Exposes judgment problems = the point.
//
// Usage:
//   npx tsx scripts/run-live-matrix.ts --all
//   npx tsx scripts/run-live-matrix.ts --type anime --form only-pack [--repeat 3]
//
// Requires LLM_BASE_URL/LLM_API_KEY/LLM_MODEL in .env. Provider creds NOT needed in replay mode.
import { parseArgs } from 'node:util'
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import 'dotenv/config'
import { makeModel } from '../src/agent/llm.js'
import { AssrtClient, MinIntervalLimiter } from '../src/adapters/providers/assrt.js'
import { makeAssrtAdapter } from '../src/cli/adapters/assrtAdapter.js'
import { makeFindSubtitleWorker } from '../src/agent/findSubtitleWorker.js'
import type { FindSubtitleTask } from '../src/agent/findSubtitleWorker.schemas.js'
import { makeReplayFetch } from '../src/testing/replayFetch.js'
import { CELL_CATALOG, loadCell, RESOURCE_TYPES, SOURCE_FORMS, type CatalogEntry } from '../src/testing/liveMatrix.js'
import { makeToolCallTap } from '../src/testing/toolCallTap.js'
import type { LanguageModel } from 'ai'

if (process.env.VITEST) throw new Error('matrix runner must not run under vitest — it hits a real LLM')

const { values } = parseArgs({ options: {
  all: { type: 'boolean' }, type: { type: 'string' }, form: { type: 'string' }, repeat: { type: 'string' },
} })
const repeat = values.repeat ? Number(values.repeat) : 1
// Validate the axis filters up front: a typo'd --type/--form would otherwise be indistinguishable
// from a legitimately-empty selection ("no seeded cells match") — fail with the specific complaint.
if (values.type && !(RESOURCE_TYPES as readonly string[]).includes(values.type)) {
  console.error(`unknown --type ${values.type}: expected ${RESOURCE_TYPES.join('|')}`)
  process.exit(1)
}
if (values.form && !(SOURCE_FORMS as readonly string[]).includes(values.form)) {
  console.error(`unknown --form ${values.form}: expected ${SOURCE_FORMS.join('|')}`)
  process.exit(1)
}

function selected(): CatalogEntry[] {
  const seeded = CELL_CATALOG.filter(c => c.seeded)
  if (values.all) return seeded
  return seeded.filter(c => (!values.type || c.resourceType === values.type) && (!values.form || c.sourceForm === values.form))
}

interface CellResult {
  cell: string; run: number; ok: boolean; got: string; want: string; err?: string
  /** Diagnostic only — NEVER folded into `ok`/exit code. True iff the tool-call tap (see
   *  src/testing/toolCallTap.ts) observed download_candidate or install_subtitle ANYWHERE in the
   *  run's tool sequence. For a no_safe_match result this distinguishes a CLEAN refusal (never
   *  touched a wrong candidate) from an ACQUISITION-ATTEMPTED one (grabbed a wrong candidate and
   *  only failed into no_safe_match by friction downstream) — the latter is Bazarr-style
   *  keyword-grabbing, the exact anti-pattern the project's north star forbids. */
  acquisitionAttempted?: boolean
  /** Full ordered tool-call sequence for this run, whatever the outcome (populated even on THREW,
   *  since the tap observes tool calls as they happen, before any error). */
  toolCalls?: string[]
}

async function runOne(entry: CatalogEntry, run: number, model: LanguageModel): Promise<CellResult> {
  const cell = loadCell(entry.resourceType, entry.sourceForm)
  const id = `${entry.resourceType}/${entry.sourceForm}`
  const root = mkdtempSync(join(tmpdir(), 'scout-matrix-'))
  // Fresh tap per run — toolCalls must not leak across runs/cells sharing the one `model` instance
  // built in main(). Declared outside the try so the THREW path below can still report whatever
  // tool sequence the tap captured before the throw; the diagnostic value doesn't evaporate just
  // because the run errored partway through.
  const tap = makeToolCallTap(model)
  try {
    const mediaRoot = join(root, 'media', cell.task.title.replace(/[^\w.-]+/g, '_'))
    mkdirSync(mediaRoot, { recursive: true })
    const videoPath = join(mediaRoot, cell.task.videoFilename)
    const replay = makeReplayFetch(cell.responsesDir)
    const client = new AssrtClient({ token: 'replay', cacheDir: join(root, 'assrt-cache'), fetchImpl: replay, limiter: new MinIntervalLimiter(0) })
    const runTask = makeFindSubtitleWorker({
      model: tap.model, adapters: [makeAssrtAdapter(client)], cacheRoot: join(root, 'cache'), fetchImpl: replay, stepCap: 500,
    })
    const task: FindSubtitleTask = { ...cell.task, jobId: `matrix-${id.replace('/', '-')}-${run}`, mediaRoot, videoPath }
    const decision = await runTask(task)
    // Assert per expectation. installed → decision + right file present + language; else → decision only.
    let ok = decision.decision === cell.expected.decision
    if (ok && cell.expected.decision === 'installed') {
      // 'zh-any' = either Simplified or Traditional is a correct install (coverage-first, no
      // 简/繁 ranking) — otherwise the language must match exactly.
      const anyZh = cell.expected.installedLanguage === 'zh-any'
      const languageOk = anyZh
        ? decision.installedLanguage === 'zh-Hans' || decision.installedLanguage === 'zh-Hant'
        : decision.installedLanguage === cell.expected.installedLanguage
      // The installed filename is `<video-base>.<langTag>.<ext>`, so on a zh-any cell the model's
      // choice of Simplified vs Traditional changes the filename itself. Accept EITHER language
      // variant of the expected name — that pins the correct EPISODE (the <video-base>) without
      // over-pinning the language, so a coverage-correct 繁 install of a cell documented as 简 is
      // not misreported as a judgment FAIL. NFC-normalize both sides: install_subtitle NFC-
      // normalizes the path it returns, and a hand-typed NFD installedFilename (easy on macOS)
      // would otherwise fail byte-exact equality against a correct install.
      const expectedNames = anyZh
        ? [cell.expected.installedFilename!.replace(/\.zh-Han[st]\./, '.zh-Hans.'),
           cell.expected.installedFilename!.replace(/\.zh-Han[st]\./, '.zh-Hant.')]
        : [cell.expected.installedFilename!]
      const accepted = expectedNames.map(n => join(mediaRoot, n).normalize('NFC'))
      const got = decision.installedPath?.normalize('NFC') ?? null
      ok = got != null && accepted.includes(got) && existsSync(got) && languageOk
    }
    const acquisitionAttempted = tap.toolCalls.includes('download_candidate') || tap.toolCalls.includes('install_subtitle')
    return { cell: id, run, ok, got: decision.decision, want: cell.expected.decision, acquisitionAttempted, toolCalls: tap.toolCalls }
  } catch (e) {
    const acquisitionAttempted = tap.toolCalls.includes('download_candidate') || tap.toolCalls.includes('install_subtitle')
    return { cell: id, run, ok: false, got: 'THREW', want: cell.expected.decision, err: String(e), acquisitionAttempted, toolCalls: tap.toolCalls }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/** For a no_safe_match result (either got OR want it, so a mismatched expectation is still
 *  labeled) — the refusal-quality signal that is the whole point of this tap. Never affects pass/
 *  fail; purely for the human reading matrix output to spot Bazarr-style grab-then-refuse runs. */
function refusalLabel(res: CellResult): string {
  if (res.got !== 'no_safe_match' && res.want !== 'no_safe_match') return ''
  return res.acquisitionAttempted
    ? ' [refusal:ACQUISITION-ATTEMPTED — grabbed a wrong candidate, north-star smell]'
    : ' [refusal:clean]'
}

/** Terse tool-sequence trace, only for successful installs (the no_safe_match labeling above is
 *  the point of this tap; this is a lightweight bonus for the other interesting outcome). */
function toolsLabel(res: CellResult): string {
  if (res.got !== 'installed' || !res.toolCalls?.length) return ''
  const seq = res.toolCalls.join('→')
  return ` [tools:${seq.length > 120 ? `${seq.slice(0, 117)}...` : seq}]`
}

async function main() {
  const cells = selected()
  if (cells.length === 0) { console.error('no seeded cells match the selection'); process.exit(1) }
  const model = makeModel({ baseUrl: process.env.LLM_BASE_URL!, apiKey: process.env.LLM_API_KEY!, model: process.env.LLM_MODEL! })
  console.error(`running ${cells.length} cell(s) × ${repeat} run(s) against ${process.env.LLM_MODEL}\n`)
  const results: CellResult[] = []
  for (const c of cells) for (let r = 1; r <= repeat; r++) {
    const res = await runOne(c, r, model)
    results.push(res)
    console.error(`${res.ok ? 'PASS' : 'FAIL'} ${res.cell} run ${r}: got=${res.got} want=${res.want}${res.err ? ` err=${res.err.slice(0, 200)}` : ''}${refusalLabel(res)}${toolsLabel(res)}`)
  }
  const passed = results.filter(r => r.ok).length
  console.error(`\n=== ${passed}/${results.length} passed ===`)
  // Per-cell stability (flakiness signal across repeats).
  for (const c of cells) {
    const rs = results.filter(r => r.cell === `${c.resourceType}/${c.sourceForm}`)
    const p = rs.filter(r => r.ok).length
    if (p !== rs.length) console.error(`  unstable: ${c.resourceType}/${c.sourceForm}: ${p}/${rs.length} stable`)
  }
  process.exit(passed === results.length ? 0 : 2)
}
main().catch(e => { console.error(e); process.exit(1) })
