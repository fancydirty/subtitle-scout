import { tool } from 'ai'
import { z } from 'zod'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { runResolve, type FetchAdapter } from '../cli/fetchLib.js'
import { downloadDirect } from '../adapters/download/direct.js'
import { writeSubtitle } from '../files/subtitleWriter.js'
import { inspectSubtitle } from '../files/subtitleInspect.js'
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
