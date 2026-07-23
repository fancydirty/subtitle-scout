# Translate Workspace Agent P2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: subagent-driven-development / executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Close the gaps proven by P1 live acceptance: cross-job glossary persistence (term canonical variance), critic layer (bracket/semantic blind spots), wiki context tool, staging GC.

**Evidence (campaign 9):** mimo SPY runs chose 东国 vs 奥斯塔尼亚 across jobs; 《》 unpaired residue passed the deterministic gate; strong+weak otherwise green.

**Scope discipline:** daemon swap + runs.llm_calls mapping = P3 (not here). No Brave.

---

## P2.1 Series glossary persistence

**Files:** `src/v2/db.ts` (migration v23 `translate_glossaries`), `src/v2/glossaryRepo.ts(+test)`, `src/agent/translateWorker.tools.ts`, `src/agent/translateWorker.ts`, `src/cli/translateItemCommand.ts`

- [x] Table: `translate_glossaries (series_key TEXT PRIMARY KEY, terms_json TEXT NOT NULL, updated_at INTEGER NOT NULL)`
- [x] `GlossaryRepo { load(seriesKey): GlossaryTerm[]; save(seriesKey, terms): void }`
- [x] `seriesKeyOf(itemId)`: `'tmdb:1/s1e2' → 'tmdb:1'`; movie id as-is
- [x] freeze_glossary: merge prior(load) + model terms, **prior wins** (mergeGlossary semantics); report `{ok, count, inherited}`
- [x] install_sidecar success → save merged terms
- [x] Live re-acceptance: two SPY jobs same series → second run inherits first run's canonical

## P2.2a Deterministic bracket gate

**Files:** `src/agent/translateWorker.tools.ts` + tools test

- [x] run_structural_gate hard violation: unbalanced 《》/「」/【】 in any tgt row (paired-count per row)

## P2.2b run_critic tool

**Files:** `src/agent/translateWorker.tools.ts`, `src/agent/translateWorker.ts`, `src/cli/translateItemCommand.ts`

- [x] deps.critic?: TranslationCritic (existing translateCritic.ts)
- [x] run_critic({fromId?, toId?}): critic over bilingual window → write work/critic.md; rows with major issues → needs_review + clear gate marker; returns {ok, issueCount}
- [x] CLI: TRANSLATE_CRITIC wiring same as legacy (default on, off via env)

## P2.3 fetch_wiki_context

**Files:** `src/agent/translateWorker.tools.ts`, `src/agent/wikiContext.ts(+test)`

- [x] MediaWiki API (Wikipedia, lang by origin: ja→ja.wikipedia, en→en.wikipedia; zh fallback zh.wikipedia), search title → extract intro (no key required)
- [x] Writes context/wiki.md; fetchImpl injectable; failure → written:false, never throws

## P2.4 Staging GC

**Files:** `src/files/stagingSandbox.ts` (+test)

- [x] gcOrphans also sweeps `<root>/.subtitle-translate/` (same non-recursive, skip .ignore + activeJobIds)

## P2.5 Live re-acceptance (mimo)

- [x] SPY job A (full) → job B (same series, 120c): B inherits A glossary (东国 canonical identical), terms conformance intact
- [x] Bracket gate: planted unbalanced 《 → held
- [x] Full serial suite green; run-log updated
