import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { OpenSubtitlesClient, osToCandidates, OsSearchResponseSchema } from './opensubtitles.js'

const fixture = JSON.parse(readFileSync('fixtures/opensubtitles/search-peacemaker-s1.json', 'utf8'))
const okJson = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))

function makeClient(fetchImpl: typeof fetch, extra: Partial<ConstructorParameters<typeof OpenSubtitlesClient>[0]> = {}) {
  return new OpenSubtitlesClient({ apiKey: 'k', appUserAgent: 'subtitlescout v0.2.0', fetchImpl, ...extra })
}

describe('OpenSubtitlesClient.search', () => {
  it('builds episode query with lowercase languages and parent_imdb_id', async () => {
    const urls: string[] = []
    const client = makeClient(((url: string) => { urls.push(String(url)); return okJson(fixture) }) as never)
    const resp = await client.search({ parentImdbId: 13146488, season: 1, episode: 1, languages: ['zh-cn', 'zh-tw'] })
    expect(urls[0]).toContain('parent_imdb_id=13146488')
    expect(urls[0]).toContain('season_number=1')
    expect(urls[0]).toContain('episode_number=1')
    expect(urls[0]).toContain('languages=zh-cn%2Czh-tw')
    expect(urls[0]).not.toMatch(/zh-CN/)
    expect(resp.data.length).toBe(2)
  })
  it('uppercases in input languages are lowercased defensively', async () => {
    const urls: string[] = []
    const client = makeClient(((url: string) => { urls.push(String(url)); return okJson(fixture) }) as never)
    await client.search({ query: 'Peacemaker', languages: ['ZH-CN'] })
    expect(urls[0]).toContain('languages=zh-cn')
  })
  it('sends Api-Key + User-Agent headers on every request', async () => {
    let headers: Record<string, string> = {}
    const client = makeClient(((url: string, init: RequestInit) => { headers = init.headers as never; return okJson(fixture) }) as never)
    await client.search({ query: 'Peacemaker', languages: ['zh-cn'] })
    expect(headers['Api-Key']).toBe('k')
    expect(headers['User-Agent']).toBe('subtitlescout v0.2.0')
  })
  it('movie query uses imdb_id, not parent_imdb_id', async () => {
    const urls: string[] = []
    const client = makeClient(((url: string) => { urls.push(String(url)); return okJson(fixture) }) as never)
    await client.search({ imdbId: 133093, languages: ['zh-cn'] })
    expect(urls[0]).toContain('imdb_id=133093')
    expect(urls[0]).not.toContain('parent_imdb_id')
  })
  it('defaults languages to zh-cn,zh-tw when empty array given', async () => {
    const urls: string[] = []
    const client = makeClient(((url: string) => { urls.push(String(url)); return okJson(fixture) }) as never)
    await client.search({ query: 'Peacemaker', languages: [] })
    expect(urls[0]).toContain('languages=zh-cn%2Czh-tw')
  })
})

describe('OpenSubtitlesClient network retry', () => {
  it('retries once on network error and succeeds on second attempt', async () => {
    let n = 0
    const client = makeClient(((_url: string) => {
      n++
      if (n === 1) return Promise.reject(new Error('ECONNRESET'))
      return okJson(fixture)
    }) as never, { networkRetryDelayMs: 0 })
    const resp = await client.search({ query: 'x', languages: ['zh-cn'] })
    expect(resp.data.length).toBe(2)
    expect(n).toBe(2)
  })
  it('throws after two network failures (single retry only)', async () => {
    let n = 0
    const client = makeClient(((_url: string) => { n++; return Promise.reject(new Error('ECONNRESET')) }) as never, { networkRetryDelayMs: 0 })
    await expect(client.search({ query: 'x', languages: ['zh-cn'] })).rejects.toThrow(/ECONNRESET/)
    expect(n).toBe(2)
  })
  it('does not retry HTTP status errors (fail fast, assrt parity)', async () => {
    let n = 0
    const client = makeClient((() => { n++; return Promise.resolve(new Response('nope', { status: 502 })) }) as never, { networkRetryDelayMs: 0 })
    await expect(client.resolveDownload(1)).rejects.toThrow(/502/)
    expect(n).toBe(1)
  })
})

