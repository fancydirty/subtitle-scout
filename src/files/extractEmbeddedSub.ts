// E AI 翻译 · 内嵌字幕轨抽取:ffmpeg `-map 0:s:<index> -f srt pipe:1` 把视频容器里第 index 条
// (0-based,与 probeEmbeddedSubtitles 返回数组同序)字幕轨抽成 SRT 文本。ffmpeg ass→srt 转换保留
// 时轴与 <i> 等基本内联标签、丢弃 ASS 样式头——正是 translateWorker 需要的"冻结时轴、只译文本"输入。
//
// 二进制解析:`opts.ffmpegPath` → `process.env.FFMPEG_PATH` → 默认 `'ffmpeg'`(走 PATH)。不依赖
// ffmpeg-static(仓未装;streamProbe 用 ffprobe-static 是探针那条链)——生产镜像 Dockerfile 用 apt
// 装了系统 ffmpeg(/usr/bin/ffmpeg 在 PATH),故默认 'ffmpeg' 在容器里恒可用;缺席时 execFile
// ENOENT 报错被 catch 归一为 null。
//
// 返回值契约:成功且有非空文本 → SRT 字符串;任何失败(execFile 报错/超时/ENOENT、抽出空白)
// → null。抽取是增益的第一步,失败不阻塞、不抛——调用方(worker)据 null 判"此轨不可抽,留原态"。
import { execFile as nodeExecFile } from 'node:child_process'

function execFileAsync(
  impl: typeof nodeExecFile,
  bin: string,
  args: readonly string[],
  options: { timeout: number; maxBuffer: number },
): Promise<string> {
  return new Promise((resolve, reject) => {
    impl(bin, args as string[], options, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout.toString())
    })
  })
}

/**
 * 抽取视频第 `subtitleStreamIndex` 条(0-based)内嵌字幕轨为 SRT 文本。见文件头契约。
 */
export async function extractEmbeddedSubtitle(
  videoPath: string,
  subtitleStreamIndex: number,
  opts?: {
    ffmpegPath?: string
    timeoutMs?: number
    execFileImpl?: typeof nodeExecFile
  },
): Promise<string | null> {
  // `||` 而非 `??`（与 streamProbe.ts resolveFfprobeBin 同一条裁决，刻意，别改回去）：
  // `??` 只对 null/undefined 短路，空串是合法值会被原样采纳 → execFile("") 抛
  // ERR_INVALID_ARG_VALUE → 被下面的 catch 吞掉 → 抽取恒返回 null，静默失败。
  // 今天 compose 里没有 FFMPEG_PATH 那一行所以没爆，但 FFPROBE_PATH 正是照
  // `${FFPROBE_PATH:-}` 这个写法被 compose 设成空串而引发了一次 61 文件的静默故障；
  // 一旦有人照同样的样子给 FFMPEG_PATH 加一行，这里会以完全相同的方式静默失败。
  // 空白 trim 后为空即当"没给"，回落 'ffmpeg'（容器内 /usr/bin/ffmpeg 在 PATH）。
  const bin = opts?.ffmpegPath?.trim() || process.env.FFMPEG_PATH?.trim() || 'ffmpeg'
  const impl = opts?.execFileImpl ?? nodeExecFile
  // 默认 5min:4K 长片抽内嵌 subrip 真机可超 30s(Astronaut ~90s+);EXTRACT_TIMEOUT_MS 可配。
  const fromEnv = Number(process.env.EXTRACT_TIMEOUT_MS)
  const timeout = opts?.timeoutMs
    ?? (Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 300_000)

  let stdout: string
  try {
    stdout = await execFileAsync(
      impl,
      bin,
      // -nostdin:ffmpeg 交互模式会读 stdin,execFile 的子进程 stdin 是永不关闭的管道,
      // 一旦走交互分支就吊到超时(审计💭)。
      ['-nostdin', '-v', 'error', '-i', videoPath, '-map', `0:s:${subtitleStreamIndex}`, '-f', 'srt', 'pipe:1'],
      { timeout, maxBuffer: 32 * 1024 * 1024 },
    )
  } catch {
    return null
  }

  return stdout.trim().length > 0 ? stdout : null
}
