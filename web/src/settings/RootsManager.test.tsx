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
  it('行 = path mono（title=全路径）+ type + 相对时间 + Remove 按钮', () => {
    renderManager(asyncOf(ROOTS))
    expect(screen.getByTitle('/media/tv')).toHaveTextContent('/media/tv')
    expect(screen.getByText('local')).toBeInTheDocument()
    expect(screen.getByText('added 3d ago')).toBeInTheDocument()
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

describe('RootsManager：加根入口', () => {
  it('roots 为空时展示一句话引导并直接展开目录浏览器', async () => {
    const fetchMock = mockFetchRouted([{ path: '/api/v2/fs/list', body: { dirs: ['media'] } }])
    vi.stubGlobal('fetch', fetchMock)
    renderManager(asyncOf([]))

    expect(screen.getByText('No media roots yet — browse below to add the first one.')).toBeInTheDocument()
    expect(await screen.findByText('media')).toBeInTheDocument()
  })

  it('roots 非空时浏览器默认收起，点击 "Add a root" 才展开', async () => {
    const fetchMock = mockFetchRouted([{ path: '/api/v2/fs/list', body: { dirs: [] } }])
    vi.stubGlobal('fetch', fetchMock)
    renderManager(asyncOf(ROOTS))

    expect(screen.queryByText('No subdirectories here.')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Add a root' }))
    expect(await screen.findByText('No subdirectories here.')).toBeInTheDocument()
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
