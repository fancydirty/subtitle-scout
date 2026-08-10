# Streaming / flowing activity feed micro-interactions

Research date: 2026-07-30
Target: `subtitle-scout` activity page hero card — live "what's happening right now" region.
Desired motion: 长江后浪推前浪 — new SSE events push older ones away, older ones fade out via mask/opacity ramp.

Constraints recap:
- SSE, irregular arrival (4–30s per provider step, sometimes bursts)
- Fixed small height (~3–5 visible lines) inside a hero card
- Client-side rendering; must be cheap
- `prefers-reduced-motion` respected
- Chinese text + monospace latin provider names

Labels used below: **[SOURCED]** = verified against a real repo/doc/spec with URL. **[INFERENCE]** = my reasoning, not directly sourced. **[UNVERIFIED]** = could not confirm; test named.

## Progress log

- 2026-07-30 — file created with skeleton. No searches run yet.
- Batch 1 (GitHub API, raw source reads) — **Q1 assistant-ui DONE**. Read the real source of:
  `packages/ui/src/components/assistant-ui/reasoning.tsx`, `tool-group.tsx`,
  `packages/react/src/primitives/thread/useThreadViewportAutoScroll.ts`,
  `packages/react/src/primitives/chainOfThought/*`,
  `packages/core/src/react/primitives/chainOfThought/ChainOfThoughtParts.tsx`,
  `packages/tw-shimmer/src/index.css`, `packages/ui/package.json`.
  Key finding: assistant-ui already implements almost exactly the requested pattern under the name
  **"bottom-pinned live preview"** in `ReasoningRoot`/`ReasoningText`/`ReasoningFade`. No animation
  library — CSS + tailwindcss-animate utilities only. Repo state: `assistant-ui/assistant-ui`,
  11,309 stars, pushed 2026-07-30.
  Still TODO: Q2 (ai-elements), Q3 (mask/CSS technique), Q4 (image refs), Q5 (tradeoffs/a11y).
- Batch 2 (GitHub API, raw source reads) — **Q2 ai-elements DONE**. Read `packages/elements/src/`
  git tree (48 components) + full source of `chain-of-thought.tsx`, `reasoning.tsx`, `task.tsx`,
  `conversation.tsx`, `shimmer.tsx`, and `packages/elements/package.json`.
  Key findings: `ChainOfThoughtStep` has a `status: "complete"|"active"|"pending"` 3-tier color ramp;
  `Conversation` wraps **`use-stick-to-bottom` ^1.1.3** with `role="log"`; `motion` ^12 is a dep but
  used *only* in `shimmer.tsx`; **no mask/fade and no fixed-height scroller** in `ChainOfThought`.
  Still TODO: Q3 (mask/CSS technique), Q4 (image refs), Q5 (tradeoffs/a11y).
- Batch 3 (npm registry + Brave llm_context ×4) — **Q3 DONE**. Covered: `use-stick-to-bottom` README
  from the npm registry (latest 1.1.6, samdenty); `mask-image` support via MDN + mdn/browser-compat-data
  PR #19019 (**Baseline widely available Dec 2023** — corrected the widely-copied blog claim that the
  `-webkit-` prefix is still mandatory); `mask-composite` value-name mismatch; `@starting-style` +
  `transition-behavior: allow-discrete` (**Baseline 2024-08-06, Firefox 129**, web.dev);
  `overflow-anchor` (**no Safari support at all**, suppression triggers include `transform`);
  `flex-direction: column-reverse` (**Firefox Bugzilla #1042151 open since 2014**, flexbugs #108,
  `scaleY(-1)` workaround reported failing on Chrome mobile); View Transitions Baseline via Firefox 144
  (Oct 2025) but rejected on semantics.
  Still TODO: Q4 (image refs), Q5 (tradeoffs/a11y).
- Batch 4 (brave_image_search ×2, brave_llm_context ×1) — **Q4 PARTIAL, Q5 DONE, all deliverable
  sections written.** Image search for Claude Code / Cursor agent panes returned mostly low-confidence
  noise; salvaged 5 usable image URLs incl. the official Claude Code Agent View dark screenshot.
  **Q4 is the weak section — per-product table is labelled INFERENCE/UNVERIFIED, not observation**, and
  ~10 planned product searches (Devin, Warp, Vercel logs, Inngest, Trigger.dev, GH Actions, Railway,
  Fly, Linear, AI Gateway) were skipped for poor yield. Q5 grounded on MDN + **W3C WCAG Technique
  ARIA23** (`role="log"`, implicit polite + `aria-atomic="false"`, "old information may disappear").
  Executive summary, Recommended implementation, Rejected alternatives, Open questions all complete.
  **File is complete and self-consistent.** Remaining optional work: the skipped Q4 product searches.

## Executive summary

The recommended technique is **assistant-ui's "bottom-pinned live preview"** (`reasoning.tsx`:
`ReasoningRoot` / `ReasoningText` / `ReasoningFade`), with three substitutions: `mask-image` replaces
their gradient-overlay divs (backdrop-agnostic, Baseline since Dec 2023), ai-elements'
`ChainOfThoughtStep` `status: "complete" | "active" | "pending"` **color** ramp replaces age-based
opacity for semantic dimming, and `use-stick-to-bottom`'s velocity-based spring replaces a
fixed-duration scroll tween. The key structural insight is that **you never animate the "push"** — a
bottom-pinned scroller plus normal block layout makes older items appear to slide up for free via a
compositor-thread scroll, so the only animated thing is each new row's own `opacity` + `translate`,
which is why neither major AI component library needs a layout-animation library (assistant-ui has
**zero** motion dependencies; ai-elements imports `motion` only for its shimmer). Bursts are handled
by assistant-ui's **capped `nth-child` stagger** (`nth-last-child(n+5) { transition-delay: 160ms }`,
so settle time is bounded regardless of burst size), `rAF`-coalesced scrolling, and a 10-item DOM
buffer. Accessibility is `role="log"` + redundant `aria-live="polite"` per **WCAG Technique ARIA23** —
whose spec text explicitly sanctions that *"old information may disappear"* — never `assertive`,
never `aria-atomic="true"`, plus a separate `role="status"` summary; `column-reverse` and
`overflow-anchor` are both rejected on hard browser-bug grounds (Firefox #1042151 open since 2014;
zero Safari support respectively).

## Q1. assistant-ui implementation

Repo: https://github.com/assistant-ui/assistant-ui (canonical; `Yonom/assistant-ui` is the old
name and redirects). 11.3k stars, actively pushed 2026-07-30. Monorepo, ~4900 files.

### Q1.1 — The single most relevant file **[SOURCED]**

`packages/ui/src/components/assistant-ui/reasoning.tsx`
https://github.com/assistant-ui/assistant-ui/blob/main/packages/ui/src/components/assistant-ui/reasoning.tsx

This file implements, verbatim from its own doc comment on `ReasoningRootProps.streaming`:

> Whether the reasoning is currently streaming. When provided, it supersedes `defaultOpen`: the
> disclosure auto-opens while streaming **with a bottom-pinned live preview**, auto-collapses when
> streaming ends, and the first manual toggle takes over the open/close state permanently. The live
> preview keeps following the newest tokens while the disclosure is open during streaming, even
> after a manual toggle, **and pauses while the reader is scrolled up.**

That is the requested interaction, minus the per-item opacity ramp. Component parts exported from
this file (exact names, verified):

| Name | Role |
|---|---|
| `ReasoningRoot` | wraps `Collapsible`; owns `streaming` prop, `isPreview = streaming && isOpen` |
| `ReasoningTrigger` | header line; `active` + `duration` props, shimmer overlay when active |
| `ReasoningContent` | `CollapsibleContent`; renders `<ReasoningFade side="top" />`, children, and `<ReasoningFade />` (bottom) **only when `isPreview`** |
| `ReasoningText` | the fixed-height scroller: `max-h-64 overflow-y-auto`, owns the pin logic |
| `ReasoningFade` | the fade overlay, `side: "top" \| "bottom"` |

### Q1.2 — How the fade is done: **gradient overlay div, NOT `mask-image`** **[SOURCED]**

Important negative finding. assistant-ui does *not* use `mask-image`. It uses two absolutely
positioned sibling divs painting a background gradient from the card's own background color to
transparent:

```tsx
// ReasoningFade, side="bottom"
<div
  data-slot="reasoning-fade"
  className={cn(
    "aui-reasoning-fade pointer-events-none absolute inset-x-0 bottom-0 z-10 h-8",
    "bg-[linear-gradient(to_top,var(--color-background),transparent)]",
    "group-data-[variant=muted]/reasoning-root:bg-[linear-gradient(to_top,hsl(var(--muted)/0.5),transparent)]",
    "fade-in-0 animate-in",
    "duration-(--animation-duration)",
  )}
/>
```

Note the `group-data-[variant=muted]` variant: because it's an opaque overlay and not a mask, they
have to hardcode a second gradient for the `muted` card background. **[INFERENCE]** This is the
known drawback of the overlay approach vs `mask-image` — the overlay must know the backdrop color.
For subtitle-scout, the hero card likely has its own background distinct from the page, so this is
a real tax; `mask-image` avoids it (see Q3).

Also note `h-8` (32px) fade height, and `z-10` overlay above `ReasoningText`'s `z-0`.

### Q1.3 — Entry animation of new items: CSS only, with an `nth-child` stagger **[SOURCED]**

From `tool-group.tsx` → `ToolGroupContent`, the inner wrapper applies to every child:

```
"[&>*]:animate-in [&>*]:fade-in-0 [&>*]:blur-in-[2px] [&>*]:slide-in-from-top-1
 [&>*]:duration-(--animation-duration) [&>*]:ease-[cubic-bezier(0.32,0.72,0,1)]",
"[&>*]:motion-reduce:animate-none",
"[&>*:nth-child(2)]:[animation-delay:40ms]",
"[&>*:nth-child(3)]:[animation-delay:80ms]",
"[&>*:nth-child(4)]:[animation-delay:120ms]",
"[&>*:nth-child(n+5)]:[animation-delay:160ms]",
```

