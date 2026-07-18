import { tool } from 'ai'
import { z } from 'zod'
import { join, basename, extname } from 'node:path'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { runResolve, type FetchAdapter } from '../cli/fetchLib.js'
import { downloadDirect } from '../adapters/download/direct.js'
import { writeSubtitle } from '../files/subtitleWriter.js'
import { inspectSubtitle } from '../files/subtitleInspect.js'
import { install } from '../files/stagingSandbox.js'
import { isUnderRoots } from '../core/mediaContext.js'
import { formatEpisodeCode, matchesEpisodeCode } from '../core/episode.js'
import { parseCandidateKey } from '../core/schemas.js'
import { coercibleInt, coercibleNullableInt, nullableTolerant } from './coerce.js'

export interface DownloadCandidateDeps {
  adapters: FetchAdapter[]
  /** Sandbox staging root for this ONE task (allocated by the caller via
   *  stagingSandbox.allocate(jobId, mediaRoot) — see findSubtitleWorker.ts). Each call gets its
   *  own subdirectory keyed by a fresh stagedFileId so comparing multiple candidates never
   *  collides (see the correctness note above this task in the plan). */
  stagingDir: string
  /** Opaque handle → real staged path, shared with install_subtitle. Never exposed to the
   *  agent — install_subtitle takes stagedFileId, not a path. */
  stagedFiles: Map<string, string>
  /** Every target video filename in this batch task (Task 5 / R-5: a worker run now covers a whole
   *  season-level range, not one episode). The tool's `videoFilename` input claims ONE of these per
   *  call — see resolveTargetFilename below. */
  targetFilenames: string[]
  /** task.targetLanguage (BCP-47 primary code, e.g. 'zh'/'en') — drives the provisional langTag
   *  this staging write uses (see execute below). Optional/defaulted to 'zh' only so existing
   *  callers/tests that predate A2 keep working unchanged; makeFindSubtitleWorker always passes
   *  it explicitly from the task. */
  targetLanguage?: string
  fetchImpl?: typeof fetch
  /** 重复源 P4：本地候选读盘用的沙盒边界——local 分支绕过 runResolve/downloadDirect 的网络路径，
   *  直接 readFile 磁盘上的字幕文件，isUnderRoots 复核（defense in depth，同 install_subtitle
   *  既有先例）防一个畸形/被篡改的 providerId 逃出媒体根之外。 */
  mediaRoot?: string
}

/** Canonicalize a filename for tolerant matching: NFKC folds NBSP / narrow NBSP / full-width
 *  space / NFD decomposition into normalized forms, and collapses runs of whitespace to a single
 *  ASCII space. This fixes the 2026-07-18 production incident where the real filename used
 *  U+00A0 (NBSP, bytes c2a0) between "V" and "klenutých", but the model echoed it as a plain
 *  U+0020 space, making the previous exact `filenames.includes(videoFilename)` match fail for
 *  multi-target tasks with no single-target fallback. */
const canonFilename = (s: string): string => s.normalize('NFKC').replace(/\s+/g, ' ').trim()

/** Shared by download_candidate and install_subtitle (Task 5 / R-5): resolves the agent-supplied
 *  `videoFilename` input against this task's list of target filenames. Three states:
 *  - named + matches one of `filenames` → that filename (claims that target for this call).
 *  - named + matches none → an error (agent named a file that isn't part of this task).
 *  - omitted (null) + exactly one target → defaults to it (single-target tasks stay zero-friction).
 *  - omitted (null) + multiple targets → an error asking the agent to say which one. */
export function resolveTargetFilename(videoFilename: string | null, filenames: string[]): string | { error: string } {
  if (videoFilename === null) {
    return filenames.length === 1
      ? filenames[0]
      : { error: `this task has ${filenames.length} targets — pass videoFilename to say which one this call is for` }
  }

  // ① Exact match first — preserves existing behavior and protects against canonical collisions.
  if (filenames.includes(videoFilename)) {
    return videoFilename
  }

  // ② Tolerant match against canonical forms (NBSP vs space, NFD vs NFC, etc.), returning the
  //    original element from `filenames` so the task's true bytes are used as the disk path.
  const canonVideo = canonFilename(videoFilename)
  const matched = filenames.find(f => canonFilename(f) === canonVideo)
  if (matched) {
    return matched
  }

  // ③ Forensic log before returning the error. This observability was missing during the
  //    2026-07-18 production incident and forced a real-device reproduction; keep it.
  const toHex = (s: string) => Buffer.from(s, 'utf8').toString('hex')
  console.error(
    `[find-subtitle-worker] videoFilename mismatch: agent=${toHex(videoFilename)} targets=${filenames.map(f => toHex(f).slice(0, 80)).join(', ')}`
  )
  return { error: `unknown videoFilename: ${videoFilename} — must be one of the task's target files` }
}

/** download_candidate's provisional staging langTag (A2): for a Chinese target the real Hans/Hant
 *  call is made later by the agent at install_subtitle time, from subtitleInspect's detectedScript
 *  signal — not here, before the file is even inspected — so this keeps the historical 'zh-Hans'
 *  placeholder. Any other target language is used as-is; it's just a staging filename, replaced
 *  wholesale by install_subtitle's own langTag once the agent decides. */
