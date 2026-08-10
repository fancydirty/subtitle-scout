# Translation Hardening and Live-Test Campaign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Qualify Mimo on all three translation source paths, close the known correctness and observability gaps under TDD, then prove the release candidate with a destructive from-zero live test.

**Architecture:** Keep `translateItem` as the I/O boundary, `translateSubtitle` as the deterministic translation pipeline, `LibraryRepo` as the parked-path state owner, and worker wrappers as run-accounting owners. Deploy and qualify between code phases so model behavior is never confused with an obsolete pipeline; run the final daemon detached on the router and monitor it from the orchestrator at fixed intervals.

**Tech Stack:** TypeScript 6, Node.js 22, Vitest, better-sqlite3, ffprobe/ffmpeg, Docker Compose, BusyBox router shell.

---

## File Map

- Modify `src/translate/translateItem.ts`: reject duration-mismatched source subtitles before any LLM call while preserving the post-translation guard.
- Modify `src/translate/translateItem.test.ts`: lock preflight ordering and postflight defense.
- Modify `src/translate/translatePipeline.ts`: sanitize ASS override blocks and count attempted LLM calls.
- Modify `src/translate/translatePipeline.test.ts`: cover sanitation, empty-cue rejection, retries, failures, and call counts.
- Modify `src/translate/qualityGate.ts`: reject candidate cues whose visible text is empty after sanitation.
- Modify `src/translate/qualityGate.test.ts`: lock empty-text fail-closed behavior.
- Modify `src/v2/translateWorkerTask.ts`: persist `llm_calls` for every instrumented translation outcome.
- Modify `src/v2/translateWorkerTask.test.ts`: verify zero and non-zero accounting on installed, held, no-source, and error paths.
- Modify `src/v2/libraryRepo.ts`: own parked-path retry eligibility and state transitions.
- Modify `src/v2/libraryRepo.test.ts`: cover staged delay, fingerprint reset, reason reset, and override eligibility.
- Modify `src/v2/ingest.ts`: skip unchanged parked files until eligible and pass fingerprints when parking.
- Modify `src/v2/ingest.test.ts`: prove expensive recognition is suppressed and resumes on each eligibility signal.
- Modify `src/v2/db.ts`: add parked negative-cache columns through one additive migration.
- Modify `src/v2/db.test.ts`: prove fresh schema and migration shape.
- Update `docs/design/2026-07-21-campaign-run-log.md`: record deployments, qualification evidence, repairs, reset, monitoring, and final outcome.
- Update `docs/design/2026-07-22-live-test-postmortem.md`: correct any model-capability conclusion contradicted by controlled evidence.

## Task 1: Baseline Verification and Controlled Deployment

**Files:**
- No source changes.
- Evidence: `docs/design/2026-07-21-campaign-run-log.md`

- [ ] **Step 1: Record the local baseline**

Run:

```bash
git status --short --branch
git log --oneline -8
npm test
npm run check
```

Expected: only known `.claude/` and `.omo/` untracked paths; at least `1918 passed | 1 skipped`; TypeScript exits zero.

- [ ] **Step 2: Verify the router before deployment**

Run read-only checks over `ssh media-router`, falling back to `media-router-tunnel` only if direct SSH fails:

```bash
docker ps --filter name=subtitle-scout
docker exec subtitle-scout node -e "const Database=require('better-sqlite3'); const db=new Database('/cache/scout.db'); console.log(db.pragma('quick_check'))"
docker exec subtitle-scout node -e "const Database=require('better-sqlite3'); const db=new Database('/cache/scout.db'); console.log(db.prepare(\"select value from settings where key='ai_translate_enabled'\").get())"
```

Expected: container running, `quick_check` is `ok`, translation setting is not `true`.

- [ ] **Step 3: Capture pre-deploy evidence**

Create a timestamped router evidence directory and copy the database with SQLite's online backup mechanism or `VACUUM INTO`; save recent container logs and aggregate job/run counts. Do not print secret environment values.

Expected: evidence directory contains a restorable DB file, logs, and text summaries.

- [ ] **Step 4: Deploy the intended source tree**

Use `deploy/deploy.sh`'s rsync whitelist, but run the Docker build detached on the router:

```bash
nohup sh -c 'docker compose build subtitle-scout && docker compose up -d; code=$?; echo $code > /tmp/subtitle-scout-deploy.done' > /tmp/subtitle-scout-deploy.log 2>&1 &
```

