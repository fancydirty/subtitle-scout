# Translation Hardening and Live-Test Campaign Design

## Context

Subtitle Scout's AI fallback can translate an embedded text track (E), a fetched
source-language subtitle (F1), or a Jimaku Japanese subtitle (F2). A prior
from-zero run found real fail-closed behavior, but its model-quality evidence was
contaminated by two workflow defects: unrelated Jimaku entries could be selected,
and an embedded English track could be described to the model as Japanese. Those
defects, plus a duration gate and repeated-held circuit breaker, are committed
through `0546f24` but are not yet deployed.

The media-router installation is a destructive integration-test environment. All
generated subtitle sidecars, the Scout database, caches, and run history may be
deleted and rebuilt. Model quota may be consumed freely. Source video files remain
the reusable test fixtures and are not deleted.

## Goal

Produce a release candidate whose known translation, source-selection,
observability, and retry defects are fixed under TDD, then prove it from a clean
database in a monitored full-library live test.

## Campaign Order

The order is a release gate, not a suggestion:

1. Deploy the already-tested fixes while automatic translation remains disabled.
2. Run a small Mimo qualification matrix and negative controls.
3. Fix all confirmed preflight defects under TDD.
4. Re-run the qualification matrix against the resulting release candidate.
5. Only after the second matrix passes, delete generated state and start the
   full-library live test.
6. If the live test exposes a correctness defect, stop translation, preserve the
   failure evidence, fix it under TDD, and restart from the appropriate clean
   boundary.

This prevents a multi-hour live test from blocking known repairs or producing
evidence from a version that is already obsolete.

## Phase 1: Safe Deployment of Existing Fixes

Deploy commits through `0546f24` to the media router. Keep
`ai_translate_enabled=false` throughout deployment and qualification so the
daemon cannot race controlled tests.

Deployment acceptance requires:

- the running image identifies the intended source revision;
- the container remains healthy;
- SQLite `quick_check` succeeds;
- the AI translation setting remains disabled; and
- no uncontrolled translation job writes a sidecar.

Before destructive reset, retain only diagnostic evidence: a database snapshot,
relevant logs, effective non-secret configuration names, queue summaries, and run
summaries. This evidence is for comparison, not restoration.

## Phase 2: Mimo Qualification Matrix

### Positive paths

Run these directly and sequentially instead of waiting for daemon dispatch:

| Sample | Path | Required evidence |
|---|---|---|
| Witch Watch E02 | E: embedded English text track | Prompt source language is English; translation and critic finish; timing and cue invariants hold |
| The Rig suitable episode | F1: fetched English subtitle | No usable embedded source; provider fetch, translation, critic, and install path are exercised |
| Frieren E01 | F2: Jimaku Japanese subtitle | Jimaku source identity is correct; Japanese-to-Chinese quality is measured independently |

Model capability is reported per source language. An English pass does not imply a
Japanese pass, and one failed sample does not become a global model verdict without
the recorded gate and critic evidence.

For each positive sample record:

- source reference and detected source language;
- source and output cue counts;
- source and output final cue time;
- untranslated-source detection;
- glossary compliance;
- critic verdict and reason;
- leaked ASS override tags;
- LLM call count; and
- whether a sidecar was written only after every gate passed.

### Negative controls

| Sample | Expected outcome |
|---|---|
| Adam E06 | `no-source`; unrelated Jimaku entries are rejected; no model call and no sidecar |
| Overflow TV-length video with full-version subtitle | `duration-mismatch`; no model call once the pre-translation gate exists; no sidecar |

The first qualification run may still spend model calls on Overflow because the
currently committed duration gate runs after translation. That observation is the
baseline for the pre-translation duration fix.

## Phase 3: Preflight Hardening

Each item is an independent TDD change and independent commit. Implementers use
the smallest correct diff and may not weaken quality thresholds merely to make a
sample pass.

### 3.1 Pre-translation source-duration gate

After source extraction or fetch, parse the source cues and compare the final cue
end to the probed video duration before glossary construction or batch translation.
If the ratio is outside `[0.85, 1.15]`, return held with a stable
`duration-mismatch` reason and perform zero model calls. Retain the existing
post-translation duration check as defense in depth.

If the video duration cannot be probed, preserve current behavior rather than
inventing a duration. Empty or unparsable subtitle input remains fail-closed in the
existing text pipeline.

### 3.2 ASS override-tag sanitation

Remove ASS/SSA override blocks such as `{\an8}` from translated cue text before SRT
serialization. Sanitation must not alter timing, cue count, ordinary braces, or
normal text. Empty text created by sanitation must not allow a vacuous quality
pass.

### 3.3 Parked-path negative cache

Skip expensive re-identification when a path is unchanged and its park reason has
not earned another attempt. Use deterministic retry stages of 1 hour, 4 hours, and
24 hours. A file fingerprint change or an explicit recognition override makes the
path immediately eligible.

The implementation must preserve the dashboard's parked-path facts and must not
turn a temporary external failure into a permanent park. Schema changes, if
needed, follow the existing migration sequence and are covered by migration tests.

### 3.4 LLM-call accounting

Every worker run that invokes an LLM records an integer `llm_calls`, including
failed, timed-out, and held runs. Translation accounting includes glossary,
translation batches, and critic calls actually attempted. Runs with no LLM call
record zero rather than null when their execution path is instrumented.

