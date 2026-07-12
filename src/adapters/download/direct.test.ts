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
})