Three things worth stealing:
1. The entry animation is **fade + 2px blur + 1-unit slide**, not just fade. `blur-in-[2px]` reads
   as "materializing", which suits a stream.
2. `ANIMATION_DURATION = 200` (a JS const, also pushed into CSS as `--animation-duration` via inline
   style on the root) — so JS and CSS can't drift.
3. **The stagger is capped**: `nth-child(n+5)` clamps delay at 160ms. This is the burst answer from
   Q5 — no matter how many items land at once, total stagger never exceeds 160ms.
4. Easing everywhere is `cubic-bezier(0.32, 0.72, 0, 1)` — a strong ease-out, the "iOS sheet" curve.
   Used consistently across `reasoning.tsx` and `tool-group.tsx`.

`motion-reduce:animate-none` is applied on every animated element. **[SOURCED]** — so their
reduced-motion answer is simply "no animation, final state", not "shorter animation".

### Q1.4 — Tool call status transitions (running → complete) **[SOURCED]**

`ToolGroupTrigger` takes `count: number` and `active?: boolean`. When `active`:
- a `<LoaderIcon className="... animate-spin [animation-duration:0.6s]">` appears (0.6s spin, faster
  than the default 1s);
- a **duplicated label** is layered on top with `aria-hidden` and the `shimmer` class:

```tsx
<span className="relative inline-block ...">
  <span className="text-xs">{label}</span>
  {active && (
    <span aria-hidden className="shimmer pointer-events-none absolute inset-0 text-xs motion-reduce:animate-none">
      {label}
    </span>
  )}
</span>
```

The duplicate-and-overlay-with-`aria-hidden` trick is the a11y-safe way to do shimmering text: the
screen reader reads the label once. `ReasoningTrigger` uses the identical pattern.

`shimmer` comes from their own first-party package **`@assistant-ui/tw-shimmer`**
(`packages/tw-shimmer/src/index.css`) — a Tailwind v4 `@utility` implementing a `background-clip:
text` + `-webkit-text-fill-color: transparent` traveling linear-gradient, with `@property`-typed
custom props (`--shimmer-track-height`, `--shimmer-angle`), a 17-stop sine-eased gradient for smooth
falloff, and a Firefox-specific duration override via `@-moz-document url-prefix()`. It is
`animation: tw-shimmer 1s linear 0s infinite backwards`. **[SOURCED]**

**[INFERENCE]** For subtitle-scout this is directly reusable for the bright "current action" line
(`● 正在翻第 3 个来源的季包内容`) — shimmer on the active line is a better "alive" signal than a
spinner, and costs one animated `background-position`.

### Q1.5 — Stick-to-bottom: hand-rolled, NOT `use-stick-to-bottom` **[SOURCED]**

Negative finding, contradicting the brief's guess. `packages/ui/package.json` dependencies contain
no `use-stick-to-bottom` and no `framer-motion`/`motion`. A code search for `stick-to-bottom`,
`framer-motion`, and `auto-animate` across `assistant-ui/assistant-ui` returns **0 results**.
Animation deps are: `class-variance-authority`, `tailwind-merge`, `lucide-react`, `radix-ui` /
`@base-ui/react`. Motion is Tailwind-animate CSS classes (`animate-in`, `fade-in-0`,
`slide-in-from-top-1`, `blur-in-[2px]`, `animate-collapsible-down/up`).

Two independent pin implementations exist:

**(a) Local, inside `ReasoningText`** — the one to copy for a small fixed-height region:

```tsx
let pinned = true;
let lastScrollTop = scrollEl.scrollTop;
let lastScrollHeight = scrollEl.scrollHeight;
const isAtBottom = () =>
  Math.abs(scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight) <= 1
  || scrollEl.scrollHeight <= scrollEl.clientHeight;

const pin = () => { if (!pinned) return; scrollEl.scrollTop = scrollEl.scrollHeight; };

// A pin's own scroll event can arrive after new content grew the scroll
// height and read as "not at bottom"; only an upward move at unchanged
// scroll height is user intent.
const onScroll = () => {
  if (isAtBottom()) pinned = true;
  else if (scrollEl.scrollTop < lastScrollTop && scrollEl.scrollHeight === lastScrollHeight) pinned = false;
  lastScrollTop = scrollEl.scrollTop;
  lastScrollHeight = scrollEl.scrollHeight;
};

pin();
scrollEl.addEventListener("scroll", onScroll);
const observer = new ResizeObserver(pin);   // <-- growth drives the pin, not a React effect
observer.observe(contentEl);
```

This is the fix for the classic "user scrolls up and gets yanked back" bug, and the comment names
the exact race: **a programmatic pin emits a `scroll` event that can be misread as user intent, so
you must require `scrollHeight` to be *unchanged* before believing an upward scroll is the user.**
That guard (`scrollEl.scrollHeight === lastScrollHeight`) is the whole trick. Note also
`<= 1` epsilon on the at-bottom test, needed for fractional device pixel ratios.

**(b) Global, `useThreadViewportAutoScroll`** — the full-thread version:
`packages/react/src/primitives/thread/useThreadViewportAutoScroll.ts`. Adds beyond (a):
- `scrollingToBottomBehaviorRef` — a *pending intent* ref, so a `smooth` scroll's many intermediate
  `scroll` events don't flicker `isAtBottom`. Explicit guard: `isInFlightDownwardScroll = !newIsAtBottom && lastScrollTop.current < div.scrollTop` → no-op.
- `pointerdown` on the scroller cancels pending intent, because "an intent kept alive by a
  non-overflowing thread hijacks the next content growth, e.g. expanding a collapsible tool call."
- `requestAnimationFrame`-coalesced `scheduleScrollToBottom` with `cancelAnimationFrame`, so
  multiple triggers in one frame produce one scroll.
- Options: `autoScroll`, `scrollToBottomOnRunStart`, `scrollToBottomOnInitialize`,
  `scrollToBottomOnThreadSwitch`; plus a `turnAnchor: "top"` mode that anchors the *start* of a turn
  instead of the bottom.
- Composed refs: `useOnResizeContent`, `useManagedRef`, `divRef` via
  `@radix-ui/react-compose-refs`'s `useComposedRefs`.

Related exported hook: **`useScrollLock(ref, durationMs)`** from `@assistant-ui/react`
(`packages/react/src/primitives/reasoning/useScrollLock.ts`), called before any open/close state
change in both `ReasoningRoot` and `ToolGroupRoot`. **[INFERENCE]** Its purpose is to prevent the
page from jumping while a collapsible animates its height for `durationMs`.

Also present: `ThreadPrimitive.Viewport`, `ThreadPrimitive.ViewportFooter`,
`ThreadPrimitive.ScrollToBottom`, `useOnScrollToBottom`, and a `ThreadViewport` store exposing
`isAtBottom` / `turnAnchor` / `element.viewport` / `element.anchor`.

### Q1.6 — "Collapse older steps" pattern **[SOURCED]**

Yes, but as auto-collapse of the *whole group*, not per-item aging:
- `ReasoningRoot` auto-opens while `streaming`, **auto-collapses when streaming ends**, and the
  first manual toggle wins permanently (`userOpen: boolean | null`, `null` = not yet touched).
- The bottom fade exists **only during streaming** (`{isPreview ? <ReasoningFade /> : null}`); the
  top fade is always present. **[INFERENCE]** Deliberate: while streaming you're peeking at a
  window into a growing buffer (fade both ends); when done, it's a static readable block and a
  bottom fade would just hide the conclusion.
- Grouping API: the current one is **`MessagePrimitive.GroupedParts`** with a **`groupBy`** prop, fed
  by the exported helper **`groupPartByType({ reasoning: [...], "tool-call": [...] })`**, producing
  synthetic part types `"group-chainOfThought"`, `"group-reasoning"`, `"group-tool"`.
- **`ChainOfThoughtPrimitive`** (`.Root`, `.AccordionTrigger`, `.Parts`) still exists but the docs
  carry an explicit warn callout: *"For new grouped reasoning/tool-call UI, use
  `MessagePrimitive.GroupedParts`. `ChainOfThoughtPrimitive` and `components.ChainOfThought` remain
  available for maintaining existing code."* Docs:
  https://github.com/assistant-ui/assistant-ui/blob/main/apps/docs/content/docs/primitives/chain-of-thought.mdx
  So **do not** build on `ChainOfThoughtPrimitive` — it is documented-legacy as of this commit.
- `ChainOfThoughtPrimitiveParts` renders by **index count only**
  (`useAuiState(s => s.chainOfThought.parts.length)` then `Array.from({length}, (_, index) => <ChainOfThoughtPartByIndexProvider key={index}>)`),
  i.e. **`key={index}`, and the array is memoized on `partsLength`**. **[INFERENCE]** This is a
  deliberate streaming optimization: parts are append-only, so index keys are stable and a token
  arriving in part N doesn't re-render parts 0..N-1. It also means the design assumes
  **append-only, never reorder** — which matches our SSE feed and is why they can get away with no
  FLIP/layout animation library at all.

### Q1.7 — Other assistant-ui components possibly worth a look **[SOURCED, not yet read]**

From the tree: `packages/ui/src/components/assistant-ui/message-timing.tsx` (elapsed-time display —
relevant to our `4s` / `11s` / `现在` column), `dot-matrix.tsx`, `number-roll.tsx` (animated numerals
— possibly for the seconds counter), `flow.tsx` / `flow-canvas.tsx`, and an
`examples/waterfall/` app (`waterfall-timeline.tsx`, `waterfall-row.tsx`, `waterfall-bar.tsx`).
Not read yet — flagged for a later batch if time permits.

### Q1 screenshots

Not yet collected — deferred to Q4 image search batch.


