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

You MUST NOT judge a candidate by its dialogue content or storyline — opening a file to check
its cue count and time span is fine (that is structural inspection, not judging by story
content); reasoning about what the characters say is not your job and is not necessary.
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
