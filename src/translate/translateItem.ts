// E AI 翻译 · 单条端到端编排(可跑最小单元):探内嵌轨 → 选非目标文本轨 → 抽取 → 攒上下文 →
// fail-closed 翻译 → 过闸才写中文 sidecar。所有 I/O(探针/抽取/LM/读旧字幕/写盘)注入,可脱机全测;
// CLI 与 daemon 各自接线真实现。北极星:held(过不了闸)绝不写 sidecar,留原态交上层。
import type { EmbeddedSubtitleTrack } from '../files/streamProbe.js'
import { parseSrtCues, type GateResult } from './qualityGate.js'
import { translateSubtitle, type TranslationContext, type TranslationLM, type TranslationCritic } from './translatePipeline.js'

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
  /** 可选:LLM-judge 语义层(确定性闸过后再审)。缺省=不跑 critic。 */
  critic?: TranslationCritic
  /** F1 可选第二腿:probe 探得零合格轨时按源语言搜外挂字幕(cli/fetchSourceSub.ts 接线)。
   *  返回 srtText=可直接进管道的字幕文本,sourceRef='provider:id' 供 runs 追溯;null=诚实失败
   *  (搜不到/都解不出,绝不抛)。未接线=行为不变(no-embedded)。 */
  fetchSourceSub?: (videoPath: string) => Promise<{ srtText: string; sourceRef: string } | null>
  /** 写中文 sidecar,返回写入路径。 */
  writeSidecar: (videoPath: string, content: string) => string
  /** 可选:探视频时长(probeDurationSec),用于时长校验闸——产出字幕最后 cue 的结束时间 / 视频时长
   *  不在 [0.85, 1.15] → held(duration-mismatch),fail-closed 防错版本/错源字幕落盘(Overflow
   *  全季装错版本实案)。translatePipeline 是纯文本管道(不知视频时长),这道闸只能在持 videoPath
   *  的本层做。缺省/返回 null=不校验(同 probe=null 语义:宁缺毋滥不阻塞)。 */
  videoDurationSec?: (videoPath: string) => Promise<number | null>
}

export interface TranslateItemResult {
  status: 'installed' | 'held' | 'no-embedded' | 'already-covered' | 'extract-failed' | 'no-source'
  sidecarPath?: string
  reason?: string
  gate?: GateResult
  /** F1:源文本来自外挂搜索时的候选标识('provider:id'),进 runs 记录供追溯;内嵌轨腿无此值。 */
  sourceRef?: string
}

/** 中文语言标签判定(ffprobe 原始 ISO:chi、zho、zh 前缀、chs、cht)。 */
function isChinese(lang: string | null): boolean {
  if (!lang) return false
  const l = lang.toLowerCase()
  return l.startsWith('zh') || l === 'chi' || l === 'zho' || l === 'chs' || l === 'cht'
}

/** 从 SRT 时轴行提取结束秒数('HH:MM:SS,mmm --> HH:MM:SS,mmm' 的后半段)。 */
function cueEndSec(timing: string): number {
  const m = timing.match(/-->\s*(\d+):(\d+):(\d+)[,.](\d+)/)
  if (!m) return 0
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000
}

export async function translateItem(videoPath: string, deps: TranslateItemDeps): Promise<TranslateItemResult> {
  const tracks = await deps.probe(videoPath)
  if (tracks === null) return { status: 'no-embedded' } // 探针不可用:不能判、不猜、不译

  // 已覆盖:内嵌有中文文本轨,或已有中文外挂 → 别译。
  if (tracks.some((t) => !t.isImageBased && isChinese(t.lang))) return { status: 'already-covered' }
  if (deps.readExistingChineseSidecar(videoPath)) return { status: 'already-covered' }

  // 源轨:第一条非中文的文本轨(图形轨不可当文本比对/翻译)。其在字幕流里的位置即 -map 0:s:N 的 N。
  const sourceIdx = tracks.findIndex((t) => !t.isImageBased && !isChinese(t.lang))

  // 源文本双腿(F1):有合格内嵌轨→抽取(绝不调 fetchSourceSub,省下载配额);零合格轨且接了
  // fetchSourceSub→按源语言搜外挂;两腿都没有→no-embedded(未接线时语义与从前完全一致)。
  let src: string
  let sourceRef: string | undefined
  if (sourceIdx >= 0) {
    const extracted = await deps.extract(videoPath, sourceIdx)
    if (extracted === null) return { status: 'extract-failed' }
    src = extracted
  } else if (deps.fetchSourceSub) {
    const fetched = await deps.fetchSourceSub(videoPath)
    if (fetched === null) return { status: 'no-source' } // 诚实失败:搜索穷尽/都解不出
    src = fetched.srtText
    sourceRef = fetched.sourceRef
  } else {
    return { status: 'no-embedded' }
  }

  const ctx = deps.gatherContext ? await deps.gatherContext(videoPath) : {}
  const result = await translateSubtitle(src, ctx, deps.lm, { critic: deps.critic })

  if (result.verdict === 'installed' && result.translatedSrt !== null) {
    // 时长校验闸(北极星 fail-closed):产出字幕最后 cue 的结束时间 / 视频时长 不在 [0.85, 1.15]
    // → held(duration-mismatch),绝不写 sidecar。防错版本/错源字幕落盘(Overflow 全季 8 集装错版本;
    // Adam E01 翻译用 24 分钟字幕给 3.5 分钟视频)。translatePipeline 纯文本管道(不知视频时长),
    // 这道闸只能在持 videoPath 的本层做。探针不可用(返回 null)→ 跳过(同 probe=null:宁缺毋滥不阻塞)。
    if (deps.videoDurationSec) {
      const videoSec = await deps.videoDurationSec(videoPath)
      if (videoSec !== null && videoSec > 0) {
        const cues = parseSrtCues(result.translatedSrt)
        const lastEndSec = cues.length > 0 ? cueEndSec(cues[cues.length - 1].timing) : 0
        const ratio = lastEndSec / videoSec
        if (ratio < 0.85 || ratio > 1.15) {
          return { status: 'held', reason: `duration-mismatch: source ${Math.round(lastEndSec)}s vs video ${videoSec}s`, gate: result.gate, sourceRef }
        }
      }
    }
    const sidecarPath = deps.writeSidecar(videoPath, result.translatedSrt)
    return { status: 'installed', sidecarPath, gate: result.gate, sourceRef }
  }
  return { status: 'held', reason: result.reason, gate: result.gate, sourceRef }
}