## Q2. Vercel AI Elements components

Repo: https://github.com/vercel/ai-elements — 2,265 stars, last push **2026-07-09** (note: 3 weeks
stale vs assistant-ui's daily pushes). Source lives in `packages/elements/src/*.tsx`, one file per
component, shipped through a shadcn custom registry (there's an
`apps/docs/app/api/registry/[component]/route.ts` serving it). Docs site is a geistdocs app.

### Q2.1 — Actual component list **[SOURCED]**

Full `packages/elements/src/` listing (48 components, verified from the git tree):
`agent`, `artifact`, `attachments`, `audio-player`, `canvas`, **`chain-of-thought`**, `checkpoint`,
`code-block`, `commit`, `confirmation`, `connection`, `context`, `controls`, **`conversation`**,
`edge`, `environment-variables`, `file-tree`, `image`, `inline-citation`, `jsx-preview`, `message`,
`mic-selector`, `model-selector`, `node`, `open-in-chat`, `package-info`, `panel`, `persona`,
**`plan`**, `prompt-input`, `queue`, **`reasoning`**, `sandbox`, `schema-display`, **`shimmer`**,
`snippet`, `sources`, `speech-input`, `stack-trace`, `suggestion`, **`task`**, `terminal`,
`test-results`, **`tool`**, `toolbar`, `transcription`, `voice-selector`, `web-preview`.

So all four names the brief guessed do exist (`Reasoning`, `Task`, `ChainOfThought`, `Tool`), plus
`Plan`, `Agent`, `Queue`, `Checkpoint`. There is **no** `Actions` component in this listing
(**[UNVERIFIED]** whether it was removed or never existed; test: `git log --diff-filter=D` on the
package, or check the docs sidebar).

**The one that matches our design is `ChainOfThought` + `ChainOfThoughtStep`.** `Task` is a plain
collapsible with a left border rail; `Reasoning` is for a prose token stream.

### Q2.2 — `ChainOfThoughtStep`: an explicit 3-tier status opacity ramp **[SOURCED]**

https://github.com/vercel/ai-elements/blob/main/packages/elements/src/chain-of-thought.tsx

```tsx
const stepStatusStyles = {
  active: "text-foreground",
  complete: "text-muted-foreground",
  pending: "text-muted-foreground/50",
};

export const ChainOfThoughtStep = memo(({
  className, icon: Icon = DotIcon, label, description,
  status = "complete", children, ...props
}: ChainOfThoughtStepProps) => (
  <div className={cn(
      "flex gap-2 text-sm",
      stepStatusStyles[status],
      "fade-in-0 slide-in-from-top-2 animate-in",   // <- entry animation, unconditional
      className)}
    {...props}>
    <div className="relative mt-0.5">
      <Icon className="size-4" />
      <div className="absolute top-7 bottom-0 left-1/2 -mx-px w-px bg-border" />  {/* connector rail */}
    </div>
    <div className="flex-1 space-y-2 overflow-hidden">
      <div>{label}</div>
      {description && <div className="text-muted-foreground text-xs">{description}</div>}
      {children}
    </div>
  </div>
));
```

Key observations:
- **Dimming is by semantic status, not by age.** `status?: "complete" | "active" | "pending"` — three
  discrete tiers driven by state, with no N-from-last gradient. **[INFERENCE]** This is the more
  maintainable choice for a variable-length list (see Q3.4), and it maps cleanly onto our data:
  `active` = the `●` current line, `complete` = past steps, `pending` = queued providers.
- Dimming is done on **`color`** (`text-muted-foreground`), **not `opacity`**. **[INFERENCE]** Better
  than `opacity` here because opacity would also fade the `✓` icon and the border rail; and
  animating `color` doesn't create a compositing layer.
- The entry animation is `fade-in-0 slide-in-from-top-2 animate-in` — **slide from top**, i.e. new
  items appear to drop in from above while the list grows downward. There is **no stagger** and
  **no `motion-reduce:` guard on `ChainOfThoughtStep`** (unlike assistant-ui, which guards
  everything). That's an accessibility gap in ai-elements. **[SOURCED — absence verified in file]**
- The connector rail is a 1px absolutely-positioned div per step (`absolute top-7 bottom-0 left-1/2 -mx-px w-px bg-border`), which draws a spine linking steps.
- `ChainOfThoughtSearchResults` / `ChainOfThoughtSearchResult` render provider hits as shadcn
  `Badge variant="secondary"` chips. **[INFERENCE]** Directly analogous to our
  `在 assrt 找到 1 个季包` — could be a badge rather than prose.

### Q2.3 — No fade mask, no fixed-height scroller in `ChainOfThought` **[SOURCED]**

Negative finding. `ChainOfThought` is `<div className="not-prose w-full space-y-4">` — it grows
unbounded. `ChainOfThoughtContent` is a `CollapsibleContent` with `mt-2 space-y-3`. There is **no**
`max-h-*`, no `overflow-y-auto`, no `mask-image`, and no gradient overlay anywhere in the file.

So on the specific thing we need — fixed small height with a fade — **assistant-ui's `reasoning.tsx`
is ahead of ai-elements' `chain-of-thought.tsx`**. ai-elements only bounds height in
`ChainOfThoughtImage` (`max-h-[22rem] overflow-hidden`, an unrelated use).

### Q2.4 — Auto-collapse when reasoning completes: yes, with a 1s delay **[SOURCED]**

`Reasoning` (`packages/elements/src/reasoning.tsx`) implements the lifecycle explicitly:

```tsx
const AUTO_CLOSE_DELAY = 1000;
const MS_IN_S = 1000;
// ...
const resolvedDefaultOpen = defaultOpen ?? isStreaming;
const isExplicitlyClosed = defaultOpen === false;
const hasEverStreamedRef = useRef(isStreaming);
const [hasAutoClosed, setHasAutoClosed] = useState(false);
const startTimeRef = useRef<number | null>(null);

// duration is self-measured, not passed in
useEffect(() => {
  if (isStreaming) {
    hasEverStreamedRef.current = true;
    if (startTimeRef.current === null) startTimeRef.current = Date.now();
  } else if (startTimeRef.current !== null) {
    setDuration(Math.ceil((Date.now() - startTimeRef.current) / MS_IN_S));
    startTimeRef.current = null;
  }
}, [isStreaming, setDuration]);

// auto-open on stream start
useEffect(() => {
  if (isStreaming && !isOpen && !isExplicitlyClosed) setIsOpen(true);
}, [...]);

// auto-close 1s after stream end, exactly once
useEffect(() => {
  if (hasEverStreamedRef.current && !isStreaming && isOpen && !hasAutoClosed) {
    const timer = setTimeout(() => { setIsOpen(false); setHasAutoClosed(true); }, AUTO_CLOSE_DELAY);
    return () => clearTimeout(timer);
  }
}, [...]);
```

Compare with assistant-ui: assistant-ui collapses immediately and lets the *first manual toggle* win
forever (`userOpen: boolean | null`); ai-elements waits `AUTO_CLOSE_DELAY = 1000` ms and uses a
one-shot `hasAutoClosed` latch. **[INFERENCE]** The 1s delay is the better UX detail — it gives the
reader a beat to see the final step before it folds away. The `hasAutoClosed` latch is weaker than
assistant-ui's `userOpen === null` sentinel, because a user who reopens after auto-close then starts
a new stream will get re-opened again.

`ReasoningTrigger` has a swappable `getThinkingMessage?: (isStreaming, duration?) => ReactNode`
whose default is:

```tsx
if (isStreaming || duration === 0) return <Shimmer duration={1}>Thinking...</Shimmer>;
if (duration === undefined) return <p>Thought for a few seconds</p>;
return <p>Thought for {duration} seconds</p>;
```

### Q2.5 — Animation library: **`motion` v12**, but used only for the shimmer **[SOURCED]**

`packages/elements/package.json` dependencies (verified):
`motion: ^12.26.2`, **`use-stick-to-bottom: ^1.1.3`**, `@radix-ui/react-use-controllable-state`,
`@xyflow/react ^12.10.0`, `streamdown ^2.4.0` + `@streamdown/{cjk,code,math,mermaid}`,
`ai ^6.0.105`, `shiki`, `katex`, `media-chrome`, `@rive-app/react-webgl2`, `ansi-to-react`,
`tokenlens`, `nanoid`, `cva`, `lucide-react ^0.577.0`, React 19.2.3 pinned.

`motion/react` is imported in exactly one relevant place — `shimmer.tsx`:

```tsx
import { motion } from "motion/react";
// module-level cache so motion.create() never runs during render
const motionComponentCache = new Map<keyof JSX.IntrinsicElements, React.ComponentType<MotionHTMLProps>>();
const getMotionComponent = (element) => { /* get-or-create */ };

<MotionComponent
  initial={{ backgroundPosition: "100% center" }}
  animate={{ backgroundPosition: "0% center" }}
  transition={{ duration, ease: "linear", repeat: Number.POSITIVE_INFINITY }}
  className="relative inline-block bg-[length:250%_100%,auto] bg-clip-text text-transparent
             [--bg:linear-gradient(90deg,#0000_calc(50%-var(--spread)),var(--color-background),#0000_calc(50%+var(--spread)))]
             [background-repeat:no-repeat,padding-box]"
  style={{ "--spread": `${(children?.length ?? 0) * spread}px`,
           backgroundImage: "var(--bg), linear-gradient(var(--color-muted-foreground), var(--color-muted-foreground))" }}
>{children}</MotionComponent>
```

Two notes: the `--spread` scales with text length (`children.length * spread`), and the
`motion.create()` module-level cache is there to avoid creating components during render.
**[INFERENCE]** Pulling in `motion` (~30–50 kB gzipped) purely for one infinite
`backgroundPosition` tween is a bad trade — `@assistant-ui/tw-shimmer`'s pure-CSS `@utility` does
the same job with a richer 17-stop sine falloff and a Firefox fix, at zero JS. Also, this shimmer
has **no `prefers-reduced-motion` handling at all** (`motion` respects it only if you opt in via
`useReducedMotion`), whereas assistant-ui's every shimmer site carries `motion-reduce:animate-none`.

