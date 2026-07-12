export interface DownloadResult { bytes: Buffer; contentType: string | null }
export interface DownloadOpts {
  fetchImpl?: typeof fetch
  retries?: number
  retryDelayMs?: number
  /** 自定义请求头(如 zimuku 归档下载需要的浏览器 UA/Accept-Language/Referer);省略则不发送
   *  除 fetch 默认值外的任何头,现有 assrt/opensubtitles 下载路径行为不变。 */
  headers?: Record<string, string>
}

export const DOWNLOAD_TIMEOUT_MS = 60_000

export async function downloadDirect(url: string, opts: DownloadOpts = {}): Promise<DownloadResult> {
  const { fetchImpl = fetch, retries = 1, retryDelayMs = 2000, headers } = opts
  let lastError: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchImpl(url, {
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
        ...(headers ? { headers } : {}),
      })
      if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
      const bytes = Buffer.from(await res.arrayBuffer())
      if (bytes.length === 0) throw new Error('download returned empty body')
      return { bytes, contentType: res.headers.get('content-type') }
    } catch (e) {
      lastError = e
      if (attempt < retries) await new Promise(r => setTimeout(r, retryDelayMs))
    }
  }
  throw lastError
}
