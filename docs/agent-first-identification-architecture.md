# Agent-First Media Identification Architecture

**Date**: 2026-07-27
**Status**: Implemented (commits 669d3b0 → 0dcc010)

## Overview

The media identification architecture has been rebuilt so the **subtitle agent performs evidence-based identification itself**, not mechanical parsing. Mechanical parsing emits only raw data (file path, directory names, duration, structure hints, embedded subtitle languages). The agent receives this raw data, cleans it, searches TMDB, applies a two-evidence bar (name + independent structural evidence), writes series/movies/episodes rows to the database immediately upon successful identification, then proceeds to find subtitles.

## Architecture Flow

```
File on disk
  ↓
Mechanical ingest (identifyFromPath)
  → Emits raw data only: path, dirName, fileName, durationSec, embeddedLangs, structureHints
  → NO TMDB calls, NO database writes
  ↓
parked_paths table (reason: 'awaiting-agent-identification')
  ↓
Orchestrator dispatches (dispatch_unidentified_identification)
  ↓
Subtitle agent (findSubtitleWorker)
  ├─ Step 0: Identify media from raw evidence
  │   ├─ Clean title from dirName/fileName (strip fansub brackets, tech tags, mojibake)
  │   ├─ search_tmdb (hit treated as SUSPECT)
  │   ├─ get_tmdb_details
  │   ├─ Two-evidence bar: name match + structural evidence (season table / duration / year)
  │   └─ write_identified_media → creates series/movies/episodes rows
  │
  └─ Continue: find subtitles for the identified media
```

**Database is the state machine**: every step's output (identity, installed subtitles) is written to the database immediately. If the agent dies mid-run, the next agent can resume from the database state.

## Core Design Principles

### 1. Evidence-First (绝不脑补)

- The agent's model knowledge (Breaking Bad, The Conjuring, etc.) is NEVER used as evidence.
- Must call TMDB: `search_tmdb` for candidates, `get_tmdb_details` for verification.
- **Two-evidence bar**: name match is not enough; must have independent structural evidence (season table for TV, duration for movies).
- **Year mismatch = AUTOMATIC FAIL**, no matter how good other evidence looks.

### 2. Database as State Machine

- Identity written to DB **immediately** after verification (series.name, tmdb_id, episodes rows).
- Subtitle installs written to DB **immediately** per episode (subtitles rows).
- If agent dies, next agent resumes from DB state (not in-memory workflow).

### 3. Hallucination Defenses

