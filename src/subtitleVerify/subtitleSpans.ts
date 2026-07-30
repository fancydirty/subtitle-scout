/**
 * 字幕文本 → 说话时段序列的共用底座。
 *
 * 这三件事（读+解码、按内容试探解析、剥成 SpeechSpan）参考源侧（referenceSource.ts）与
 * 待检侧（verifySubtitle.ts）都要做，且**必须做得一模一样**——两侧口径分裂会直接污染
 * 对齐分数：比如参考源走 chardet 解码而待检侧朴素按 utf-8 读，GBK 字幕在待检侧解析出
 * 0 条 cue，于是一条完全正常的字幕被判"无法验证"。所以抽在这里共用，不各写一份。
 *
 * 纯读取，无写盘、无 console。
 */
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { decodeToUtf8 } from '../files/subtitleEncoding.js'
import { parseSrtCues, parseAssCues, type Cue } from '../files/subtitleInspect.js'
import type { SpeechSpan } from './alignDetect.js'

/**
 * 把已解码文本解析成 cue：先按 SRT，得 0 条再按 ASS。
 *
 * 与 subtitleDialogueFingerprint（subtitleInspect.ts:163）同一套判定顺序，而不是按扩展名分派——
 * 内嵌轨的输入来自 ffmpeg `-f srt` 管道，没有文件名可看；外挂文件的扩展名也不总可信
 * （.srt 里装 ASS 内容是字幕站常见的错贴）。按内容试探对两者都正确。
 */
export function parseCues(text: string): Cue[] {
  const srtCues = parseSrtCues(text)
  if (srtCues.length > 0) return srtCues
  return parseAssCues(text).cues
}

/**
 * cue → SpeechSpan：丢掉 text，只留时段。
 *
 * 对齐一律不看文本内容（跨语言天然对不上），显式剥掉可以让"对齐不看内容"这条语义在
 * 类型层面成立，而不是靠调用方自觉不去读 text。
 */
export function toSpans(cues: readonly Cue[]): SpeechSpan[] {
  return cues.map(({ startMs, endMs }) => ({ startMs, endMs }))
}

/**
 * 读 + 解码合成一步：调用方只关心"拿到可解析的文本"，编码探测是实现内部的事。
 *
 * 走 readFileSync + decodeToUtf8（字幕编码五花八门：GBK/BIG5/UTF-16，朴素按 utf-8 读会把
 * 合法中文变成乱码，解析出 0 条 cue 而误判"无参考源"）。任何失败（不存在/无权限/解不出）
 * 返回 null，不抛——一个读不动的候选文件不该让整次检测失败。
 */
export async function readSubtitleText(path: string): Promise<string | null> {
  try {
    return decodeToUtf8(readFileSync(path)).data.toString('utf8')
  } catch {
    return null
  }
}

/**
 * 字幕内容哈希——用于判断"这个字幕文件变了，上次的检测结论作废需重检"。
 *
 * 刻意哈希**解码后的 UTF-8 文本**而非原始字节：同一份字幕以 GBK 与 UTF-8 两种编码存盘时
 * 字节完全不同但内容一致，按原始字节哈希会在一次无害的编码归一化（subtitleWriter 落盘就会做）
 * 之后判"变了"而白跑一次检测。反过来说，**时间戳变化必须被视为"变了"**——所以这里不能复用
 * subtitleDialogueFingerprint（它刻意剥掉时间戳、只哈希对白，正是为了识别"内容相同仅时轴偏移"
 * 的重复字幕）：那恰好把本模块唯一关心的维度抹掉了，平移过时间轴的字幕会哈希不变而永不重检。
 *
 * 读不到文件返回 null（调用方据此判"无从比较指纹" → 需重检，见 SubtitleVerifyRepo.needsRecheck）。
 */
export async function hashSubtitleContent(path: string): Promise<string | null> {
  const text = await readSubtitleText(path)
  if (text === null) return null
  return createHash('sha1').update(text).digest('hex')
}

/** 读 + 解码 + 解析 + 剥成 spans 的一条龙。读不到/解析不出 cue 时返回 null
 *  （0 条 cue 与读失败对调用方是同一件事：拿不到可用的时间轴）。 */
export async function loadSpans(path: string): Promise<SpeechSpan[] | null> {
  const text = await readSubtitleText(path)
  if (text === null) return null
  const cues = parseCues(text)
  if (cues.length === 0) return null
  return toSpans(cues)
}
