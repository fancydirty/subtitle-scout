import { describe, it, expect, vi } from 'vitest'
import { downloadDirect } from './direct.js'

describe('downloadDirect', () => {
  it('returns bytes on success', async () => {
    const fetchImpl = vi.fn(async () => new Response(Buffer.from('subtitle content')))
    const r = await downloadDirect('http://file0.assrt.net/x.ass', { fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(r.bytes.toString()).toBe('subtitle content')
    expect(r.bytes.length).toBeGreaterThan(0)
  })
  it('retries once on failure then succeeds', async () => {
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(new Response(Buffer.from('ok')))
    const r = await downloadDirect('http://x/y.ass', { fetchImpl: fetchImpl as unknown as typeof fetch, retryDelayMs: 1 })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(r.bytes.toString()).toBe('ok')
  })
  it('throws after exhausting retries', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('nope', { status: 403 }))
    await expect(downloadDirect('http://x/y.ass', { fetchImpl: fetchImpl as unknown as typeof fetch, retryDelayMs: 1 }))
      .rejects.toThrow(/403/)
  })
  it('rejects empty bodies', async () => {
    const fetchImpl = vi.fn(async () => new Response(Buffer.alloc(0)))
    await expect(downloadDirect('http://x/y.ass', { fetchImpl: fetchImpl as unknown as typeof fetch, retryDelayMs: 1 }))
      .rejects.toThrow(/empty/i)
  })
  it('sends AbortSignal timeout to fetch inside retry loop', async () => {
    const fetchImpl = vi.fn(async () => new Response(Buffer.from('ok')))
    await downloadDirect('http://x/y.ass', { fetchImpl: fetchImpl as unknown as typeof fetch })
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })
  it('forwards custom headers to fetchImpl when provided (zimuku archive download needs browser UA/Referer)', async () => {
    const fetchImpl = vi.fn(async () => new Response(Buffer.from('ok')))
    const headers = { 'User-Agent': 'test-ua', Referer: 'https://www.zimuku.org/' }
    await downloadDirect('http://x/y.zip', { fetchImpl: fetchImpl as unknown as typeof fetch, headers })
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.headers).toEqual(headers)
  })
  it('omits headers from the fetch init when not provided (existing assrt/OS downloads unaffected)', async () => {
    const fetchImpl = vi.fn(async () => new Response(Buffer.from('ok')))
    await downloadDirect('http://x/y.ass', { fetchImpl: fetchImpl as unknown as typeof fetch })
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.headers).toBeUndefined()
  })
  it('rejects with a human-readable timeout error when fetch hangs', async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      return new Promise<Response>((_, reject) => {
        const onAbort = () => reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
        if (init.signal?.aborted) {
          onAbort()
          return
        }
        init.signal?.addEventListener('abort', onAbort, { once: true })
      })
    })
    const url = 'http://file0.assrt.net/x.ass'
    await expect(
      downloadDirect(url, { fetchImpl: fetchImpl as unknown as typeof fetch, timeoutMs: 1, retries: 0 })
    ).rejects.toThrow(/download timed out after .+s: file0\.assrt\.net/i)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [calledUrl, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(calledUrl).toBe(url)
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })
  it('returns bytes on success even when a short timeoutMs is injected', async () => {
    const fetchImpl = vi.fn(async () => new Response(Buffer.from('subtitle content')))
    const r = await downloadDirect('http://file0.assrt.net/x.ass', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 10,
    })
    expect(r.bytes.toString()).toBe('subtitle content')
  })
})