Counting belongs at call boundaries, not inferred from success results. Existing
`assrt_calls` semantics remain unchanged.

### 3.5 Newly discovered defects

A qualification failure is actionable only when backed by a preserved input,
observed output, logs, and a reproducible expected result. The fix follows the same
red test, minimal implementation, focused verification, full verification, and
review cycle. Architectural enhancements not required to close a demonstrated
failure remain out of scope.

## Review and Acceptance Workflow

The orchestrator remains the only agent allowed to integrate, deploy, reset test
state, or declare acceptance. Every implementation task follows this loop:

1. A fresh implementation subagent receives one task, exact scope, TDD requirement,
   and verification commands.
2. The orchestrator inspects the diff and focused test evidence.
3. A fresh Agency Agents **Code Reviewer** audits correctness, safety,
   maintainability, performance, and missing tests.
4. Reliability/daemon changes also receive an Agency Agents **SRE** audit.
5. SQLite/schema/accounting changes also receive an Agency Agents **Database
   Reliability Engineer** audit.
6. Actionable findings are verified by the orchestrator and returned to a fresh
   fix subagent. Reviewer suggestions are not implemented blindly.
7. The orchestrator runs focused tests, the complete test suite, and TypeScript
   checking before accepting the task.

At campaign close, a fresh Agency Agents **Reality Checker** compares this spec,
the final diff, test output, production evidence, and live-test report. It defaults
to `NEEDS WORK`; only evidence can produce a release-candidate verdict.

Agency persona prompts are sourced from the public `msitarzewski/agency-agents`
repository and supplied directly in subagent prompts. This avoids relying on the
local OpenCode persona registry, which has previously failed to load reliably.

## Phase 4: Release-Candidate Qualification

Deploy all accepted hardening commits with automatic translation disabled. Repeat
the full Phase 2 matrix. The full live test is blocked unless:

- all three positive paths produce the expected path-specific outcome;
- Adam rejects unrelated sources without an LLM call;
- Overflow is rejected before an LLM call;
- no installed SRT leaks ASS override tags;
- LLM counts match observed attempts; and
- no test writes an invalid sidecar.

A model-quality held result may be an honest outcome, but its language-specific
evidence must be understood before proceeding. Pipeline correctness cannot be
waived because a model is weak.

## Phase 5: Destructive Clean Reset

After release-candidate qualification:

- delete all generated subtitle sidecars from the configured test media roots;
- stop the daemon before deleting state;
- delete Scout DB, WAL, SHM, provider caches, task state, and run history;
- retain source videos and deployment configuration;
- initialize a fresh database;
- confirm schema and settings;
- enable AI translation; and
- start the release candidate against the complete media library.

Deletion is scoped by known subtitle extensions and Scout-owned cache paths. Source
video extensions are never part of a deletion command.

## Phase 6: Detached Live Test and Monitoring

The live test runs on the router independently of SSH and the chat session. Use a
background process/container with timestamped logs plus explicit start, done, and
failed markers. A disconnected SSH session must not stop the daemon.

Monitoring cadence:

1. Sleep 10 minutes after startup and perform an early health check.
2. If healthy, sleep 1 hour between progress checks.
3. Each check records queue state, active jobs, recent runs, installed/held/dormant
   counts, LLM calls, container health, database integrity, and log deltas.
4. Continue hourly sleeps while work remains and no stop condition is met.
5. Stop sleeping immediately when the queue reaches a stable terminal state or an
   incident is detected.

The local sleep command is only the orchestrator's timer. The router workload keeps
running in the background. Tool timeouts must exceed the requested sleep interval.

### Automatic stop conditions

Disable AI translation, retain evidence, and return to repair when any of these is
observed:

- wrong-title or wrong-version subtitle installation;
- source-video overwrite risk;
- repeated error hot loop or crash loop;
- SQLite integrity failure;
- unbounded provider or model call amplification;
- substantial cue loss accepted as installed;
- patrol starvation caused by translation work; or
- a deterministic gate bypass.

Honest `no-source`, held, dormant, and scheduled backoff outcomes do not stop the
run.

## Live-Test Completion Criteria

Because the daemon is permanent, completion means operational quiescence rather
than process exit:

- patrol work is drained;
- no job remains active/searching;
- no currently claimable wanted job remains;
- remaining work has an explicit done, dormant, no-source, or future-backoff state;
- two consecutive monitoring checks show stable state;
- no error hot loop is present;
- every installed subtitle passes automated duration, format, language, and tag
  checks; and
- representative E, F1, F2, downloaded, no-source, held, and recovery paths are
  sampled from evidence.

## Final Deliverables

- focused and full test evidence;
- Mimo qualification report split by language and source path;
- implementation commits for each accepted hardening item;
- per-task Agency Agents review findings and dispositions;
- detached live-test timeline and final database/queue summary;
- documented incidents, reproductions, fixes, and rerun evidence;
- final Reality Checker verdict; and
- no public push.

## Non-Goals

- deleting source video fixtures;
- lowering glossary, cue, timing, or critic thresholds to force installation;
- broad refactors unrelated to a reproduced defect;
- adding AniList identity resolution without evidence that it is required for this
  release candidate;
- publishing to the public repository; or
- treating old test-state restoration as a product requirement.
