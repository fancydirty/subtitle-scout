# F1+F2 Ship + Astronaut Live Test — Implementation Plan

> **For agentic workers:** Execute task-by-task. Steps use checkbox syntax. User authorized: commit, deploy, burn quota; **do not** push public GitHub.

**Goal:** Commit F1+F2, deploy to media-router with TRANSLATE_*/JIMAKU_*, unpark The Astronaut, run long-film translate live test, quality-review, log.

**Architecture:** Ship already-green local code; production rsync+docker; unlock film via identify_overrides (not recognizer tiebreak); E embedded-subrip path for ~90min film; nohup+done heartbeat.

**Tech Stack:** TypeScript, vitest, docker compose on media-router, company TRANSLATE endpoint, better-sqlite3 on production cache.

---

### Task 1: Baseline + commit F1+F2

**Files:** all current unstaged F1/F2 sources + design docs

- [ ] **Step 1:** `npx vitest run` expect ≥1873 passed; `npm run check` clean
- [ ] **Step 2:** `git add` sources+docs (not .env, not .claude/, not scratchpad secrets)
- [ ] **Step 3:** Commit message covering F1 retries/timeout + F2 jimaku + designs
- [ ] **Step 4:** Do **not** `git push`

### Task 2: Deploy to media-router

- [ ] **Step 1:** rsync whitelist: `src/` `package.json` `package-lock.json` `tsconfig*.json` `Dockerfile` `web/` (match prior deploy habit)
- [ ] **Step 2:** Append production `.env` TRANSLATE_* + JIMAKU_API_KEY from local (via ssh, never log keys)
- [ ] **Step 3:** nohup `docker compose build && docker compose up -d` + done marker under `/mnt/nvme0n1-4/docker/subtitle-scout/`
- [ ] **Step 4:** Verify container up; `node -e` can import new modules if needed

### Task 3: Unpark The Astronaut

- [ ] **Step 1:** Insert identify_overrides: path_prefix=`/media/movies/The Astronaut (2025)`, tmdb_id=`1086260`, is_tv=0
- [ ] **Step 2:** Delete parked_paths row for the mkv (or let next ingest clear)
- [ ] **Step 3:** Trigger ingest/watch tick or `reconcile` path so movies row appears
- [ ] **Step 4:** Confirm movies row: name The Astronaut, origin_lang en, path correct, sub_status not parked

### Task 4: Live translate The Astronaut

- [ ] **Step 1:** nohup `docker exec subtitle-scout node ... translate-item "<path>"` or CLI inside container
- [ ] **Step 2:** Poll done file every few minutes; log progress to campaign-run-log
- [ ] **Step 3:** On finish: record status, gate stats, sidecar path, sourceRef

### Task 5: Quality review + close

- [ ] **Step 1:** Sample ≥10 cues JA/EN→ZH (structure, terms, fluency)
- [ ] **Step 2:** Write findings to `docs/design/2026-07-21-campaign-run-log.md`
- [ ] **Step 3:** Update handoff doc status
- [ ] **Step 4:** Commit run-log/docs if changed (still no public push)

### Heartbeat protocol (all long tasks)

```
nohup sh -c 'CMD > LOG 2>&1; echo exit=$? > DONE' &
# poll: [ -f DONE ] || tail LOG; sleep 120–300; repeat
# never block a single bash tool call >2–3 min waiting
```
