import { describe, it, expect, vi } from 'vitest'
import { readFileSync, mkdtempSync, readdirSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AssrtClient, MinIntervalLimiter } from './assrt.js'

const searchFixture = readFileSync('fixtures/assrt/search-matrix.json', 'utf8')
const detailFixture = readFileSync('fixtures/assrt/detail-673114.json', 'utf8')

function makeClient(responses: string[]) {
  let i = 0
  const fetchImpl = vi.fn(async () => new Response(responses[Math.min(i++, responses.length - 1)]))
  const client = new AssrtClient({
    token: 'test-token',
    fetchImpl: fetchImpl as unknown as typeof fetch,
    limiter: new MinIntervalLimiter(0), // 测试不等待
    cacheDir: mkdtempSync(join(tmpdir(), 'assrt-')),
  })
  return { client, fetchImpl }
}

describe('AssrtClient', () => {
  it('search parses recorded fixture and passes filelist+no_muxer params', async () => {
    const { client, fetchImpl } = makeClient([searchFixture])
    const r = await client.search('The.Matrix.1999')
    expect(r.sub.subs.length).toBeGreaterThan(0)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const url = String((fetchImpl.mock.calls as any)[0][0])
    expect(url).toContain('/sub/search')
    expect(url).toContain('filelist=1')
    expect(url).toContain('no_muxer=1')
    expect(url).toContain('token=test-token')
  })

  it('detail returns download urls', async () => {
    const { client } = makeClient([detailFixture])
    const r = await client.detail(673114)
    expect(r.sub.subs[0].url).toMatch(/^http/)
  })

  it('throws AssrtApiError on non-zero status even with HTTP 200', async () => {
    const { client } = makeClient([JSON.stringify({ status: 30900, sub: { subs: [] } })])
    await expect(client.search('x')).rejects.toThrow(/30900/)
  })

  it('serves identical search from disk cache without second fetch', async () => {
    const { client, fetchImpl } = makeClient([searchFixture])
    await client.search('The.Matrix.1999')
    await client.search('The.Matrix.1999')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})

describe('MinIntervalLimiter', () => {
  it('spaces calls by the interval', async () => {
    const limiter = new MinIntervalLimiter(50)
    const t0 = Date.now()
    await limiter.wait(); await limiter.wait()
    expect(Date.now() - t0).toBeGreaterThanOrEqual(45)
  })
})

describe('AssrtClient network retry', () => {
  it('retries transient network failures then succeeds', async () => {
    let n = 0
    const fetchImpl = vi.fn(async () => {
      if (n++ === 0) throw new TypeError('fetch failed')
      return new Response(searchFixture)
    })
    const client = new AssrtClient({
      token: 't', fetchImpl: fetchImpl as unknown as typeof fetch,
      limiter: new MinIntervalLimiter(0),
      cacheDir: mkdtempSync(join(tmpdir(), 'assrt-')),
      networkRetryDelayMs: 1,
    })
    const r = await client.search('x')
    expect(r.status).toBe(0)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('does NOT retry non-zero API status', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ status: 30900, sub: { subs: [] } })))
    const client = new AssrtClient({
      token: 't', fetchImpl: fetchImpl as unknown as typeof fetch,
      limiter: new MinIntervalLimiter(0),
      cacheDir: mkdtempSync(join(tmpdir(), 'assrt-')),
      networkRetryDelayMs: 1,
    })
    await expect(client.search('x')).rejects.toThrow(/30900/)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})

describe('detail 短 TTL 缓存（10min）——季包 N 集 resolve 只打一次真请求', () => {
  it('TTL 内两次 detail(673114) → fetchImpl 只调用一次', async () => {
    const { client, fetchImpl } = makeClient([detailFixture, detailFixture])
    await client.detail(673114)
    await client.detail(673114)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('缓存文件超过 10min → 重新请求', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'assrt-'))
    const fetchImpl = vi.fn(async () => new Response(detailFixture))
    const client = new AssrtClient({
      token: 'test-token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      limiter: new MinIntervalLimiter(0),
      cacheDir,
    })
    await client.detail(673114)
    const [cacheFile] = readdirSync(cacheDir)
    const elevenMinAgo = new Date(Date.now() - 11 * 60_000)
    utimesSync(join(cacheDir, cacheFile), elevenMinAgo, elevenMinAgo)
    await client.detail(673114)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})

describe('AbortSignal timeout coverage', () => {
  it('call sends AbortSignal to fetch inside retry loop', async () => {
    const { client, fetchImpl } = makeClient([searchFixture])
    await client.search('x')
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })
})

describe('AssrtClient gems endpoints', () => {
  it('similar() calls /sub/similar with id and parses like search', async () => {
    const mockSimilarResponse = JSON.stringify({
      status: 0,
      sub: { subs: [{ id: 99, filelist: [] }] }
    })
    const { client, fetchImpl } = makeClient([mockSimilarResponse])
    const r = await client.similar(673114)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const url = String((fetchImpl.mock.calls as any)[0][0])
    expect(url).toContain('/sub/similar')
    expect(url).toContain('id=673114')
    expect(r.sub.subs[0].id).toBe(99)
  })

  it('searchByFilename() passes is_file=1 and the raw filename', async () => {
    const { client, fetchImpl } = makeClient([searchFixture])
    await client.searchByFilename('Peacemaker.S01E08.1080p.WEB.h264.mkv')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const url = String((fetchImpl.mock.calls as any)[0][0])
    expect(url).toContain('is_file=1')
    expect(url).toContain(encodeURIComponent('Peacemaker.S01E08.1080p.WEB.h264.mkv'))
    expect(url).toContain('filelist=1')
    expect(url).toContain('no_muxer=1')
  })
})
