// Out-of-band orchestrator matrix runner — NOT part of `npm test`. Real reasoning model + fully
// in-memory world (seeded DB + faked tmdb/jf — the orchestrator makes no network calls). Proves the
// orchestrator's JUDGMENT: dispatches only warranted, well-formed worker_tasks, and NEVER
// false-triggers destructive realign on a normal library (the zero-false-trigger pole star).
//
// Usage: npx tsx scripts/run-orchestrator-matrix.ts [--shape <name>] [--repeat N]
// Requires LLM_BASE_URL/LLM_API_KEY/LLM_MODEL in .env. No provider creds needed.
import { parseArgs } from 'node:util'
import 'dotenv/config'
import { makeModel } from '../src/agent/llm.js'
import { openDb } from '../src/v2/db.js'
import { JobsRepo } from '../src/v2/jobsRepo.js'
import { LibraryRepo } from '../src/v2/libraryRepo.js'
import { makeOrchestratorAgent } from '../src/agent/orchestratorAgent.js'
import { makeToolCallTap } from '../src/testing/toolCallTap.js'
import { seedBacklog, makeBacklogFakes, type BacklogShape } from '../src/testing/seedBacklog.js'
import { ORCHESTRATOR_BACKLOG_SHAPES } from '../src/testing/orchestratorBacklog.js'
import type { LanguageModel } from 'ai'

if (process.env.VITEST) throw new Error('orchestrator matrix runner must not run under vitest — it hits a real LLM')

const { values } = parseArgs({ options: { shape: { type: 'string' }, repeat: { type: 'string' } } })
const repeat = values.repeat ? Number(values.repeat) : 1
const shapes = values.shape ? ORCHESTRATOR_BACKLOG_SHAPES.filter(s => s.name === values.shape) : ORCHESTRATOR_BACKLOG_SHAPES
if (shapes.length === 0) { console.error(`no shape named ${values.shape}`); process.exit(1) }

function summarizeRows(jobs: JobsRepo): { find: string[]; realign: string[] } {
  const rows = jobs.listByState('wanted').filter(j => j.kind === 'worker_task')
  const find: string[] = [], realign: string[] = []
  for (const r of rows) {
    const p = JSON.parse(r.payload!)
    const id = `${r.series_id ?? ''}/${r.season ?? ''}/${r.movie_id ?? ''}`
    if (p.taskType === 'find_subtitle') find.push(id)
    else if (p.taskType === 'realign') realign.push(r.series_id ?? '')
  }
  return { find: find.sort(), realign: realign.sort() }
}

async function runShape(shape: BacklogShape, run: number, model: LanguageModel): Promise<boolean> {
  const db = openDb(':memory:'); const jobs = new JobsRepo(db); const lib = new LibraryRepo(db)
  seedBacklog(lib, shape)
  const { tmdb, jf } = makeBacklogFakes(shape)
  const tap = makeToolCallTap(model)
  let threw: string | undefined
  try {
    await makeOrchestratorAgent({ model: tap.model, lib, tmdb, jf, jobs, now: () => Date.now(), orchestratorJobId: null, stepCap: 500 })()
  } catch (e) { threw = String(e) }
  const got = summarizeRows(jobs)
  const wantRealign = [...shape.expected.realignSeriesIds].sort()
  const wantFind = shape.expected.findSubtitle.map(f => `${f.seriesId ?? ''}/${f.season ?? ''}/${f.movieId ?? ''}`).sort()
  // Pole star: realign set MUST match exactly (esp. empty on clean/normal). Find set: assert the
  // expected are all present (the model may reasonably also dispatch find for a realign season — do
  // not over-penalize extra finds), but realign is the hard gate.
  const realignOk = JSON.stringify(got.realign) === JSON.stringify(wantRealign)
  const findOk = wantFind.every(f => got.find.includes(f))
  const ok = !threw && realignOk && findOk
  console.error(`${ok ? 'PASS' : 'FAIL'} ${shape.name} run ${run}: realign got=${JSON.stringify(got.realign)} want=${JSON.stringify(wantRealign)}${realignOk ? '' : ' <REALIGN-GATE-LEAK>'} | find got=${JSON.stringify(got.find)} want_subset=${JSON.stringify(wantFind)}${findOk ? '' : ' <FIND-MISS>'}${threw ? ` THREW=${threw.slice(0, 160)}` : ''} | tools=${tap.toolCalls.join('->')}`)
  return ok
}

async function main() {
  const model = makeModel({ baseUrl: process.env.LLM_BASE_URL!, apiKey: process.env.LLM_API_KEY!, model: process.env.LLM_MODEL! })
  console.error(`running ${shapes.length} shape(s) x ${repeat} against ${process.env.LLM_MODEL}\n`)
  let pass = 0, total = 0
  for (const s of shapes) for (let r = 1; r <= repeat; r++) { total++; if (await runShape(s, r, model)) pass++ }
  console.error(`\n=== ${pass}/${total} passed ===`)
  process.exit(pass === total ? 0 : 2)
}
main().catch(e => { console.error(e); process.exit(1) })
