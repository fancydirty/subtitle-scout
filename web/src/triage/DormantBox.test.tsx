import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { DormantBox } from './DormantBox.js'
import type { DormantTaskDTO } from '../api/types.js'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const row = (over: Partial<DormantTaskDTO> = {}): DormantTaskDTO =>
  ({ jobId: 1, task: 'find_subtitle', targetLabel: 'The Rig, Season 2', attempts: 5, ...over })

function stub(rows: DormantTaskDTO[]) {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).includes('/workflow/dormant')) {
      return new Response(JSON.stringify(rows), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
}
const wrap = () => render(<I18nProvider initialLang="en"><DormantBox /></I18nProvider>)

describe('DormantBox', () => {
  it('空清单 → 整区不渲染', async () => {
    stub([])
    const { container } = wrap()
    await waitFor(() => expect(container.querySelector('.triage-box')).toBeNull())
  })

  it('有停车任务 → 区头计数 + targetLabel + 事实句 + mono 裸工具名', async () => {
    stub([row()])
    wrap()
    expect(await screen.findByText('Dormant tasks')).toBeInTheDocument()
    expect(screen.getByText('The Rig, Season 2')).toBeInTheDocument()
    expect(screen.getByText('Failed 5 times, automatic retries stopped.')).toBeInTheDocument()
    expect(screen.getByText('find_subtitle')).toBeInTheDocument()
  })

  it('铁律：dormant 行零按钮（唤醒通道不补，§3 决策 1）', async () => {
    stub([row(), row({ jobId: 2, targetLabel: 'Silo, Season 1' })])
    const { container } = wrap()
    await screen.findByText('The Rig, Season 2')
    expect(container.querySelectorAll('button')).toHaveLength(0)
    expect(container.querySelector('[role="button"]')).toBeNull()
  })
})
