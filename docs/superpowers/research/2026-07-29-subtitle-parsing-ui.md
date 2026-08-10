# Subtitle parsing + inspection UI research (2026-07-29)

Scope: `.ass`/`.srt` parsing in TypeScript, browser ASS rendering (JASSUB), and
the two-track comparison-strip visualization for `subtitle-scout`.

Labels used throughout:
- **[SOURCED]** — verified against a primary source (repo file, npm registry, issue thread) with URL.
- **[INFERENCE]** — my reasoning, not directly stated by a source.
- **[UNVERIFIED]** — could not confirm; test plan stated.

## Progress log

- `2026-07-29 T0` — file created with skeleton. No searches run yet.
- `T1` — **npm registry sweep done** (18 packages, direct registry.npmjs.org + api.npmjs.org
  downloads endpoint). Hard numbers in Q1 table. Key finding: `ass-compiler` is alive
  (0.1.16, 2025-11-09), `jassub` is very alive (2.5.11, 2026-07-25); `ass-parser`,
  `subsrt`, `matroska-subtitles`, `libass-wasm` are all abandoned (2018–2022).
- `T2` — **read `ass-compiler` source line-by-line** (parser/*.js + stringifier.js + types)
  and **ran it locally against a synthetic Chinese-fansub ASS file** (`npm i ass-compiler@0.1.16`).
  Confirmed round-trip IS lossy, with 6 specific named losses. Settles the shift-strategy
  question empirically rather than by guesswork.
- `T3` — **benchmarked encoding detection locally** (`chardet` vs `jschardet` vs `iconv-lite`)
  against generated GBK/GB18030/Big5/UTF-8±BOM/UTF-16LE byte streams. Both detectors
  perfect on realistic files; both fail on <10-byte inputs. Picked `chardet`+`iconv-lite` (MIT).
- `T4` — **Q2 JASSUB done thoroughly.** Read README + `dist/*.d.ts` from the real
  `npm pack jassub@2.5.11` tarball + `src/worker/worker.ts` + 8 issue threads via GitHub API.
  Confirmed `manualRender()` exists with exact signature; **measured real WASM size (2.0 MiB
  x2 binaries, 4.2 MiB dir)**; **corrected the brief's option names** (`fallbackFont` and
  `addFont` do NOT exist — it's `defaultFont` and `addFonts`); found the **CJK fallback
  problem is declared unfixable by the maintainer** (#46, #27) — this is the top risk.

## Executive summary

_pending_

## Q1 parsing

### Package landscape — registry facts

All rows **[SOURCED]** from `registry.npmjs.org/<pkg>` and
`api.npmjs.org/downloads/point/last-week/<pkg>`, fetched 2026-07-29.

| package | latest | published | dl/week | TS types | module | verdict |
|---|---|---|---|---|---|---|
| `ass-compiler` | 0.1.16 | 2025-11-09 | 2,966 | **yes** | ESM | **maintained**, ASS-specialist |
| `subtitle` (subtitle.js) | 4.2.2 | 2025-11-16 | 45,460 | yes | CJS | maintained, **SRT/VTT only** |
| `srt-parser-2` | 1.2.3 | 2023-05-14 | 130,138 | yes | ESM | stale but SRT is a frozen format |
| `@plussub/srt-vtt-parser` | 2.0.5 | 2024-07-29 | 17,703 | yes | ESM | tiny, SRT/VTT only |
| `node-webvtt` | 1.9.4 | 2022-05-17 | 128,090 | no | CJS | VTT only, irrelevant |
| `subsrt-ts` | 2.1.2 | 2023-10-17 | 2,868 | **yes** | ESM | TS fork of subsrt; multi-format |
| `subsrt` | 1.1.1 | 2019-10-29 | 1,716 | no | CJS | **abandoned** — use `subsrt-ts` |
| `ass-parser` | 0.2.0 | **2018-01-08** | 145 | no | CJS | **abandoned** |
| `ass-to-vtt` | 1.2.0 | 2018-04-26 | 322 | no | CJS | **abandoned** |
| `matroska-subtitles` | 3.3.2 | 2021-09-20 | 719 | no | CJS | abandoned; only for MKV extraction |
| `jassub` | **2.5.11** | **2026-07-25** | 16,756 | no (see Q2) | ESM | **the live renderer** |
| `libass-wasm` (SubtitlesOctopus) | 4.1.0 | 2022-12-04 | 5,297 | no | CJS | **abandoned upstream** |
| `@jellyfin/libass-wasm` | 4.2.4 | 2026-01-13 | 4,795 | no | CJS | Jellyfin's maintained fork |

Encoding-detection candidates, same method:

| package | latest | published | dl/week | TS types | note |
|---|---|---|---|---|---|
| `iconv-lite` | 0.7.3 | 2026-07-03 | 272.9M | yes | de-facto standard decoder |
| `chardet` | 2.2.0 | 2026-06-20 | 56.5M | yes | ICU-derived detector, actively released |
| `jschardet` | 3.1.4 | 2024-09-30 | 1.44M | yes | port of Mozilla universalchardet |
| `encoding-japanese` | 2.2.0 | 2024-06-08 | 4.71M | no | JP-centric; not right for GB18030/Big5 |

Observations:
- **Nothing except `ass-compiler` is a serious ASS-with-styles parser that is still
  maintained.** `ass-parser` (the obvious-sounding name) last shipped in Jan 2018 and gets
  145 downloads/week. `subsrt-ts` handles `.ass` but, per its lineage from `subsrt`,
  treats it as a generic caption format. **[INFERENCE]** that means override tags and the
  `[V4+ Styles]` section are not first-class.
- `jassub` published **four days ago** at time of research and is a hard dependency-light
  ESM package — this is the healthy successor to both `libass-wasm` and the Jellyfin fork.
- The download-count comparison is misleading for the ASS packages: 2,966/wk for
  `ass-compiler` looks small next to `srt-parser-2`'s 130k, but SRT parsing is used by
  every transcription tool on earth while ASS is a niche. Judge `ass-compiler` on
  recency + types, not volume.


### `ass-compiler` API — verified from source

**[SOURCED]** `src/index.js` exports exactly four functions
(https://github.com/weizhenye/ass-compiler/blob/master/src/index.js):

```js
export { parse }      from './parser/index.js';   // raw ASS text -> ParsedASS tree
export { stringify }  from './stringifier.js';    // ParsedASS tree -> ASS text
export { compile }    from './compiler/index.js'; // -> renderer-oriented flat form
export { decompile }  from './decompiler.js';     // CompiledASS -> ASS text
```

Repo health **[SOURCED]** via GitHub API `repos/weizhenye/ass-compiler`: 137 stars,
**0 open issues**, last push `2025-11-09`. Small but tended.

Types ship at `types/index.d.ts` (`package.json#types`), hand-written, and are good:
`ParsedASS = { info: ScriptInfo, styles: ParsedASSStyles, events: ParsedASSEvents }`,
where `ParsedASSEvents = { format: string[], comment: ParsedASSEvent[], dialogue: ParsedASSEvent[] }`.

Two facts that matter enormously for our line list, both **[SOURCED]** from the type defs
and confirmed at runtime:

1. **`Start`/`End` are already `number` (seconds as float)**, not strings.
   `parser/time.js` is `t[0]*3600 + t[1]*60 + t[2]*1`. No time parsing work for us.
2. **`Text` is an object, not a string**: `{ raw, combined, parsed }`. `raw` is the
   original text field verbatim; **`combined` is the plain text with all `{\...}`
   override blocks stripped** — exactly what the dialogue-line list needs, for free.
   `parsed[]` is the per-fragment `{tags, text, drawing}` breakdown.

**Comment vs Dialogue is separated at parse time** into `events.comment[]` and
`events.dialogue[]` (`parser/index.js` keys the push by `key.toLowerCase()`). The classic
naive-parser bug of showing `Comment:` staff-credit lines as dialogue does not apply if we
read `events.dialogue` only. **[SOURCED]**

### Verified runtime behaviour on a Chinese-fansub-style file

I built a sample with `方正准圆_GBK` / `小塚ゴシック Pr6N B` styles, `\N` breaks, `\fad`,
`\pos`, karaoke `\k`, `\an8`, `\1c` colour, a `\p1` vector drawing, a `\t` animation, an
`[Aegisub Project Garbage]` section, and both a full-width and an ASCII comma in text.

What worked **[SOURCED, ran locally]**:
- 6 dialogue + 1 comment correctly split.
- `Start=1.5`, `End=4.2` floats.
- `Text.combined` for the `\an8\c&H00FF00&` line → `"上方绿字，含逗号, 这样"` — the
  **ASCII comma inside the text field is preserved**, because `parser/dialogue.js`
  re-joins overflow fields:
  `if (fields.length > format.length) { textField = fields.slice(format.length-1).join() }`.
- `[V4 Styles]` (old SSA, not `V4+`) parses too — regex is `/^\[V4\+? Styles\]/i`.
- Non-standard `[Script Info]` keys like `YCbCr Matrix: TV.709` are preserved (`info` is
  an index-signature bag).
- `;`-prefixed comment lines are skipped (`if (/^;/.test(line)) continue;`).
- `\N`, `\n`, `\h` are left as literal escapes in `Text.combined` (verified:
  `"a\hb\nc\Nd"` comes back verbatim). **So we must handle `\N`→newline and `\h`→nbsp
  ourselves in the line list.** Not a bug, but a required step.

### Round-trip IS LOSSY — six confirmed losses

I parsed the sample and `stringify()`d it back. Diffs, all **[SOURCED, ran locally]**:

| # | Loss | Cause |
|---|---|---|
| 1 | **`[Aegisub Project Garbage]` section deleted entirely** | `parse` sets `state=0` for unknown `[...]` sections and drops them; `stringify` only ever emits `[Script Info]`, `[V4+ Styles]`, `[Events]` |
| 2 | **`; Script generated by Aegisub 3.2.2` header comments deleted** | `parse` skips `/^;/` lines and never stores them |
| 3 | `MarginL/R/V: 0` → **`0000`** | `stringify`'s `event[fmt] \|\| '0000'` |
| 4 | `{\c&H00FF00&}` → **`{\1c&H00FF00&}`** | `parseTag` normalizes bare `c` to `c1`; `stringifyTag` re-emits `/^[ac]\d$/` as `\1c` |
| 5 | `{\t(0,500,\frz360)}` → **`{\t(0,500,1,\frz360)}`** | `accel` defaulted to 1 and always re-emitted |
| 6 | **Comment and Dialogue lines re-sorted and interleaved by time** | `stringify` concats both arrays then `.sort((a,b)=>a.start-b.start)` |

Losses 4 and 5 are *semantically* equivalent ASS. Losses 1, 2, 3, 6 are **cosmetic but
destructive to the user's file** — an editor's project state (`Audio File:`, `Active Line:`)
is silently thrown away. For a tool operating on someone's fansub library that is not
acceptable.

Also, `stringify` always writes the literal header `[V4+ Styles]`, so an input SSA file
with `[V4 Styles]` and a 3-field Format is rewritten as V4+ — a format change.

### The killer edge case: `Text` not last in `Format:`

**[SOURCED, ran locally].** `parser/dialogue.js` assumes the overflow field is the **last**
one. With a reordered `Format: Layer, Start, End, Style, Text, Name, ...` and text
containing an ASCII comma:

```
Dialogue: 0,0:00:01.00,0:00:02.00,Default,hello, world,,0,0,0,
  ->  Text = "hello"   Name = "world"    // WRONG, silently
```

With CJK text using full-width `，` this never triggers, which is why 68%-`.ass`
Chinese-fansub libraries mostly get away with it. **[INFERENCE]** Reordered `Format:` with
`Text` non-final is rare (Aegisub always writes Text last), so this is a low-probability,
high-silence bug. Mitigation: on load, assert
`events.format.at(-1) === 'Text'` and warn/fall back if not. Cheap, worth doing.

### Float drift on timestamp shift

**[SOURCED, ran locally]** `1.5 + 0.1 + 0.1 + 0.1 === 1.8000000000000003`. Since
`Start`/`End` are floats in seconds, shift arithmetic accumulates IEEE754 error.
`stringifyTime` does `Number.parseFloat(tf.toFixed(2))`, i.e. it *rounds to centiseconds
on output* — I verified `0:00:01.50`, `1:23:45.67`, `0:00:00.01`, `2:59:59.99` all
round-trip exactly. Drift is therefore masked at serialization. **[INFERENCE]** Still, do
shift math in **integer centiseconds** internally so comparisons and diffs stay exact.

Note `stringifyTime` emits `h:mm:ss.cc` with **unpadded hours** — matches the ASS spec
(`0:00:01.50`), so that is correct, not a bug.

### SRT side (32% of library)

SRT is a trivially simple, frozen format. Candidates that are maintained and typed:
`subtitle`@4.2.2 (45k dl/wk, actively released 2025-11-16) and `@plussub/srt-vtt-parser`@2.0.5.
`srt-parser-2` has the biggest install base (130k/wk) but last shipped 2023-05.

**[INFERENCE]** For SRT specifically, hand-rolling is ~40 lines and removes a dependency,
because the only real-world variances are: CRLF vs LF, BOM, `,` vs `.` as the ms separator,
missing/duplicate index numbers, and blank-line-in-cue. A dependency does not save
meaningful work here and `subtitle`@4.2.2 pulls in `multipipe`/`split2`/`strip-bom`
(stream-oriented API we don't want). Lean hand-roll, or `@plussub/srt-vtt-parser` (zero
deps, ESM, typed) if we want it off our plate.

### Encoding detection — benchmarked locally

Method **[SOURCED, ran locally]**: generated real byte streams with Python
(`.encode("gb18030"/"gbk"/"big5"/"utf-8"/"utf-16-le")`), then ran `chardet@2.2.0`,
`jschardet@3.1.4`, and decoded with `iconv-lite@0.7.3`.

Realistic ASS files (ASCII-heavy header + `[V4+ Styles]` + ~40 dialogue lines):

| file | `chardet.detect` | `jschardet` (conf) | decode sane? |
|---|---|---|---|
| GBK, short CJK payloads | **GB18030** (conf 100) | GB2312 0.99 | yes |
| Big5, short CJK payloads | **Big5** (conf 100) | Big5 0.99 | yes |
| GBK bilingual CN+EN | **GB18030** (conf 100) | GB2312 0.99 | yes |
| pure GB18030 | GB18030 | GB2312 0.99 | yes |
| Big5 | Big5 | Big5 0.99 | yes |
| UTF-8 + BOM | UTF-8 | UTF-8 1.00 | yes |
| UTF-8 no BOM | UTF-8 | UTF-8 0.99 | yes |
| UTF-16LE + BOM | UTF-16LE | UTF-16LE 1.00 | yes |

**Both detectors are effectively perfect on realistic subtitle files.** `chardet.analyse()`
returns a ranked list; on the GBK file the runner-up (`ISO-8859-1`) scored 36 vs 100, so
confidence separation is wide and a threshold check is meaningful.

**The one real failure mode [SOURCED, ran locally]:** a *very short* file. `"我们走吧"`
alone (8 bytes GBK) → `chardet` says **KOI8-R**, `jschardet` says **TIS-620 @ 0.40**. Both
wrong, producing mojibake. **[INFERENCE]** Irrelevant for us in practice — a real subtitle
file always carries an ASCII `[Script Info]`/`Format:` skeleton plus hundreds of CJK lines,
which is exactly the high-signal case. But it means: **never run detection on a truncated
head of the file.** Feed the detector the whole buffer, or at minimum tens of KB.

`iconv-lite` codec coverage verified at runtime: `gb18030` ✅, `big5` ✅, `big5hkscs` ✅,
`cp950` ✅. Note `chardet` returns the label `"GB18030"` and `iconv-lite` accepts it
directly — no name mapping needed for the CJK cases we care about.

Maintenance status **[SOURCED]** (registry):
- `chardet`@2.2.0, **2026-06-20**, 56.5M dl/wk, MIT, typed → *actively maintained*.
- `iconv-lite`@0.7.3, **2026-07-03**, 272.9M dl/wk, MIT, typed → *actively maintained*.
- `jschardet`@3.1.4, 2024-09-30, 1.44M dl/wk, **LGPL-2.1+** → maintained-ish, but the
  licence is the reason to skip it: LGPL in a bundled product invites questions that MIT
  does not.
- `encoding-japanese`@2.2.0 — JP-centric; wrong tool for GB18030/Big5. Reject.

**Recommendation: `chardet` + `iconv-lite`.** Both MIT, both released within the last two
months, both typed. Skip `jschardet` (LGPL, and no accuracy advantage in my runs).

**BOM handling [INFERENCE]:** strip the BOM explicitly after decoding —
`text.replace(/^\uFEFF/, '')`. `iconv-lite` has a `stripBOM` option for some codecs but
relying on a leading U+FEFF never reaching `ass-compiler` matters: an unstripped BOM would
make the first line `\uFEFF[Script Info]`, which fails the `/^\[Script Info\]/i` regex and
silently yields an empty `info` object. **This is a concrete, likely bug — worth a test.**

### Decision for Q1

- **`.ass` → `ass-compiler`@0.1.16** for reading (parse only). Typed, maintained,
  gives us `Start`/`End` as numbers and `Text.combined` as pre-stripped plain text, which
  is precisely the line-list shape.
- **`.srt` → hand-roll (~40 lines)**, or `@plussub/srt-vtt-parser` if we want zero
  maintenance. Do not pull `subtitle`@4.2.2 just for this — stream API, 4 transitive deps.
- **Never `stringify()` a user's ASS file.** Use line-level regex rewriting for shifts
  (full rationale in *Recommended stack*).

## Q2 JASSUB

Repo health **[SOURCED]** GitHub API `repos/ThaUnknown/jassub`: **192 stars, 2 open issues,
last push 2026-07-25**, repo licence MIT (package licence is the compound
`LGPL-2.1-or-later AND (FTL OR GPL-2.0-or-later) AND MIT AND ...` because it statically
links libass/FreeType). Actively maintained — this is the right renderer, not a gamble.

Note: `jassub` **replaces** `libass-wasm`/SubtitlesOctopus (last publish 2022-12-04) and is
newer than `@jellyfin/libass-wasm`@4.2.4 (2026-01-13). Same lineage, JASSUB is the live one.

### Q2a. Can it render at an arbitrary timestamp with no `<video>`? — YES, confirmed

**[SOURCED]** README "Using only with canvas" section
(https://github.com/ThaUnknown/jassub/blob/main/README.md) plus the shipped type
declaration `dist/jassub.d.ts` from the actual 2.5.11 tarball (`npm pack jassub@2.5.11`).

The exact signature — **not** a `setCurrentTime` API, it is `manualRender`:

```ts
manualRender(
  data: Pick<VideoFrameCallbackMetadata,
    'expectedDisplayTime' | 'width' | 'height' | 'mediaTime'>,
  repaint?: boolean
): Promise<void>
```

Documented usage:

```js
const instance = new JASSUB({ canvas: document.querySelector('canvas'), subUrl: './sub.ass' })
await instance.ready
instance.manualRender({
  expectedDisplayTime: performance.now(),
  width: 1920, height: 1080,
  mediaTime: 10.20            // <-- the arbitrary timestamp, in SECONDS
})
```

`mediaTime` is the subtitle timestamp; `expectedDisplayTime` is a `performance.now()`-domain
wall-clock value (it comes from the `requestVideoFrameCallback` metadata shape). This is
**exactly** our "styled preview at a chosen timestamp" use case — no `<video>` needed.

Also **[SOURCED]** from the same `.d.ts`, the options type enforces at the type level that
you supply *either* `video` *or* `canvas*, and *either* `subUrl` *or* `subContent`:

```ts
type JASSUBOptions = { /* ...tunables... */ }
  & ({ video: HTMLVideoElement; canvas?: HTMLCanvasElement }
   | { video?: HTMLVideoElement; canvas: HTMLCanvasElement })
  & ({ subUrl: string; subContent?: string }
   | { subUrl?: string; subContent: string })
