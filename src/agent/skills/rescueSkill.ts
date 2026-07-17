// Judgment playbook for the rescue-identify worker (救援官战役 R2). Written as a .ts const
// module, not .md — tsconfig.build.json only compiles .ts (same constraint that shaped
// findSubtitleSkill.ts). Loaded on demand via read_doc — the system prompt only ever sees the
// name+description from the descriptor below.
//
// 主控亲笔（铁律：src/agent/skills/* 只由主控修订，子代理禁触）。判断纪律的出处：
// 救援官 spec §2（docs/design/2026-07-17-rescue-officer-design.md）+ DxD 案实证
// （2026-07-17：一条假 override 让 Prickly Heat 幽灵入册——停车谦逊是对的，救援官只把
// "查一下就能确认"的清掉，绝不把"猜一下大概是"的放进来）。
//
// 决策模型（与 R1 收割器的契约）：三个决策工具（claim_directory/exclude_extras/keep_parked）
// 只做"验证+登记于痕迹"，**不落库**；唯一的生效通道是 finalize 的逐组结局清单——runner 收割
// finalize 后走 claimParked 单一实现路径落 override / 改写停车理由。agent 中途死掉=零副作用，
// 与 find-subtitle worker 的 install_subtitle（工具即落盘）不同构，因为救援的"决定"是可整体
// 延迟的纯判断，而下载安装天然是逐步副作用——两者各取所安。
import type { Skill } from './types.js'

export const rescueSkill: Skill = {
  descriptor: {
    name: 'rescue-identify-playbook',
    description:
      'How to identify parked media directories: evidence rules, the two-evidence bar, ' +
      'extras (SP/OVA) judgment, and when to keep a directory parked.',
  },
  content: `# Rescue-identify playbook

You are looking at directories of video files that the automatic scraper could NOT identify.
Your job: for each directory, decide ONE of three outcomes — claim it (you are confident which
TMDB entry it is), exclude it (it is non-episode extras material), or keep it parked (you are
not confident). Every directory in your task MUST appear in your finalize report exactly once.

## The two-evidence bar

Claim a directory ONLY when at least TWO independent pieces of evidence agree on the same TMDB
entry:

1. Name evidence — the directory or file names parse to a title (including romaji, aliases,
   short forms) that matches a TMDB search hit's title or originalTitle.
2. Structure evidence — the file count fits the TMDB season table (e.g. 12 files vs a
   12-episode season), or explicit SxxEyy markers fit an existing season.
3. Year evidence — a year in the path matches the TMDB entry's year (±1).
4. Duration evidence — file durations fit the medium (movie-length file for a movie entry;
   ~20-25 min files for a TV season).

One strong match on name alone is NOT enough — fetch details (get_tmdb_details) and verify a
second signal before claiming. If the second signal contradicts the first (file count does not
fit any season, year is far off), do NOT claim: keep_parked and say what contradicted.

## When unsure, keep parked — never guess

A wrong claim poisons the library with a fake identity (a real incident: a stale test override
enrolled a completely unrelated show; cleaning it up required manual surgery). A kept-parked
directory costs nothing — a human will look at it with your written reason. So:

- If TMDB search returns several plausible candidates and evidence does not single one out,
  keep_parked with a reason listing the top candidates.
- If the directory mixes files that clearly belong to DIFFERENT works, keep_parked and say so
  — one claim covers one directory, and a mixed directory must not be claimed at all.
- If you would have to assume ("probably season 2 because the folder says II"), check the
  season table first; if it still requires assumption, keep_parked.
- Write reasons a human can act on: "matches both 'X (2019)' and 'X (2023)', file count 13
  fits neither season table" beats "unsure".

## Extras (SP / OVA / OAD / Special / 特典)

Mechanical NC-material (NCOP/NCED/Menu/PV/CM/Trailer/Preview) never reaches you — it is
filtered before parking. What reaches you is the grey zone:

- If TMDB season 0 (Specials) has entries that plausibly correspond to the files, OR the files
  run ≥ 15 minutes (story-level specials often have real subtitles), claim the directory with
  season 0 — these are legitimate library items.
- If the files run < 15 minutes AND season 0 offers no plausible match, they are pure bonus
  material: exclude_extras. When durations are null (probe failed), do not treat that as
  "< 15 min" — it is missing evidence; keep_parked instead.

## Tools and the finalize contract

- search_tmdb / get_tmdb_details are your evidence tools — use them freely; searching twice
  with different phrasings (romaji, English, stripped tags) is normal.
- claim_directory / exclude_extras / keep_parked VALIDATE and RECORD a decision but do not
  apply it. The ONLY thing that takes effect is your finalize report. Call finalize exactly
  once, with one outcome per directory, repeating the decisions you recorded. If a decision
  tool returns an error (unknown directory, malformed tmdbId), fix the decision — do not
  carry an errored decision into finalize.
- season in a claim: pass it only when the directory maps to ONE specific season and you
  verified it against the season table; otherwise omit it and let ingest resolve per-file.
`,
}
