import { describe, it, expect } from 'vitest'
import { makeSubdlAdapter } from './subdlAdapter.js'
import type { SubdlSubtitle } from '../providers/subdl.js'

const SUBS: SubdlSubtitle[] = [
  { release_name: 'Inception.2010.1080p.BluRay-SECTOR7', language: 'ZH', lang: 'chinese_simplified', url: '/subtitle/3197651-3213944.zip' },
  { release_name: 'Inception.2010.720p-REFiNED', language: 'EN', lang: 'english', url: '/subtitle/3197651-9999999.zip' },
]

function fakeClient(subs: SubdlSubtitle[]) {
  return { async search() { return subs } }
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

  it('resolve 走标准 GET（providerId=url 段 → dl.subdl.com 绝对地址）', async () => {
    const a = makeSubdlAdapter(fakeClient([]))
    const r = await a.resolve({ provider: 'subdl', providerId: '/subtitle/3197651-3213944.zip', fileIndex: null }, () => {})
    expect(r.url).toBe('https://dl.subdl.com/subtitle/3197651-3213944.zip')
  })
})
