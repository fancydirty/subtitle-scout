// web/src/api/useDashboard.test.tsx
import { render, screen, waitFor } from '@testing-library/react'
import { vi, afterEach } from 'vitest'
import { useDashboard } from './useDashboard.js'

function Probe() {
  const { summary, runs } = useDashboard()
  return <div>{summary ? `today ${summary.todayReady}` : 'loading'}{runs ? ` runs ${runs.runs.length}` : ''}</div>
}
afterEach(() => vi.restoreAllMocks())

it('loads summary + runs on mount', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
    ok: true,
    json: async () => url.includes('summary')
      ? { status: 'running', todayReady: 7, totalReady: 7, queuePending: 0, queueDormant: 0, runsInWindow: 1, windowHours: 168 }
      : { inFlight: [], runs: [{ id: 'a', itemId: 'i', name: 'X', decision: 'download', outcomeLabel: 'ok', tone: 'ok', ts: 1, clickable: true }] },
  })) as any)
  render(<Probe />)
  await waitFor(() => expect(screen.getByText('today 7 runs 1')).toBeInTheDocument())
})
