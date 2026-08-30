import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SubdlClient, subdlDownloadUrl } from './subdl.js'

const searchJson = readFileSync(join(__dirname, '__fixtures__', 'subdl-search.json'), 'utf8')

function jsonRes(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } })
}

describe('subdlDownloadUrl', () => {
  it('拼 dl.subdl.com 前缀', () => {
    expect(subdlDownloadUrl('/subtitle/3197651-3213944.zip')).toBe('https://dl.subdl.com/subtitle/3197651-3213944.zip')
  })
})

describe('SubdlClient.search', () => {
  it('解析 subtitles[]（release_name/lang/language/url）', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes(200, searchJson))
    const client = new SubdlClient({ apiKey: 'k', fetchImpl })
    const subs = await client.search({ filmName: 'Inception', type: 'movie', languages: ['zh', 'en'] })
    expect(subs.length).toBe(2)
    expect(subs[0].release_name).toBe('Inception.2010.1080p.BluRay.x264-SECTOR7')
    expect(subs[0].language).toBe('ZH')
    expect(subs[0].url).toBe('/subtitle/3197651-3213944.zip')
  })

  it('imdb_id 优先于 film_name（有 imdb 时用它，更精准）', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes(200, searchJson))
    const client = new SubdlClient({ apiKey: 'k', fetchImpl })
    await client.search({ filmName: 'Inception', imdbId: 'tt1375666', type: 'movie', languages: ['zh'] })
    const url = String(fetchImpl.mock.calls[0][0])
    expect(url).toContain('imdb_id=tt1375666')
    expect(url).not.toContain('film_name=')
    expect(url).toContain('api_key=k')
  })

  // 探偵ときたら实案：film_name 英文名 "can't find film"，tmdb_id 逐集命中——tmdbId 通道优先于
  // film_name（imdb>tmdb>film_name 三级优先，imdb 优先见上一用例）。
  it('tmdb_id 优先于 film_name（仅 tmdbId 时 URL 含 tmdb_id 不含 film_name）', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes(200, searchJson))
    const client = new SubdlClient({ apiKey: 'k', fetchImpl })
    await client.search({ filmName: 'Detectives These Days Are Crazy!', tmdbId: 262377, type: 'tv', languages: ['zh'] })
    const url = String(fetchImpl.mock.calls[0][0])
    expect(url).toContain('tmdb_id=262377')
    expect(url).not.toContain('film_name=')
  })

  it('imdb_id 优先于 tmdb_id（三级优先 imdb>tmdb>film_name 的第一腿）', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes(200, searchJson))
    const client = new SubdlClient({ apiKey: 'k', fetchImpl })
    await client.search({ imdbId: 'tt1375666', tmdbId: 262377, type: 'movie', languages: ['zh'] })
    const url = String(fetchImpl.mock.calls[0][0])
    expect(url).toContain('imdb_id=tt1375666')
    expect(url).not.toContain('tmdb_id=')
  })

  it('TV 参数（season/episode）拼进查询', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes(200, '{"status":true,"subtitles":[]}'))
    const client = new SubdlClient({ apiKey: 'k', fetchImpl })
    await client.search({ filmName: 'Silo', type: 'tv', season: 2, episode: 3, languages: ['zh'] })
    const url = String(fetchImpl.mock.calls[0][0])
    expect(url).toContain('type=tv')
    expect(url).toContain('season_number=2')
    expect(url).toContain('episode_number=3')
  })

  it('status:false → 抛错带 error 文案', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes(200, '{"status":false,"error":"No result found"}'))
    const client = new SubdlClient({ apiKey: 'k', fetchImpl })
    await expect(client.search({ filmName: 'zzz', type: 'movie', languages: ['zh'] })).rejects.toThrow(/No result found/)
  })

  it('subtitles 缺失 → 空数组（宽松解析，不抛）', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes(200, '{"status":true,"results":[]}'))
    const client = new SubdlClient({ apiKey: 'k', fetchImpl })
    expect(await client.search({ filmName: 'x', type: 'movie', languages: ['zh'] })).toEqual([])
  })

  it('client=bazarr 标识请求（DX 礼貌）', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes(200, '{"status":true,"subtitles":[]}'))
    const client = new SubdlClient({ apiKey: 'k', fetchImpl })
    await client.search({ filmName: 'x', type: 'movie', languages: ['zh'] })
    expect(String(fetchImpl.mock.calls[0][0])).toContain('subtitle-scout')
  })
})
