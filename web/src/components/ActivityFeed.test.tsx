import { render, screen, fireEvent } from '@testing-library/react'
import { ActivityFeed } from './ActivityFeed.js'
import type { RunsDTO } from '../api/types.js'

const data: RunsDTO = {
  inFlight: [{ itemId: 'w', name: 'Overflow S1E2', source: 'queue' }],
  runs: [
    { id: 'a-1', itemId: 'a', name: '招魂', decision: 'download', outcomeLabel: '已下好中文字幕', tone: 'ok', ts: 1000, clickable: true },
    { id: '', itemId: 'b', name: '寻踪迷镇', decision: 'no_safe_match', outcomeLabel: '暂时没找到合适的中文字幕', tone: 'muted', ts: 900, clickable: false },
  ],
}

it('shows in-flight working row + plain-language outcomes, no jargon', () => {
  render(<ActivityFeed data={data} now={2000} selectedId={null} onSelect={() => {}} />)
  expect(screen.getByText('正在找字幕…')).toBeInTheDocument()
  expect(screen.getByText('✓ 已下好中文字幕')).toBeInTheDocument()
  expect(screen.getByText('暂时没找到合适的中文字幕')).toBeInTheDocument()
  expect(screen.queryByText(/no_safe_match|升格|gate|映射/)).toBeNull()
})

it('fires onSelect only for clickable runs', () => {
  const onSelect = vi.fn()
  render(<ActivityFeed data={data} now={2000} selectedId={null} onSelect={onSelect} />)
  fireEvent.click(screen.getByText('招魂'))
  fireEvent.click(screen.getByText('寻踪迷镇'))
  expect(onSelect).toHaveBeenCalledTimes(1)
})
