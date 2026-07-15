import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { Parked } from './Parked.js'
import type { ParkedItemDTO } from '../api/types.js'

const PARKED: ParkedItemDTO[] = [
  { path: '/media/tv/Unknown Show/S01/e1.mkv', parkReason: 'ambiguous match', firstSeen: Date.now(), lastAttempt: Date.now() },
]

function mockFetch(getBody: unknown, postStatus = 200, postBody: unknown = { ok: true }) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') {
      return { ok: postStatus >= 200 && postStatus < 300, status: postStatus, json: async () => postBody } as unknown as Response
    }
    return { ok: true, status: 200, json: async () => getBody } as unknown as Response
  })
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('Parked park 救援页', () => {
  it('列出 parked_paths 的路径/原因/挂起时间', async () => {
    vi.stubGlobal('fetch', mockFetch(PARKED))
    render(<Parked />)
    expect(await screen.findByText('/media/tv/Unknown Show/S01/e1.mkv')).toBeInTheDocument()
    expect(screen.getByText('ambiguous match')).toBeInTheDocument()
  })

  it('填 tmdb id 后点认领 → POST /api/parked/claim，成功后灰行 + 提示下一轮巡检生效', async () => {
    const fetchMock = mockFetch(PARKED)
    vi.stubGlobal('fetch', fetchMock)
    render(<Parked />)

    await screen.findByText('/media/tv/Unknown Show/S01/e1.mkv')
    const input = screen.getByPlaceholderText('TMDB id')
    fireEvent.change(input, { target: { value: '12345' } })
    fireEvent.click(screen.getByRole('button', { name: '认领' }))

    expect(await screen.findByText(/已认领/)).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/parked/claim'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ path: '/media/tv/Unknown Show/S01/e1.mkv', tmdbId: '12345', isTv: true }),
      }),
    )
  })

  // P7 disambiguation 补丁：可选季号输入——填了就随请求体一起发出去；留空（既有测试，见上）时
  // 请求体里完全不带 season 键，行为不变。
  it('填季号后点认领 → POST body 带上 season', async () => {
    const fetchMock = mockFetch(PARKED)
    vi.stubGlobal('fetch', fetchMock)
    render(<Parked />)

    await screen.findByText('/media/tv/Unknown Show/S01/e1.mkv')
    fireEvent.change(screen.getByPlaceholderText('TMDB id'), { target: { value: '24240' } })
    fireEvent.change(screen.getByPlaceholderText('季 (可选)'), { target: { value: '4' } })
    fireEvent.click(screen.getByRole('button', { name: '认领' }))

    expect(await screen.findByText(/已认领/)).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/parked/claim'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ path: '/media/tv/Unknown Show/S01/e1.mkv', tmdbId: '24240', isTv: true, season: 4 }),
      }),
    )
  })

  it('认领失败时该行展示错误信息', async () => {
    vi.stubGlobal('fetch', mockFetch(PARKED, 400, { ok: false, error: 'path is not currently parked' }))
    render(<Parked />)

    await screen.findByText('/media/tv/Unknown Show/S01/e1.mkv')
    fireEvent.change(screen.getByPlaceholderText('TMDB id'), { target: { value: '1' } })
    fireEvent.click(screen.getByRole('button', { name: '认领' }))

    await waitFor(() => expect(screen.getByText('path is not currently parked')).toBeInTheDocument())
  })

  it('空列表给引导文案', async () => {
    vi.stubGlobal('fetch', mockFetch([]))
    render(<Parked />)
    expect(await screen.findByText('没有未识别的文件')).toBeInTheDocument()
  })
})
