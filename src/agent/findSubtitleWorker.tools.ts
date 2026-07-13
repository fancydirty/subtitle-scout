import { tool } from 'ai'
import { z } from 'zod'
import { join, basename, extname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { runResolve, type FetchAdapter } from '../cli/fetchLib.js'
import { downloadDirect } from '../adapters/download/direct.js'
import { writeSubtitle } from '../files/subtitleWriter.js'
import { inspectSubtitle } from '../files/subtitleInspect.js'
import { install } from '../files/stagingSandbox.js'
import { isUnderRoots } from '../core/mediaContext.js'
import { formatEpisodeCode, matchesEpisodeCode } from '../core/episode.js'
import { PROVIDERS } from '../core/schemas.js'

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
  videoFilename: string
  fetchImpl?: typeof fetch
}

export function makeDownloadCandidateTool(deps: DownloadCandidateDeps) {
  return tool({
    description:
      'Resolve a candidate to a download URL, download it, unpack/decode it into your ' +
      'sandbox, and inspect its structural signals (cue count, time span, detected script). ' +
      'Does NOT install it — call install_subtitle once you decide it is a match.',
    inputSchema: z.object({
      provider: z.enum(PROVIDERS),
      providerId: z.string(),
      fileIndex: z.number().int().nullable(),
    }),
    execute: async ({ provider, providerId, fileIndex }) => {
      const { url, filename, headers } = await runResolve({ provider, providerId, fileIndex }, deps.adapters)
      const { bytes, contentType } = await downloadDirect(url, { headers, fetchImpl: deps.fetchImpl })
      const artifactFilename = filename ?? (contentType?.includes('zip') ? 'download.zip' : 'download.srt')
      const stagedFileId = randomUUID()
      const attemptDir = join(deps.stagingDir, stagedFileId)
      const written = await writeSubtitle({
        artifact: bytes, artifactFilename, videoFilename: deps.videoFilename,
        langTag: 'zh-Hans', outDir: attemptDir,
      })
      const signals = inspectSubtitle(written.path)
      deps.stagedFiles.set(stagedFileId, written.path)
      return { stagedFileId, bytes: written.bytes, encoding: written.encoding, signals }
    },
  })
}

export interface InstallSubtitleDeps {
  stagedFiles: Map<string, string>
  /** Fixed by the caller at task-construction time — dirname(task.videoPath). Never derived
   *  from anything the agent supplies. */
  outDir: string
  /** The ONE sandbox root for this task — checked again here even though outDir is already
   *  fixed (defense-in-depth, mirrors realignExecutor.ts's containingRoot/isUnderRoots use). */
  mediaRoot: string
  videoFilename: string
}

export function makeInstallSubtitleTool(deps: InstallSubtitleDeps) {
  return tool({
    description:
      'Atomically install a previously downloaded+inspected candidate (by stagedFileId) as ' +
      'the final subtitle for this task\'s video. Only call this once you have decided, like ' +
      'a person who opened the file, that this candidate really is the subtitle for this exact video.',
    inputSchema: z.object({
      stagedFileId: z.string(),
      langTag: z.enum(['zh-Hans', 'zh-Hant']),
    }),
    execute: async ({ stagedFileId, langTag }) => {
      const stagedPath = deps.stagedFiles.get(stagedFileId)
      if (!stagedPath) return { error: `unknown stagedFileId: ${stagedFileId} — call download_candidate first` }
      const videoBase = basename(deps.videoFilename).replace(/\.[^.]+$/, '')
      const ext = extname(stagedPath)
      const finalPath = join(deps.outDir, `${videoBase}.${langTag}${ext}`)
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
      season: z.number().int(),
      episode: z.number().int(),
    }),
    execute: async ({ filename, season, episode }) => {
      const expectedCode = formatEpisodeCode(season, episode)
      return { safe: matchesEpisodeCode(filename, expectedCode), expectedCode }
    },
  })
}