function stagingLangTag(targetLanguage: string): string {
  return targetLanguage === 'zh' ? 'zh-Hans' : targetLanguage
}

export function makeDownloadCandidateTool(deps: DownloadCandidateDeps) {
  return tool({
    description:
      'Resolve a candidate to a download URL, download it, unpack/decode it into your ' +
      'sandbox, and inspect its structural signals (cue count, time span, detected script). ' +
      'candidateId is the candidate\'s `id` exactly as shown by search_source / list_candidates / ' +
      'get_candidate (e.g. "assrt:667241") — pass it back whole. ' +
      'This task may cover several target videos at once: pass videoFilename to say which target ' +
      'file this call is for (must be one of the task\'s target files); you can omit it when the ' +
      'task has exactly one target. ' +
      'Use fileIndex to pull ONE file out of a season pack / collection BEFORE download: set it to ' +
      'the index of the entry in the candidate\'s fileList (seen via get_candidate) that names your ' +
      'target episode; pass fileIndex: null for a plain single-file candidate. ' +
      'If the downloaded archive is a zip with more than one subtitle file inside (e.g. an ' +
      'un-indexed season pack), this call returns an `archiveEntries` list instead of staging ' +
      'anything — call again with archiveEntryName set to the exact entry name from that list to ' +
      'pick which file INSIDE the zip to use (archiveEntryName picks an entry AFTER download, ' +
      'inside the unpacked archive — a different step from fileIndex, which picks the source file ' +
      'before download). ' +
      'Does NOT install it — call install_subtitle once you decide it is a match.',
    inputSchema: z.object({
      // The agent only ever sees ONE identifier per candidate — candidateKey(c) = the composite
      // "provider:providerId" surfaced as `id` (resultHandles.ts). Accept that composite here and
      // split it back into a BARE providerId + provider below, so the CandidateRef reaching runResolve
      // carries the provider-native id the adapters' resolve() needs (assrt does Number(ref.providerId)).
      candidateId: z.string(),
      // Real models string-encode numbers ("10") and emit "None"/"null"/"" for a null — coerce them.
      fileIndex: coercibleNullableInt,
      // Which of the task's target videos this call claims (Task 5 / R-5) — see resolveTargetFilename.
      videoFilename: nullableTolerant(z.string()),
      // Which entry inside a multi-subtitle zip to pick (C-D1) — matched by exact basename in
      // subtitleWriter's pickFromZip.
      archiveEntryName: nullableTolerant(z.string()),
    }),
    execute: async ({ candidateId, fileIndex, videoFilename, archiveEntryName }) => {
      const resolvedTarget = resolveTargetFilename(videoFilename, deps.targetFilenames)
      if (typeof resolvedTarget !== 'string') return resolvedTarget

      const parsed = parseCandidateKey(candidateId)
      if (!parsed) {
        return {
          error:
            `unrecognized candidate id: ${candidateId} — pass the candidate's \`id\` exactly as shown ` +
            `by search_source/list_candidates/get_candidate (e.g. "assrt:667241")`,
        }
      }
      const { provider, providerId } = parsed

      // 重复源 P4：provider:'local' 是"该条目另一个文件已有的字幕"，不是真实网络适配器——
      // providerId 直接编码字幕文件的绝对路径（mapper 侧 encodeURIComponent 写入，见
      // findSubtitleWorkerTask.ts 的 buildLocalCandidates），这里解码后直接读盘，完全绕开
      // runResolve/downloadDirect 的网络路径。同一份 writeSubtitle/inspectSubtitle 落盘纪律，
      // 同一个 stagedFileId 机制——install_subtitle 完全不用知道这份字幕是网络下的还是本地复制的。
      if (provider === 'local') {
        const srcPath = decodeURIComponent(providerId)
        if (deps.mediaRoot && !isUnderRoots(srcPath, [deps.mediaRoot])) {
          return { error: `refusing to read local candidate outside sandboxed media root: ${srcPath}` }
        }
        let bytes: Buffer
        try {
          bytes = await readFile(srcPath)
        } catch (e) {
          return { error: `local candidate file unreadable: ${srcPath} (${e instanceof Error ? e.message : String(e)})` }
        }
        const stagedFileId = randomUUID()
        const attemptDir = join(deps.stagingDir, stagedFileId)
        const written = await writeSubtitle({
          artifact: bytes, artifactFilename: basename(srcPath), videoFilename: resolvedTarget,
          langTag: stagingLangTag(deps.targetLanguage ?? 'zh'), outDir: attemptDir,
          selectFileName: archiveEntryName ?? undefined,
        })
        if ('needsSelection' in written) {
          return {
            archiveEntries: written.entries,
            hint: 'multiple subtitle entries in this archive — call again with archiveEntryName to pick your episode',
          }
        }
        const signals = inspectSubtitle(written.path)
        deps.stagedFiles.set(stagedFileId, written.path)
        return { stagedFileId, bytes: written.bytes, encoding: written.encoding, signals }
      }

      const { url, filename, headers } = await runResolve({ provider, providerId, fileIndex }, deps.adapters)
      const { bytes, contentType } = await downloadDirect(url, { headers, fetchImpl: deps.fetchImpl })
      const artifactFilename = filename ?? (contentType?.includes('zip') ? 'download.zip' : 'download.srt')
      const stagedFileId = randomUUID()
      const attemptDir = join(deps.stagingDir, stagedFileId)
      const written = await writeSubtitle({
        artifact: bytes, artifactFilename, videoFilename: resolvedTarget,
        langTag: stagingLangTag(deps.targetLanguage ?? 'zh'), outDir: attemptDir,
        selectFileName: archiveEntryName ?? undefined,
      })
      if ('needsSelection' in written) {
        return {
          archiveEntries: written.entries,
          hint: 'multiple subtitle entries in this archive — call again with archiveEntryName to pick your episode',
        }
      }
      const signals = inspectSubtitle(written.path)
      deps.stagedFiles.set(stagedFileId, written.path)
      return { stagedFileId, bytes: written.bytes, encoding: written.encoding, signals }
    },
  })
}

