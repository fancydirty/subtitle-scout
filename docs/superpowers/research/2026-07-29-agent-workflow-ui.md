# Research: UI/UX patterns for visualizing autonomous AI-agent pipelines

Date: 2026-07-29
Scope: how to present subtitle-scout's three-agent pipeline (identify → subtitle-find → translate,
chained through the DB as state machine) to an end user, replacing Bazarr's mechanical per-episode
queue metaphor.

Labels used throughout: **[SOURCED]** = verified from product docs / screenshots / issue threads.
**[INFERENCE]** = my reasoning, not verified. **[UNVERIFIED]** = claim I could not confirm.

## Progress log

- (init) File created with skeleton. No searches run yet.
- (step 9) **COMPLETE.** All synthesis sections written: Executive summary, Recommended metaphor,
  Concrete layout proposal (incl. component fate table + 7 new things required), Rejected alternatives
  (8, each with sourced grounds), Open questions (9). Nothing outstanding; the doc is self-contained.
  Residual gaps are recorded explicitly as "could not verify" in Q1 and as Open question 8.
- (step 8) Search batch 7 done: **Vercel eve "Agent Runs" — Developer mode vs Business mode toggle.
  This is the strongest single citation in the document for the two-rendering thesis: same run data,
  one view humanizes tool names + hides JSON + generates a plain-English summary.** Plus ChatGPT agent
  mode (on-screen narration + interrupt), Lindy task history, Braintrust. Q1 completed.
  Next: synthesis (metaphor, layout, rejected alternatives, open questions).
