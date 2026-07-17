// web/src/triage/text.test.ts：甄别区纯函数——路径处理（pathTail/dirnameOf）、目录分组
// （groupPending，验收修复轮一 Task V2）与双语动态文案（fileCountLabel/moreLabel/relativeClaimedAgo）。
import { describe, it, expect } from 'vitest'
import {
  pathTail, dirnameOf, groupPending, fileCountLabel, moreLabel, relativeClaimedAgo,
} from './text.js'
import type { ParkedItemDTO } from '../api/types.js'

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

function row(path: string, parkReason = 'ambiguous match'): ParkedItemDTO {
  return { path, parkReason, firstSeen: 0, lastAttempt: 0 }
}

describe('groupPending——按 dirname 分组 + duplicate-content 单独分箱（claimParked 的 override 粒度=目录前缀）', () => {
  it('actionable：按目录分组，组内按 path 排序、组间按文件数降序', () => {
    const { actionable } = groupPending([
      row('/media/tv/Show B/ep1.mkv'),
      row('/media/tv/Show A/S01/ep2.mkv'),
      row('/media/tv/Show A/S01/ep1.mkv'),
    ])
    expect(actionable).toEqual([
      {
        dir: '/media/tv/Show A/S01',
        dirTail: 'S01',
        files: [row('/media/tv/Show A/S01/ep1.mkv'), row('/media/tv/Show A/S01/ep2.mkv')],
      },
      {
        dir: '/media/tv/Show B',
        dirTail: 'Show B',
        files: [row('/media/tv/Show B/ep1.mkv')],
      },
    ])
  })

  it('duplicate-content 行进 duplicates 桶，其余进 actionable 桶——两桶各自独立分组', () => {
    const { actionable, duplicates } = groupPending([
      row('/media/tv/Show A/ep1.mkv', 'ambiguous match'),
      row('/media/tv/Show A/ep2.mkv', 'duplicate-content'),
    ])
    expect(actionable).toEqual([
      { dir: '/media/tv/Show A', dirTail: 'Show A', files: [row('/media/tv/Show A/ep1.mkv', 'ambiguous match')] },
    ])
    expect(duplicates).toEqual([
      { dir: '/media/tv/Show A', dirTail: 'Show A', files: [row('/media/tv/Show A/ep2.mkv', 'duplicate-content')] },
    ])
  })

  it('组间文件数并列时按 dir 名排序，结果确定不抖动', () => {
    const { actionable } = groupPending([
      row('/media/tv/Show B/ep1.mkv'),
      row('/media/tv/Show A/ep1.mkv'),
    ])
    expect(actionable.map((g) => g.dir)).toEqual(['/media/tv/Show A', '/media/tv/Show B'])
  })

  it('空输入 → 两桶皆空', () => {
    expect(groupPending([])).toEqual({ actionable: [], duplicates: [] })
  })
})

describe('双语动态文案', () => {
  it('fileCountLabel：en 单复数 / zh 计数', () => {
    expect(fileCountLabel(1, 'en')).toBe('1 file')
    expect(fileCountLabel(3, 'en')).toBe('3 files')
    expect(fileCountLabel(3, 'zh')).toBe('3 个文件')
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
