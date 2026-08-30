import { describe, it, expect } from 'vitest'
import { countStates, isSingleFileGrid, type Target } from './targetState.js'

// 覆盖格：活动卡把一部剧的每个 target（剧集流是逐集、电影流是单枚）画成一格丸。
// 这两个纯函数只做计数与形态判定，不碰渲染——测试锁死四档计数与单格退化判据。

describe('countStates：覆盖格四档计数', () => {
  it('空数组 → 全 0', () => {
    expect(countStates([])).toEqual({ installed: 0, active: 0, pending: 0, pendingSource: 0 })
  })
  it('四档各计各的（含 pending-source 单独成档，不并入 pending）', () => {
    const targets: Target[] = [
      { key: 's01e01', label: 'E01', state: 'installed' },
      { key: 's01e02', label: 'E02', state: 'installed' },
      { key: 's01e03', label: 'E03', state: 'active' },
      { key: 's01e04', label: 'E04', state: 'pending' },
      { key: 's01e05', label: 'E05', state: 'pending-source' },
    ]
    expect(countStates(targets)).toEqual({ installed: 2, active: 1, pending: 1, pendingSource: 1 })
  })
})

describe('isSingleFileGrid：电影流退化成单枚状态丸', () => {
  it('恰一个 target 且 key===movie → true', () => {
    expect(isSingleFileGrid([{ key: 'movie', label: '电影', state: 'active' }])).toBe(true)
  })
  it('多集 → false', () => {
    const targets: Target[] = [
      { key: 's01e01', label: 'E01', state: 'active' },
      { key: 's01e02', label: 'E02', state: 'pending' },
    ]
    expect(isSingleFileGrid(targets)).toBe(false)
  })
  it('单个非 movie 键（防御）→ false', () => {
    expect(isSingleFileGrid([{ key: 's01e01', label: 'E01', state: 'active' }])).toBe(false)
  })
  it('空数组 → false', () => {
    expect(isSingleFileGrid([])).toBe(false)
  })
})
