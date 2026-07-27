// Identification playbook — split out of findSubtitleSkill.ts on 2026-07-27.
//
// 为什么单独成篇（调研结论 + 六轮血案的教训）：
//  ① progressive disclosure（Anthropic Agent Skills 的核心做法）：SKILL.md 只留索引，大块
//     内容拆成按需加载的独立文档。识别与字幕搜索是两个独立阶段（识别成功但没字幕是完全
//     正常的结局），塞在同一篇里让 Step 0 长到 100+ 行，还把关键步骤埋进中间——正是
//     "lost in the middle" 的稀释位置。
//  ② 措辞不是机制：原文里"不是可选记账"/"是 FAILED run"/"no exceptions"这类强调，是我
//     连续三轮试图用 prose 修一个**代码缺陷**（工具 schema 只收 JSON null，模型的五种发法
//     全被拒）留下的疤。门修好后（coercibleNullableInt + resolveTargetPath）这些强调没有
//     存在理由——"需要靠强调才可靠的步骤，本身就该是代码约束"。这一版按此原则重写：
//     只讲模型无法自己推出的约束（证据门槛、陷阱形态、边界判定），删掉所有劝导性散文。
import type { Skill } from './types.js'

/** 识别文档。仅在 TMDB 证据工具 + write_identified_media 都挂载时才交给模型
 *  （工具不在时连文档名都不出现在索引里——零误触发纪律，同 hardsubSection 的先例）。 */