**No `AnimatePresence` and no `layout` prop is used anywhere in the step/reasoning components.**
All list entry/exit animation in ai-elements is Tailwind-animate CSS (`animate-in`, `fade-in-0`,
`slide-in-from-top-2`, `data-[state=closed]:animate-out`). This is a notable convergence: **both
major AI component libraries do streaming-list motion with CSS only, not with a layout-animation
library.**

### Q2.6 — `Conversation`: this is where `use-stick-to-bottom` lives **[SOURCED]**

`packages/elements/src/conversation.tsx`:

```tsx
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";

export const Conversation = ({ className, ...props }) => (
  <StickToBottom
    className={cn("relative flex-1 overflow-y-hidden", className)}
    initial="smooth"
    resize="smooth"
    role="log"          // <-- a11y: role="log", NOT aria-live
    {...props}
  />
);

export const ConversationContent = (props) => (
  <StickToBottom.Content className={cn("flex flex-col gap-8 p-4", ...)} {...props} />
);

export const ConversationScrollButton = ({ className, ...props }) => {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();
  return !isAtBottom && (
    <Button className="absolute bottom-4 left-[50%] translate-x-[-50%] rounded-full ..." onClick={() => scrollToBottom()}>
      <ArrowDownIcon className="size-4" />
    </Button>
  );
};
```

So the brief's guess was right, but about the *wrong library*: **`use-stick-to-bottom` is an
ai-elements dependency, not an assistant-ui one.** Verified API surface: default export component
`StickToBottom` with `initial` / `resize` props accepting `"smooth"`, a `StickToBottom.Content`
subcomponent, and a `useStickToBottomContext()` hook returning at least `{ isAtBottom, scrollToBottom }`.
Version `^1.1.3`.

Note `overflow-y-hidden` on the outer `StickToBottom` — the library moves the scroll onto its own
inner wrapper. And note the escape hatch: rather than fight the "yanked back" bug, they surface an
explicit **scroll-to-bottom FAB shown only when `!isAtBottom`** (assistant-ui has the same idea as
`ThreadPrimitive.ScrollToBottom`).

**a11y datapoint, important for Q5:** `Conversation` uses **`role="log"`** and *no* `aria-live`
attribute. `role="log"` has an implicit `aria-live="polite"` per ARIA, but crucially also implies
`aria-relevant="additions"` — so only added nodes are announced, not the whole re-read.

### Q2.7 — CJK plugin **[SOURCED]**

`reasoning.tsx` imports `cjk` from **`@streamdown/cjk`** and passes it in
`const streamdownPlugins = { cjk, code, math, mermaid }`. **[INFERENCE]** Relevant to us since our
text is Chinese, but it is a *markdown-streaming* plugin (presumably handling CJK emphasis/spacing
during partial parses), not a layout/animation concern. Only matters if we render markdown; our
activity lines are plain strings, so probably not needed. **[UNVERIFIED]** what `@streamdown/cjk`
actually does — test: read `streamdown`'s repo or `npm view @streamdown/cjk`.


## Q3. The motion pattern: new pushes old + old fades

### Q3.1 — `mask-image` for fade-out edges: use it, and **skip the prefix panic** **[SOURCED]**

Support, from MDN (authoritative) rather than the SEO blogs:
- **`mask` shorthand + `mask-image`: Baseline "widely available" since December 2023.** MDN on
  `mask`: *"This feature is well established and works across many devices and browser versions.
  It's been available across browsers since December 2023."*
  https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/mask
- Unprefixed floor: Chrome 120+, Edge 120+, Firefox 53+, **Safari 15.4+**, Opera 106+, Samsung
  Internet 25+. Safari 15.4 shipped unprefixed `mask` / `mask-image` / `mask-size` / `mask-repeat-x`
  / `mask-repeat-y` / `mask-origin` — corroborated by the WebKit release notes quoted in
  mdn/browser-compat-data PR #19019 (https://github.com/mdn/browser-compat-data/pull/19019):
  *"In an ongoing effort to reduce dependency on prefixes, WebKit newly supports several CSS
  properties and values that were only previously available in an earlier form. The prefixed versions
  will still work, now aliased to the unprefixed versions."*

**Correction to the widely-copied blog advice.** Several 2026-dated posts (dev.to
`nickbenksim`, csscodelab, w3tweaks) insist *"mask-image still heavily relies on the -webkit- prefix
in Chrome, Edge, and Safari"* and that omitting it means *"your effect will likely only work in
Firefox."* **That is false for any browser from 2023 onward** and contradicts MDN/BCD. Those posts
appear to be AI-spun SEO content (they share near-identical prose). **[INFERENCE]** Keep
`-webkit-mask-image` only if you must support Safari < 15.4 (released March 2022); for
subtitle-scout, a Vite + React 19 app, that is already outside any plausible support matrix. React 19
requires modern browsers anyway. Cost of keeping it is one duplicated line, so it's cheap insurance,
but it is not a correctness requirement.

Production snippet for a vertically fading scroller (this is the shape we want — the double-`calc`
form is better than percentages because the fade height stays constant regardless of content length):

