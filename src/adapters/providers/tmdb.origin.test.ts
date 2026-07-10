import { describe, it, expect } from 'vitest'
import { TmdbClient } from './tmdb.js'

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
  it('returns null on non-2xx / missing field / network error (fail-soft)', async () => {
    const c404 = new TmdbClient({ apiKey: 'k', fetchImpl: (() => Promise.resolve(new Response('x', { status: 404 }))) as never })
    expect(await c404.getOriginLanguage('movie', '1')).toBeNull()
    const cEmpty = new TmdbClient({ apiKey: 'k', fetchImpl: (() => okJson({})) as never })
    expect(await cEmpty.getOriginLanguage('movie', '1')).toBeNull()
    const cBlank = new TmdbClient({ apiKey: 'k', fetchImpl: (() => okJson({ original_language: '' })) as never })
    expect(await cBlank.getOriginLanguage('movie', '1')).toBeNull()
    const cErr = new TmdbClient({ apiKey: 'k', fetchImpl: (() => Promise.reject(new Error('net'))) as never })
    expect(await cErr.getOriginLanguage('movie', '1')).toBeNull()
  })
})
