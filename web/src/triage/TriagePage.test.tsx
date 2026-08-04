// web/src/triage/TriagePage.test.tsx：甄别 tab 集成测试——目录分组渲染（组头=目录尾段
// mono+计数、组间按文件数降序、无逐行 checkbox）与空态。TriagePage 自己发请求（同 Lanes 的
// 自洽口径），所以 mock 全局 fetch 按 URL 路由（同 Lanes.test.tsx 的既有手法）。
//
// 认领流测试（对话框/搜索/提交/置灰沉底）已随认领退役整体删除（2026-07-28 两证据红线裁决，
// 见 src/v2/triageOps.ts 头注释）——甄别页现在是只读事实呈现 + ExcludedBox 翻案（后者的
// 行为测试在 ExcludedBox.test.tsx）。
//
// duplicates 折叠箱更早退役（P2 起 ingest 不再产 duplicate-content 停车行，PendingBox.tsx
// 文件头注释）——历史遗留的 duplicate-content 行不再单独分桶，随其余行进 actionable 分组区。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { TriagePage } from './TriagePage.js'
import type { TriageDTO } from '../api/types.js'

// CSS 断言走 vitest.config.ts:21 的 define 编译期替换（同 Task 19-21 各测试文件的既有底座）。
// 本屏读 CSS 是因为 .triage-box/.triage-dirgroup 底色与 "+N more" 焦点环踩在跨栈撞车上
// （--color-accent 被 scout 遮蔽成柠檬绿），只看 DOM 改错了也全绿。
declare const __STYLES_CSS__: string
const CSS = __STYLES_CSS__

function cssDecl(selector: string, prop: string): string | null {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const block = new RegExp(`${esc}\\s*\\{([^}]*)\\}`).exec(CSS)?.[1]
  if (!block) return null
  const bare = block.replace(/\/\*[\s\S]*?\*\//g, '')
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(bare)
  return m ? m[1]!.trim() : null
}

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

const EMPTY_TRIAGE: TriageDTO = { pending: [] }

// 目录分组样本：Show A/S01 两集（组内文件最多，按文件数降序排最前）、Show B 一集
// （actionable 合计 3 文件）——两个计数（3 顶部/2 每组/1 每组）互不相同，dirTail
// （S01/Show B）也互不相同，测试断言不需要额外 DOM 作用域即可消歧。
function triageWithData(): TriageDTO {
  return {
    pending: [
      { path: '/media/tv/Show A/S01/a-ep1.mkv', parkReason: 'ambiguous match', firstSeen: NOW - 60_000, lastAttempt: NOW },
      { path: '/media/tv/Show A/S01/a-ep2.mkv', parkReason: 'ambiguous match', firstSeen: NOW - 60_000, lastAttempt: NOW },
      { path: '/media/tv/Show B/b-ep1.mkv', parkReason: 'no tmdb hit', firstSeen: NOW - 120_000, lastAttempt: NOW },
    ],
  }
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

describe('TriagePage：目录分组渲染', () => {
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

    // 改名指引恒定渲染（原有断言延续）——认领退役后它就是这一页的核心修复指引。
    expect(screen.getByText('Title (Year)/Season NN/Title SNNENN.mkv')).toBeInTheDocument()
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
  // 正常参与排序、正常计入箱头计数。
  it('历史遗留 duplicate-content 行 → 不再单独分桶折叠，就是普通 actionable 组（计入箱头计数）', async () => {
    const data: TriageDTO = {
      pending: [
        { path: '/media/tv/Show C/c-ep1.mkv', parkReason: 'duplicate-content', firstSeen: NOW - 30_000, lastAttempt: NOW },
      ],
    }
    vi.stubGlobal('fetch', mockFetchRouted([{ path: '/api/v2/triage', body: data }]))
    renderPage()

    expect(await screen.findByText('Show C')).toBeInTheDocument()
    expect(screen.getByTitle('/media/tv/Show C/c-ep1.mkv')).toHaveTextContent('c-ep1.mkv')
    // 计入箱头计数（1）——这里就是普通 actionable 桶的行为。
    expect(screen.getByText('1')).toBeInTheDocument()
    // 没有 Duplicates 折叠区这种东西了。
    expect(screen.queryByText(/Duplicates —/)).not.toBeInTheDocument()
  })

  it('页面无逐行 checkbox（多选早已撤）、无 Claim 按钮（认领已退役）', async () => {
    vi.stubGlobal('fetch', mockFetchRouted([{ path: '/api/v2/triage', body: triageWithData() }]))
    renderPage()
    await screen.findByText('S01')
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0)
    expect(screen.queryByRole('button', { name: 'Claim' })).not.toBeInTheDocument()
  })

  it('空态：待甄别空=好事（identifier 全部归位方向）', async () => {
    vi.stubGlobal('fetch', mockFetchRouted([{ path: '/api/v2/triage', body: EMPTY_TRIAGE }]))
    renderPage()
    expect(await screen.findByText('Every file found its identifier')).toBeInTheDocument()
  })
})

// ── CSS 侧迁移锁（Task 22）
describe('TriagePage / Pending 区：CSS 侧迁移锁', () => {
  it('箱底/组底走新栈 token（card/secondary），不是被 scout 遮蔽的 --color-accent', () => {
    expect(cssDecl('.triage-box', 'background')).toBe('var(--color-card)')
    expect(cssDecl('.triage-dirgroup', 'background')).toBe('var(--color-secondary)')
    expect(cssDecl('.triage-box', 'border-radius')).toBe('var(--radius-control)')
  })
  it('"+N more" 折叠钮焦点环走 --color-ring（不是过渡期变绿的 --color-accent）', () => {
    expect(cssDecl('.triage-dialog-more:focus-visible', 'outline')).toBe('2px solid var(--color-ring)')
    expect(cssDecl('.triage-dirgroup-tail', 'color')).toBe('var(--color-foreground)')
  })
})
