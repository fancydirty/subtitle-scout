// web/src/App.test.tsx
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { vi, afterEach } from 'vitest'
import { App } from './App.js'

const summary = { status: 'running', todayReady: 3, totalReady: 3, queuePending: 2, queueDormant: 0, runsInWindow: 3, windowHours: 168 }
const runs = { inFlight: [], runs: [{ id: 'a-1', itemId: 'a', name: '招魂', decision: 'download', outcomeLabel: '已下好中文字幕', tone: 'ok', ts: 1000, clickable: true }] }
const story = { name: '招魂', decision: 'download', outcomeLabel: '已下好中文字幕', tone: 'ok', ts: 1000,
  steps: [{ title: '认出这部片', detail: '招魂', state: 'done' }], raw: { pipelineSteps: [], llmCalls: [] } }

afterEach(() => vi.restoreAllMocks())
function mockFetch() {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
    ok: true, json: async () =>
      url.includes('/api/summary') ? summary :
      url.includes('/api/runs/a-1') ? story :
      url.includes('/api/runs') ? runs :
      { pending: [], dormant: [] },
  })) as any)
}

it('shows summary + feed, and loads story on feed click', async () => {
  mockFetch()
  render(<App />)
  await waitFor(() => expect(screen.getByText(/今天下好了/)).toBeInTheDocument())
  expect(screen.getByText('招魂')).toBeInTheDocument()
  expect(screen.getByText(/选择左侧一次运行/)).toBeInTheDocument()   // 未选时空态
  fireEvent.click(screen.getByText('招魂'))
  await waitFor(() => expect(screen.getByText('认出这部片')).toBeInTheDocument())
})
