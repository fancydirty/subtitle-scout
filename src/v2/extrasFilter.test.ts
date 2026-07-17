import { describe, it, expect } from 'vitest'
import { isMechanicalExtra } from './extrasFilter.js'

describe('isMechanicalExtra', () => {
  it('命中 NCOP/NCED/Menu/PV/CM/Trailer/Preview 文件名', () => {
    expect(isMechanicalExtra('Show - NCOP01.mkv')).toBe(true)
    expect(isMechanicalExtra('[Group] Show NCED.mp4')).toBe(true)
    expect(isMechanicalExtra('[Group] Show Menu.mp4')).toBe(true)
    expect(isMechanicalExtra('Show PV.mkv')).toBe(true)
    expect(isMechanicalExtra('Show CM.mkv')).toBe(true)
    expect(isMechanicalExtra('Show Trailer.mkv')).toBe(true)
    expect(isMechanicalExtra('Show Preview.mkv')).toBe(true)
  })

  it('大小写不敏感', () => {
    expect(isMechanicalExtra('show ncop01.mkv')).toBe(true)
    expect(isMechanicalExtra('Show TRAILER.mkv')).toBe(true)
  })

  it('词边界负例：子串命中但不构成独立标记 → false', () => {
    expect(isMechanicalExtra('PVC_documentary.mkv')).toBe(false)
    expect(isMechanicalExtra('Comedy.mkv')).toBe(false)
    expect(isMechanicalExtra('Show S01E05.mkv')).toBe(false)
  })

  it('SP/OVA/OAD/Special 是灰区，绝不在铁案表（单独红线断言）', () => {
    expect(isMechanicalExtra('Show OVA1.mkv')).toBe(false)
    expect(isMechanicalExtra('Show SP01.mkv')).toBe(false)
    expect(isMechanicalExtra('Show OAD.mkv')).toBe(false)
    expect(isMechanicalExtra('Special.mkv')).toBe(false)
  })

  it('只看 basename：目录名里的 CM 不算', () => {
    expect(isMechanicalExtra('/media/CM Punk Show/ep1.mkv')).toBe(false)
  })
})
