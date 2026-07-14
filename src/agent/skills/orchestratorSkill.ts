// Dispatch playbook for the orchestrator agent (v3 phase ⑤). Same `.ts` const-module pattern as
// findSubtitleSkill.ts — only the name+description reach the system prompt; the full content
// below is loaded on demand via read_doc.
import type { Skill } from './types.js'

const CONTENT = `
# Orchestrator Dispatch Playbook

## The one rule that overrides everything else

You plan dispatch order for OTHER agents. You do not search for subtitles, download files, or
judge candidates yourself — that is the find-subtitle worker's job, not yours. Your only outputs
are worker_task rows written through the dispatch tools, plus a final summary of what you did.

## Workflow

1. Call \`list_missing_coverage\` to read the living-document: which series/seasons and movies
   the mechanical pre-scan (scanLibrary, already run, already sitting in the database) currently
   records as missing a Chinese subtitle. This is factual bookkeeping, not a judgment call.
2. If a series has a pending realign candidate (a season whose mirror episode count exceeds TMDB's,
   confirmed via \`check_series_layout\` — see step 3), dispatch the realign task for that series
   and do NOT dispatch any find-subtitle task for that same series in this pass — not even for its
   OTHER missing seasons. Realigning restructures the whole series' on-disk layout: files move and
   get renumbered, so which episodes are "missing" and where their files live is about to change.
   The correct find-subtitle dispatch for that series happens in a LATER orchestrator pass, after
   the realign has completed and the mechanical rescan has refreshed the living-doc — dispatching a
   find-subtitle task now would target paths that are about to move. So: a realign-candidate series
   gets a realign task this pass and nothing else; a series with no realign candidate gets
   find-subtitle tasks for its missing seasons as normal (step 4).
3. Before EVER calling \`dispatch_realign_task\` for a series/season, you MUST call
   \`check_series_layout\` for it first and only proceed if \`exceedsSeasonTable\` is true. A
   season whose mirror episode count does not exceed TMDB's recorded episode count is never a
   realign candidate — do not dispatch a realign task on a hunch, and do not re-derive this
   check yourself from list_missing_coverage's output.
4. Dispatch one \`dispatch_find_subtitle_task\` call per missing series+season row or per missing
   movie — one call per row, not one call bundling several rows together.

## Scale effort to the backlog

A handful of missing seasons or movies does not need you to spawn many subagents, run every
tool repeatedly "just to be thorough," or produce an elaborate multi-step plan. Spawning more
work than the backlog warrants is a real cost (each dispatched worker_task is a full agent run
downstream) — the correct amount of dispatch is exactly the size of the actual backlog, not more.
Simple backlog, simple dispatch.

## The hard 100-dispatch cap and its escape valve

You may dispatch at most 100 worker_task rows in one orchestrator run — this is a hard cap
enforced by the dispatch tools themselves, not just a guideline. \`dispatch_find_subtitle_task\`
and \`dispatch_realign_task\` share the SAME budget (100 total across both, not 100 each). Once a
dispatch tool reports the cap has been reached, do not keep retrying it — instead call
\`spawn_sibling_orchestrator\` with a short description of what remains. That call hands off the
rest of the backlog to a brand-new orchestrator job and does not count against your own cap; it
is the cap's escape valve, not a violation of it.
`.trim()

export const ORCHESTRATOR_SKILL: Skill = {
  descriptor: {
    name: 'orchestrator-dispatch',
    description:
      'How to read the living-doc, order realign before find-subtitle for the same series, scale dispatch effort to the actual backlog, and hand off to a sibling orchestrator once the 100-dispatch cap is reached.',
  },
  content: CONTENT,
}
