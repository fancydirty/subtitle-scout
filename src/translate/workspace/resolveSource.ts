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
    // 单跳只走源语言:ja 内嵌轨 → jimaku/外源 ja。两条都空就停牌,**故意不回退英轨**。
    // 这里曾有一段 eng 兜底(2026-07-24 裁决:"jimaku 没有就 eng 兜底,context 补信息熵,总好过留空缺"),
    // 2026-08-08 用户重新拍板废止(R18,R13 胜出):JP→EN→CN 是悄悄降质却假装成功,
    // 而 no-source 是诚实的"暂时无能为力"——界面停牌可被看见、可被后续补源救回,
    // 二次转译的产物却会以 covered 姿态永久占位。所以此处的空白是设计,不是漏写。
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
      reason: 'origin_lang=ja: no Japanese source (embedded ja track or jimaku fetch) — single-hop only, English relay is forbidden',
    }
  }

  if (origin === '') {
    // TMDB 未刮到 original_language。空值 ≠ 英语:此时片子的语言**完全未经证实**,
    // 而单跳翻译的正确性完全押在"源语言判断没错"上。有英文内嵌轨也不足以证明对白是英语
    // (日漫/欧洲片普遍自带英轨)。宁可停牌等 identify 补上语言,也不拿臆断去开翻。
    return {
      status: 'no-source',
      reason: 'origin_lang unknown — cannot pick a single-hop source language honestly',
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
