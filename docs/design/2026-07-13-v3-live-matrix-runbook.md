# v3 Live Test Matrix — Runbook (auto-research loop)

The A-layer machine is built. This is how to *populate and run* the matrix — the ongoing loop
that turns exposed problems into hardened skills and code. Populating all cells is continuous
operation, not a one-shot build.

## The two consumers
- **In-suite deterministic** (`src/testing/findSubtitleWorker.replay.test.ts`, in `npm test`):
  real adapters + replay + scripted mock. Proves recorded responses parse and plumbing carries
  them. Deterministic — safe for CI. Home for **code-bug** regressions.
- **Out-of-band real-model** (`scripts/run-live-matrix.ts`, NEVER in `npm test`): real reasoning
  model + replay providers. Proves **judgment**. Non-deterministic — run manually, observe.

## Adding a cell
1. **Record** the source's real responses (rate-limited, one-time; re-running REPLACES the
   cell's responses/ wholesale):
   `npx tsx scripts/record-provider-responses.ts --type <t> --form <f> --title "<title>" [--original … --season … --episode … --year …]`
   → writes `fixtures/v3-live/<t>/<f>/responses/`.
   **Heed the recorder's WARNING about ambiguous path buckets**: >1 recording on the same
   method+path means a model query that doesn't exactly match a recorded signature will fail —
   and NOT loudly: runSearch converts the throw into a discarded provider_error, the model sees
   zero candidates and honestly finalizes no_safe_match, and the runner prints a plain FAIL with
   no err. A fixture problem masquerading as a model-judgment failure. Prune to one recording
   per path (keep the one whose query the model most plausibly issues).
2. **Author** `fixtures/v3-live/<t>/<f>/cell.json`: the `task`, and the **correct** `expected`
   answer (which candidate/file/language, or `no_safe_match` for a counter-example cell).
   Deciding the correct answer is the human's job — the recorder only captures what the source
   returned. If the recorder crashed mid-mint (assrt in-body failure), just re-run it: the mint
   is wipe-and-replace.
3. **Flip** the catalog entry in `src/testing/liveMatrix.ts` to `seeded: true`.
4. **Verify plumbing:** `npx vitest run src/testing/liveMatrix.test.ts` (structural validation
   of all seeded cells is automatic) — optionally add a deterministic replay case mirroring
   `findSubtitleWorker.replay.test.ts` for high-value cells.
5. **Run judgment:** `npx tsx scripts/run-live-matrix.ts --type <t> --form <f> --repeat 3`.

## The loop (test-matrix spec §暴露问题的处置)
Run a cell → problem exposed → **systematic-debugging** to root cause → classify:
- **Code bug** (param-flow / parse / plumbing): fix the code, add a deterministic regression to
  `findSubtitleWorker.replay.test.ts` (or `.eval.test.ts`) using the recorded response shape.
- **Judgment / cognition gap** (model mis-locates, mislabels 简/繁, treats a pack as "not
  single"): fix the **skill** (`src/agent/skills/findSubtitleSkill.ts`). **HARD LAW: skills are
  edited ONLY by the human + orchestrating Claude — the running agent NEVER self-edits a
  skill.** Re-run the cell (`--repeat`) to confirm the skill patch actually moved judgment
  (step-trace before assuming — the earlier misdiagnosis lesson: 2 skill patches did nothing
  because the real root cause was param-flow, not cognition).
- **Fixture problem** (ambiguous buckets, stale residue): re-record; not a code or skill issue.
Re-run the affected cells after each sediment.

## Quota reality
- assrt: 5/min rate limit, NO daily cap — record freely, just slowly (client enforces 15s).
- OpenSubtitles: 100/day but only *downloads* count; search/query is free.
- Real model (mimo token plan): resets in 4 days — don't conserve, expect slowness instead.

## Wall-time expectations
The runner is strictly sequential: worst case = seeded-cells × repeat × up to 5 min (the
worker's per-task 300s timeout). `--all --repeat 3` over a grown matrix is an hours-scale run;
select cells (`--type/--form`) for tight loops.

## Containerized run
`scripts/run-live-matrix-in-orbstack.sh --type <t> --form <f>` — replay mode needs only the LLM
network; providers are served from mounted fixtures. The container is isolation convenience;
the runner's own mkdtemp roots already keep it off real media.