export function makeIdentifyMediaSkill(): Skill {
  const content = `
# Identifying a Media File from Raw Evidence

You are given raw evidence only — directory names from the path, the file name, duration,
embedded subtitle languages, and mechanically-extracted structure hints (candidate
title/year/season/episode — hints, not truth). Establish WHICH WORK this is before searching
for subtitles. A wrong identity files every subtitle under the wrong show.

## Where the title actually is

The file name is often pure technical tokens with no title in it at all
(\`2026.2160p.iT.WEB-DL.DDP.5.1.Atmos.DV.HDR10+.H.265.mkv\` — year, resolution, source, codec).
In that case the parent directory name is the primary evidence, not a fallback:
\`H）后丨室（2026）4K DV HDR 高码率 简英特效\` is where the title lives.

The evidence is hostile. Known distortions and how they read:

| Raw form | Reads as | Distortion |
|---|---|---|
| \`招z魂4\` | 招魂4 | copyright-evasion letter injection |
| \`H）后丨室\` | 后室 | mojibake: stray full-width bracket, leftover codec letter, 丨 ｜ \| wedged inside a word |
| \`[诸神字幕组][莉可丽丝][01]\` | 莉可丽丝 ep01 | fansub bracket tags |
| \`铁.\` | 铁拳教育 | truncated Chinese title |

Search the repaired native-language title itself, not only romanizations or English guesses.
Never query a bare year, resolution, or codec fragment (\`2026\`, \`iT\`, \`2026 movie\`) — that
returns noise. If your query contains no title, go back to the directory name.

## The two-evidence bar

Call \`search_tmdb\` with your cleaned candidates (re-searching with alternates is expected).
Treat the most promising hit as a SUSPECT, then call \`get_tmdb_details\` on it. Claim the
identity only when two independent lines hold:

- **Name** — TMDB title/original title plausibly matches the file and directory evidence,
  accounting for misspelling, romanization, translation (\`Lycoris Recoil\` = \`莉可丽丝\`).
- **Structure** — TV: the season table actually contains your targets' seasons/episodes and
  the first-air year fits. Movie: TMDB runtime roughly matches your target's duration and the
  year fits.

A year mismatch is an automatic fail regardless of the other line: a runtime matching to the
minute proves nothing when the year is off by a decade (112 minutes fits both The Conjuring
(2013) and unrelated releases). A strong line never buys back a failed one. A rejected suspect
sends you back to the search hits — the next candidate faces the same bar.

Same-name traps are the reason this bar exists: different works share names constantly
(a 2010 film and a 2023 series both called The Rig; a Finnish series and a DC series both
called Peacemaker). Name similarity alone never establishes identity.

When the file name carries no usable title at all, a title candidate can also come from
cross-checking evidence: a numeric-only name like \`2012\` under a \`movies\` directory with a
158-minute duration is worth searching as the literal title \`2012\` — TMDB's 2009 disaster
film runs 158 minutes, and that runtime agreement is the second evidence line.

## When the path carries a [tmdbid-N] tag

Some paths carry an explicit TMDB id — either written by a previous run of this system or by an
external organizer (Sonarr/Radarr and similar). It is the strongest starting point you will get:
skip searching and call \`get_tmdb_details\` on that id directly.

It is a starting point, not a verdict. The tag may be stale or simply wrong — a previous run may
have misidentified the show, or whoever renamed the directory may have typed the wrong number.
So the two-evidence bar still applies in full: the details you get back must match the name
evidence AND the structure evidence. If the tagged id fails the bar, discard it and identify from
scratch (clean a title, search, verify) — do not claim an identity just because a number was
written in the path.

## Identification comes from tools, never from memory

You may know a show well. That knowledge guides which queries you try; it is never a verdict.
A verdict requires a search hit plus a details check that passed the bar in THIS run.

## Once the bar is met

Call \`write_identified_media\` — once per target — with the verified tmdbId and title, each
target's season/episode (movies: leave them out), and the target's file name exactly as shown
in the task facts. The tool returns the own-id (e.g. \`tmdb:1396/s1e1\`); that returned value is
the itemId for every later subtitle operation. You cannot construct it yourself.

Identification and subtitle search are separate jobs with separate outcomes. Writing the
identity is what makes the identification exist; whether subtitles are then found is a
different question, answered per target afterwards (a correctly identified file with no
available subtitle is \`no_safe_match\` for that target, and the identity still stands).

Order: \`search_tmdb\` → \`get_tmdb_details\` → \`write_identified_media\` → subtitle search with
the returned itemId → \`finalize\`.

## No candidate passes

Install nothing, put every target into \`no_safe_match\`, and name the identification problem in
your reason. Guessing an identity is strictly worse than admitting you could not establish one.

## What is NOT an identity problem

The bar is about which work this is — not about whether every target lines up. Once the
identity passes, these are normal and must not send you back to re-identify; the odd target is
handled by ordinary per-target judgment later:

- An episode number outside the season table (an S04E13 file when TMDB says season 4 has 9
  episodes) — a mislabeled, differently-numbered, or multi-episode/special release. Report that
  one target as \`no_safe_match\` if you cannot place it; leave the identity alone.
- A target runtime differing from the show's typical runtime (extended finales, recaps,
  double-length episodes).
- Targets missing from the season table entirely (unaired, specials, numbering offsets).

Discarding a whole series' established identity because one episode looks odd strands every
target of a correctly-identified show. When name and year fit, the identity stands.
`

  return {
    descriptor: {
      name: 'identify-media',
      description:
        'How to identify what a media file actually is from raw evidence before searching for ' +
        'subtitles: find the title in the directory names when the file name is pure technical ' +
        'tokens, repair copyright-evasion/mojibake/fansub-tag/truncation distortions, search_tmdb ' +
        'then get_tmdb_details under a two-evidence bar (name plus season-table/year/runtime, a ' +
        'year mismatch is an automatic fail, never from memory), how to treat an explicit ' +
        '[tmdbid-N] path tag as the strongest starting point but never a verdict (it may be stale ' +
        'or wrong — verify it against the same bar), write_identified_media per target ' +
        'and continue with the itemId it returns, no_safe_match when nothing passes the bar, and ' +
        'which per-target oddities (out-of-range episode, unusual runtime, missing from season ' +
        'table) are NOT reasons to re-identify.',
    },
    content,
  }
}

/** 单实例——识别文档不随语言/档位变化（识别是语言无关的）。 */
export const IDENTIFY_MEDIA_SKILL: Skill = makeIdentifyMediaSkill()
