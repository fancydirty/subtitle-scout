// web/src/triage/TriagePage.test.tsx：甄别 tab 集成测试——两区收件箱（Timing → Dormant）。
//
// ── 2026-08-13：本文件从 11 条缩到 2 条 ─────────────────────────────────────
// 删掉的 9 条全部只测 PendingBox / ExcludedBox（目录分组渲染、组间降序、duplicate-content
// 归桶、无 checkbox/Claim、待甄别空态、Pending 区的 CSS/DOM 迁移锁），那两个区随 parked 族
// 整体删除——被测组件不存在了，用例没有降级形态可留。
// 正本论证见 ./TriagePage.tsx 头注释的「2.5 parked 族的结局」段。
//
// 留下的 2 条是**换算过的**，不是原样保留：
//  ① 两区集成锁 —— 原「四区集成锁」，删掉 Pending/Excluded 两区的断言，其余（Timing/Dormant
//     标题、DOM 顺序、Fix 按钮、dormant 零按钮、title 截断兜底）逐字保留。它同时是防"删一半"
//     的阳性对照：谁把 Timing 或 Dormant 也顺手删了，这条当场红。
//  ② 页面自己不再发请求 —— **新增**的负向锁。TriagePage 现在是纯布局壳（两区各自取数），
//     这条钉住"没人偷偷把 /api/v2/triage 加回来"，也钉住这一族确实是整族走的。
//
// 认领流测试更早已随认领退役整体删除（2026-07-28 两证据红线裁决，见 src/v2/triageOps.ts）。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { TriagePage } from './TriagePage.js'

function requestInfo(input: RequestInfo | URL): { path: string; url: string } {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
  return { path: raw.split('?')[0], url: raw }
}

interface Handler {
  path: string
  method?: string
  status?: number
  body: unknown
}

function mockFetchRouted(handlers: Handler[]) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const { path } = requestInfo(input)
    const method = init?.method ?? 'GET'
    const hit = handlers.find((h) => h.path === path && (h.method ?? 'GET') === method)
    if (!hit) return { ok: false, status: 404, json: async () => ({ error: 'not found' }) } as unknown as Response
    const status = hit.status ?? 200
    return { ok: status < 400, status, json: async () => hit.body } as unknown as Response
  })
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function renderPage() {
  return render(
    <I18nProvider>
      <TriagePage />
    </I18nProvider>,
  )
}

describe('TriagePage：两区收件箱集成', () => {
  const NOW2 = Date.now()

  it('两端点齐 → Timing/Dormant 两区齐渲染；dormant 零按钮', async () => {
    vi.stubGlobal('fetch', mockFetchRouted([
      { path: '/api/v2/subtitle/shifted', body: [
        { itemId: 'it-1', seriesId: 'tmdb:1', seriesName: 'Peacemaker', season: 2, episode: 3, checkedAt: NOW2 - 2 * 3_600_000, hasPriorCorrection: true },
      ] },
      { path: '/api/v2/workflow/dormant', body: [
        { jobId: 1, task: 'find_subtitle', targetLabel: 'The Rig, Season 2', attempts: 5 },
      ] },
    ]))
    const { container } = renderPage()

    // 两区标题齐（各自有数据故在场）。
    expect(await screen.findByText('Timing looks off')).toBeInTheDocument()
    expect(await screen.findByText('Dormant tasks')).toBeInTheDocument()

    // 两区按 §5.5 序竖排——DOM 顺序锁（Timing → Dormant）。**同时是"删一半"的阳性对照**：
    // 长度断言 2 让"顺手把其中一区也删了"当场红，而不是静默变成一区。
    const boxes = [...container.querySelectorAll('.triage-box')].map((el) => el.textContent ?? '')
    expect(boxes).toHaveLength(2)
    expect(boxes[0]).toContain('Timing looks off')
    expect(boxes[1]).toContain('Dormant tasks')

    // Timing 行可 Fix；Dormant 行零按钮（唤醒通道不补）。
    expect(screen.getByRole('button', { name: 'Fix the timing' })).toBeInTheDocument()
    const dormantRow = screen.getByText('The Rig, Season 2').closest('.triage-box')!
    expect(dormantRow.querySelectorAll('button')).toHaveLength(0)

    // C3（Task 23/24 评审携带，controller 裁决）：截断兜底平齐锁——Timing 行标签带 title。
    expect(screen.getByText('Peacemaker S2E03')).toHaveAttribute('title', 'Peacemaker S2E03')
  })

  it('🔴 页面自身不再发任何请求——只有两区各自那两个端点被打（parked 族整族退役的负向锁）', async () => {
    const fetchMock = mockFetchRouted([
      { path: '/api/v2/subtitle/shifted', body: [] },
      { path: '/api/v2/workflow/dormant', body: [] },
    ])
    vi.stubGlobal('fetch', fetchMock)
    renderPage()

    // 等两区各自取完数（两者都返回空 → 各自渲染 null，页面只剩页头）。
    await screen.findByText('Triage')

    const paths = fetchMock.mock.calls.map((c) => requestInfo(c[0] as RequestInfo | URL).path)
    // 已删除的端点一个都不许出现。写成"不含"而不是"等于某个集合"：将来两区自己多打一个
    // 端点不该让这条红，它守的是 parked 族**没有回来**这一件事。
    expect(paths).not.toContain('/api/v2/triage')
    expect(paths).not.toContain('/api/parked')
    expect(paths).not.toContain('/api/v2/triage/unexclude')
  })
})
