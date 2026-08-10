# Old-Pipeline Retirement — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. This plan targets capable sonnet subagents that CAN read the repo — file-level deletion detail lives in `docs/design/2026-07-14-old-pipeline-retirement-scope.md` (the survey); DO NOT duplicate it, read it.

**Goal:** Retire the pre-v3 deterministic subtitle pipeline (`runPipeline` + its forced-JSON LLM stack + old single-shot agents + old daemon feed/routing) now that v3 is proven live (stage-3 acceptance PASS, 12/12 orchestrator matrix). Wall ① (captcha off the forced-JSON stack) is already done (`479f157`).

**Architecture:** Two "load-bearing walls" still tie the old pipeline into live code: Wall ① (captcha — DONE) and Wall ② (v3 realign worker still calls `runPipeline` for its post-restructure per-episode subtitle fetch). Sever Wall ②, then retire the old daemon feed/routing, then delete the now-unreferenced modules. Each phase keeps `tsc + vitest + web` green; realign's 5 data-safety layers are NEVER weakened (Wall ② only swaps the injected subtitle-fetch seam, not the restructuring/manifest/reveal logic).

**Tech Stack:** TypeScript ESM (`.js` specifiers), vitest, zod, ai@7. Live validation runs on the soft router (`ssh media-router`, `/mnt/nvme0n1-4/scout-test`, real `.env`) against an ISOLATED NAS test dir the user has authorized us to build/copy-into/thrash.

---

## Gate discipline
- After EVERY task: `npx tsc --noEmit` clean + `npx vitest run` green. Commit per task.
- Phases are sequential. Phase 3 (deletions) MUST NOT start until Phase 1 (Wall ②) is implemented AND Phase 2 (live-validated on the NAS) passes — deleting the fallback before the replacement is proven live is the one thing we don't do.

---

## Phase 1 — Wall ②: realign's per-episode subtitle fetch → v3 find-subtitle worker

**What stays untouched (safety):** `executeRealign`'s restructuring — `assembleInvisibleTree`, manifest write-ahead, `waitForJellyfinIdle`, reveal, archive/rollback (realignExecutor.ts ~433–670). Wall ② ONLY changes the implementation behind the `deps.runEpisode` seam called at realignExecutor.ts ~675 (the "字幕先行 / subtitle-first" step, whose failures are already caught + non-blocking, and whose RETURN VALUE IS IGNORED by the caller).

### Task 1: Swap `makeRealignRunEpisode` backend from `runPipeline` to the v3 find-subtitle worker

**Files:**
- Modify: `src/v2/realignExecutor.ts` — `makeRealignRunEpisode` (~214) + its imports (drop `runPipeline`/`PipelineResult` from `../core/pipeline.js` once unused).
- Modify: `src/cli/index.ts` — where `makeRealignRunEpisode({makeDeps, withJournal, cacheRoot})` is wired (~391) — inject the find-subtitle worker deps (model + adapters + cacheRoot) instead of the runPipeline closure.
- Test: `src/v2/realignExecutor.test.ts` (or the realign runEpisode test) — swap the injected `runPipelineImpl` fake for a find-subtitle-worker fake.

**Approach (read the real code before writing):**
- `makeFindSubtitleWorker({ model, adapters, cacheRoot, stepCap?, timeoutMs?, fetchImpl? }) → runFindSubtitleTask(task: FindSubtitleTask): Promise<FindSubtitleDecision>` (`src/agent/findSubtitleWorker.ts`). It self-sandboxes (`isUnderRoots(dirname(task.videoPath), [task.mediaRoot])`), stages, installs the sub next to `task.videoPath`, and cleans up.
- Rewrite `makeRealignRunEpisode` to build a `FindSubtitleTask` from the realign per-episode inputs (`ctx: MediaContext`, `outDir`, `jobId`) and call `runFindSubtitleTask`. The `MediaContext` (see `buildRealignMediaContext`) already carries videoPath (the `.realign-build` path), series title, year, tmdbId, season/episode, and the absolute episode number — map those onto `FindSubtitleTask` fields (read `FindSubtitleTask` in `src/agent/findSubtitleWorker.schemas.js` for exact field names incl. `absoluteEpisode`, `mediaRoot`, `langTags`).
- CRITICAL sandbox point: the video lives under the `.realign-build` invisible tree; set `task.mediaRoot` to the realign libRoot (the root that CONTAINS `.realign-build`) so `isUnderRoots` passes and the sub installs INTO the build tree (so reveal shows a subtitled tree). Verify against how the old `runEpisode` got its root (the mount-sentinel/root-precheck already validated writability).
- Keep the seam injectable for tests: `makeRealignRunEpisode(assembled, opts)` where `opts.runFindSubtitleTaskImpl?` replaces the old `opts.runPipelineImpl?`. The returned function keeps signature `(ctx, outDir, jobId) => Promise<unknown>` (caller ignores the result — do NOT invent a PipelineResult mapping; return the `FindSubtitleDecision` or void).
- Preserve the `withJournal` wrap ONLY if the worker needs it; the v3 worker has its own logging, so journaling may drop away here — decide by reading what `withJournal` provides and whether the worker duplicates it. If dropped, note it.

