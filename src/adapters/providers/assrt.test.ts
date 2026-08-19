import { describe, it, expect, vi } from 'vitest'
import { readFileSync, writeFileSync, mkdtempSync, readdirSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { AssrtClient, MinIntervalLimiter, AssrtAllEntriesDroppedError } from './assrt.js'

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

  it('similar() 带 filelist=1(与 search 对齐,让召回的季包候选也有 fileList 供逐集导航)', async () => {
    const { client, fetchImpl } = makeClient([JSON.stringify({ status: 0, sub: { subs: [{ id: 1, filelist: [] }] } })])
    await client.similar(673114)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const url = String((fetchImpl.mock.calls as any)[0][0])
    expect(url).toContain('/sub/similar')
    expect(url).toContain('filelist=1')
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

  it('quota probe never reuses a cached success for a different token', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'assrt-'))
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 0, user: { quota: 10 } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 20001, errmsg: 'invalid token' })))
    const validClient = new AssrtClient({
      token: 'valid-token', fetchImpl: fetchImpl as unknown as typeof fetch,
      limiter: new MinIntervalLimiter(0), cacheDir,
    })
    const invalidClient = new AssrtClient({
      token: 'invalid-token', fetchImpl: fetchImpl as unknown as typeof fetch,
      limiter: new MinIntervalLimiter(0), cacheDir,
    })

    await expect(validClient.quota()).resolves.toMatchObject({ status: 0 })
    await expect(invalidClient.quota()).rejects.toThrow(/20001/)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
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

describe('AssrtClient fail-soft entry parsing (production incident: ASSRT /sub/similar returned sub.subs[2..4] without id)', () => {
  // 复现生产事故形状：好条目中间穿插缺 id 的条目（真实观测：索引 2..4 缺 id）
  const mixedSubsResponse = JSON.stringify({
    status: 0,
    sub: {
      subs: [
        { id: 1, filelist: [] },
        { id: 2, filelist: [] },
        { filelist: [] }, // 缺 id — index 2
        { filelist: [] }, // 缺 id — index 3
        { filelist: [] }, // 缺 id — index 4
        { id: 6, filelist: [] },
      ],
    },
  })
  const allMalformedResponse = JSON.stringify({
    status: 0,
    sub: { subs: [{ filelist: [] }, { filelist: [] }] },
  })

  it('similar() drops id-less entries, keeps well-formed ones, does not throw', async () => {
    const { client } = makeClient([mixedSubsResponse])
    const r = await client.similar(673114)
    expect(r.sub.subs.map(s => s.id)).toEqual([1, 2, 6])
  })

  it('similar() with ALL entries malformed (droppedEntries>0, kept===0) → throws, does NOT silently report empty (CRITICAL fix: a provider malfunction must never masquerade as "no candidates" and get negative-cached)', async () => {
    const { client } = makeClient([allMalformedResponse])
    await expect(client.similar(673114)).rejects.toThrow(AssrtAllEntriesDroppedError)
    await expect(client.similar(673114)).rejects.toThrow(/sub\/similar.*all 2 entries.*malformed/)
  })

  it('genuinely empty response (subs: {} from the real API zero-result shape, zero dropped) still returns empty WITHOUT throwing — that is an honest content conclusion, not a provider malfunction', async () => {
    const emptyResponse = readFileSync('fixtures/assrt/search-empty.json', 'utf8')
    const { client } = makeClient([emptyResponse])
    const r = await client.search('The Astronaut (2025)')
    expect(r.sub.subs).toEqual([])
  })

  // MINOR-2 (over-drop protection): id present + genuinely-loose-but-valid field shapes must NOT
  // be mistaken for malformed entries by filterMalformedSubs — every field below is schema-valid
  // per AssrtSubSchema's own preprocess/nullish semantics (see schemas.ts), not a bug to filter out.
  it('quirky-but-schema-valid entries (filelist:{}, native_name as array, lang:null, unknown extra field) survive the filter — over-drop protection', async () => {
    const quirkyResponse = JSON.stringify({
      status: 0,
      sub: {
        subs: [
          { id: 1, filelist: {} }, // filelist 空对象——FileListSchema 的 preprocess 归一化为 []
          { id: 2, filelist: [], native_name: ['名字A', '名字B'] }, // native_name 数组形式（union 允许）
          { id: 3, filelist: [], lang: null }, // lang 显式 null（nullish）
          { id: 4, filelist: [], some_future_field: 'unrecognized' }, // passthrough：未知字段不该导致丢弃
          { filelist: [] }, // 唯一真正畸形的一条——缺 id
        ],
      },
    })
    const { client } = makeClient([quirkyResponse])
    const r = await client.similar(673114)
    expect(r.sub.subs.map(s => s.id)).toEqual([1, 2, 3, 4])
  })

  it('similar() reports dropped-entry count via onApiCall (existing observability idiom)', async () => {
    const fetchImpl = vi.fn(async () => new Response(mixedSubsResponse))
    const onApiCall = vi.fn()
    const client = new AssrtClient({
      token: 't',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      limiter: new MinIntervalLimiter(0),
      cacheDir: mkdtempSync(join(tmpdir(), 'assrt-')),
      onApiCall,
    })
    await client.similar(673114)
    expect(onApiCall).toHaveBeenCalledWith(expect.objectContaining({ endpoint: 'sub/similar', droppedEntries: 3 }))
  })

  it('similar() does NOT report droppedEntries when nothing was dropped', async () => {
    const fetchImpl = vi.fn(async () => new Response(searchFixture))
    const onApiCall = vi.fn()
    const client = new AssrtClient({
      token: 't',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      limiter: new MinIntervalLimiter(0),
      cacheDir: mkdtempSync(join(tmpdir(), 'assrt-')),
      onApiCall,
    })
    await client.similar(673114)
    expect(onApiCall).toHaveBeenCalledWith(expect.not.objectContaining({ droppedEntries: expect.anything() }))
  })

  it('search() also drops id-less entries (primary search must not fail worse than similar())', async () => {
    const { client } = makeClient([mixedSubsResponse])
    const r = await client.search('x')
    expect(r.sub.subs.map(s => s.id)).toEqual([1, 2, 6])
  })

  it('searchByFilename() also drops id-less entries', async () => {
    const { client } = makeClient([mixedSubsResponse])
    const r = await client.searchByFilename('x.mkv')
    expect(r.sub.subs.map(s => s.id)).toEqual([1, 2, 6])
  })

  it('detail() also drops id-less entries (season-pack resolve must not infinite-retry on one bad entry)', async () => {
    const { client } = makeClient([mixedSubsResponse])
    const r = await client.detail(673114)
    expect(r.sub.subs.map(s => s.id)).toEqual([1, 2, 6])
  })

  it('genuinely broken response (status != 0) still throws — completeness guard stays intact', async () => {
    const { client } = makeClient([JSON.stringify({ status: 30900, sub: { subs: [] } })])
    await expect(client.similar(673114)).rejects.toThrow(/30900/)
  })
})

