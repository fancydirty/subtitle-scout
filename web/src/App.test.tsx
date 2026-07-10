import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react'
import { App } from './App.js'
import type { LibraryItemDTO } from './api/types.js'

const item = (p: Partial<LibraryItemDTO> & Pick<LibraryItemDTO, 'id' | 'kind' | 'coverage'>): LibraryItemDTO =>
  ({ name: 'n', chineseTitle: null, year: null, posterTag: null, job: null, ...p })

const LIBRARY: LibraryItemDTO[] = [
  item({ id: 's1', kind: 'series', name: 'Series A', chineseTitle: '甲剧', year: 2021,
    coverage: { covered: 12, missing: 0, embedded: 0, unavailable: 0 } }),                         // full
  item({ id: 's2', kind: 'series', name: 'Series B', chineseTitle: '乙剧', year: 2024,
    coverage: { covered: 3, missing: 5, embedded: 0, unavailable: 0 } }),                           // part → missing
  item({ id: 's3', kind: 'series', name: 'Series C', chineseTitle: '丙剧', year: 2025,
    coverage: { covered: 1, missing: 8, embedded: 0, unavailable: 0 }, job: { state: 'searching', priority: 100 } }), // work
]

function mockFetch(body: unknown, ok = true) {
  return vi.fn(async () => ({ ok, status: ok ? 200 : 500, json: async () => body }) as unknown as Response)
}

beforeEach(() => { location.hash = '' })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('App 海报墙冒烟', () => {
  it('渲染标题、事实句、徽章，并按 tab 过滤', async () => {
    vi.stubGlobal('fetch', mockFetch(LIBRARY))
    render(<App />)

    expect(await screen.findByText('甲剧')).toBeInTheDocument()
    expect(screen.getByText('乙剧')).toBeInTheDocument()
    // 事实句：3 部剧 · 缺字幕 1 · 1 部处理中
    expect(screen.getByText(/3 部剧/)).toBeInTheDocument()
    expect(screen.getByText(/缺字幕 1/)).toBeInTheDocument()
    expect(screen.getByText(/1 部处理中/)).toBeInTheDocument()

    // 切到「缺字幕」：full 的甲剧消失，part 的乙剧仍在
    fireEvent.click(screen.getByText('缺字幕'))
    await waitFor(() => expect(screen.queryByText('甲剧')).not.toBeInTheDocument())
    expect(screen.getByText('乙剧')).toBeInTheDocument()

    // 切到「处理中」：只剩 work 的丙剧
    fireEvent.click(screen.getByText('处理中'))
    await waitFor(() => expect(screen.getByText('丙剧')).toBeInTheDocument())
    expect(screen.queryByText('乙剧')).not.toBeInTheDocument()
  })

  it('空库给引导文案', async () => {
    vi.stubGlobal('fetch', mockFetch([]))
    render(<App />)
    expect(await screen.findByText(/起 watch 后这里会出现你的库/)).toBeInTheDocument()
  })

  it('错误态给冷峻一行 + 重试', async () => {
    vi.stubGlobal('fetch', mockFetch({ error: 'boom' }, false))
    render(<App />)
    expect(await screen.findByText(/读取失败/)).toBeInTheDocument()
    expect(screen.getByText('重试')).toBeInTheDocument()
  })
})
