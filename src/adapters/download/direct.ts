export interface DownloadResult { bytes: Buffer; contentType: string | null; filename: string | null }

/** 从 Content-Disposition 头解析下载文件名——`filename*=UTF-8''<pct>`(RFC 5987,优先)或
 *  `filename="..."`/`filename=...`。zimuku CDN 用 `attachment; filename="[zmk.pw]xxx.srt"` 携带
 *  真实文件名+扩展名(.srt/.zip),是判 zip-vs-raw 的权威来源(writeSubtitle 按扩展名分派)。
 *  拿不到返回 null。 */
export function filenameFromContentDisposition(cd: string | null): string | null {
  if (!cd) return null
  const star = cd.match(/filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/)
  if (star) { try { return decodeURIComponent(star[1].trim()) } catch { /* fall through */ } }
  const quoted = cd.match(/filename\s*=\s*"([^"]+)"/)
  if (quoted) return quoted[1].trim()
  const bare = cd.match(/filename\s*=\s*([^;]+)/)
  if (bare) return bare[1].trim()
  return null
}
export interface DownloadOpts {
  fetchImpl?: typeof fetch
  retries?: number
  retryDelayMs?: number
  /** 自定义请求头(如 zimuku 归档下载需要的浏览器 UA/Accept-Language/Referer);省略则不发送
   *  除 fetch 默认值外的任何头,现有 assrt/opensubtitles 下载路径行为不变。 */
  headers?: Record<string, string>
  /** 可注入的超时（毫秒），默认 DOWNLOAD_TIMEOUT_MS；用于测试让挂起下载快败。 */
  timeoutMs?: number
}

/** 验收轮一：字幕文件下载单独 60s 超时。
 *  背景：ASSRT 文件下载端点曾在真站单次吊死 130s，两次下载就吃掉大半个 agent 预算
 *  （find-subtitle worker 总超时 300s），导致整个 agent 被拖 abort（job 46 / Shelby Oaks
 *  连续 12 次 "The operation was aborted due to timeout"）。60s 快败让 agent 还有余量换候选
 *  或判 retry_later，而不是把预算全烧在一条吊死的下载上。 */
export const DOWNLOAD_TIMEOUT_MS = 60_000

export class DownloadTimeoutError extends Error {
  constructor(public url: string, public timeoutMs: number) {
    const host = new URL(url).hostname
    super(`download timed out after ${timeoutMs / 1000}s: ${host}`)
  }
}

function isAbortError(e: unknown): boolean {
  return e instanceof DOMException && (e.name === 'AbortError' || e.name === 'TimeoutError')
}

/** 字幕/字幕包的合理体量上限。单条字幕通常几十 KB~几 MB,整季 zip 包也远小于此;超过 = 异常
 *  (误标的大文件、zip 炸弹的外层、纯 HTTP CDN 被 MITM 塞垃圾)。无人值守 daemon 若无上限地
 *  arrayBuffer 一个多 GB 响应会 OOM 拖垮所有在途 job。故边下边计数,超限即中止,不把整个身体
 *  读进内存才发现太大。DOWNLOAD_TIMEOUT_MS 只管墙钟,管不了字节数,两者互补。 */
export const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024 // 100 MB

/** 流式读取响应体,累计超过 cap 立即 cancel 并抛错——不等整体读完才发现超限(防 OOM)。
 *  res.body 为 null(极少数实现/空体)时回落 arrayBuffer(此时 cap 仅作事后校验)。 */
async function readBodyCapped(res: Response, cap: number): Promise<Buffer> {
  const reader = res.body?.getReader?.()
  if (!reader) {
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > cap) throw new Error(`download too large: ${buf.length} bytes > cap ${cap}`)
    return buf
  }
  const chunks: Buffer[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > cap) {
      await reader.cancel().catch(() => {})
      throw new Error(`download exceeded size cap ${cap} bytes (aborted mid-stream)`)
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks)
}

export async function downloadDirect(url: string, opts: DownloadOpts = {}): Promise<DownloadResult> {
  const { fetchImpl = fetch, retries = 1, retryDelayMs = 2000, headers, timeoutMs = DOWNLOAD_TIMEOUT_MS } = opts
  let lastError: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchImpl(url, {
        signal: AbortSignal.timeout(timeoutMs),
        ...(headers ? { headers } : {}),
      })
      if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
      // Content-Length 若已声明超限,连身体都不用读,早拒。
      const declared = Number(res.headers.get('content-length'))
      if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) {
        throw new Error(`download too large: declared ${declared} bytes > cap ${MAX_DOWNLOAD_BYTES}`)
      }
      const bytes = await readBodyCapped(res, MAX_DOWNLOAD_BYTES)
      if (bytes.length === 0) throw new Error('download returned empty body')
      return {
        bytes,
        contentType: res.headers.get('content-type'),
        filename: filenameFromContentDisposition(res.headers.get('content-disposition')),
      }
    } catch (e) {
      lastError = e
      // 文件下载超时是远端端点挂死，重试大概率继续挂；直接快败，不拖 agent 总预算。
      if (isAbortError(e)) throw new DownloadTimeoutError(url, timeoutMs)
      if (attempt < retries) await new Promise(r => setTimeout(r, retryDelayMs))
    }
  }
  throw lastError
}
