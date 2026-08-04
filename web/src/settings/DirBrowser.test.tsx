// web/src/settings/DirBrowser.test.tsx：目录浏览器——mock fs/list 下钻两级 + 面包屑跳转 + 加根
// POST 断言（成功提示 + onAdded 回调）+ 400 加根失败如实展示 + 不可读目录灰字降级。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { DirBrowser } from './DirBrowser.js'

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

function renderBrowser(startPath: string, onAdded: () => void = vi.fn()) {
  return render(
    <I18nProvider>
      <DirBrowser startPath={startPath} onAdded={onAdded} />
    </I18nProvider>,
  )
}

describe('DirBrowser：下钻 + 面包屑', () => {
  it('起点列出子目录，点击下钻两级，面包屑逐级累加', async () => {
    const fetchMock = mockFetchRouted([
      { path: '/api/v2/fs/list', body: { dirs: ['tv', 'movies'] } },
    ])
    // fs/list 按 query path 区分响应——用同一路径不够，改写 mock 支持按 path 参数路由。
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const { url } = requestInfo(input)
      const path = new URL(url, 'http://localhost').searchParams.get('path')
      if (path === '/media') return { ok: true, status: 200, json: async () => ({ dirs: ['tv', 'movies'] }) } as unknown as Response
      if (path === '/media/tv') return { ok: true, status: 200, json: async () => ({ dirs: ['anime'] }) } as unknown as Response
      if (path === '/media/tv/anime') return { ok: true, status: 200, json: async () => ({ dirs: [] }) } as unknown as Response
      return { ok: false, status: 404, json: async () => ({ error: 'not found' }) } as unknown as Response
    })
    vi.stubGlobal('fetch', fetchMock)
    renderBrowser('/media')

    expect(await screen.findByText('tv')).toBeInTheDocument()
    expect(screen.getByText('movies')).toBeInTheDocument()

    fireEvent.click(screen.getByText('tv'))
    expect(await screen.findByText('anime')).toBeInTheDocument()
    // 面包屑逐级累加：/ media tv 三段都在场。
    expect(screen.getByText('media')).toBeInTheDocument()

    fireEvent.click(screen.getByText('anime'))
    expect(await screen.findByText('No subdirectories here.')).toBeInTheDocument()
    expect(screen.getByTitle('/media/tv/anime')).toHaveTextContent('/media/tv/anime')

    // 面包屑跳回上一级——点击非当前项的 "media" 段应重新拉取 /media 并回到两个子目录列表。
    fireEvent.click(screen.getByText('media'))
    expect(await screen.findByText('tv')).toBeInTheDocument()
    expect(screen.getByText('movies')).toBeInTheDocument()
  })

  it('不可读目录：灰字如实降级，不是红色告警', async () => {
    // R2D-8（R2 复审）：get()（全站共用的只读 helper）现在照 mutate() 的既有手法解析失败响应体
    // 的 {error} 字段——listMediaSubdirs 早就给出了具体原因（"path is not readable (permission
    // denied?)"），之前 get() 会把它丢在地上、只吐裸的 "path → status"。这里断言那句诚实文案
    // 真的传到了 UI 上，不只是验证降级路径落在灰字 class。
    const fetchMock = mockFetchRouted([
      { path: '/api/v2/fs/list', status: 400, body: { error: 'path is not readable (permission denied?)' } },
    ])
    vi.stubGlobal('fetch', fetchMock)
    renderBrowser('/mnt/locked')

    // DirBrowser 用 String(e) 呈现（e 是 Error 实例），JS 的 Error#toString() 自带 "Error: " 前缀
    // ——这是既有呈现方式，不是这次改动引入的，断言照实际渲染文本走。
    const err = await screen.findByText(/Couldn't list this directory: Error: path is not readable \(permission denied\?\)/)
    expect(err).toBeInTheDocument()
    expect(err.className).toContain('settings-dirbrowser-list-error')
  })
})

describe('DirBrowser：加根', () => {
  it('点击 "Add this directory" → POST 断言 → 成功提示 + onAdded 回调', async () => {
    const onAdded = vi.fn()
    const fetchMock = mockFetchRouted([
      { path: '/api/v2/fs/list', body: { dirs: [] } },
      { path: '/api/v2/settings/roots', method: 'POST', body: { ok: true } },
    ])
    vi.stubGlobal('fetch', fetchMock)
    renderBrowser('/media/tv', onAdded)

    await screen.findByText('No subdirectories here.')
    fireEvent.click(screen.getByRole('button', { name: 'Add this directory' }))

    await waitFor(() => expect(onAdded).toHaveBeenCalled())
    const call = fetchMock.mock.calls.find(
      (c) =>
        requestInfo(c[0] as RequestInfo).path === '/api/v2/settings/roots' &&
        (c[1] as RequestInit | undefined)?.method === 'POST',
    )
    expect(call).toBeTruthy()
    expect(JSON.parse(String((call![1] as RequestInit).body))).toEqual({ path: '/media/tv' })
    expect(await screen.findByText('Added — the next scan will pick it up automatically.')).toBeInTheDocument()
  })

  it('400 加根失败 → 行内如实展示（不是静默失败）', async () => {
    const fetchMock = mockFetchRouted([
      { path: '/api/v2/fs/list', body: { dirs: [] } },
      { path: '/api/v2/settings/roots', method: 'POST', status: 400, body: { error: 'path is not a directory' } },
    ])
    vi.stubGlobal('fetch', fetchMock)
    renderBrowser('/media/tv')

    await screen.findByText('No subdirectories here.')
    fireEvent.click(screen.getByRole('button', { name: 'Add this directory' }))

    expect(await screen.findByText(/path is not a directory/)).toBeInTheDocument()
  })
})

describe('DirBrowser：迁移锁', () => {
  it('DOM 里不再有 astryx-* 类名', async () => {
    const fetchMock = mockFetchRouted([{ path: '/api/v2/fs/list', body: { dirs: ['media'] } }])
    vi.stubGlobal('fetch', fetchMock)
    renderBrowser('/')
    await screen.findByText('media')
    expect(document.body.querySelector('[class*="astryx"]')).toBeNull()
  })
})
