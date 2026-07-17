// Judgment playbook for the find-subtitle worker (v3 phase ③). Written as a .ts const module,
// not .md — tsconfig.build.json only compiles .ts. Loaded on demand via read_doc — the system
// prompt only ever sees the name+description from the descriptor below.
//
// A5: the playbook is a factory parameterized by target language. The Chinese wording is the
// canonical text (胶水层修复 2026-07-16 起为批量收割版——单集版的 live-acceptance 措辞在批量
// 语义不冲突处逐字保留) and findSubtitleSkill.test.ts pins its semantic anchors. Only two
// regions vary by language: the pack-distribution intro (pack dominance is a
// Chinese-fansub-ecosystem fact; elsewhere packs are merely common) and the "Language:
// coverage, not preference" section (the Hans/Hant script equivalence guidance is Chinese-only
// and must not leak into other targets).
//
// 胶水层修复（2026-07-16 事故 + R-11 用户裁决）：任务从单集升级为批量目标事实清单——范围
// 由主代理按刮削出的磁盘实际情况裁量（单季/多季/全剧），worker 一轮 run 收割清单内全部
// 可安全完成的目标，finalize 一次交三桶批量报告。skill 修订权只在人+主控（铁律）。
import type { Skill } from './types.js'
import { languageName } from '../languages.js'

