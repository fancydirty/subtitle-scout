import { describe, it, expect } from 'vitest'
import { TmdbClient, TmdbRequestFailedError } from './tmdb.js'

const okJson = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))

describe('TmdbClient.getOriginLanguage', () => {
  it('returns lowercased original_language for a movie', async () => {
    let url = ''
    const c = new TmdbClient({ apiKey: 'k', fetchImpl: ((u: string) => { url = String(u); return okJson({ original_language: 'zh' }) }) as never })
    expect(await c.getOriginLanguage('movie', '535167')).toBe('zh')
    expect(url).toContain('/movie/535167')
  })
  it('uses the tv endpoint for tv', async () => {
    let url = ''
    const c = new TmdbClient({ apiKey: 'k', fetchImpl: ((u: string) => { url = String(u); return okJson({ original_language: 'JA' }) }) as never })
    expect(await c.getOriginLanguage('tv', '1429')).toBe('ja')
    expect(url).toContain('/tv/1429')
  })
  it('returns null on genuine no-data: 404 / missing field / blank field', async () => {
    // 真·no-data（TMDB 明确答复没有可用数据）→ null，上游可安全负缓存。
    const c404 = new TmdbClient({ apiKey: 'k', fetchImpl: (() => Promise.resolve(new Response('x', { status: 404 }))) as never })
    expect(await c404.getOriginLanguage('movie', '1')).toBeNull()
    const cEmpty = new TmdbClient({ apiKey: 'k', fetchImpl: (() => okJson({})) as never })
    expect(await cEmpty.getOriginLanguage('movie', '1')).toBeNull()
    const cBlank = new TmdbClient({ apiKey: 'k', fetchImpl: (() => okJson({ original_language: '' })) as never })
    expect(await cBlank.getOriginLanguage('movie', '1')).toBeNull()
  })
  it('rejects with TmdbRequestFailedError on transient failure: network error / 5xx', async () => {
    // 旧契约（失败也折叠成 null）正是被修复的缺陷：一次 TMDB 故障会被上游当 no-data
    // 负缓存成 'unknown' 哨兵，永久关闭权威 origin gate。瞬时失败必须可观察。
    const cErr = new TmdbClient({ apiKey: 'k', fetchImpl: (() => Promise.reject(new Error('net'))) as never })
    await expect(cErr.getOriginLanguage('movie', '1')).rejects.toThrow(TmdbRequestFailedError)
    const c500 = new TmdbClient({ apiKey: 'k', fetchImpl: (() => Promise.resolve(new Response('x', { status: 500 }))) as never })
    await expect(c500.getOriginLanguage('movie', '1')).rejects.toThrow(TmdbRequestFailedError)
  })
})
