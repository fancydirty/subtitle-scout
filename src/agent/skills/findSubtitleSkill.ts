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

## Season packs and collections are NORMAL — internalize this before you judge anything

Chinese subtitles are distributed as SEASON PACKS and COMPLETE-SERIES collections far more
often than as single per-episode files. It is entirely normal for EVERY candidate a search
returns to be a pack — "進擊的巨人 S1+S2+S3+OAD 合集", a "[Fansub] Complete Series 繁中字幕"
bundle, a multi-season or whole-show collection, sometimes with movies/OADs mixed in. A pack
that spans this show's season is a GOOD candidate, NOT something to reject for being a pack.

Do not hold out for a "clean single-episode" candidate: that is the LESS common case and
often does not exist at all. If you keep re-searching for a lone single-episode file and
rejecting every pack, you will loop forever and never finalize — that is the exact failure
mode this section exists to prevent.

### How to work with a pack (like scanning a downloaded zip's contents)

A candidate carries a \`fileList\` — the entries inside it, each with an \`index\` and a
\`name\`. Call \`get_candidate(index, detail: 'detailed')\` to read the full fileList of a
pack. Scan it the way a person scans a zip's file listing: find the entry whose name matches
YOUR target season+episode (e.g. an entry named ...S01E01... when you want S01E01). Then call
\`download_candidate\` with that entry's \`fileIndex\` — that pulls exactly that one episode's
file out of the pack for you to inspect and install. A pack whose fileList clearly contains
your episode IS a match: go into it, do not skip it. For a plain single-file candidate (empty
fileList, or one entry that is your episode) pass \`fileIndex: null\`.

## Workflow

1. Read the task's media identity (title, alternative/native titles, year, season/episode,
   filename) from your instructions — it is fixed for this task, you do not re-derive it.
2. Call \`search_source\` with one or more queries built from the title/native title. It
   returns a result_set_id, a count, and a short top-N preview — NOT the full result set.
3. Use \`list_candidates\`/\`get_candidate\` to page through the result set instead of asking
   for everything at once. Prefer candidates whose release name, native name, or filelist
   entries plausibly cover this exact season/episode — a season pack or complete-series
   collection that spans this season counts, so read its fileList (\`get_candidate\` detailed)
   to confirm your episode is inside and to find that entry's fileIndex.
4. If nothing plausible turns up, you MAY call \`search_source\` again with different
   queries (alternate titles, romanizations, a narrower/wider query) — re-searching is
   expected, not a failure.
5. For a plausible candidate, call \`download_candidate\` to fetch it into your sandbox and
   get back structural inspection signals — pass \`fileIndex: null\` for a single-file
   candidate, or the fileList entry's \`fileIndex\` to extract your episode from a pack.
   Compare those signals against what a normal episode/movie of this runtime should look like
   (cue count in the low hundreds, span roughly matching runtime, decodable, not HTML, script
   matching your target language). A convincing filename sitting on top of implausible
   structural signals is NOT a match — trust the bytes over the label.
6. Only when you have genuinely decided — the way a person would after opening the file —
   call \`install_subtitle\` to atomically place it. If you are not sure, that is
   no_safe_match, not a hopeful guess: a wrong subtitle silently installed is worse than a
   gap that gets retried later.
7. Report your final decision (installed / no_safe_match / retry_later) by calling
   \`finalize\` EXACTLY ONCE — once you have either installed a subtitle or concluded
   no_safe_match, stop; do not keep looping. no_safe_match means you have genuinely exhausted
   the real candidates and none of them — pack or single — contains this episode; it is NOT
   "there was no clean single-episode file" (a pack that spans this season DOES contain it).
   retry_later is for transient failures (a provider errored, a download timed out) — not for
   "I am not confident," which is no_safe_match.

## Sandbox

You only know about ONE media directory for this task. There is no other directory in your
world — do not ask about, reference, or attempt to construct paths to any other location.
\`install_subtitle\` will refuse anything outside this task's directory regardless.
`.trim()

export const FIND_SUBTITLE_SKILL: Skill = {
  descriptor: {
    name: 'find-subtitle-judgment',
    description:
      'How to judge whether a downloaded candidate belongs to this exact video (metadata + structural inspection, never dialogue content, never a confidence score), how to extract your episode from the season packs / complete-series collections that Chinese subtitles usually come as (read the fileList, download by fileIndex), and the search→compare→install workflow.',
  },
  content: CONTENT,
}