```

`subContent: string` means **we can feed the ASS text we already have in memory** — no need
to write a temp file or serve a URL. Important: it accepts the *raw ASS string*, so our
`ass-compiler` parse and JASSUB's render are two independent consumers of the same original
text. We never have to re-serialize to render. **That is a major architectural win.**

**Correction to the brief's assumptions:** the package is **fully typed** (`index.d.ts` +
`src/**/*.ts` are in `package.json#files`, and every `dist/*.d.ts` ships). My earlier
registry table said "no types" because there is no `types` field in `package.json` — that
was wrong in effect; TS resolves `dist/jassub.d.ts` via the `main`-adjacent `.d.ts`.
**[SOURCED]** — verified the `.d.ts` files are present in the tarball listing.

### Q2b. Bundle cost — measured from the real tarball

**[SOURCED]** `npm pack jassub@2.5.11` then `du`/`ls -la`:

| asset | size | notes |
|---|---|---|
| `dist/wasm/jassub-worker.wasm` | **2,066,765 B (~1.97 MiB)** | non-SIMD fallback |
| `dist/wasm/jassub-worker-modern.wasm` | **2,137,124 B (~2.04 MiB)** | SIMD build |
| `dist/wasm/` total | **4.2 MiB** | *both* wasm binaries ship |
| `dist/default.woff2` | **145,972 B (~143 KiB)** | bundled default font |
| `dist/worker/` | 164 KiB | worker + 4 renderer backends |
| `dist/jassub.js` | 12 KiB | main-thread glue |