**Steps:**
- [ ] Read `makeFindSubtitleWorker`, `FindSubtitleTask` schema, `buildRealignMediaContext`, and the current `makeRealignRunEpisode` + its cli/index.ts wiring + its test.
- [ ] Update the realign runEpisode test first: inject a fake `runFindSubtitleTask` that records the `FindSubtitleTask` it received; assert the task's videoPath/mediaRoot/season/episode/absoluteEpisode are built correctly from a realign ctx, and that a thrown fetch is still swallowed non-blockingly by `executeRealign`'s caller. Run it red.
- [ ] Rewrite `makeRealignRunEpisode` to construct the task + call the worker. Rewire `cli/index.ts` to inject `{ model: makeModel(...), adapters: buildAdapters(...), cacheRoot }` (reuse the same adapter/model construction the find-subtitle worker path already uses elsewhere in index.ts — grep for `makeFindSubtitleWorker` to copy the wiring).
- [ ] Green the test; `tsc` clean; full `vitest` green.
- [ ] Commit: `refactor(v3): Wall ② — realign per-episode subtitle fetch runs the v3 find-subtitle worker, not runPipeline`.

### Task 2: Live-validate Wall ② on an isolated NAS test dir (the gate for Phase 3)

**This is a live run, not a unit test.** The user authorized building an isolated test dir on the NAS, copying real resources in, and thrashing them (no fear of breaking/deleting — blast radius stays inside the test dir).