- (step 7) Search batch 6 done: status-page/empty-state patterns (found the decisive "an empty incident
  log doesn't read as 'perfect uptime', it reads as 'nobody is updating this page'" quote), Temporal vs
  Trigger.dev durability/history models, Inngest run-detail docs. Q4 + Q5 written.
  Next: synthesis sections (metaphor, layout, rejected alternatives, open questions).
- (step 6) Search batch 5 done: **Nielsen (UX Tigers, 2026-07-09) "Progressive Disclosure: From
  Training Wheels to Week-Long AI Agents" — the single most directly applicable source in this doc**,
  plus ~6 trust-calibration / XAI papers. Q3 written. Next: Q4 (live vs history, idle states) + Q5.
- (step 5) Search batch 4 done: GitHub Actions matrix-explosion complaints (2 long-lived community
  threads, 137 upvotes), and **7 real Bazarr issues** = the anti-pattern evidence base. Bazarr #1939 is
  the single best negative source in this doc. Appended to Q2 (anti-patterns) + Q3.
  Next: Q3 trust calibration HCI research, intentional no-ops prior art.
- (step 4) Search batch 3 done: **Dagster asset model — this is the answer to Q2 and probably the
  organizing metaphor for the whole page.** Two decisive sourced quotes found (asset graph ≠ execution
  DAG; "alerts when tasks fail, not when data is out of date"). Appended to Q2.
  Next: GitHub Actions matrix / batch-unit queues, then Bazarr/Sonarr user complaints (Q2 anti-patterns).
- (step 3) Search batch 2 done: Manus ("Manus's Computer" side panel + todo.md), Claude Code /
  Cursor agent panes (4 real GitHub issues = user complaints about collapsed output & non-sticky
  todo list). Appended to Q1 + seeded Q3/Q4 anti-patterns.
  Next: Q2 = Dagster asset model, GitHub Actions matrix, dbt Cloud, batch-unit queues.
- (step 2) Search batch 1 done: Devin UI, LangSmith/LangGraph trace tree. Findings appended to Q1.
  Emerging signal: products ship **two levels** — a narrative/plan view (default) + a technical tree
  (opt-in). Next: Q1 batch 2 = Manus, Lindy, Claude Code/Cursor panes, Operator.
- (step 1) Read own codebase: `web/src/workflow/{Lanes,SummaryLine,PendingLane,ActivityFeed,TraceRows,RunDetail}.tsx`.
  Confirmed inventory of existing components + their data contracts. See "## Existing inventory" below.
  Next: search batch 1 = Q1 agent-product UIs (Devin, Operator, Manus, Lindy, LangSmith/LangGraph, Braintrust, AI Gateway).

## Existing inventory (read from repo, not searched)

**[SOURCED — own repo]**

| Component | File | What it renders | Data source |
|---|---|---|---|
| `Lanes` | `web/src/workflow/Lanes.tsx` | 2-col shell: narrow "Gaps" \| wide "Activity". Mobile → 2 stacked `Collapsible`. Whole-page `EmptyState` when everything empty. | 3 polling hooks @15s (`pending`, `passes`, `workers`), paused when tab hidden |
| `SummaryLine` | `SummaryLine.tsx` | Midday-style sentence w/ inline big numbers: "Watching **N** gaps · **M** episodes installed in the last 24h · **K** translated · **J** agents working". Omits segments whose datasource is null — refuses to fake a `0`. | `pending` + `workers` |
| `PendingLane` | `PendingLane.tsx` | Mechanical fact rows grouped series/movies: `{seriesName} · S{n}` + missing badge + throttled line w/ `nextRecheckAt` + truncated `sampleReason` + hover Rerun (series only; API has no movieId). Plus a `N parked · triage →` link. | `pending` |
| `ActivityFeed` | `ActivityFeed.tsx` | Stacked sections: `QuotaFacts` (neutral dots, not alerts) → `NowWorking` cards (subject = show name: "Searching subtitles for X", live `TraceRows phraseMode`, elapsed) → `Held` (fail-closed translations + retry-in) → `Recent` (folded runs, `decisionPhrase`, ×retries, llmCalls) → `Collapsible "Orchestrator log"` **default closed** holding pass rows + receipt chips. | `workers` + `passes` |
| `TraceRows` | `TraceRows.tsx` | Inngest-style rows: mono tool name + truncated args + right-aligned duration. `phraseMode` renders plain-language phrases instead. | SSE singleton `traceStream.ts` |
| `RunDetail` | `RunDetail.tsx` | Right slide-in panel; discriminated union over `{kind:'worker'|'pass'}`; replay/rerun. | click-through |

Notable existing philosophy already in the code, worth preserving: (a) sentence **subject = the content**
(show name), never the system component; (b) never render a fabricated `0`; (c) failure/wait wording is
**neutral**, not alarming (`StatusDot variant="neutral"` for quota exhaustion + held); (d) technical
receipts exist but are collapsed by default.


## Executive summary

The organizing metaphor should be **a coverage ledger, not a work queue**: the page declares "these
episodes should have subtitles", shows how much of that is satisfied, and treats the three agents as
invisible machinery that materialises coverage — Dagster's software-defined-asset model, which explicitly
separates *the asset graph* ("what should exist") from *the execution DAG* ("what runs"), and which
therefore makes hiding the identify agent a consequence of the right abstraction rather than a
concealment decision. Every agent product surveyed converges on two renderings of one dataset — a
plain-language narrative by default and a technical trace on demand (Vercel eve ships this literally as a
**Business mode / Developer mode** toggle) — and on rendering multi-agent work as **one narrative with the
agent identity as filterable metadata, never as one lane per agent**. The unit of a row must be **one
agent action with a magnitude in its collapsed header** ("installed the S01 pack — covers E01–E24"),
because the most-upvoted unmet request in GitHub Actions' own community is exactly "show one parent job
for matrix jobs rather than bloating the list", and because Bazarr's own issue tracker shows per-episode
queues become meaningless at 30,000 rows while still failing to answer the only question users asked.
Idle is the state that matters most, and it must be expressed as **evidence plus a cadence** — coverage
number, recent completions, last sweep, next sweep — because "an empty log doesn't read as 'perfect
uptime', it reads as 'nobody is updating this page'", and because the single most common Bazarr complaint
is being unable to distinguish *converged* from *stalled*. Concretely: keep and reframe `SummaryLine` and
`ActivityFeed`, retire the whole-page `EmptyState` and the "Gaps" framing, demote `TraceRows` behind a
mode switch rather than a component-named drawer, and add the two things nobody in the prior art gives you
for free but our DB-as-state-machine makes cheap — a persisted reason for every decision including
no-ops, and a visible converged-vs-stalled distinction.

## Q1. How products visualize autonomous agent work

### Devin (Cognition) — "plan first, then a replay timeline"

**[SOURCED]** Devin's session UI is a **split view**: agent reasoning/plan on the left as a chat-like
stream, live artifacts on the right in tabs (**Progress / Planner / Shell / Browser / Editor**).
- Sources: https://www.datacamp.com/tutorial/devin-ai ,
  https://www.scalablepath.com/ai/devin-ai ,
  https://medium.com/@nitinmatani22/your-first-devin-session-a-practical-walkthrough-for-developers-who-havent-tried-it-yet-f4be30695dd5
- The **Planner tab** shows the full numbered step list the agent intends to follow, written *before*
  execution, e.g. `001 check_for_repo() / 002 clone_repository(...) / 003 read_readme() / …`. This is
  a **planning checkpoint** — the user can edit/approve before any side effects.
  (https://www.scalablepath.com/ai/devin-ai)
- Under the numbered list the plan is really a **DAG**, and Devin **re-plans** when something breaks.
  (https://medium.com/@nitinmatani22/how-devin-ai-actually-thinks-autonomous-planning-dag-execution-and-dynamic-re-planning-explained-997be175a475)
- Every command / file diff / browser action is recorded into a **replay timeline** — "you can review
  exactly what it changed, in what order, and why" — an audit trail decoupled from the live view.
  (https://www.deployhq.com/guides/devin ,
  https://medium.com/@nitinmatani22/devins-cloud-sandbox-explained-shell-browser-and-editor-working-as-one-6e001f8c5d3c)

**Transferable:** the *reasoning* lives in a narrative stream; the *evidence* lives in tabs you open
only if you care; and the *intent* (plan) is a separate, stable artifact from the *log* (what happened).
Three distinct surfaces, not one merged log.

**Not transferable:** Devin's plan is per-task and user-initiated. Ours is continuous/ambient with no
human kickoff, so there is no "approve the plan" moment. **[INFERENCE]**

### LangSmith / LangGraph — the developer trace tree, *plus* a human "Messages" view

**[SOURCED]** LangSmith renders an agent run as a **hierarchical span tree** (root agent run → LLM
call → tool run → LLM call …), each node clickable into a right-hand **detail panel** showing exact
inputs/outputs/metrics. `run_type` (`tool`, `llm`, `retriever`, `chain`) drives specialised rendering
per node type.
- https://docs.langchain.com/langsmith/trace-deep-agents
- https://docs.langchain.com/langsmith/trace-with-langgraph
- https://medium.com/@shubham.shardul2019/llm-observability-with-langsmith-log-observations-beyond-just-ui-5d5e4a416b43
  (shows the actual tree shape: `ResearchAgent → LangGraph → router → Route Question → ChatGoogleGenerativeAI`,
  with per-node latency/tokens/cost, and notes that **framework noise is worth collapsing** so only
  "meaningful application-level runs" show — leaf nodes where actual work happens get marked/bolded.)

**The critical find for us:** LangSmith ships a **"Messages" view** alongside the tree, which
"shows a simplified conversation history … represents them in a chat-like format", pulling only
top-level trace content. Same run, two renderings: **semantic narrative by default, span tree on demand.**
(https://docs.langchain.com/langsmith/trace-deep-agents)

That is *exactly* the two-level structure our `ActivityFeed` (plain-language rows) + collapsed
`Orchestrator log` (`TraceRows`) already has. **This is convergent validation of the existing design,
not a reason to redesign.** **[INFERENCE, from sourced facts]**

Also sourced: Deep Agents writes `lc_agent_name` metadata on every run produced by a subagent, so the
UI can **filter a view down to one subagent** and save it as a named view. Multi-agent systems are
presented as *one trace, filterable by which agent produced the span* — not as N separate dashboards.
(https://docs.langchain.com/langsmith/trace-deep-agents) — directly relevant to our Q5.

### Manus — the "over the shoulder" panel + an externalised checklist

**[SOURCED]** Manus's interface is three regions: left rail of sessions, centre chat, and a third panel
called **"Manus's Computer"** which shows the agent's live actions (browser tabs opening, forms filled,
terminal commands) and keeps a **timeline of screenshots** for later replay.
- https://workos.com/blog/introducing-manus-the-general-ai-agent
- https://ssojet.com/blog/what-is-manus-ai-agent-explained
- https://www.revolutioninai.com/2026/04/how-manus-ai-works.html
- https://manus.im/docs/integrations/manus-browser-operator ("Every action Manus takes is meticulously
  logged, providing a clear audit trail.")

**The key architectural detail, and the one most relevant to us:** Manus **externalises its plan to a
file, `todo.md`**, ticking items off as it completes them. The investigation gist notes this doubles as
crash-recovery state: "if the session were paused or context lost, the to-do file serves as a source of
truth for what's done and what's left."
(https://gist.github.com/renschni/4fbc70b31bad8dd57f3370239dccd58f)

**[INFERENCE]** This is *structurally identical to our architecture* — our DB **is** the `todo.md`.
Manus renders that checklist as the primary progress affordance; the streaming action log is secondary.
That is a strong argument that our primary UI object should be **the work bench (declared outstanding
work) rendered as a checklist that drains**, with the action stream as supporting evidence — the inverse
emphasis from a Bazarr queue, which renders the *mechanism* rather than the *outstanding intent*.

**Sourced anti-pattern from the same corpus:** a designer running a Nielsen heuristic eval *of Manus*
found the transparency panel double-edged — "this same panel also shows raw terminal commands, which
could be confusing or intimidating to users who aren't technical. While it adds transparency, it may
also create cognitive overload."
(https://medium.com/design-bootcamp/i-asked-an-manus-ai-to-evaluate-itself-heres-what-happened-69c90a148e80)
The same review's positive note is precise about *why* the panel works: "Watching Manus interact with
real web pages **while narrating its actions** gave me more confidence in the results it produced."
→ **Narration, not raw log, is what builds trust.** Validates our `phraseMode` on `TraceRows`.

### Claude Code / Cursor agent panes — collapsed-by-default, and the complaints that follow

**[SOURCED]** Claude Code collapses tool results by default; the community explicitly endorses this as
"the desired behavior for skim-reading past turns"
(https://github.com/anthropics/claude-code/issues/50313). But the surrounding issues document exactly
what breaks, and each maps onto a decision we have to make:

| Issue | Complaint | Lesson for us |
|---|---|---|
| [#50313](https://github.com/anthropics/claude-code/issues/50313) | No way to expand *one* collapsed tool result in place; only an all-or-nothing global verbose toggle. | Disclosure must be **per-item**, not one global "show technical detail" switch. Our `Collapsible "Orchestrator log"` is a single global toggle — a mild version of the same smell. |
| [#51624](https://github.com/anthropics/claude-code/issues/51624) | Large fan-out results scroll away; asks for accordion sections with a **summary header carrying a count** (`▶ [Flynn — Ingress Design] (47 lines)`). | A collapsed batch must **advertise its magnitude in the header** — "(47 lines)" / "(12 episodes)". A collapsed group with no count is a black box. |
| [#8723](https://github.com/anthropics/claude-code/issues/8723), [#76537](https://github.com/anthropics/claude-code/issues/76537) | The TodoWrite plan scrolls away into history; users want a **sticky/pinned, always-visible plan panel** above the input, updating in real time, with done greyed out and current highlighted. #76537's motivation is verbatim our idle-return case: "I kick off a task … and step away … When I come back, I want to quickly glance at progress." | **Do not put outstanding work in the scrolling stream.** The plan/worklist must be a *pinned region* separate from the feed. Strong evidence for keeping our left Gaps lane as a persistent region rather than folding it into the Activity stream. |
| [Changelog 2.1.210, 2026-07-14](https://www.gradually.ai/en/changelogs/claude-code/) | "Added a **live elapsed-time counter to the collapsed tool summary line** so long-running tool calls visibly tick instead of looking stuck." | A collapsed long-running item must show **motion**, or users read collapsed as hung. Directly applicable to our slow translate agent. |

**[SOURCED]** Cursor's Claude Code extension is characterised as designed around reviewability:
"Plan mode, checkpoints, and the separate panel are all there because the hardest part of using an
autonomous coding agent is not asking it to do something. **It is reading what it actually did.**"
(https://www.datacamp.com/tutorial/claude-code-in-cursor)

### Vercel "Agent Runs" (eve) — an explicit two-audience toggle over one dataset **[SOURCED]**

This is the most direct confirmation of the central thesis found anywhere, and it is a shipped feature
documented by the vendor (June 2026):

> "**Developer mode** shows raw tool names, input and output JSON, and per-step token counts for engineers
> debugging a failure. **Business mode humanizes tool names, hides JSON, and generates a plain-English
> summary so a non-technical reviewer can audit what an agent did.**"
> — https://vercel.com/changelog/eve-agent-observability

The same product's structure (https://vercel.com/docs/eve/observability):
- **Overview**: "Runs over time, broken down by trigger"; token usage split input/output/cached; then
  "**a table of runs** with the triggering message, trigger type, tokens in and out, turn count, duration,
  and time."
- **Run detail**: "model, trigger, and deployment, then a **per-turn breakdown** with: Timings for each
  step in the turn, including skill loads and individual tool calls. Input and Output for the turn.
  **Reasoning the model produced along the way.**"
- Failure correlation is called out as the point: "Runtime errors that **previously vanished into function
  logs** now correlate to the failing step." (changelog)

**[INFERENCE]** Two things to steal. (1) The **mode toggle** is a cleaner solution to the disclosure
problem than a single collapsed "Orchestrator log" drawer, and it dodges Claude Code #50313's
all-or-nothing complaint by making the *whole view* switch register rather than forcing per-item
expansion. It also gives the technical content a home without ever putting it on the default path.
(2) "Runtime errors that previously vanished into function logs now correlate to the failing step" is
precisely the Bazarr #1939 disease, named by a vendor as the problem their product exists to fix.

### ChatGPT agent mode — narration + interruptibility **[SOURCED]**

> "As it performs your task, **an on-screen narration provides visibility into exactly what ChatGPT is
> doing. You can interrupt and take control of the browser whenever needed**, ensuring tasks remain
> aligned with your goals." — https://openai.com/index/introducing-chatgpt-agent/

**[INFERENCE]** Narration + an interrupt affordance, as a pair. The interrupt is what converts watching
into supervising. Our equivalent of "take control" for a slow translate run would be a **stop/skip** on
the in-flight item — worth noting we may not have one.

### Lindy — per-task history as the audit unit **[SOURCED]**

Founder walkthrough describing the UI: "when I look at the **task history** of this Lindy, it's really
simple. It's like, okay, you do this and boom, appending this row to this spreadsheet. **And this is the
information extracted.**" (https://www.latent.space/p/lindy)
**[INFERENCE]** The unit is one triggered task, and the payload shown is *the extracted values* — the
semantic result — not the mechanism. Consistent with everything else here. **Could not verify** Lindy's
current UI from primary docs/screenshots; this is a 2024 interview transcript.

### Braintrust — trace parity between eval and production **[SOURCED]**

"Braintrust's traces are **consistent across both offline eval runs and production logging**, so you can
debug issues **in the same UI where you tested your fixes**."
(https://www.braintrust.dev/articles/best-ai-observability-tools-2026 — vendor source, treat as
positioning). On multi-agent handoffs Braintrust advocates parent-child span propagation producing
"**a single trace** that shows the planning agent, the handoff payload, the sub-agent's tool calls, and the
final response **in one view**." (https://www.braintrust.dev/articles/agent-observability-complete-guide-2026)
**[INFERENCE]** Again: multi-agent → one trace, not N dashboards. Third independent instance of this
convention (with LangSmith and eve). For us: a single episode's story should read as one continuous
narrative even though three different agents contributed to it.

**Could not verify** from primary sources within this session: OpenAI Operator's specific UI chrome
(as distinct from ChatGPT agent mode), Zapier Central / AI Actions' current run-history UI (product has
been repositioned; I found no authoritative current screenshots), Temporal UI's specific event-history
screen layout (only the architectural comparison via Trigger.dev), and Inngest AgentKit's dedicated UI
(as opposed to Inngest's general function-run UI, which I did verify). Treat any claim about those four as
unverified.

### Recurring conventions across Q1 products (the convergence signal)

**[INFERENCE, aggregated from the sourced items above]**

1. **Two renderings of one run.** Narrative/semantic by default (Devin's chat+Planner, LangSmith
   "Messages", Manus's narrated actions) + technical span tree on demand (LangSmith trace tree, Devin's
   Shell tab, Manus's terminal). Nobody ships only one.
2. **The plan/worklist is a separate, persistent artifact from the log.** Devin's Planner tab, Manus's
   `todo.md`, Claude Code's TodoWrite — and the loudest Claude Code UI complaints are precisely about
   that artifact *not* being pinned.
3. **Replay is a first-class, distinct mode.** Devin's replay timeline, Manus's rollback-the-timeline.
   Live-watching and after-the-fact auditing are different jobs. (→ Q4)
4. **Narration beats logging for trust.** Every product that is praised for transparency narrates in
   plain language; every complaint about cognitive overload targets the raw log. Vercel productises this
   as an explicit **Business mode vs Developer mode** switch over identical data.
5. **Collapsed things must carry a count and a heartbeat.** Otherwise collapsed reads as hidden, and
   slow reads as stuck.
6. **Multi-agent systems render as ONE narrative, with the agent identity as filterable metadata**
   (LangSmith `lc_agent_name`; Braintrust parent-child span propagation "in one view"; eve's per-turn
   breakdown). **Not one lane per agent.** Three independent instances — this is the strongest
   convergence in the whole survey, and it is the direct answer to Q5.
7. **The list/detail split, not the live/history split.** Inngest, eve, LangSmith and Manus all present a
   reverse-chronological list of runs plus a detail view; none of them ship a separate "live" page.

## Q2. The "pending list" problem for semantic batch work

### Dagster's asset model — the strongest analogue found. **[SOURCED]**

The hypothesis in the brief is correct, and Dagster's own framing is almost verbatim our situation.

**1. Declare the desired end state; the system figures out execution.**
> "Software-defined assets are defined by writing code that describes **the asset you want to exist**,
> its upstream dependencies, and a function that can be run to compute the contents of the asset. This
> approach allows you to focus on **the assets themselves — the end products** — rather than the
> execution of tasks."
> — https://dagster.io/glossary/software-defined-assets

> "Instead of describing the chaos that exists, SDA **declares the order you want to create**. Once
> you've declared this order you want to create, an asset-based orchestrator helps you materialize and
> maintain it." — Sandy Ryza, Dagster lead engineer, quoted at
> https://atlan.com/dagster-data-orchestration/

Ours: *"this episode should have a Chinese subtitle"* is the asset. The three agents are the
materialization mechanism. **The user's mental model should be the asset, not the mechanism.**

**2. The decisive distinction: the asset graph is NOT the execution DAG.**
> "A crucial element of Dagster's software-defined assets approach is that **the graph of data assets is
> different from the execution DAGs** that show up in systems like Airflow. Execution DAGs track
> execution dependencies: do task Y after task X. The data asset graph tracks **data** dependencies:
> data asset Y is derived from data asset X."
> — https://medium.com/@dagster-io/declarative-scheduling-for-data-assets-a-breakthrough-in-data-orchestration-85bd5fa6d707

**[INFERENCE — and I think this is the single most important finding in this document]** This resolves
the owner's Q5 anxiety about hiding the identify agent *at the level of principle, not as a UI trick*.
If the page is organised around the **asset graph** ("what should exist / does it exist / how fresh is
it"), then the identify agent is simply not a node in that graph — it is execution machinery. Hiding it
isn't a concealment decision requiring justification; it's a consequence of choosing the right
abstraction. Bazarr's per-episode queue is an *execution DAG view*. Ours should be an *asset view*.

**3. Failure semantics: alert on unmet intent, not on failed attempts.**
> "Imperative, workflow-based orchestrators send **alerts when tasks fail, not when data is out of
> date**, which is often what stakeholders actually care about. **If the system can retry and
> self-correct before the deadline, then waking someone up on PagerDuty is a waste.**"
> — same source as above

This is direct, external, principled justification for a design instinct already present in our code
(neutral `StatusDot` for quota exhaustion / held / throttled). A failed provider search is not an event
worth the user's attention; an episode that has been *un-subtitled past its acceptable window* is.
**[INFERENCE]** → we should introduce something like a per-item **freshness/patience window** and only
escalate visually when the window is blown, not when an attempt fails.

**4. Health rollup as the primary at-a-glance object.**
**[SOURCED]** Dagster+ computes, per asset, a **single health status** combining the most recent
materialization, freshness, and asset checks. It "appears on the home page, throughout the asset
catalog, and in the asset lineage view, and can be used to **group and filter** your assets."
- https://docs.dagster.io/guides/observe/asset-health-status
- https://dagster.io/blog/introducing-the-new-dagster-plus-ui : "Every asset is tagged with a health
  indicator that doubles as a quick report card. **Hover over it to get detailed diagnostics.** … In the
  catalog, you can quickly filter and group by health status, making it simple to focus on what needs
  attention right now."
- Freshness policies exist precisely "so it's obvious when something is out of date"; Dagster
  "continuously evaluates each asset's materialization events, quality checks, and freshness policies to
  calculate its overall health, **so you can see potential problems before they affect downstream work**".
- Dagster 1.1 redesigned the asset graph "to make better use of **color** to communicate asset health.
  New status indicators make it easy to spot **missing and stale** assets (even on large graphs!) and the
  UI updates in real-time as displayed assets are materialized."
  (https://dagster.io/blog/dagster-1-1-thank-u-next)

Note the hover-for-diagnostics pattern: **status glyph as the default, reasoning on hover** — a direct
answer to Q3's "right level of detail" question, from a shipped product.

**5. User testimony that freshness-as-observability is the load-bearing feature.**
**[SOURCED]** In the Freshness-Policy→Freshness-Checks migration discussion, a user argues against
demoting freshness to a "check":
> "Freshness based observability … has been a big component of the benefit of Dagster's UI **for our
> stakeholders**. Without seeing the freshness status at a glance … it would be a big downgrade. …
> I would request that the big picture view of **freshness as a promise made by the asset** be
> maintained. … **Checks on data quality are secondary to the data being there or not.**"
> — https://github.com/dagster-io/dagster/discussions/21343

**[INFERENCE]** Translated: *coverage* ("does this episode have a subtitle, and is that still true")
outranks *quality of the individual run*. Our top-level object should be coverage-of-the-library, and
run receipts should be secondary — which is what `SummaryLine` already gestures at, but the left lane
currently frames as "Gaps" (a deficit framing) rather than "coverage/health".

### Batch-as-unit-of-work: how CI UIs handle it (and fail at it) **[SOURCED]**

The GitHub Actions matrix is the closest mainstream analogue to "one action satisfies N items", and the
verdict from users is unambiguous: **N flat rows is the wrong presentation, and everyone asks for a
single parent row with a rollup.**

- **[SOURCED]** [community/discussions#26246 "Hide/Group jobs in the status checks list"](https://github.com/orgs/community/discussions/26246)
  — 137 upvotes, 40 replies, open from Apr 2021 through at least Oct 2025. The asks, verbatim:
  - "there are only **5 main 'checks' we want to keep track of** … However, because of the parallel tests
    you would not be able to see everything **at a quick glance**."
  - "it would make more sense to **show one parent job for matrix jobs** in the Checks section rather than
    bloating it up with all the parallel jobs as there can be many."
  - "the number of various actions in the check window makes it **borderline unusable apart from
    'everything ok' and 'something failed'**."
  - "This is a job whose sole purpose is to determine if some other jobs should be run. **It never fails,
    and just creates noise** by including it in the Progress Checks list."
  - Accepted-ish resolution: "**Collapsed by default actually sounds like a good idea!**"
  - GitHub's own answer at the time: "Each job is going to show up as a check … You can click 'Hide All
    Checks' to collapse it down, but that is about the best I can think of." (i.e. only a global toggle —
    the same anti-pattern as Claude Code #50313.)
- **[SOURCED]** [ansible/team-devtools#5 "matrix explosion"](https://github.com/ansible/team-devtools/issues/5):
  "I do remember seeing at some point >100 jobs running, **it was insane to scroll over them to find
  which one failed**. As a thumb rule, I think that we should aim to limit them to what can be displayed
  in a **single screen, about 15 jobs**." The author explicitly prefers *chaining* many dimensions into
  one job — accepting reduced granularity — because "I find this inconvenience as being lesser than the
  improvement of **displaying only ~13 jobs in UI instead of 40-50**."
- **[SOURCED]** [StackOverflow 75318609](https://stackoverflow.com/questions/75318609/matrix-strategy-over-entire-workflow-in-github-actions):
  reusable-workflow matrices render sub-jobs **in alphabetical order, not execution order**, "so you lose
  the sense of the dependencies between the jobs" — users resort to naming jobs `1. First Job`,
  `2. Second Job`. **Lesson: order in a fan-out list must be meaningful or the list is worse than useless.**

**[INFERENCE] Direct design consequences for us:**
1. **One row per *action*, not per *item satisfied*.** "Installed the S01 pack from assrt — covers
   E01–E24" is ONE row with a count, expandable to 24. This is precisely GitHub's most-requested missing
   feature, and we get it for free because our agent genuinely acts in batches.
2. **The rollup must state magnitude in the collapsed header** (`(47 lines)` / `covers E01–E24`), per
   both this thread and Claude Code #51624.
3. **A stage "whose sole purpose is to determine if other work should run" and which "never fails" is
   pure noise.** That is a verbatim description of our identify agent and our filter step. Direct
   sourced support for the owner's instinct to hide the identify agent (→ Q5).
4. **Cap the visible list at roughly one screen** and roll the rest up. ~15 rows is the number an
   experienced practitioner landed on independently.

### Anti-patterns: what actually goes wrong in Bazarr's queue UI **[SOURCED]**

This is the strongest negative evidence in the document, and it is all from Bazarr's own issue tracker.
Note that almost none of these are "the rows are ugly" — they are all **"the system did nothing and told
me nothing about why."** The mechanical row UI is not the disease; the absence of *stated reasons* is.

- **[SOURCED] The canonical complaint — [bazarr#1939](https://github.com/morpheus65535/bazarr/issues/1939)**
  (all-caps in the original):
  > "**THERE IS ABSOLUTELY ZERO USER-FACING INDICATION OF A PROBLEM.** Seriously!? It just says it's doing
  > the thing, ZERO related information provided in the logs, no feedback in any of the status pages, the
  > Providers page which is INTENDED TO LIST ISSUES WITH PROVIDERS says 'good'. GOOD."
  > … "Bazarr runs scheduled tasks, they take as long as they should(?), with Download tasks **seemingly
  > doing nothing, with no indication as to why, but all tasks claiming to complete successfully**."
  > … "The actual core of the problem … is a message that could have triggered a flag on the Providers
  > list, 'Skipping discarded provider opensubtitles' — **WHY was it discarded?** I can't just read the
  > log - it's not IN the log. I'm NOT going to enable Debug logging and restart the service hoping to
  > fish for an answer, it took literally a handful of seconds to write 500K in logs mid-run."
  > Also: "Within six or so seconds I had **50 pages of data to sift through**, triple-spaced, 50 entries
  > at a time, with as few as two actual words per entry."

  **Three separate failures, each an explicit design requirement for us:**
  (a) green-looking success that concealed a total no-op → **a run that did nothing must say so, and say
  why**; (b) the reason existed but only at DEBUG level and required a restart to obtain → **the reason
  must be captured at decision time and persisted, always, not gated behind a log level**; (c) when the
  log was available it was unusably voluminous → **volume is not transparency.**
  Our architecture already avoids (b) — decision phrases are persisted rows in the DB, not log lines.
  **That is our single biggest structural advantage over Bazarr and the UI should be built to spend it.**

- **[SOURCED] Scale makes the mechanical list meaningless.**
  [#2041](https://github.com/morpheus65535/bazarr/issues/2041) "Wanted ~4,000 series, 600 Movies";
  [#732](https://github.com/morpheus65535/bazarr/issues/732) "> 30.000 missing episodes and 3700 missing
  movies", where the user's actual, unanswerable question was about *the absence of activity*: "he just
  does not start to search. For series he often will start downloading a show's subtitle. But then for
  multiple hours nothing. There are times that it won't download a thing for 6 hours."
  **[INFERENCE]** At 30,000 rows the per-episode list conveys nothing a single number wouldn't, while
  actively hiding the only thing the user wanted to know: *is it working, and if not, why not.* This is
  the empirical case against per-row queues at library scale, and it also means **our idle/quiet state
  must positively distinguish "converged" from "stalled"** (→ Q4) — the #1 unanswered Bazarr question.

- **[SOURCED] Intentional no-ops read as bugs when unexplained.**
  [#2599](https://github.com/morpheus65535/bazarr/issues/2599) "Search button on a series **does nothing**
  if it has embedded subtitles even though settings is set to extract them … Click search button … 
  **Nothing happens**." The user filed a bug because a *correct* skip was rendered as silence.
  **[INFERENCE]** This is exactly our filter step (embedded subs / already covered / origin-language).
  Bazarr proves that if we render these as "nothing happened", users will read it as broken. They must be
  rendered as **stated, affirmative outcomes** (→ Q3).

- **[SOURCED] Users want the *rejection reasoning*, and Bazarr's score-based version doesn't satisfy.**
  [#1977](https://github.com/morpheus65535/bazarr/issues/1977): "it does find a high matching value …
  albeit with **some reasons for disqualifying**"; [#1675](https://github.com/morpheus65535/bazarr/issues/1675)
  "even if the release_group is there **it doesn't show like it meets the release_group criteria**";
  [#3170](https://github.com/morpheus65535/bazarr/issues/3170) (Feb 2026) "Very bad at matching subtitles
  for series … a subtitle **does exist** … Where it is not badly named or anything as well."
  **[INFERENCE]** Bazarr *does* surface per-candidate match reasons in its interactive-search modal — and
  it still fails, because a numeric score with checkbox criteria explains the *mechanism* but not the
  *judgment*. Our agent's advantage is that it can say "structural signals match a ~24min anime episode",
  which is a claim a human can agree or disagree with. **Score → argument is the upgrade.**

**Could not verify:** I did not find a Bazarr/Sonarr issue complaining specifically that the per-episode
row layout is *too noisy* as a layout. The complaints are about missing reasons, silent no-ops, and
scale. **[INFERENCE]** So the argument against Bazarr's per-row queue should be made on the grounds of
*wrong unit of work + no room for reasons*, not on the grounds of visual noise. That is a more honest and
more defensible framing than "it looks mechanical".

**Caveat / where Dagster does NOT transfer. [INFERENCE]** Dagster's asset graph is a *lineage* graph —
its visual payoff is upstream/downstream dependency. Our assets are ~flat and numerous (thousands of
episodes) with no interesting lineage between them; only a shallow grouping (series → season → episode).
So **borrow Dagster's declarative + health-rollup semantics, do NOT borrow the node-link graph
visualisation.** A node-link graph of 4,000 episodes is noise. The right visual for a flat, huge,
grouped asset set is a **grouped/rolled-up list or coverage grid**, not a DAG.

## Q3. Surfacing judgment/reasoning without overwhelming

### The best source found: Nielsen on progressive disclosure for long-running agents **[SOURCED]**

Jakob Nielsen, "Progressive Disclosure: From Training Wheels to Week-Long AI Agents" (2026-07-09):
- https://www.uxtigers.com/post/progressive-disclosure
- mirror: https://jakobnielsenphd.substack.com/p/progressive-disclosure

This article was published three weeks ago and is about *exactly* our problem. Load-bearing quotes:

> "Agentic AI raises the stakes, because agents **act on the world** rather than merely describing it. …
> nobody reviews a coworker by watching every keystroke; **you review deliverables and spot-check the
> process.** … **Level 1 is the outcome** plus any decision-critical action awaiting approval …
> **Level 2 is the full step-by-step trace. The activity log is the Advanced Settings drawer of agentic
> AI.** An agent that narrates all 60 of its tool calls is as unusable as a settings screen with 60
> toggles; **an agent that hides the ledger entirely is untrustworthy.** Show the destination on the
> bench, and keep the itinerary in the drawer, 1 click away."

> "For a 10-second task, progressive disclosure divides **space**: bench versus drawer. For a **10-hour
> task, it must divide time**: what interrupts you now versus what waits for you."

> Guideline, verbatim: "**Make long-running agents disclose by exception. Interrupt only for
> decision-critical events, digest the milestones, report progress as conceptual breadcrumbs, and keep
> the full activity ledger 1 click away.**"

> "Layer AI answers. **Verdict first, in 1 short paragraph; reasoning, sources, and detail behind
> disclosure controls.** Label partial or preliminary output as exactly that." … "level 1 should be the
> verdict plus the **3 strongest reasons**, while the … methodology and the confidence caveats belong 1
> tap deeper. **The same goes for uncertainty: surface the answer, and disclose the error bars on
> request.**" … "**Do not make people scroll past your homework to find your conclusion.**"

> "**Never hide decision-critical information.** Price, requirements, risks, and privacy terms stay on
> level 1, before commitment. For AI agents, that means a **run contract before the run** … ETA window,
> cost cap, what the agent won't do." Example given: "a 6–10 hour window, a $220 cost cap, and a promise
> never to email an actual customer."

> Reported usage split for a well-layered design: "**80% of tasks land on level 1, 20% on level 2**."

> On the split being the whole game: "Test both audiences. 5 novices should complete level-1 tasks
> unaided; 5 experts should reach level 2 in seconds. A design that aces one test and flunks the other
> **has merely relocated the pain.**"

**Direct consequences for us. [INFERENCE from sourced guidelines]**
1. Our translation agent is *the* case for a **run contract**: it is slow, costs money, and is opt-in.
   Nielsen says cost caps and "what the agent won't do" are level-1, pre-commitment information — not
   settings-page fine print. Our settings toggle should state the contract at the toggle.
2. "**Disclose by exception**" is the governing rule for the quiet system: the feed should carry
   milestones and exceptions, not every attempt.
3. "Verdict + 3 strongest reasons" is the exact shape of a good row for us:
   *"Installed the S01 pack from assrt — covers E01–E24"* (verdict) + up to three reasons on expand.
4. NN/G's own caution applies: "you must **disclose everything users frequently need up front** and keep
   the primary list small enough to maintain focus; otherwise … **you simply relocate complexity rather
   than reduce it**" (https://www.nngroup.com/articles/progressive-disclosure/ , summarised at
   https://bytebridge.medium.com/progressive-disclosure-for-mcps-12b327844be7). The "wrong split" is the
   main failure mode, not too much hiding per se.

**[SOURCED]** NN/G also distinguishes **progressive** (hierarchical: core vs secondary; most users never
leave level 1) from **staged** disclosure (linear: step-by-step, everyone traverses all steps)
(https://www.nngroup.com/articles/progressive-disclosure/). **[INFERENCE]** Our three-agent pipeline is
tempting to render as *staged* (agent 1 → 2 → 3), but the user is not traversing a sequence — so the
correct pattern is **progressive**, and a stage-stepper visual would be a category error. This is
another independent argument against a pipeline-lane layout.

**[SOURCED]** Labelling matters: "Keep the toggle label **concrete** ('Advanced routing rules') rather
than abstract ('More')"; NN/g "explicitly calls out labeling and **information scent** as a key success
factor: users must understand what they'll get when they go deeper."
(https://bytebridge.medium.com/progressive-disclosure-for-mcps-12b327844be7)
**[INFERENCE]** Our current trigger label "Orchestrator log" is a *system-component* name — it scores
poorly on information scent and violates our own rule that the subject should be content, not machinery.
Something like "Show what it checked" or "Search receipts" carries scent; "Orchestrator log" does not.

### Presenting intentional no-ops (skipped-with-reason)

I could not find a canonical named UX pattern for "intentional no-op". What I did find:

- **[SOURCED]** The GitHub Actions thread names the problem exactly: a gating job "whose sole purpose is
  to determine if some other jobs should be run. **It never fails, and just creates noise** by including
  it in the Progress Checks list." (https://github.com/orgs/community/discussions/26246)
  → **[INFERENCE]** No-ops belong in an *aggregate*, not as peer rows to real work. "312 items needed
  nothing (embedded subs 190 · already covered 108 · origin-language 14)" is one line, expandable.
- **[SOURCED]** Bazarr #2599 proves the failure mode of the alternative (silence):
  a correct skip due to embedded subtitles produced "Nothing happens", and the user filed it as a bug.
  (https://github.com/morpheus65535/bazarr/issues/2599)
- **[SOURCED]** Academic work summarised in the MCP-disclosure piece: "**hiding low-level errors can
  cause users to overestimate system capability**, while exposing every low-level feature can trigger
  perception that the system is 'wrong'." The recommendation is on-demand, occasioned explanation:
  "explanation is best 'occasioned' — provided **when the user requests it or when something anomalous
  happens**." (https://bytebridge.medium.com/progressive-disclosure-for-mcps-12b327844be7 , citing
  Springer & Whittaker)
  → **[INFERENCE]** Both directions have a cost, so the resolution is *aggregate + count + expandable*:
  visible enough that the user knows filtering happened and at what scale, quiet enough that it doesn't
  compete with real outcomes. And crucially: **skips must be counted in the "handled" total, not in a
  "failed" or "pending" total.** Positive framing follows from correct accounting, not from euphemism.

### Trust calibration — what the HCI literature actually supports

The literature is more equivocal than the popular framing, and the caveats matter for us.

- **[SOURCED] Goal is calibration, not maximisation.** "Optimal collaboration occurs **not at maximum
  trust but at calibrated trust**, where confidence in AI capabilities aligns accurately with actual
  system reliability" (Lee & See 2004, "Trust in automation: Designing for appropriate reliance",
  doi:10.1518/00187204774810708 — as cited in
  https://cerebratech.ai/calibrating-trust-finding-the-right-balance-in-human-ai-reliance/).
  Trust calibration = "the extent to which the trust that users place in the system is adequate to the
  system's actual capabilities" (Wischnewski et al. 2023, cited in
  https://www.frontiersin.org/journals/computer-science/articles/10.3389/fcomp.2023.1151150/full).
- **[SOURCED] Transparency about *reasoning* does measurably improve accuracy of use.** Tatasciore &
  Loft, *Int. J. Human–Computer Interaction* (2025), doi:10.1080/10447318.2025.2487861:
  "**Higher transparency benefited automation use accuracy, decision time, perceived workload, trust, and
  usability.**" But with two important negatives: "there were **no benefits to correct rejection rates,
  and there was a bias towards agreeing with advice** with increased transparency"; and separately
  "**Trust calibration feedback had no benefit** on automation use accuracy."
- **[SOURCED] Continuous > cumulative feedback.** "a better calibration of trust … can be achieved by
  providing more of the right kind of transparency: not just cumulative performance feedback (delivered
  at the end of a task session), but **continuous performance feedback that allows the user to maintain a
  better picture of the system's relative superiority in real time**."
  (https://pmc.ncbi.nlm.nih.gov/articles/PMC9023880/ — "How transparency modulates trust in AI")
  → **[INFERENCE]** Argues for a persistent visible track record ("N installed in the last 24h", per-run
  outcomes retained) rather than only a momentary live view. Our `SummaryLine` is already this.
- **[SOURCED] Explanations can backfire.** "while most studies find explanations enhance trust, a
  significant minority report **decreased** trust when explanations are overly complex, incoherent or
  reveal reasoning that contradicts user expectations. … **The explanation that confuses or alarms can be
  worse than no explanation at all.**" (https://www.tandfonline.com/doi/full/10.1080/0144929X.2026.2662402)
  Also: "Many popular explanation techniques **fail to improve calibrated trust when users have little
  domain expertise**, particularly when explanations are overly complex or fail to match users' mental
  models" (Wang & Yin 2021, cited ibid.).
  → **[INFERENCE]** Our reasons must be phrased in the *user's* domain (episodes, seasons, languages,
  runtime), never the system's (provider IDs, scores, thresholds, tool names). A reason like "structural
  signals match a ~24min anime episode" passes; "score 87 ≥ threshold 80" fails — it explains mechanism,
  contradicts nothing, and gives the user nothing to agree or disagree with.
- **[SOURCED] Explanations can *increase* overreliance by reducing friction.** "in agentic systems,
  **confident explanations can sometimes increase overreliance precisely because they reduce
  uncertainty, friction, and critical reflection**"; and (citing Buçinca et al.) "**reducing cognitive
  effort too aggressively may increase overreliance**". The proposed alternative emphasis is
  **interrogability** — "the ability for humans to **inspect, challenge, refine**, and contextualize
  system reasoning dynamically" — and systems that "help people understand **the boundaries of
  confidence**, recognize ambiguity, compare alternatives, and know when intervention is necessary."
  (https://www.designative.info/2026/05/21/trust-calibration-in-agentic-ai-designing-for-appropriate-reliance-not-blind-trust/)
  → **[INFERENCE]** Do not write reasons in a uniformly confident register. When the agent's own
  confidence was low, the row should say so, and the affordance next to it should be a *challenge* action
  ("wrong subtitle? re-search / show the candidates it rejected"), not merely "view details". We already
  have Rerun; the missing piece is **showing rejected candidates**, which is what makes a judgment
  contestable rather than merely narrated.
- **[SOURCED] Tiered disclosure by risk is an explicit recommendation.** "We advocate **tiered
  disclosure**: in high-risk domains … require co-presentation of uncertainty, calibration, and
  traceability; **in lower-risk domains, use lighter information burdens.**"
  (https://pmc.ncbi.nlm.nih.gov/articles/PMC12562135/)
  → **[INFERENCE]** Subtitle-scout is low-stakes (a wrong subtitle is annoying, not harmful) — **except**
  for the translation agent, which spends real money. Disclosure depth should not be uniform across the
  three agents: search/install rows can be terse; translation rows warrant cost, duration and
  source-track provenance up front. This is a principled reason to treat translate differently in the UI
  *without* giving it its own lane.
- **[SOURCED] Both failure directions are real and named:** automation bias / overreliance ("misuse") and
  algorithm aversion / under-reliance ("disuse") — Parasuraman & Riley 1997, and "Algorithm aversion:
  People erroneously avoid algorithms after seeing them err" (doi:10.1037/xge0000033), both cited at
  https://cerebratech.ai/calibrating-trust-finding-the-right-balance-in-human-ai-reliance/ .
  → **[INFERENCE]** Algorithm aversion is our realistic risk: one visibly wrong subtitle install could
  make the owner distrust the whole agent. Mitigation is a **visible, honest track record** plus an easy
  correction path — so a single error reads as a known rate, not as a revelation.

**Honest caveat [INFERENCE]:** none of these studies are about ambient media-library automation; they are
mostly UAV supervision, clinical decision support, and MTurk pricing tasks. The transferable findings are
the *directional* ones (calibration over maximisation; reasoning-transparency helps use accuracy;
explanations must match the user's domain; watch for reduced-friction overreliance). I would not import
any effect size.

## Q4. Live-vs-history, and idle state

### Do products split live and history, or unify them?

**[SOURCED] They mostly unify into one reverse-chronological run list, with a separate *detail* view per
run** — the split is not live-vs-history, it's **list vs detail**.

- **Inngest**: a run list; "Clicking on the failed Function Runs **expands the run detail view**", which is
  "divided in 3 parts": trigger details, run details with **timeline**, and step expansion. Steps expand
  to show error message, timings and **retry history**. Actions on the detail: **Replay / Rerun**, or send
  the trigger event to a local dev server to reproduce.
  (https://www.inngest.com/docs/platform/monitor/inspecting-function-runs)
  → **[INFERENCE]** Our `RunDetail` slide-in + `TraceRows` + `RerunDialog` is already an accurate copy of
  this shape. Keep it. The one thing Inngest has that we should check we have is **retry grouping inside
  the step** ("the same error during the following 5 retries") — our `collapseRecentRuns` + `×N` badge is
  the equivalent at list level, but per-step retry detail may be missing.
- **Temporal vs Trigger.dev** — two different philosophies of "history", sourced from Trigger.dev's own
  comparison page (biased source, but the technical claims are checkable and uncontroversial):
  "Temporal's **event history provides a replayable record of every workflow execution** … Trigger.dev
  provides OpenTelemetry tracing, a dashboard with **trace viewer, run filtering, and custom views**.
  Both have web dashboards for monitoring runs." Temporal = event-sourcing + deterministic replay;
  Trigger.dev = checkpoint-resume, "the tradeoff is **losing the replayable event history**."
  (https://trigger.dev/vs/temporal)
  → **[INFERENCE]** We are architecturally in Temporal's camp *by accident and for free*: because the DB
  is the state machine, our history is durable rows, not ephemeral log lines. This is worth exploiting —
  we can honestly offer "show me exactly what it did and why" for any past decision, which is the thing
  Bazarr users could not get (#1939). **Our differentiator is retrospective explainability, not live
  streaming.** Live streaming is the flashier feature but serves the rarer moment (the system is idle most
  of the time; the user is rarely watching during the 40 seconds an agent runs).

**Tradeoffs at low activity. [INFERENCE]** A dedicated "live tail" region is a bad bet for a system that
is idle most of the time: it is empty on nearly every page load, and an empty region that is *sometimes*
the most important region trains the user to ignore it. Better: **one activity stream where the in-flight
item is simply the top row, visually distinguished** (live dot + ticking elapsed) rather than a separate
"Now working" *section* that is empty most visits. Note this is a change from our current
`NowWorkingSection`, which renders a heading + "nothing running" text — i.e. it spends vertical space and
a heading on emptiness on most page loads.

Support for the "ticking" requirement: Claude Code shipped "a **live elapsed-time counter** to the
collapsed tool summary line so long-running tool calls **visibly tick instead of looking stuck**"
(https://www.gradually.ai/en/changelogs/claude-code/, 2.1.210, 2026-07-14). **[SOURCED]**

### Idle-state design — the most important section for us

**[SOURCED] The single best quote found, from status-page design practice:**
> "A status page that shows **90 days of data, including a few incidents with clear resolutions, is more
> credible than a page with no history at all. An empty incident log doesn't read as 'perfect uptime.'
> It reads as '**nobody is updating this page**.'"
> — https://www.pttrns.com/status-page-design-patterns-how-the-best-saas-companies-communicate-downtime/

The same source names the anti-pattern precisely: bad status pages "show a single green banner reading
'All Systems Operational', **offer no history**, and go silent during the exact moments users need them
most."

**[INFERENCE] This is the answer to the owner's idle-state problem, and it is the opposite of what a naive
`EmptyState` component does.** Our current `Lanes.tsx` renders a whole-page `EmptyState` ("No active
work") when everything is empty. That is the "single green banner with no history" anti-pattern. **Idle
should be expressed as recent evidence of work, not as an absence of work.** Convergence is a *result*,
and results are shown by history.

Also sourced, from PagerDuty's status-page guidance — three transferable rules:
- **Customer-centric component names:** "Use customer-centric names like 'Dashboard' or 'API Access',
  **not internal jargon like 'API-gateway-prod'**."
  → directly supports our existing rule (subject = show name, not worker/job) and condemns
  "Orchestrator log" as a label.
- **Never go silent; set the next-update expectation:** "Update … at regular intervals, even if the update
  is simply 'We are continuing to work on a fix.' … **Include a timestamp for the next anticipated update
  in every message. This predictability reduces customer anxiety.**"
  → **[INFERENCE]** For us: an idle page must show **when it last looked and when it will look next**.
  We already compute `nextRecheckAt` per row in `PendingLane` — the finding is that this datum should be
  **promoted to the top-level idle statement**, not buried per row. "Everything I can get is in place.
  Last swept 14 minutes ago · next sweep in 46 minutes" answers the Bazarr #732 question ("it won't
  download a thing for 6 hours" — *is it broken or is it done?*) that Bazarr structurally cannot answer.
- **Scope the impact in user terms:** "Clearly state which components are affected and what the
  **customer-visible impact** is."
  → **[INFERENCE]** "assrt quota exhausted" is a component statement; "12 episodes are waiting on assrt's
  quota, which resets in 3h" is an impact statement. We currently render the former (`QuotaFactsSection`).
- (https://www.pagerduty.com/resources/outages/learn/status-page-best-practices/)

**[SOURCED] Standard empty-state doctrine** (design systems, for the genuinely-nothing-yet case):
- PatternFly: an empty state is "a screen that is not yet populated with data … typically containing a
  short message **and next steps for users**." (https://www.patternfly.org/components/empty-state/design-guidelines/)
- Cloudscape distinguishes **empty** (no data at all) from **zero-results** (filters matched nothing) and
  from **empty value** — different states need different copy. (https://cloudscape.design/patterns/general/empty-states/)
- The practical guide: a good empty state answers "**What's happening, why is it happening, what can users
  do next?**" and the failure mode is bare "No data."
  (https://uxplanet.org/empty-state-design-a-practical-guide-94ad0adbda45)
- Dashboards specifically: "It's not clear whether I need to **wait for data to load, or if there is
  nothing to display, or whether the dashboard has broken**." (https://www.infosol.com/ui-ux-series-empty-states/)

**[INFERENCE] Therefore we need to distinguish four states that all currently risk looking alike**, which
I think is the crux of the owner's unease:

| State | Meaning | Must communicate |
|---|---|---|
| **Cold** | fresh install, nothing scanned yet | onboarding + next step (true `EmptyState`) |
| **Converged** (our normal) | everything obtainable is obtained | *health*: coverage number + recent history + last/next sweep |
| **Blocked** | work outstanding, but waiting on quota / throttle / retry window | *why waiting* + *when it resumes*, neutrally |
| **Stalled** | work outstanding, nothing waiting, nothing running — a bug | this must look **different**, and it's the one Bazarr never surfaced |

Today `Lanes.tsx` collapses Cold and Converged into one `EmptyState`, and has no way to render Stalled at
all. **[INFERENCE]** Making Converged ≠ Stalled visible is probably the highest-value single change
available, and it is a direct answer to the most common Bazarr bug report.

## Q5. Three-stage pipeline with one hidden stage

**Framing first. [INFERENCE, argued from Q2's sourced material]** The strongest answer is not a
hide/reveal *technique* — it is that with the asset abstraction there is **no stage to hide**. Dagster:
the asset graph "is different from the execution DAGs … Execution DAGs track execution dependencies …
The data asset graph tracks data dependencies"
(https://medium.com/@dagster-io/declarative-scheduling-for-data-assets-a-breakthrough-in-data-orchestration-85bd5fa6d707).
Identification is execution machinery; it produces no user-visible asset. It is absent from the asset
view for the same reason a database connection pool is absent from a dashboard of tables.

Independent sourced support that gating stages are noise: the GitHub Actions thread's complaint about
"a job whose sole purpose is to determine if some other jobs should be run. **It never fails, and just
creates noise** by including it in the Progress Checks list."
(https://github.com/orgs/community/discussions/26246) — a near-exact description of both our identify
agent and our filter step. **[SOURCED]**

**But hidden stages must become visible when they fail. Prior art:**

- **[SOURCED] Inngest — failure is what drives expansion.** The documented debugging flow is: notice a
  failed run in the list → "Clicking on the failed Function Runs **expands the run detail view**" →
  "let's have a closer look at the Timeline to identify the root cause: We can now **spot that the
  `downgrade-account-billing-plan` failed**. Let's expand this step to look at the retries and errors."
  The hierarchy stays collapsed until a failure gives you a reason to descend, and the failing step is
  the thing you're pointed at.
  (https://www.inngest.com/docs/platform/monitor/inspecting-function-runs)
- **[SOURCED] LangSmith — one trace, filter by which agent produced the span.** Deep Agents writes
  `lc_agent_name` onto every run a subagent produces; you "**Add filter** → Metadata → key
  `lc_agent_name`" and can "**save the filter as a named view**". Also: the tree collapses "framework
  noise" so only "**meaningful application-level runs**" show, with leaf nodes (where work happens)
  emphasised. (https://docs.langchain.com/langsmith/trace-deep-agents ,
  https://medium.com/@shubham.shardul2019/llm-observability-with-langsmith-log-observations-beyond-just-ui-5d5e4a416b43)
  → **[INFERENCE]** The pattern is: **stages are a filter dimension, not a layout dimension.** Which
  agent did something is metadata you can pivot on, not a lane you must look at. That gives us the
  identify agent's escape hatch for free — it's filterable, just not laid out.
- **[SOURCED] Status pages — never let a green banner hide the mechanism.** The anti-pattern is a single
  "All Systems Operational" banner with no component list and no history; the recommendation is a
  **component list with per-component indicators**, in customer-centric names.
  (https://www.pttrns.com/status-page-design-patterns-how-the-best-saas-companies-communicate-downtime/ ,
  https://www.pagerduty.com/resources/outages/learn/status-page-best-practices/)
  → **[INFERENCE]** So the identify agent should still *exist* somewhere as a health datum with a
  timestamp ("library read 14 min ago · 4,182 items known"), just not as a lane. That single line is what
  makes a "nothing is arriving in the queue" failure diagnosable instead of invisible.

**Is hiding a stage confusing when things go wrong in it? [INFERENCE]** Yes, and Bazarr #1939 is the
empirical proof at one remove: there, the *reason* was hidden (DEBUG-only) rather than the *stage*, and
the user's fury was entirely about being unable to reach it — "**WHY was it discarded?** I can't just read
the log - it's not IN the log." The mitigation is not to un-hide by default; it is to guarantee that
(a) a hidden stage's failure **promotes itself into the visible layer**, and (b) the reason is
**persisted at decision time**, so descending is always possible and never requires re-running with a
different log level.

**Could not verify:** I found no product that documents an explicit "collapsed by default, auto-expanded
on failure" behaviour as a named, deliberate feature. Inngest's docs *describe a workflow* that works
that way (user clicks the failed run) but do not claim automatic expansion. Treat auto-expand-on-failure
as a **reasonable synthesis of the observed conventions, not as a cited pattern.**

## Q5. Three-stage pipeline with one hidden stage

_pending_

## Recommended metaphor

### **"The library keeps a promise." A coverage ledger that drains, not a queue that grinds.**

One sentence: *the page states what subtitle coverage the library is supposed to have, how much of it is
real, what's still outstanding and why, and what the agents did recently to close the gap — with the
machinery invisible until it matters.*

**Why this metaphor and not another, argued from the evidence:**

1. **It is the abstraction Dagster arrived at for a structurally identical problem.** "Instead of
   describing the chaos that exists, SDA declares the order you want to create" (Sandy Ryza, via
   https://atlan.com/dagster-data-orchestration/). We declare "this episode should have a subtitle in the
   target language"; three agents are the materialisation function. **[SOURCED premise, INFERENCE mapping]**
2. **It dissolves the hidden-stage problem instead of solving it.** The asset graph "is different from the
   execution DAGs" (https://medium.com/@dagster-io/declarative-scheduling-for-data-assets-a-breakthrough-in-data-orchestration-85bd5fa6d707).
   The identify agent produces no asset the user cares about, so it has no place in the view — and
   independently, a gating stage that "never fails, and just creates noise" is the most concrete complaint
   in GitHub's own matrix-jobs thread (https://github.com/orgs/community/discussions/26246).
3. **It gets the failure semantics right.** "Imperative, workflow-based orchestrators send alerts when
   tasks fail, not when data is out of date, which is often what stakeholders actually care about. If the
   system can retry and self-correct before the deadline, then waking someone up … is a waste." (Dagster,
   ibid.) A failed provider search is not news. An episode still uncovered past its patience window is.
   This retro-justifies the neutral-tone instinct already in `ActivityFeed`/`QuotaFactsSection`.
4. **It makes idle legible.** A ledger at 100% with a timestamp is *a result*. A queue at zero rows is
   *an absence*. Given "an empty incident log … reads as 'nobody is updating this page'"
   (https://www.pttrns.com/status-page-design-patterns-how-the-best-saas-companies-communicate-downtime/),
   and given that Bazarr's users' recurring unanswerable question is "is it done or is it broken"
   (https://github.com/morpheus65535/bazarr/issues/732), this is the decisive advantage.
5. **It survives batch semantics natively.** A ledger doesn't care whether 24 lines were satisfied by 24
   actions or 1; it cares that they're satisfied. The batch action becomes *the interesting thing to
   narrate* rather than an awkwardness to flatten — which is precisely the affordance GitHub users have
   been asking for since 2021 and still don't have.

### How each piece fits

| Piece | Where it lives in the metaphor |
|---|---|
| **Identify agent** | Not in the ledger. One health datum: "library read 14 min ago · 4,182 items known". Becomes visible only when it fails (nothing arriving / read timestamp gone stale). **[INFERENCE, per Q5]** |
| **The filter step** (embedded / already covered / origin-language) | **Ledger accounting, not work.** These items are *satisfied*, not skipped-in-failure. One aggregate line with a count and a breakdown, expandable: "312 need nothing — embedded 190 · already covered 108 · origin-language 14". Counted in the satisfied total. Rationale: Bazarr #2599 proves silence reads as a bug; the GH Actions thread proves peer rows read as noise; the "occasioned explanation" literature says aggregate-plus-on-demand. |
| **Subtitle-finding agent** | The main narrator. Each action = one row: verdict + magnitude, up to 3 reasons on expand, rejected candidates one level deeper (interrogability). This is the *only* agent that needs prominence. |
| **Translation agent** | Same stream, distinguished by **cost disclosure, not by a separate lane**. Per the tiered-disclosure-by-risk recommendation (https://pmc.ncbi.nlm.nih.gov/articles/PMC12562135/) and Nielsen's **run contract** (ETA window, cost cap, what it won't do) shown *before* commitment — i.e. at the settings toggle and on the in-flight row. |
| **Batch actions** | First-class rows with counts in the collapsed header (`covers E01–E24`), expandable to per-episode. Never N flat rows. |
| **Idle / converged** | The default and most-seen state. Coverage figure + last-24h evidence + "last swept / next sweep". Explicitly distinct from Cold, Blocked, and Stalled (see Q4's four-state table). |
| **Live work** | The top row of the one stream, with a live dot and a **ticking** elapsed counter (per Claude Code 2.1.210), not a dedicated section that's empty on most page loads. |

### The one thing to build that the prior art doesn't hand you

**[INFERENCE]** Everything above is assembly of existing conventions. The genuinely differentiating move
is available only because the DB is the state machine: **every decision, including every no-op and every
rejection, has a persisted plain-language reason, always, not behind a log level.** Bazarr's single most
furious bug report is exactly the absence of this ("WHY was it discarded? I can't just read the log - it's
not IN the log", #1939). Spend that advantage in the UI: make *every* line in the ledger answer "why is
this the way it is" without re-running anything.

## Concrete layout proposal

Single column at a comfortable reading width, not two lanes. Rationale: the two-lane split encodes
"pending vs activity" — a **queue** distinction. A ledger reads top-to-bottom: promise → state → evidence.
(Retaining a narrow secondary lane is defensible; see Open questions.)

```
┌─ HEADER: THE PROMISE + THE STATE ───────────────────────────────────┐
│ 3,914 of 4,182 episodes have subtitles.                             │  ← reframed SummaryLine
│ 268 outstanding · 12 installed in the last 24h · 2 translated        │
│ Last swept 14 min ago · next sweep in 46 min          [health dot]  │  ← NEW: cadence line
├─ NOW (only when something is in flight) ────────────────────────────┤
│ ● Searching subtitles for Frieren S01       0:42 ⟳   [stop]         │  ← ticking; live phrases
│   checking assrt · 3 candidates so far                              │
├─ WHAT HAPPENED ─────────────────────────────────────────────────────┤
│ ● Frieren — installed the S01 pack from assrt, covers E01–E24  2h   │  ← batch row w/ magnitude
│   ▸ why this one · ▸ 24 episodes · ▸ 3 rejected                     │     3 disclosure doors
│ ● Dune — translated from the English track  ($0.42 · 6m)       5h   │  ← cost inline (risk tier)
│ ○ 312 items needed nothing  ▸                                       │  ← intentional no-ops, aggregated
│ ○ assrt quota exhausted — 12 episodes waiting, resets in 3h    6h   │  ← impact, not component
├─ STILL OUTSTANDING (268) ───────────────────────────────────────────┤
│ Frieren S01 · 4 missing                        next look in 46m  ⟳  │  ← ≤15 rows, then "show all"
│ …                                                                   │
└─ [ ] Developer mode                                                 │  ← replaces "Orchestrator log"
```

### Region-by-region

**1. Header — the promise and the state.** Coverage as a ratio (the ledger), outstanding count, 24h
evidence, **and the cadence line** (`last swept` / `next sweep`). The health dot is a rollup à la
Dagster's per-asset health indicator, **hover for diagnostics**. Never renders a fabricated `0`
(preserve existing `SummaryLine` philosophy).

**2. Now.** Absent entirely when idle — no heading, no "nothing running" text. Present as the stream's
top row when live. Ticking elapsed. A **stop** affordance (per ChatGPT agent mode's interrupt pairing);
mandatory for translate rows.

**3. What happened.** One reverse-chronological stream. Row = one agent action, subject = the content.
Three disclosure doors, each concretely labelled (information scent): **why this one** (≤3 reasons),
**the N episodes it covered**, **what it rejected**. The third is what makes the judgment contestable
rather than merely narrated. No-ops and quota facts appear here as neutral aggregate rows, phrased as
impact.

**4. Still outstanding.** The ledger's remainder. Grouped series/season, ~15 rows then roll up. Each row
carries *why it's still outstanding* and *when it will be looked at again*. This is `PendingLane`
reframed from deficit ("Gaps") to remainder-of-a-promise.

**5. Developer mode toggle.** Page-level register switch (per eve). Off: everything above. On: mono tool
names, args, durations, per-step timings — i.e. `TraceRows` and receipt chips promoted from a drawer to a
mode. Solves Claude Code #50313's all-or-nothing-per-item complaint by making the switch global *by
design* while keeping per-item doors available in either mode.

### Idle state (the most-seen state)

```
All 4,182 episodes have the subtitles they can get.
Last swept 14 minutes ago · next sweep in 46 minutes
12 installed · 2 translated · 312 needed nothing — in the last 24h
▸ what it did                                    [ ] Developer mode
```
No illustration, no "nothing to see here". Evidence + cadence. **Stalled** must look different: outstanding
work, nothing running, no wait reason → say so plainly and offer the sweep action. This is the state Bazarr
cannot express and the reason most of its bug reports exist.

### Component fate

| Component | Fate | Notes |
|---|---|---|
| `SummaryLine` | **Keep, reframe** | Ratio-first ("3,914 of 4,182") instead of deficit-first ("Watching N gaps"). Add the cadence line. Keep the no-fake-zero rule and the inline-big-number treatment. |
| `ActivityFeed` | **Keep as the spine, restructure** | Drop the per-section headings that render on empty (`NowWorkingSection`'s empty text). Merge Now/Held/Recent/Quota into one stream with row kinds. Move the `Collapsible "Orchestrator log"` → page-level Developer mode. |
| `PendingLane` | **Keep, reframe + cap** | "Gaps" → "Still outstanding". Cap ~15 rows + roll up (per ansible/team-devtools#5). Promote `nextRecheckAt` from a sub-line to a first-class per-row datum, and to the header. Keep the series-only Rerun. |
| `TraceRows` | **Keep, re-home** | `phraseMode` becomes the default live narration inside the Now row (validated by Manus: narration is what builds trust). Raw mode surfaces under Developer mode. Zero mechanism change. |
| `RunDetail` | **Keep as-is** | Already matches Inngest/eve's list→detail convention exactly. Add rejected-candidates if not present. |
| `Lanes.tsx` two-column shell | **Retire** | Replaced by single-column regions. Mobile path gets simpler, not harder. |
| Whole-page `EmptyState` | **Retire** | Actively harmful: it is the "green banner, no history" anti-pattern and it conflates Cold with Converged. |
| `phrases.ts`, `text.ts`, `collapseRecentRuns`, `traceStream`, `useLiveTrail`, `RerunDialog` | **Keep untouched** | All still needed; `collapseRecentRuns` generalises into batch-row folding. |

### New things required

1. **Cadence facts** (`lastSweptAt`, `nextSweepAt`) at the top level — data may already exist per-row.
2. **A satisfied/no-op aggregate** with reason breakdown, counted as satisfied.
3. **Batch-action rows** — one action, N items, magnitude in the header, expandable.
4. **A stalled detector** — outstanding > 0 ∧ running = 0 ∧ no wait reason.
5. **Rejected candidates** persisted and viewable (interrogability / contestability).
6. **Run contract copy** at the translation toggle: ETA, cost cap, what it won't do.
7. **Developer mode** flag.

## Rejected alternatives

**1. Bazarr's per-episode queue (one row per episode, fixed columns, spinner).** Rejected on three sourced
grounds, none of which is "it looks mechanical": (a) **wrong unit of work** — our agent acts in batches, so
N rows misrepresent one action, and one-parent-row-per-batch is GitHub's own longest-standing unmet
request (https://github.com/orgs/community/discussions/26246); (b) **no room for reasons** — fixed columns
can't hold "structural signals match a ~24min anime episode", and the absence of reasons is what Bazarr
users actually rage about (https://github.com/morpheus65535/bazarr/issues/1939); (c) **it collapses at
library scale** — 4,000 and 30,000-row instances exist in the wild
(https://github.com/morpheus65535/bazarr/issues/2041, .../732) and convey strictly less than one number
while hiding the only question asked. Note honestly: Bazarr's interactive per-candidate search modal *is*
good and worth keeping an equivalent of — it's the *ambient queue* that's wrong, not per-item inspection.

**2. One lane per agent (identify | find | translate).** Rejected: three independent products render
multi-agent work as **one narrative with agent identity as filterable metadata** (LangSmith's
`lc_agent_name` filter + saved views; Braintrust's parent-child propagation "in one view"; eve's per-turn
breakdown). Lanes also force the identify agent into view, and would make a single episode's story read as
three disconnected fragments.

**3. A node-link DAG / asset-lineage graph.** Rejected even though we're borrowing Dagster's *semantics*.
Dagster's graph pays off on lineage depth; our assets are flat, ~thousands, with only shallow grouping.
A 4,000-node graph is decoration. Borrow the declarative model and the health rollup; skip the picture.

**4. A stage-stepper / pipeline progress bar (Stage 1 → 2 → 3).** Rejected: NN/G's distinction —
**staged** disclosure is linear and every user traverses every step; **progressive** is hierarchical and
most users never leave level 1 (https://www.nngroup.com/articles/progressive-disclosure/). Our user
traverses nothing. A stepper would visualise a sequence nobody walks.

**5. Separate "Live" and "History" views.** Rejected: no surveyed product does this (Inngest, eve,
LangSmith, Manus all do list→detail), and at our duty cycle a live pane is empty on nearly every load,
which trains the user to ignore the region that occasionally matters most.

**6. A raw log / terminal feed as the primary surface.** Rejected with direct evidence: the Nielsen
heuristic review of Manus flags exactly this ("raw terminal commands … may create cognitive overload")
while praising the *narrated* actions
(https://medium.com/design-bootcamp/i-asked-an-manus-ai-to-evaluate-itself-heres-what-happened-69c90a148e80);
Nielsen: "an agent that narrates all 60 of its tool calls is as unusable as a settings screen with 60
toggles"; Bazarr #1939: 50 pages of debug log in six seconds. **But** the same Nielsen line continues "an
agent that hides the ledger entirely is untrustworthy" — hence Developer mode, not deletion.

**7. Hiding the identify agent completely, with no trace anywhere.** Rejected: status-page practice warns
against the green-banner-with-no-components pattern, and a failure in an entirely invisible stage is
undiagnosable. Compromise: one health datum with a timestamp, promoted on failure.

**8. Confidence scores / percentage match on rows.** Rejected: it's Bazarr's existing approach and its
issues show scores explain mechanism without conveying judgment (#1977, #1675); the XAI literature warns
explanations that "fail to match users' mental models" don't improve calibrated trust. An argument a human
can dispute beats a number they can only accept.

## Open questions

1. **One column or one-plus-narrow-lane?** I propose single column, but the existing two-lane layout has
   the real virtue that outstanding work stays pinned while the feed scrolls — which is *precisely* what
   Claude Code users demand (#8723, #76537: sticky, always-visible plan). A sticky header + scrolling feed
   may capture that without the lane. **Needs a real prototype at real data volumes to settle.**
2. **What is the patience window?** The Dagster freshness analogue requires a policy — how long may an
   episode stay uncovered before it escalates from "outstanding" to "wrong"? Probably differs for a
   just-released episode vs an obscure 1998 film. Unanswered, and the health rollup depends on it.
3. **Is coverage as a ratio honest?** "3,914 of 4,182" implies the remaining 268 are obtainable. If most
   are genuinely unobtainable, the ratio should probably be *of the obtainable* with unobtainable broken
   out — otherwise the number never reaches 100% and stops meaning anything.
4. **Does Developer mode actually beat per-item expansion?** eve ships the toggle; Claude Code users
   complain about exactly this kind of global switch (#50313) and want per-item. My proposal keeps both,
   which may be one mechanism too many.
5. **Cost disclosure granularity for translation.** Per-run cost inline is proposed, but is a running
   monthly total needed in the header? Untested; the run-contract literature says pre-commitment
   disclosure, which argues for the settings surface more than the feed.
6. **Do we have rejected candidates persisted today?** The whole contestability argument depends on it.
   Not verified in the code read.
7. **Do we have a stop/cancel for an in-flight run?** ChatGPT agent mode pairs narration with interrupt;
   I saw `RerunDialog` but no cancel. For a slow, paid translate run this is arguably required.
8. **Unverified products.** Operator's chrome, Zapier Central's current run history, Temporal UI's
   event-history screen, and Inngest AgentKit's dedicated UI were not confirmed from primary sources.
   If any of them has solved the batch-rollup problem well, it would be the most valuable remaining find.
9. **Is "sweep" the right word?** The cadence line is load-bearing for the idle state and needs a term
   that reads as routine and healthy, not as a scan/job. Untested with the owner.

## Concrete layout proposal

_pending_

## Rejected alternatives

_pending_

## Open questions

_pending_
