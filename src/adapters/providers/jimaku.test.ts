import { describe, it, expect } from 'vitest'
import { JimakuClient, JimakuHttpError, JIMAKU_BASE } from './jimaku.js'

const okJson = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))

describe('JimakuClient.search', () => {
  it('query 路径带 Authorization 裸 key,解析 entry 数组', async () => {
    const urls: string[] = []
    const headers: HeadersInit[] = []
    const client = new JimakuClient({
      apiKey: 'k-test',
      fetchImpl: ((url: string, init?: RequestInit) => {
        urls.push(String(url))
        headers.push(init?.headers ?? {})
        return okJson([{ id: 729, name: 'Sousou no Frieren', anilist_id: 154587, english_name: 'Frieren' }])
      }) as never,
    })
    const r = await client.search({ query: 'Frieren' })
    expect(urls[0]).toBe(`${JIMAKU_BASE}/entries/search?query=Frieren`)
    expect((headers[0] as Record<string, string>).Authorization).toBe('k-test')
    expect(r).toEqual([{ id: 729, name: 'Sousou no Frieren', anilist_id: 154587, english_name: 'Frieren' }])
  })

  it('anilist_id 精确检索', async () => {
    const urls: string[] = []
    const client = new JimakuClient({
      apiKey: 'k',
      fetchImpl: ((url: string) => { urls.push(String(url)); return okJson([]) }) as never,
    })
    await client.search({ anilistId: 154587 })
    expect(urls[0]).toContain('anilist_id=154587')
  })

  it('401 → JimakuHttpError', async () => {
    const client = new JimakuClient({
      apiKey: 'bad',
      fetchImpl: (() => Promise.resolve(new Response('{"error":"unauthorized"}', { status: 401 }))) as never,
    })
    await expect(client.search({ query: 'x' })).rejects.toBeInstanceOf(JimakuHttpError)
  })
})

describe('JimakuClient.files', () => {
  it('带 episode 过滤拉文件列表', async () => {
    const urls: string[] = []
    const client = new JimakuClient({
      apiKey: 'k',
      fetchImpl: ((url: string) => {
        urls.push(String(url))
        return okJson([{ url: 'https://jimaku.cc/entry/729/download/a.srt', name: 'Frieren - 01.srt', size: 1 }])
      }) as never,
    })
    const r = await client.files(729, 1)
    expect(urls[0]).toBe(`${JIMAKU_BASE}/entries/729/files?episode=1`)
    expect(r[0].name).toContain('01')
  })

  it('无 episode → 不带 query', async () => {
    const urls: string[] = []
    const client = new JimakuClient({
      apiKey: 'k',
      fetchImpl: ((url: string) => { urls.push(String(url)); return okJson([]) }) as never,
    })
    await client.files(729)
    expect(urls[0]).toBe(`${JIMAKU_BASE}/entries/729/files`)
  })
})