**~2 MiB of WASM transferred per session** (only one of the two binaries is fetched at
runtime — `JASSUB._supportsSIMD` / `static _test()` picks). Plus 143 KiB font.
**[INFERENCE]** On a low-power router serving this, that's fine for bandwidth (it's LAN /
one-time, and gzip/brotli takes wasm down substantially) but note the **WASM compile +
libass init cost on a weak client CPU** is the real concern, not the download.

Runtime deps are 4 and all tiny: `abslink` (worker RPC proxy), `lfa-ponyfill`,
`rvfc-polyfill`, `throughput`. **[SOURCED]** `package.json`.

Note the README is **stale on asset paths**. It says
`jassub/dist/jassub-worker.js?worker&url` and `jassub/dist/jassub-worker.wasm?url`, but the
2.5.11 tarball actually has them at **`dist/wasm/jassub-worker.js`** and
**`dist/wasm/jassub-worker.wasm`**. **[SOURCED]** tarball file listing vs README. If we
override `workerUrl`/`wasmUrl` we must use the `dist/wasm/` paths, not the README's.

### Q2c. Vite configuration — real, and there are real traps

The README claims overriding worker/wasm URLs "shoud almost never be necessary". The issue
tracker disagrees; this is the single most-reported category (9 issues matching "vite").

