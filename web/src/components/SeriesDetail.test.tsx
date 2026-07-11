import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { SeriesDetail } from './SeriesDetail.js'
import type { SeriesDetailDTO, LibraryItemDTO } from '../api/types.js'

const DETAIL: SeriesDetailDTO = {
  id: 's1', name: 'Love, Death & Robots', chineseTitle: '爱，死亡和机器人', year: 2019, posterTag: null,
  seasons: [
    { season: 1, episodes: [
      { id: 'e1', episode: 1, name: null, subStatus: 'covered', statusReason: null, recheckAfter: null },
      { id: 'e2', episode: 2, name: null, subStatus: 'embedded', statusReason: null, recheckAfter: null },
      { id: 'e3', episode: 3, name: null, subStatus: 'missing', statusReason: null, recheckAfter: null },
      { id: 'e4', episode: 4, name: null, subStatus: 'unavailable', statusReason: '搜索穷尽', recheckAfter: 4102444800000 },
      { id: 'e5', episode: 5, name: null, subStatus: 'needs_review', statusReason: '找到候选但把握不足（置信 0.62 < 0.75）', recheckAfter: 4102444800000 },
    ] },
  ],
  runs: [
    { startedAt: Date.now(), finishedAt: Date.now(), decision: 'download', detail: '下好一集放到位', journalPath: '/j/x' },
  ],
}

function fetchFor(job: LibraryItemDTO['job']) {
  const lib: LibraryItemDTO[] = [
    { id: 's1', kind: 'series', name: DETAIL.name, chineseTitle: DETAIL.chineseTitle, year: 2019,
      posterTag: null, coverage: { covered: 1, missing: 1, embedded: 1, unavailable: 1, needsReview: 1 }, job },
  ]
  return vi.fn(async (url: string) => {
    const body = url.includes('/api/v2/series/') ? DETAIL : lib
    return { ok: true, status: 200, json: async () => body } as unknown as Response
  })
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })

function cellClass(episode: string): string {
  const el = screen.getByText(episode).closest('.ep')
  return el?.className ?? ''
}

describe('SeriesDetail 集格子态映射', () => {
  it('job 静止：cov/emb/miss/unav/review 各态', async () => {
    vi.stubGlobal('fetch', fetchFor({ state: 'done', priority: 0 }))
    render(<SeriesDetail id="s1" />)
    expect(await screen.findByText('爱，死亡和机器人')).toBeInTheDocument()
    expect(cellClass('1')).toContain('cov')
    expect(cellClass('2')).toContain('emb')
    expect(cellClass('3')).toContain('miss')
    expect(cellClass('4')).toContain('unav')
    expect(cellClass('5')).toContain('review') // task 2: needs_review → review 格子态
    // journalPath 不暴露
    expect(screen.queryByText(/\/j\/x/)).not.toBeInTheDocument()
    // runs 人话摘要直接展示
    expect(screen.getByText('下好一集放到位')).toBeInTheDocument()
  })

  it('job 活跃：missing/unavailable/needs_review 变 work（脉冲）', async () => {
    vi.stubGlobal('fetch', fetchFor({ state: 'searching', priority: 100 }))
    render(<SeriesDetail id="s1" />)
    await screen.findByText('爱，死亡和机器人')
    expect(cellClass('1')).toContain('cov')   // covered 不受影响
    expect(cellClass('2')).toContain('emb')   // embedded 不受影响
    expect(cellClass('3')).toContain('work')  // missing → work
    expect(cellClass('4')).toContain('work')  // unavailable → work
    expect(cellClass('5')).toContain('work')  // needs_review → work
  })

  it('unavailable 集带原生 title 提示（原因 + 复查时间）', async () => {
    vi.stubGlobal('fetch', fetchFor({ state: 'done', priority: 0 }))
    render(<SeriesDetail id="s1" />)
    await screen.findByText('爱，死亡和机器人')
    const cell = screen.getByText('4').closest('.ep') as HTMLElement
    expect(cell.getAttribute('title')).toContain('搜索穷尽')
    expect(cell.getAttribute('title')).toContain('复查')
  })

  it('task 2: needs_review 集带原生 title 提示（置信数字 + 复查时间），且图例含待确认条目', async () => {
    vi.stubGlobal('fetch', fetchFor({ state: 'done', priority: 0 }))
    render(<SeriesDetail id="s1" />)
    await screen.findByText('爱，死亡和机器人')
    const cell = screen.getByText('5').closest('.ep') as HTMLElement
    expect(cell.getAttribute('title')).toContain('置信 0.62')
    expect(cell.getAttribute('title')).toContain('复查')
    expect(document.querySelector('.legend')?.textContent).toContain('找到候选，待确认')
  })
})
