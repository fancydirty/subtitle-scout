import type { EmbeddedSubtitleTrack } from '../../files/streamProbe.js'

export interface ResolveSourceDeps {
  probe: (videoPath: string) => Promise<EmbeddedSubtitleTrack[] | null>
  extract: (videoPath: string, trackIndex: number) => Promise<string | null>
  fetchSourceSub?: (
    videoPath: string,
    accept?: (srtText: string) => Promise<boolean>,
  ) => Promise<{ srtText: string; sourceRef: string } | null>
}

export type ResolveSourceResult =
  | { status: 'ok'; srtText: string; sourceRef: string; sourceLangName: '英文' | '日文' | '源语言' }
  | { status: 'no-source'; reason: string }
  | { status: 'extract-failed'; reason: string }
  | { status: 'probe-failed'; reason: string }

function normOrigin(originLang: string | null | undefined): string {
  return (originLang ?? '').trim().toLowerCase()
}

function isJa(origin: string): boolean {
  return origin === 'ja' || origin === 'jpn'
}

function isEn(origin: string): boolean {
  return origin === 'en' || origin === 'eng' || origin.startsWith('en-')
}

function trackLang(t: EmbeddedSubtitleTrack): string {
  return (t.lang ?? '').toLowerCase()
}

function isJaTrack(t: EmbeddedSubtitleTrack): boolean {
  const l = trackLang(t)
  return l === 'ja' || l === 'jpn' || l.startsWith('ja')
}

function isEnTrack(t: EmbeddedSubtitleTrack): boolean {
  const l = trackLang(t)
  return l === 'en' || l === 'eng' || l.startsWith('en')
}

/** Origin-lang single-hop source selection. ja never falls back to eng embedded. */
export async function resolveTranslateSource(args: {
  originLang: string | null | undefined
  videoPath: string
  deps: ResolveSourceDeps
}): Promise<ResolveSourceResult> {
  const origin = normOrigin(args.originLang)
  const tracks = await args.deps.probe(args.videoPath)
  if (tracks === null) {
    return { status: 'probe-failed', reason: 'subtitle probe unavailable' }
  }

  if (isJa(origin)) {
    const jaIdx = tracks.findIndex((t) => !t.isImageBased && isJaTrack(t))
    if (jaIdx >= 0) {
      const srt = await args.deps.extract(args.videoPath, jaIdx)
      if (srt == null) return { status: 'extract-failed', reason: 'ja embedded extract failed' }
      return { status: 'ok', srtText: srt, sourceRef: `embedded:s:${jaIdx}`, sourceLangName: '日文' }
    }
    if (args.deps.fetchSourceSub) {
      const fetched = await args.deps.fetchSourceSub(args.videoPath)
      if (fetched) {
        return { status: 'ok', srtText: fetched.srtText, sourceRef: fetched.sourceRef, sourceLangName: '日文' }
      }
    }
    return {
      status: 'no-source',
      reason: 'origin_lang=ja requires Japanese source (jimaku/embedded ja); eng embedded is not a valid single-hop source',
    }
  }

  if (isEn(origin)) {
    const enIdx = tracks.findIndex((t) => !t.isImageBased && isEnTrack(t))
    if (enIdx >= 0) {
      const srt = await args.deps.extract(args.videoPath, enIdx)
      if (srt == null) return { status: 'extract-failed', reason: 'eng embedded extract failed' }
      return { status: 'ok', srtText: srt, sourceRef: `embedded:s:${enIdx}`, sourceLangName: '英文' }
    }
    if (args.deps.fetchSourceSub) {
      const fetched = await args.deps.fetchSourceSub(args.videoPath)
      if (fetched) {
        return { status: 'ok', srtText: fetched.srtText, sourceRef: fetched.sourceRef, sourceLangName: '英文' }
      }
    }
    return { status: 'no-source', reason: 'no English source available' }
  }

  return {
    status: 'no-source',
    reason: `unsupported origin_lang=${origin || '(empty)'} for single-hop translate`,
  }
}