describe('IMPORTANT fix: cache-HIT path applies the same per-entry filter as fresh fetch (production incident: a malformed payload written to disk under main kept throwing ZodError on every cache hit until TTL)', () => {
  // 复现 call() 的私有 cachePath() 算法（sha1(endpoint + JSON.stringify(params))），供测试直接
  // 往磁盘缓存目录里"种"一个已经畸形的响应，模拟"main 分支写脏缓存，本分支部署后命中它"的场景。
  function seedCache(cacheDir: string, endpoint: string, params: Record<string, string>, body: string) {
    const key = createHash('sha1').update(endpoint + JSON.stringify(params)).digest('hex')
    writeFileSync(join(cacheDir, `${key}.json`), body)
  }

  const mixedCachedPayload = JSON.stringify({
    status: 0,
    sub: { subs: [{ id: 1, filelist: [] }, { filelist: [] }, { id: 3, filelist: [] }] }, // 索引 1 缺 id
  })
  const allMalformedCachedPayload = JSON.stringify({
    status: 0,
    sub: { subs: [{ filelist: [] }, { filelist: [] }] },
  })

  it('cache hit with a mixed malformed payload on disk → filtered on read, good entries returned, fetchImpl never called', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'assrt-'))
    seedCache(cacheDir, 'sub/similar', { id: '673114', filelist: '1' }, mixedCachedPayload)
    const fetchImpl = vi.fn(async () => { throw new Error('must not fetch — this is a cache-hit test') })
    const client = new AssrtClient({
      token: 't', fetchImpl: fetchImpl as unknown as typeof fetch,
      limiter: new MinIntervalLimiter(0), cacheDir,
    })
    const r = await client.similar(673114)
    expect(r.sub.subs.map(s => s.id)).toEqual([1, 3])
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('cache hit with an ALL-malformed payload on disk → throws AssrtAllEntriesDroppedError (CRITICAL fix applies on cache-read too), no ZodError leak, fetchImpl never called', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'assrt-'))
    seedCache(cacheDir, 'sub/similar', { id: '673114', filelist: '1' }, allMalformedCachedPayload)
    const fetchImpl = vi.fn(async () => { throw new Error('must not fetch — this is a cache-hit test') })
    const client = new AssrtClient({
      token: 't', fetchImpl: fetchImpl as unknown as typeof fetch,
      limiter: new MinIntervalLimiter(0), cacheDir,
    })
    let caught: unknown
    try { await client.similar(673114) } catch (e) { caught = e }
    expect(caught).toBeInstanceOf(AssrtAllEntriesDroppedError)
    expect(String(caught)).not.toMatch(/ZodError|invalid_type|Invalid input/i)
    expect(fetchImpl).not.toHaveBeenCalled()
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