- **404 check**: `write_identified_media` refuses to create rows if `getDetails` returns null (tmdbId doesn't exist on TMDB).
- **DB-authoritative embeddedLangs**: comes from ffprobe (parked row), not agent input. Prevents agent from hallucinating `['chi']` to permanently silence subtitle search.
- **Transaction**: multi-statement write (series + episode + probe memo + clear parked) is atomic.

### 4. Traps Handled

- **Copyright evasion**: 招z魂z4 (nonsense title for The Conjuring 4)
- **Mojibake**: H）后丨室 (corrupted Chinese title)
- **Fansub brackets**: [字幕组][1080p] (not part of title)
- **Same-name traps**: The Rig (2023 TV vs 2010 movie), Peacemaker (2022 DC vs 2020 Finnish)
- **Directory name as primary evidence**: when filename is pure tech tokens (2026.2160p.iT.WEB-DL...), title lives in directory name

### 5. Red Lines

- **NEVER identify from memory**: must call TMDB tools.
- **NEVER skip verification**: even when title looks obvious.
- **NEVER refuse whole-series identity for one odd episode**: single episode number exceeding season table is a data lag, not an identity problem.
- **NEVER write identity if duration is abnormal**: 15-min file vs 120-min TMDB runtime may be corrupt file, not wrong movie.

## What Changed

| Component | Old Behavior | New Behavior |
|---|---|---|
| **Ingest** | Parse → TMDB search (resolveToTmdb) → write rows | Parse → measure duration/probe embedded langs → park with raw data |
| **Agent** | Verify mechanical guess (Step 0 verification) | Identify from raw evidence (Step 0 identification) |
| **Database** | Rows written by ingest | Rows written by agent (write_identified_media) |
| **rescue agent** | Tried to fix bad identities | **Deleted** (agent does primary identification) |
| **resolveToTmdb** | Mechanical TMDB search + pick top hit | **Deleted** |

## Key Files

### New Files
- `src/agent/identityTools.ts` — `write_identified_media` tool (agent writes identity to DB)
- `src/recognition/rawEvidence.ts` — `RawFileEvidence` type (raw data carrier)
- `src/cli/unidentifiedFindSubtitle.ts` — reads parked_paths, builds targets with raw evidence

### Modified Files
- `src/v2/ingest.ts` — FULL PATH rewritten (290 lines → 37 lines): only collects raw data, parks
- `src/agent/skills/findSubtitleSkill.ts` — Step 0 rewritten: "verify" → "identify"
- `src/agent/findSubtitleWorker.ts` — added `identityDeps` for write_identified_media
- `src/agent/findSubtitleWorker.schemas.ts` — `identity` field replaces `identity_correction`/`identity_verified`
- `src/v2/libraryRepo.ts` — stores `duration_sec`/`embedded_langs` in parked_paths (JSON format)
- `src/agent/orchestratorAgent.tools.ts` — added `dispatch_unidentified_identification`
- `src/cli/index.ts` — wires unidentified scope

### Deleted Files
- `src/recognition/resolveToTmdb.ts` — mechanical identity guessing
- `src/agent/rescueWorker*.ts` (7 files) — rescue agent
- `src/agent/skills/rescueSkill.ts` — rescue skill
- `src/agent/identityEval.live.test.ts` — old verify-correction evaluation
- `src/v2/identityCorrectionLoop.test.ts` — old identity_correction tests

## Database Schema (v25)

`parked_paths` gains two columns:
- `duration_sec INTEGER` — file duration in seconds (from ffprobe)
- `embedded_langs TEXT` — embedded subtitle languages (JSON array: `'["eng","chi"]'`)

## Testing

- **1984 tests pass** (backend), **301 tests pass** (frontend)
- **Type check**: 0 errors (`tsc --noEmit`)
- **Production build**: passes
- Integration test: `src/agent/integration/agentIdentification.test.ts` verifies end-to-end flow (parked → identify → write DB → clear parked)

## Migration Notes

- **Existing parked paths**: get NULL for `duration_sec`/`embedded_langs` (v25 migration is backward compatible)
- **Existing library rows**: untouched (agent will re-verify them on next subtitle task)
- **Old `identity_overrides` with `source='agent'`**: should be cleared (new architecture doesn't use overrides for agent identification)

## Next Steps (Not in This Plan)

- [ ] Rewrite `identityEval.live.test.ts` for the new identify-from-raw flow (evaluate agent identification quality)
- [ ] Add batch agent-run mode for processing many parked files
- [ ] Add agent retry logic for transient TMDB API failures
- [ ] Metrics: track identification success rate, evidence quality

## Lessons Learned

This implementation followed the superpowers workflow (plan → independent review → subagent-driven implementation with two-stage review per task). Key lessons:

1. **Independent review caught 11 critical issues in the plan** (hallucinated APIs, wrong episodeId format, missing deps) that self-review missed. Never skip independent review.

2. **Subagents caught plan defects during implementation** (6+ per task on average). The plan's code snippets were often wrong against the real codebase. Two-stage review (spec compliance → code quality) caught safety issues (hallucination vectors, missing transactions) that spec compliance alone would have missed.

3. **Batch test updates require parallel subagents**. Task 13 (58 failing tests) failed twice with a single subagent; succeeded when split into 3 parallel groups.

4. **Type errors must be fixed incrementally**. Deferring typecheck fixes until the end left 58 errors; fixing them incrementally per task would have been cheaper.
