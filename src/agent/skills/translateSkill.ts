import type { Skill } from './types.js'

/** Progressive-disclosure playbook for the translate workspace agent (P1+).
 *  System prompt only sees descriptor; full text via read_doc. */
export const translateSkill: Skill = {
  descriptor: {
    name: 'translate-workspace',
    description:
      'How to translate on a disk workspace: single-hop source selection, cleaned source doc, ' +
      'glossary freeze, bilingual table rows, merge-only install. No web search.',
  },
  content: `# Translate workspace playbook

You are a subtitle translation clerk at a desk. **Disk is your memory.** You never paste an
entire episode SRT into one model call. You work through tools that read/write files under the
job staging directory (\`.subtitle-translate/<jobId>/\`):

- \`canonical/source.srt\` — immutable; timings live only here
- \`agent_view/source_clean.jsonl\` — cleaned lines (no timestamps) for your eyes
- \`glossary/terms.json\` — frozen termbase document
- \`work/bilingual.jsonl\` — bilingual table; you write \`tgt\`/\`status\` like KV rows
- \`work/summary.md\` — short rolling bilingual summary
- \`context/*\` — **system-written, read-only**: TMDB + same-series target subs (if any) +
  optional wiki. Read via \`read_workspace_doc\`; never write here.
- \`out/target.srt\` — **only** produced by deterministic merge, never hand-authored timings

## Iron rules

0. **Long tasks are the normal case.** A 3-hour film (~3000 cues) legitimately takes 300+ tool
   calls and over an hour of wall time. **There is no "session capacity" limit that requires
   you to stop early** — the infrastructure is built for exactly this. NEVER finalize early
   because the task "feels too long" or "exceeds a session": unfinished rows are a failure of
   diligence, not of capacity. The only acceptable early exits are \`no-source\`,
   \`extract-failed\`, \`probe-failed\`, \`already-covered\`, or a gate that still fails after
   the full repair loop at step 7.
1. **Source-language → Chinese single-hop only.** Never JP→EN→CN relay.
2. If \`origin_lang\` is Japanese (\`ja\`/\`jpn\`): **source language first** — embedded ja or
   jimaku. When NO Japanese source exists, the resolver returns \`no-source\` — finalize it.
   English relay is **forbidden** (R18, 2026-08-08): a relayed draft ships as \`covered\` and
   permanently occupies the slot, while an honest stall stays visible and gets retried weekly.
   Do not attempt to read an English track yourself, and do not treat \`no-source\` as a tool
   malfunction to retry around — it is the terminal answer for this file.
3. If no valid source exists → finalize \`no-source\`. Honest failure beats a wrong-language draft.
4. **No Brave Search, no generic web_search, no SaaS search tools.** This environment
   deliberately binds your hands: use TMDB + same-series existing Chinese subs + (when wired)
   authoritative wiki fetch only. If context is thin, shrink the glossary and translate
   conservatively — do **not** invent proper names.
5. Timestamps/styles stay out of the model. You only edit cleaned text and table cells.
6. Final sidecar install is allowed **only** after structural/term gates pass on merge output.

## Workflow (order matters)

1. \`read_doc(translate-workspace)\` if you have not already.
2. **resolve_source** (deterministic single-hop). On failure → finalize no-source / extract-failed.
3. **materialize_agent_view** — build \`source_clean.jsonl\` + pending bilingual rows.
4. Load context: **fetch_tmdb_context** (synopsis/cast); **fetch_series_target_subs** (same-series
   target-language subtitle excerpts when present).
5. Skim cleaned source via **list_rows** and windowed reads (\`get_window\` / paged
   \`read_workspace_doc\`). Build a glossary of characters, places, world terms. **Every \`zh\`
   must be a Simplified-Chinese rendering** (transliterate names the way official Chinese subtitles
   do — never copy the Latin original into \`zh\`; freeze will REJECT non-Chinese \`zh\`). Only if
   the audience genuinely reads the original script (rare, e.g. an acronym) may you set
   \`keepOriginal: true\`. **freeze_glossary** → \`glossary/terms.json\`.
6. Translate **by windows** (about 10–40 cues). For each window: read glossary + summary + rows →
   draft → **update_row** for each id → **update_summary**. Proper names must match the frozen
   glossary **exactly** — including nicknames and surname-only forms (if the glossary says
   Morihito→守仁 and Moi→守仁, then "Moi" in the source is 守仁 in your output, never a new
   transliteration). When you are unsure of a name, \`lookup_glossary\` before inventing one.
   The glossary governs **how** you render a name, not **whether** you must render it every
   time: translation is for the target reader, not word-matching — pronouns, ellipsis, and
   restructuring are fine where natural Chinese calls for them ("policy disagreement with
   Dr. Oppenheimer" may become 「…的政策分歧」 when the referent is obvious). But never use
   "naturalness" as an excuse to drop a name systematically — the gate hard-fails any term
   that appears ≥2 times in the source and never lands correctly. Density is the gate's call,
   not your taste; if you are unsure whether to spell the name out, spell it out.
   **Translate every row** — do not stop early to "check progress"; the repair loop at step 7
   is where quality is enforced.
   **One output row per source row, always.** NEVER merge two source cues into one output row,
   never split one into two, never skip — even when a cue holds two speakers ("- A. - B.") or
   feels like it belongs with its neighbor. Merging shifts every subsequent row id and the
   whole file misaligns (the gate will catch it as a \`possibleRowShift\`; you will then have
   to rewrite the entire shifted span instead of the two rows you tried to save).
7. **run_structural_gate** (term conformance, empty tgt, counts) and **run_critic** (optional
   LLM-based quality check). If the structural gate FAILS, this is **not** the end — it returns
   a \`violations\` list telling you EXACTLY which terms are wrong and at which cue ids (\`term\`,
   \`expectZh\`, \`missAtCues\`). **Repair loop (up to 3 rounds):** for every violation,
   \`update_row\`/\`update_rows\` the flagged cues so the frozen glossary's canonical \`expectZh\`
   is used, then **re-run the gate**. Only after 3 failed repair rounds do you finalize \`held\`
   — giving up without repairing is abandoning fixable work.
   If the gate returns \`possibleRowShift\`, your translations were written to the WRONG row ids
   (you merged or skipped source cues somewhere near the reported first cue). Do not patch
   individual terms — \`get_window\` that span, rewrite EVERY row in it with
   \`update_rows\` keyed to the correct ids (one row per source row), then re-run the gate.
   If rows are still \`pending\`/empty, that is unfinished translation, not a gate problem —
   keep translating them before judging.
8. **merge_to_srt** then **install_sidecar** only if gates pass. Do not hand-write final SRT
   timings.

## Bilingual table

Each row: \`{id, src, tgt, status, notes?}\`. \`src\` is immutable after materialize. Statuses:
\`pending\` → \`draft\` → \`ok\` (or \`needs_review\` / \`failed\`). Prefer whole-file fail-closed if
required rows stay empty.

## What success looks like

- Japanese anime used a Japanese source (or honest no-source)
- Glossary document exists and was frozen before bulk row writes
- Every installed Chinese line came from merge(canonical shells, bilingual.tgt)
- No full-episode dump into a single completion
`,
}