Poll `/tmp/subtitle-scout-deploy.done`; do not assume an SSH connection surviving means the build completed.

Expected: exit code `0`, container running, translation setting remains disabled.

- [ ] **Step 5: Verify the deployed fixes**

Run container health, DB quick check, recent startup logs, and a source-revision marker derived from the deployed tree. Confirm no translation run started during deployment.

- [ ] **Step 6: Append deployment evidence and commit**

```bash
git add docs/design/2026-07-21-campaign-run-log.md
git commit -m "docs: record translation hardening deployment"
```

## Task 2: First Mimo Qualification Matrix

**Files:**
- Create runtime evidence under the router's timestamped campaign directory.
- Modify `docs/design/2026-07-21-campaign-run-log.md`.
- Modify `docs/design/2026-07-22-live-test-postmortem.md` only when evidence changes a prior conclusion.

- [ ] **Step 1: Locate exact fixtures without changing state**

Query the database for Witch Watch E02, a The Rig episode suitable for F1, Frieren E01, Adam E06, and Overflow. Verify video duration, embedded subtitle tracks, existing sidecars, item identity, and source-language metadata.

Expected: each selected path and expected translation leg is documented before execution.

- [ ] **Step 2: Remove only sidecars that would short-circuit the five controlled samples**

List each candidate path before deletion. Delete known generated subtitle extensions adjacent to those fixtures, never video extensions.

- [ ] **Step 3: Run the positive samples sequentially**

For each exact path, execute the built CLI in the container with `TRANSLATE_*` pointing to Mimo. Capture stdout/stderr, timestamps, output sidecar metadata, cue counts, final cue time, source reference, critic verdict, untranslated source lines, glossary conformance, and ASS override blocks.

Expected: path-specific evidence exists even when the outcome is honestly held.

- [ ] **Step 4: Run Adam E06 as a negative control**

Expected: `no-source`; no unrelated Jimaku source, no LLM request, no sidecar.

- [ ] **Step 5: Run Overflow as the pre-hardening duration baseline**

Expected: `duration-mismatch` and no sidecar. Record whether model calls occurred before rejection; this is the before-state for Task 3.

- [ ] **Step 6: Classify Mimo capability by language and path**

Use `PASS`, `HELD_MODEL_QUALITY`, `PIPELINE_DEFECT`, or `NO_SOURCE` for each sample. Do not collapse English and Japanese into one verdict.

- [ ] **Step 7: Append evidence and commit**

```bash
git add docs/design/2026-07-21-campaign-run-log.md docs/design/2026-07-22-live-test-postmortem.md
git commit -m "docs: record first mimo qualification matrix"
```

## Task 3: Reject Wrong-Duration Sources Before Translation

**Files:**
- Modify: `src/translate/translateItem.ts`
- Test: `src/translate/translateItem.test.ts`

- [ ] **Step 1: Write failing preflight tests**

Add tests proving both embedded and fetched source subtitles with a final-cue/video ratio outside `[0.85, 1.15]` return held before `gatherContext`, `buildGlossary`, `translateBatch`, critic, or `writeSidecar` run. Add a test where the source ratio is valid but a deliberately altered translated result is still rejected by the retained postflight guard.

Core assertion shape:

```ts
expect(result).toMatchObject({ status: 'held' })
expect(result.reason).toContain('duration-mismatch')
expect(modelCalls).toBe(0)
expect(written).toHaveLength(0)
```

- [ ] **Step 2: Run the focused test and verify RED**

```bash
npx vitest run src/translate/translateItem.test.ts
```

Expected: the new call-order assertion fails because translation currently occurs before duration comparison.

- [ ] **Step 3: Implement the minimal preflight**

Parse `src` immediately after extraction/fetch, probe video duration at most once, and return a stable mismatch result before context gathering or `translateSubtitle`. Reuse the probed duration for the existing postflight check.

Representative control flow:

```ts
const sourceCues = parseSrtCues(src)
const videoSec = deps.videoDurationSec ? await deps.videoDurationSec(videoPath) : null
if (videoSec !== null && videoSec > 0 && sourceCues.length > 0) {
  const sourceEndSec = cueEndSec(sourceCues[sourceCues.length - 1].timing)
  const sourceRatio = sourceEndSec / videoSec
  if (sourceRatio < 0.85 || sourceRatio > 1.15) {
    return { status: 'held', reason: `duration-mismatch: source ${Math.round(sourceEndSec)}s vs video ${videoSec}s`, sourceRef }
  }
}
```

