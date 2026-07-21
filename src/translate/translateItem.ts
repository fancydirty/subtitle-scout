// E AI 翻译 · 单条端到端编排(可跑最小单元):探内嵌轨 → 选非目标文本轨 → 抽取 → 攒上下文 →
// fail-closed 翻译 → 过闸才写中文 sidecar。所有 I/O(探针/抽取/LM/读旧字幕/写盘)注入,可脱机全测;
// CLI 与 daemon 各自接线真实现。北极星:held(过不了闸)绝不写 sidecar,留原态交上层。
import type { EmbeddedSubtitleTrack } from '../files/streamProbe.js'
import type { GateResult } from './qualityGate.js'
import { translateSubtitle, type TranslationContext, type TranslationLM } from './translatePipeline.js'

export interface TranslateItemDeps {
  /** 探内嵌字幕轨(probeEmbeddedSubtitles);null=探针不可用。数组顺序=字幕流顺序(与 -map 0:s:N 对齐)。 */
  probe: (videoPath: string) => Promise<EmbeddedSubtitleTrack[] | null>
  /** 抽第 trackIndex 条(0-based 字幕流序)为 SRT 文本(extractEmbeddedSubtitle);null=抽取失败。 */
  extract: (videoPath: string, trackIndex: number) => Promise<string | null>
  lm: TranslationLM
  /** 该视频是否已有中文外挂(findExternalSidecar);返回路径=有,null=无。 */
  readExistingChineseSidecar: (videoPath: string) => string | null
  /** 可选:攒上下文(同剧既有中字/TMDB)。缺省=空上下文。 */
  gatherContext?: (videoPath: string) => Promise<TranslationContext>
  /** 写中文 sidecar,返回写入路径。 */
  writeSidecar: (videoPath: string, content: string) => string
}

export interface TranslateItemResult {
  status: 'installed' | 'held' | 'no-embedded' | 'already-covered' | 'extract-failed'
  sidecarPath?: string
  reason?: string
  gate?: GateResult
}

/** 中文语言标签判定(ffprobe 原始 ISO:chi、zho、zh 前缀、chs、cht)。 */
function isChinese(lang: string | null): boolean {
  if (!lang) return false
  const l = lang.toLowerCase()
  return l.startsWith('zh') || l === 'chi' || l === 'zho' || l === 'chs' || l === 'cht'
}

export async function translateItem(videoPath: string, deps: TranslateItemDeps): Promise<TranslateItemResult> {
  const tracks = await deps.probe(videoPath)
  if (tracks === null) return { status: 'no-embedded' } // 探针不可用:不能判、不猜、不译

  // 已覆盖:内嵌有中文文本轨,或已有中文外挂 → 别译。
  if (tracks.some((t) => !t.isImageBased && isChinese(t.lang))) return { status: 'already-covered' }
  if (deps.readExistingChineseSidecar(videoPath)) return { status: 'already-covered' }

  // 源轨:第一条非中文的文本轨(图形轨不可当文本比对/翻译)。其在字幕流里的位置即 -map 0:s:N 的 N。
  const sourceIdx = tracks.findIndex((t) => !t.isImageBased && !isChinese(t.lang))
  if (sourceIdx < 0) return { status: 'no-embedded' }

  const src = await deps.extract(videoPath, sourceIdx)
  if (src === null) return { status: 'extract-failed' }

  const ctx = deps.gatherContext ? await deps.gatherContext(videoPath) : {}
  const result = await translateSubtitle(src, ctx, deps.lm)

  if (result.verdict === 'installed' && result.translatedSrt !== null) {
    const sidecarPath = deps.writeSidecar(videoPath, result.translatedSrt)
    return { status: 'installed', sidecarPath, gate: result.gate }
  }
  return { status: 'held', reason: result.reason, gate: result.gate }
}
