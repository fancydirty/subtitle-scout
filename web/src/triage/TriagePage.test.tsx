// web/src/triage/TriagePage.test.tsx：甄别 tab 集成测试（验收修复轮一 Task V2 全面重写）——
// 目录分组渲染（组头=目录尾段 mono+计数、组间按文件数降序、无逐行 checkbox）、认领流端到端
// （打开单目录组对话框→搜索/手动 tmdbId→提交一条 claim→成功关闭+刷新+该组置灰沉底+计数减除，
// 失败保留对话框如实展示）。TriagePage 自己发请求（同 Lanes 的自洽口径），所以 mock 全局 fetch
// 按 URL 路由（同 Lanes.test.tsx 的既有手法）。
//
// duplicates 折叠箱已退役（P2 起 ingest 不再产 duplicate-content 停车行，PendingBox.tsx 文件头
// 注释）——历史遗留的 duplicate-content 行不再单独分桶，样本数据里的 Show C（reason 仍标
// duplicate-content，模拟老数据）现在随其余行一起进 actionable 分组区正常展示。
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

// 目录分组样本：Show A/S01 两集（组内文件最多，按文件数降序排最前）、Show B 一集
// （actionable 合计 3 文件）——两个计数（3 顶部/2 每组/1 每组）互不相同，dirTail
// （S01/Show B）也互不相同，测试断言不需要额外 DOM 作用域即可消歧。duplicate-content 历史行
// 的展示行为单独用一份局部 fixture 测（见下方"历史遗留 duplicate-content 行"测试），不混进这份
// 被认领流等大量测试共用的主 fixture，免得扰动那些测试依赖的组排序/计数假设。
function triageWithData(): TriageDTO {
  return {
    pending: [
      { path: '/media/tv/Show A/S01/a-ep1.mkv', parkReason: 'ambiguous match', firstSeen: NOW - 60_000, lastAttempt: NOW },
      { path: '/media/tv/Show A/S01/a-ep2.mkv', parkReason: 'ambiguous match', firstSeen: NOW - 60_000, lastAttempt: NOW },
      { path: '/media/tv/Show B/b-ep1.mkv', parkReason: 'no tmdb hit', firstSeen: NOW - 120_000, lastAttempt: NOW },
    ],
    claimed: [
      { pathPrefix: '/media/tv/Old Show', tmdbId: '4242', isTv: true, season: 2, createdAt: NOW - 3 * 24 * 60 * 60_000 - 60_000, source: 'human' as const },
      { pathPrefix: '/media/movies/Old Movie', tmdbId: '77', isTv: false, season: null, createdAt: NOW - 60_000, source: 'agent' as const },
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

/** 认领流公共前奏：渲染 → 等目录组渲染完成 → 点最大的那个可认领组（Show A/S01，2 个文件，
 *  按文件数降序排最前）的 Claim 按钮 → 等对话框出现。 */
async function openClaimDialog() {
  renderPage()
  await screen.findByText('S01')
  const claimButtons = screen.getAllByRole('button', { name: 'Claim' })
  fireEvent.click(claimButtons[0])
  return await screen.findByRole('dialog')
}

/** fetch mock 的 POST /api/v2/triage/claim body 清单（按调用顺序）。 */
function claimBodies(fetchMock: ReturnType<typeof mockFetchRouted>): unknown[] {
  return fetchMock.mock.calls
    .filter((c) => requestInfo(c[0] as RequestInfo).path === '/api/v2/triage/claim')
    .map((c) => JSON.parse(String((c[1] as RequestInit).body)))
}

describe('TriagePage：目录分组渲染（验收修复轮一 Task V2）', () => {
  it('待甄别箱按目录分组：组头=目录尾段 mono + 文件计数，组体=文件名只读列表；箱头计数=actionable 文件数', async () => {
    vi.stubGlobal('fetch', mockFetchRouted([{ path: '/api/v2/triage', body: triageWithData() }]))
    renderPage()

    expect(await screen.findByText('S01')).toBeInTheDocument()
    expect(screen.getByText('Show B')).toBeInTheDocument()
    expect(screen.getByText('2 files')).toBeInTheDocument()
    expect(screen.getByText('1 file')).toBeInTheDocument()
    expect(screen.getByTitle('/media/tv/Show A/S01/a-ep1.mkv')).toHaveTextContent('a-ep1.mkv')
    expect(screen.getByTitle('/media/tv/Show A/S01/a-ep2.mkv')).toHaveTextContent('a-ep2.mkv')
    expect(screen.getByTitle('/media/tv/Show B/b-ep1.mkv')).toHaveTextContent('b-ep1.mkv')
    // 箱头计数：actionable 总文件数（S01 的 2 + Show B 的 1 = 3）。
    expect(screen.getByText('3')).toBeInTheDocument()

    // 改名指引恒定渲染（原有断言延续）
    expect(screen.getByText('Title (Year)/Season NN/Title SNNENN.mkv')).toBeInTheDocument()

    // 已认领箱不变
    expect(screen.getByText('/media/tv/Old Show')).toBeInTheDocument()
    expect(screen.getByText('4242')).toBeInTheDocument()
    expect(screen.getByText('TV')).toBeInTheDocument()
    expect(screen.getByText('S2')).toBeInTheDocument()
    expect(screen.getByText('3d ago')).toBeInTheDocument()
    expect(screen.getByText('/media/movies/Old Movie')).toBeInTheDocument()
    expect(screen.getByText('Movie')).toBeInTheDocument()
  })

  it('组间按文件数降序：Show A/S01（2 文件）排在 Show B（1 文件）之前', async () => {
    vi.stubGlobal('fetch', mockFetchRouted([{ path: '/api/v2/triage', body: triageWithData() }]))
    const { container } = renderPage()
    await screen.findByText('S01')
    const actionable = container.querySelector('.triage-actionable-groups')
    const tails = [...actionable!.querySelectorAll('.triage-dirgroup-tail')].map((el) => el.textContent)
    expect(tails).toEqual(['S01', 'Show B'])
  })

  // duplicates 桶已退役（P2 起 ingest 不再产 duplicate-content 停车行）——历史遗留的
  // duplicate-content 行不再被单独过滤进一个折叠箱，就是一个普普通通的 actionable 目录组：
  // 正常参与排序、正常给 Claim 按钮、正常计入箱头计数。用局部 fixture（不是共享的
  // triageWithData()）避免扰动其余测试依赖的组排序假设。
  it('历史遗留 duplicate-content 行 → 不再单独分桶折叠，就是普通 actionable 组（有 Claim 按钮，计入箱头计数）', async () => {
    const data: TriageDTO = {
      pending: [
        { path: '/media/tv/Show C/c-ep1.mkv', parkReason: 'duplicate-content', firstSeen: NOW - 30_000, lastAttempt: NOW },
      ],
      claimed: [],
    }
    vi.stubGlobal('fetch', mockFetchRouted([{ path: '/api/v2/triage', body: data }]))
    renderPage()

    expect(await screen.findByText('Show C')).toBeInTheDocument()
    expect(screen.getByTitle('/media/tv/Show C/c-ep1.mkv')).toHaveTextContent('c-ep1.mkv')
    // 计入箱头计数（1），不是被隔离在别处的 4——这里就是普通 actionable 桶的行为。
    expect(screen.getByText('1')).toBeInTheDocument()
    // 有 Claim 按钮——不再是 duplicates 桶那种"不给认领"的组卡。
    expect(screen.getAllByRole('button', { name: 'Claim' })).toHaveLength(1)
    // 没有 Duplicates 折叠区这种东西了。
    expect(screen.queryByText(/Duplicates —/)).not.toBeInTheDocument()
  })

  it('页面无逐行 checkbox（多选已撤）', async () => {
    vi.stubGlobal('fetch', mockFetchRouted([{ path: '/api/v2/triage', body: triageWithData() }]))
    renderPage()
    await screen.findByText('S01')
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0)
  })

  it('两箱空态：待甄别空=好事（identifier 全部归位方向），已认领空=中性说明', async () => {
    vi.stubGlobal('fetch', mockFetchRouted([{ path: '/api/v2/triage', body: EMPTY_TRIAGE }]))
    renderPage()
    expect(await screen.findByText('Every file found its identifier')).toBeInTheDocument()
    expect(screen.getByText('No claims yet')).toBeInTheDocument()
  })
})

describe('TriagePage：组认领对话框（收单目录，文件列表只读，无 checkbox）', () => {
  it('点组的 Claim → 对话框展示该组全部文件（只读全路径），无 checkbox', async () => {
    vi.stubGlobal('fetch', mockFetchRouted([{ path: '/api/v2/triage', body: triageWithData() }]))
    const dialog = await openClaimDialog()
    expect(within(dialog).getByText('/media/tv/Show A/S01/a-ep1.mkv')).toBeInTheDocument()
    expect(within(dialog).getByText('/media/tv/Show A/S01/a-ep2.mkv')).toBeInTheDocument()
    expect(within(dialog).queryAllByRole('checkbox')).toHaveLength(0)
  })
})

describe('TriagePage：认领流端到端（搜索→选条目→提交→刷新→置灰）', () => {
  it('搜索防抖后打 search 端点，选条目提交一条 claim（组内第一个文件的 path），成功关闭并刷新', async () => {
    const fetchMock = mockFetchRouted([
      { path: '/api/v2/triage', body: triageWithData() },
      { path: '/api/v2/tmdb/search', body: SEARCH_HITS },
      { path: '/api/v2/triage/claim', method: 'POST', body: { ok: true } },
    ])
    vi.stubGlobal('fetch', fetchMock)
    const dialog = await openClaimDialog()

    fireEvent.change(within(dialog).getByPlaceholderText('Search TMDB…'), { target: { value: 'titan' } })
    expect(await within(dialog).findByText('Attack on Titan')).toBeInTheDocument()
    const searchCall = fetchMock.mock.calls.find((c) => requestInfo(c[0] as RequestInfo).path === '/api/v2/tmdb/search')
    expect(searchCall).toBeTruthy()
    expect(requestInfo(searchCall![0] as RequestInfo).url).toContain('type=tv')
    expect(requestInfo(searchCall![0] as RequestInfo).url).toContain('q=titan')

    fireEvent.click(within(dialog).getByText('Attack on Titan'))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Claim' }))

    // 一条 claim，取组内第一个文件（按 path 排序后 a-ep1.mkv 排在 a-ep2.mkv 之前）。
    await waitFor(() => expect(claimBodies(fetchMock)).toHaveLength(1))
    expect(claimBodies(fetchMock)).toEqual([
      { path: '/media/tv/Show A/S01/a-ep1.mkv', tmdbId: '1429', isTv: true },
    ])

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

    fireEvent.change(within(dialog).getByRole('spinbutton', { name: 'TMDB ID' }), { target: { value: '1429' } })
    fireEvent.change(within(dialog).getByRole('spinbutton', { name: 'Season' }), { target: { value: '2' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Claim' }))

    await waitFor(() => expect(claimBodies(fetchMock)).toHaveLength(1))
    expect(claimBodies(fetchMock)[0]).toEqual({
      path: '/media/tv/Show A/S01/a-ep1.mkv', tmdbId: '1429', isTv: true, season: 2,
    })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('提交失败 → 对话框保留，展示失败结果 + 错误文案（不假装全部顺利）', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const { path } = requestInfo(input)
      const method = init?.method ?? 'GET'
      if (path === '/api/v2/triage' && method === 'GET') {
        return { ok: true, status: 200, json: async () => triageWithData() } as unknown as Response
      }
      if (path === '/api/v2/triage/claim' && method === 'POST') {
        return {
          ok: false, status: 400, json: async () => ({ ok: false, error: 'path is not currently parked' }),
        } as unknown as Response
      }
      return { ok: false, status: 404, json: async () => ({ error: 'not found' }) } as unknown as Response
    })
    vi.stubGlobal('fetch', fetchMock)
    const dialog = await openClaimDialog()

    fireEvent.change(within(dialog).getByRole('spinbutton', { name: 'TMDB ID' }), { target: { value: '77' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Claim' }))

    expect(await within(dialog).findByText(/path is not currently parked/)).toBeInTheDocument()
    expect(within(dialog).getByText('This claim failed — see the error below.')).toBeInTheDocument()
    expect(within(dialog).getByText('a-ep1.mkv')).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('认领成功 → 该组置灰 claimed · awaiting rescan、Claim 按钮消失、沉到组列表底部、actionable 计数减除', async () => {
    const fetchMock = mockFetchRouted([
      { path: '/api/v2/triage', body: triageWithData() },
      { path: '/api/v2/triage/claim', method: 'POST', body: { ok: true } },
    ])
    vi.stubGlobal('fetch', fetchMock)
    const { container } = renderPage()
    await screen.findByText('S01')

    // 认领前：箱头计数 3（S01 的 2 + Show B 的 1）。
    expect(screen.getByText('3')).toBeInTheDocument()

    const claimButtons = screen.getAllByRole('button', { name: 'Claim' })
    fireEvent.click(claimButtons[0]) // S01（最大的可认领组，2 个文件）
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByRole('spinbutton', { name: 'TMDB ID' }), { target: { value: '1429' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Claim' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    // 刷新后行还在（mock 没模拟真的退户口）——组置灰 + 角标 + 沉底 + 计数减除（诚实过渡态，
    // TriagePage.tsx claimedDirs 注释）。
    await waitFor(() => expect(screen.getByText('claimed · awaiting rescan')).toBeInTheDocument())
    expect(screen.getByText('1')).toBeInTheDocument() // 只剩 Show B 的 1 个文件仍是 actionable
    expect(screen.getAllByRole('button', { name: 'Claim' })).toHaveLength(1) // S01 的 Claim 按钮消失
    const actionable = container.querySelector('.triage-actionable-groups')
    const tails = [...actionable!.querySelectorAll('.triage-dirgroup-tail')].map((el) => el.textContent)
    expect(tails).toEqual(['Show B', 'S01']) // S01 沉到底部
    expect(container.querySelector('.triage-dirgroup-claimed')).toHaveTextContent('S01')
  })
})
