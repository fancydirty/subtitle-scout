// web/src/triage/text.test.ts：甄别区纯函数——路径处理（pathTail/dirnameOf/dedupeByDirname）
// 与双语动态文案（selectedCountLabel/moreLabel/relativeClaimedAgo）。
import { describe, it, expect } from 'vitest'
import {
  pathTail, dirnameOf, dedupeByDirname, selectedCountLabel, moreLabel, relativeClaimedAgo,
} from './text.js'

describe('pathTail', () => {
  it('绝对路径 → 最后一段文件名', () => {
    expect(pathTail('/media/tv/Show A/S01/ep1.mkv')).toBe('ep1.mkv')
  })
  it('无斜杠（防御性）→ 原样返回', () => {
    expect(pathTail('ep1.mkv')).toBe('ep1.mkv')
  })
})

describe('dirnameOf（POSIX dirname 语义）', () => {
  it('常规绝对路径', () => {
    expect(dirnameOf('/media/tv/Show A/S01/ep1.mkv')).toBe('/media/tv/Show A/S01')
  })
  it('根下文件 → "/"', () => {
    expect(dirnameOf('/ep1.mkv')).toBe('/')
  })
  it('裸文件名（防御性）→ "."', () => {
    expect(dirnameOf('ep1.mkv')).toBe('.')
  })
})

describe('dedupeByDirname——claimParked 的 override 粒度是 dirname 前缀，同目录只 POST 一条', () => {
  it('同目录多文件保留第一条、保序', () => {
    expect(
      dedupeByDirname([
        '/media/tv/Show A/S01/ep1.mkv',
        '/media/tv/Show A/S01/ep2.mkv',
        '/media/tv/Show B/ep1.mkv',
        '/media/tv/Show A/S01/ep3.mkv',
      ]),
    ).toEqual(['/media/tv/Show A/S01/ep1.mkv', '/media/tv/Show B/ep1.mkv'])
  })
  it('全部不同目录 → 原样', () => {
    expect(dedupeByDirname(['/a/x.mkv', '/b/x.mkv'])).toEqual(['/a/x.mkv', '/b/x.mkv'])
  })
})

describe('双语动态文案', () => {
  it('selectedCountLabel：en 单复数 / zh 计数', () => {
    expect(selectedCountLabel(1, 'en')).toBe('1 file selected')
    expect(selectedCountLabel(3, 'en')).toBe('3 files selected')
    expect(selectedCountLabel(3, 'zh')).toBe('已选 3 个文件')
  })
  it('moreLabel', () => {
    expect(moreLabel(4, 'en')).toBe('+4 more')
    expect(moreLabel(4, 'zh')).toBe('还有 4 个…')
  })
  it('relativeClaimedAgo：时长单位是技术值（两种语言同一套 s/m/h/d），只有前后缀跟语言走', () => {
    expect(relativeClaimedAgo(3 * 24 * 60 * 60_000 + 60_000, 'en')).toBe('3d ago')
    expect(relativeClaimedAgo(3 * 24 * 60 * 60_000 + 60_000, 'zh')).toBe('3d 前')
  })
})