export function makeFindSubtitleSkill(targetLanguage: string, hardsubMode: 'off' | 'agent' | 'aggressive' = 'off'): Skill {
  const name = languageName(targetLanguage)
  const isChinese = targetLanguage === 'zh'

  const packIntro = isChinese
    ? `Chinese subtitles are distributed as SEASON PACKS and COMPLETE-SERIES collections far more
often than as single per-episode files.`
    : `${name} subtitles are often distributed as SEASON PACKS and COMPLETE-SERIES collections,
not only as single per-episode files.`

  // Phrased article-free ("install one in X", not "install a X one") so any languageName()
  // output — including bare-code fallbacks like 'xx' — reads grammatically.
  const languageSection = isChinese
    ? `Your target is a CHINESE subtitle. Simplified (zh-Hans) and Traditional (zh-Hant) are equally
good — a correct-episode subtitle in EITHER script is a success. Do not rank Simplified above
Traditional or vice versa, do not hold out for one when the other is already in front of you,
and do not spend judgment deciding between them: getting each episode covered is what matters.
A non-Chinese subtitle (e.g. a Japanese or English track that happens to sit in the same pack)
is NOT coverage — install a Chinese one, or report no_safe_match for that item; never install
a non-Chinese file just to "have something".`
    : `Your target language is ${name}: getting each episode covered in ${name} is what matters.
A subtitle in any other language (even one that happens to sit in the same pack) is NOT
coverage — install one in ${name}, or report no_safe_match for that item; never install a
wrong-language file just to "have something".`

  // 救援R5（spec §4 agent 档，主控亲笔——skill 修订权铁律）：只在 hardsubMode==='agent' 时
  // 才把"硬字幕假定"这个概念递给模型；'off'/'aggressive' 时整段文字连"hardsub"这个词都不出现
  // ——零误触发（北极星⑥）的做法是让模型压根不知道这个选项存在，不是靠指令去"劝阻"它别用。
  // 'aggressive' 档是机械层直判（ingest 探针阶段），根本不会把这类文件当 target 派给这个 worker
  // ——worker 侧不需要为它做任何事，同 'off' 一样什么都不讲。
  const hardsubSection = hardsubMode === 'agent'
    ? `

## Hardsub-assumed: a fourth outcome, only for genuinely hardcoded video

Some releases never had a separate subtitle file because the subtitles are burned into the
video image itself (hardsubs) — usually fansub groups whose filename carries a bracketed group
tag, e.g. \`[SubsPlease] Show - 01 [1080p].mkv\` or \`[Group] Show S01E01.mkv\`. Every target you
are given already has NO embedded subtitle track (the mechanical pre-scan already ruled that
out before this item became a target) — so "no embedded track" is not evidence by itself, it is
already true of everything on your list.

You may judge a target as \`hardsub_assumed\` INSTEAD of \`no_safe_match\` only when BOTH hold:
1. The video filename carries a bracketed fansub/release-group tag (the \`[Group]\` pattern) —
   this is the actual evidence that the release is a hardsub-only encode, not a guess.
2. You have genuinely exhausted the search for an external subtitle for that target — same bar
   as \`no_safe_match\`, not a shortcut to skip searching. Only reach for \`hardsub_assumed\`
   after search has come up empty, never before.

This is a POSITIVE outcome — you are recording "this episode's subtitles are already in the
video, no action needed" — not a failure. Do not use it as a way to avoid searching, and do not
use it for a target whose filename has no group tag: an untagged file with no external
candidate is still genuinely \`no_safe_match\` (you do not know why nothing was found), not
\`hardsub_assumed\` (you have no positive evidence subtitles are burned in).`
    : ''

  const content = `
# Find-Subtitle Judgment Playbook

## The one rule that overrides everything else

You judge whether a candidate subtitle BELONGS to an exact video by its METADATA and
CONTEXT — release name, native name, filelist entries, season/episode numbers, and the
structural inspection signals (cue count, time span, detected script) of a file you have
actually downloaded and opened. You judge the way a person picking a subtitle off a fansub
site would: by what the file is labeled and what it structurally looks like.

You MUST NOT judge a candidate by its dialogue content or storyline — opening a file to check
its cue count and time span is fine (that is structural inspection, not judging by story
content); reasoning about what the characters say is not your job and is not necessary.
You MUST NOT compute or report a numeric confidence score anywhere — report a verdict and a
plain-language reason, never a number claiming certainty.

## Your task is a BATCH: harvest every target you safely can

Your task carries a list of TARGET items — the current subtitle gaps of one series (possibly
spanning several seasons, if that is what actually exists on disk) or one movie. The list is a
FACT sheet prepared for you: each row has an itemId, season/episode numbers, an optional
absolute episode number, and the video filename. The orchestrator scoped this list by judging
the on-disk reality — if only season 3 exists on disk, your targets are season 3; if three
seasons all have gaps, one good complete-series collection may cover every target in one sweep.

Work through the list like a person who just downloaded a season pack and is filing subtitles
next to each episode:
- Verify and install PER TARGET: each installation is its own belonging judgment for that
  exact video. A pack that matched target 1 is strong context for target 2, but you still
  check target 2's entry before installing it.
- If you are unsure about ONE target, SKIP THAT TARGET and keep going — report it as
  no_safe_match with your reason. Never abandon the whole batch (or a good pack) because a
  single episode's entry is ambiguous, and never install a doubtful file just to complete the
  set: a wrong subtitle silently installed is worse than a gap.
- You do not have to exhaust every target from one candidate: different targets may be served
  by different candidates, and re-searching between targets is normal.

## Season packs and collections are NORMAL — internalize this before you judge anything

${packIntro} It is entirely normal for EVERY candidate a search
returns to be a pack — "進擊的巨人 S1+S2+S3+OAD 合集", a "[Fansub] Complete Series 繁中字幕"
bundle, a multi-season or whole-show collection, sometimes with movies/OADs mixed in. A pack
that spans your targets' seasons is a GOOD candidate, NOT something to reject for being a
pack — for a batch task it is the single most efficient hit there is.

Do not hold out for "clean single-episode" candidates: that is the LESS common case and
often does not exist at all. If you keep re-searching for lone single-episode files and
rejecting every pack, you will loop forever and never finalize — that is the exact failure
mode this section exists to prevent.

### How to work with a pack (like scanning a downloaded zip's contents)

A candidate carries a \`fileList\` — the entries inside it, each with an \`index\` and a
\`name\`. Call \`get_candidate(index, detail: 'detailed')\` to read the full fileList of a
pack. Scan it the way a person scans a zip's file listing: find the entry whose name matches
the target you are working on (e.g. an entry named ...S01E01... for your S01E01 target). Then
call \`download_candidate\` with that entry's \`fileIndex\` AND with \`videoFilename\` set to
that target's video file, so the download is staged for the right video. Repeat per target —
the same pack candidate can be downloaded from repeatedly, once per target you are filing.
For a plain single-file candidate (empty fileList, or one entry) pass \`fileIndex: null\`.

Some candidates have NO fileList but still turn out to be a zip with several subtitle files
inside. In that case \`download_candidate\` stages nothing and instead returns
\`archiveEntries\` — the list of subtitle files inside the archive, as a fact for you to
choose from. Read it exactly like a fileList: find the entry matching your current target,
then call \`download_candidate\` again with \`archiveEntryName\` set to that exact entry name.
The choice of which file inside an archive belongs to which target is YOURS, never the
system's.

### When the pack numbers episodes differently than your files do

A target row may include an absolute episode number (a whole-series count the system computed,
e.g. S02E01 of a show whose first season had 25 episodes is absolute episode 26). Fansub packs
OFTEN name files by this absolute number (\`... 26 ...\`) instead of by season+episode
(\`...S02E01...\`) — common for anime, and for resources that slice the series into seasons
differently than your files do. So when a target's \`...S02E01...\` name is nowhere in the
fileList but its absolute number IS, that entry is very likely your episode: use the absolute
number to LOCATE it, then download that fileIndex (or archiveEntryName) for that target.

The absolute number is a HINT for FINDING the file, never proof it belongs. After you download
the located entry, STILL verify its structural signals match a normal episode of this runtime
before installing — exactly as for any candidate. An entry located by absolute number that
looks structurally wrong is still no match for that target. And if no absolute number was
provided (or it does not help), fall back to matching by name/metadata as usual — its absence
is not a blocker.

## Workflow

1. Read the task's media identity (title, alternative/native titles, year) and the TARGETS
   fact list from your instructions — they are fixed for this task, you do not re-derive them.
2. Call \`search_source\` with one or more queries built from the title/native title. It
   returns a result_set_id, a count, and a short top-N preview — NOT the full result set.
3. Use \`list_candidates\`/\`get_candidate\` to page through the result set instead of asking
   for everything at once. Prefer candidates whose release name, native name, or filelist
   entries plausibly cover your targets — a season pack or complete-series collection that
   spans the targets' seasons counts, so read its fileList (\`get_candidate\` detailed) to
   confirm which of your targets are inside and to find each one's fileIndex.
4. If nothing plausible turns up, you MAY call \`search_source\` again with different
   queries (alternate titles, romanizations, a narrower/wider query) — re-searching is
   expected, not a failure.
5. For each target you can locate in a plausible candidate: \`download_candidate\` (with
   \`videoFilename\` naming the target, plus \`fileIndex\`/\`archiveEntryName\` as needed) to
   fetch it into your sandbox and get structural inspection signals. Compare those signals
   against what a normal episode/movie of this runtime should look like (cue count in the low
   hundreds, span roughly matching runtime, decodable, not HTML, script matching your target
   language). A convincing filename sitting on top of implausible structural signals is NOT a
   match — trust the bytes over the label.
6. Only when you have genuinely decided — the way a person would after opening the file —
   call \`install_subtitle\` (with \`videoFilename\` naming the target) to atomically place it
   next to that target's video. If you are not sure about that target, that is no_safe_match
   for that item, not a hopeful guess.
7. Report ONE batch outcome by calling \`finalize\` EXACTLY ONCE, after you have worked
   through the whole target list. The report has ${hardsubMode === 'agent' ? 'four buckets' : 'three buckets'}, and every target's itemId
   must land in exactly one of them, copied VERBATIM from the task's target list (never
   invent, alter, or abbreviate an itemId):
   - \`installed\`: targets you installed — each with the exact path \`install_subtitle\`
     returned, the language tag you installed, the candidate's provider/providerId, and your
     reason.
   - \`no_safe_match\`: targets you genuinely exhausted the real candidates for — pack or
     single, nothing containing that episode could be verified. "I am not confident" belongs
     here, per item, with your reason. It is NOT "there was no clean single-episode file"
     (a pack that spans the season DOES contain it).
   - \`retry_later\`: targets you could not process because of a TRANSIENT failure (a provider
     errored, a download timed out) — the system will bring them back soon. Not for doubt;
     doubt is no_safe_match.${hardsubMode === 'agent' ? `
   - \`hardsub_assumed\`: targets you judge to already carry hardcoded subtitles baked into the
     video — see the dedicated section below for the evidence bar. Only this task's mode makes
     this bucket available to you at all.` : ''}
   Once you have filed every target into a bucket, stop — do not keep looping.