- [ ] **Step 4: Run focused and full verification**

```bash
npx vitest run src/translate/translateItem.test.ts
npm test
npm run check
```

Expected: all pass and no baseline regression.

- [ ] **Step 5: Implementation review loop**

Dispatch a fresh Agency Code Reviewer. Resolve only verified correctness, safety, performance, or missing-test findings. Run focused tests after fixes.

- [ ] **Step 6: Commit**

```bash
git add src/translate/translateItem.ts src/translate/translateItem.test.ts
git commit -m "fix(translate): reject wrong-duration sources before llm"
```

## Task 4: Sanitize ASS Override Blocks Fail-Closed

**Files:**
- Modify: `src/translate/translatePipeline.ts`
- Modify: `src/translate/qualityGate.ts`
- Test: `src/translate/translatePipeline.test.ts`
- Test: `src/translate/qualityGate.test.ts`

- [ ] **Step 1: Write failing sanitation tests**

Cover `Dialogue {\an8}Hello` becoming `Dialogue Hello`, multiple commands in one override block, ordinary `{literal}` preservation, unchanged cue count/timing, and a cue containing only `{\an8}` failing instead of installing an empty cue.

Use an ASS-specific pattern, not a blanket brace remover:

```ts
const ASS_OVERRIDE = /\{\\[^}]*\}/g
```

- [ ] **Step 2: Verify RED**

```bash
npx vitest run src/translate/translatePipeline.test.ts src/translate/qualityGate.test.ts
```

Expected: leaked override blocks remain and override-only text can pass.

- [ ] **Step 3: Implement minimal sanitation before evaluation**

Sanitize translated cue lines before deterministic gate evaluation, critic review, and SRT serialization. Add a deterministic hard violation when any candidate cue has no non-whitespace visible text.

- [ ] **Step 4: Run focused and full verification**

```bash
npx vitest run src/translate/translatePipeline.test.ts src/translate/qualityGate.test.ts
npm test
npm run check
```

- [ ] **Step 5: Agency Code Reviewer loop and commit**

```bash
git add src/translate/translatePipeline.ts src/translate/translatePipeline.test.ts src/translate/qualityGate.ts src/translate/qualityGate.test.ts
git commit -m "fix(translate): strip ass overrides from srt output"
```

## Task 5: Add Parked-Path Negative Cache

**Files:**
- Modify: `src/v2/db.ts`
- Modify: `src/v2/db.test.ts`
- Modify: `src/v2/libraryRepo.ts`
- Modify: `src/v2/libraryRepo.test.ts`
- Modify: `src/v2/ingest.ts`
- Modify: `src/v2/ingest.test.ts`

- [ ] **Step 1: Write failing schema and repository tests**

Add additive parked-path columns for `retry_count`, `next_retry_at`, `probe_mtime`, and `probe_size`. Test these transitions:

```text
new park                    -> retry_count=0, next_retry_at=now+1h
same reason + fingerprint   -> retry_count=1, next_retry_at=now+4h
same reason + fingerprint   -> retry_count=2, next_retry_at=now+24h
later identical attempts    -> remain on 24h stage
changed reason              -> reset to 1h stage
changed fingerprint         -> eligible immediately, then reset to 1h stage if re-parked
matching override           -> eligible immediately
```

- [ ] **Step 2: Verify RED**

```bash
npx vitest run src/v2/db.test.ts src/v2/libraryRepo.test.ts src/v2/ingest.test.ts
```

Expected: columns and eligibility APIs do not exist.

- [ ] **Step 3: Implement the additive migration and repository policy**

Keep retry arithmetic in `LibraryRepo`; do not scatter delay calculations through ingest. Expose one query such as:

```ts
shouldRetryParkedPath(path: string, fingerprint: FileFingerprint, now: number): boolean
```

and extend the park write to receive the observed fingerprint. `findOverride(path)` remains the authoritative immediate-retry signal in ingest.

- [ ] **Step 4: Integrate the skip before `recognize(path)`**

After `statFile(path)` and before the full recognition path, skip unchanged ineligible parked paths. Keep the path in `seenPaths` so cleanup cannot delete it. Do not count a skipped path as a newly parked result.

