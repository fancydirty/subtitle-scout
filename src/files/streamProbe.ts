// 自有内嵌字幕探针：跑 ffprobe -show_streams -select_streams s，读出视频容器里的字幕轨。
// 顶替 Jellyfin MediaStreams 元数据（daemon/triggers.ts usableChineseSubtitleStreams 的数据源）——
// de-Jellyfin-ization campaign P1（docs/design/2026-07-16-de-jellyfin-design.md）。
import { execFile as nodeExecFile } from 'node:child_process'
import { path as ffprobeStaticPath } from 'ffprobe-static'

export interface EmbeddedSubtitleTrack {
  lang: string | null
  codec: string | null
  isImageBased: boolean
}

/** 图形字幕(位图叠加，无法当文本比对)的 codec_name 枚举——探针据此标 isImageBased，
 *  下游(覆盖判定)据此排除这些轨不算"已有可读字幕"。 */
const IMAGE_BASED_CODECS = new Set(['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub'])

interface FfprobeStream {
  codec_name?: string
  tags?: { language?: string }
}

interface FfprobeShowStreamsOutput {
  streams: FfprobeStream[]
}

function isFfprobeShowStreamsOutput(value: unknown): value is FfprobeShowStreamsOutput {
  return typeof value === 'object' && value !== null
    && Array.isArray((value as { streams?: unknown }).streams)
}

/** execFile 的回调签名重载到没法直接拿来当类型用——包一层 Promise，行为等价，测试里注入的
 *  execFileImpl 只需实现 (bin, args, options, callback) 这一种形状。 */
function execFileAsync(
  impl: typeof nodeExecFile,
  bin: string,
  args: readonly string[],
  options: { timeout: number },
): Promise<string> {
  return new Promise((resolve, reject) => {
    impl(bin, args as string[], options, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout.toString())
    })
  })
}

/**
 * 探测一个视频文件的内嵌字幕轨(ffprobe `-show_streams -select_streams s`)。
 *
 * 二进制解析顺序：`opts.ffprobePath` → `process.env.FFPROBE_PATH` → ffprobe-static 自带的二进制
 * (容器/异构平台用前两者兜底逃生)。
 *
 * **返回值契约(load-bearing，消费方必须遵守)**：
 * - `null` —— 探测不可用/失败(二进制缺失、execFile 报错/ENOENT、超时、JSON 解析不出来)。
 *   消费方必须降级为"仅认 sidecar"检测("宁多查勿漏配"既有口径)——**不要**把 null 当成
 *   "确认无内嵌字幕"。
 * - `[]` —— 探测成功执行，且视频容器里没有字幕轨。这才是"确认无内嵌字幕"。
 *
 * 语言标签原样返回 ffprobe 的原始 ISO 值(如 'chi'/'eng')——**不做**任何 BCP-47 归一化。
 * 消费方自行用 src/agent/languages.ts 的 langOf()/tagsForLanguage() 归一。
 *
 * 纯函数：仅依赖 (videoPath, 二进制路径)。不做记忆化、不碰 fs.stat、不碰数据库——
 * 记忆化和摄取接线是后续任务(T3)的事。
 */
export async function probeEmbeddedSubtitles(
  videoPath: string,
  opts?: { ffprobePath?: string; timeoutMs?: number; execFileImpl?: typeof nodeExecFile },
): Promise<EmbeddedSubtitleTrack[] | null> {
  const bin = opts?.ffprobePath ?? process.env.FFPROBE_PATH ?? ffprobeStaticPath
  const impl = opts?.execFileImpl ?? nodeExecFile
  const timeout = opts?.timeoutMs ?? 15000

  let stdout: string
  try {
    stdout = await execFileAsync(
      impl,
      bin,
      ['-v', 'quiet', '-print_format', 'json', '-show_streams', '-select_streams', 's', videoPath],
      { timeout },
    )
  } catch {
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return null
  }
  if (!isFfprobeShowStreamsOutput(parsed)) return null

  return parsed.streams.map(stream => ({
    lang: stream.tags?.language ?? null,
    codec: stream.codec_name ?? null,
    isImageBased: IMAGE_BASED_CODECS.has(stream.codec_name ?? ''),
  }))
}
