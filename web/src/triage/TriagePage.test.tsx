// web/src/triage/TriagePage.test.tsx：甄别 tab 集成测试——两箱渲染+空态、认领流端到端
// （打开→搜索（mock search 端点）→选条目→提交→POST body 断言→成功刷新）、搜索失败（502）降级
// 到手动 tmdbId 输入仍可提交、同目录多路径 dedupe 成一条 POST。TriagePage 自己发请求（同 Lanes
// 的自洽口径），所以 mock 全局 fetch 按 URL 路由（同 Lanes.test.tsx 的既有手法）。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { TriagePage } from './TriagePage.js'
import type { TriageDTO, TmdbSearchResponseDTO } from '../api/types.js'

const NOW = Date.now()

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

const EMPTY_TRIAGE: TriageDTO = { pending: [], claimed: [] }

function triageWithData(): TriageDTO {
  return {
    pending: [
      { path: '/media/tv/Show A/S01/a-ep1.mkv', parkReason: 'ambiguous match', firstSeen: NOW - 60_000, lastAttempt: NOW },
      { path: '/media/tv/Show A/S01/a-ep2.mkv', parkReason: 'ambiguous match', firstSeen: NOW - 60_000, lastAttempt: NOW },
      { path: '/media/tv/Show B/b-ep1.mkv', parkReason: 'no tmdb hit', firstSeen: NOW - 120_000, lastAttempt: NOW },
    ],
    claimed: [
      { pathPrefix: '/media/tv/Old Show', tmdbId: '4242', isTv: true, season: 2, createdAt: NOW - 3 * 24 * 60 * 60_000 - 60_000 },
      { pathPrefix: '/media/movies/Old Movie', tmdbId: '77', isTv: false, season: null, createdAt: NOW - 60_000 },
    ],
  }
}

