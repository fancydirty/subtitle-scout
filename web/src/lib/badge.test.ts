import { describe, it, expect } from 'vitest'
import { coverageBadge, matchesFilter, jobActive, scoutScope } from './badge.js'
import type { CoverageDTO, LibraryJobDTO } from '../api/types.js'

const cov = (p: Partial<CoverageDTO>): CoverageDTO =>
  ({ covered: 0, missing: 0, embedded: 0, unavailable: 0, ...p })
const job = (state: string): LibraryJobDTO => ({ state, priority: 0 })

describe('coverageBadge 覆盖矩阵四态', () => {
  it('全覆盖有实补集数 → full n/n', () => {
    expect(coverageBadge(cov({ covered: 12 }), null)).toEqual({ kind: 'full', text: '12/12', pulse: false })
  })
  it('纯内嵌无 scout 战果 → full ✓', () => {
    expect(coverageBadge(cov({ embedded: 8 }), null)).toEqual({ kind: 'full', text: '✓', pulse: false })
  })
  it('部分补齐 → part 分数', () => {
    expect(coverageBadge(cov({ covered: 3, missing: 5 }), null)).toEqual({ kind: 'part', text: '3/8', pulse: false })
  })
  it('全 missing（还没搜过）→ none 待搜索，区别于搜穷尽的暂无', () => {
    expect(coverageBadge(cov({ missing: 5 }), null)).toEqual({ kind: 'none', text: '待搜索', pulse: false })
  })
  it('全 unavailable（搜穷尽）→ none 暂无', () => {
    expect(coverageBadge(cov({ unavailable: 3 }), null)).toEqual({ kind: 'none', text: '暂无', pulse: false })
  })
  it('missing + unavailable 混合（部分还没搜）→ none 待搜索', () => {
    expect(coverageBadge(cov({ missing: 2, unavailable: 3 }), null)).toEqual({ kind: 'none', text: '待搜索', pulse: false })
  })
  it('queued job（wanted，未认领）不改变判定——仍按 coverage 出 待搜索', () => {
    expect(coverageBadge(cov({ missing: 5 }), job('wanted'))).toEqual({ kind: 'none', text: '待搜索', pulse: false })
  })
  it('covered + unavailable 混合 → part 计入 scope', () => {
    expect(coverageBadge(cov({ covered: 2, unavailable: 1 }), null)).toEqual({ kind: 'part', text: '2/3', pulse: false })
  })
  it('job 在跑 → work 脉冲，覆盖静态判定', () => {
    expect(coverageBadge(cov({ covered: 1, missing: 8 }), job('searching'))).toEqual({ kind: 'work', text: '1/9', pulse: true })
    expect(coverageBadge(cov({ covered: 1, missing: 8 }), job('downloading')).pulse).toBe(true)
    expect(coverageBadge(cov({ covered: 1, missing: 8 }), job('verifying')).pulse).toBe(true)
  })
  it('静止态 job（done/wanted/failed/dormant）不脉冲', () => {
    for (const s of ['done', 'wanted', 'failed', 'dormant']) {
      expect(coverageBadge(cov({ covered: 3, missing: 5 }), job(s)).pulse).toBe(false)
    }
  })
  it('全空库存条目 → none', () => {
    expect(coverageBadge(cov({}), null)).toEqual({ kind: 'none', text: '暂无', pulse: false })
  })
})

describe('jobActive / scoutScope', () => {
  it('jobActive 仅三活跃态', () => {
    expect(jobActive(job('searching'))).toBe(true)
    expect(jobActive(job('done'))).toBe(false)
    expect(jobActive(null)).toBe(false)
  })
  it('scoutScope 不计内嵌', () => {
    expect(scoutScope(cov({ covered: 2, missing: 3, unavailable: 1, embedded: 9 }))).toBe(6)
  })
})

describe('matchesFilter 与徽章一致', () => {
  it('全部 tab 收所有', () => {
    for (const k of ['full', 'part', 'work', 'none'] as const) {
      expect(matchesFilter({ kind: k, text: '', pulse: false }, 'all')).toBe(true)
    }
  })
  it('缺字幕 = part | none（内嵌 full 不入）', () => {
    expect(matchesFilter({ kind: 'part', text: '', pulse: false }, 'missing')).toBe(true)
    expect(matchesFilter({ kind: 'none', text: '', pulse: false }, 'missing')).toBe(true)
    expect(matchesFilter({ kind: 'full', text: '', pulse: false }, 'missing')).toBe(false)
    expect(matchesFilter({ kind: 'work', text: '', pulse: false }, 'missing')).toBe(false)
  })
  it('处理中 = work，已补齐 = full', () => {
    expect(matchesFilter({ kind: 'work', text: '', pulse: false }, 'working')).toBe(true)
    expect(matchesFilter({ kind: 'full', text: '', pulse: false }, 'done')).toBe(true)
    expect(matchesFilter({ kind: 'part', text: '', pulse: false }, 'done')).toBe(false)
  })
})
