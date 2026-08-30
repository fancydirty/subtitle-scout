import { describe, it, expect } from 'vitest'
import { makeSubdlAdapter } from './subdlAdapter.js'
import type { SubdlSubtitle, SubdlSearchArgs } from '../providers/subdl.js'

const SUBS: SubdlSubtitle[] = [
  { release_name: 'Inception.2010.1080p.BluRay-SECTOR7', language: 'ZH', lang: 'chinese_simplified', url: '/subtitle/3197651-3213944.zip' },
  { release_name: 'Inception.2010.720p-REFiNED', language: 'EN', lang: 'english', url: '/subtitle/3197651-9999999.zip' },
]

function fakeClient(subs: SubdlSubtitle[]) {
  return { async search() { return subs } }
}

/** 记录 client.search 实收参数的 fake——tmdb 映射用例要断言 adapter→client 的参数形状。 */
function recordingClient(subs: SubdlSubtitle[] = []) {
  const calls: SubdlSearchArgs[] = []
  return { calls, client: { async search(a: SubdlSearchArgs) { calls.push(a); return subs } } }
}

describe('makeSubdlAdapter', () => {
  it('name==="subdl"', () => {
    expect(makeSubdlAdapter(fakeClient([])).name).toBe('subdl')
  })

  it('enabled 恒 true（国际源，不做语言门控）', () => {
    const a = makeSubdlAdapter(fakeClient([]))
    expect(a.enabled({ queries: [], languages: ['en'] }, {} as NodeJS.ProcessEnv)).toBe(true)
    expect(a.enabled({ queries: [], languages: ['zh'] }, {} as NodeJS.ProcessEnv)).toBe(true)
    expect(a.enabled({ queries: [] }, {} as NodeJS.ProcessEnv)).toBe(true)
  })

  it('search 映射 candidate（provider/providerId/videoName/language）', async () => {
    const a = makeSubdlAdapter(fakeClient(SUBS))
    const cands = await a.search({ queries: ['Inception'], languages: ['zh', 'en'] }, () => {})
    expect(cands.length).toBe(2)
    expect(cands[0].provider).toBe('subdl')
    expect(cands[0].providerId).toBe('/subtitle/3197651-3213944.zip')
    expect(cands[0].videoName).toBe('Inception.2010.1080p.BluRay-SECTOR7')
    expect(cands[0].language).toBe('ZH')
  })

  // 探偵ときたら实案（tmdb:262377）：SubDL film_name 英文名反复 "can't find film"，tmdb_id
  // 逐集精准命中——agent 显式传 args.tmdb（照 imdb 先例），adapter 负责映射到 client 的 tmdbId。
  it('args.tmdb 数字串 → client 收 tmdbId: number', async () => {
    const { calls, client } = recordingClient()
    const a = makeSubdlAdapter(client)
    await a.search({ queries: ['Detectives These Days Are Crazy!'], tmdb: '262377', season: 1, episode: 2 }, () => {})
    expect(calls[0].tmdbId).toBe(262377)
  })

  it('imdb 与 tmdb 同给 → 两者都透传（优先级归 client，adapter 不裁剪）', async () => {
    const { calls, client } = recordingClient()
    const a = makeSubdlAdapter(client)
    await a.search({ queries: ['x'], imdb: 'tt1375666', tmdb: '262377' }, () => {})
    expect(calls[0].imdbId).toBe('tt1375666')
    expect(calls[0].tmdbId).toBe(262377)
  })

  it('args.tmdb 非数字串 → 不传 tmdbId（宁缺勿错）', async () => {
    const { calls, client } = recordingClient()
    const a = makeSubdlAdapter(client)
    await a.search({ queries: ['x'], tmdb: 'not-a-number' }, () => {})
    expect(calls[0].tmdbId).toBeUndefined()
  })

  it('resolve 走标准 GET（providerId=url 段 → dl.subdl.com 绝对地址）', async () => {
    const a = makeSubdlAdapter(fakeClient([]))
    const r = await a.resolve({ provider: 'subdl', providerId: '/subtitle/3197651-3213944.zip', fileIndex: null }, () => {})
    expect(r.url).toBe('https://dl.subdl.com/subtitle/3197651-3213944.zip')
  })
})
