# v3 Agentic Rebirth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fixed 10-agent forced-JSON pipeline with an agentic architecture: a `ToolLoopAgent`-based find-subtitle worker that judges candidate belonging by metadata like a human (reasoning enabled, no dialogue reading, no confidence scores), a living-doc orchestrator that reads mechanical scan results and dispatches work, and a realign worker — all riding on the existing SQLite jobs state machine, coexisting with the old pipeline until live acceptance passes.

**Architecture:** Main-subagent tree. Mechanical pre-scan (existing `scanLibrary`/`classifyItemDetailed`, pure code, zero LLM) fills a living-doc (`LibraryRepo` tables). An orchestrator agent reads the living-doc via progressive-disclosure skills, decides dispatch order, writes `worker_task` rows to the jobs table (idempotent, exactly-once via existing claim/lease machinery). Stateless workers (find-subtitle, realign) claim `worker_task` rows, sandboxed to exactly one media directory via code-level path validation (`containingRoot`/`isUnderRoots`) plus prompt-level "you only know this one directory." The find-subtitle worker is a `ToolLoopAgent` with `reasoning: 'high'` that can re-search, compare candidates, and finalizes via `Output.object()` — replacing the old `llm.ts` `callStructured` forced single-tool-call path (which disabled thinking to force schema compliance) for this one code path, while the old path keeps running everywhere else until phase ⑧.

**Tech Stack:** TypeScript (ESM, `module: nodenext`), vitest, `ai@7.0.15`, `@ai-sdk/openai-compatible@^3.0.5`, `better-sqlite3@^12`, `zod@^4`. Node >=22.

**Scope note:** Phases ①–④ (foundation + core find-subtitle worker + DB backbone) are specified in full TDD detail below — failing test, minimal impl, passing test, commit, every step. Phases ⑤–⑧ (orchestrator, realign wrapper, trigger wiring, retirement) are specified at a slightly higher level per the requester's explicit instruction — real file paths and real signatures throughout, no placeholders, but fewer exhaustive edge-case tests spelled out. **If the scope of ⑤–⑧ grows during implementation, split them into a follow-up plan** (`docs/superpowers/plans/2026-07-XX-v3-orchestrator-and-cutover.md`) rather than shrinking their rigor to fit this document.

**Ground truth this plan is built on (read first if resuming):**
- Spec: `docs/design/2026-07-13-v3-agentic-rebirth-design.md` (8-phase migration ①–⑧, risk ledger, north star — this plan is the bite-sized TDD expansion of that sketch).
- Repo is `/Users/dirtyfancy/projects/subtitle-scout` — **not** `subtitle-plugin` (an old fork lacking `src/v2`). Verify `pwd` before starting if in doubt.

**Three corrections to the ai@7.0.15 API baked into every code sample below** (verified 2026-07-13 by reading the installed `.d.ts`, not from training-data memory — the package has moved since):
1. Instantiate `ToolLoopAgent` (a class), not `Agent` (an interface `Experimental_Agent` merely aliases `ToolLoopAgent`). `new ToolLoopAgent({ model, tools, instructions, stopWhen, output, reasoning, telemetry, prepareStep, activeTools })`, then `await agent.generate({ prompt, abortSignal })`.
2. **`abortSignal` and `timeout` are parameters of `.generate()`/`.stream()`, NOT of the constructor** — confirmed at `node_modules/ai/dist/index.d.ts:5245` (`generate({ abortSignal, timeout, ... }: AgentCallParameters<...>)`). Passing them to `new ToolLoopAgent({...})` is silently ignored (excess property, not a type error, since settings intersects `Omit<RequestOptions<TOOLS>, 'abortSignal'>`).
3. Structured output at loop end is the `output` option (`experimental_output` no longer exists in 7.0.15): `output: Output.object({ schema: zodSchema })` (`Output` is a value import from `'ai'` — `Output.object`/`.array`/`.text`/`.json`/`.choice` — confirmed at `node_modules/ai/dist/index.d.ts:3798`). Read the result off `result.output` (typed `z.infer<schema>`, confirmed via `GenerateTextResult.output: InferCompleteOutput<OUTPUT>` at line ~4570). This coexists with tools: the model reasons and calls tools across steps, and `Output.object`'s `parseCompleteOutput` parses the **final step's plain text** as JSON against the schema — it does NOT require a dedicated "finalize" tool call.

**Other verified API facts used throughout:**
- `stepCountIs(n)` and `hasToolCall(...names)` are both exported from `'ai'` (`stepCountIs` is `isStepCount` re-exported; confirmed at `dist/index.d.ts:8919`). `stopWhen` accepts an array; ToolLoopAgent's own default is `stepCountIs(20)`. Per the spec's test philosophy, phase ③ uses a deliberately high ceiling (`stepCountIs(500)`) during testing/observation, not a production-tuned cap.
- `reasoning` is a plain string union: `'provider-default' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'` (confirmed at `node_modules/@ai-sdk/provider/dist/index.d.ts:2166`). Setting `reasoning: 'high'` as a top-level call option on `generateText`/`ToolLoopAgent` is read by `@ai-sdk/openai-compatible`'s request builder and — **when no `providerOptions['subtitle-scout-llm'].reasoningEffort` override is present** — emitted as `reasoning_effort: 'high'` in the outgoing JSON body (confirmed by reading `node_modules/@ai-sdk/openai-compatible/dist/index.js:600`: `reasoning_effort: compatibleOptions.reasoningEffort ?? (isCustomReasoning(reasoning) && reasoning !== 'none' ? reasoning : void 0)`). This is the literal fix for the current thinking-disable illness in `src/agent/quirks.ts`/`probe.ts`/`profile.ts`.
- `tool({ description, inputSchema: zodSchema, execute: async (input, { abortSignal, toolCallId, messages, context }) => {...} })` — it is `inputSchema`, not `parameters` (confirmed at `node_modules/@ai-sdk/provider-utils/dist/index.d.ts:1678`); `execute` is optional (a tool without `execute` halts the loop, used by the SDK for approval-gated tools — not used in this plan).
- `ai/test` exports `MockLanguageModelV4` (already used by this repo's own `src/agent/llm.test.ts` — same mock-model pattern is reused verbatim below for consistency). `doGenerate` may be given as a function, a single result, or **an array of results consumed one per successive step** — exactly what a deterministic multi-step tool-loop test needs.
- `db.ts`'s current jobs table is schema v7 (`kind IN ('series_season','movie','realign')`, no `payload`/`parent_job_id` columns) — confirmed by reading `src/v2/db.ts` directly; the spec's "v8 migration" is real, not yet done.

**Testing/environment discipline (applies to every task below):**
- **vitest does NOT typecheck.** `vitest run` will happily pass a file with type errors in code paths untouched by the test. `tsc --noEmit` is the real gate. Every task's steps include `npm run check` (root — script is `"check": "tsc --noEmit"`, `tsconfig.json` has `strict: true`) and, for any task touching `web/`, also `cd web && npx tsc --noEmit` (uses `web/tsconfig.json`, `noEmit: true`, `strict: true` — the `web` package has no `"check"` npm script of its own, `npx tsc --noEmit` is the direct invocation; CI's `test.yml` currently only runs the root package's `tsc`/`vitest`, so web's typecheck is not yet enforced by CI and must be run by hand).
- **Two packages, both must stay green:** root (`vitest.config.ts` → `src/**/*.test.ts`) and `web/` (`web/vitest.config.ts`). Phases ①–⑥ do not touch `web/` at all — their tasks only need root checks. Phase ⑦ touches both.
- **RED-for-right-reason:** when a step says "run test, expect FAIL", read the actual failure output before moving on — a failure from a typo/import-path mistake is not the same as a failure from "function not implemented yet." If the reported error doesn't match what the step expects, stop and fix before writing the implementation.
- **Offline tests only unless a task explicitly says "live":** every test in phases ①–⑥ (and the offline eval harness in phase ③) uses `MockLanguageModelV4`, fake `FetchAdapter`s, and a real filesystem tmp dir (`mkdtempSync(join(tmpdir(), ...))`) or `:memory:` SQLite — never real network, real API keys, or a real LLM. The one exception is the phase ③ **live acceptance procedure**, which is explicitly manual and explicitly not part of `vitest run`.
- Commit messages below follow this repo's existing style (`type(scope): summary`, seen in `git log`: `feat`, `test`, `fix`, `chore(release)`, `build`, `merge`). Always end commits with the required `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` trailer per the harness's global git instructions.

---

## File structure

| Path | Phase | Responsibility |
|---|---|---|
| `src/agent/reasoningAgent.ts` | ① | `makeReasoningAgent()` factory wrapping `ToolLoopAgent` + `Output.object` + `reasoning` |
| `src/agent/reasoningAgent.test.ts` | ① | Mock-model proof of tool-loop + reasoning + structured output |
| `src/agent/skills/types.ts` | ② | `SkillDescriptor` type |
| `src/agent/skills/registry.ts` | ② | `read_doc` tool factory + system-prompt skill index builder |
| `src/agent/skills/registry.test.ts` | ② | Unit tests for the above |
| `src/agent/skills/findSubtitleSkill.ts` | ②/③ | Find-subtitle judgment playbook, `.ts` const module (mirrors `src/agent/playbooks/realignPlaybook.ts`) |
| `src/agent/resultHandles.ts` | ② | File-backed `ResultSetStore` + `search_source`/`list_candidates`/`get_candidate` tool factories |
| `src/agent/resultHandles.test.ts` | ② | Unit tests for the above |
| `src/agent/findSubtitleWorker.schemas.ts` | ③ | `FindSubtitleDecisionSchema`, `FindSubtitleTask` type |
| `src/agent/findSubtitleWorker.schemas.test.ts` | ③ | Schema round-trip tests |
| `src/agent/findSubtitleWorker.tools.ts` | ③ | `download_candidate`, `install_subtitle`, `check_episode_code_safety` tool factories |
| `src/agent/findSubtitleWorker.tools.test.ts` | ③ | Unit tests for the above (incl. sandbox-escape rejection) |
| `src/agent/findSubtitleWorker.ts` | ③ | `makeFindSubtitleWorker()` — assembles tools + skill + `ToolLoopAgent`, runs one task |
| `src/agent/findSubtitleWorker.test.ts` | ③ | End-to-end mock-model test of the full tool loop |
| `fixtures/v3-find-subtitle/{new-release,ongoing-series,old-movie,old-series,messy-layout}/fixture.json` | ③ | Offline eval fixtures (task + candidates + expected decision; sandbox-escape is already covered structurally by phase ③ Task 3 — no tool input accepts a raw path, so no 6th fixture is needed) |
| `src/agent/findSubtitleWorker.eval.test.ts` | ③ | Offline eval harness driving all fixtures |
| `docs/design/2026-07-13-v3-live-acceptance-checklist.md` | ③ | Manual live-acceptance procedure (real site, real LLM, real install) |
| `scripts/live-accept-find-subtitle.ts` | ③ | Guarded manual-run script implementing the checklist |
| `src/v2/db.ts` | ④ | Modify: push v8 migration (`kind` CHECK add `worker_task`, add `payload`, `parent_job_id`) |
| `src/v2/migration.worker-task-kind.test.ts` | ④ | Round-trip migration test (mirrors `migration.realign-job-kind.test.ts`) |
| `src/v2/jobsRepo.ts` | ④ | Modify: `JobKind`/`Job`/`JobIdent` types, new `upsertWorkerTask()` |
| `src/v2/jobsRepo.test.ts` | ④ | Modify: add `upsertWorkerTask` coverage |
| `src/agent/skills/orchestratorSkill.ts` | ⑤ | Orchestrator dispatch playbook |
| `src/agent/orchestratorAgent.ts` | ⑤ | `makeOrchestratorAgent()` — reads living-doc, dispatches `worker_task` rows, 100-cap spillover |
| `src/agent/orchestratorAgent.test.ts` | ⑤ | Mock-model dispatch scenario tests |
| `src/v2/realignWorkerTask.ts` | ⑥ | Wraps `executeRealign` as a claimable `worker_task` handler |
| `src/v2/realignWorkerTask.test.ts` | ⑥ | Claim → execute → complete coverage |
| `src/cli/index.ts` | ⑦ | Modify: `cmdWatch`'s claim-dispatch switch gains `kind === 'worker_task'`; new `cmdReconcileAll` |
| `src/dashboard/apiV2.ts`, `src/dashboard/router.ts` | ⑦ | Modify: `POST /api/v2/reconcile-all` endpoint |
| `web/src/components/*` | ⑦ | Modify: "全仓校验" button |
| `src/agent/llm.ts`, `runtime.ts`, `quirks.ts`, `probe.ts`, `profile.ts`, `identifyMedia.ts`, `planSearch.ts`, `rankCandidates.ts`, `verifySubtitle.ts`, `judgeOrphan.ts`, `mapSeasonPack.ts`, `mapLooseEpisodes.ts`, `diagnoseSeason.ts`, `harvestAlias.ts` | ⑧ | Retire (gated on phase ③ live acceptance) |

---

## Phase ① — `ToolLoopAgent` + reasoning path (coexists with `callStructured`)

Goal: prove the new API shape works end-to-end against a mock model, and prove the `reasoning` → `reasoning_effort` wiring is real — before building anything that depends on it. **Do not touch `src/agent/llm.ts`, `runtime.ts`, `quirks.ts`, `probe.ts`, or `profile.ts` in this phase** — they keep serving the old 10-agent path unchanged.

### Task 1: `makeReasoningAgent()` factory + mock-model proof

**Files:**
- Create: `src/agent/reasoningAgent.ts`
- Test: `src/agent/reasoningAgent.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/agent/reasoningAgent.test.ts
import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { MockLanguageModelV4 } from 'ai/test'
import { tool } from 'ai'
import { makeReasoningAgent } from './reasoningAgent.js'

const DecisionSchema = z.object({
  verdict: z.enum(['match', 'no_match']),
  reason: z.string(),
})

describe('makeReasoningAgent', () => {
  it('runs a tool-call step then produces schema-typed Output.object() on the final step', async () => {
    let call = 0
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        call++
        if (call === 1) {
          return {
            finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
            usage: {
              inputTokens: { total: 10, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 5, text: undefined, reasoning: undefined },
            },
            content: [
              { type: 'tool-call', toolCallId: 'c1', toolName: 'peek', input: JSON.stringify({}) },
            ],
            warnings: [],
          }
        }
        return {
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: {
            inputTokens: { total: 20, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 8, text: undefined, reasoning: undefined },
          },
          content: [
            { type: 'text', text: JSON.stringify({ verdict: 'match', reason: 'metadata lines up' }) },
          ],
          warnings: [],
        }
      },
    })

    const peekCalls: unknown[] = []
    const agent = makeReasoningAgent({
      model,
      tools: {
        peek: tool({
          description: 'peek at something',
          inputSchema: z.object({}),
          execute: async (input) => {
            peekCalls.push(input)
            return { ok: true }
          },
        }),
      },
      instructions: 'Decide match or no_match for the given evidence.',
      schema: DecisionSchema,
    })

    const result = await agent.generate({
      prompt: 'is this a match?',
      abortSignal: AbortSignal.timeout(30_000),
    })

    expect(peekCalls).toHaveLength(1)
    expect(result.output).toEqual({ verdict: 'match', reason: 'metadata lines up' })
    expect(result.steps.length).toBe(2)
  })

  it('defaults reasoning to "high" and stopWhen to stepCountIs(20) when not overridden', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: 5, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 3, text: undefined, reasoning: undefined },
        },
        content: [{ type: 'text', text: JSON.stringify({ verdict: 'no_match', reason: 'no evidence' }) }],
        warnings: [],
      }),
    })
    const agent = makeReasoningAgent({ model, tools: {}, schema: DecisionSchema })
    const result = await agent.generate({ prompt: 'p' })
    expect(result.output).toEqual({ verdict: 'no_match', reason: 'no evidence' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agent/reasoningAgent.test.ts`
Expected: FAIL with `Cannot find module './reasoningAgent.js'` (or `.ts` not found) — the module doesn't exist yet.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/agent/reasoningAgent.ts
import { ToolLoopAgent, Output, stepCountIs, type LanguageModel, type ToolSet } from 'ai'
import type { z } from 'zod'

export type ReasoningLevel = 'provider-default' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

export interface ReasoningAgentOptions<TOOLS extends ToolSet, SCHEMA extends z.ZodType> {
  model: LanguageModel
  tools: TOOLS
  schema: SCHEMA
  instructions?: string
  outputName?: string
  outputDescription?: string
  /** @default stepCountIs(20) — same default as the underlying ToolLoopAgent. Callers building
   *  production workers (phase ③) MUST override this explicitly (a big test-time ceiling like
   *  stepCountIs(500) per the spec's "observe first, cap later" test philosophy). */
  stopWhen?: ConstructorParameters<typeof ToolLoopAgent>[0]['stopWhen']
  /** @default 'high' — this is the actual fix for the old pipeline's thinking-disable illness
   *  (quirks.ts/probe.ts/profile.ts force thinking off to make forced tool_choice work). */
  reasoning?: ReasoningLevel
  telemetry?: { isEnabled: boolean }
}

/** Thin factory over ToolLoopAgent: bakes in Output.object(schema) for end-of-loop structured
 *  output and a sane reasoning default, so every v3 subagent (find-subtitle, orchestrator,
 *  realign-wrapper) configures the same handful of options instead of re-deriving the
 *  ToolLoopAgent constructor shape each time. Does NOT touch llm.ts's callStructured — this is
 *  a parallel, coexisting path (phase ① of the v3 migration). */
