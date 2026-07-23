# Translate Workspace Agent P1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Deliver the P1 closed loop from `docs/design/2026-07-23-translate-workspace-agent-design.md`: per-job disk workspace, origin-lang single-hop source resolve, clean agent view, glossary doc, bilingual table, deterministic merge + structural/term gates, install only from merge output.

**Architecture:** New `makeTranslateWorker` mirrors `findSubtitleWorker` (skill + tools + staging). Canonical SRT stays immutable; agent only reads cleaned JSONL and writes glossary/bilingual/summary via tools. No full-SRT-in-prompt API.

**Tech Stack:** TypeScript, vitest, ai SDK tool loop (`makeReasoningAgent`), existing `qualityGate` / `fetchSourceSub` / `stagingSandbox` patterns.

**Spec:** `docs/design/2026-07-23-translate-workspace-agent-design.md` (also under `docs/superpowers/specs/`).

**Out of P1:** wiki tool, full critic loop, daemon swap (P2/P3). CLI may call the new runner directly.

---

## File map (P1)

| Path | Role |
|---|---|
| `src/translate/workspace/types.ts` | Row/glossary/meta types |
| `src/translate/workspace/paths.ts` | Job dir layout helpers |
| `src/translate/workspace/materialize.ts` | canonical → clean jsonl + bilingual init |
| `src/translate/workspace/merge.ts` | bilingual + canonical → out/target.srt |
| `src/translate/workspace/resolveSource.ts` | origin-lang single-hop (ja never eng) |
| `src/translate/workspace/*.test.ts` | Unit tests per module |
| `src/agent/skills/translateSkill.ts` | Progressive-disclosure playbook |
| `src/agent/skills/translateSkill.test.ts` | Anchor tests |
| `src/agent/translateWorker.schemas.ts` | Task + finalize report zod |
| `src/agent/translateWorker.tools.ts` | Tool implementations |
| `src/agent/translateWorker.tools.test.ts` | Tool contract tests |
| `src/agent/translateWorker.ts` | `makeTranslateWorker` assembly |
| `src/agent/translateWorker.test.ts` | Tool-order / workspace-shape tests (scripted model) |
| `src/cli/translateItemCommand.ts` | Wire default path to agent runner (keep thin) |

---

### Task 1: Workspace path + types

**Files:**
- Create: `src/translate/workspace/types.ts`
- Create: `src/translate/workspace/paths.ts`
- Create: `src/translate/workspace/paths.test.ts`

- [ ] **Step 1: Write failing test** for layout helpers

```typescript
// paths.test.ts
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { workspacePaths, ensureWorkspaceLayout } from './paths.js'

it('ensureWorkspaceLayout creates canonical/agent_view/glossary/work/out', () => {
  const root = mkdtempSync(join(tmpdir(), 'tw-'))
  const w = ensureWorkspaceLayout(root, 'job-1')
  expect(w.jobRoot).toContain('job-1')
  expect(w.canonicalDir).toMatch(/canonical$/)
  // dirs exist...
})
```

- [ ] **Step 2: Run test — expect FAIL**

`npx vitest run src/translate/workspace/paths.test.ts`

- [ ] **Step 3: Minimal implementation** `paths.ts` + `types.ts`

- [ ] **Step 4: Tests PASS + commit**

`git commit -m "feat(translate): workspace path layout for agent staging"`

---

### Task 2: materialize agent_view (strip timing)

**Files:**
- Create: `src/translate/workspace/materialize.ts`
- Create: `src/translate/workspace/materialize.test.ts`

- [ ] **Step 1: Failing test** — SRT with timing + `{\an8}` → clean jsonl without timing; bilingual pending rows; ids stable

- [ ] **Step 2: Implement** using `parseSrtCues` + ASS strip from pipeline/qualityGate

- [ ] **Step 3: PASS + commit**

`git commit -m "feat(translate): materialize cleaned agent_view and bilingual skeleton"`

---