```css
.feed {
  max-height: 5lh;              /* 5 line-heights; see Q3.6 */
  overflow-y: auto;
  mask-image: linear-gradient(
    to bottom,
    transparent 0,
    black 2.5rem,
    black calc(100% - 0.75rem),
    black 100%
  );
  mask-repeat: no-repeat;
  mask-size: 100% 100%;
}
```
Source pattern: https://savvy.co.il/en/blog/css/css-mask-image/ (uses `transparent 0px, black 40px,
black calc(100% - 40px), transparent 100%`).

**`mask-composite` — not needed here.** **[SOURCED]** It only has any effect with **two or more
comma-separated mask layers**; a single `mask-image` ignores it entirely. It matters if you fade all
four edges (stack a horizontal and a vertical gradient, then `mask-composite: intersect`). Our region
fades only vertically → one layer → no composite. If you ever do need it, note the value names
differ: standard `add`/`subtract`/`intersect`/`exclude` vs webkit
`source-over`/`source-out`/**`source-in`**/`xor`; writing `-webkit-mask-composite: intersect` is a
silent no-op in Safari.

**Why mask beats the overlay-div approach** (which is what assistant-ui uses, Q1.2): the overlay must
hardcode the backdrop color, so it breaks over a textured, gradient, or differently-tinted card —
and assistant-ui demonstrably pays that tax with a second hardcoded gradient for its `muted`
variant. `mask-image` is backdrop-agnostic. Given subtitle-scout has a dark theme with a hero card
that likely has its own elevation/tint, **mask is the right call**.

Two mask gotchas worth knowing **[SOURCED]**:
1. `mask-image` on the scroll container fades the **scrollbar** too, and creates a containing/paint
   context. **[INFERENCE]** Since we're hiding the scrollbar anyway in a 3–5 line region, fine.
2. **[INFERENCE, needs test]** Masking forces the element onto its own composited/paint layer; on a
   region containing a `background-clip: text` shimmer, layer interaction should be checked. Test:
   Chrome DevTools → Rendering → "Paint flashing" + Layers panel, with the shimmer active inside a
   masked scroller.

### Q3.2 — Making new items push old ones up, without layout thrash

Four candidate techniques, with a verdict on each.

**(a) `flex-direction: column-reverse` — REJECT. [SOURCED]**
The classic "free chat scroll" trick, and it is genuinely broken:
- **Firefox: content overflowing the "start" side of a `*-reverse` flex container is not
  scrollable.** Bugzilla **#1042151**, filed 2014-07, still open ~12 years later; duplicate
  **#1063967**. Also tracked as philipwalton/flexbugs **#108**. Direct quotes from the bug: *"Our chat
  app is not scrolling to the bottom in FF when there are new messages using overflow: auto and flex:
  column-reverse. Chrome and Safari works."* and *"It's not a top priority at the moment — probably
  not destined to be resolved in the immediate future."*
  https://bugzilla.mozilla.org/show_bug.cgi?id=1042151
- The commonly-posted workaround is `transform: scaleY(-1)` on the container and `scaleY(-1)` again
  on each item. The team that tried it in production reported it failed: *"we actually used this
  solution for a while, until we realised chrome mobile would inexplicably flip scroll directions
  seemingly randomly. Some users ended up stuck, trying to scroll only to have it go the wrong way
  whichever direction they tried."* — https://onfe.uk/blog/p/the-woes-of-firefox-s-flexbox/
  That post's final answer was UA-sniffing for Firefox via `typeof InstallTrigger !== "undefined"`,
  which is both ugly and now broken (Firefox removed `InstallTrigger`).
- iOS bonus bug: with `column-reverse`, `scrollTo({top: 0})` doesn't work on first render; you must
  scroll to `-1`. https://stackoverflow.com/questions/77229520/

**(b) `overflow-anchor` (CSS scroll anchoring) — REJECT as the primary mechanism. [SOURCED]**
- **Safari does not support `overflow-anchor` in any stable release, macOS or iOS.** Chrome 56+,
  Edge 79+, Firefox 66+, Opera 43+, Samsung 5+ do. WebKit tracks it as bug 307734. Because iOS
  forces WebKit, *every* iOS browser lacks it.
- Two further spec-level traps: **(i)** anchoring is *silently suppressed* by changes to `top`,
  `left`, `right`, `bottom`, `margin`, `padding`, `width`, `height`, **`transform`**, or `position`
  on the anchor's ancestor — so **our own entry animation would disable it**; **(ii)** once an
  ancestor sets `overflow-anchor: none`, descendants cannot opt back in.
- Notably, `use-stick-to-bottom` advertises exactly this as its first feature: *"Does not require
  `overflow-anchor` browser-level CSS support which Safari does not support."*

**(c) CSS View Transitions for list reordering — REJECT for this use case. [SOURCED]**
Same-document view transitions became Baseline when **Firefox 144 shipped in October 2025**, and
`:active-view-transition` / `:active-view-transition-type()` reached Baseline Newly Available around
April 2026 (https://www.buildmvpfast.com/blog/web-platform-baseline-2026-new-features-browser-support).
So support is no longer the blocker. The blockers are semantic:
- `document.startViewTransition()` is a **document-scoped, serialized** primitive. A burst of 5 SSE
  events in 200ms means 5 overlapping transition requests; the API's contract is to skip/abort
  in-flight transitions when a new one starts. **[INFERENCE]** This is precisely the wrong shape for
  a high-frequency append-only stream.
- It also snapshots and freezes the page during the transition, and each animated element needs a
  unique `view-transition-name`. **[INFERENCE]** For an append-only list nothing actually *reorders*,
  so we'd be paying the full cost of a crossfade engine to do what a `translateY` keyframe does.
- Verdict: view transitions are for *reordering/replacing* lists. Ours is append-only. Wrong tool.

**(d) `@starting-style` + a `translateY` entry animation — ACCEPT (or Tailwind-animate equivalent). [SOURCED]**
- **`@starting-style` and `transition-behavior: allow-discrete` both became Baseline Newly Available
  on 2024-08-06 with Firefox 129.** https://web.dev/blog/baseline-entry-animations — *"Now, two of
  these features, `@starting-style` and `transition-behavior: allow-discrete` have become Baseline
  Newly available with the release of Firefox 129."* Floor: Chrome 117+, Edge 117+, Safari 17.5+,
  Firefox 129+.
- It degrades perfectly: unsupported browsers just show the element instantly, no polyfill needed.
  Feature-detectable via `@supports at-rule(@starting-style)`.
- We do **not** need `allow-discrete` — that's only for crossing the `display: none` boundary. New
  feed items are genuinely inserted into the DOM, so plain `@starting-style` suffices.
- The published stagger idiom is `transition-delay` per `:nth-child` — same shape as assistant-ui's
  capped `nth-child` stagger (Q1.3):
  ```css
  .list-item { opacity: 1; transform: translateY(0); transition: opacity .3s ease, transform .3s ease;
    @starting-style { opacity: 0; transform: translateY(15px); } }
  .list-item:nth-child(2) { transition-delay: 50ms; } /* ... */
  ```

**How "push" actually works, and why there is no thrash. [INFERENCE, mechanism is sourced]**
The key realisation: **you don't animate the push at all.** If the container is bottom-pinned and you
append a node, normal block layout instantly grows the content and the pin scrolls to the new
bottom — the older items *appear* to slide up because the scroll offset changed, which is a
compositor-thread scroll, not a layout animation. The only thing you animate is the **new item's own
`opacity` + `translateY`**. So per event you get: one layout pass for the inserted node (unavoidable),
plus a compositor-only scroll and a compositor-only transform/opacity tween. No FLIP, no measuring,
no per-item position bookkeeping. This is exactly what both assistant-ui and ai-elements do, and it
explains why neither needs a layout-animation library.

**Motion / framer-motion `AnimatePresence` + `layout` — REJECT. [SOURCED for the fact that neither
library uses it; INFERENCE for the reasoning]** `layout` props implement FLIP: measure every child
before and after commit, then counter-transform. For an append-only, bottom-pinned list that's pure
overhead, and FLIP is the single most common source of jank in long lists. Confirmed datapoint:
**neither assistant-ui nor ai-elements uses `AnimatePresence` or `layout` for streaming steps** —
ai-elements pulls in `motion` v12 but *only* for `shimmer.tsx`, and assistant-ui has no motion
dependency at all.

### Q3.3 — Auto-scroll / stick-to-bottom

**Library: `use-stick-to-bottom` (samdenty), latest `1.1.6`, zero dependencies. [SOURCED]**
https://github.com/samdenty/use-stick-to-bottom · https://use-stick-to-bottom.samdenty.io
Verified feature list from its README:
- *"Does not require `overflow-anchor` browser-level CSS support which Safari does not support."*
- Uses **`ResizeObserver`**, and explicitly *"supports content shrinking without losing stickiness —
  not just getting taller."*
- *"Correctly handles Scroll Anchoring... when content above the viewport resizes, it doesn't cause
  the content currently displayed in viewport to jump up or down."*
- *"Allows the user to cancel the stickiness at any time by scrolling up. Clever logic distinguishes
  the user scrolling from the custom animation scroll events (**without doing any debouncing which
  could cause some events to be missed**)."*
- *"Uses a custom implemented smooth scrolling algorithm, featuring **velocity-based spring
  animations** (with configurable parameters). Other libraries use easing functions with durations
  instead, but these don't work well when you want to stream in new content with variable sizing —
  which is common for AI chatbot use cases."* ← **This is the single best argument for the library
  over a hand-rolled pin, and it maps directly onto our variable 4–30s irregular arrivals.**
- `scrollToBottom()` returns `Promise<boolean>` — `true` on success, `false` if cancelled.
- Two APIs: `<StickToBottom>` / `<StickToBottom.Content>` + `useStickToBottomContext()`, or the bare
  `useStickToBottom()` hook returning `{ scrollRef, contentRef }`.
- Props seen in real use: `resize="smooth"`, `initial="smooth"` (ai-elements passes both).

**The classic "yanked back" bug and the fix.** Both real implementations converge on the same
insight, which is worth stating as a rule: **an upward scroll only counts as user intent if
`scrollHeight` is unchanged.** assistant-ui writes it out (Q1.5):
```js
if (isAtBottom()) pinned = true;
else if (scrollEl.scrollTop < lastScrollTop && scrollEl.scrollHeight === lastScrollHeight) pinned = false;
```
with the comment *"A pin's own scroll event can arrive after new content grew the scroll height and
read as 'not at bottom'; only an upward move at unchanged scroll height is user intent."*
`use-stick-to-bottom` describes the same thing as distinguishing user scroll from animation scroll
"without doing any debouncing which could cause some events to be missed."
Secondary guards from assistant-ui's fuller hook: an at-bottom epsilon of `<= 1` px; treating
in-flight downward scrolls as no-ops; cancelling pending scroll intent on `pointerdown`; and
`requestAnimationFrame`-coalescing scroll requests.
Escape hatch both libraries ship: a **scroll-to-bottom button rendered only when `!isAtBottom`**
(`ConversationScrollButton`, `ThreadPrimitive.ScrollToBottom`).

Other libraries: `react-scroll-to-bottom` — **[UNVERIFIED]**, not investigated; it appears
unmaintained relative to `use-stick-to-bottom`. Test: check npm last-publish date and open issues.

### Q3.4 — Opacity ramp by age: CSS-only vs JS

**Option A — `:nth-last-child()` CSS-only ramp.** No JS, no per-item state, self-correcting as the
list grows. Because the *last* child is the newest, `nth-last-child` indexes by recency:
```css
.feed-item { opacity: .38; transition: opacity .2s ease; }
.feed-item:nth-last-child(1) { opacity: 1;   }
.feed-item:nth-last-child(2) { opacity: .72; }
.feed-item:nth-last-child(3) { opacity: .52; }
/* everything older keeps the .38 base */
```
Robust for **variable-length** lists precisely because the base rule handles the unbounded tail and
only a fixed number of overrides are needed. `:nth-last-child` is ancient/universal support.
**[INFERENCE]** Caveat: it's positional, so it can't distinguish "old" from "important-but-old"
(e.g. an error line you want to keep legible).

**Option B — semantic status classes**, which is what **ai-elements actually ships** (Q2.2):
`status: "complete" | "active" | "pending"` → `text-foreground` / `text-muted-foreground` /
`text-muted-foreground/50`. **[SOURCED]**

**Option C — JS-computed opacity per item** (index from end → inline style). Most flexible, but
re-renders every item on every append and puts inline styles in the way of the design system.

**Verdict [INFERENCE]:** combine A and B, on different properties. Use **semantic color** for
meaning (`active` bright, `complete` dimmed, `error` stays legible with an accent) and the
**`:nth-last-child` ramp for age** — but apply the age ramp via the **mask gradient instead of
per-item opacity** where possible, since the mask already produces a continuous age fade for free
and costs zero per-item CSS. Reserve `:nth-last-child` for the 1–2 discrete steps the mask can't
express. This also dodges a real pitfall: stacking per-item `opacity` *under* a mask multiplies the
two alphas, so old items can vanish faster than intended.

Also note **`opacity` vs `color` [INFERENCE]**: `opacity` on a row fades its icon, its `✓`, and its
timing text uniformly and creates a compositing layer per item; `color` only affects text and
inherits to `currentColor` icons. ai-elements deliberately uses `color`. For a mostly-text row,
`color` is the cheaper and more controllable choice; use `opacity` only for the whole-row age ramp.

### Q3.5 — `content-visibility` / containment **[INFERENCE, unverified]**
Not researched in depth. For a 3–5 line region with a capped buffer this is almost certainly
unnecessary; `contain: layout paint` on the scroller might slightly help isolate the region's layout
from the hero card. Test: measure with and without, on the low-power box, using DevTools Performance.

### Q3.6 — Sizing the region: `lh` unit **[INFERENCE]**
Since the requirement is "3–5 visible lines", `max-height: 5lh` expresses that directly and stays
correct if the CJK line-height changes. `lh`/`rlh` units are part of CSS Values 4.
**[UNVERIFIED]** exact Baseline date for `lh` — test: check MDN `lh` BCD; fall back to
`calc(5 * var(--feed-line-height))` if it's not comfortably available.


## Q4. Real product visual references

**Honest status: this is the weakest section of the research.** Two image-search batches
(`brave_image_search`) for Claude Code and Cursor agent panes returned mostly low-confidence noise —
Reddit thumbnails at 140×85, XDA stock photos, unrelated marketplace/hooks screenshots. Brave's own
`confidence` field rated all but two results `"low"`. I did not run the remaining ~10 product
searches (Devin / Warp / Vercel build logs / Inngest / Trigger.dev / GitHub Actions / Railway / Fly /
Linear / AI Gateway Agent Runs) because the yield-per-call was poor and I judged Q5's sourced a11y
guidance to be worth more to the implementation. **Do not treat the per-product table below as
sourced observation — most of it is unverified.**

### Images actually found, with URLs the controller can open

| What | Image URL | Notes |
|---|---|---|
| Claude Code **Agent View** (official docs) | https://mintcdn.com/claude-code/1B48Qz2Z9hac4SLG/images/agent-view-dark.png | 1772×780. Official, dark theme. Caption (from the docs page) describes it precisely: *"Sessions are grouped under **Needs input**, **Working**, and **Completed**, with a dispatch input at the bottom and a footer of keyboard hints."* Source page: https://code.claude.com/docs/en/agent-view |
| Claude Code parallel task agents | https://storage.ghost.io/c/57/9b/579b6dca-f48a-4307-844f-f0533595d058/content/images/2026/04/Claude-Code-Agents-working-in-parallel-1.webp | 1548×1498, rated `medium` confidence. From https://www.producttalk.org/how-to-use-claude-code-features/ |
| Claude Code sub-agent running w/ main agent waiting | https://storage.ghost.io/c/57/9b/579b6dca-f48a-4307-844f-f0533595d058/content/images/2026/04/WebSearch-as-a-Sub-Agent.webp | 1520×770 |
| Cursor agent panel | https://us1.discourse-cdn.com/cursor1/optimized/3X/d/b/dbdbd06df705e46f2b681b6c8688d323b1efc19b_2_590x500.png | 590×500, `medium` confidence, from the Cursor forum |
| Cursor Agent modes | https://www.altexsoft.com/static/content-image/2025/6/d3539fe8-6d9b-478a-bcb5-9e540ca3d1ef.png | 1596×729 |

**The single most useful datapoint here [SOURCED, from the official caption]:** Claude Code's Agent
View does **not** use an age-based fade at all. It **buckets by status** — `Needs input` / `Working`
/ `Completed` — which is the same design decision as ai-elements' `ChainOfThoughtStep`
`status` prop (Q2.2) and the opposite of a positional age ramp. Two independent teams reaching for
status-grouping over age-fading is meaningful evidence.

### Per-product expectations — **[INFERENCE / UNVERIFIED, from general familiarity, NOT from images I retrieved]**

Flagging this explicitly because the brief asked me not to invent. The following are priors, not
findings, and each needs a screenshot to confirm:

| Product | Newest at | Fade mask? | Old items | Separate "current action" line? |
|---|---|---|---|---|
| Claude Code (terminal) | bottom | no (terminal scrollback) | stay in scrollback | yes — spinner + current tool line |
| Cursor agent pane | bottom | unverified | collapse into summaries | yes |
| Devin | bottom | unverified | scrollable timeline | yes |
| Warp AI blocks | bottom | no | persistent blocks | block-level |
| Vercel build logs | bottom | no | fully scrollable, retained | no |
| GitHub Actions live log | bottom | no | retained, collapsible per step | step headers act as one |
| Inngest / Trigger.dev run timeline | top or bottom | unverified | retained | run status header |
| Railway / Fly deploy logs | bottom | no | retained | no |
| Linear activity feed | top (typically) | unverified | paginated | no |
| Vercel AI Gateway Agent Runs | unverified | unverified | unverified | unverified |

**The pattern I'd assert with confidence anyway [INFERENCE]:** *log-style* surfaces (build logs, CI,
deploy) universally append at the **bottom**, never fade, and keep everything scrollable — because
the log is the artifact and truncation is a bug. *Agent-UI* surfaces (Claude Code Agent View,
Cursor, the two component libraries in Q1/Q2) treat history as ephemeral and collapse or de-emphasize
it — because the artifact is the *result*, not the trace. **subtitle-scout's hero card is the second
kind**: a 3–5 line window inside a hero card is explicitly not a log. That justifies fading, and it
also means **there should be a full, non-faded, scrollable log elsewhere** for when the user actually
wants to audit what happened. Fading is only acceptable if the information is recoverable.

**Recommended follow-up for the controller:** rather than more image search, open these directly —
https://code.claude.com/docs/en/agent-view (official, dark, and the closest analogue found), plus
the ai-elements docs preview for `ChainOfThought`
(https://github.com/vercel/ai-elements → `apps/docs`, component page renders a live demo) and
assistant-ui's `examples/with-chain-of-thought` app. Live demos beat screenshots for a motion
question.

## Q5. Tradeoffs and failure modes

### Q5.1 — Bursty arrival: 5 events in 200ms

**What breaks [INFERENCE, mechanism-level]:** with a naive per-item `animation` on mount and a
200ms duration, five items landing inside 200ms produce five simultaneously-running animations whose
start times are ~40ms apart. They don't queue — CSS animations are independent — so you get five
overlapping fades. Visually this reads as a single blurry lurch rather than five discrete arrivals,
and the bottom-pin fires up to five scroll adjustments in the same window.

**How the real implementations handle it [SOURCED]:**
1. **assistant-ui: a capped `nth-child` stagger** (Q1.3). `[&>*:nth-child(n+5)]:[animation-delay:160ms]`
   — delays are 0/40/80/120/160ms and then clamp. So arbitrary burst size still resolves within
   160ms + 200ms duration. This is the cheapest correct answer, and it's pure CSS. The clamp is the
   important half: an uncapped `nth-child` stagger on a 30-item burst would take 1.2s to settle.
2. **assistant-ui: `requestAnimationFrame` coalescing of scroll intent.**
   `scheduleScrollToBottom` cancels any pending frame before scheduling a new one
   (`cancelAnimationFrame(scheduledFrameRef.current)`), so N events in one frame → one scroll.
3. **assistant-ui: `ResizeObserver`-driven pinning** rather than effect-driven. The observer fires
   once per layout regardless of how many React commits happened, so bursts naturally batch.
4. **`use-stick-to-bottom`: velocity-based spring instead of a fixed-duration ease** — explicitly
   justified in its README as needed *"when you want to stream in new content with variable
   sizing."* A spring re-targets mid-flight; a duration-based tween restarts and stutters.
5. **React 19 automatic batching [INFERENCE]:** if all five SSE events arrive in one macrotask, React
   19 batches them into a single commit, and they'd mount in the same frame — which is exactly the
   case the capped stagger is designed for.

**[UNVERIFIED]** I did not find first-hand bug reports/issue threads specifically measuring burst
behaviour in these libraries. Test to close this: render the region, fire 20 synthetic events over
200ms via `setTimeout(…, i*10)`, record a DevTools Performance trace, and check for dropped frames
and for the total settle time.

**[INFERENCE] Additional mitigation worth building:** cap the rendered buffer. With a 3–5 line
window there is no reason to keep more than ~8–10 items in the DOM. Slice the array
(`items.slice(-10)`) so the DOM stays tiny and `ResizeObserver` work stays constant regardless of run
length. This matters more than any animation choice for the low-power-box concern.

### Q5.2 — CLS and jank

**CLS: not a risk here, and it's worth being precise about why. [INFERENCE, grounded in the CLS spec's definition]**
Cumulative Layout Shift only counts *unexpected* shifts of visible elements, and critically:
(a) shifts within a **fixed-size scroll container** don't move anything outside it — the hero card's
geometry never changes, so no shift is recorded for the surrounding page; (b) **scrolling itself is
excluded** from CLS; (c) shifts caused by `transform` are excluded, since transforms don't affect
layout. So the recommended design (fixed height + pinned scroll + transform/opacity tweens) is
CLS-neutral **provided the region's height is genuinely fixed**. The thing that *would* cause CLS is
letting the region grow from 1 line to 5 lines as events arrive — the hero card would push page
content down on every one of the first five events. **Therefore: reserve the full height from the
start** (`min-height` equal to `max-height`), even when empty.

**Jank: the risk is real but small, and it's about property choice, not about animating at all.**
**[INFERENCE]** `opacity` and `transform` are compositor-friendly. The things in this design that
are *not* free: (i) the `background-clip: text` shimmer animates `background-position`, which repaints
the text every frame — one line only, acceptable, and it's what both libraries ship; (ii) `filter:
blur()` in assistant-ui's `blur-in-[2px]` entry is a per-frame GPU filter — cheap for a 200ms
one-shot on one line, but I would **drop the blur on the low-power box** and keep fade+translate;
(iii) `mask-image` promotes the scroller to its own paint layer.
No published measurements found. **[UNVERIFIED]** Test: DevTools Performance trace on the target
low-power box during a burst; watch for long paint records and check the compositor lane. Also
Rendering → "Paint flashing" to confirm only the new row repaints, not the whole region.

### Q5.3 — Accessibility of a fast live region: use `role="log"`, not raw `aria-live` **[SOURCED]**

This is the best-sourced answer in the whole document, and the naive instinct (`aria-live="polite"`
on the container) is indeed wrong-ish. The correct primitive is **`role="log"`**, and there is a
formal WCAG technique for exactly our case:

**W3C WCAG 2.1 Technique ARIA23: "Using role=log to identify sequential information updates"**
https://www.w3.org/WAI/WCAG21/Techniques/aria/ARIA23
> *"The purpose of this technique is to notify Assistive Technologies (AT) when content has been
> appended to sequential information concerning the application's history or logs. The ARIA live
> region role of `log` has an implicit `aria-live` value of **polite** and `aria-atomic` value of
> **false**, which allows a user to be notified via AT when log messages are added."*

And its second worked example is literally ours: *"An application log records time-stamped
activities. The log is exposed in the app as a view, with the region marked with `role="log"` so that
the new additions are announced by the ATs."*

MDN's `log` role page is decisive on why `log` beats a bare `aria-live` region
(https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Roles/log_role):
> *"A log is a type of live region where new information is added in meaningful order and **old
> information may disappear**... In contrast to other live regions, in this role there is a
> relationship between the arrival of new items in the log and the reading order. The log contains a
> meaningful sequence and new information is added only to the end of the log, not at arbitrary
> points."*
> *"By default, updates contain **only the changes** to the live region and these are announced when
> the user is idle."*

"Old information may disappear" is explicitly sanctioned — which is precisely what our fade-out does.
Implicit values: `aria-live="polite"`, **`aria-atomic="false"`** (only the delta is read, never the
whole region re-read). Note a doc conflict: MDN's role page says implicit `aria-atomic` is `false`,
while one training course (bati-itao) claims `true` for `log`; **MDN and the ARIA spec say `false`,
and `false` is the behaviour you want.** **[SOURCED, conflict noted]**

**Compatibility caveat [SOURCED]:** MDN's live-regions guide table says for `log`: *"To maximize
compatibility, add a redundant `aria-live="polite"` when using this role."* So belt-and-braces
`role="log" aria-live="polite"` is the recommended markup. (Contrast with `role="alert"`, where MDN
warns the redundant attribute *causes double-speaking in VoiceOver on iOS* — that caveat is specific
to `alert`, not `log`.)

**What NOT to do [SOURCED]:**
- `aria-live="assertive"` — *"will interrupt any announcement a screen reader is currently making...
  extremely annoying and disruptive."*
- `aria-live="off"` — counter-intuitively **not** "never announce". MDN: *"changes to the element's
  content are only supposed to be announced when focus is on, or inside, the element."*
- `role="marquee"` — tempting ("text which scrolls"), but its implicit `aria-live` is **`off`** and it
  is defined for content *"where the sequence in which the information is updated is irrelevant."*
  Our sequence matters. Wrong role.
- `aria-atomic="true"` — would re-read all 5 lines on every event. Catastrophic here.

**Two more sourced details worth implementing:**
- MDN, `aria-live` reference: the live region *"is set on an empty element"* and must exist in the DOM
  **before** the updates. Corollary: render the `role="log"` container unconditionally, even before
  the first event, or announcements will be missed. One course adds *"if adding the live region to the
  DOM dynamically, it's best practice to wait at least 2 seconds for the accessibility API to
  identify it before injecting any text."*
- **`aria-busy`** — MDN: *"Use `aria-busy` to prevent announcements while updates are still being
  made."* **[INFERENCE]** This is the sanctioned burst mitigation for a11y: set `aria-busy="true"`
  while a burst is being flushed, `false` when settled, and the AT gets one coherent announcement.

**Precedent [SOURCED]:** ai-elements' `Conversation` ships **`role="log"` with no `aria-live`
attribute** (Q2.6) — right role, but missing MDN's recommended redundant `aria-live="polite"`.

**[INFERENCE] My recommendation, going slightly beyond the sources:** the visible feed is a
*decorative compression* of the truth — dimmed, masked, capped at 5 lines. A screen reader user gets
nothing from the fade. So: put `role="log" aria-live="polite"` on the item list so each new step is
announced once as it arrives, mark the purely decorative parts (`●`, the shimmer duplicate, the
connector rail) `aria-hidden="true"`, and additionally provide a `role="status"` one-liner
summarising overall progress ("正在检索第 3 个来源，共 5 个") for users who want state without the
narration. `role="status"` has implicit `aria-live="polite"` **and implicit `aria-atomic="true"`
[SOURCED, MDN status role]**, which is correct for a summary — you *do* want the whole sentence
re-read.

### Q5.4 — `prefers-reduced-motion` fallback **[SOURCED for the pattern used, INFERENCE for the recommendation]**

**assistant-ui's answer is "no animation, final state."** Every animated element carries
`motion-reduce:animate-none` — the entry animation, the stagger, the chevron rotation, the collapsible
height animation, and the shimmer. It is applied unconditionally and consistently. That is a defensible
and very cheap policy. **ai-elements, by contrast, has no reduced-motion handling on
`ChainOfThoughtStep` or in `shimmer.tsx` at all** — a genuine gap, since `motion` only honours the
preference if you opt in via `useReducedMotion()`.

**[INFERENCE] What the right fallback is here, specifically.** Three things must degrade differently:
1. **Entry animation** → drop entirely. Item appears at final opacity/position. No translate, no blur.
2. **The scroll pin** → keep, but switch `behavior: "smooth"` → `"instant"`. Smooth programmatic
   scrolling is itself vestibular-triggering motion; this is the most-missed part of reduced-motion
   compliance in chat UIs. `use-stick-to-bottom`'s spring should be bypassed for a jump.
3. **The shimmer** → stop the animation, but **do not lose the "this is active" signal**. Replace with
   a static distinction (brighter color / a `●` glyph / bold weight). Killing the shimmer without a
   replacement removes information, which is worse than the motion.
The **mask fade stays** in all cases — it is a static visual treatment, not motion, and it carries the
"there is more above" information.

```css
@media (prefers-reduced-motion: reduce) {
  .feed-item { animation: none; transition: none; }
  .feed-item--active .shimmer { animation: none; }  /* keep the color/weight distinction */
}
```


## Recommended implementation

Borrowed from: **assistant-ui's `reasoning.tsx` "bottom-pinned live preview"** (structure, capped
stagger, pin logic), **ai-elements' `ChainOfThoughtStep`** (status-based dimming), **`use-stick-to-bottom`**
(spring-based pin), with `mask-image` substituted for assistant-ui's gradient-overlay divs.

### DOM structure

```jsx
// The outer box has a FIXED height (min == max) so the hero card never reflows → no CLS.
<div className="feed" aria-label="当前进度">

  {/* 1. Persistent current-action line — OUTSIDE the scroller, never scrolls away. */}
  <p className="feed__current">
    <span className="feed__dot" aria-hidden="true">●</span>
    <span className="feed__shimmer-wrap">
      <span>{current.label}</span>
      {/* duplicated + aria-hidden so SRs read the label once (assistant-ui's trick) */}
      <span aria-hidden="true" className="feed__shimmer">{current.label}</span>
    </span>
  </p>

  {/* 2. The fading history scroller. role=log per WCAG ARIA23. */}
  <ol
    ref={scrollRef}
    className="feed__log"
    role="log"
    aria-live="polite"          // redundant-but-recommended per MDN
    aria-busy={isFlushingBurst} // suppress announcements mid-burst
  >
    <div ref={contentRef}>
      {items.slice(-10).map((it) => (        // capped buffer: DOM stays tiny
        <li key={it.id} className="feed__item" data-status={it.status}>
          <span className="feed__label">{it.label}</span>
          {it.ok && <span aria-hidden="true">✓</span>}
          <time className="feed__age" dateTime={it.at}>{it.ageLabel}</time>
        </li>
      ))}
    </div>
  </ol>

  {/* 3. Static summary for screen readers who want state, not narration. */}
  <p className="sr-only" role="status">
    正在检索第 {current.index} 个来源，共 {total} 个
  </p>
