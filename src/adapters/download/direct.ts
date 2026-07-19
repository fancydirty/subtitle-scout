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
      const bytes = Buffer.from(await res.arrayBuffer())
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
