export interface DownloadResult { bytes: Buffer; contentType: string | null }
export interface DownloadOpts { fetchImpl?: typeof fetch; retries?: number; retryDelayMs?: number }

export const DOWNLOAD_TIMEOUT_MS = 60_000

export async function downloadDirect(url: string, opts: DownloadOpts = {}): Promise<DownloadResult> {
  const { fetchImpl = fetch, retries = 1, retryDelayMs = 2000 } = opts
  let lastError: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchImpl(url, {
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
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