</div>
```

Two deliberate choices: the **current action lives outside the scroller** (so it can never be
scrolled away or faded — matching Claude Code's persistent "Working" bucket), and the buffer is
**sliced to the last 10** so neither the DOM nor `ResizeObserver` work grows with run length.

### CSS

```css
.feed {
  --feed-lines: 5;
  --feed-fade: 2rem;
  --feed-dur: 200ms;
  --feed-ease: cubic-bezier(0.32, 0.72, 0, 1);   /* assistant-ui's curve */
}

/* Fixed height, both bounds, so the hero card geometry is constant. */
.feed__log {
  min-height: calc(var(--feed-lines) * 1lh);
  max-height: calc(var(--feed-lines) * 1lh);
  overflow-y: auto;
  scrollbar-width: none;
  overscroll-behavior: contain;      /* don't chain scroll to the page */

  /* Age fade: opaque at the bottom (newest), dissolving upward (oldest). */
  mask-image: linear-gradient(
    to bottom,
    transparent 0,
    black var(--feed-fade),
    black 100%
  );
  -webkit-mask-image: linear-gradient(to bottom, transparent 0, black var(--feed-fade), black 100%);
  mask-repeat: no-repeat;
  mask-size: 100% 100%;
}
.feed__log::-webkit-scrollbar { display: none; }

