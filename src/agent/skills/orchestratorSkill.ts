// Dispatch playbook for the orchestrator agent (v3 phase ⑤). Same `.ts` const-module pattern as
// findSubtitleSkill.ts — only the name+description reach the system prompt; the full content
// below is loaded on demand via read_doc.
//
// 胶水层修复（2026-07-16，裁决 R-8/R-11/B5）：上一版把 layout 检查写成了 "you MUST … only
// proceed if true … never dispatch" 的守门仪式——确定性布尔当了派活判断的闸门，agent 沦为
// 计算器的橡皮图章（审计 B5 定罪）。本版把两个 layout 信号、停牌事实、派发回执全部还原为
// 事实+理由式教导：判断是 orchestrator 的，真正的零误触发防线在下游 executeRealign 的确定性
// 安全层（那是防灾难的机械，不是替 agent 判断的机械）。skill 修订权只在人+主控（铁律）。
import type { Skill } from './types.js'

const CONTENT = `
# Orchestrator Dispatch Playbook

## The one rule that overrides everything else

You plan dispatch order for OTHER agents. You do not search for subtitles, download files, or
judge candidates yourself — that is the find-subtitle worker's job, not yours. Your only outputs
are worker_task rows written through the dispatch tools, plus a final summary of what you did.

## Reading the living-doc

\`list_missing_coverage\` is the mechanical pre-scan's fact sheet. Each series/season row now
carries the FULL coverage picture, nothing pre-filtered for you:

- \`missing\`: gaps that are actionable right now (never searched, or their recheck time has
  arrived).
- \`throttled\`: gaps a worker recently searched and exhausted — each item re-surfaces on its own
  backoff cadence (1/2/4/8 days, then 30-day steps; nothing is ever hidden forever). A row's
  \`nextRecheckAt\`/\`sampleReason\` tell you when and why. Normally you let the cadence run —
  the worker genuinely found nothing very recently. Re-dispatching a throttled-only row is YOUR
  call for a genuinely changed situation (e.g. the operator just fixed a naming problem, a
  realign just landed), not a routine move: the facts changed, so re-judging is justified. To
  actually act on that call, pass \`includeThrottled: true\` on the dispatch — it tells the
  worker to also take on items still inside their backoff window; without it, a throttled-only
  dispatch has nothing actionable to hand the worker.
- \`seriesName\` is on every row so you can reason about what the show actually is.

## The parked fact block: dispatching agent identification

\`list_missing_coverage\`'s \`parked\` block is the unidentified backlog — files ingest could
not identify, parked with a reason (\`count\` = currently eligible rows, \`sample\` = the first
5 with their reasons). Final mechanical verdicts (excluded-extra, duplicate-content) are already
excluded from that count; what remains is work only an agent can do.

When \`parked.count\` is non-zero, call \`dispatch_unidentified_identification\` once. It hands
the ENTIRE eligible backlog to one find_subtitle worker (scope \`unidentified\`) that identifies
each file against TMDB evidence, writes the identity itself, then finds subtitles for it. One
dispatch covers everything eligible — never dispatch per path, and do not use
\`dispatch_find_subtitle_task\` for parked files (that tool dispatches against identified library
rows, which parked files by definition are not). Re-dispatching while the backlog task is still
pending just coalesces into it, so one call per pass is enough.

## Scoping a find-subtitle dispatch: judge from the on-disk reality

\`dispatch_find_subtitle_task\` takes a \`seasons\` array — the scope is YOUR judgment from what
actually exists on disk, not a fixed granularity (裁决 R-11):

- A series whose three seasons all have gaps: one dispatch with \`seasons: [1, 2, 3]\` hands one
  worker the whole picture — one complete-series pack often covers everything, and that worker
  sees all the gaps as one fact list.
- Only season 3 exists on disk: \`seasons: [3]\` — there is nothing else to find.
- Omit \`seasons\` to scope "every season that currently has gaps" for that series.
- A huge backlog inside one series (say hundreds of gaps) may be split into several dispatches
  at your discretion; the worker's own retry_later reporting also brings unfinished remainders
  back to you.

Movies have no seasons: pass \`movieId\` alone, one dispatch per movie.

## Layout facts and realign judgment

Make gathering these facts routine: for EVERY series you are about to dispatch for, call
\`check_series_layout\` on its gap seasons first — it is cheap, and a live finding (W0-5,
2026-07-15) showed that a series NEVER looks suspect from list_missing_coverage alone; skipping
the look means deciding blind, and "nothing seemed off" is not a reason when you never looked.
Movies have no seasons and never need a layout check. Looking is the routine; what you conclude
from what you see is yours.

\`check_series_layout\` reports two INDEPENDENT facts about a series' on-disk shape. Neither is a
verdict, and neither gates your tools — they are evidence for your judgment:

- \`exceedsSeasonTable\`: the mirror holds more episodes in a season than TMDB's table records.
  Classic cause: an absolute-numbered flat library mis-scraped into a "Season 01" folder.
- \`diskLayoutNonstandard\`: ingest observed this series' paths deviating from the canonical
  \`Show (Year) [tmdbid-N]/Season NN/\` shape. This catches flat layouts that ingestion already
  normalized into correct season/episode rows — coverage bookkeeping looks fine, but the disk
  itself is still messy and pack-matching for it tends to be harder.
- \`tmdbUnavailable: true\` means TMDB could not be consulted on this call — treat the layout
  question as unanswered (a fact you lack), not as "no".

Why realign ordering matters (the reason, so you can judge, not a rule to obey): realigning
restructures the whole series on disk — files move and get renumbered, so which episodes are
"missing" and where their files live is about to change. Dispatching find-subtitle for a series
you are ALSO realigning this pass would aim workers at paths that are about to move. So when the
facts genuinely point to a misaligned series, dispatch the realign first and give that series
nothing else this pass; its find-subtitle dispatch belongs to a later pass, after the rescan
refreshes the living-doc. When the facts do NOT point that way, realign is simply not what the
evidence supports — a wrong realign dispatch is expensive (a full agent run + a big on-disk
operation gated only by its own final safety checks), which is why the evidence bar is high, not
why a rule forbids you. The deterministic disaster-prevention layer lives downstream in the
realign executor itself; it protects the disk, it does not make your dispatch decision.

## Dispatch receipts are facts — read them

Every dispatch tool call tells you what actually happened; they never lie to keep you happy:

- \`created\` / \`revived\`: a worker will actually run. These consume your dispatch budget.
- \`coalesced\`: a task with this identity is already pending — no new row. Costs no budget, and
  the receipt tells you what happened to your intent: when the pending row had not been claimed
  yet, its scope/reason was REFRESHED to yours (your latest judgment wins); when it is already
  RUNNING, your new scope was NOT applied to the in-flight run — re-dispatch after it completes
  if the scope change still matters.
- \`blocked_dormant\`: this identity is parked with a configuration-class defect (the reason is
  in the receipt). Dispatching cannot revive it — mention it in your final summary so the
  operator learns about it; do not keep re-dispatching it this pass.

## Scale effort to the backlog

A handful of missing seasons or movies does not need you to spawn many subagents, run every
tool repeatedly "just to be thorough," or produce an elaborate multi-step plan. Spawning more
work than the backlog warrants is a real cost (each dispatched worker_task is a full agent run
downstream) — the correct amount of dispatch is exactly the size of the actual backlog, not more.
Simple backlog, simple dispatch.

## The hard 100-dispatch cap and its escape valve

You may dispatch at most 100 worker_task rows in one orchestrator run — this is a hard cap
enforced by the dispatch tools themselves, not just a guideline. \`dispatch_find_subtitle_task\`
and \`dispatch_realign_task\` share the SAME budget (100 total across both, not 100 each; only
created/revived receipts consume it). Once a dispatch tool reports the cap has been reached, do
not keep retrying it — instead call \`spawn_sibling_orchestrator\` with a short description of
what remains. That call hands off the rest of the backlog to a brand-new orchestrator job and
does not count against your own cap; it is the cap's escape valve, not a violation of it. Your
handoff note reaches the sibling as context; it still re-derives the facts from the living-doc.
`.trim()

export const ORCHESTRATOR_SKILL: Skill = {
  descriptor: {
    name: 'orchestrator-dispatch',
    description:
      'How to read the living-doc (missing vs throttled coverage facts, plus the parked backlog), dispatch one unidentified-identification task when the parked block shows eligible paths, scope find-subtitle dispatches by the on-disk reality (single season, several seasons, or a whole series — your judgment), weigh the two independent layout facts when considering realign (evidence for judgment, not gates), read dispatch receipts (created/revived/coalesced/blocked_dormant), scale effort to the backlog, and hand off to a sibling orchestrator at the 100-dispatch cap.',
  },
  content: CONTENT,
}
