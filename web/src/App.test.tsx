// web/src/App.test.tsx：dashboard-F2 新外壳冒烟测试。覆盖：外壳渲染（四 tab 项在场）、
// tab 切换、fetch mock 下新鲜度行渲染、fetch 失败降级不白屏、⌘K 开合。
// i18n 完整性测试在 web/src/i18n/i18n.test.ts（不需要挂组件树，纯表对比更快更直接）。
//
// 查询手法说明：侧栏 tab 项渲染成 <a href="#/xxx">（SideNavItem 传了 href），跟顶栏面包屑
// 的同名当前项文字（纯 <span>）会重名——统一用 getByRole('link', {name}) 定位侧栏项，
// 避免 getByText 因为"多处同名"报错。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react'
import { App } from './App.js'
import type { WorkflowPendingDTO } from './api/types.js'

function mockFetch(body: unknown, ok = true) {
  return vi.fn(async () => ({ ok, status: ok ? 200 : 500, json: async () => body }) as unknown as Response)
}

const WORKFLOW: WorkflowPendingDTO = {
  series: [],
  movies: [],
  parked: 3,
  meta: { roots: ['/media'], lastScanAt: Date.now() - 2 * 60_000, files: 568 },
}

beforeEach(() => {
  location.hash = ''
  // 部分 Node/jsdom 组合下 window.localStorage 本身就是 undefined（Node 自带的实验性全局
  // localStorage 会跟 jsdom 环境撞——这不是本任务要修的坑，i18n/useT.ts 已经对这种情况做了
  // try/catch 降级；这里只是尽力清一下，清不掉也不影响这些测试）。
  try {
    window.localStorage.clear()
  } catch {
    /* 环境不提供 localStorage 时无需清理 */
  }
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('App 外壳冒烟', () => {
  it('渲染四个 tab 项', async () => {
    vi.stubGlobal('fetch', mockFetch(WORKFLOW))
    render(<App />)

    expect(await screen.findByRole('link', { name: 'Library' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Workflow' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /^Triage/ })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Settings' })).toBeInTheDocument()
  })

  it('点击侧栏 tab 切换 hash 路由，对应占位内容跟着换', async () => {
    vi.stubGlobal('fetch', mockFetch(WORKFLOW))
    render(<App />)

    await screen.findByRole('link', { name: 'Library' })
    expect(screen.getByText('No library yet')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('link', { name: 'Workflow' }))
    await waitFor(() => expect(screen.getByText('No active work')).toBeInTheDocument())
    expect(location.hash).toBe('#/workflow')
    expect(screen.queryByText('No library yet')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('link', { name: /^Triage/ }))
    await waitFor(() => expect(screen.getByText('Nothing parked')).toBeInTheDocument())
    expect(location.hash).toBe('#/triage')
  })

  it('fetch 成功时顶栏渲染 mono 新鲜度行（watching/scanned/files 三段）', async () => {
    vi.stubGlobal('fetch', mockFetch(WORKFLOW))
    render(<App />)

    expect(
      await screen.findByText('watching /media · scanned 2m ago · 568 files'),
    ).toBeInTheDocument()
    // 甄别角标：parked=3 时应该出现在侧栏 Triage 项旁边。
    expect(screen.getByText('3')).toBeInTheDocument()
  })

  it('fetch 失败时外壳骨架仍在，不白屏——新鲜度行降级显示，甄别角标不渲染', async () => {
    vi.stubGlobal('fetch', mockFetch({ error: 'boom' }, false))
    render(<App />)

    // 外壳本身（四 tab 项）必须完整渲染，不能因为这一个请求失败就整屏空白。
    expect(await screen.findByRole('link', { name: 'Library' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Workflow' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /^Triage/ })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Settings' })).toBeInTheDocument()
    // 新鲜度行降级为冷静的 mono 灰字，不是报错弹窗。
    await waitFor(() => expect(screen.getByText('offline')).toBeInTheDocument())
    // 无数据时不显示甄别角标。
    expect(screen.queryByText('3')).not.toBeInTheDocument()
  })

  it('⌘K：点击触发器打开，Escape 关闭', async () => {
    vi.stubGlobal('fetch', mockFetch(WORKFLOW))
    render(<App />)
    await screen.findByRole('link', { name: 'Library' })

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('Find anything'))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toBeInTheDocument()
    // 四个 tab 都是 bootstrap 结果，导航面板里应该能看到（跟侧栏重复渲染的同名文字互不冲突，
    // getAllByText 至少命中一个即可）。
    expect(screen.getAllByText('Workflow').length).toBeGreaterThan(0)

    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('⌘K：选中一项后跳转对应 tab 并关闭面板', async () => {
    vi.stubGlobal('fetch', mockFetch(WORKFLOW))
    render(<App />)
    await screen.findByRole('link', { name: 'Library' })

    fireEvent.click(screen.getByText('Find anything'))
    await screen.findByRole('dialog')

    const items = screen.getAllByText('Settings')
    // 最后一个是面板内的 CommandPaletteItem（第一个是侧栏项，是 <a>；CommandK 作为 Shell 的
    // 最后一个子树渲染在 DOM 更靠后的位置）。
    fireEvent.click(items[items.length - 1])

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(location.hash).toBe('#/settings')
    await waitFor(() => expect(screen.getByText('Settings coming soon')).toBeInTheDocument())
  })
})