**Steps:**
- [ ] On `ssh media-router`: create `/mnt/nvme0n1-4/nas_media/_scout_realign_test/` (an isolated dir OUTSIDE any real Jellyfin library path so no production scan touches it, OR a throwaway library — confirm it's not under a live library root unless intentionally testing the full path). Copy in a REAL messy-absolute-numbered anime (e.g. one whose files are flat-absolute-numbered 1..N while TMDB splits it into seasons — 进击的巨人 / 咒术 style). Keep the copy small if possible (symlink or a few episodes).
- [ ] Deploy current HEAD to the router test dir (`git archive HEAD` → scp → extract into `/mnt/nvme0n1-4/scout-test`, per the established flow; `.env` + node_modules volume persist).
- [ ] Run realign against the test dir (via the manual realign entrypoint / a small driver script — check `scripts/` for a realign live driver; if none, write a throwaway one under `scripts/` mirroring `live-accept-find-subtitle.ts`'s construction but calling `executeRealign`). Detached + retry-poll (home network can be flaky).
- [ ] GATHER EVIDENCE (do not self-certify): the restructured tree is correct (episodes renumbered per absolute→season/episode), subtitles were installed INTO the revealed tree next to the right episodes, the manifest/archive is coherent, and NO file outside the test dir moved. Report the evidence for the main session to judge PASS/FAIL.
- [ ] Only on PASS: proceed to Phase 3.

---

## Phase 2 — Retire the old daemon feed + job routing

Read scope doc §"两条管线并存" + §建议退役顺序 step 5. The old path (`series_season|movie|realign` job.kind → `executeJob` → `runPipeline`) is fed by `aggregate` (v2/aggregator.ts) on the daemon reconcile loop.

### Task 3: Stop the old feed and route only through v3
**Files:** `src/v2/aggregator.ts` (`aggregate`), `src/cli/index.ts` (daemon reconcile → aggregate wiring; `cmdWatch` old `executeJob` branch; `cmdRun`/`cmdRunItem` runPipeline calls), `src/v2/executor.ts` (`executeJob` series_season/movie branches).
- [ ] Read those sites. Make the daemon reconcile stop creating `series_season`/`movie` jobs; ensure the v3 orchestrator/worker path is what the daemon drives (or is manually/dashboard-triggered as designed — confirm the intended daemon behavior with the scope doc + spec before removing the only auto-trigger; if v3 has no daemon auto-trigger yet, that is a SEPARATE gap — flag it, do not silently strand coverage).
- [ ] Update/remove the tests bound to the old feed. `tsc` + `vitest` green. Commit.

> **Judgment gate for the main session:** if removing the old feed leaves NO automatic subtitle acquisition (because v3 orchestrator is manual/dashboard-only today), STOP and surface it — that is a product decision (wire a v3 daemon trigger vs. accept manual-only), not a mechanical deletion.

---

## Phase 3 — Delete the now-unreferenced old modules

Only after Phase 1+2. Read scope doc §"纯旧路径（可删候选）" for the exact file list. Delete in dependency order, `tsc`+`vitest` green after EACH deletion (the compiler is the guide — a still-referenced module won't delete cleanly).

### Task 4: Delete old pipeline + gates + single-shot agents + executor internals + aggregator
- [ ] Delete `core/pipeline.ts`, `core/gate.ts`, `core/orphanGate.ts`, `core/seasonPackGate.ts`, `core/cache.ts`, `core/journal.ts` (verify no v3 importer first — `core/episode.ts`, `core/schemas.ts`, `core/mediaContext.ts`, staging/sandbox/fetchLib/download/subtitleWriter/subtitleInspect are KEEP per scope doc).
- [ ] Delete the 9 old single-shot agents (identifyMedia/planSearch/rankCandidates-LLM/verifySubtitle/judgeOrphan/mapSeasonPack/mapLooseEpisodes/diagnoseSeason/harvestAlias) — but FIRST confirm `mirrorExceedsSeasonTable` was already extracted out of diagnoseSeason (it was → `seasonShape.ts`; verify v3 imports point there, not diagnoseSeason).
- [ ] Delete `executeJob` old branches + `makeRunEpisode` + `makeDiagnoseSeason` + `aggregator.ts`.
- [ ] Delete the forced-JSON LLM stack ONLY once nothing references it: `callStructured`/`callPromptJson` in `llm.ts` (KEEP `makeModel`/`injectExtraBody`/`withConnectRetry`/`extractJson` if still used), `runtime.ts`, `probe.ts`, `profile.ts`, `quirks.ts`. Grep-verify zero production+test importers before each delete.
- [ ] Commit per coherent deletion batch, green throughout.

### Task 5 (optional/last): DB + deployment cleanup
- [ ] (optional, riskiest — leave enum values if unsure) DB `job.kind` CHECK constraint removal of `series_season|movie` needs a full-table-rebuild migration; harmless to keep the enum values, so default to SKIP unless clearly worth it.
- [ ] Deployment: remove the `LLM_EXTRA_BODY` thinking-disabled escape hatch from operator config (it conflicts with reasoning_effort:high) — doc/ops change, coordinate with the user.

---

## Self-review notes
- Spec coverage: Wall ② (scope walls ①②) ✓ (① done, ② Task 1+2); old feed/routing (scope step 5) ✓ Task 3; module deletion (scope step 6) ✓ Task 4; DB/deploy (step 7-8) ✓ Task 5. `mirrorExceedsSeasonTable` extraction (step 1) already done — Task 4 verifies the repoint.
- The one real UNKNOWN, flagged as a judgment gate in Task 3: whether v3 has an automatic daemon trigger, or is manual/dashboard-only. If manual-only, retiring the old auto-feed changes product behavior — surface, don't bulldoze.
- Data-safety invariant restated in Phase 1: Wall ② swaps ONLY the injected `runEpisode` seam; restructuring/manifest/reveal/rollback untouched; live-validated on an isolated NAS dir before any deletion.
