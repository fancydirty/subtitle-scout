import { render, screen, fireEvent } from '@testing-library/react'
import { StoryPanel } from './StoryPanel.js'
import type { StoryDTO } from '../api/types.js'

const story: StoryDTO = {
  name: 'Overflow · 第 1 季', decision: 'download', outcomeLabel: '已下好中文字幕', tone: 'ok', ts: 1,
  steps: [
    { title: '认出这部片', detail: 'Overflow', state: 'done' },
    { title: '去字幕站找了一圈', detail: '找到一份覆盖整季的字幕（共 8 集）', state: 'done' },
    { title: '挑了最靠谱的那份', detail: '简体中文 · 跟你的片子对得上', state: 'done' },
    { title: '下好并放到位', detail: '8 集字幕全部就位，Jellyfin 里已经能看了', state: 'done' },
  ],
  raw: { pipelineSteps: [{ name: 'seasonGraduate', at: 't' }], llmCalls: [{ point: 'identify', durationMs: 12, prompt: 'P', parsed: {} }] },
}

it('renders empty state, then story steps, then toggles raw tier-2', () => {
  const { rerender } = render(<StoryPanel story={null} loading={false} />)
  expect(screen.getByText(/选择左侧一次运行/)).toBeInTheDocument()
  rerender(<StoryPanel story={story} loading={false} />)
  expect(screen.getByText('下好并放到位')).toBeInTheDocument()
  expect(screen.getByText(/8 集字幕全部就位/)).toBeInTheDocument()
  expect(screen.queryByText(/seasonGraduate/)).toBeNull()          // tier-2 默认隐藏
  fireEvent.click(screen.getByText(/原始细节/))
  expect(screen.getByText(/seasonGraduate/)).toBeInTheDocument()   // 展开后可见
})