- [ ] **Step 5: Prove recognition suppression and wake-up**

Tests must assert `recognize` call counts across time boundaries, fingerprint changes, reason changes, and an added override.

- [ ] **Step 6: Run focused and full verification**

```bash
npx vitest run src/v2/db.test.ts src/v2/libraryRepo.test.ts src/v2/ingest.test.ts
npm test
npm run check
```

- [ ] **Step 7: Dual Agency review**

Dispatch Code Reviewer and Database Reliability Engineer in parallel. Verify every finding against the code before assigning fixes. Require migration-from-prior-schema evidence and no destructive table rebuild.

- [ ] **Step 8: Commit**

```bash
git add src/v2/db.ts src/v2/db.test.ts src/v2/libraryRepo.ts src/v2/libraryRepo.test.ts src/v2/ingest.ts src/v2/ingest.test.ts
git commit -m "fix(ingest): back off unchanged parked paths"
```

## Task 6: Record Translation LLM Calls

**Files:**
- Modify: `src/translate/translatePipeline.ts`
- Modify: `src/translate/translatePipeline.test.ts`
- Modify: `src/translate/translateItem.ts`
- Modify: `src/translate/translateItem.test.ts`
- Modify: `src/v2/translateWorkerTask.ts`
- Modify: `src/v2/translateWorkerTask.test.ts`

- [ ] **Step 1: Write failing accounting tests**

Test exact attempted-call counts:

```text
empty source                          -> 0
glossary success + 2 batches          -> 3
glossary failure + 1 batch            -> 2
one batch fails twice then succeeds   -> glossary + 3 batch attempts
critic attempted                      -> add 1, even when critic throws
preflight duration mismatch/no-source -> 0
```

Worker tests must prove `runs.insert` receives the result count for installed and held outcomes and zero for instrumented no-source outcomes.

- [ ] **Step 2: Verify RED**

```bash
npx vitest run src/translate/translatePipeline.test.ts src/translate/translateItem.test.ts src/v2/translateWorkerTask.test.ts
```

- [ ] **Step 3: Count at call boundaries**

Add `llmCalls` to `TranslationResult` and `TranslateItemResult`. Increment immediately before each `buildGlossary`, `translateBatch`, and critic attempt. Propagate the integer through `translateItem` to `runTranslateWorkerTask`, and include `llmCalls` in every recorded translation run.

Do not derive counts from successful output arrays. A thrown or timed-out attempt still costs one call.

- [ ] **Step 4: Run focused and full verification**

```bash
npx vitest run src/translate/translatePipeline.test.ts src/translate/translateItem.test.ts src/v2/translateWorkerTask.test.ts src/v2/runsRepo.test.ts
npm test
npm run check
```

- [ ] **Step 5: Dual Agency review**