/* Dimming by MEANING (color, not opacity — icons/timestamps stay controllable). */
.feed__item                      { color: var(--color-text-muted); }
.feed__item[data-status="active"] { color: var(--color-text); }
.feed__item[data-status="pending"] { color: var(--color-text-subtle); }
.feed__item[data-status="error"]  { color: var(--color-danger); }  /* never dimmed away */

/* Age ramp: only the 1–2 steps the mask can't express. :nth-last-child == recency. */
.feed__item:nth-last-child(1) { opacity: 1; }
.feed__item:nth-last-child(2) { opacity: .82; }
/* older items rely on the mask gradient — do NOT stack more per-item opacity,
   because mask alpha × item opacity multiplies and they'd vanish too fast. */

/* Latin provider names in mono, CJK in the body face. */
.feed__label { font-variant-east-asian: proportional-width; }
.feed__label code, .feed__provider { font-family: var(--font-mono); }
.feed__age { font-variant-numeric: tabular-nums; }  /* 4s/11s don't jitter */

/* Entry animation: fade + rise. Baseline since Aug 2024. */
.feed__item {
  opacity: 1;
  translate: 0 0;
  transition: opacity var(--feed-dur) var(--feed-ease),
              translate var(--feed-dur) var(--feed-ease);
  @starting-style { opacity: 0; translate: 0 0.5lh; }
}