### Task 3: merge bilingual → target.srt

**Files:**
- Create: `src/translate/workspace/merge.ts`
- Create: `src/translate/workspace/merge.test.ts`

- [ ] **Step 1: Failing test** — canonical timing preserved; tgt text applied; missing tgt fails closed

- [ ] **Step 2: Implement**

- [ ] **Step 3: PASS + commit**

`git commit -m "feat(translate): deterministic merge of bilingual table into srt"`

---

### Task 4: resolveSource single-hop

**Files:**
- Create: `src/translate/workspace/resolveSource.ts`
- Create: `src/translate/workspace/resolveSource.test.ts`

- [ ] **Step 1: Failing tests**
  - `origin=ja` + eng embedded only → **no-source** (not eng)
  - `origin=ja` + jpn embedded → extract jpn
  - `origin=en` + eng embedded → eng
  - `origin=ja` + fetch returns ja srt → jimaku/os ref

- [ ] **Step 2: Implement** with injected `probe` / `extract` / `fetchSourceSub`

- [ ] **Step 3: PASS + commit**

`git commit -m "feat(translate): origin-lang single-hop source resolve"`

---

### Task 5: translate skill document

**Files:**
- Create: `src/agent/skills/translateSkill.ts`
- Create: `src/agent/skills/translateSkill.test.ts`

- [ ] **Step 1: Failing tests** for anchors: single-hop, no Brave, workspace docs, freeze glossary, update_row, no hand-written final SRT

- [ ] **Step 2: Write skill content** (factory if needed)

- [ ] **Step 3: PASS + commit**

`git commit -m "feat(translate): translate-workspace skill playbook"`

---

### Task 6: schemas + tools (read/write workspace, rows, gate, merge, install)

**Files:**
- Create: `src/agent/translateWorker.schemas.ts`
- Create: `src/agent/translateWorker.tools.ts`
- Create: `src/agent/translateWorker.tools.test.ts`

- [ ] **Step 1: Tests** — path sandbox escape denied; update_row cannot change src; finalize requires out/target

- [ ] **Step 2: Implement tools**

- [ ] **Step 3: PASS + commit**

`git commit -m "feat(translate): workspace agent tools and schemas"`

---

### Task 7: makeTranslateWorker + scripted loop test

**Files:**
- Create: `src/agent/translateWorker.ts`
- Create: `src/agent/translateWorker.test.ts`

- [ ] **Step 1: Scripted/mock model test** asserting tool order includes resolve_source → materialize → freeze_glossary → update_row → merge → install (or held)

- [ ] **Step 2: Implement worker assembly like findSubtitleWorker (allocate under `.subtitle-translate`)

- [ ] **Step 3: Full `npm run check` + focused vitest + commit**

`git commit -m "feat(translate): makeTranslateWorker agent entrypoint"`

---

### Task 8: CLI wire + gate integration

**Files:**
- Modify: `src/cli/translateItemCommand.ts`
- Modify/create tests as needed

- [ ] **Step 1: Default translate-item uses agent runner when flag/env allows; document**

- [ ] **Step 2: Structural gate + term gate on bilingual before install**

- [ ] **Step 3: `npx vitest run --maxWorkers=1` subset + `npm run check` + commit**

`git commit -m "feat(translate): wire CLI to workspace agent runner"`

---

### Task 9: P1 verification + run-log note

- [ ] Serial tests green; update `docs/design/2026-07-21-campaign-run-log.md` with P1 status
- [ ] Commit docs

---

## Self-review vs spec

| Spec § | Task |
|---|---|
| Staging layout | T1 |
| agent_view clean | T2 |
| merge | T3 |
| resolve single-hop | T4 |
| skill | T5 |
| tools | T6–T7 |
| gates/install | T6–T8 |
| no Brave / wiki P2 | skill text + deferred |
| daemon P3 | deferred |

---

## Execution

Prefer **subagent-driven-development**: one task per subagent, review between tasks, TDD red→green each step.