describe('OpenSubtitlesClient.resolveDownload', () => {
  it('POSTs /download with file_id, no Bearer when no credentials (dev_mode)', async () => {
    let captured: { url: string; init: RequestInit } | null = null
    const client = makeClient(((url: string, init: RequestInit) => {
      captured = { url: String(url), init }
      return okJson({ link: 'https://www.opensubtitles.com/download/ABC', file_name: 'e1.srt', remaining: 99, reset_time_utc: '2026-07-10T23:59:58.000Z' })
    }) as never)
    const r = await client.resolveDownload(7174766)
    expect(captured!.url).toContain('/download')
    expect((captured!.init.headers as Record<string, string>).Authorization).toBeUndefined()
    expect(JSON.parse(String(captured!.init.body))).toEqual({ file_id: 7174766 })
    expect(r.link).toContain('/download/ABC')
    expect(r.remaining).toBe(99)
  })
  it('logs in once for concurrent calls and attaches Bearer when credentials given', async () => {
    const calls: string[] = []
    const client = makeClient(((url: string, init: RequestInit) => {
      calls.push(String(url))
      if (String(url).endsWith('/login')) return okJson({ token: 'JWT1', base_url: 'api.opensubtitles.com', user: { allowed_downloads: 20, vip: false } })
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer JWT1')
      return okJson({ link: 'L', file_name: 'f.srt', remaining: 19, reset_time_utc: '' })
    }) as never, { username: 'u', password: 'p' })
    await Promise.all([client.resolveDownload(1), client.resolveDownload(2)])
    expect(calls.filter(u => u.endsWith('/login')).length).toBe(1)
  })
  it('throws on non-2xx with endpoint in message', async () => {
    const client = makeClient((() => Promise.resolve(new Response('nope', { status: 502 }))) as never)
    await expect(client.resolveDownload(1)).rejects.toThrow(/download.*502|502.*download/)
  })
  it('re-logins and retries the request once on 401 (JWT expiry self-heal)', async () => {
    const calls: string[] = []
    let logins = 0
    let downloads = 0
    const client = makeClient(((url: string, init: RequestInit) => {
      calls.push(String(url))
      if (String(url).endsWith('/login')) {
        logins++
        return okJson({ token: `JWT${logins}`, base_url: 'api.opensubtitles.com', user: { allowed_downloads: 20, vip: false } })
      }
      downloads++
      if (downloads === 1) return Promise.resolve(new Response('token expired', { status: 401 }))
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer JWT2')
      return okJson({ link: 'L', file_name: 'f.srt', remaining: 19, reset_time_utc: '' })
    }) as never, { username: 'u', password: 'p', networkRetryDelayMs: 0 })
    const r = await client.resolveDownload(1)
    expect(r.link).toBe('L')
    expect(calls.filter(u => u.endsWith('/login')).length).toBe(2)
    expect(downloads).toBe(2)
  })
  it('throws after second consecutive 401 (no infinite re-login loop)', async () => {
    let logins = 0
    let downloads = 0
    const client = makeClient(((url: string) => {
      if (String(url).endsWith('/login')) {
        logins++
        return okJson({ token: `JWT${logins}`, base_url: 'api.opensubtitles.com', user: { allowed_downloads: 20, vip: false } })
      }
      downloads++
      return Promise.resolve(new Response('still expired', { status: 401 }))
    }) as never, { username: 'u', password: 'p', networkRetryDelayMs: 0 })
    await expect(client.resolveDownload(1)).rejects.toThrow(/401/)
    expect(downloads).toBe(2)
    expect(logins).toBe(2)
  })
})

describe('AbortSignal timeout coverage', () => {
  it('search request init carries an AbortSignal (matches assrt/tmdb clients)', async () => {
    let captured: RequestInit | null = null
    const client = makeClient(((_url: string, init: RequestInit) => { captured = init; return okJson(fixture) }) as never)
    await client.search({ query: 'x', languages: ['zh-cn'] })
    expect(captured!.signal).toBeInstanceOf(AbortSignal)
  })
  it('resolveDownload request init carries an AbortSignal', async () => {
    let captured: RequestInit | null = null
    const client = makeClient(((_url: string, init: RequestInit) => { captured = init; return okJson({ link: 'L', file_name: 'f.srt' }) }) as never)
    await client.resolveDownload(1)
    expect(captured!.signal).toBeInstanceOf(AbortSignal)
  })
})

describe('osToCandidates', () => {
  it('yields one candidate per file with providerId = file_id', () => {
    const cands = osToCandidates(OsSearchResponseSchema.parse(fixture))
    expect(cands.length).toBe(2)
    expect(cands[0]).toMatchObject({
      provider: 'opensubtitles', providerId: '7174766',
      videoName: 'peacemaker.2022.s01e01.1080p.web.h264-cakes.chs',
      language: 'zh-CN', fileList: [],
    })
    expect(cands[0].uploadDate).toBe('2022-02-18T08:20:12Z')
  })
})