/* Burst clamp — total stagger never exceeds 160ms regardless of burst size. */
.feed__item:nth-last-child(1) { transition-delay: 0ms; }
.feed__item:nth-last-child(2) { transition-delay: 40ms; }
.feed__item:nth-last-child(3) { transition-delay: 80ms; }
.feed__item:nth-last-child(4) { transition-delay: 120ms; }
.feed__item:nth-last-child(n+5) { transition-delay: 160ms; }

@media (prefers-reduced-motion: reduce) {
  .feed__item { transition: none; }
  .feed__item { @starting-style { opacity: 1; translate: 0 0; } }
  .feed__shimmer { animation: none; display: none; }
  .feed__current { font-weight: 600; }   /* keep the "active" signal without motion */
}
```

Note `translate: 0 0.5lh` rather than `transform: translateY(...)` — the independent `translate`
property composes without clobbering other transforms, and `lh` ties the rise to the line height so
it reads as "one row up" in both CJK and latin.

### Animation approach: **CSS-only.** No animation library.

Justified by convergent evidence: assistant-ui has **zero** motion dependencies, and ai-elements
imports `motion` **only for its shimmer**. Neither uses `AnimatePresence` or `layout`. For an
append-only bottom-pinned list, FLIP is pure overhead. For the shimmer, port
`@assistant-ui/tw-shimmer`'s pure-CSS `@utility` approach rather than adding `motion` (~30–50 kB) for
one `background-position` tween.

### Scroll behavior

Use **`use-stick-to-bottom@^1.1.6`** (zero-dependency) rather than hand-rolling, specifically for its
**velocity-based spring**, which its README justifies for *"content with variable sizing"* — matching
our 4–30s irregular arrivals where a fixed-duration tween would restart and stutter. It also avoids
`overflow-anchor` (no Safari support) by design.

If you'd rather not add a dependency, port assistant-ui's `ReasoningText` effect verbatim (Q1.5) — it's
~25 lines. Either way the non-negotiable invariant is:

> **An upward scroll counts as user intent only if `scrollHeight` is unchanged.**
> `else if (scrollTop < lastScrollTop && scrollHeight === lastScrollHeight) pinned = false;`

Plus: `<= 1`px at-bottom epsilon; `requestAnimationFrame`-coalesce scroll requests; cancel pending
intent on `pointerdown`; drive the pin from `ResizeObserver` on the content (not a React effect); and
show a scroll-to-bottom affordance when `!isAtBottom`. Under reduced-motion, force `behavior: "instant"`.

### How bursts are handled

Four layers, in order of importance:
1. **Capped `nth-last-child` stagger** (above) — bounded settle time for any burst size.
2. **`rAF`-coalesced scroll** — N events in one frame → one scroll adjustment.
3. **`ResizeObserver`-driven pin** — fires per layout, not per commit; batches naturally.
4. **`aria-busy` during a flush** — one coherent SR announcement instead of five interleaved.
Plus the **capped 10-item buffer**, which is the biggest single win for the low-power box.

### Accessibility summary

- `role="log"` + redundant `aria-live="polite"` on the list — per **WCAG ARIA23** and MDN's
  compatibility note. Implicit `aria-atomic="false"` means only the new line is read. `role="log"`
  explicitly sanctions that *"old information may disappear."*
- Render the log container **before** the first event (live regions must pre-exist).
- `aria-hidden="true"` on the `●`, the shimmer duplicate, the `✓` glyph, and any connector rail.
- Separate `role="status"` summary (implicit `aria-atomic="true"`) for state-without-narration.
- Never `assertive`, never `aria-atomic="true"` on the list, never `role="marquee"`.
- Full unfaded scrollable log available elsewhere — fading is only ethical if recoverable.

## Rejected alternatives

| Rejected | Reason |
|---|---|
| `flex-direction: column-reverse` for free bottom-anchoring | **Firefox Bugzilla #1042151 open since 2014-07**, "probably not destined to be resolved"; flexbugs #108. The `transform: scaleY(-1)` workaround was reported failing in production on Chrome mobile (random scroll-direction inversion). iOS needs `scrollTo(-1)` not `0`. **[SOURCED]** |
| `overflow-anchor: auto` as the pin mechanism | **No Safari support in any stable release, macOS or iOS** (WebKit bug 307734); iOS forces WebKit so *every* iOS browser lacks it. Worse, anchoring is silently suppressed by `transform` changes on ancestors — our own entry animation would disable it. **[SOURCED]** |
| CSS View Transitions for the list update | Support is fine (Baseline via Firefox 144, Oct 2025), but semantics are wrong: document-scoped and serialized, so a 5-event burst produces overlapping/aborted transitions. It's a *reorder/replace* primitive; our list is append-only, so nothing needs crossfading. **[SOURCED support, INFERENCE semantics]** |
| Motion/framer-motion `AnimatePresence` + `layout` | FLIP measures every child pre/post commit — pure overhead for an append-only bottom-pinned list, and a classic jank source. Confirmed that **neither assistant-ui nor ai-elements uses it** for streaming steps. **[SOURCED absence]** |
| `motion` just for the shimmer (ai-elements' choice) | ~30–50 kB gzipped for one infinite `backgroundPosition` tween, and it doesn't honour `prefers-reduced-motion` unless you opt in. `@assistant-ui/tw-shimmer` does more (17-stop sine falloff, Firefox duration fix) in pure CSS. **[SOURCED]** |
| Gradient-overlay divs for the fade (assistant-ui's choice) | The overlay must hardcode the backdrop color; assistant-ui demonstrably pays this tax with a second hardcoded gradient for its `muted` variant. `mask-image` is backdrop-agnostic and Baseline since Dec 2023. **[SOURCED]** |
| `ChainOfThoughtPrimitive` as an API model | Documented-legacy in assistant-ui's own docs: *"For new grouped reasoning/tool-call UI, use `MessagePrimitive.GroupedParts`."* **[SOURCED]** |
| Per-item JS-computed opacity by index | Re-renders every item on every append and fights the design system with inline styles. `:nth-last-child` + the mask gradient get the same result for free. **[INFERENCE]** |
| Stacking a full per-item opacity ramp *under* the mask | Mask alpha × item opacity multiply, so old rows vanish faster than intended. Let the mask do the age fade; use `:nth-last-child` for only 1–2 discrete steps. **[INFERENCE]** |
| `opacity` for status dimming | Fades the `✓`, the timestamp, and the icon uniformly and creates a per-item compositing layer. ai-elements deliberately uses `color`. **[SOURCED precedent]** |
| `role="marquee"` | Implicit `aria-live="off"`, and defined for content where update *sequence is irrelevant*. Ours is sequential. **[SOURCED]** |
| `aria-live="assertive"` or `aria-atomic="true"` on the list | Assertive interrupts every announcement; atomic re-reads all 5 lines per event. **[SOURCED]** |
| Unbounded item buffer | No reason to keep >10 nodes for a 5-line window; growth hurts the low-power box via `ResizeObserver` + layout cost. **[INFERENCE]** |
| `blur-in-[2px]` on entry (assistant-ui does this) | Per-frame GPU filter. Fine on a laptop, first thing I'd cut for the low-power box. Keep fade + translate. **[INFERENCE]** |

## Open questions

1. **Does the mask interact badly with the `background-clip: text` shimmer?** The masked scroller gets
   its own paint layer; the shimmer repaints text every frame. Test: DevTools → Rendering → Paint
   flashing + Layers, shimmer active inside the masked region, on the target box. *(I'd put the
   shimmer on the current-action line which is **outside** the scroller — which likely sidesteps this
   entirely, but confirm.)*
2. **Is `lh` safely available?** **[UNVERIFIED]** — check MDN BCD for `lh`; fall back to
   `calc(5 * var(--feed-line-height))` if not. Same question for `1lh` inside `translate`.
3. **Does `@starting-style` fire reliably for React 19 list insertions?** The element must be newly
   inserted, not merely re-keyed. If React reuses a DOM node (bad keys, or a `key={index}` scheme like
   assistant-ui's `ChainOfThoughtParts` uses), `@starting-style` won't fire. Test: stable
   `key={event.id}` and verify the entry animation actually plays on the 2nd..Nth event, not just the
   1st. **This is the most likely thing to silently not work.**
4. **Do we need `@streamdown/cjk`?** **[UNVERIFIED]** what it does. Only relevant if we render
   markdown; our lines are plain strings, so probably not. Test: `npm view @streamdown/cjk` / read
   streamdown's repo.
5. **Mixed CJK + monospace latin baseline alignment** — `opensubtitles` in a mono face inside a CJK
   line usually sits on a different baseline and different line-height, which can make the fixed
   `1lh` row height wrong. Not researched. Test: render the real provider names and check row heights
   are identical; may need `font-size-adjust` or a matched mono.
6. **Where does the full, unfaded log live?** The recommendation is only defensible if the compressed
   view is recoverable. This is a product decision, not a technical one, and it's unresolved.
7. **`use-stick-to-bottom` vs porting ~25 lines.** Adding a dep for one region may not be worth it.
   **[UNVERIFIED]** its bundle size — test: `npx bundlejs use-stick-to-bottom`. If it's small, take
   the spring; if not, port assistant-ui's `ReasoningText` effect.
8. **Should the fade be top-only or both ends?** assistant-ui shows the bottom fade **only while
   streaming** — reasoning being that once done, a bottom fade would hide the conclusion. Our current
   action is outside the scroller, so a top-only fade is probably right, but worth a visual check.
9. **Q4 is under-researched.** Per-product behaviours are priors, not observations. Highest-value
   follow-up is opening the live demos (assistant-ui `examples/with-chain-of-thought`, ai-elements
   docs `ChainOfThought` page, https://code.claude.com/docs/en/agent-view) rather than more image
   search.
10. **`ai-elements` may be going stale** — last push 2026-07-09 vs assistant-ui's daily. If we copy
    from ai-elements, we're copying from the less-maintained of the two. **[SOURCED]**

