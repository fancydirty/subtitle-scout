// web/src/settings/RootsManager.test.tsx：守备目录管理器——根行渲染（mono path+type+相对时间+
// Remove）、删根确认流（AlertDialog 文案断言 → 确认 → DELETE 调用断言 → 计数行渲染；取消不发
// 请求；404 如实展示）、空态引导直接展开浏览器、非空时点击展开浏览器。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { RootsManager } from './RootsManager.js'
import type { Async } from '../api/hooks.js'
import type { MediaRootDTO } from '../api/types.js'

const NOW = Date.now()

function asyncOf(data: MediaRootDTO[] | null, error: string | null = null, reload = vi.fn()): Async<MediaRootDTO[]> {
  return { data, loading: false, error, reload }
}

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

const ROOTS: MediaRootDTO[] = [{ path: '/media/tv', type: 'local', addedAt: NOW - 3 * 24 * 60 * 60_000 }]

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function renderManager(roots: Async<MediaRootDTO[]>) {
  return render(
    <I18nProvider>
      <RootsManager roots={roots} />
    </I18nProvider>,
  )
}

describe('RootsManager：根列表渲染', () => {
  it('行 = 路径 + Remove 按钮，不显示内部字段', () => {
    renderManager(asyncOf(ROOTS))
    expect(screen.getByTitle('/media/tv')).toHaveTextContent('/media/tv')
    expect(screen.queryByText('local')).not.toBeInTheDocument()
    expect(screen.queryByText('added 3d ago')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument()
  })
})

describe('RootsManager：删根确认流', () => {
  it('点击 Remove → AlertDialog 文案断言 → 确认 → DELETE 调用断言 → 计数行渲染', async () => {
    const reload = vi.fn()
    const fetchMock = mockFetchRouted([
      { path: '/api/v2/settings/roots', method: 'DELETE', body: { episodes: 42, movies: 0, series: 3, parked: 1 } },
    ])
    vi.stubGlobal('fetch', fetchMock)
    renderManager(asyncOf(ROOTS, null, reload))

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText('Remove "/media/tv"?')).toBeInTheDocument()
    expect(
      within(dialog).getByText(
        'This clears every indexed row under this root — episodes, movies, subtitle records, and parked entries. Files on disk are not touched.',
      ),
    ).toBeInTheDocument()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const call = fetchMock.mock.calls.find(
      (c) =>
        requestInfo(c[0] as RequestInfo).path === '/api/v2/settings/roots' &&
        (c[1] as RequestInit | undefined)?.method === 'DELETE',
    )
    expect(call).toBeTruthy()
    expect(requestInfo(call![0] as RequestInfo).url).toContain('path=%2Fmedia%2Ftv')

    expect(await within(dialog).findByText('removed 42 episodes · 3 series · 1 parked')).toBeInTheDocument()
    expect(reload).toHaveBeenCalled()
  })

  it('取消不发请求', () => {
    const fetchMock = mockFetchRouted([])
    vi.stubGlobal('fetch', fetchMock)
    renderManager(asyncOf(ROOTS))

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    const dialog = screen.getByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('404（非登记在册的守备目录）如实展示 error 文案', async () => {
    const fetchMock = mockFetchRouted([
      { path: '/api/v2/settings/roots', method: 'DELETE', status: 404, body: { error: 'not a media root' } },
    ])
    vi.stubGlobal('fetch', fetchMock)
    renderManager(asyncOf(ROOTS))

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }))

    expect(await within(dialog).findByText(/not a media root/)).toBeInTheDocument()
  })
})

describe('RootsManager：卸载清理防抖扫描', () => {
  // 缺陷回归：加根后 2 秒内切走页面（组件卸载），防抖定时器此前**无人清理**，仍会在
  // 2 秒后打一次 POST /api/v2/library/scan。
  //
  // 为什么这是真缺陷而不是"用户本来就想扫"：服务端 POST /api/v2/settings/roots 处理器
  // 在加根成功时**已经**同步踢过一次 requestIngest（src/dashboard/server.ts:745），用户
  // 要的那次扫描早跑完了。真正的坏后果在下一条用例里。
  it('加根后立刻卸载 → 2 秒后不再打 /api/v2/library/scan', async () => {
    const fetchMock = mockFetchRouted([
      { path: '/api/v2/settings/roots', method: 'POST', body: { ok: true } },
      { path: '/api/v2/library/scan', method: 'POST', body: { ok: true } },
    ])
    vi.stubGlobal('fetch', fetchMock)
    const { unmount } = renderManager(asyncOf([]))

    // 输入路径 → 点 Add a root 加根 → onAdded → debouncer.requestScan 武装定时器
    fireEvent.change(screen.getByRole('textbox', { name: 'Media folder path' }), { target: { value: '/data/media' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add folder' }))
    // 等加根**真正完成**（成功文案上屏 = onAdded 已回调 = 防抖定时器已武装），
    // 这才是缺陷描述的时序："用户加完守备目录立刻切到别的页"。
    expect(
      await screen.findByText('Added — the next scan will pick it up automatically.'),
    ).toBeInTheDocument()

    // 切页 = 卸载。此后那颗 2 秒定时器不许再打 API。
    // 用真实定时器等满 2 秒（fake timers 会卡住上面 findByText 的轮询，故不混用）。
    unmount()
    await new Promise((r) => setTimeout(r, 2100))

    const scanCalls = fetchMock.mock.calls.filter(
      (c) => requestInfo(c[0] as RequestInfo).path === '/api/v2/library/scan',
    )
    expect(scanCalls).toHaveLength(0)
  })
})

describe('RootsManager：加根入口', () => {
  it('roots 为空时展示一句话引导 + 路径输入框', () => {
    renderManager(asyncOf([]))

    expect(screen.getByText('No media folders yet — enter a path below to add the first one.')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Media folder path' })).toBeInTheDocument()
  })

  it('roots 非空时同样常驻路径输入框', () => {
    renderManager(asyncOf(ROOTS))
    expect(screen.getByRole('textbox', { name: 'Media folder path' })).toBeInTheDocument()
  })
})

describe('RootsManager：三态', () => {
  it('error 且无数据时展示重试', () => {
    const reload = vi.fn()
    render(
      <I18nProvider>
        <RootsManager roots={{ data: null, loading: false, error: 'boom', reload }} />
      </I18nProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(reload).toHaveBeenCalled()
  })
})

describe('RootsManager：迁移锁', () => {
  it('DOM 里不再有 astryx-* 类名', () => {
    renderManager(asyncOf(ROOTS))
    expect(document.body.querySelector('[class*="astryx"]')).toBeNull()
  })

  it('RemoveRootDialog 打开态：DOM 里不再有 astryx-* 类名（对话框 portal 在 body 下）', async () => {
    renderManager(asyncOf(ROOTS))
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    await screen.findByRole('alertdialog')
    expect(document.body.querySelector('[class*="astryx"]')).toBeNull()
  })
})