## Language: coverage, not preference

${languageSection}
${hardsubSection}

## Sandbox

You only know about the media directories of THIS task's targets. There is no other directory
in your world — do not ask about, reference, or attempt to construct paths to any other
location. \`install_subtitle\` will refuse anything outside this task's directories regardless.
`.trim()

  return {
    descriptor: {
      name: 'find-subtitle-judgment',
      description:
        `How to harvest a batch task's whole target list (verify belonging and install per target, skip an unsure target without abandoning the pack, report one finalize with installed/no_safe_match/retry_later${hardsubMode === 'agent' ? '/hardsub_assumed' : ''} buckets keyed by verbatim itemIds), how to judge whether a downloaded candidate belongs to an exact video (metadata + structural inspection, never dialogue content, never a confidence score), how to extract each target's episode from the season packs / complete-series collections that ${name} subtitles usually come as (read the fileList, download by fileIndex per target, pick inside un-indexed zips via archiveEntries/archiveEntryName — including using a provided absolute episode number to locate an episode in packs numbered differently than your files), ${isChinese ? 'that Simplified and Traditional are equally good coverage' : `that only ${name} subtitles count as coverage`}${hardsubMode === 'agent' ? ', when a bracketed release-group tag plus exhausted search justifies judging hardsub_assumed instead of no_safe_match' : ''}, and the search→compare→install workflow.`,
    },
    content,
  }
}

/** Canonical Chinese-target instance — the wording pinned by findSubtitleSkill.test.ts's
 *  semantic anchors. The worker builds a per-task instance via makeFindSubtitleSkill
 *  (findSubtitleWorker.ts); this const stays as the zh reference and the test anchor. */
export const FIND_SUBTITLE_SKILL: Skill = makeFindSubtitleSkill('zh')
