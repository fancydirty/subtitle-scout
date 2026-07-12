import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { History } from './History.js'
import type { RunHistoryDTO } from '../api/types.js'

const RUNS: RunHistoryDTO[] = [
  { id: 1, jobId: 1, startedAt: Date.now(), finishedAt: Date.now(), decision: 'download', detail: '已下好中文字幕', journalPath: '/j/a' },
  { id: 2, jobId: 2, startedAt: Date.now(), finishedAt: Date.now(), decision: 'realigned', detail: '把 40 集平铺整理成 3 季，字幕已就位', journalPath: null },
  { id: 3, jobId: 3, startedAt: Date.now(), finishedAt: Date.now(), decision: 'no_safe_match', detail: '没找到合适的中文字幕', journalPath: '/j/c' },
]

function mockFetch(body: unknown) {
  return vi.fn(async () => ({ ok: true, status: 200, json: async () => body }) as unknown as Response)
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('History 运行历史', () => {
  it('realigned 决策展示为成功语气（rd ok），与 download 同级，no_safe_match 仍是 rd no', async () => {
    vi.stubGlobal('fetch', mockFetch(RUNS))
    render(<History />)

    const downloadRow = await screen.findByText('已下好中文字幕')
    expect(downloadRow.className).toBe('rd ok')

    const realignRow = screen.getByText('把 40 集平铺整理成 3 季，字幕已就位')
    expect(realignRow.className).toBe('rd ok')

    const noMatchRow = screen.getByText('没找到合适的中文字幕')
    expect(noMatchRow.className).toBe('rd no')
  })
})
