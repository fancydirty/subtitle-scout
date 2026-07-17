import { describe, it, expect } from 'vitest'
import {
  commonRootStart, breadcrumbSegments, joinDir, addedAgoLabel,
  removeRootConfirmTitle, removeRootResultLabel, secretDisplay,
} from './text.js'

describe('commonRootStart', () => {
  it('零根时回退到 /', () => {
    expect(commonRootStart([])).toBe('/')
  })
  it('单根：公共祖先就是它自己', () => {
    expect(commonRootStart(['/media/tv'])).toBe('/media/tv')
  })
  it('两根同一父目录：取公共祖先', () => {
    expect(commonRootStart(['/media/tv', '/media/movies'])).toBe('/media')
  })
  it('两根完全不相交：回退到 /', () => {
    expect(commonRootStart(['/mnt/a', '/srv/b'])).toBe('/')
  })
  it('多根，公共前缀更深一层', () => {
    expect(commonRootStart(['/data/media/tv', '/data/media/anime'])).toBe('/data/media')
  })
})

describe('breadcrumbSegments', () => {
  it('根路径只有一项', () => {
    expect(breadcrumbSegments('/')).toEqual([{ label: '/', path: '/' }])
  })
  it('逐级累加', () => {
    expect(breadcrumbSegments('/media/tv')).toEqual([
      { label: '/', path: '/' },
      { label: 'media', path: '/media' },
      { label: 'tv', path: '/media/tv' },
    ])
  })
})

describe('joinDir', () => {
  it('父目录是根时不重复斜杠', () => {
    expect(joinDir('/', 'media')).toBe('/media')
  })
  it('普通拼接', () => {
    expect(joinDir('/media', 'tv')).toBe('/media/tv')
  })
})

describe('addedAgoLabel', () => {
  it('英文：added N ago', () => {
    expect(addedAgoLabel(3 * 24 * 60 * 60_000, 'en')).toBe('added 3d ago')
  })
  it('中文：N 前加入', () => {
    expect(addedAgoLabel(3 * 24 * 60 * 60_000, 'zh')).toBe('3d 前加入')
  })
})

describe('removeRootConfirmTitle', () => {
  it('英文亮出路径', () => {
    expect(removeRootConfirmTitle('/media/tv', 'en')).toBe('Remove "/media/tv"?')
  })
  it('中文亮出路径', () => {
    expect(removeRootConfirmTitle('/media/tv', 'zh')).toBe('删除守备目录 "/media/tv"？')
  })
})

describe('removeRootResultLabel', () => {
  it('只列非零类别（英文，movies=0 时省略）', () => {
    expect(removeRootResultLabel({ episodes: 42, movies: 0, series: 3, parked: 1 }, 'en')).toBe(
      'removed 42 episodes · 3 series · 1 parked',
    )
  })
  it('单数不加 s', () => {
    expect(removeRootResultLabel({ episodes: 1, movies: 1, series: 1, parked: 0 }, 'en')).toBe(
      'removed 1 episode · 1 movie · 1 series',
    )
  })
  it('全零时给诚实说明而不是空字符串', () => {
    expect(removeRootResultLabel({ episodes: 0, movies: 0, series: 0, parked: 0 }, 'en')).toBe(
      'removed nothing — this root had no indexed rows',
    )
  })
  it('中文：只列非零类别', () => {
    expect(removeRootResultLabel({ episodes: 42, movies: 0, series: 3, parked: 1 }, 'zh')).toBe(
      '已删除 42 集·3 部剧·1 条停车记录',
    )
  })
})

describe('secretDisplay', () => {
  it('present 时展示尾 4 位', () => {
    expect(secretDisplay({ present: true, tail: 'abcd' })).toBe('····abcd')
  })
  it('未配置时 em dash', () => {
    expect(secretDisplay({ present: false, tail: '' })).toBe('—')
  })
})