const SEARCH_HITS: TmdbSearchResponseDTO = {
  results: [
    { id: 1429, name: 'Attack on Titan', year: 2013, posterPath: null },
    { id: 999, name: 'Another Show', year: null, posterPath: null },
  ],
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

/** 认领流公共前奏：渲染 → 勾选全部三行 → 点 "Claim selected" → 等对话框出现。
 *  注：行内 mono 路径尾段用 findByTitle 定位（title=全路径）——checkbox 的视觉隐藏 label 也含
 *  同一段尾段文字，裸 findByText 会因"多处同名"报错。 */
async function openClaimDialog() {
  renderPage()
  await screen.findByTitle('/media/tv/Show A/S01/a-ep1.mkv')
  fireEvent.click(screen.getByRole('checkbox', { name: 'a-ep1.mkv' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'a-ep2.mkv' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'b-ep1.mkv' }))
  fireEvent.click(screen.getByRole('button', { name: 'Claim selected' }))
  return await screen.findByRole('dialog')
}

/** fetch mock 的 POST /api/v2/triage/claim body 清单（按调用顺序）。 */
function claimBodies(fetchMock: ReturnType<typeof mockFetchRouted>): unknown[] {
  return fetchMock.mock.calls
    .filter((c) => requestInfo(c[0] as RequestInfo).path === '/api/v2/triage/claim')
    .map((c) => JSON.parse(String((c[1] as RequestInit).body)))
}

describe('TriagePage：两箱渲染', () => {
  it('待甄别箱：路径尾段（mono，title=全路径）+ park reason + 计数；已认领箱：prefix → tmdbId + 词 + S{n} + 相对时间', async () => {
    vi.stubGlobal('fetch', mockFetchRouted([{ path: '/api/v2/triage', body: triageWithData() }]))
    renderPage()

    // 待甄别箱——尾段 mono 展示行（title=全路径；checkbox 的隐藏 label 也含尾段文字，
    // 用 findByTitle 精确定位展示行本体）
    const tail = await screen.findByTitle('/media/tv/Show A/S01/a-ep1.mkv')
    expect(tail).toHaveTextContent('a-ep1.mkv')
    expect(screen.getAllByText('ambiguous match')).toHaveLength(2)
    expect(screen.getByText('no tmdb hit')).toBeInTheDocument()
    // 箱头计数
    expect(screen.getByText('3')).toBeInTheDocument()
    // 改名指引（灰字 + mono 路径形状）
    expect(screen.getByText('Title (Year)/Season NN/Title SNNENN.mkv')).toBeInTheDocument()

    // 已认领箱
    expect(screen.getByText('/media/tv/Old Show')).toBeInTheDocument()
    expect(screen.getByText('4242')).toBeInTheDocument()
    expect(screen.getByText('TV')).toBeInTheDocument()
    expect(screen.getByText('S2')).toBeInTheDocument()
    expect(screen.getByText('3d ago')).toBeInTheDocument()
    expect(screen.getByText('/media/movies/Old Movie')).toBeInTheDocument()
    expect(screen.getByText('Movie')).toBeInTheDocument()
  })

  it('Claim selected 按钮：选中 0 时禁用，勾选后可用', async () => {
    vi.stubGlobal('fetch', mockFetchRouted([{ path: '/api/v2/triage', body: triageWithData() }]))
    renderPage()
    await screen.findByTitle('/media/tv/Show A/S01/a-ep1.mkv')
    const btn = screen.getByRole('button', { name: 'Claim selected' })
    expect(btn).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox', { name: 'a-ep1.mkv' }))
    expect(btn).not.toBeDisabled()
  })

  it('两箱空态：待甄别空=好事（identifier 全部归位方向），已认领空=中性说明', async () => {
    vi.stubGlobal('fetch', mockFetchRouted([{ path: '/api/v2/triage', body: EMPTY_TRIAGE }]))
    renderPage()
    expect(await screen.findByText('Every file found its identifier')).toBeInTheDocument()
    expect(screen.getByText('No claims yet')).toBeInTheDocument()
  })
})

describe('TriagePage：认领流端到端（搜索→选条目→提交→刷新）', () => {
  it('搜索防抖后打 search 端点，选条目提交，同目录 dedupe 成一条 POST，全部成功关闭并刷新', async () => {
    const fetchMock = mockFetchRouted([
      { path: '/api/v2/triage', body: triageWithData() },
      { path: '/api/v2/tmdb/search', body: SEARCH_HITS },
      { path: '/api/v2/triage/claim', method: 'POST', body: { ok: true } },
    ])
    vi.stubGlobal('fetch', fetchMock)
    const dialog = await openClaimDialog()

    // 打开时列出选中路径（3 条 ≤5 不折叠，mono 全路径列表）
    expect(within(dialog).getByText('/media/tv/Show A/S01/a-ep1.mkv')).toBeInTheDocument()
    expect(within(dialog).getByText('/media/tv/Show B/b-ep1.mkv')).toBeInTheDocument()

    // 搜索（防抖 400ms 后真实打 mock 端点）
    fireEvent.change(within(dialog).getByPlaceholderText('Search TMDB…'), { target: { value: 'titan' } })
    expect(await within(dialog).findByText('Attack on Titan')).toBeInTheDocument()
    const searchCall = fetchMock.mock.calls.find((c) => requestInfo(c[0] as RequestInfo).path === '/api/v2/tmdb/search')
    expect(searchCall).toBeTruthy()
    expect(requestInfo(searchCall![0] as RequestInfo).url).toContain('type=tv')
    expect(requestInfo(searchCall![0] as RequestInfo).url).toContain('q=titan')

    // 选条目 → 提交
    fireEvent.click(within(dialog).getByText('Attack on Titan'))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Claim' }))

    // 同 dirname dedupe：Show A/S01 两条只 POST 一条 + Show B 一条 = 共 2 条
    await waitFor(() => expect(claimBodies(fetchMock)).toHaveLength(2))
    expect(claimBodies(fetchMock)).toEqual([
      { path: '/media/tv/Show A/S01/a-ep1.mkv', tmdbId: '1429', isTv: true },
      { path: '/media/tv/Show B/b-ep1.mkv', tmdbId: '1429', isTv: true },
    ])

    // 全部成功 → 关闭对话框 + 重新拉 triage（刷新两箱）
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    const triageCalls = fetchMock.mock.calls.filter((c) => requestInfo(c[0] as RequestInfo).path === '/api/v2/triage')
    expect(triageCalls.length).toBeGreaterThanOrEqual(2)
  })

  it('搜索失败（502）→ 如实一行灰字，手动 tmdbId + season 兜底仍可提交', async () => {
    const fetchMock = mockFetchRouted([
      { path: '/api/v2/triage', body: triageWithData() },
      { path: '/api/v2/tmdb/search', status: 502, body: { error: 'tmdb search failed' } },
      { path: '/api/v2/triage/claim', method: 'POST', body: { ok: true } },
    ])
    vi.stubGlobal('fetch', fetchMock)
    const dialog = await openClaimDialog()

    fireEvent.change(within(dialog).getByPlaceholderText('Search TMDB…'), { target: { value: 'titan' } })
    expect(
      await within(dialog).findByText('TMDB unreachable — you can still paste a tmdb id'),
    ).toBeInTheDocument()

    // 手动 tmdbId 兜底（始终可见的数字输入）+ tv 的可选 season
    fireEvent.change(within(dialog).getByRole('spinbutton', { name: 'TMDB ID' }), { target: { value: '1429' } })
    fireEvent.change(within(dialog).getByRole('spinbutton', { name: 'Season' }), { target: { value: '2' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Claim' }))

    await waitFor(() => expect(claimBodies(fetchMock)).toHaveLength(2))
    expect(claimBodies(fetchMock)[0]).toEqual({
      path: '/media/tv/Show A/S01/a-ep1.mkv', tmdbId: '1429', isTv: true, season: 2,
    })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('部分失败 → 对话框保留，逐行结果 + 失败行错误文案（不假装全部顺利）', async () => {
    // 第一条 POST 成功、第二条 400——按 path 分流。
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const { path } = requestInfo(input)
      const method = init?.method ?? 'GET'
      if (path === '/api/v2/triage' && method === 'GET') {
        return { ok: true, status: 200, json: async () => triageWithData() } as unknown as Response
      }
      if (path === '/api/v2/triage/claim' && method === 'POST') {
        const body = JSON.parse(String(init?.body)) as { path: string }
        if (body.path.includes('Show B')) {
          return { ok: false, status: 400, json: async () => ({ ok: false, error: 'path is not currently parked' }) } as unknown as Response
        }
        return { ok: true, status: 200, json: async () => ({ ok: true }) } as unknown as Response
      }
      return { ok: false, status: 404, json: async () => ({ error: 'not found' }) } as unknown as Response
    })
    vi.stubGlobal('fetch', fetchMock)
    const dialog = await openClaimDialog()

    fireEvent.change(within(dialog).getByRole('spinbutton', { name: 'TMDB ID' }), { target: { value: '77' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Claim' }))

    // 保留对话框展示结果：成功行 ✓（claimed 点）+ 失败行 ✗ + error 原文（String(Error) 带
    // "Error: " 前缀，用正则锚定后端那句人话本体）
    expect(await within(dialog).findByText(/path is not currently parked/)).toBeInTheDocument()
    expect(within(dialog).getByText('Some claims failed — review the results below.')).toBeInTheDocument()
    expect(within(dialog).getByText('a-ep1.mkv')).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })
})
