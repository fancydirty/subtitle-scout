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

interface CellResult { cell: string; run: number; ok: boolean; got: string; want: string; err?: string }

async function runOne(entry: CatalogEntry, run: number, model: LanguageModel): Promise<CellResult> {
  const cell = loadCell(entry.resourceType, entry.sourceForm)
  const id = `${entry.resourceType}/${entry.sourceForm}`
  const root = mkdtempSync(join(tmpdir(), 'scout-matrix-'))
  try {
    const mediaRoot = join(root, 'media', cell.task.title.replace(/[^\w.-]+/g, '_'))
    mkdirSync(mediaRoot, { recursive: true })
    const videoPath = join(mediaRoot, cell.task.videoFilename)
    const replay = makeReplayFetch(cell.responsesDir)
    const client = new AssrtClient({ token: 'replay', cacheDir: join(root, 'assrt-cache'), fetchImpl: replay, limiter: new MinIntervalLimiter(0) })
    const runTask = makeFindSubtitleWorker({
      model, adapters: [makeAssrtAdapter(client)], cacheRoot: join(root, 'cache'), fetchImpl: replay, stepCap: 500,
    })
    const task: FindSubtitleTask = { ...cell.task, jobId: `matrix-${id.replace('/', '-')}-${run}`, mediaRoot, videoPath }
    const decision = await runTask(task)
    // Assert per expectation. installed → decision + right file present + language; else → decision only.
    let ok = decision.decision === cell.expected.decision
    if (ok && cell.expected.decision === 'installed') {
      // NFC-normalize: install_subtitle NFC-normalizes the final path it returns, so a
      // hand-typed NFD installedFilename in cell.json (easy on macOS) would silently fail
      // byte-exact equality against a correct install.
      const want = join(mediaRoot, cell.expected.installedFilename!).normalize('NFC')
      ok = decision.installedPath === want && existsSync(want) && decision.installedLanguage === cell.expected.installedLanguage
    }
    return { cell: id, run, ok, got: decision.decision, want: cell.expected.decision }
  } catch (e) {
    return { cell: id, run, ok: false, got: 'THREW', want: cell.expected.decision, err: String(e) }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
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
    console.error(`${res.ok ? 'PASS' : 'FAIL'} ${res.cell} run ${r}: got=${res.got} want=${res.want}${res.err ? ` err=${res.err.slice(0, 200)}` : ''}`)
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