export function makeReasoningAgent<TOOLS extends ToolSet, SCHEMA extends z.ZodType>(
  opts: ReasoningAgentOptions<TOOLS, SCHEMA>,
) {
  return new ToolLoopAgent({
    model: opts.model,
    tools: opts.tools,
    instructions: opts.instructions,
    output: Output.object({
      schema: opts.schema,
      name: opts.outputName,
      description: opts.outputDescription,
    }),
    stopWhen: opts.stopWhen ?? stepCountIs(20),
    reasoning: opts.reasoning ?? 'high',
    telemetry: opts.telemetry,
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/agent/reasoningAgent.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Typecheck**

Run: `npm run check`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add src/agent/reasoningAgent.ts src/agent/reasoningAgent.test.ts
git commit -m "$(cat <<'EOF'
feat(agent): add ToolLoopAgent-based reasoning agent factory (v3 phase ①)

Coexists with the existing callStructured forced-tool path in llm.ts —
proves ToolLoopAgent + Output.object + reasoning against a mock model
before anything depends on it.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

### Task 2: Prove `reasoning: 'high'` really becomes `reasoning_effort: 'high'` over the wire

This is the load-bearing claim behind "phase ① fixes the thinking-disable illness." Test it directly against `@ai-sdk/openai-compatible` (the real provider this repo's `llm.ts` already uses), with a fake `fetch` — no mock-model abstraction, no network.

**Files:**
- Test: `src/agent/reasoningAgent.test.ts` (append)

- [ ] **Step 1: Write the failing test**

```ts
// append to src/agent/reasoningAgent.test.ts
import { generateText } from 'ai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'

describe('reasoning wiring over the wire (@ai-sdk/openai-compatible)', () => {
  it('reasoning:"high" is emitted as reasoning_effort:"high" in the request body', async () => {
    const requestBodies: unknown[] = []
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
      requestBodies.push(JSON.parse(init!.body as string))
      return new Response(
        JSON.stringify({
          id: 'x', created: 0, model: 'm',
          choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    const provider = createOpenAICompatible({
      name: 'subtitle-scout-llm',
      baseURL: 'https://example.invalid/v1',
      apiKey: 'test-key',
      fetch: fetchImpl as unknown as typeof fetch,
    })
    await generateText({ model: provider('test-model'), prompt: 'hi', reasoning: 'high' })
    expect(requestBodies).toHaveLength(1)
    expect((requestBodies[0] as { reasoning_effort?: string }).reasoning_effort).toBe('high')
  })

  it('reasoning:"none" does NOT emit reasoning_effort (matches isCustomReasoning exclusion)', async () => {
    const requestBodies: unknown[] = []
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
      requestBodies.push(JSON.parse(init!.body as string))
      return new Response(
        JSON.stringify({
          id: 'x', created: 0, model: 'm',
          choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    const provider = createOpenAICompatible({
      name: 'subtitle-scout-llm',
      baseURL: 'https://example.invalid/v1',
      apiKey: 'test-key',
      fetch: fetchImpl as unknown as typeof fetch,
    })
    await generateText({ model: provider('test-model'), prompt: 'hi', reasoning: 'none' })
    expect((requestBodies[0] as { reasoning_effort?: string }).reasoning_effort).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agent/reasoningAgent.test.ts`
Expected: This may in fact PASS immediately — it exercises only already-installed `ai`/`@ai-sdk/openai-compatible` code, no new production code is being introduced by this task. If it fails, the failure MUST be a real assertion mismatch (e.g. `reasoning_effort` undefined when `'high'` was expected) — if so, STOP: this means the `reasoning` → `reasoning_effort` mapping this whole phase relies on does not hold on the installed version, and phase ① must be re-planned around whatever `providerOptions` key it actually needs (re-check `node_modules/@ai-sdk/openai-compatible/dist/index.js` for the current mapping) before proceeding to phase ③.

- [ ] **Step 3: No implementation needed — this task is characterization, not construction**

There is no "make it pass" step: this test documents and locks in a fact about installed dependencies, guarding against a future `npm update` silently breaking the reasoning fix. If Step 2 passed, skip to Step 4.

- [ ] **Step 4: Typecheck**

Run: `npm run check`
Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add src/agent/reasoningAgent.test.ts
git commit -m "$(cat <<'EOF'
test(agent): lock in reasoning→reasoning_effort wiring over @ai-sdk/openai-compatible

Characterization test against the installed provider package (fake fetch,
no network) — proves the fix for the thinking-disable illness (quirks.ts/
probe.ts/profile.ts) is real before phase ③ depends on it.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

## Phase ② — Living-doc tools: progressive-disclosure skills + result-set handle-ization

Goal: two independent capabilities every later subagent needs. (a) `read_doc(name)`: system prompt only lists skill name+description; full text loads on demand. (b) Search results get written to a handle store and referenced by id — never inlined wholesale into the model's context, per Anthropic's writing-tools guidance and this repo's own `realignPlaybook.ts` precedent for keeping long instructional text out of prompt strings.

**Design note on skill file format:** skills are `.ts` const-string modules, not `.md` files — confirmed by reading `src/agent/playbooks/realignPlaybook.ts`, whose own header comment explains why: `tsconfig.build.json` only compiles `src/**/*.ts` (excludes `*.test.ts`), so a bare `.md` file would not survive into `dist/` without an extra asset-copy build step. This plan follows the same pattern for every new skill file.

**Design note on the result-set store:** file-backed (JSON, atomic tmp+rename), not a new DB table — this keeps phase ② independent of any DB migration (the only DB migration in this plan is phase ④'s, explicitly reserved for the jobs table). This mirrors the existing `ProfileStore` (`src/agent/profile.ts`) atomic-write idiom already in the codebase.

### Task 1: Skill descriptor type + find-subtitle skill content

**Files:**
- Create: `src/agent/skills/types.ts`
- Create: `src/agent/skills/findSubtitleSkill.ts`
- Test: `src/agent/skills/findSubtitleSkill.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/agent/skills/findSubtitleSkill.test.ts
import { describe, it, expect } from 'vitest'
import { FIND_SUBTITLE_SKILL } from './findSubtitleSkill.js'

describe('FIND_SUBTITLE_SKILL', () => {
  it('is non-empty and states the north-star rules the agent must follow', () => {
    expect(FIND_SUBTITLE_SKILL.descriptor.name).toBe('find-subtitle-judgment')
    expect(FIND_SUBTITLE_SKILL.descriptor.description.length).toBeGreaterThan(0)
    expect(FIND_SUBTITLE_SKILL.content).toMatch(/metadata/i)
    expect(FIND_SUBTITLE_SKILL.content).toMatch(/MUST NOT/i)
    // must not accidentally reference dialogue-content reading — that is the exact anti-pattern
    // this worker replaces (north star #1: judge by metadata, never by reading subtitle text).
    expect(FIND_SUBTITLE_SKILL.content).not.toMatch(/read (the )?dialogue/i)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agent/skills/findSubtitleSkill.test.ts`
Expected: FAIL — `Cannot find module './findSubtitleSkill.js'`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/agent/skills/types.ts
export interface SkillDescriptor {
  name: string
  description: string
}

export interface Skill {
  descriptor: SkillDescriptor
  content: string
}
```

```ts
// src/agent/skills/findSubtitleSkill.ts
// Judgment playbook for the find-subtitle worker (v3 phase ③). Written as a .ts const module,
// not .md — see the phase ② header note above (tsconfig.build.json only compiles .ts, mirrors
// src/agent/playbooks/realignPlaybook.ts). Loaded on demand via read_doc — the system prompt
// only ever sees the name+description from the descriptor below.
import type { Skill } from './types.js'

const CONTENT = `
# Find-Subtitle Judgment Playbook

## The one rule that overrides everything else

You judge whether a candidate subtitle BELONGS to this exact video by its METADATA and
CONTEXT — release name, native name, filelist entries, season/episode numbers, and the
structural inspection signals (cue count, time span, detected script) of a file you have
actually downloaded and opened. You judge the way a person picking a subtitle off a fansub
site would: by what the file is labeled and what it structurally looks like.

You MUST NOT read the dialogue text of a subtitle to decide whether it matches — opening a
file to check its cue count and time span is fine (that is structural inspection, not reading
the story); reasoning about what the characters say is not your job and is not necessary.
You MUST NOT compute or report a numeric confidence score anywhere — report a verdict and a
plain-language reason, never a number claiming certainty.

## Workflow

1. Read the task's media identity (title, alternative/native titles, year, season/episode,
   filename) from your instructions — it is fixed for this task, you do not re-derive it.
2. Call \`search_source\` with one or more queries built from the title/native title. It
   returns a result_set_id, a count, and a short top-N preview — NOT the full result set.
3. Use \`list_candidates\`/\`get_candidate\` to page through the result set instead of asking
   for everything at once. Prefer candidates whose release name, filelist entries, or upload
   context plausibly name this exact season/episode.
4. If nothing plausible turns up, you MAY call \`search_source\` again with different
   queries (alternate titles, romanizations, a narrower/wider query) — re-searching is
   expected, not a failure.
5. For a plausible candidate, call \`download_candidate\` to fetch it into your sandbox and
   get back structural inspection signals. Compare those signals against what a normal
   episode/movie of this runtime should look like (cue count in the low hundreds, span
   roughly matching runtime, decodable, not HTML, script matching your target language).
   A convincing filename sitting on top of implausible structural signals is NOT a match —
   trust the bytes over the label.
6. Only when you have genuinely decided — the way a person would after opening the file —
   call \`install_subtitle\` to atomically place it. If you are not sure, that is
   no_safe_match, not a hopeful guess: a wrong subtitle silently installed is worse than a
   gap that gets retried later.
7. Report your final decision (installed / no_safe_match / retry_later) with a concrete
   reason. retry_later is for transient failures (a provider errored, a download timed out) —
   not for "I am not confident," which is no_safe_match.

## Sandbox

You only know about ONE media directory for this task. There is no other directory in your
world — do not ask about, reference, or attempt to construct paths to any other location.
\`install_subtitle\` will refuse anything outside this task's directory regardless.
`.trim()

export const FIND_SUBTITLE_SKILL: Skill = {
  descriptor: {
    name: 'find-subtitle-judgment',
    description:
      'How to judge whether a downloaded candidate belongs to this exact video (metadata + structural inspection, never dialogue content, never a confidence score) and the search→compare→install workflow.',
  },
  content: CONTENT,
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/agent/skills/findSubtitleSkill.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck**

Run: `npm run check`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add src/agent/skills/types.ts src/agent/skills/findSubtitleSkill.ts src/agent/skills/findSubtitleSkill.test.ts
git commit -m "$(cat <<'EOF'
feat(agent): add find-subtitle judgment skill content (v3 phase ②)

.ts const module (not .md) so it survives the dist build — mirrors the
existing realignPlaybook.ts pattern.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

### Task 2: `read_doc` tool + skill registry (progressive disclosure)

**Files:**
- Create: `src/agent/skills/registry.ts`
- Test: `src/agent/skills/registry.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/agent/skills/registry.test.ts
import { describe, it, expect } from 'vitest'
import { systemPromptSkillIndex, makeReadDocTool } from './registry.js'
import type { Skill } from './types.js'

const skillA: Skill = { descriptor: { name: 'a', description: 'does a things' }, content: 'A full text' }
const skillB: Skill = { descriptor: { name: 'b', description: 'does b things' }, content: 'B full text' }

describe('systemPromptSkillIndex', () => {
  it('renders a compact name+description list, not full content', () => {
    const index = systemPromptSkillIndex([skillA, skillB])
    expect(index).toContain('a: does a things')
    expect(index).toContain('b: does b things')
    expect(index).not.toContain('A full text')
  })
})

describe('makeReadDocTool', () => {
  it('returns the full content for a known skill name', async () => {
    const readDoc = makeReadDocTool([skillA, skillB])
    const result = await readDoc.execute!({ name: 'b' }, { toolCallId: 't1', messages: [] } as any)
    expect(result).toEqual({ name: 'b', content: 'B full text' })
  })

  it('reports available names on an unknown skill name (fail-soft, not a thrown error)', async () => {
    const readDoc = makeReadDocTool([skillA, skillB])
    const result = await readDoc.execute!({ name: 'nope' }, { toolCallId: 't1', messages: [] } as any)
    expect(result).toEqual({ error: 'unknown skill: nope. Available: a, b' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agent/skills/registry.test.ts`
Expected: FAIL — `Cannot find module './registry.js'`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/agent/skills/registry.ts
import { tool } from 'ai'
import { z } from 'zod'
import type { Skill } from './types.js'

/** Compact "name: description" list — this is ALL that goes in a subagent's system prompt
 *  for progressive disclosure. Full skill text is only loaded on demand via read_doc. */
export function systemPromptSkillIndex(skills: Skill[]): string {
  return skills.map(s => `- ${s.descriptor.name}: ${s.descriptor.description}`).join('\n')
}

/** read_doc(name) tool: the hand-written progressive-disclosure loader called for in the
 *  design (NOT ai@7's uploadSkill/skills API — that is for provider-hosted sandboxes; this
 *  repo runs its own local tool loop). Unknown name is fail-soft (returns an {error} object
 *  the model can read and retry from), not a thrown exception — a thrown error inside a tool
 *  execute becomes a tool-result error the model sees anyway, but returning a structured
 *  {error} keeps the available-names list visible to the model without relying on how the
 *  SDK serializes thrown errors into tool results. */
export function makeReadDocTool(skills: Skill[]) {
  const byName = new Map(skills.map(s => [s.descriptor.name, s]))
  return tool({
    description:
      'Load the full text of a named skill document. Your system prompt only lists skill ' +
      'names and one-line descriptions — call this before you need the full instructions.',
    inputSchema: z.object({ name: z.string() }),
    execute: async ({ name }) => {
      const skill = byName.get(name)
      if (!skill) {
        return { error: `unknown skill: ${name}. Available: ${[...byName.keys()].join(', ')}` }
      }
      return { name: skill.descriptor.name, content: skill.content }
    },
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/agent/skills/registry.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck**

Run: `npm run check`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add src/agent/skills/registry.ts src/agent/skills/registry.test.ts
git commit -m "$(cat <<'EOF'
feat(agent): add read_doc progressive-disclosure tool + skill registry (v3 phase ②)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

### Task 3: File-backed result-set store (`search_source` handle-ization)

**Files:**
- Create: `src/agent/resultHandles.ts`
- Test: `src/agent/resultHandles.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/agent/resultHandles.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeFileResultSetStore } from './resultHandles.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'scout-resultsets-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('makeFileResultSetStore', () => {
  it('creates a result set and returns its count', () => {
    const store = makeFileResultSetStore(dir)
    const id = store.create([{ a: 1 }, { a: 2 }, { a: 3 }])
    expect(store.count(id)).toBe(3)
  })

  it('lists a page with offset/limit', () => {
    const store = makeFileResultSetStore(dir)
    const id = store.create([{ a: 1 }, { a: 2 }, { a: 3 }, { a: 4 }])
    expect(store.list(id, 1, 2)).toEqual([{ a: 2 }, { a: 3 }])
  })

  it('gets a single item by index, or null when out of range', () => {
    const store = makeFileResultSetStore(dir)
    const id = store.create([{ a: 1 }, { a: 2 }])
    expect(store.get(id, 1)).toEqual({ a: 2 })
    expect(store.get(id, 5)).toBeNull()
  })

  it('throws a clear error for an unknown result set id', () => {
    const store = makeFileResultSetStore(dir)
    expect(() => store.count('does-not-exist')).toThrow(/unknown result set/)
  })

  it('two result sets in the same store are independent', () => {
    const store = makeFileResultSetStore(dir)
    const id1 = store.create([{ a: 1 }])
    const id2 = store.create([{ a: 2 }, { a: 3 }])
    expect(store.count(id1)).toBe(1)
    expect(store.count(id2)).toBe(2)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agent/resultHandles.test.ts`
Expected: FAIL — `Cannot find module './resultHandles.js'`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/agent/resultHandles.ts
import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export interface ResultSetStore {
  create(items: unknown[]): string
  count(id: string): number
  list(id: string, offset: number, limit: number): unknown[]
  get(id: string, index: number): unknown | null
}

/** File-backed handle store for search_source's full result sets (design: "写 DB/文件,只返回
 *  {result_set_id,count,top-N}"). Deliberately file-backed, not a new DB table — keeps phase ②
 *  independent of any schema migration (the only migration in this plan is phase ④'s, on the
 *  jobs table). Atomic tmp+rename write mirrors the existing ProfileStore idiom
 *  (src/agent/profile.ts) already used in this codebase. */
export function makeFileResultSetStore(dir: string): ResultSetStore {
  mkdirSync(dir, { recursive: true })
  const pathFor = (id: string) => join(dir, `${id}.json`)
  const read = (id: string): unknown[] => {
    const p = pathFor(id)
    if (!existsSync(p)) throw new Error(`unknown result set: ${id}`)
    return JSON.parse(readFileSync(p, 'utf8'))
  }
  return {
    create(items) {
      const id = randomUUID()
      const finalPath = pathFor(id)
      const tmpPath = `${finalPath}.tmp`
      writeFileSync(tmpPath, JSON.stringify(items))
      renameSync(tmpPath, finalPath)
      return id
    },
    count(id) {
      return read(id).length
    },
    list(id, offset, limit) {
      return read(id).slice(offset, offset + limit)
    },
    get(id, index) {
      const items = read(id)
      return items[index] ?? null
    },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/agent/resultHandles.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Typecheck**

Run: `npm run check`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add src/agent/resultHandles.ts src/agent/resultHandles.test.ts
git commit -m "$(cat <<'EOF'
feat(agent): add file-backed result-set store for handle-ized search results (v3 phase ②)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

### Task 4: `search_source`/`list_candidates`/`get_candidate` tools over the result-set store

**Files:**
- Modify: `src/agent/resultHandles.ts`
- Modify: `src/agent/resultHandles.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// append to src/agent/resultHandles.test.ts
import { z } from 'zod'
import type { SubtitleCandidate } from '../core/schemas.js'
import { makeSearchSourceTool, makeListCandidatesTool, makeGetCandidateTool, summarizeCandidate } from './resultHandles.js'
import type { FetchAdapter } from '../cli/fetchLib.js'

function fakeCandidate(providerId: string, videoName: string): SubtitleCandidate {
  return {
    provider: 'assrt', providerId, videoName, nativeName: null, language: 'zh-CN',
    subtype: null, releaseSite: null, uploadDate: null,
    fileList: [{ index: 0, name: `${videoName}.srt` }],
  }
}

function fakeAdapter(results: SubtitleCandidate[]): FetchAdapter {
  return {
    name: 'assrt',
    enabled: () => true,
    search: async () => results,
    resolve: async () => { throw new Error('not used in this test') },
  }
}

describe('search_source / list_candidates / get_candidate tools', () => {
  it('search_source writes full results to the store and returns a handle + top-N preview', async () => {
    const store = makeFileResultSetStore(dir)
    const results = [fakeCandidate('1', 'Show.S01E01'), fakeCandidate('2', 'Show.S01E02'), fakeCandidate('3', 'Show.S01E03')]
    const searchSource = makeSearchSourceTool({ adapters: [fakeAdapter(results)], store, topN: 2 })
    const out = await searchSource.execute!({ queries: ['Show S01E01'], languages: ['zh-Hans'] }, { toolCallId: 't1', messages: [] } as any)
    expect(out.count).toBe(3)
    expect(out.top).toHaveLength(2)
    expect(out.top[0]).toEqual(summarizeCandidate(results[0]))
    expect(store.count(out.result_set_id)).toBe(3)
  })

  it('list_candidates pages through a result set by handle', async () => {
    const store = makeFileResultSetStore(dir)
    const id = store.create([fakeCandidate('1', 'A'), fakeCandidate('2', 'B'), fakeCandidate('3', 'C')])
    const listCandidates = makeListCandidatesTool(store)
    const out = await listCandidates.execute!({ result_set_id: id, offset: 1, limit: 1 }, { toolCallId: 't1', messages: [] } as any)
    expect(out.items).toEqual([summarizeCandidate(fakeCandidate('2', 'B'))])
  })

  it('get_candidate returns a concise summary by default, full object when detail=detailed', async () => {
    const store = makeFileResultSetStore(dir)
    const candidate = fakeCandidate('1', 'A')
    const id = store.create([candidate])
    const getCandidate = makeGetCandidateTool(store)
    const concise = await getCandidate.execute!({ result_set_id: id, index: 0, detail: 'concise' }, { toolCallId: 't1', messages: [] } as any)
    expect(concise).toEqual(summarizeCandidate(candidate))
    const detailed = await getCandidate.execute!({ result_set_id: id, index: 0, detail: 'detailed' }, { toolCallId: 't1', messages: [] } as any)
    expect(detailed).toEqual(candidate)
  })

  it('get_candidate reports an error for an out-of-range index', async () => {
    const store = makeFileResultSetStore(dir)
    const id = store.create([fakeCandidate('1', 'A')])
    const getCandidate = makeGetCandidateTool(store)
    const out = await getCandidate.execute!({ result_set_id: id, index: 9, detail: 'concise' }, { toolCallId: 't1', messages: [] } as any)
    expect(out).toEqual({ error: `no candidate at index 9 in result set ${id}` })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agent/resultHandles.test.ts`
Expected: FAIL — `makeSearchSourceTool is not a function` (etc.)

- [ ] **Step 3: Write minimal implementation**

```ts
// append to src/agent/resultHandles.ts
import { tool } from 'ai'
import { z } from 'zod'
import { runSearch, type FetchAdapter } from '../cli/fetchLib.js'
import { candidateKey, type SubtitleCandidate } from '../core/schemas.js'

export interface CandidateSummary {
  id: string
  provider: string
  videoName: string | null | undefined
  nativeName: string | null | undefined
  language: string | null | undefined
  subtype: string | null | undefined
  releaseSite: string | null | undefined
  fileList: { index: number; name: string }[]
}

/** Concise view of a SubtitleCandidate for a model to skim — drops nothing structurally
 *  important, just flattens candidateKey() into `id` for the model's convenience. */
export function summarizeCandidate(c: SubtitleCandidate): CandidateSummary {
  return {
    id: candidateKey(c), provider: c.provider, videoName: c.videoName, nativeName: c.nativeName,
    language: c.language, subtype: c.subtype, releaseSite: c.releaseSite, fileList: c.fileList,
  }
}

export interface SearchSourceDeps {
  adapters: FetchAdapter[]
  store: ResultSetStore
  topN?: number
}

/** search_source: runs the existing multi-provider fan-out (runSearch — fetchLib.ts, unchanged)
 *  but does NOT hand the full result list to the model. Full results go into the result-set
 *  store; the model gets a handle + count + a short preview (design: source-result
 *  handle-ization, "不内联" — Anthropic writing-tools guidance on large tool results). */
export function makeSearchSourceTool(deps: SearchSourceDeps) {
  return tool({
    description:
      'Search all configured subtitle providers for this media. Returns a result_set_id, a ' +
      'count, and a short top-N preview — call list_candidates/get_candidate to see more.',
    inputSchema: z.object({
      queries: z.array(z.string()).min(1),
      imdb: z.string().optional(),
      year: z.number().int().optional(),
      season: z.number().int().optional(),
      episode: z.number().int().optional(),
      filename: z.string().optional(),
      languages: z.array(z.string()).optional(),
    }),
    execute: async (args) => {
      const candidates = await runSearch({ ...args, deep: false }, deps.adapters, () => {})
      const resultSetId = deps.store.create(candidates)
      const topN = deps.topN ?? 5
      return {
        result_set_id: resultSetId,
        count: candidates.length,
        top: candidates.slice(0, topN).map(summarizeCandidate),
      }
    },
  })
}

export function makeListCandidatesTool(store: ResultSetStore) {
  return tool({
    description: 'Page through a result set previously returned by search_source.',
    inputSchema: z.object({
      result_set_id: z.string(),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(50).default(10),
    }),
    execute: async ({ result_set_id, offset, limit }) => {
      const items = store.list(result_set_id, offset, limit) as SubtitleCandidate[]
      return { items: items.map(summarizeCandidate) }
    },
  })
}

export function makeGetCandidateTool(store: ResultSetStore) {
  return tool({
    description: 'Fetch one candidate from a result set by index — concise summary or full detail.',
    inputSchema: z.object({
      result_set_id: z.string(),
      index: z.number().int().min(0),
      detail: z.enum(['concise', 'detailed']).default('concise'),
    }),
    execute: async ({ result_set_id, index, detail }) => {
      const item = store.get(result_set_id, index) as SubtitleCandidate | null
      if (!item) return { error: `no candidate at index ${index} in result set ${result_set_id}` }
      return detail === 'detailed' ? item : summarizeCandidate(item)
    },
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/agent/resultHandles.test.ts`
Expected: PASS (9 tests total)

- [ ] **Step 5: Typecheck**

Run: `npm run check`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add src/agent/resultHandles.ts src/agent/resultHandles.test.ts
git commit -m "$(cat <<'EOF'
feat(agent): add search_source/list_candidates/get_candidate tools (v3 phase ②)

Wraps the existing runSearch (fetchLib.ts, untouched) — full results go
into the handle store from Task 3, the model only ever sees a handle +
count + short preview.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

## Phase ③ — CORE: the find-subtitle worker

This is the north-star deliverable: a `ToolLoopAgent` that judges candidate BELONGING by metadata (never dialogue content, never a confidence score), can re-search and compare, reasons with `reasoning: 'high'`, and finalizes via `Output.object()`. Sandboxed to exactly one media directory.

**Sandbox design (two independent layers, per the spec's "两头堵"):**
1. **Code layer:** the worker is constructed once per task with a fixed `mediaRoot`/`outDir` supplied by the *caller* (orchestrator/daemon), never by the agent. No tool's `inputSchema` accepts a raw filesystem path — `download_candidate` takes `{provider, providerId, fileIndex}`, `install_subtitle` takes `{stagedFileId, langTag}` where `stagedFileId` is an opaque handle minted by our own code. The agent literally cannot express "install somewhere else" through any tool's input shape. `install_subtitle` additionally re-validates the computed final path with `isUnderRoots` (from `src/core/mediaContext.ts`, already used by `realignExecutor.ts` for the identical purpose) as defense-in-depth, even though the path is already fixed.
2. **Prompt/skill layer:** the instructions given to the agent state "you only know about one media directory" (see `FIND_SUBTITLE_SKILL` in phase ②) — no other directory name ever appears in its context.

**Design decision — no dedicated `finalize` tool:** the corrections above say `stopWhen: [stepCountIs(N), hasToolCall('finalize')]` is available API. This plan does NOT wire `hasToolCall('finalize')` into the find-subtitle worker's `stopWhen`, for a concrete, verified reason: `Output.object`'s structured-output parsing works by JSON-parsing the **final step's plain text** (confirmed by reading `parseAndValidateObjectResult` in `node_modules/ai/dist/index.js` — it calls `safeParseJSON(result)` on the raw text, then validates against the schema). If the model's last action were a tool call to a `finalize` tool instead of emitting text, that step's `result.text` would be empty and `Output.object` would throw `NoObjectGeneratedError` on an empty parse. The verified-working mechanism is: the model reasons, calls tools across steps, and eventually responds with plain text (no more tool calls) that IS the JSON decision — which is exactly what phase ①'s Task 1 test already proves end-to-end. `stopWhen` here is `[stepCountIs(N)]` only, as a token/time budget backstop, not a semantic termination signal. `hasToolCall` remains imported and available for a later phase (e.g. the orchestrator in phase ⑤, where a dedicated dispatch-complete tool call is a more natural fit) but is not load-bearing here.

### Task 1: `FindSubtitleTask` type + `FindSubtitleDecisionSchema`

**Files:**
- Create: `src/agent/findSubtitleWorker.schemas.ts`
- Test: `src/agent/findSubtitleWorker.schemas.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/agent/findSubtitleWorker.schemas.test.ts
import { describe, it, expect } from 'vitest'
import { FindSubtitleDecisionSchema } from './findSubtitleWorker.schemas.js'

describe('FindSubtitleDecisionSchema', () => {
  it('accepts an installed decision with all fields populated', () => {
    const parsed = FindSubtitleDecisionSchema.parse({
      decision: 'installed',
      reason: 'release name and cue count match',
      installedPath: '/media/Show/Show.S01E01.zh-Hans.srt',
      installedLanguage: 'zh-Hans',
      candidateProvider: 'assrt',
      candidateProviderId: '12345',
    })
    expect(parsed.decision).toBe('installed')
  })

  it('accepts a no_safe_match decision with null install fields', () => {
    const parsed = FindSubtitleDecisionSchema.parse({
      decision: 'no_safe_match',
      reason: 'no candidate plausibly named this episode',
      installedPath: null,
      installedLanguage: null,
      candidateProvider: null,
      candidateProviderId: null,
    })
    expect(parsed.decision).toBe('no_safe_match')
  })

  it('rejects an unknown decision value', () => {
    expect(() =>
      FindSubtitleDecisionSchema.parse({
        decision: 'maybe', reason: 'x',
        installedPath: null, installedLanguage: null, candidateProvider: null, candidateProviderId: null,
      }),
    ).toThrow()
  })

  it('rejects a missing reason', () => {
    expect(() =>
      FindSubtitleDecisionSchema.parse({
        decision: 'no_safe_match',
        installedPath: null, installedLanguage: null, candidateProvider: null, candidateProviderId: null,
      }),
    ).toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agent/findSubtitleWorker.schemas.test.ts`
Expected: FAIL — `Cannot find module './findSubtitleWorker.schemas.js'`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/agent/findSubtitleWorker.schemas.ts
import { z } from 'zod'

/** Terminal decision the find-subtitle worker's ToolLoopAgent reports via Output.object().
 *  No confidence score anywhere (north star #1) — decision + a plain-language reason. */
export const FindSubtitleDecisionSchema = z.object({
  decision: z.enum(['installed', 'no_safe_match', 'retry_later']),
  reason: z.string().min(1),
  installedPath: z.string().nullable(),
  installedLanguage: z.enum(['zh-Hans', 'zh-Hant']).nullable(),
  candidateProvider: z.string().nullable(),
  candidateProviderId: z.string().nullable(),
})
export type FindSubtitleDecision = z.infer<typeof FindSubtitleDecisionSchema>

/** Input to one find-subtitle worker run. Deliberately a narrow, purpose-built shape rather
 *  than the full legacy MediaContext (core/schemas.ts) — phase ③ stays decoupled from the old
 *  pipeline's types; a mapper from MediaContext → FindSubtitleTask is a phase ⑦ wiring concern,
 *  not this worker's. mediaRoot/videoPath together define the ONE sandboxed directory (see the
 *  phase ③ header's sandbox design) — both are supplied by the caller, never by the agent. */
export interface FindSubtitleTask {
  jobId: string
  mediaRoot: string
  videoPath: string
  videoFilename: string
  title: string
  originalTitle: string | null
  year: number | null
  season: number | null
  episode: number | null
  alternativeTitles: string[]
  overview: string | null
  runtimeMinutes: number | null
  providerIds: Record<string, string>
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/agent/findSubtitleWorker.schemas.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck**

Run: `npm run check`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add src/agent/findSubtitleWorker.schemas.ts src/agent/findSubtitleWorker.schemas.test.ts
git commit -m "$(cat <<'EOF'
feat(agent): add FindSubtitleTask type and FindSubtitleDecisionSchema (v3 phase ③)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

### Task 2: `download_candidate` tool (resolve → download → stage → inspect)

Wires three already-existing, pure/DI pieces exactly as-is per the reuse map: `runResolve`/`downloadDirect` (unchanged), `subtitleWriter.writeSubtitle` (unchanged), `subtitleInspect.inspectSubtitle` (unchanged).

**Correctness note found while designing this task:** `writeSubtitle`'s output filename is `${videoBase}.${langTag}${ext}` inside a fixed `outDir` — if every `download_candidate` call in one task shared the same staging directory, a SECOND download attempt (comparing a different candidate) would collide with the first attempt's filename and short-circuit through `writeSubtitle`'s `alreadyExists` fast path (see `src/files/subtitleWriter.ts:78-93`), silently returning the FIRST candidate's bytes info instead of downloading the second. The core capability "can re-search, can compare" (north star) requires downloading and inspecting more than one candidate per task. Fix: give every `download_candidate` call its own subdirectory under the sandbox, keyed by a fresh `stagedFileId`, so concurrent/sequential attempts within one task never collide.

**Files:**
- Create: `src/agent/findSubtitleWorker.tools.ts`
- Test: `src/agent/findSubtitleWorker.tools.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/agent/findSubtitleWorker.tools.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FetchAdapter } from '../cli/fetchLib.js'
import { makeDownloadCandidateTool } from './findSubtitleWorker.tools.js'

let sandboxDir: string
beforeEach(() => { sandboxDir = mkdtempSync(join(tmpdir(), 'scout-find-subtitle-tools-')) })
afterEach(() => { rmSync(sandboxDir, { recursive: true, force: true }) })

function fakeAdapter(url: string): FetchAdapter {
  return {
    name: 'assrt',
    enabled: () => true,
    search: async () => [],
    resolve: async () => ({ url, filename: 'Show.S01E01.srt' }),
  }
}

describe('download_candidate tool', () => {
  it('resolves, downloads, stages, and inspects — returns a stagedFileId + signals, does not install', async () => {
    const fetchImpl = vi.fn(async () => new Response(Buffer.from(
      '1\n00:00:01,000 --> 00:00:02,000\nhello\n',
    )))
    const tool_ = makeDownloadCandidateTool({
      adapters: [fakeAdapter('http://file0.assrt.net/x.srt')],
      stagingDir: sandboxDir,
      stagedFiles: new Map(),
      videoFilename: 'Show.S01E01.mkv',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const out = await tool_.execute!(
      { provider: 'assrt', providerId: '1', fileIndex: null },
      { toolCallId: 't1', messages: [] } as any,
    )
    expect(out.stagedFileId).toBeTruthy()
    expect(out.signals.cueCount).toBe(1)
    expect(out.signals.decodable).toBe(true)
  })

  it('two downloads in the same task do not collide (each gets its own staging subdir)', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nfirst\n')))
      .mockResolvedValueOnce(new Response(Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nsecond\n')))
    const stagedFiles = new Map<string, string>()
    const tool_ = makeDownloadCandidateTool({
      adapters: [fakeAdapter('http://file0.assrt.net/x.srt')],
      stagingDir: sandboxDir,
      stagedFiles,
      videoFilename: 'Show.S01E01.mkv',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const first = await tool_.execute!({ provider: 'assrt', providerId: '1', fileIndex: null }, { toolCallId: 't1', messages: [] } as any)
    const second = await tool_.execute!({ provider: 'assrt', providerId: '2', fileIndex: null }, { toolCallId: 't2', messages: [] } as any)
    expect(first.stagedFileId).not.toBe(second.stagedFileId)
    const firstPath = stagedFiles.get(first.stagedFileId)!
    const secondPath = stagedFiles.get(second.stagedFileId)!
    expect(firstPath).not.toBe(secondPath)
    expect(readFileSync(firstPath, 'utf8')).toContain('first')
    expect(readFileSync(secondPath, 'utf8')).toContain('second')
    expect(existsSync(firstPath)).toBe(true)
    expect(existsSync(secondPath)).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agent/findSubtitleWorker.tools.test.ts`
Expected: FAIL — `Cannot find module './findSubtitleWorker.tools.js'`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/agent/findSubtitleWorker.tools.ts
import { tool } from 'ai'
import { z } from 'zod'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { runResolve, type FetchAdapter } from '../cli/fetchLib.js'
import { downloadDirect } from '../adapters/download/direct.js'
import { writeSubtitle } from '../files/subtitleWriter.js'
import { inspectSubtitle } from '../files/subtitleInspect.js'
import { PROVIDERS } from '../core/schemas.js'

export interface DownloadCandidateDeps {
  adapters: FetchAdapter[]
  /** Sandbox staging root for this ONE task (allocated by the caller via
   *  stagingSandbox.allocate(jobId, mediaRoot) — see findSubtitleWorker.ts). Each call gets its
   *  own subdirectory keyed by a fresh stagedFileId so comparing multiple candidates never
   *  collides (see the correctness note above this task in the plan). */
  stagingDir: string
  /** Opaque handle → real staged path, shared with install_subtitle. Never exposed to the
   *  agent — install_subtitle takes stagedFileId, not a path. */
  stagedFiles: Map<string, string>
  videoFilename: string
  fetchImpl?: typeof fetch
}

export function makeDownloadCandidateTool(deps: DownloadCandidateDeps) {
  return tool({
    description:
      'Resolve a candidate to a download URL, download it, unpack/decode it into your ' +
      'sandbox, and inspect its structural signals (cue count, time span, detected script). ' +
      'Does NOT install it — call install_subtitle once you decide it is a match.',
    inputSchema: z.object({
      provider: z.enum(PROVIDERS),
      providerId: z.string(),
      fileIndex: z.number().int().nullable(),
    }),
    execute: async ({ provider, providerId, fileIndex }) => {
      const { url, filename, headers } = await runResolve({ provider, providerId, fileIndex }, deps.adapters)
      const { bytes, contentType } = await downloadDirect(url, { headers, fetchImpl: deps.fetchImpl })
      const artifactFilename = filename ?? (contentType?.includes('zip') ? 'download.zip' : 'download.srt')
      const stagedFileId = randomUUID()
      const attemptDir = join(deps.stagingDir, stagedFileId)
      const written = await writeSubtitle({
        artifact: bytes, artifactFilename, videoFilename: deps.videoFilename,
        langTag: 'zh-Hans', outDir: attemptDir,
      })
      const signals = inspectSubtitle(written.path)
      deps.stagedFiles.set(stagedFileId, written.path)
      return { stagedFileId, bytes: written.bytes, encoding: written.encoding, signals }
    },
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/agent/findSubtitleWorker.tools.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Typecheck**

Run: `npm run check`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add src/agent/findSubtitleWorker.tools.ts src/agent/findSubtitleWorker.tools.test.ts
git commit -m "$(cat <<'EOF'
feat(agent): add download_candidate tool (v3 phase ③)

Wraps runResolve/downloadDirect/writeSubtitle/inspectSubtitle unchanged;
each attempt gets its own staging subdir so comparing multiple candidates
in one task never collides on writeSubtitle's fixed output filename.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

### Task 3: `install_subtitle` tool (atomic install, sandboxed)

**Files:**
- Modify: `src/agent/findSubtitleWorker.tools.ts`
- Modify: `src/agent/findSubtitleWorker.tools.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// append to src/agent/findSubtitleWorker.tools.test.ts
import { mkdirSync, writeFileSync } from 'node:fs'
import { makeInstallSubtitleTool } from './findSubtitleWorker.tools.js'

describe('install_subtitle tool', () => {
  it('installs a staged file to the video directory with the given lang tag', async () => {
    const videoDir = join(sandboxDir, 'media', 'Show')
    mkdirSync(videoDir, { recursive: true })
    const stagedPath = join(sandboxDir, '.staging', 'attempt1', 'staged.srt')
    mkdirSync(join(sandboxDir, '.staging', 'attempt1'), { recursive: true })
    writeFileSync(stagedPath, 'hello')
    const stagedFileId = 'handle-1'
    const stagedFiles = new Map([[stagedFileId, stagedPath]])

    const tool_ = makeInstallSubtitleTool({
      stagedFiles, outDir: videoDir, mediaRoot: join(sandboxDir, 'media'), videoFilename: 'Show.S01E01.mkv',
    })
    const out = await tool_.execute!({ stagedFileId, langTag: 'zh-Hans' }, { toolCallId: 't1', messages: [] } as any)
    expect(out.path).toBe(join(videoDir, 'Show.S01E01.zh-Hans.srt'))
    expect(existsSync(out.path)).toBe(true)
  })

  it('rejects an unknown stagedFileId', async () => {
    const tool_ = makeInstallSubtitleTool({
      stagedFiles: new Map(), outDir: sandboxDir, mediaRoot: sandboxDir, videoFilename: 'Show.S01E01.mkv',
    })
    const out = await tool_.execute!({ stagedFileId: 'nope', langTag: 'zh-Hans' }, { toolCallId: 't1', messages: [] } as any)
    expect(out).toEqual({ error: 'unknown stagedFileId: nope — call download_candidate first' })
  })

  it('sandbox: refuses to install outside the configured mediaRoot even if outDir were miswired', async () => {
    const stagedPath = join(sandboxDir, 'staged.srt')
    writeFileSync(stagedPath, 'hello')
    const stagedFileId = 'handle-escape'
    const tool_ = makeInstallSubtitleTool({
      stagedFiles: new Map([[stagedFileId, stagedPath]]),
      outDir: join(sandboxDir, 'outside'), // deliberately NOT under mediaRoot below
      mediaRoot: join(sandboxDir, 'media'),
      videoFilename: 'Show.S01E01.mkv',
    })
    const out = await tool_.execute!({ stagedFileId, langTag: 'zh-Hans' }, { toolCallId: 't1', messages: [] } as any)
    expect(out).toHaveProperty('error')
    expect((out as { error: string }).error).toMatch(/refusing to install outside/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agent/findSubtitleWorker.tools.test.ts`
Expected: FAIL — `makeInstallSubtitleTool is not a function`

- [ ] **Step 3: Write minimal implementation**

```ts
// append to src/agent/findSubtitleWorker.tools.ts
import { basename, extname } from 'node:path'
import { install } from '../files/stagingSandbox.js'
import { isUnderRoots } from '../core/mediaContext.js'

export interface InstallSubtitleDeps {
  stagedFiles: Map<string, string>
  /** Fixed by the caller at task-construction time — dirname(task.videoPath). Never derived
   *  from anything the agent supplies. */
  outDir: string
  /** The ONE sandbox root for this task — checked again here even though outDir is already
   *  fixed (defense-in-depth, mirrors realignExecutor.ts's containingRoot/isUnderRoots use). */
  mediaRoot: string
  videoFilename: string
}

export function makeInstallSubtitleTool(deps: InstallSubtitleDeps) {
  return tool({
    description:
      'Atomically install a previously downloaded+inspected candidate (by stagedFileId) as ' +
      'the final subtitle for this task\'s video. Only call this once you have decided, like ' +
      'a person who opened the file, that this candidate really is the subtitle for this exact video.',
    inputSchema: z.object({
      stagedFileId: z.string(),
      langTag: z.enum(['zh-Hans', 'zh-Hant']),
    }),
    execute: async ({ stagedFileId, langTag }) => {
      const stagedPath = deps.stagedFiles.get(stagedFileId)
      if (!stagedPath) return { error: `unknown stagedFileId: ${stagedFileId} — call download_candidate first` }
      const videoBase = basename(deps.videoFilename).replace(/\.[^.]+$/, '')
      const ext = extname(stagedPath)
      const finalPath = join(deps.outDir, `${videoBase}.${langTag}${ext}`)
      if (!isUnderRoots(finalPath, [deps.mediaRoot])) {
        return { error: `refusing to install outside sandboxed media root: ${finalPath}` }
      }
      const result = await install(stagedPath, finalPath)
      return { path: result.path }
    },
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/agent/findSubtitleWorker.tools.test.ts`
Expected: PASS (5 tests total)

- [ ] **Step 5: Typecheck**

Run: `npm run check`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add src/agent/findSubtitleWorker.tools.ts src/agent/findSubtitleWorker.tools.test.ts
git commit -m "$(cat <<'EOF'
feat(agent): add install_subtitle tool with sandbox re-check (v3 phase ③)

Wraps stagingSandbox.install unchanged. Path is always computed from a
caller-fixed outDir + agent-chosen langTag only — no tool input accepts a
raw filesystem path — plus an isUnderRoots defense-in-depth re-check.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

### Task 4: `check_episode_code_safety` tool (optional advisory, downgraded from `runGate`)

The spec calls for downgrading `core/gate.ts`'s `runGate` from a mandatory pipeline gate into "a tool the subagent can optionally call to check whether the file index/episode code it picked is safe." Reading `runGate`'s actual signature (`runGate(rank: RankDecision, candidates: SubtitleCandidate[], identity: MediaIdentity)`) shows it is tightly coupled to the legacy single-shot `RankDecision` shape (an `order`/`rejected` array the old rank-then-gate pipeline produces) — the new agent never produces a `RankDecision`, so calling `runGate` itself would require constructing an awkward one-item fake `RankDecision` purely to satisfy its signature. Instead, this task extracts the same underlying idea `runGate` uses for its episode-code backstop (`matchesEpisodeCode`/`formatEpisodeCode`, both pure exports of `src/core/episode.ts`, confirmed unchanged) into a new, smaller pure helper the agent can call directly with just the fields it has in hand. **This is a deliberate deviation from the spec's literal wording** ("runGate...降级为...工具") — the underlying safety check is reused, the legacy function signature is not force-fit.

**Files:**
- Modify: `src/agent/findSubtitleWorker.tools.ts`
- Modify: `src/agent/findSubtitleWorker.tools.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// append to src/agent/findSubtitleWorker.tools.test.ts
import { makeCheckEpisodeCodeSafetyTool } from './findSubtitleWorker.tools.js'

describe('check_episode_code_safety tool', () => {
  it('reports safe:true when the filename matches the target episode code', async () => {
    const tool_ = makeCheckEpisodeCodeSafetyTool()
    const out = await tool_.execute!(
      { filename: 'Show.S01E05.1080p.srt', season: 1, episode: 5 },
      { toolCallId: 't1', messages: [] } as any,
    )
    expect(out).toEqual({ safe: true, expectedCode: 'S01E05' })
  })

  it('reports safe:false when the filename names a different episode', async () => {
    const tool_ = makeCheckEpisodeCodeSafetyTool()
    const out = await tool_.execute!(
      { filename: 'Show.S01E06.1080p.srt', season: 1, episode: 5 },
      { toolCallId: 't1', messages: [] } as any,
    )
    expect(out).toEqual({ safe: false, expectedCode: 'S01E05' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agent/findSubtitleWorker.tools.test.ts`
Expected: FAIL — `makeCheckEpisodeCodeSafetyTool is not a function`

- [ ] **Step 3: Write minimal implementation**

```ts
// append to src/agent/findSubtitleWorker.tools.ts
import { formatEpisodeCode, matchesEpisodeCode } from '../core/episode.js'

/** Optional advisory check — NOT a mandatory gate (north star #2: deterministic checks never
 *  get to be the "is this subtitle right" gatekeeper; they only do factual bookkeeping). The
 *  agent may call this to sanity-check a filename against the season/episode it believes it is
 *  looking for; it is one more piece of evidence, not a pass/fail door the agent must clear. */
export function makeCheckEpisodeCodeSafetyTool() {
  return tool({
    description:
      'Advisory check: does a filename\'s episode code match the given season/episode? This ' +
      'is one signal among several, not a verdict — a false result does not mean reject, a ' +
      'true result does not mean accept.',
    inputSchema: z.object({
      filename: z.string(),
      season: z.number().int(),
      episode: z.number().int(),
    }),
    execute: async ({ filename, season, episode }) => {
      const expectedCode = formatEpisodeCode(season, episode)
      return { safe: matchesEpisodeCode(filename, expectedCode), expectedCode }
    },
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/agent/findSubtitleWorker.tools.test.ts`
Expected: PASS (7 tests total)

- [ ] **Step 5: Typecheck**

Run: `npm run check`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add src/agent/findSubtitleWorker.tools.ts src/agent/findSubtitleWorker.tools.test.ts
git commit -m "$(cat <<'EOF'
feat(agent): add optional check_episode_code_safety advisory tool (v3 phase ③)

Extracts runGate's episode-code backstop idea (matchesEpisodeCode/
formatEpisodeCode, core/episode.ts, unchanged) into a new pure helper the
agent may call — NOT a call into runGate itself, whose signature is
tightly coupled to the legacy RankDecision shape this agent never
produces. Downgraded from mandatory gate to optional advisory tool per
the north star (deterministic checks never gatekeep subtitle-correctness).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

### Task 5: `makeFindSubtitleWorker()` — assemble the full `ToolLoopAgent`

**Files:**
- Create: `src/agent/findSubtitleWorker.ts`
- Test: `src/agent/findSubtitleWorker.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/agent/findSubtitleWorker.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MockLanguageModelV4 } from 'ai/test'
import type { LanguageModelV4CallOptions, LanguageModelV4Prompt } from '@ai-sdk/provider'
import type { FetchAdapter } from '../cli/fetchLib.js'
import type { SubtitleCandidate } from '../core/schemas.js'
import { makeFindSubtitleWorker } from './findSubtitleWorker.js'
import type { FindSubtitleTask } from './findSubtitleWorker.schemas.js'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'scout-find-subtitle-e2e-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

function fakeCandidate(): SubtitleCandidate {
  return {
    provider: 'assrt', providerId: '1', videoName: 'Show.S01E01.1080p',
    nativeName: null, language: 'zh-CN', subtype: null, releaseSite: null, uploadDate: null,
    fileList: [{ index: 0, name: 'Show.S01E01.srt' }],
  }
}

function fakeAdapter(): FetchAdapter {
  return {
    name: 'assrt',
    enabled: () => true,
    search: async () => [fakeCandidate()],
    resolve: async () => ({ url: 'http://file0.assrt.net/x.srt', filename: 'Show.S01E01.srt' }),
  }
}

/** Reads a prior tool call's JSON result out of a scripted step's own prompt history — the
 *  only way a static-but-stateful mock model can react to a REAL runtime-generated value
 *  (like download_candidate's randomUUID() stagedFileId) it could not have known in advance. */
function findToolResultValue(prompt: LanguageModelV4Prompt, toolName: string): any {
  for (const msg of prompt) {
    if (msg.role !== 'tool') continue
    for (const part of msg.content) {
      if (part.type === 'tool-result' && part.toolName === toolName && part.output.type === 'json') {
        return part.output.value
      }
    }
  }
  throw new Error(`no tool-result for ${toolName} found in prompt history`)
}

function toolCallResult(toolCallId: string, toolName: string, input: unknown) {
  return {
    finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' },
    usage: {
      inputTokens: { total: 10, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 5, text: undefined, reasoning: undefined },
    },
    content: [{ type: 'tool-call' as const, toolCallId, toolName, input: JSON.stringify(input) }],
    warnings: [],
  }
}

function finalTextResult(output: unknown) {
  return {
    finishReason: { unified: 'stop' as const, raw: 'stop' },
    usage: {
      inputTokens: { total: 20, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 10, text: undefined, reasoning: undefined },
    },
    content: [{ type: 'text' as const, text: JSON.stringify(output) }],
    warnings: [],
  }
}

describe('makeFindSubtitleWorker (end-to-end, mock model)', () => {
  it('searches, downloads, compares, installs, and reports installed', async () => {
    const mediaRoot = join(root, 'media')
    const videoPath = join(mediaRoot, 'Show', 'Show.S01E01.mkv')
    mkdirSync(join(mediaRoot, 'Show'), { recursive: true })

    let call = 0
    const model = new MockLanguageModelV4({
      doGenerate: async (options: LanguageModelV4CallOptions) => {
        call++
        if (call === 1) {
          return toolCallResult('c1', 'search_source', { queries: ['Show'], languages: ['zh-Hans'] })
        }
        if (call === 2) {
          return toolCallResult('c2', 'download_candidate', { provider: 'assrt', providerId: '1', fileIndex: null })
        }
        if (call === 3) {
          const downloaded = findToolResultValue(options.prompt, 'download_candidate')
          return toolCallResult('c3', 'install_subtitle', { stagedFileId: downloaded.stagedFileId, langTag: 'zh-Hans' })
        }
        const installed = findToolResultValue(options.prompt, 'install_subtitle')
        return finalTextResult({
          decision: 'installed', reason: 'release name and cue count match S01E01',
          installedPath: installed.path, installedLanguage: 'zh-Hans',
          candidateProvider: 'assrt', candidateProviderId: '1',
        })
      },
    })

    const fetchImpl = async () => new Response(Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nhello\n'))

    const runTask = makeFindSubtitleWorker({
      model, adapters: [fakeAdapter()], cacheRoot: join(root, 'cache'),
      fetchImpl: fetchImpl as unknown as typeof fetch, stepCap: 10,
    })

    const task: FindSubtitleTask = {
      jobId: 'job-1', mediaRoot, videoPath, videoFilename: 'Show.S01E01.mkv',
      title: 'Show', originalTitle: null, year: 2024, season: 1, episode: 1,
      alternativeTitles: [], overview: null, runtimeMinutes: 24, providerIds: {},
    }

    const decision = await runTask(task)

    expect(decision.decision).toBe('installed')
    expect(decision.installedPath).toBe(join(mediaRoot, 'Show', 'Show.S01E01.zh-Hans.srt'))
    expect(existsSync(decision.installedPath!)).toBe(true)
    expect(readFileSync(decision.installedPath!, 'utf8')).toContain('hello')
    // sandbox cleanup: the staging dir under mediaRoot/.subtitle-staging/job-1 is gone after the run
    expect(existsSync(join(mediaRoot, '.subtitle-staging', 'job-1'))).toBe(false)
  })

  it('rejects a task whose videoPath escapes its own mediaRoot before ever calling the model', async () => {
    const mediaRoot = join(root, 'media')
    mkdirSync(mediaRoot, { recursive: true })
    const model = new MockLanguageModelV4({ doGenerate: async () => { throw new Error('model should never be called') } })
    const runTask = makeFindSubtitleWorker({ model, adapters: [], cacheRoot: join(root, 'cache') })
    const task: FindSubtitleTask = {
      jobId: 'job-2', mediaRoot, videoPath: join(root, 'elsewhere', 'Show.S01E01.mkv'),
      videoFilename: 'Show.S01E01.mkv', title: 'Show', originalTitle: null, year: null,
      season: 1, episode: 1, alternativeTitles: [], overview: null, runtimeMinutes: null, providerIds: {},
    }
    await expect(runTask(task)).rejects.toThrow(/escapes its own sandboxed mediaRoot/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agent/findSubtitleWorker.test.ts`
Expected: FAIL — `Cannot find module './findSubtitleWorker.js'`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/agent/findSubtitleWorker.ts
import { dirname, join } from 'node:path'
import { stepCountIs, type LanguageModel } from 'ai'
import { makeReasoningAgent } from './reasoningAgent.js'
import { FIND_SUBTITLE_SKILL } from './skills/findSubtitleSkill.js'
import { systemPromptSkillIndex, makeReadDocTool } from './skills/registry.js'
import {
  makeFileResultSetStore, makeSearchSourceTool, makeListCandidatesTool, makeGetCandidateTool,
} from './resultHandles.js'
import {
  makeDownloadCandidateTool, makeInstallSubtitleTool, makeCheckEpisodeCodeSafetyTool,
} from './findSubtitleWorker.tools.js'
import {
  FindSubtitleDecisionSchema, type FindSubtitleTask, type FindSubtitleDecision,
} from './findSubtitleWorker.schemas.js'
import { allocate, cleanup } from '../files/stagingSandbox.js'
import { isUnderRoots } from '../core/mediaContext.js'
import type { FetchAdapter } from '../cli/fetchLib.js'

export interface FindSubtitleWorkerDeps {
  model: LanguageModel
  adapters: FetchAdapter[]
  cacheRoot: string
  /** Test phase per spec: no production step cap yet — observe actual step counts first.
   *  @default 500 */
  stepCap?: number
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

const DEFAULT_TIMEOUT_MS = 300_000

/** Assembles one find-subtitle worker run. Every dependency (model, adapters, cacheRoot) is
 *  injected — this function has zero global state, so the caller (orchestrator in phase ⑤,
 *  the manual live-acceptance script in Task 7) can construct it identically in both offline
 *  tests and production. Returns a function that runs exactly one task end to end. */
export function makeFindSubtitleWorker(deps: FindSubtitleWorkerDeps) {
  return async function runFindSubtitleTask(task: FindSubtitleTask): Promise<FindSubtitleDecision> {
    const outDir = dirname(task.videoPath)
    // Sandbox layer 1 (code): verified BEFORE any tool exists or any model call happens — a
    // misconfigured task never even gets to try.
    if (!isUnderRoots(outDir, [task.mediaRoot])) {
      throw new Error(`task video path ${task.videoPath} escapes its own sandboxed mediaRoot ${task.mediaRoot}`)
    }

    const stagingDir = allocate(task.jobId, task.mediaRoot)
    const store = makeFileResultSetStore(join(deps.cacheRoot, 'result-sets', task.jobId))
    const stagedFiles = new Map<string, string>()

    const tools = {
      read_doc: makeReadDocTool([FIND_SUBTITLE_SKILL]),
      search_source: makeSearchSourceTool({ adapters: deps.adapters, store }),
      list_candidates: makeListCandidatesTool(store),
      get_candidate: makeGetCandidateTool(store),
      download_candidate: makeDownloadCandidateTool({
        adapters: deps.adapters, stagingDir, stagedFiles,
        videoFilename: task.videoFilename, fetchImpl: deps.fetchImpl,
      }),
      install_subtitle: makeInstallSubtitleTool({
        stagedFiles, outDir, mediaRoot: task.mediaRoot, videoFilename: task.videoFilename,
      }),
      check_episode_code_safety: makeCheckEpisodeCodeSafetyTool(),
    }

    // Sandbox layer 2 (prompt/skill): this instructions string is the ENTIRE system prompt —
    // no other directory name is ever mentioned anywhere in it.
    const instructions = [
      'You are the find-subtitle worker for exactly ONE media item. You have no knowledge of',
      'any other directory or media item in existence — do not ask about or reference one.',
      '',
      'Available skill documents (call read_doc(name) to load the full text of one):',
      systemPromptSkillIndex([FIND_SUBTITLE_SKILL]),
    ].join('\n')

    const prompt = [
      'Find and install a Chinese subtitle for this media item, or report why you could not.',
      '',
      `title: ${task.title}`,
      `original title: ${task.originalTitle ?? 'unknown'}`,
      `year: ${task.year ?? 'unknown'}`,
      `season/episode: S${task.season ?? '-'} E${task.episode ?? '-'}`,
      `filename: ${task.videoFilename}`,
      `alternative/native titles: ${task.alternativeTitles.length ? task.alternativeTitles.join(', ') : 'none'}`,
      `overview: ${task.overview ?? 'none'}`,
      `runtime minutes: ${task.runtimeMinutes ?? 'unknown'}`,
      `provider ids: ${JSON.stringify(task.providerIds)}`,
    ].join('\n')

    const agent = makeReasoningAgent({
      model: deps.model,
      tools,
      instructions,
      schema: FindSubtitleDecisionSchema,
      stopWhen: stepCountIs(deps.stepCap ?? 500),
      reasoning: 'high',
      telemetry: { isEnabled: true },
    })

    try {
      const result = await agent.generate({
        prompt,
        abortSignal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      })
      return result.output
    } finally {
      // Try-error sandbox cleanup runs even on a thrown error — the staging dir never
      // survives a run, matching stagingSandbox's own "job ends, sandbox is deleted" contract.
      cleanup(task.jobId, task.mediaRoot)
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/agent/findSubtitleWorker.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Typecheck**

Run: `npm run check`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add src/agent/findSubtitleWorker.ts src/agent/findSubtitleWorker.test.ts
git commit -m "$(cat <<'EOF'
feat(agent): assemble makeFindSubtitleWorker (v3 phase ③ core deliverable)

ToolLoopAgent wiring read_doc + search_source/list_candidates/get_candidate
+ download_candidate + install_subtitle + check_episode_code_safety, with
reasoning:'high' and Output.object(FindSubtitleDecisionSchema). Sandboxed
to one media directory at both the code layer (no tool accepts a raw
path; isUnderRoots re-check) and the prompt layer (skill text only ever
mentions this one directory). End-to-end mock-model test proves the full
search→download→compare→install loop.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

### Task 6: Offline eval harness across all five task shapes

**What this harness proves, and what it deliberately does NOT prove:** it proves the worker's PLUMBING (every tool wired correctly, the sandbox holds, `Output.object` produces the right decision shape) behaves correctly across five differently-shaped tasks, using a fully deterministic scripted mock model. It does **not** evaluate a real reasoning model's actual judgment quality — that is what the manual live acceptance procedure (Task 7) is for. Conflating "the scaffolding works" with "the model judges correctly" would misrepresent what an offline, mock-model test can ever show.

**Files:**
- Create: `fixtures/v3-find-subtitle/new-release/fixture.json`
- Create: `fixtures/v3-find-subtitle/ongoing-series/fixture.json`
- Create: `fixtures/v3-find-subtitle/old-movie/fixture.json`
- Create: `fixtures/v3-find-subtitle/old-series/fixture.json`
- Create: `fixtures/v3-find-subtitle/messy-layout/fixture.json`
- Create: `src/agent/findSubtitleWorker.eval.test.ts`

- [ ] **Step 1: Write the fixtures (data, not code — no failing test yet, these are inputs)**

```json
// fixtures/v3-find-subtitle/new-release/fixture.json — 新片: brand-new episode, one clean match
{
  "name": "new-release",
  "jobId": "eval-new-release",
  "task": {
    "videoFilename": "Show.S01E01.mkv", "title": "Show", "originalTitle": null,
    "year": 2026, "season": 1, "episode": 1, "alternativeTitles": [], "overview": null,
    "runtimeMinutes": 24, "providerIds": {}
  },
  "candidates": [
    { "provider": "assrt", "providerId": "1", "videoName": "Show.S01E01.1080p.WEB-DL", "nativeName": null,
      "language": "zh-CN", "subtype": null, "releaseSite": null, "uploadDate": "2026-07-13",
      "fileList": [{ "index": 0, "name": "Show.S01E01.srt" }] }
  ],
  "chosenCandidate": { "provider": "assrt", "providerId": "1", "fileIndex": null },
  "downloadedSrt": "1\n00:00:01,000 --> 00:00:02,000\nhello\n\n2\n00:00:03,000 --> 00:00:05,000\nworld\n",
  "expected": { "decision": "installed", "installedFilename": "Show.S01E01.zh-Hans.srt" }
}
```

```json
// fixtures/v3-find-subtitle/ongoing-series/fixture.json — 在更剧: latest episode of a running series
{
  "name": "ongoing-series",
  "jobId": "eval-ongoing-series",
  "task": {
    "videoFilename": "Running.Show.S05E12.mkv", "title": "Running Show", "originalTitle": null,
    "year": 2021, "season": 5, "episode": 12, "alternativeTitles": ["长跑剧"], "overview": null,
    "runtimeMinutes": 45, "providerIds": { "tmdb": "9999" }
  },
  "candidates": [
    { "provider": "zimuku", "providerId": "z-501", "videoName": "Running.Show.S05E12.HDTV.x264-GROUP",
      "nativeName": "长跑剧", "language": null, "subtype": null, "releaseSite": "zimuku", "uploadDate": null,
      "fileList": [] }
  ],
  "chosenCandidate": { "provider": "zimuku", "providerId": "z-501", "fileIndex": null },
  "downloadedSrt": "1\n00:00:02,000 --> 00:00:04,500\n第十二集台词\n",
  "expected": { "decision": "installed", "installedFilename": "Running.Show.S05E12.zh-Hans.srt" }
}
```

```json
// fixtures/v3-find-subtitle/old-movie/fixture.json — 老片: an old movie, one real match buried among noise
{
  "name": "old-movie",
  "jobId": "eval-old-movie",
  "task": {
    "videoFilename": "Old.Classic.1987.mkv", "title": "Old Classic", "originalTitle": "Old Classic",
    "year": 1987, "season": null, "episode": null, "alternativeTitles": ["经典老片"], "overview": null,
    "runtimeMinutes": 118, "providerIds": { "imdb": "tt0000000" }
  },
  "candidates": [
    { "provider": "assrt", "providerId": "9001", "videoName": "Some.Unrelated.Movie.1999.srt", "nativeName": null,
      "language": "zh-CN", "subtype": null, "releaseSite": null, "uploadDate": null, "fileList": [] },
    { "provider": "opensubtitles", "providerId": "9002", "videoName": "Old.Classic.1987.BluRay.x264",
      "nativeName": "经典老片", "language": "zh-CN", "subtype": null, "releaseSite": null, "uploadDate": null,
      "fileList": [] }
  ],
  "chosenCandidate": { "provider": "opensubtitles", "providerId": "9002", "fileIndex": null },
  "downloadedSrt": "1\n00:00:05,000 --> 00:00:08,000\n经典台词\n",
  "expected": { "decision": "installed", "installedFilename": "Old.Classic.1987.zh-Hans.srt" }
}
```

```json
// fixtures/v3-find-subtitle/old-series/fixture.json — 老剧: obscure old series, nothing plausible turns up
{
  "name": "old-series",
  "jobId": "eval-old-series",
  "task": {
    "videoFilename": "Forgotten.Show.S02E03.mkv", "title": "Forgotten Show", "originalTitle": null,
    "year": 2003, "season": 2, "episode": 3, "alternativeTitles": [], "overview": null,
    "runtimeMinutes": 42, "providerIds": {}
  },
  "candidates": [
    { "provider": "assrt", "providerId": "1", "videoName": "Completely.Different.Show.S01E01.srt", "nativeName": null,
      "language": "zh-CN", "subtype": null, "releaseSite": null, "uploadDate": null, "fileList": [] }
  ],
  "chosenCandidate": null,
  "downloadedSrt": null,
  "expected": { "decision": "no_safe_match", "installedFilename": null }
}
```

```json
// fixtures/v3-find-subtitle/messy-layout/fixture.json — 乱排布 (间谍过家家-style absolute numbering):
// candidates exist but are named for the wrong season under absolute-numbering confusion —
// the safe behavior is to refuse, not to force an install onto a mismatched episode.
{
  "name": "messy-layout",
  "jobId": "eval-messy-layout",
  "task": {
    "videoFilename": "Spy.Family.S01E26.mkv", "title": "Spy x Family", "originalTitle": "SPY×FAMILY",
    "year": 2022, "season": 1, "episode": 26, "alternativeTitles": ["间谍过家家"], "overview": null,
    "runtimeMinutes": 24, "providerIds": { "tmdb": "120089" }
  },
  "candidates": [
    { "provider": "assrt", "providerId": "1", "videoName": "Spy.Family.S02E01.1080p", "nativeName": "间谍过家家",
      "language": "zh-CN", "subtype": null, "releaseSite": null, "uploadDate": null,
      "fileList": [{ "index": 0, "name": "Spy.Family.S02E01.srt" }] }
  ],
  "chosenCandidate": null,
  "downloadedSrt": null,
  "expected": { "decision": "no_safe_match", "installedFilename": null }
}
```

- [ ] **Step 2: Write the failing test**

```ts
// src/agent/findSubtitleWorker.eval.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync, mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MockLanguageModelV4 } from 'ai/test'
import type { LanguageModelV4CallOptions, LanguageModelV4Prompt } from '@ai-sdk/provider'
import type { FetchAdapter } from '../cli/fetchLib.js'
import type { SubtitleCandidate } from '../core/schemas.js'
import { makeFindSubtitleWorker } from './findSubtitleWorker.js'
import type { FindSubtitleTask } from './findSubtitleWorker.schemas.js'

interface EvalFixture {
  name: string
  jobId: string
  task: Omit<FindSubtitleTask, 'jobId' | 'mediaRoot' | 'videoPath'>
  candidates: SubtitleCandidate[]
  chosenCandidate: { provider: string; providerId: string; fileIndex: number | null } | null
  downloadedSrt: string | null
  expected: { decision: 'installed' | 'no_safe_match' | 'retry_later'; installedFilename: string | null }
}

function loadFixture(scenario: string): EvalFixture {
  return JSON.parse(readFileSync(`fixtures/v3-find-subtitle/${scenario}/fixture.json`, 'utf8'))
}

function findToolResultValue(prompt: LanguageModelV4Prompt, toolName: string): any {
  for (const msg of prompt) {
    if (msg.role !== 'tool') continue
    for (const part of msg.content as any[]) {
      if (part.type === 'tool-result' && part.toolName === toolName && part.output.type === 'json') {
        return part.output.value
      }
    }
  }
  return undefined
}

function toolCallStep(toolCallId: string, toolName: string, input: unknown) {
  return {
    finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' },
    usage: { inputTokens: { total: 10, noCache: undefined, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 5, text: undefined, reasoning: undefined } },
    content: [{ type: 'tool-call' as const, toolCallId, toolName, input: JSON.stringify(input) }],
    warnings: [],
  }
}
function finalStep(output: unknown) {
  return {
    finishReason: { unified: 'stop' as const, raw: 'stop' },
    usage: { inputTokens: { total: 20, noCache: undefined, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 10, text: undefined, reasoning: undefined } },
    content: [{ type: 'text' as const, text: JSON.stringify(output) }],
    warnings: [],
  }
}

/** Generic scripted driver: search → (download → install)? → final, parameterized entirely by
 *  fixture data. See the phase ③ Task 6 header note above — this proves plumbing, not judgment. */
function scriptFixture(fixture: EvalFixture) {
  let call = 0
  return async (options: LanguageModelV4CallOptions) => {
    call++
    if (call === 1) return toolCallStep('c1', 'search_source', { queries: [fixture.task.title] })
    if (fixture.chosenCandidate == null) {
      return finalStep({
        decision: fixture.expected.decision, reason: `no plausible candidate for ${fixture.name}`,
        installedPath: null, installedLanguage: null, candidateProvider: null, candidateProviderId: null,
      })
    }
    if (call === 2) return toolCallStep('c2', 'download_candidate', fixture.chosenCandidate)
    if (call === 3) {
      const downloaded = findToolResultValue(options.prompt, 'download_candidate')
      return toolCallStep('c3', 'install_subtitle', { stagedFileId: downloaded.stagedFileId, langTag: 'zh-Hans' })
    }
    const installed = findToolResultValue(options.prompt, 'install_subtitle')
    return finalStep({
      decision: 'installed', reason: `${fixture.name}: metadata + structural signals match`,
      installedPath: installed.path, installedLanguage: 'zh-Hans',
      candidateProvider: fixture.chosenCandidate!.provider, candidateProviderId: fixture.chosenCandidate!.providerId,
    })
  }
}

describe.each(['new-release', 'ongoing-series', 'old-movie', 'old-series', 'messy-layout'])(
  'find-subtitle worker offline eval: %s',
  (scenario) => {
    let root: string
    beforeEach(() => { root = mkdtempSync(join(tmpdir(), `scout-eval-${scenario}-`)) })
    afterEach(() => { rmSync(root, { recursive: true, force: true }) })

    it('matches the recorded expected decision', async () => {
      const fixture = loadFixture(scenario)
      const mediaRoot = join(root, 'media')
      const showDir = join(mediaRoot, 'Show')
      mkdirSync(showDir, { recursive: true })
      const videoPath = join(showDir, fixture.task.videoFilename)

      const adapter: FetchAdapter = {
        name: 'assrt', enabled: () => true,
        search: async () => fixture.candidates,
        resolve: async () => ({ url: 'http://file0.assrt.net/x.srt', filename: fixture.task.videoFilename.replace(/\.mkv$/, '.srt') }),
      }
      const fetchImpl = async () => new Response(Buffer.from(fixture.downloadedSrt ?? ''))

      const model = new MockLanguageModelV4({ doGenerate: scriptFixture(fixture) })
      const runTask = makeFindSubtitleWorker({
        model, adapters: [adapter], cacheRoot: join(root, 'cache'),
        fetchImpl: fetchImpl as unknown as typeof fetch, stepCap: 10,
      })

      const task: FindSubtitleTask = { ...fixture.task, jobId: fixture.jobId, mediaRoot, videoPath }
      const decision = await runTask(task)

      expect(decision.decision).toBe(fixture.expected.decision)
      if (fixture.expected.installedFilename) {
        expect(decision.installedPath).toBe(join(showDir, fixture.expected.installedFilename))
        expect(existsSync(decision.installedPath!)).toBe(true)
      } else {
        expect(decision.installedPath).toBeNull()
      }
    })
  },
)
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/agent/findSubtitleWorker.eval.test.ts`
Expected: FAIL — either `Cannot find module`-adjacent errors if a fixture path is mistyped, or (once fixtures load) an assertion failure if the generic driver's tool-call sequence doesn't yet line up with `makeFindSubtitleWorker`'s real tool names. Since `makeFindSubtitleWorker` and its tools already exist from Tasks 2/3/5, this test should actually PASS on the first run once the fixture JSON files are correctly placed — treat any failure as a real bug (fixture data typo, or a genuine plumbing gap) and fix it before moving on, per the RED-for-right-reason discipline.

- [ ] **Step 4: Fix whatever the failure actually says, then re-run**

Run: `npx vitest run src/agent/findSubtitleWorker.eval.test.ts`
Expected: PASS (5 tests, one per scenario)

- [ ] **Step 5: Typecheck**

Run: `npm run check`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add fixtures/v3-find-subtitle src/agent/findSubtitleWorker.eval.test.ts
git commit -m "$(cat <<'EOF'
test(agent): add offline eval harness across five find-subtitle task shapes (v3 phase ③)

新片/在更剧/老片/老剧/乱排布 fixtures, driven by a generic scripted mock
model — proves the worker's plumbing (tool wiring, sandbox, Output.object
schema) across shapes. Does NOT evaluate real model judgment quality —
that is the separate manual live acceptance procedure (next task).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

### Task 7: Live acceptance procedure (manual, real site, real LLM, real install)

Per the spec's hard door: "找字幕子代理必须在真站真的搜到→判断→下载→解压→装上真字幕，不止离线夹具绿" (continuing the zimuku lesson — offline-green has been wrong before). This is deliberately NOT part of `vitest run`.

**Files:**
- Create: `docs/design/2026-07-13-v3-live-acceptance-checklist.md`
- Create: `scripts/live-accept-find-subtitle.ts`

- [ ] **Step 1: Write the manual checklist**

```markdown
<!-- docs/design/2026-07-13-v3-live-acceptance-checklist.md -->
# v3 find-subtitle worker — live acceptance checklist

Run manually, NOT part of `npm test`/CI. Requires: a real `LLM_BASE_URL`/`LLM_API_KEY`/`LLM_MODEL`
(see `.env.example`), at least one real provider credential (`ASSRT_TOKEN` or
`OPENSUBTITLES_API_KEY` or `ZIMUKU_ENABLED=true`), and a real media directory containing at
least one video file genuinely missing a Chinese subtitle that is known to be findable.

1. [ ] Pick one real episode or movie file with NO existing Chinese subtitle, on a real subtitle
       site, that a human has manually confirmed is findable (search the site yourself first).
2. [ ] Run `npx tsx scripts/live-accept-find-subtitle.ts --video <path> --title <title> --year <year> [--season N --episode N]`.
3. [ ] Confirm the script's printed decision is `installed` (or a defensible `no_safe_match`/
       `retry_later` with a reason a human would find reasonable on inspection).
4. [ ] If `installed`: confirm a real `.srt`/`.ass` file now sits next to the video, open it,
       and manually confirm it is really the correct episode/movie's Chinese subtitle (not just
       "a file exists").
5. [ ] Confirm the media directory's `.subtitle-staging/<jobId>/` directory is gone after the
       run (cleanup on both success and failure paths).
6. [ ] Note in this file (as a dated log entry appended below) the step count the run took
       (`stepCount` printed by the script) — this is raw data for eventually setting a
       production `stepCountIs()` cap; the spec is explicit that no cap is set until enough
       real runs have been observed.
7. [ ] Re-run once against a video that should legitimately produce `no_safe_match` (nothing
       findable) and confirm no file gets installed and the reason is honest, not a hopeful guess.

## Run log

(append one dated entry per run: date, scenario, decision, step count, pass/fail)
```

- [ ] **Step 2: Write the guarded manual-run script**

```ts
// scripts/live-accept-find-subtitle.ts
// Manual live-acceptance runner — NOT wired into `npm test`. Requires real env vars (LLM_*,
// provider credentials) and a real filesystem path; refuses to run under `vitest`/CI.
import { parseArgs } from 'node:util'
import { dirname, basename } from 'node:path'
import 'dotenv/config'
import { makeModel } from '../src/agent/llm.js'
import { makeFindSubtitleWorker } from '../src/agent/findSubtitleWorker.js'
import type { FindSubtitleTask } from '../src/agent/findSubtitleWorker.schemas.js'
import { makeAssrtAdapter } from '../src/cli/adapters/assrtAdapter.js'
import { makeOpenSubtitlesAdapter } from '../src/cli/adapters/opensubtitlesAdapter.js'
import { makeZimukuAdapter } from '../src/cli/adapters/zimukuAdapter.js'
import { AssrtClient } from '../src/adapters/providers/assrt.js'
import { OpenSubtitlesClient } from '../src/adapters/providers/opensubtitles.js'
import { ZimukuClient } from '../src/adapters/providers/zimuku.js'

if (process.env.VITEST) {
  throw new Error('live-accept-find-subtitle.ts must not run under vitest — it hits real network and a real LLM')
}

const { values } = parseArgs({
  options: {
    video: { type: 'string' }, title: { type: 'string' }, year: { type: 'string' },
    season: { type: 'string' }, episode: { type: 'string' }, root: { type: 'string' },
  },
})
if (!values.video || !values.title) {
  console.error('usage: tsx scripts/live-accept-find-subtitle.ts --video <path> --title <title> [--year N --season N --episode N --root <mediaRoot>]')
  process.exit(1)
}

async function main() {
  const model = makeModel({
    baseUrl: process.env.LLM_BASE_URL!, apiKey: process.env.LLM_API_KEY!, model: process.env.LLM_MODEL!,
  })
  const adapters = [
    ...(process.env.ASSRT_TOKEN ? [makeAssrtAdapter(new AssrtClient({ token: process.env.ASSRT_TOKEN, cacheDir: '.cache/live-accept/assrt' }))] : []),
    ...(process.env.OPENSUBTITLES_API_KEY ? [makeOpenSubtitlesAdapter(new OpenSubtitlesClient({ apiKey: process.env.OPENSUBTITLES_API_KEY }))] : []),
    ...(process.env.ZIMUKU_ENABLED === 'true' ? [makeZimukuAdapter(new ZimukuClient())] : []),
  ]
  if (adapters.length === 0) throw new Error('no provider credentials configured — set ASSRT_TOKEN/OPENSUBTITLES_API_KEY/ZIMUKU_ENABLED')

  const mediaRoot = values.root ?? dirname(values.video!)
  const runTask = makeFindSubtitleWorker({ model, adapters, cacheRoot: '.cache/live-accept', stepCap: 500 })

  const task: FindSubtitleTask = {
    jobId: `live-accept-${Date.now()}`, mediaRoot, videoPath: values.video!, videoFilename: basename(values.video!),
    title: values.title!, originalTitle: null, year: values.year ? Number(values.year) : null,
    season: values.season ? Number(values.season) : null, episode: values.episode ? Number(values.episode) : null,
    alternativeTitles: [], overview: null, runtimeMinutes: null, providerIds: {},
  }

  const decision = await runTask(task)
  console.log(JSON.stringify(decision, null, 2))
}

main().catch(e => { console.error(e); process.exit(1) })
```

- [ ] **Step 3: Typecheck**

Run: `npm run check`
Expected: no errors. (This script is under `scripts/`, outside `tsconfig.json`'s `include: ["src"]` — if `tsc --noEmit` does not pick it up, run `npx tsc --noEmit scripts/live-accept-find-subtitle.ts --module nodenext --moduleResolution nodenext --target es2022 --strict --skipLibCheck` directly to typecheck it standalone, since it is intentionally outside the vitest/tsc-checked `src/` tree like the rest of `scripts/`.)

- [ ] **Step 4: Commit**

```bash
git add docs/design/2026-07-13-v3-live-acceptance-checklist.md scripts/live-accept-find-subtitle.ts
git commit -m "$(cat <<'EOF'
docs(agent): add manual live-acceptance checklist + runner for find-subtitle worker (v3 phase ③)

Deliberately not part of vitest run / CI — real site, real LLM, real
install, per the spec's live-acceptance hard door (continuing the
zimuku lesson: offline-green has been wrong before).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 5: Actually run the live acceptance procedure and fill in the run log before treating phase ③ as done**

This step has no automatable "run test, expect pass" — it is the gate itself. Phase ③ is not complete, and phase ⑧'s retirement is not unblocked, until a human has walked through the checklist in Step 1 and confirmed a real installed subtitle, or a defensible real `no_safe_match`.

---

## Phase ④ — DB v8 migration: `worker_task` kind + `payload` + `parent_job_id`

**Design decisions verified against the real `src/v2/db.ts`/`jobsRepo.ts` (not assumed):**
- The jobs table is currently schema v7 (`MIGRATIONS` array has 7 entries; `kind IN ('series_season','movie','realign')`). This plan's migration is `MIGRATIONS[7]` (the 8th entry → schema_version 8, hence "v8"), following the exact 12-step SQLite rebuild recipe already used by v5 (`needs_review`) and v7 (`realign` kind): `CREATE jobs_new` (expanded CHECK + new columns) → `INSERT INTO jobs_new SELECT ... FROM jobs` (explicit column list) → `DROP TABLE jobs` → `ALTER TABLE jobs_new RENAME TO jobs` → rebuild `jobs_identity`/`jobs_claim` indexes (dropped along with the table, as the v7 migration's own comment warns).
- **`worker_task` rows reuse the EXISTING `series_id`/`season`/`movie_id` identity columns for dedup — no new identity scheme, no partial unique index.** This was a real design fork: the spec's "结构性约束…同一迁移里加 payload…+parent_job_id" could be read as implying `worker_task` rows need a parallel identity mechanism (since a truly generic dispatched task has no natural series/season/movie shape). But `jobs_identity`'s existing unique index is `(kind, ifnull(series_id,''), ifnull(season,-1), ifnull(movie_id,''))` — since `kind` is part of the tuple, a `worker_task` row for series X season Y never collides with the EXISTING `series_season` row for the same X/Y (different `kind`), and reusing the same three columns for `worker_task`'s own target identity gets "one live worker_task per target, idempotent re-dispatch via the same done→wanted ON CONFLICT upsert pattern `upsertWanted` already uses" **for free**, with zero new SQL concepts. A tree-shaped orchestrator-shard task (phase ⑤'s 100-cap spillover, no natural series/season shape) gets a synthetic `series_id` like `orchestrator-shard-<parentJobId>-<n>` with `season`/`movie_id` NULL — it still fits the existing three-column scheme without inventing a fourth. `payload` carries the actual task instructions (`taskType` discriminator + whatever fields that task type needs); `parent_job_id` carries dispatch lineage (which orchestrator job created this row) for the tree/spillover bookkeeping.
- `parent_job_id INTEGER REFERENCES jobs(id)` is self-referential on the same table being rebuilt. This works via the identical mechanism the v7 migration already relies on for `runs.job_id REFERENCES jobs(id)` surviving a `DROP TABLE jobs` + `RENAME jobs_new TO jobs`: SQLite foreign keys are resolved by table NAME at check time, not bound to a specific schema object at declaration time, and `foreign_keys` is OFF for the whole migration window (`db.ts`'s `openDb()` already wraps the entire `MIGRATIONS` loop in one `PRAGMA foreign_keys = OFF` → migrate → `PRAGMA foreign_keys = ON`, confirmed by reading the file directly) — no additional pragma handling needed for this migration beyond what already exists.

### Task 1: v8 migration + round-trip test

**Files:**
- Modify: `src/v2/db.ts`
- Create: `src/v2/migration.worker-task-kind.test.ts` (mirrors `src/v2/migration.realign-job-kind.test.ts`)

- [ ] **Step 1: Write the failing test**

```ts
// src/v2/migration.worker-task-kind.test.ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { openDb, MIGRATIONS } from './db.js'

/** 造一个停在 v7 的存量库并回填 schema_version（镜像 migration.realign-job-kind.test.ts 的
 *  mkV6Db，v8 迁移的前置版本是 v7）。 */
function mkV7Db(): { dbPath: string; raw: Database.Database } {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'scout-mig-worker-task-')), 'scout.db')
  const raw = new Database(dbPath)
  for (let i = 0; i < 7; i++) raw.exec(MIGRATIONS[i])
  raw.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '7')").run()
  return { dbPath, raw }
}

describe('migration: worker_task job kind + payload + parent_job_id（jobs 表重建）', () => {
  it('全新库：jobs 能写入 kind=worker_task + payload + parent_job_id', () => {
    const db = openDb(':memory:')
    const now = Date.now()
    db.prepare(`INSERT INTO series (id, name) VALUES ('s1', 'Series A')`).run()
    db.prepare(
      `INSERT INTO jobs (kind, series_id, season, payload, parent_job_id, state, priority, attempt, created_at, updated_at)
       VALUES ('worker_task', 's1', 1, ?, NULL, 'wanted', 0, 0, ?, ?)`
    ).run(JSON.stringify({ taskType: 'find_subtitle' }), now, now)
    const row = db.prepare(`SELECT * FROM jobs WHERE kind='worker_task'`).get() as any
    expect(row.series_id).toBe('s1')
    expect(row.season).toBe(1)
    expect(JSON.parse(row.payload)).toEqual({ taskType: 'find_subtitle' })
    expect(row.parent_job_id).toBeNull()
    db.close()
  })

  it('parent_job_id 可指向另一个 job（自引用外键在 foreign_keys=ON 后仍校验）', () => {
    const db = openDb(':memory:')
    const now = Date.now()
    db.prepare(`INSERT INTO series (id, name) VALUES ('s1', 'Series A')`).run()
    const orchestratorId = db.prepare(
      `INSERT INTO jobs (kind, series_id, payload, state, priority, attempt, created_at, updated_at)
       VALUES ('worker_task', 'orchestrator-shard-0', ?, 'wanted', 0, 0, ?, ?)`
    ).run(JSON.stringify({ taskType: 'orchestrate' }), now, now).lastInsertRowid as number
    db.prepare(
      `INSERT INTO jobs (kind, series_id, season, payload, parent_job_id, state, priority, attempt, created_at, updated_at)
       VALUES ('worker_task', 's1', 1, ?, ?, 'wanted', 0, 0, ?, ?)`
    ).run(JSON.stringify({ taskType: 'find_subtitle' }), orchestratorId, now, now)
    const row = db.prepare(`SELECT * FROM jobs WHERE parent_job_id IS NOT NULL`).get() as any
    expect(row.parent_job_id).toBe(orchestratorId)

    expect(() =>
      db.prepare(
        `INSERT INTO jobs (kind, series_id, payload, parent_job_id, state, priority, attempt, created_at, updated_at)
         VALUES ('worker_task', 's2', ?, 999999, 'wanted', 0, 0, ?, ?)`
      ).run(JSON.stringify({ taskType: 'find_subtitle' }), now, now),
    ).toThrow(/FOREIGN KEY constraint failed/)
    db.close()
  })

  it('worker_task 与 series_season 同剧同季不冲突（kind 是 jobs_identity 元组的一部分）', () => {
    const db = openDb(':memory:')
    const now = Date.now()
    db.prepare(`INSERT INTO series (id, name) VALUES ('s1', 'Series A')`).run()
    db.prepare(
      `INSERT INTO jobs (kind, series_id, season, state, priority, attempt, created_at, updated_at)
       VALUES ('series_season', 's1', 1, 'wanted', 0, 0, ?, ?)`
    ).run(now, now)
    expect(() =>
      db.prepare(
        `INSERT INTO jobs (kind, series_id, season, payload, state, priority, attempt, created_at, updated_at)
         VALUES ('worker_task', 's1', 1, ?, 'wanted', 0, 0, ?, ?)`
      ).run(JSON.stringify({ taskType: 'find_subtitle' }), now, now),
    ).not.toThrow()
    const count = db.prepare(`SELECT COUNT(*) as c FROM jobs WHERE series_id='s1' AND season=1`).get() as { c: number }
    expect(count.c).toBe(2) // one series_season row, one worker_task row — kind distinguishes them
    db.close()
  })

  it('旧枚举值仍被 CHECK 约束拒绝非法 kind', () => {
    const db = openDb(':memory:')
    expect(() =>
      db.prepare(
        `INSERT INTO jobs (kind, state, priority, attempt, created_at, updated_at)
         VALUES ('bogus_kind', 'wanted', 0, 0, ?, ?)`
      ).run(Date.now(), Date.now()),
    ).toThrow(/CHECK constraint failed/)
    db.close()
  })

  it('存量库（v7）：已有 jobs/runs 行无损迁移，runs.job_id 外键关系保持完整', () => {
    const { dbPath, raw } = mkV7Db()
    const now = Date.now()
    raw.prepare(`INSERT INTO series (id, name) VALUES ('s1', 'Series A')`).run()
    raw.prepare(
      `INSERT INTO jobs (id, kind, series_id, season, state, priority, attempt, error_attempt, created_at, updated_at)
       VALUES (1, 'series_season', 's1', 1, 'failed', 0, 2, 0, ?, ?)`
    ).run(now, now)
    raw.prepare(
      `INSERT INTO runs (job_id, started_at, finished_at, decision, detail)
       VALUES (1, ?, ?, 'no_safe_match', '没找到合适的中文字幕')`
    ).run(now, now)
    raw.close()

    const db = openDb(dbPath) // currentVersion=7 < 8 → 只跑 v8
    const job = db.prepare(`SELECT * FROM jobs WHERE id=1`).get() as any
    expect(job.kind).toBe('series_season')
    expect(job.payload).toBeNull() // 新列，存量行回填 NULL
    expect(job.parent_job_id).toBeNull() // 新列，存量行回填 NULL
    expect(job.plan_ref).toBeNull() // v7 既有列，安然无损

    const run = db.prepare(`SELECT * FROM runs WHERE job_id=1`).get() as any
    expect(run.decision).toBe('no_safe_match')

    expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()).toEqual({
      value: String(MIGRATIONS.length),
    })
    db.close()
  })

  it('v7→v8 round-trip：18 列全量互异非 NULL 值逐列无损，payload/parent_job_id 回填 NULL', () => {
    const { dbPath, raw } = mkV7Db()
    raw.prepare(
      `INSERT INTO jobs (id, kind, series_id, season, movie_id, plan_ref, state, priority, target_episodes,
                         attempt, error_attempt, next_retry_at, lease_until, last_error, journal_ref,
                         created_at, updated_at)
       VALUES (7, 'series_season', 's-roundtrip', 3, 'm-ghost', '/archive/manifest.jsonl', 'failed', 42, '[4,5,6]',
               2, 5, 1111, 2222, 'boom: EXDEV', 'jr-e9-1700000000000',
               3333, 4444)`
    ).run()
    raw.close()

    const db = openDb(dbPath)
    const job = db.prepare(`SELECT * FROM jobs WHERE id=7`).get()
    expect(job).toEqual({
      id: 7, kind: 'series_season', series_id: 's-roundtrip', season: 3, movie_id: 'm-ghost',
      plan_ref: '/archive/manifest.jsonl',
      payload: null, parent_job_id: null, // v8 新列：存量行回填 NULL
      state: 'failed', priority: 42, target_episodes: '[4,5,6]',
      attempt: 2, error_attempt: 5, next_retry_at: 1111, lease_until: 2222,
      last_error: 'boom: EXDEV', journal_ref: 'jr-e9-1700000000000',
      created_at: 3333, updated_at: 4444,
    })
    db.close()
  })

  it('迁移失败（目标临时表被占坑）→ 抛错且关闭 db 句柄（-wal 随关闭清理）', () => {
    const { dbPath, raw } = mkV7Db()
    raw.exec('CREATE TABLE jobs_new (x INTEGER)') // 占坑：v8 的 CREATE TABLE jobs_new 必然失败
    raw.close()
    expect(() => openDb(dbPath)).toThrow(/jobs_new/)
    expect(existsSync(dbPath + '-wal')).toBe(false)
    const check = new Database(dbPath)
    expect(check.prepare("SELECT value FROM meta WHERE key='schema_version'").get()).toEqual({ value: '7' })
    check.close()
  })

  it('jobs_claim 索引重建后 claimNext 排序仍可用（priority DESC, created_at）', () => {
    const db = openDb(':memory:')
    const now = Date.now()
    db.prepare(`INSERT INTO series (id, name) VALUES ('s1', 'Series A')`).run()
    db.prepare(
      `INSERT INTO jobs (kind, series_id, season, state, priority, attempt, created_at, updated_at)
       VALUES ('series_season', 's1', 1, 'wanted', 0, 0, ?, ?)`
    ).run(now, now)
    const row = db.prepare(
      `SELECT id FROM jobs WHERE state IN ('wanted','failed') ORDER BY priority DESC, created_at ASC LIMIT 1`
    ).get() as { id: number }
    expect(row).toBeDefined()
    db.close()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/v2/migration.worker-task-kind.test.ts`
Expected: FAIL — every test that inserts `kind='worker_task'` or references `payload`/`parent_job_id` fails with `NOT NULL constraint failed` / `table jobs has no column named payload` / `CHECK constraint failed` (since `'worker_task'` is not yet in the CHECK enum).

- [ ] **Step 3: Write minimal implementation**

```ts
// append to the MIGRATIONS array in src/v2/db.ts, immediately after the v7 (realign) entry
  // v8: worker_task job kind + payload + parent_job_id——v3 主代理派活的通用载荷列。SQLite 不支持
  // ALTER 已有 CHECK 约束，同 v5/v7 手法：建新表(扩容 CHECK + 新列)→显式列拷数据→删旧表→改名→
  // 重建 jobs_identity/jobs_claim 索引(v7 注释已明文警告过：DROP TABLE 会连带丢掉它们，必须显式重建)。
  // worker_task 复用既有 series_id/season/movie_id 三列做身份 dedup(不是新identity 方案)：
  // jobs_identity 是 (kind, series_id, season, movie_id) 四元组，kind 本身在元组里，worker_task
  // 与同 series_id/season 的 series_season 行天然不冲突，天然获得"崩溃重启不重复派"的幂等 upsert
  // (与 upsertWanted 完全同一套 ON CONFLICT DO UPDATE 语义)——无需为 worker_task 发明第二套身份/
  // 局部唯一索引。没有自然季/剧归属的通用任务(如 100 溢出的 sibling orchestrator 分片)用合成
  // series_id(如 'orchestrator-shard-<parentJobId>-<n>')+season/movie_id 恒 NULL，同样落在这
  // 三列方案里。parent_job_id 自引用 jobs(id)：与 v7 迁移让 runs.job_id REFERENCES jobs(id) 安然
  // 穿越 DROP+RENAME 是同一机制(SQLite 外键按表名而非 schema 对象身份解析，foreign_keys=OFF 覆盖
  // 整个迁移窗口——db.ts openDb() 顶部已有说明，本迁移不需要额外处理)。
  `
CREATE TABLE jobs_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK(kind IN ('series_season','movie','realign','worker_task')),
  series_id TEXT, season INTEGER,
  movie_id TEXT,
  plan_ref TEXT,
  payload TEXT,
  parent_job_id INTEGER REFERENCES jobs(id),
  state TEXT NOT NULL CHECK(state IN
    ('wanted','searching','downloading','verifying','done','failed','dormant')),
  priority INTEGER NOT NULL DEFAULT 0,
  target_episodes TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  error_attempt INTEGER NOT NULL DEFAULT 0,
  next_retry_at INTEGER,
  lease_until INTEGER,
  last_error TEXT, journal_ref TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
INSERT INTO jobs_new
  (id, kind, series_id, season, movie_id, plan_ref, state, priority, target_episodes,
   attempt, error_attempt, next_retry_at, lease_until, last_error, journal_ref,
   created_at, updated_at)
  SELECT id, kind, series_id, season, movie_id, plan_ref, state, priority, target_episodes,
         attempt, error_attempt, next_retry_at, lease_until, last_error, journal_ref,
         created_at, updated_at
  FROM jobs;
DROP TABLE jobs;
ALTER TABLE jobs_new RENAME TO jobs;
CREATE UNIQUE INDEX jobs_identity ON jobs(kind, ifnull(series_id,''), ifnull(season,-1), ifnull(movie_id,''));
CREATE INDEX jobs_claim ON jobs(state, priority DESC, created_at);
CREATE INDEX jobs_parent ON jobs(parent_job_id);
  `.trim(),
```

Add this as the 8th array element (immediately after the v7 string, before the closing `]`) in `src/v2/db.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/v2/migration.worker-task-kind.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Run the FULL existing v2 test suite — a jobs-table migration is exactly the kind of change that can silently break unrelated tests**

Run: `npx vitest run src/v2/`
Expected: PASS (all pre-existing `src/v2/*.test.ts` files, including `jobsRepo.test.ts`, `migration.realign-job-kind.test.ts`, `db.test.ts`, `realignExecutor.test.ts`, `scanner.test.ts`, `libraryRepo.test.ts`, `executor.test.ts`, `daemon.test.ts`, `aggregator.test.ts`, `recovery.test.ts`, and the other `migration.*.test.ts` files continue to pass unmodified)

- [ ] **Step 6: Typecheck**

Run: `npm run check`
Expected: no errors

- [ ] **Step 7: Commit**

```bash
git add src/v2/db.ts src/v2/migration.worker-task-kind.test.ts
git commit -m "$(cat <<'EOF'
feat(v2): add jobs table v8 migration — worker_task kind + payload + parent_job_id

Follows the v5/v7 SQLite table-rebuild recipe exactly (CHECK constraints
can't be ALTERed). worker_task rows reuse the existing series_id/season/
movie_id identity columns for dedup — kind is part of jobs_identity's
tuple, so no new identity scheme or partial index is needed; a synthetic
series_id covers tasks with no natural series/season shape (e.g. sibling-
orchestrator shards). parent_job_id is self-referential, riding the same
foreign_keys=OFF migration window that already lets runs.job_id survive
the v7 DROP+RENAME.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

### Task 2: `JobsRepo.upsertWorkerTask()` + type extensions

**Files:**
- Modify: `src/v2/jobsRepo.ts`
- Modify: `src/v2/jobsRepo.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// append to src/v2/jobsRepo.test.ts
describe('worker_task dispatch (v3 phase ④)', () => {
  it('upsertWorkerTask writes a new wanted row with payload and parent_job_id', () => {
    const now = Date.now()
    repo.upsertWorkerTask({ seriesId: 's1', season: 1, movieId: null }, { taskType: 'find_subtitle' }, null, now)
    const job = repo.find('s1', 1)
    // find() only looks at kind='series_season' — worker_task rows need a dedicated lookup;
    // go through claimNext to prove the row is really there and claimable.
    expect(job).toBeNull()
    const claimed = repo.claimNext(now)
    expect(claimed?.kind).toBe('worker_task')
    expect(claimed?.series_id).toBe('s1')
    expect(JSON.parse(claimed!.payload!)).toEqual({ taskType: 'find_subtitle' })
    expect(claimed?.parent_job_id).toBeNull()
  })

  it('upsertWorkerTask is idempotent for the same identity while active (no duplicate row)', () => {
    const now = Date.now()
    repo.upsertWorkerTask({ seriesId: 's1', season: 1, movieId: null }, { taskType: 'find_subtitle' }, null, now)
    repo.upsertWorkerTask({ seriesId: 's1', season: 1, movieId: null }, { taskType: 'find_subtitle', retry: true }, null, now)
    expect(repo.countByState('wanted')).toBe(1)
  })

  it('upsertWorkerTask does not collide with an existing series_season job for the same series/season', () => {
    const now = Date.now()
    repo.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now)
    repo.upsertWorkerTask({ seriesId: 's1', season: 1, movieId: null }, { taskType: 'find_subtitle' }, null, now)
    expect(repo.countByState('wanted')).toBe(2)
  })

  it('records parent_job_id lineage for sibling-orchestrator style dispatch', () => {
    const now = Date.now()
    repo.upsertWorkerTask({ seriesId: 'orchestrator-shard-0', season: null, movieId: null }, { taskType: 'orchestrate' }, null, now)
    const orchestratorJob = repo.claimNext(now)!
    repo.upsertWorkerTask({ seriesId: 's1', season: 1, movieId: null }, { taskType: 'find_subtitle' }, orchestratorJob.id, now)
    const dispatched = repo.get(orchestratorJob.id + 1)!
    expect(dispatched.parent_job_id).toBe(orchestratorJob.id)
  })

  it('done→wanted revival refreshes payload/parent_job_id (mirrors upsertWanted semantics)', () => {
    const now = Date.now()
    repo.upsertWorkerTask({ seriesId: 's1', season: 1, movieId: null }, { taskType: 'find_subtitle' }, null, now)
    const job = repo.claimNext(now)!
    repo.completeDone(job.id, now)
    repo.upsertWorkerTask({ seriesId: 's1', season: 1, movieId: null }, { taskType: 'find_subtitle', round: 2 }, null, now)
    const revived = repo.get(job.id)!
    expect(revived.state).toBe('wanted')
    expect(JSON.parse(revived.payload!)).toEqual({ taskType: 'find_subtitle', round: 2 })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/v2/jobsRepo.test.ts`
Expected: FAIL — `repo.upsertWorkerTask is not a function`

- [ ] **Step 3: Write minimal implementation**

```ts
// modify src/v2/jobsRepo.ts

// JobKind: add 'worker_task'
export type JobKind = 'series_season' | 'movie' | 'realign' | 'worker_task'

// Job: add payload/parent_job_id
export interface Job {
  id: number
  kind: JobKind
  series_id: string | null
  season: number | null
  movie_id: string | null
  plan_ref: string | null
  payload: string | null
  parent_job_id: number | null
  state: JobState
  priority: number
  target_episodes: string | null
  attempt: number
  error_attempt: number
  next_retry_at: number | null
  lease_until: number | null
  last_error: string | null
  journal_ref: string | null
  created_at: number
  updated_at: number
}

// new identity variant + union member
export interface WorkerTaskIdentity {
  seriesId: string | null
  season: number | null
  movieId: string | null
}
```

```ts
// add to the JobsRepo class in src/v2/jobsRepo.ts, near upsertWanted
  /** 主代理派活(v3 phase ④/⑤)：写一行 worker_task job。复用 series_id/season/movie_id 三列做
   *  身份 dedup——jobs_identity 的 (kind, series_id, season, movie_id) 四元组里 kind 本身已经
   *  区分 worker_task 与 series_season/movie/realign，同一 identity 重复派发是幂等 upsert
   *  （镜像 upsertWanted 的 done→wanted 复活语义：非 done 态只碰 updated_at，done 态整体刷新
   *  payload/parent_job_id 并复活）。没有自然季/剧归属的任务（如 sibling-orchestrator 分片）
   *  用合成 seriesId（如 'orchestrator-shard-<parentJobId>-<n>'），season/movieId 恒 null。 */
  upsertWorkerTask(
    ident: WorkerTaskIdentity, payload: Record<string, unknown>, parentJobId: number | null, now: number,
  ): void {
    const payloadJson = JSON.stringify(payload)
    this.db
      .prepare(
        `INSERT INTO jobs (kind, series_id, season, movie_id, payload, parent_job_id, state, priority, attempt, created_at, updated_at)
         VALUES ('worker_task', ?, ?, ?, ?, ?, 'wanted', 0, 0, ?, ?)
         ON CONFLICT(kind, ifnull(series_id,''), ifnull(season,-1), ifnull(movie_id,''))
         DO UPDATE SET
           updated_at = ?,
           payload = CASE WHEN state = 'done' THEN excluded.payload ELSE jobs.payload END,
           parent_job_id = CASE WHEN state = 'done' THEN excluded.parent_job_id ELSE jobs.parent_job_id END,
           state = CASE WHEN state = 'done' THEN 'wanted' ELSE state END,
           attempt = CASE WHEN state = 'done' THEN 0 ELSE attempt END,
           error_attempt = CASE WHEN state = 'done' THEN 0 ELSE error_attempt END,
           next_retry_at = CASE WHEN state = 'done' THEN NULL ELSE next_retry_at END`
      )
      .run(ident.seriesId, ident.season, ident.movieId, payloadJson, parentJobId, now, now, now)
  }
```

Note: `JobIdent`'s existing union (`JobIdentity | MovieJobIdentity | RealignJobIdentity`) is deliberately **not** extended with a `WorkerTaskIdentity` variant here — `upsertWanted`'s `if (ident.kind === 'series_season') {...} else if (ident.kind === 'movie') {...} else {/* assumed realign */}` control flow relies on exactly those three variants via TypeScript's exhaustive narrowing; adding a 4th `JobIdent` member without also rewriting that final `else` into an explicit `else if (ident.kind === 'realign')` + a new branch would silently miscompile a worker_task identity into the realign SQL branch. `upsertWorkerTask` is a separate method with its own `WorkerTaskIdentity` parameter type instead, which sidesteps this — a real bug avoided by writing out the existing `upsertWanted` implementation before deciding how to extend it.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/v2/jobsRepo.test.ts`
Expected: PASS (all existing jobsRepo tests + 5 new ones)

- [ ] **Step 5: Run the full v2 suite again**

Run: `npx vitest run src/v2/`
Expected: PASS

- [ ] **Step 6: Typecheck**

Run: `npm run check`
Expected: no errors

- [ ] **Step 7: Commit**

```bash
git add src/v2/jobsRepo.ts src/v2/jobsRepo.test.ts
git commit -m "$(cat <<'EOF'
feat(v2): add JobsRepo.upsertWorkerTask() + payload/parent_job_id types (v3 phase ④)

Deliberately a separate method with its own WorkerTaskIdentity type,
not a 4th JobIdent union member — upsertWanted's if/else-if/else kind
switch narrows on exactly 3 variants today; adding a 4th there without
restructuring that control flow would silently route worker_task
identities into the realign SQL branch.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

## Phase ⑤ — Orchestrator agent

Per the requester's instruction, phases ⑤–⑧ are specified at a slightly higher level: real file paths and real signatures throughout, fewer exhaustive per-branch tests than ①–④. **If this phase grows in scope during implementation (e.g. the 100-cap spillover tree needs its own recursive-claim integration tests), split it into a follow-up plan rather than compressing the rigor below.**

The orchestrator reads the living-doc (mechanical scan results already sitting in `LibraryRepo`, written by the EXISTING unchanged `scanLibrary`/`classifyItemDetailed`), decides dispatch order with `reasoning: 'high'`, and writes `worker_task` rows via `JobsRepo.upsertWorkerTask` (phase ④). The **100-task-per-orchestrator cap is enforced in code** (a counter inside the dispatch tools, not merely documented in the skill text) — once reached, the only tool still available for handing off more work is `spawn_sibling_orchestrator`, which does not count against the cap and creates a new `worker_task` row with `payload.taskType = 'orchestrate'` and `parent_job_id` pointing at the current orchestrator, giving the tree/fan-out shape the spec calls for.

### Task 1: Orchestrator skill content

**Files:**
- Create: `src/agent/skills/orchestratorSkill.ts` (same `.ts`-const-module pattern as `findSubtitleSkill.ts`)

Content covers: how to call `list_missing_coverage`, the rule "realign before find-subtitle for the same series if both are pending" (dependency ordering — the concrete reason this phase is agentic rather than a second mechanical FIFO), the effort-scaling rule from the spec's risk ledger ("simple = dispatch little, don't spawn 50 subagents for a trivial backlog" — the classic multi-agent cost-blowup failure mode), and the hard 100-dispatch cap + `spawn_sibling_orchestrator` escape valve.

### Task 2: Living-doc read tool + dispatch tools (hard-capped)

**Files:**
- Create: `src/agent/orchestratorAgent.tools.ts`

```ts
import { tool } from 'ai'
import { z } from 'zod'
import type { LibraryRepo } from '../v2/libraryRepo.js'
import type { JobsRepo } from '../v2/jobsRepo.js'
import type { TmdbClient } from '../adapters/providers/tmdb.js'
import { mirrorExceedsSeasonTable } from './diagnoseSeason.js'

export function makeListMissingCoverageTool(lib: Pick<LibraryRepo, 'missingBySeason' | 'missingMovies'>, now: () => number) {
  return tool({
    description:
      'Read the mechanical pre-scan\'s living-doc: which series/seasons and movies are ' +
      'currently missing a Chinese subtitle. This is factual bookkeeping only — it does not ' +
      'judge whether any particular subtitle is correct.',
    inputSchema: z.object({}),
    execute: async () => ({
      missingSeasons: lib.missingBySeason(now()),
      missingMovies: lib.missingMovies(now()).map(m => ({ id: m.id, name: m.name })),
    }),
  })
}

/** Deterministic pre-check the orchestrator MUST consult before dispatching a realign task —
 *  this is what makes "正常库零误触发" (zero false-trigger on an already-aligned library) a
 *  code-level property of the orchestrator's own dispatch decision, not just something
 *  executeRealign's internal gates catch after the fact (phase ⑥ leaves those unchanged as a
 *  second, independent layer of defense). Reuses mirrorExceedsSeasonTable — the exact same
 *  pure primary-signal check src/agent/diagnoseSeason.ts already uses to short-circuit to
 *  'unknown' without spending an LLM call when the signal doesn't hold — confirmed unchanged
 *  by reading diagnoseSeason.ts directly. A season with mirrorEpisodeCount <= tmdbEpisodeCount
 *  is NOT a realign candidate, full stop; the tool reports that fact rather than letting the
 *  model infer it from nothing. */
export function makeCheckSeriesLayoutTool(
  lib: Pick<LibraryRepo, 'countEpisodesInSeason'>,
  tmdb: Pick<TmdbClient, 'getSeasonTable'>,
) {
  return tool({
    description:
      'Deterministic check: does this series/season\'s mirror episode count exceed TMDB\'s ' +
      'recorded episode count for that season? Only a TRUE result is even a candidate for ' +
      'dispatch_realign_task — this is the same primary signal diagnoseSeason.ts already uses ' +
      'to rule out realign candidates without spending an LLM call.',
    inputSchema: z.object({ seriesId: z.string(), season: z.number().int(), tmdbId: z.string() }),
    execute: async ({ seriesId, season, tmdbId }) => {
      const mirrorEpisodeCount = lib.countEpisodesInSeason(seriesId, season)
      const seasonTable = await tmdb.getSeasonTable(tmdbId)
      const tmdbEpisodeCount = seasonTable?.find(s => s.seasonNumber === season)?.episodeCount ?? null
      const exceedsSeasonTable = mirrorExceedsSeasonTable({ seriesId, season, mirrorEpisodeCount, tmdbEpisodeCount })
      return { mirrorEpisodeCount, tmdbEpisodeCount, exceedsSeasonTable }
    },
  })
}

export interface DispatchDeps {
  jobs: Pick<JobsRepo, 'upsertWorkerTask'>
  now: () => number
  parentJobId: number | null
  maxDispatchesPerOrchestrator?: number
}

/** Shared mutable counter across every dispatch_* tool instance for one orchestrator run —
 *  the 100-cap is a single budget across ALL dispatch kinds, not 100 find-subtitle tasks PLUS
 *  100 realign tasks separately. */
export interface DispatchCounter { count: number }

function capCheck(counter: DispatchCounter, cap: number): { error: string } | null {
  if (counter.count >= cap) {
    return { error: `dispatch cap (${cap}) reached for this orchestrator — call spawn_sibling_orchestrator to hand off the rest instead of dispatching more directly` }
  }
  return null
}

export function makeDispatchFindSubtitleTaskTool(deps: DispatchDeps, counter: DispatchCounter) {
  const cap = deps.maxDispatchesPerOrchestrator ?? 100
  return tool({
    description: 'Dispatch a find-subtitle worker task for one series+season or one movie.',
    inputSchema: z.object({
      seriesId: z.string().nullable(), season: z.number().int().nullable(), movieId: z.string().nullable(),
      reason: z.string(),
    }),
    execute: async ({ seriesId, season, movieId, reason }) => {
      const capped = capCheck(counter, cap)
      if (capped) return capped
      deps.jobs.upsertWorkerTask({ seriesId, season, movieId }, { taskType: 'find_subtitle', reason }, deps.parentJobId, deps.now())
      counter.count++
      return { dispatched: true, remainingCapacity: cap - counter.count }
    },
  })
}

export function makeDispatchRealignTaskTool(deps: DispatchDeps, counter: DispatchCounter) {
  const cap = deps.maxDispatchesPerOrchestrator ?? 100
  return tool({
    description:
      'Dispatch a realign worker task for one series whose on-disk layout looks misaligned ' +
      'with TMDB (e.g. absolute-numbering flat layout). Dispatch this BEFORE find_subtitle for ' +
      'the same series if both are pending — realigning first means the subsequent ' +
      'find-subtitle task sees correctly-numbered files.',
    inputSchema: z.object({ seriesId: z.string(), reason: z.string() }),
    execute: async ({ seriesId, reason }) => {
      const capped = capCheck(counter, cap)
      if (capped) return capped
      deps.jobs.upsertWorkerTask({ seriesId, season: null, movieId: null }, { taskType: 'realign', reason }, deps.parentJobId, deps.now())
      counter.count++
      return { dispatched: true, remainingCapacity: cap - counter.count }
    },
  })
}

/** Does NOT count against the 100-dispatch cap — this IS the cap's escape valve. shardIndex is
 *  supplied by the model (or a simple incrementing counter the caller tracks) purely to keep
 *  the synthetic seriesId human-legible in the jobs table; it has no other significance. */
export function makeSpawnSiblingOrchestratorTool(deps: Omit<DispatchDeps, 'maxDispatchesPerOrchestrator'>) {
  return tool({
    description:
      'Hand off remaining dispatch work to a new sibling orchestrator job, once you have used ' +
      'up this orchestrator\'s dispatch capacity. Give it a short description of what remains.',
    inputSchema: z.object({ shardIndex: z.number().int(), remainingWorkSummary: z.string() }),
    execute: async ({ shardIndex, remainingWorkSummary }) => {
      const syntheticSeriesId = `orchestrator-shard-${deps.parentJobId ?? 'root'}-${shardIndex}`
      deps.jobs.upsertWorkerTask(
        { seriesId: syntheticSeriesId, season: null, movieId: null },
        { taskType: 'orchestrate', remainingWorkSummary },
        deps.parentJobId,
        deps.now(),
      )
      return { spawned: true, syntheticSeriesId }
    },
  })
}
```

### Task 3: `makeOrchestratorAgent()`

**Files:**
- Create: `src/agent/orchestratorAgent.ts`

```ts
import { stepCountIs, type LanguageModel } from 'ai'
import { z } from 'zod'
import { makeReasoningAgent } from './reasoningAgent.js'
import { makeReadDocTool, systemPromptSkillIndex } from './skills/registry.js'
import { ORCHESTRATOR_SKILL } from './skills/orchestratorSkill.js'
import {
  makeListMissingCoverageTool, makeCheckSeriesLayoutTool, makeDispatchFindSubtitleTaskTool,
  makeDispatchRealignTaskTool, makeSpawnSiblingOrchestratorTool, type DispatchCounter,
} from './orchestratorAgent.tools.js'
import type { LibraryRepo } from '../v2/libraryRepo.js'
import type { JobsRepo } from '../v2/jobsRepo.js'
import type { TmdbClient } from '../adapters/providers/tmdb.js'

export const OrchestratorDecisionSchema = z.object({
  dispatchedFindSubtitle: z.number().int(),
  dispatchedRealign: z.number().int(),
  spawnedSiblings: z.number().int(),
  summary: z.string(),
})
export type OrchestratorDecision = z.infer<typeof OrchestratorDecisionSchema>

export interface OrchestratorAgentDeps {
  model: LanguageModel
  lib: Pick<LibraryRepo, 'missingBySeason' | 'missingMovies' | 'countEpisodesInSeason'>
  tmdb: Pick<TmdbClient, 'getSeasonTable'>
  jobs: Pick<JobsRepo, 'upsertWorkerTask'>
  now: () => number
  /** null for the root orchestrator (triggered directly, phase ⑦); set to the claiming job's
   *  own id when this run IS a sibling orchestrator claimed from the jobs table (phase ⑦'s
   *  claim-dispatch switch passes its own job.id here). */
  orchestratorJobId: number | null
  stepCap?: number
  maxDispatchesPerOrchestrator?: number
}

export function makeOrchestratorAgent(deps: OrchestratorAgentDeps) {
  return async function runOrchestratorPass(): Promise<OrchestratorDecision> {
    const counter: DispatchCounter = { count: 0 }
    const dispatchDeps = { jobs: deps.jobs, now: deps.now, parentJobId: deps.orchestratorJobId }

    const tools = {
      read_doc: makeReadDocTool([ORCHESTRATOR_SKILL]),
      list_missing_coverage: makeListMissingCoverageTool(deps.lib, deps.now),
      // Hard gate (spec: "正常库零误触发"): the orchestrator MUST call this before
      // dispatch_realign_task — a season that does not exceed TMDB's episode count is never a
      // realign candidate, and this tool reports that as a fact rather than letting the model
      // infer it. executeRealign's own gates (unchanged, phase ⑥) are a second, independent
      // layer of defense on top of this, not the only one.
      check_series_layout: makeCheckSeriesLayoutTool(deps.lib, deps.tmdb),
      dispatch_find_subtitle_task: makeDispatchFindSubtitleTaskTool(
        { ...dispatchDeps, maxDispatchesPerOrchestrator: deps.maxDispatchesPerOrchestrator }, counter,
      ),
      dispatch_realign_task: makeDispatchRealignTaskTool(
        { ...dispatchDeps, maxDispatchesPerOrchestrator: deps.maxDispatchesPerOrchestrator }, counter,
      ),
      spawn_sibling_orchestrator: makeSpawnSiblingOrchestratorTool(dispatchDeps),
    }

    const instructions = [
      'You are the orchestrator. You plan dispatch order, you do not do the work yourself.',
      'Scale effort to the actual backlog — a handful of missing seasons does not need you to',
      'spawn many subagents; that is a known multi-agent cost blowup, not thoroughness.',
      'Before EVER calling dispatch_realign_task for a series/season, you MUST call',
      'check_series_layout for it first and only proceed if exceedsSeasonTable is true — never',
      'dispatch a realign task on a hunch.',
      '',
      'Available skill documents (call read_doc(name) to load the full text of one):',
      systemPromptSkillIndex([ORCHESTRATOR_SKILL]),
    ].join('\n')

    const agent = makeReasoningAgent({
      model: deps.model,
      tools,
      instructions,
      schema: OrchestratorDecisionSchema,
      stopWhen: stepCountIs(deps.stepCap ?? 500),
      reasoning: 'high',
      telemetry: { isEnabled: true },
    })

    const result = await agent.generate({
      prompt: 'Read the living-doc and dispatch worker tasks for whatever needs work right now.',
      abortSignal: AbortSignal.timeout(180_000),
    })
    return result.output
  }
}
```

- [ ] **Test:** `src/agent/orchestratorAgent.test.ts` — mock-model scenario using the same `MockLanguageModelV4` + scripted-step pattern established in phases ①/③ (a `doGenerate` step calling `list_missing_coverage`, one or two `dispatch_find_subtitle_task` calls, a final `OrchestratorDecisionSchema`-shaped text response), asserting against a real `:memory:` `JobsRepo`/`LibraryRepo` pair that the right `worker_task` rows actually landed with the right `payload`/`parent_job_id`. Add a second test proving the 100-cap: seed `deps.maxDispatchesPerOrchestrator = 2`, script the model attempting 3 dispatches, assert the 3rd tool call receives the cap-reached `{error}` and that `countByState('wanted')` only grew by 2 (plus whatever `spawn_sibling_orchestrator` adds if the script calls it next).

- [ ] **Commit:**

```bash
git add src/agent/skills/orchestratorSkill.ts src/agent/orchestratorAgent.tools.ts src/agent/orchestratorAgent.ts src/agent/orchestratorAgent.test.ts
git commit -m "$(cat <<'EOF'
feat(agent): add orchestrator agent — living-doc read + hard-capped dispatch (v3 phase ⑤)

100-dispatch cap enforced in code (a shared counter across dispatch
tools), not just documented — spawn_sibling_orchestrator is the cap's
escape valve, creating a worker_task row with payload.taskType=
'orchestrate' and parent_job_id pointing at this orchestrator.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

## Phase ⑥ — 整理子代理 (realign worker, wraps `executeRealign`)

`executeRealign` (`src/v2/realignExecutor.ts`) is already fully dependency-injected (`RealignExecutorDeps`, 14 fields, confirmed by reading the file) and already carries its five safety layers (mount-alive sentinel, atomic rename, write-ahead manifest + rollback, never-delete archival, nested-video park threshold) — this phase does not touch `executeRealign` itself, it only wraps it as something a `worker_task` claim loop can invoke.

### Task 1: `realignWorkerTask` handler

**Files:**
- Create: `src/v2/realignWorkerTask.ts`

```ts
import { executeRealign, type RealignExecutorDeps, type RealignExecutionResult } from './realignExecutor.js'
import type { Job, JobsRepo } from './jobsRepo.js'

export interface RealignWorkerTaskPayload { taskType: 'realign'; seriesId: string; reason: string }

/** Claims-and-runs one worker_task row whose payload.taskType === 'realign'. Called from the
 *  same claim-dispatch switch as the find-subtitle worker (phase ⑦) — job.kind === 'worker_task'
 *  is generic, the payload's taskType discriminates which handler to invoke. Inherits all five
 *  of executeRealign's existing safety layers unchanged; this wrapper only bridges a
 *  worker_task row's identity (series_id column) to the Job shape executeRealign expects
 *  (job.series_id) and its completion back onto the jobs table via the existing
 *  complete*/park methods — no new safety logic. */
export async function runRealignWorkerTask(
  job: Job, deps: RealignExecutorDeps, jobs: Pick<JobsRepo, 'completeDone' | 'completeError' | 'park'>, now: () => number,
): Promise<RealignExecutionResult> {
  const result = await executeRealign(job, deps)
  if (result.decision === 'realigned') jobs.completeDone(job.id, now())
  else if (result.decision === 'park') jobs.park(job.id, result.detail, now())
  else jobs.completeError(job.id, result.detail, now())
  return result
}
```

- [ ] **Test:** `src/v2/realignWorkerTask.test.ts` — construct a `worker_task` job row via `jobsRepo.upsertWorkerTask({seriesId, season:null, movieId:null}, {taskType:'realign', reason:'...'}, null, now)`, claim it via `claimNext`, pass a fake `RealignExecutorDeps` (mirroring the existing `realignExecutor.test.ts`'s own fakes — read that file's `beforeEach` setup before writing this test, it already has a complete fake-deps builder to reuse or closely imitate) into `runRealignWorkerTask`, and assert the job's terminal state matches the returned `decision` (`realigned`→done, `park`→dormant, `error`→failed with `next_retry_at` set).

- [ ] **Commit:**

```bash
git add src/v2/realignWorkerTask.ts src/v2/realignWorkerTask.test.ts
git commit -m "$(cat <<'EOF'
feat(v2): wrap executeRealign as a claimable worker_task handler (v3 phase ⑥)

No changes to executeRealign itself or its five safety layers — this is
a thin bridge from a worker_task row's identity/completion bookkeeping
to the existing RealignExecutorDeps-driven function.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

## Phase ⑦ — Trigger flow: dashboard "全仓校验" → mechanical pre-scan → orchestrator

**Read before wiring:** `src/daemon/watcher.ts`'s `WatcherDeps`/`Watcher.tick()` (already read in full during planning — it drives the playback-triggered path, not the reconcile path this phase touches) and `src/cli/index.ts`'s `cmdWatch` (already read in full — its claim-dispatch currently branches only on `job.kind === 'realign'` vs everything else via `executeRealignClosure`/`runEpisode`; this phase adds a third branch). Before touching `src/dashboard/router.ts`/`apiV2.ts`, read their current route registration pattern directly — this plan does not assume its exact shape since those files were not read in full during planning; verify signatures before writing code, per this plan's own "verify every seam" discipline.

**Design: two independent wiring points, not one.** (a) An on-demand "全仓校验" trigger (`cmdReconcileAll` CLI command + dashboard button) that runs the mechanical pre-scan (`scanLibrary`, unchanged) then one orchestrator pass — separate from and in addition to the daemon's existing per-tick `aggregate()` mechanical dispatch, which keeps running unchanged and keeps feeding the OLD pipeline via the existing `executor.ts`/`runEpisode` path. (b) `cmdWatch`'s claim loop gains a `job.kind === 'worker_task'` branch that parses `JSON.parse(job.payload).taskType` and routes to `makeFindSubtitleWorker`'s runner (phase ③) or `runRealignWorkerTask` (phase ⑥) or (for `taskType: 'orchestrate'`) `makeOrchestratorAgent` itself. This is what makes the jobs table's kind-agnostic `claimNext` genuinely serve three independent execution paths (old pipeline, new find-subtitle worker, new realign wrapper) off the same queue, exactly as the spec's "DB 即状态机" design calls for.

### Task 1: `cmdReconcileAll` — on-demand trigger

**Files:**
- Modify: `src/cli/index.ts`

```ts
async function cmdReconcileAll() {
  const { makeDeps, withJournal, cacheRoot, llm, jf, mappings, tmdb } = await assemble()
  // ... construct db/jobs/lib exactly as cmdWatch already does (lines ~296-301) ...
  await scanLibrary(jf, lib, { pageSize: 100, fileExists: p => existsSync(p), mappings, skipChineseOrigin, resolver: originResolver })
  const runOrchestratorPass = makeOrchestratorAgent({
    model: llm /* the model instance assemble() already constructs for the old pipeline —
                  reused as-is; the orchestrator does not need its own separately-configured model */,
    lib, jobs, now: () => Date.now(), orchestratorJobId: null,
  })
  const decision = await runOrchestratorPass()
  console.log(`[reconcile-all] ${decision.summary} (dispatched ${decision.dispatchedFindSubtitle} find-subtitle, ${decision.dispatchedRealign} realign, spawned ${decision.spawnedSiblings} sibling orchestrators)`)
}
```

Wire `if (cmd === 'reconcile-all') return cmdReconcileAll()` alongside the existing `if (cmd === 'watch') return cmdWatch()` dispatch.

### Task 2: `cmdWatch`'s claim loop gains the `worker_task` branch

**Files:**
- Modify: `src/cli/index.ts` (the claim/dispatch section inside `cmdWatch`, near the existing `executeRealignClosure` wiring read during planning)

```ts
// inside cmdWatch's claim loop, alongside the existing job.kind === 'realign' branch:
if (job.kind === 'worker_task') {
  const payload = JSON.parse(job.payload ?? '{}') as { taskType: string; [k: string]: unknown }
  if (payload.taskType === 'find_subtitle') {
    const decision = await findSubtitleWorkerRunner({ /* map job.series_id/season or job.movie_id + LibraryRepo lookups → FindSubtitleTask */ })
    if (decision.decision === 'installed') jobs.completeDone(job.id, Date.now())
    else if (decision.decision === 'retry_later') jobs.completeError(job.id, decision.reason, Date.now())
    else jobs.completeNoMatch(job.id, Date.now())
  } else if (payload.taskType === 'realign') {
    await runRealignWorkerTask(job, realignDeps, jobs, () => Date.now())
  } else if (payload.taskType === 'orchestrate') {
    const decision = await makeOrchestratorAgent({ lib, jobs, model: llm, now: () => Date.now(), orchestratorJobId: job.id })()
    jobs.completeDone(job.id, Date.now())
  }
  continue
}
```

The `/* map job.series_id/season or job.movie_id + LibraryRepo lookups → FindSubtitleTask */` mapper (turning a claimed `worker_task` row + its `LibraryRepo` episode/movie row into a `FindSubtitleTask`'s `videoPath`/`videoFilename`/`title`/etc.) is real, non-trivial glue code that depends on exactly how `cmdWatch` already resolves a `series_season`/`movie` job's target episode today (the existing `runEpisode`/`makeRunEpisode` closure already does this mapping for the OLD pipeline) — **read `makeRunEpisode` in `src/v2/executor.ts` in full before writing this mapper**, and reuse its episode/movie-row-lookup logic rather than re-deriving it, since `FindSubtitleTask`'s fields (`title`, `year`, `season`, `episode`, `videoPath`, `providerIds`) are deliberately the same shape of information `makeRunEpisode` already assembles for the old pipeline's `MediaContext`.

### Task 3: Dashboard endpoint + web button

**Files:**
- Modify: `src/dashboard/apiV2.ts`, `src/dashboard/router.ts` (read their current routing pattern first — not assumed here)
- Modify: `web/src/components/*` (identify the existing dashboard action-button component to extend — not assumed here; this repo's dashboard already has at least one triggered action per `src/dashboard/apiV2.ts`'s existence, follow its established pattern)

Add `POST /api/v2/reconcile-all` that invokes the same logic as `cmdReconcileAll` (Task 1) — factor the scan+orchestrator-pass body into a shared function both the CLI command and the HTTP handler call, rather than duplicating it. Add a "全仓校验" button in the web dashboard that POSTs to this endpoint and shows the returned summary/counts.

- [ ] **Tests:** a `src/dashboard/apiV2.test.ts` (or new `apiV3.test.ts`, matching whatever versioning convention the existing dashboard test files use — check `router.test.ts` first) case for the new route, and a `web/src/components/*.test.tsx` case for the button (uses `@testing-library/react`, already a `web/` devDependency).
- [ ] **Verification for this phase specifically (both packages):**
  - Run: `npm run check` (root)
  - Run: `cd web && npx tsc --noEmit` (web has no `check` script — direct invocation, per this plan's header note)
  - Run: `npx vitest run` (root)
  - Run: `cd web && npx vitest run` (web)
  - Expected: all four green.

- [ ] **Commit:**

```bash
git add src/cli/index.ts src/dashboard/apiV2.ts src/dashboard/router.ts web/src/components web/src
git commit -m "$(cat <<'EOF'
feat: wire "全仓校验" trigger — mechanical scan + orchestrator pass (v3 phase ⑦)

New cmdReconcileAll CLI command + dashboard endpoint/button, separate
from the daemon's existing per-tick aggregate() mechanical dispatch
(which keeps feeding the old pipeline unchanged). cmdWatch's claim loop
gains a job.kind==='worker_task' branch routing on payload.taskType to
the new find-subtitle worker, the realign wrapper, or a sibling
orchestrator pass.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

## Phase ⑧ — Retire the old pipeline (GATED — do last, only after phase ③'s live acceptance passes)

**Hard gate:** do not start this phase until phase ③ Task 7's live acceptance checklist has a real passing run logged. Retiring the old pipeline before that would leave the repo with no verified-working subtitle-fetching path at all if the new one turns out to have a real-world gap offline fixtures didn't catch (the exact zimuku-lesson risk the spec calls out).

### Task 1: Confirm the gate, then retire the 9 dissolved single-shot agents

**Files to delete** (their judgment is now folded into the find-subtitle worker's own `reasoning: 'high'` tool-loop, per the spec's dissolution list):
- `src/agent/identifyMedia.ts` (+ `.test.ts`)
- `src/agent/planSearch.ts` (+ `.test.ts`)
- `src/agent/rankCandidates.ts` (+ `.test.ts`) — **but first confirm no other still-live code imports `isGraphicOnly`/`filterGraphicOnly`/`neededEpisodeCodesFor`/`compactCandidates` from this file**; the spec explicitly calls these out as "确定性工具" worth keeping. If phase ③'s worker or anything else still needs them, move them to a small standalone module (e.g. `src/agent/candidateFilters.ts`) before deleting `rankCandidates.ts`, rather than deleting working pure helpers along with the LLM-calling function they used to live beside.
- `src/agent/verifySubtitle.ts` (+ `.test.ts`)
- `src/agent/judgeOrphan.ts`
- `src/agent/mapSeasonPack.ts`
- `src/agent/mapLooseEpisodes.ts` (+ `.test.ts`) — same pure-helper check as `rankCandidates.ts`
- `src/agent/diagnoseSeason.ts` (+ `.test.ts`) — **`mirrorExceedsSeasonTable` is imported by `src/agent/orchestratorAgent.tools.ts` (phase ⑤'s `check_series_layout` tool — the deterministic pre-check behind the "zero false-trigger on an aligned library" hard gate). Move this one pure function to a standalone module (e.g. `src/agent/seasonShape.ts`) and update `orchestratorAgent.tools.ts`'s import BEFORE deleting `diagnoseSeason.ts`, exactly like the `rankCandidates.ts` pure-helper check above — do not delete a function a still-live phase ⑤ module depends on.**
- `src/agent/harvestAlias.ts` (+ `.test.ts`)

**Kept as-is:** `src/agent/solveNumericCaptcha.ts` (+ `.test.ts`) — the spec explicitly keeps this (narrow, multimodal OCR, callable by any subagent that needs it).

- [ ] For each deleted module, `grep -rn '<moduleName>' src --include='*.ts'` first and resolve every remaining import (either it's a dead import to delete alongside, or it's a pure helper that needs to move somewhere per the note above) before removing the file.
- [ ] Run `npm run check` and `npx vitest run` after each deletion — do not batch all 9 deletions into one commit; delete and verify green one at a time, matching this plan's own bite-sized discipline.

### Task 2: Retire the forced-tool-call path itself

**Files to delete:**
- `src/agent/runtime.ts` (+ `.test.ts`) — the mode-dispatch (`forced-tool`/`prompt-json`) wrapper
- `src/agent/quirks.ts` — the thinking-disable body-injection table (the actual illness this whole plan exists to cure)
- `src/agent/probe.ts` (+ `.test.ts`) — the probe ladder that exists only to find a quirk that makes forced `tool_choice` work
- `src/agent/profile.ts` (+ `.test.ts`) — the probed-profile cache

**Files to modify, not delete:** `src/agent/llm.ts` — `callStructured`/`callPromptJson`/`makeModel`/`injectExtraBody` may still have live callers outside the 9 dissolved agents (check `src/agent/solveNumericCaptcha.ts` and anywhere else `runtime.ts`'s `LlmRuntime` interface is consumed) before deleting `llm.ts` itself; if `makeModel` is still needed (it almost certainly is — `reasoningAgent.ts`/`findSubtitleWorker.ts` need a `LanguageModel` instance too, and `makeModel` is the only place that constructs one against this repo's `subtitle-scout-llm` OpenAI-compatible provider config), keep `makeModel`/`LlmConfig` and delete only the forced-tool-call machinery (`callStructured`, `callPromptJson`, `ToolChoiceRejectionError`, `isToolChoiceRejection`, `StructuredOutputError`, `extractJson`).

- [ ] Same one-at-a-time delete-and-verify discipline as Task 1.

### Task 3: Final full-repo green check + update `docs/design/2026-07-13-v3-agentic-rebirth-design.md`'s status

- [ ] Run: `npm run check && npx vitest run` (root)
- [ ] Run: `cd web && npx tsc --noEmit && npx vitest run` (web)
- [ ] Grep the entire `src/` tree for any remaining reference to the deleted modules' names — a stale import that `tsc --noEmit` somehow didn't catch (e.g. a dynamic `import()` string) would be a silent runtime break.
- [ ] Update the design doc's status line (currently "状态:设计中") to reflect that the migration is complete and dated, per this repo's existing convention of dating design-doc status updates in place.
- [ ] Commit:

```bash
git add -A
git commit -m "$(cat <<'EOF'
chore(agent): retire the pre-v3 forced-tool-call pipeline (v3 phase ⑧, gated on live acceptance)

10 single-shot forced-JSON agents + the thinking-disable quirk/probe/
profile triad are gone — replaced by the ToolLoopAgent-based
find-subtitle worker (phase ③) with reasoning enabled. Gated: this
commit must not land until phase ③'s live acceptance checklist has a
real passing run logged (docs/design/2026-07-13-v3-live-acceptance-checklist.md).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

## Known gaps deliberately deferred (not silently dropped)

Three items from the spec are not mechanically covered by the tasks above. Each is a real, scoped follow-up rather than a placeholder — recorded here so a resuming implementer (or a follow-up plan) picks them up explicitly instead of assuming this plan already handled them:

1. **Auto-research iterative skill guardrails** (spec: "auto-research 迭代 skill(带护栏,不放任自改)" — a fixed eval set, incremental append-only skill updates with human curation, hard rule against the model rewriting its own skill file wholesale, citing the ACE paper's context-collapse finding). This plan's phases ①–⑧ ship the skills (`FIND_SUBTITLE_SKILL`, `ORCHESTRATOR_SKILL`) as static, hand-authored content and an offline eval harness (phase ③ Task 6) that runs against fixed fixtures — but no mechanism for the skill content itself to be incrementally improved from observed failures exists yet. This is a meaningfully separate piece of infrastructure (a curation queue, an append-only diff review step, a hard block on full-file rewrites) that deserves its own plan once phases ①–④ have produced enough real running history to have failures worth learning from.
2. **Hard token/cost budget, separate from `stepCountIs`** (spec: "测试期不设步数上限...但设硬 token/成本预算+全程 tracing"). This plan wires `telemetry: { isEnabled: true }` (OTel spans) throughout and uses a step-count ceiling (`stepCountIs(500)` in test/eval contexts) as the only enforced limit. A token/cost ceiling independent of step count (e.g. accumulating `usage.totalTokens` across `onStepFinish` and aborting once a budget is exceeded, distinct from hitting the step cap) is not implemented. Follow-up: add an `onStepFinish` callback to `makeReasoningAgent` (phase ①) that tracks cumulative usage and calls `AbortController.abort()` on the same signal passed to `.generate()` once a caller-supplied token budget is exceeded.
3. **OS-level sandbox jail** (spec: "Linux NAS 可选加 OS 级 jail:@anthropic-ai/sandbox-runtime/bubblewrap 或 Docker 单目录 bind-mount;v1 先做前两层,OS 层记 backlog"). This plan implements exactly the two layers the spec calls for in v1 — code-layer path validation (`isUnderRoots`/`containingRoot`, phase ③ Tasks 2–3) and prompt/skill-layer scope narrowing (phase ② `FIND_SUBTITLE_SKILL`) — and explicitly does not add an OS-level jail, matching the spec's own "v1 先做前两层" scoping. Recorded here only so it isn't mistaken for an oversight.

**Not a gap, but worth restating for a resuming implementer:** the "正常库零误触发" hard test gate (zero false-trigger realign on an already-aligned library) is satisfied by TWO independent layers — phase ⑤'s `check_series_layout` advisory tool (the orchestrator is instructed to check before ever dispatching a realign task) is the efficiency/waste-avoidance layer; the REAL zero-harm guarantee is `executeRealign`'s own pre-existing, unchanged, already-tested plan gates (`buildRealignPlan`'s parseable-coverage/continuity checks, the `SxxEyy` guard in `parseAbsoluteEpisodeNumber` that refuses files already in normal season/episode form) — phase ⑥ explicitly does not touch any of that. Even if the orchestrator mis-dispatched a realign task for an aligned library, `executeRealign` would still refuse to move a single file.

---

## Self-review

**1. Spec coverage** (checked against every numbered/bulleted claim in `docs/design/2026-07-13-v3-agentic-rebirth-design.md`):

| Spec requirement | Covered by |
|---|---|
| North star #1: judge by metadata, never dialogue content, never a confidence score | Phase ③ (`FIND_SUBTITLE_SKILL`, `FindSubtitleDecisionSchema` has no confidence field, `download_candidate` returns structural `InspectSignals` not dialogue text) |
| North star #2: deterministic checks are factual bookkeeping, never the correctness gatekeeper | Phase ③ Task 4 (`check_episode_code_safety` explicitly advisory); mechanical `scanLibrary`/`classifyItemDetailed` untouched; phase ⑤'s `check_series_layout` is advisory, not a hard gate on the model's own reasoning (the hard gate is `executeRealign`'s unchanged internal gates, per the note above) |
| North star #3: root cause is "model not allowed to think," fix is reasoning + reason-then-answer | Phase ① (both tasks: mock-model proof + real `reasoning`→`reasoning_effort` wiring proof) |
| Framework selection: `ai@7.0.15`, zero new dependencies, no eve/Temporal/Inngest/LangGraph/DBOS | Every phase — no new npm dependency appears in any task |
| Architecture: main-subagent tree, mechanical pre-scan → orchestrator → subagents | Phase ⑦ (trigger wiring), phase ⑤ (orchestrator), phases ③/⑥ (subagents) |
| Mechanical pre-scan writes a living-doc, never stuffed into agent context | Phase ⑤ (`list_missing_coverage`/`check_series_layout` pull on demand from `LibraryRepo`, unchanged `scanLibrary`) |
| Orchestrator only orchestrates; skill-based initial context | Phase ⑤ Task 1/3 |
| 100-task/orchestrator hard cap + sibling spillover tree | Phase ⑤ Task 2/3 (`DispatchCounter`, `spawn_sibling_orchestrator`) — enforced in code, not just documented |
| Realign subagent: sandboxed, wraps existing capability | Phase ⑥ |
| Find-subtitle subagent: `ToolLoopAgent`+reasoning, re-search, compare, `Output.object` finalize, sandboxed | Phase ③ (entire phase) |
| DB is the state machine; crash-restart continues from DB | Phase ④ (extends, does not replace, the existing `claimNext`/lease machinery) |
| Sandbox: code layer + prompt layer, OS layer is backlog | Phase ③ header + "Known gaps" section above |
| Living-doc/skill: progressive disclosure via hand-rolled `read_doc`, not `ai@7` `uploadSkill` | Phase ② Task 1/2 (explicit note on why) |
| Search results handle-ized, not inlined | Phase ② Task 3/4 |
| Auto-research iterative skill with guardrails | **Not covered — "Known gaps" item 1** |
| Test philosophy: no step cap in test, big ceiling, hard token/cost budget, full tracing | `stepCountIs(500)` throughout phase ③/⑤; `telemetry:{isEnabled:true}` wired; **hard token/cost budget not implemented — "Known gaps" item 2** |
| Full-shape offline eval (新片/在更剧/老片/老剧/乱排布) | Phase ③ Task 6 |
| Zero false-trigger on aligned libraries (hard gate) | Phase ⑤'s `check_series_layout` + phase ⑥'s unchanged `executeRealign` gates (see note above) |
| Live end-to-end hard gate (real site, real LLM, real install) | Phase ③ Task 7 |
| DB v8 migration: `worker_task` kind, `payload`, `parent_job_id`, v7 recipe reuse | Phase ④ Task 1 |
| Identity/dedup structural constraint addressed | Phase ④ header design-decision note (reuses existing 3-column identity, no new scheme) |
| Reuse map: `fetchLib`/`stagingSandbox`/`subtitleWriter`/`subtitleInspect`/`libraryRealign`/`realignManifest`/`scanner` untouched | Every phase ③/⑥ task imports these unchanged, zero modifications proposed to any of them |
| `realignExecutor.executeRealign` lightly wrapped, not modified | Phase ⑥ |
| `runGate` downgraded to optional tool | Phase ③ Task 4 (with an explicit, justified deviation: a new pure helper, not a call into `runGate`'s legacy signature) |
| 10 agents dissolved into subagent reasoning, `solveNumericCaptcha` kept clean | Phase ⑧ Task 1 (all 9 dissolved agents enumerated + kept-as-is note) |
| Migration path: 8 phases, both packages green throughout, old pipeline not deleted until live acceptance | Every phase's typecheck/test steps; phase ⑧ explicitly gated |
| Risk: cost explosion, effort-scaling rule | Phase ⑤ orchestrator instructions ("scale effort...known multi-agent cost blowup") |
| Risk: context rot | Phase ② (progressive disclosure + handle-ization); item 1 above for the auto-research half |
| Risk: sandbox escape, code layer is the real boundary | Phase ③ header + Task 3's explicit escape-attempt test |
| Risk: data safety (realign) | Phase ⑥ ("no changes to executeRealign... inherits all five safety layers unchanged") |
| Risk: wrong-repo | Plan header |
| Risk: regression (old pipeline kept until acceptance) | Phase ⑧ gate |

**2. Placeholder scan:** searched this plan for "TBD"/"TODO"/"implement later"/"add appropriate"/"handle edge cases"/"similar to Task N" — none found in code blocks. The three explicit gaps above are not placeholders in the prohibited sense (a step that describes what to do without showing how); they are scoped, named follow-up work with a concrete reason each is out of this plan's scope, matching the requester's own instruction that phases ⑤–⑧ may warrant a follow-up plan. Phase ⑦'s Task 3 (dashboard/web wiring) and Task 2's job-payload-to-`FindSubtitleTask` mapper are the two places this plan explicitly says "read the real file before writing this — its exact shape was not read during planning" rather than fabricating a signature it did not verify; this is intentional honesty about phases ⑤–⑧'s "slightly higher level" per the requester's own scoping instruction, not a placeholder.

**3. Type consistency across tasks:** verified by hand —
- `FindSubtitleDecisionSchema`/`FindSubtitleDecision` (phase ③ Task 1) is used with identical field names (`decision`, `reason`, `installedPath`, `installedLanguage`, `candidateProvider`, `candidateProviderId`) in Tasks 5, 6, and 7's script/test code — no drift.
- `FindSubtitleTask`'s fields (`jobId`, `mediaRoot`, `videoPath`, `videoFilename`, `title`, `originalTitle`, `year`, `season`, `episode`, `alternativeTitles`, `overview`, `runtimeMinutes`, `providerIds`) are used identically in phase ③ Tasks 1/5/6/7.
- `stagedFileId`/`stagedFiles: Map<string,string>` naming is identical across Tasks 2, 3, and 5 (`download_candidate` writes it, `install_subtitle` reads it, `findSubtitleWorker.ts` owns the shared `Map` instance).
- `ResultSetStore`'s method names (`create`/`count`/`list`/`get`) from phase ② Task 3 are used unchanged by Task 4's `search_source`/`list_candidates`/`get_candidate` and phase ③ Task 5's assembly.
- `Job`'s new `payload`/`parent_job_id` fields (phase ④ Task 2) match the column names added by phase ④ Task 1's migration exactly (`payload`, `parent_job_id` — not `parentJobId`/camelCase at the DB-row level, matching this repo's existing `snake_case` `Job` interface convention already used for `series_id`/`movie_id`/`plan_ref`/etc.).
- `JobKind` gains exactly one new member (`'worker_task'`) in phase ④ Task 2, matching the exact string used in phase ④ Task 1's migration CHECK constraint and in phase ⑤/⑥/⑦'s `upsertWorkerTask`/claim-dispatch code.
- `WorkerTaskIdentity` (phase ④ Task 2) is deliberately NOT merged into the `JobIdent` union — flagged explicitly in that task with the reason (would silently break `upsertWanted`'s existing 3-way `if`/`else if`/`else` narrowing). Phase ⑤'s `DispatchDeps`/dispatch tools call `jobs.upsertWorkerTask(...)` with the same 3-field `{seriesId, season, movieId}` shape, not the `JobIdent` union — consistent.
- `mirrorExceedsSeasonTable`'s cross-phase dependency (phase ⑤ imports it from `diagnoseSeason.ts`, which phase ⑧ deletes) is called out explicitly in phase ⑧ Task 1 with the required extraction step before deletion — the one real cross-phase fragility this self-review found, now recorded rather than silently landing as a phase ⑧ breakage.

---
