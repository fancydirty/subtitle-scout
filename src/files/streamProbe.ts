// 自有内嵌字幕探针：跑 ffprobe -show_streams -select_streams s，读出视频容器里的字幕轨。
// 顶替 Jellyfin MediaStreams 元数据（曾是 daemon/triggers.ts usableChineseSubtitleStreams 的
// 数据源——daemon/triggers.ts 本身已随去 Jellyfin 化整体删除）——de-Jellyfin-ization campaign P1
// （docs/design/2026-07-16-de-jellyfin-design.md）。
import { execFile as nodeExecFile } from 'node:child_process'

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

interface FfprobeShowFormatOutput {
  format?: { duration?: string }
}

function isFfprobeShowFormatOutput(value: unknown): value is FfprobeShowFormatOutput {
  if (typeof value !== 'object' || value === null) return false
  const format = (value as { format?: unknown }).format
  if (typeof format !== 'object' || format === null) return false
  return typeof (format as { duration?: unknown }).duration === 'string'
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

/** ffprobe-static 是 optionalDependency——受限网络下它那 ~50MB 内置二进制的 tarball 可能装不上，
 *  npm 会跳过它而不是让整个 install 失败。故这里对它的 import 必须是懒加载 + 可失败的：
 *  只有真走到"两个显式来源都没给"这一档才会尝试 import，且失败/缺失都归一为 null，不炸进程。
 *  探测结果按调用方是否传入了测试用 importer 决定是否写入模块级缓存——真实 import 只需成功/失败一次，
 *  重复探测不必重复 import()；测试注入的 importer 每次都新跑，不污染这份缓存。 */
type FfprobeStaticModule = { path?: string; default?: { path?: string } }

let cachedFfprobeStaticPath: string | null | undefined

async function resolveFfprobeStaticPath(): Promise<string | null> {
  if (cachedFfprobeStaticPath !== undefined) return cachedFfprobeStaticPath
  const mod = await import('ffprobe-static').catch(() => null) as FfprobeStaticModule | null
  cachedFfprobeStaticPath = mod?.path ?? mod?.default?.path ?? null
  return cachedFfprobeStaticPath
}

async function resolveFfprobeStaticPathWith(importer: () => Promise<unknown>): Promise<string | null> {
  const mod = await importer().catch(() => null) as FfprobeStaticModule | null
  return mod?.path ?? mod?.default?.path ?? null
}

/** 二进制路径解析：`opts.ffprobePath` → `process.env.FFPROBE_PATH` → 懒加载 ffprobe-static。
 *
 *  **为什么是 `||` 而不是 `??`（刻意裁决，别"顺手改回去"）**：`??` 只对 null/undefined 短路，
 *  空串是**合法值**会被原样采纳。而生产上这个变量最常见的取值恰恰是空串——
 *  `docker-compose.yml` 写 `FFPROBE_PATH: ${FFPROBE_PATH:-}`，用户没在 .env 里填时 compose
 *  会把它**设置成空串**（不是"不设置"），从而覆盖镜像 Dockerfile 的
 *  `ENV FFPROBE_PATH=/usr/bin/ffprobe`。用 `??` 的旧实现于是拿到 bin=""，绕过"二进制缺席"这道闸，
 *  `execFile("")` 抛 ERR_INVALID_ARG_VALUE 被下面的 catch 吞掉 → 探针恒返回 null →
 *  61 个文件的 embedded_langs / duration_sec 静默全 NULL，而日志报的是 `probe ok=61 failed=0`。
 *  所以这里要的正是"空白字符串也算没给"——`|| undefined` 配 `.trim()` 就是这个语义，
 *  它同时吃掉 ""、"   " 两种 compose/手填能产出的空值形态。
 *
 *  返回 null = 三档全空 = 探针不可用（调用方据契约返回 null，绝不 execFile 空串）。 */
async function resolveFfprobeBin(opts?: {
  ffprobePath?: string
  importFfprobeStatic?: () => Promise<unknown>
}): Promise<string | null> {
  const envPath = process.env.FFPROBE_PATH?.trim() || undefined
  const explicit = opts?.ffprobePath?.trim() || undefined
  return explicit
    ?? envPath
    ?? (opts?.importFfprobeStatic
      ? await resolveFfprobeStaticPathWith(opts.importFfprobeStatic)
      : await resolveFfprobeStaticPath())
}

/**
 * 探测一个视频文件的内嵌字幕轨(ffprobe `-show_streams -select_streams s`)。
 *
 * 二进制解析顺序：`opts.ffprobePath` → `process.env.FFPROBE_PATH` → 懒加载 `import('ffprobe-static')`
 * 拿它自带的二进制(容器/异构平台用前两者兜底逃生；第三档失败/包缺失一律降级为 null，不抛)。
 * 前两档的空串/纯空白**一律视为"没给"**——理由见 resolveFfprobeBin 的裁决注释。
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
 * 纯函数：结果仅依赖 (videoPath, 二进制路径)，不碰 fs.stat、不碰数据库——摄取接线是后续任务(T3)的事。
 * 唯一的例外是上面那份模块级缓存：它记的是"ffprobe-static 这个包 import 得动/得不动"这一环境事实，
 * 不是按 videoPath 记忆探测结果，不影响这里"纯函数"的语义。
 */
export async function probeEmbeddedSubtitles(
  videoPath: string,
  opts?: {
    ffprobePath?: string
    timeoutMs?: number
    execFileImpl?: typeof nodeExecFile
    /** 测试专用注入：顶替懒加载的 `import('ffprobe-static')`，绕开模块级缓存，避免测试间互相污染。 */
    importFfprobeStatic?: () => Promise<unknown>
  },
): Promise<EmbeddedSubtitleTrack[] | null> {
  const bin = await resolveFfprobeBin(opts)
  // `!bin` 而非 `bin === null`：纵深防御。上游解析已把空值归一为 null，这道闸再兜一层——
  // 即使日后有人在解析链里漏一个空串进来，也绝不会走到 execFile("")（那正是本次事故的形态：
  // 报错被 catch 吞掉，故障表现为"探针静默不可用"而非一条可见的崩溃）。
  if (!bin) return null

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

/**
 * 探测一个视频文件的时长（ffprobe `-show_format -print_format json`）。
 *
 * 二进制解析顺序与 probeEmbeddedSubtitles 完全一致（共用 resolveFfprobeBin，含"空串/纯空白
 * 视为未设置"那条裁决——两个探针共用同一条链，也就共用同一个故障面，必须一处修两处生效）。
 * 任何失败（二进制缺席、spawn 失败、JSON 解析失败、无 duration 字段或 duration 非有效数值）一律
 * 降级为 null——备料是增益，不阻塞后续流程。
 *
 * 返回值：向下取整后的秒数，失败时 null。 */
export async function probeDurationSec(
  videoPath: string,
  opts?: {
    ffprobePath?: string
    timeoutMs?: number
    execFileImpl?: typeof nodeExecFile
    /** 测试专用注入：顶替懒加载的 `import('ffprobe-static')`，绕开模块级缓存。 */
    importFfprobeStatic?: () => Promise<unknown>
  },
): Promise<number | null> {
  const bin = await resolveFfprobeBin(opts)
  // 同 probeEmbeddedSubtitles：`!bin` 是纵深防御那道闸，绝不让空串走到 execFile。
  if (!bin) return null

  const impl = opts?.execFileImpl ?? nodeExecFile
  const timeout = opts?.timeoutMs ?? 15000

  let stdout: string
  try {
    stdout = await execFileAsync(
      impl,
      bin,
      ['-v', 'quiet', '-print_format', 'json', '-show_format', videoPath],
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

  if (!isFfprobeShowFormatOutput(parsed)) return null
  const duration = parsed.format!.duration
  if (typeof duration !== 'string') return null
  const seconds = parseFloat(duration)
  if (!Number.isFinite(seconds) || seconds < 0) return null
  return Math.floor(seconds)
}
