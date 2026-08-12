// web/src/workflow/RunDetail.test.tsx：Plan C Task 30 迁移锁——RunDetail 此前零测试覆盖
// （活动页只测到入口），卸下 Astryx 八件后把三条硬契约钉死：
//   ① 自管 role="dialog" 与 aria-label 在（它不是 Astryx 件，是全仓唯一的固定右侧板）；
//   ② Escape 关板（useHotkeys 窗口级监听，Task 29 换源后的行为钉）；
//   ③ DOM 无 astryx-* 类名。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { I18nProvider } from '../../i18n/useT.js'
import { RunDetail } from './RunDetail.js'
import type { WorkflowRecentRunDTO } from '../../api/types.js'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

const RUN: WorkflowRecentRunDTO = {
  id: 42,
  jobId: 7,
  decision: 'installed',
  detail: 'found zimuku pack → 3 files',
  finishedAt: 1_000_000,
  seriesId: 'tmdb:1396',
  movieId: null,
  seriesName: 'Twin Peaks',
  movieName: null,
  posterPath: null,
  backdropPath: null,
  llmCalls: null,
}

function renderDetail(onClose = vi.fn()) {
  // useRunTrace 的一次性请求——回空事件列表（走"无痕迹"分支，不依赖 TraceRows）。
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true, status: 200, json: async () => ({ events: [] }),
  }) as unknown as Response))
  render(
    <I18nProvider>
      <RunDetail source={{ kind: 'worker', run: RUN }} now={1_000_060_000} onClose={onClose} onRerun={vi.fn()} />
    </I18nProvider>,
  )
  return onClose
}

describe('RunDetail：迁移锁（Astryx → components/ui，Plan C Task 30）', () => {
  it('自管 role="dialog" 与 aria-label 在（kind+id 是可及名）', () => {
    renderDetail()
    expect(screen.getByRole('dialog', { name: 'run 42' })).toBeInTheDocument()
  })

  it('Escape 关板（useHotkeys 窗口级监听）', () => {
    const onClose = renderDetail()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('DOM 里不再有 astryx-* 类名', () => {
    renderDetail()
    expect(document.body.querySelector('[class*="astryx"]')).toBeNull()
  })
})