**[SOURCED]** Maintainer's own minimal Vite config
(https://github.com/ThaUnknown/jassub/blob/main/vite.config.js) — the only thing it does is
set the threading headers:

```js
server: { headers: {
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Opener-Policy': 'same-origin',
}}
```

The demo app config (gh-pages `vite.config.ts`) additionally uses
`worker: { format: 'es' }`, `build.target: 'es2020'`, and `COEP: 'credentialless'`.
**[SOURCED]**

Traps found in issues:
- **COOP/COEP headers.** README **[SOURCED]**: SharedArrayBuffer multi-threading needs
  them, but *"if you can't set them, it will fallback automatically to work in
  single-threaded mode"*. So they're an optimization, not a hard requirement. **[INFERENCE]**
  For our Docker-on-router deployment, setting these two headers is easy but has a real
  side effect: `require-corp` breaks cross-origin images/iframes elsewhere in the app.
  `credentialless` (what the demo uses) is the softer choice. Since our preview is a static
  frame + subtitle overlay, single-threaded fallback is likely acceptable — **decide by
  measuring, don't set COEP blindly.**
- **[#65 "Worker doesn't load wasm"](https://github.com/ThaUnknown/jassub/issues/65)** —
  `await jassub.ready` hangs forever with *no console error*. Contributor `@Sapd` diagnosed
  it as a CJS/ESM interop problem: `throughput` is CommonJS but jassub imports it as ESM.
  Their fix **[SOURCED]**:
  ```js
  optimizeDeps: { exclude: ['jassub'], include: ['throughput', 'jassub > throughput'] }
  ```
  Maintainer's counter-position: old Vite versions have broken worker support, update Vite.
  Reporter (`@zoriya`) never resolved it and **stayed on v1.x**. Bun and Expo/RN are
  explicitly unsupported ("I have low interest in making fixes for broken tooling like bun").
  **[INFERENCE]** We're on Vite (good, the supported path), but *"`ready` never resolves,
  silently"* is a genuine failure mode. **Mitigation: race `instance.ready` against a
  timeout and surface a real error in the UI rather than an infinite `Skeleton`.**
- **[#6](https://github.com/ThaUnknown/jassub/issues/6)** wasm import breaks specifically in
  *production* builds while dev works; **[#59](https://github.com/ThaUnknown/jassub/issues/59)**
  `TypeError: s.JASSUB is not a constructor` with Vite/Astro; **[#41](https://github.com/ThaUnknown/jassub/issues/41)**
  default config works in dev, breaks after build. **The pattern is dev-vs-prod asset
  resolution divergence — we must test the built bundle, not just `vite dev`.**

### Q2d. Fonts — and the CJK problem, which is our biggest risk

**Correct option names, [SOURCED] from `dist/jassub.d.ts`** (`JASSUBOptions`):

```ts
fonts?: Array<string | Uint8Array>              // preload eagerly
availableFonts?: Record<string, Uint8Array | string>  // lazy, keyed by family name
defaultFont?: string                            // <-- NOT "fallbackFont"
queryFonts?: 'local' | 'localandremote' | false
libassMemoryLimit?: number
libassGlyphLimit?: number
```

**The brief's guessed names are partly wrong:**
- `availableFonts` ✅ exists, exactly that name.
- `fallbackFont` ❌ **does not exist** in 2.5.11. The option is **`defaultFont`**, and the
  runtime setter is **`renderer.setDefaultFont(fontName)`**. (`fallbackFont` was the *old*
  SubtitlesOctopus/v1 name — issue [#41](https://github.com/ThaUnknown/jassub/issues/41)
  shows someone passing `fallbackFont` and it silently doing nothing.)
- `addFont` ❌ singular does not exist. It is **`renderer.addFonts(fontOrURLs: Array<Uint8Array | string>)`**
  — plural, takes an array, returns `Promise<boolean>`. **[SOURCED]** `dist/worker/worker.d.ts`.
- Also gone: `useLocalFonts` (v1) → replaced by `queryFonts: 'local' | 'localandremote' | false`.

`availableFonts` keys are **case-insensitive and matched by font *family* name**, per README
and confirmed by [#41](https://github.com/ThaUnknown/jassub/issues/41)'s resolution:
> *"Nevermind figured it out, I had to set the font family as the key and not the font name."*

#### What happens when a style's font is missing

**[SOURCED]** `src/worker/worker.ts` lines ~177-179 — the fallback is driven by *scraping
libass's own log output*:

```ts
const match = log.match(/JASSUB: fontselect:[^(]+: \(([^,]+), (\d{1,4}), \d\)/)
if (match && !await this._findAvailableFont(match[1]!.trim().toLowerCase(), WEIGHT_MAP[...])) {
  await this._findAvailableFont(this._defaultFont)
}
```

So the chain is: libass fails `fontselect` → logs → JASSUB regex-matches the family name →
tries `availableFonts` → tries `queryFonts` (local, then Google Fonts) → falls back to
`_defaultFont`. If *that* also lacks the glyph, you get **tofu / blank**, not graceful
degradation.

The concrete error string seen in the wild **[SOURCED]** [#41](https://github.com/ThaUnknown/jassub/issues/41):
```
JASSUB: fontselect: failed to find any fallback with glyph 0x0 for font: (Arial, 400, 0)
```

#### CJK fallback: the maintainer says this is unsolvable in libass

This is the finding that most affects us, since **68% of the library is Chinese fansub ASS**
with styles like `方正准圆_GBK`, `文鼎PL細上海宋`, `小塚ゴシック Pr6N B`.

**[SOURCED]** [#46 "Render non-Latin or CJK subtitles with the fallback font"](https://github.com/ThaUnknown/jassub/issues/46).
Reporter shows a screenshot of broken CJK rendering with external subs and no embedded
fonts. Maintainer `@ThaUnknown`:
> *"yes, the fallback font can't handle them because the font map can't be big enough to fit
> them, even if it was the font would be like 20MB, you need to add a font which supports
> those characters, and set the subtitles to use that font"*

Reporter asks for a *list* of fallback fonts tried in order. Maintainer:
> *"local fonts can't detect what characters the font supports without loading all of them,
> which is excessive, you're asking for a series of impossible things here ... either the
> fallback font needs to support the characters specified in the subtitles, or the font
> specified in the subtitles need to support the characters"*

**[SOURCED]** [#27 "Are multiple fallback fonts possible?"](https://github.com/ThaUnknown/jassub/issues/27)
— same request, explicitly for Japanese/Chinese/English mixed content. Maintainer:
> *"no it's not possible as libass doesn't expose this kind of functionality, I recommend
> you compile the fonts into one file"*

**Consequences for us, [INFERENCE] but tightly grounded:**
1. The bundled `default.woff2` (143 KiB) is **Liberation Sans** (string present in
   `dist/jassub.js` **[SOURCED]**) — **zero CJK coverage**. Out of the box, a Chinese
   fansub `.ass` whose font isn't available renders as **tofu or blank**.
2. There is **no multi-font fallback chain**. One `defaultFont`, one glyph set.
3. Therefore we **must ship at least one broad CJK font ourselves** and register it as
   `defaultFont`, or CJK previews are broken for the majority of the library.
4. A full `Noto Sans CJK SC` is ~10-20 MB per weight — unacceptable on a low-power router
   alongside 2 MiB of WASM. Realistic options:
   - **Subset the CJK font to the glyphs actually present in the file being previewed.**
     We already parse the file, so we know the exact glyph set from `Text.combined`.
     Build a subset on the backend and hand it in as a `Uint8Array` via `fonts: []`.
     **[INFERENCE]** This is the highest-quality answer and is genuinely feasible because
     the preview is one timestamp of one file, not a whole library. Needs a subsetter
     (`fonttools`/`subset-font`/`harfbuzzjs`) on the backend — **unverified whether that's
     acceptable in our Docker image; flag as a task.**
   - Ship one pre-subsetted CJK font covering common Hanzi (e.g. GB2312's 6,763 chars ≈
     1-3 MB woff2) as `defaultFont`. Simpler, mostly right, breaks on rare glyphs.
   - Use MKV-embedded fonts when present via the `fonts` option (this is the case JASSUB is
     designed for, and matches `matroska-subtitles`-style attachment extraction).
5. **Font *identity* will be wrong even when glyphs render.** `方正准圆_GBK` (FZZhunYuan) is
   a commercial Chinese font we cannot ship. So the preview is
   **"correct text, correct layout/position/colour, approximate typeface."**
   **We should say so in the UI** — a `Badge`/`StatusDot` reading "字体已替换 / font
   substituted" is honest and cheap. Silently showing a wrong typeface in a *subtitle
   inspection tool* undermines the tool's purpose.

Other font issues worth knowing:
- **[#67](https://github.com/ThaUnknown/jassub/issues/67)** *"fonts preload is not awaited in
  `_ready`, causing fontselect failures"* (closed) — historical race between font preload and
  first render. **[INFERENCE]** reinforces: always `await instance.ready` **and** consider
  awaiting `renderer.addFonts([...])` before the first `manualRender`.
- **[#73](https://github.com/ThaUnknown/jassub/issues/73)** "Missing default.woff2 font" —
  bundlers failing to emit the font asset. Another dev-vs-prod asset trap.
- README **[SOURCED]**: `queryFonts: 'localandremote'` pulls fonts from **Google Fonts API**
  and *"loads 50+ KB of code"*. For a self-hosted router box this is an unwanted external
  network dependency and a privacy leak. **Recommend `queryFonts: false`** and supply fonts
  explicitly.
- README **[SOURCED]**: FOUT (flash of unstyled text) happens with `availableFonts` because
  loading is async; preloading via `fonts: []` avoids it. For a static single-frame preview,
  **[INFERENCE]** preload and render once — do not use lazy `availableFonts` for the
  preview path, or we may screenshot/paint the un-styled frame.

### Q2e. React integration — the lifecycle hazards are real

`instance.renderer` is an **`abslink` `Remote<ASSRenderer>` proxy over a Worker**, so
**every** renderer call is async. README is emphatic **[SOURCED]**:
> *"`instance.renderer` calls are ALWAYS async as it's a remote worker, which means you
> should always await/then them for the IPC call to be serialized!!!"*
> *"Make sure to always `await instance.ready` before running any methods!!!"*

And a subtle trap **[SOURCED]** — property *reads* need awaiting too:
```ts
const x = instance.renderer.useLocalFonts        // does nothing, returns IPC proxy object
const y = await instance.renderer.useLocalFonts  // returns true/false
```

Disposal: **[SOURCED]** `dist/jassub.d.ts` declares `destroy(): Promise<void>` and fields
`_destroyed: boolean`, `_ro: ResizeObserver`, `_worker: Worker`, plus
`_removeListeners()`. So there *is* a real teardown path that terminates the worker and
disconnects a `ResizeObserver`.

**[INFERENCE]** (not from an issue — I could not find a React-specific StrictMode bug report;
issue [#5 "React support"](https://github.com/ThaUnknown/jassub/issues/5) is purely about
bundler asset URLs, and issue [#21](https://github.com/ThaUnknown/jassub/issues/21) is a
Next.js worker error): the risk profile of a `new JASSUB(...)` per effect is exactly the
classic one — React 19 StrictMode dev double-invokes effects, so you get **two workers, two
WASM instantiations (~2 MiB each), two ResizeObservers**. Because construction is async
(`ready`), a naive cleanup can also destroy the *first* instance after the *second* has
mounted, or call `manualRender` on a destroyed instance.

**Required pattern [INFERENCE]:**
```ts
useEffect(() => {
  let inst: JASSUB | null = null
  let cancelled = false
  ;(async () => {
    const i = new JASSUB({ canvas, subContent, queryFonts: false, fonts: [cjkSubset] })
    await i.ready
    if (cancelled) { await i.destroy(); return }   // lost the race -> tear down
    inst = i
    await i.manualRender({ expectedDisplayTime: performance.now(), width, height, mediaTime })
  })()
  return () => { cancelled = true; inst?.destroy() }
}, [/* subContent, mediaTime deliberately NOT here */])
```
Then drive timestamp changes by calling `manualRender` on the **existing** instance rather
than remounting — one worker for the panel's lifetime. **[UNVERIFIED]** I have not run this;
what I'd test: (a) mount/unmount 20× in StrictMode and watch `performance.memory` +
DevTools worker count for leaks; (b) confirm `destroy()` while `ready` is still pending
doesn't throw; (c) confirm `manualRender` after `destroy()` rejects rather than hanging.

I found **no maintained React wrapper package** for JASSUB on npm. **[INFERENCE]** write our
own ~60-line hook; do not add a dependency.

### Q2f. Lighter alternatives — honest assessment

| option | verdict |
|---|---|
| `libass-wasm` / SubtitlesOctopus | **No.** Abandoned 2022-12-04. Strictly worse than JASSUB, same weight. |
| `@jellyfin/libass-wasm`@4.2.4 | Maintained (2026-01-13) but it's the older v4 API line and still ships libass WASM — **same ~2 MiB cost, fewer features**. Only relevant if JASSUB's v2 bundler issues prove intractable. |
| `ass-compiler`'s `compile()` + hand-rolled DOM/canvas renderer | **Genuinely viable for our narrow case.** `compile()` produces a flat, renderer-oriented structure with resolved styles and per-fragment tags. Rendering *static* text with position (`\pos`), alignment (`\an`), colour, outline, and font size covers the overwhelming majority of dialogue lines. **[INFERENCE]** ~300-600 lines for a decent subset. **What it will NOT do:** `\t` animations, `\p` vector drawings, `\clip`, karaoke `\k` sweeps, blur/`\be`, transforms `\frx/\fry/\frz`, and correct libass line-breaking/collision resolution. For a *typesetting-heavy* Chinese fansub file (signs, captions, effects), the output would be visibly wrong — which is bad in an *inspection* tool whose job is to show the truth. |
| Server-side render to PNG/SVG | Requires libass + fontconfig + the actual fonts in the Docker image, on a **low-power router**. Trades client WASM cost for server CPU cost on the weakest machine in the system. **[INFERENCE]** Worse fit, unless we cache aggressively. One upside: the server already has the fonts and can do glyph subsetting anyway. |

**[INFERENCE] Recommendation:** JASSUB for the styled preview, **lazy-loaded** (dynamic
`import()` behind the Collapsible / only when the preview panel is actually opened) so the
~2 MiB WASM never costs anything for users who only read the line list and comparison
strips. This neutralizes most of the weight objection.


## Q3 visualization

_pending_

## Recommended stack

_pending_

## Risks & unknowns

_pending_
