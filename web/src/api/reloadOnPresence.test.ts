// web/src/api/reloadOnPresence.test.ts：媒体库该不该因在场变化再拉一次。
//
// found 序号变了 → 刚装上字幕，覆盖数字可能变了。
// health.current 从有变无 → 本轮扫盘已排进主循环，详情格该从 pending 变成覆盖态。
// 其余跃迁（含 null→null、非 null→非 null 哪怕换了作品）不触发——不定时轮询。
import { describe, it, expect } from 'vitest'
import { shouldReloadMedia } from './reloadOnPresence.js'
import type { ScoutCurrentDTO } from './types.js'

const current = (over: Partial<ScoutCurrentDTO> = {}): ScoutCurrentDTO => ({
  kind: 'subtitle', title: 'A', index: 0, total: 1,
  workId: 'tmdb:1', backdropPath: null, chineseTitle: null,
  startedAt: 1, lastStep: null, ...over,
})

describe('shouldReloadMedia', () => {
  it('foundSeq !== prevFoundSeq → true', () => {
    expect(shouldReloadMedia(null, null, 2, 1)).toBe(true)
    expect(shouldReloadMedia(current(), current(), 5, 4)).toBe(true)
  })

  it('prev !== null && next === null → true', () => {
    expect(shouldReloadMedia(current(), null, 1, 1)).toBe(true)
  })

  it('otherwise false（含 null→null、非 null→非 null 同/不同 current）', () => {
    expect(shouldReloadMedia(null, null, 0, 0)).toBe(false)
    expect(shouldReloadMedia(null, null, 3, 3)).toBe(false)
    expect(shouldReloadMedia(current(), current(), 1, 1)).toBe(false)
    expect(shouldReloadMedia(current(), current({ workId: 'tmdb:2' }), 1, 1)).toBe(false)
    expect(shouldReloadMedia(null, current(), 1, 1)).toBe(false)
  })
})