export interface InstallSubtitleDeps {
  stagedFiles: Map<string, string>
  /** Every target this batch task covers, each with its OWN outDir (dirname(target.videoPath),
   *  never derived from anything the agent supplies — Task 5 / R-5: a worker run installs
   *  episode-by-episode across a whole season, so each target needs its own destination dir). The
   *  tool's `videoFilename` input claims ONE of these per call — see resolveTargetFilename. */
  targets: { videoFilename: string; outDir: string }[]
  /** The ONE sandbox root for this task — checked again here even though each target's outDir is
   *  already fixed (defense-in-depth, mirrors realignExecutor.ts's containingRoot/isUnderRoots use). */
  mediaRoot: string
}

export function makeInstallSubtitleTool(deps: InstallSubtitleDeps) {
  return tool({
    description:
      'Atomically install a previously downloaded+inspected candidate (by stagedFileId) as ' +
      'the final subtitle for this task\'s video. Only call this once you have decided, like ' +
      'a person who opened the file, that this candidate really is the subtitle for this exact video. ' +
      'This task may cover several target videos at once: pass videoFilename to say which target ' +
      'file you are installing for (must be one of the task\'s target files); you can omit it when ' +
      'the task has exactly one target.',
    inputSchema: z.object({
      stagedFileId: z.string(),
      // A2: any non-empty language tag, not just zh-Hans/zh-Hant — the agent picks this from
      // task.targetLanguage (refined to Hans/Hant via subtitleInspect's detectedScript for
      // Chinese targets), not from a fixed two-value domain.
      langTag: z.string().min(1),
      // Which of the task's target videos this call claims (Task 5 / R-5) — see resolveTargetFilename.
      videoFilename: nullableTolerant(z.string()),
    }),
    execute: async ({ stagedFileId, langTag, videoFilename }) => {
      const resolvedTarget = resolveTargetFilename(videoFilename, deps.targets.map(t => t.videoFilename))
      if (typeof resolvedTarget !== 'string') return resolvedTarget
      const target = deps.targets.find(t => t.videoFilename === resolvedTarget)!

      const stagedPath = deps.stagedFiles.get(stagedFileId)
      if (!stagedPath) return { error: `unknown stagedFileId: ${stagedFileId} — call download_candidate first` }
      const videoBase = basename(target.videoFilename).replace(/\.[^.]+$/, '')
      const ext = extname(stagedPath)
      const finalPath = join(target.outDir, `${videoBase}.${langTag}${ext}`)
      if (!isUnderRoots(finalPath, [deps.mediaRoot])) {
        return { error: `refusing to install outside sandboxed media root: ${finalPath}` }
      }
      const result = await install(stagedPath, finalPath)
      return { path: result.path }
    },
  })
}

/** Optional advisory check — NOT a mandatory gate (north star #2: deterministic checks never
 *  get to be the "is this subtitle right" gatekeeper; they only do factual bookkeeping). The
 *  agent may call this to sanity-check a filename against the season/episode it believes it is
 *  looking for; it is one more piece of evidence, not a pass/fail door the agent must clear. */
export function makeCheckEpisodeCodeSafetyTool() {
  return tool({
    description:
      'Advisory check: does a filename\'s episode code match the given season/episode? This ' +
      'is one signal among several, not a verdict — a false result does not mean reject, a ' +
      'true result does not mean accept.',
    inputSchema: z.object({
      filename: z.string(),
      // Real models string-encode these ("1"/"5") — coerce so the advisory check's tool-arg
      // validation does not fail before execute runs.
      season: coercibleInt,
      episode: coercibleInt,
    }),
    execute: async ({ filename, season, episode }) => {
      const expectedCode = formatEpisodeCode(season, episode)
      return { safe: matchesEpisodeCode(filename, expectedCode), expectedCode }
    },
  })
}
