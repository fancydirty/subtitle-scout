import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { ReconcileButton } from './ReconcileButton.js'

function mockFetch(status: number, body: unknown) {
  return vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response)
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('ReconcileButton 全仓校验按钮', () => {
  it('POSTs to /api/v2/reconcile-all on click, shows "校验中…" while in flight, then the result summary', async () => {
    let resolveFetch!: (v: Response) => void
    const fetchMock = vi.fn(() => new Promise<Response>(resolve => { resolveFetch = resolve }))
    vi.stubGlobal('fetch', fetchMock)

    render(<ReconcileButton />)
    fireEvent.click(screen.getByRole('button', { name: '全仓校验' }))

    expect(await screen.findByRole('button', { name: '校验中…' })).toBeDisabled()

    resolveFetch({
      ok: true, status: 200,
      json: async () => ({ dispatchedFindSubtitle: 3, dispatchedRealign: 1, spawnedSiblings: 0, summary: '派发了 4 个任务' }),
    } as unknown as Response)

    expect(await screen.findByText('派发了 4 个任务')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/v2/reconcile-all'), expect.objectContaining({ method: 'POST' }))
    expect(screen.getByRole('button', { name: '全仓校验' })).not.toBeDisabled()
  })

  it('shows the server error message on a non-2xx response (e.g. 503 TMDB_API_KEY missing)', async () => {
    vi.stubGlobal('fetch', mockFetch(503, { error: 'reconcile-all not configured (TMDB_API_KEY missing?)' }))
    render(<ReconcileButton />)
    fireEvent.click(screen.getByRole('button', { name: '全仓校验' }))

    expect(await screen.findByText('reconcile-all not configured (TMDB_API_KEY missing?)')).toBeInTheDocument()
  })

  it('shows a network-error message when fetch itself rejects', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))
    render(<ReconcileButton />)
    fireEvent.click(screen.getByRole('button', { name: '全仓校验' }))

    await waitFor(() => expect(screen.getByText('network down')).toBeInTheDocument())
  })
})