Dispatch Code Reviewer and Database Reliability Engineer in parallel. Verify that all translation terminal states write an integer and existing non-translation run semantics remain unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/translate/translatePipeline.ts src/translate/translatePipeline.test.ts src/translate/translateItem.ts src/translate/translateItem.test.ts src/v2/translateWorkerTask.ts src/v2/translateWorkerTask.test.ts
git commit -m "feat(translate): account for attempted llm calls"
```

## Task 7: Release-Candidate Verification and Deployment

**Files:**
- Modify: `docs/design/2026-07-21-campaign-run-log.md`

- [ ] **Step 1: Inspect the complete campaign diff**

```bash
git status --short
git diff 0546f24..HEAD --stat
git diff --check 0546f24..HEAD
```

- [ ] **Step 2: Run release verification**

```bash
npm test
npm run check
npm run build
```

Expected: all commands exit zero and test count is no lower than baseline.

- [ ] **Step 3: Dispatch Agency close-code reviews**

Run Code Reviewer over the complete hardening diff and SRE over daemon/ingest/retry/accounting behavior. Fix only confirmed findings through fresh implementation subagents, then repeat release verification.

- [ ] **Step 4: Deploy with AI translation disabled**

Use the detached build protocol from Task 1. Verify schema migration, DB quick check, container health, and effective setting.

- [ ] **Step 5: Repeat the five-sample qualification matrix**

Expected: Adam uses zero calls and returns `no-source`; Overflow uses zero calls and returns `duration-mismatch`; no installed subtitle contains ASS overrides; every sample has plausible `llm_calls`; positive E/F1/F2 paths have explicit evidence-based outcomes.

- [ ] **Step 6: Gate the destructive reset**

Do not continue if any `PIPELINE_DEFECT` remains. Honest language-specific `HELD_MODEL_QUALITY` is documented and evaluated against whether the full test can safely remain fail-closed.

- [ ] **Step 7: Commit release-candidate evidence**

```bash
git add docs/design/2026-07-21-campaign-run-log.md docs/design/2026-07-22-live-test-postmortem.md
git commit -m "docs: qualify translation hardening release candidate"
```

## Task 8: Destructive Reset and Detached Full-Library Test

**Files:**
- Modify: `docs/design/2026-07-21-campaign-run-log.md`

- [ ] **Step 1: Save final pre-reset evidence**

Create a timestamped router evidence directory with DB snapshot, quick check, logs, and aggregate state. This is diagnostic evidence only.

- [ ] **Step 2: Stop the daemon and enumerate deletion scope**

Produce a list of generated subtitle sidecars by known subtitle extensions under configured test roots. Assert the list contains no video extensions before deletion.

- [ ] **Step 3: Delete generated Scout state**

Delete listed sidecars and Scout-owned DB/WAL/SHM/cache/task/run state. Retain source videos, `.env`, compose configuration, and deployment files.

- [ ] **Step 4: Initialize a fresh database with translation disabled**

Start the container, verify schema and quick check, then set `ai_translate_enabled=true` only after the clean initialization is proven healthy.

- [ ] **Step 5: Start detached and write markers**

Start the daemon under Docker Compose. Save timestamped logs and create campaign start metadata. Define explicit `failed` evidence when monitoring triggers stop conditions; operational completion is derived from DB quiescence rather than daemon exit.

- [ ] **Step 6: Perform the 10-minute early check**

Run local `sleep 600` with a timeout above 10 minutes. On wake, inspect container health, DB quick check, queue growth, first runs, model-call rate, and logs.

- [ ] **Step 7: Monitor hourly**

Run `sleep 3600` with a timeout above one hour. After each wake, record:

```text
container health
quick_check
jobs by task_type/state
currently claimable jobs
runs by decision
installed/held/dormant/no-source counts
sum(llm_calls) and recent per-run counts
new sidecars and automatic audit results
new error signatures and repetition counts
```

Continue until two consecutive checks meet quiescence or an automatic stop condition occurs.

- [ ] **Step 8: Stop and repair on incident**

For wrong installations, gate bypass, hot loops, DB failure, patrol starvation, source overwrite risk, cue-loss acceptance, or call amplification: disable AI translation, preserve exact evidence, add a failing test, dispatch a fresh implementation subagent, audit the fix, deploy, and restart from the appropriate clean boundary.

- [ ] **Step 9: Audit installed subtitles**

Automatically check every installed sidecar for parseability, duration ratio, non-empty cues, Chinese-content expectations, and ASS override leakage. Manually sample representative E, F1, F2, download, held, and no-source paths using stored evidence.

- [ ] **Step 10: Commit the live-test report**

```bash
git add docs/design/2026-07-21-campaign-run-log.md docs/design/2026-07-22-live-test-postmortem.md
git commit -m "docs: report clean full-library live test"
```

## Task 9: Final Reality Check

**Files:**
- Modify: `docs/design/2026-07-21-campaign-run-log.md`

- [ ] **Step 1: Dispatch Agency Reality Checker**

Provide the approved spec, implementation plan, all campaign commits, complete test output, qualification evidence, migration evidence, router logs, final DB summaries, and installed-subtitle audit. Require a verdict of `NEEDS WORK` unless every release claim has evidence.

- [ ] **Step 2: Verify findings independently**

Reproduce each blocker or reject it with direct evidence. Send confirmed blockers to fresh implementation subagents and repeat their relevant review and test gates.

- [ ] **Step 3: Run final local verification**

```bash
git diff --check
npm test
npm run check
npm run build
git status --short --branch
```

- [ ] **Step 4: Record final disposition**

Document the Reality Checker verdict, residual model limitations, remaining non-critical risks, exact test counts, deployed revision, live-test result, and whether AI translation was left enabled or disabled.

- [ ] **Step 5: Commit documentation only; do not push**

```bash
git add docs/design/2026-07-21-campaign-run-log.md docs/design/2026-07-22-live-test-postmortem.md
git commit -m "docs: close translation hardening campaign"
```
