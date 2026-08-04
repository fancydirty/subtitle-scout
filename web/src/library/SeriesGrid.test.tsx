// web/src/library/SeriesGrid.test.tsx：海报墙列表页——分区渲染、筛选 chip 过滤、结果计数、
// 三态（loading 由骨架屏覆盖，不额外断言像素；error/empty 断言文案）。沿 F2 的 fetch mock 手法
// （App.test.tsx 的 mockFetchRouted），这里只有一个端点（/api/v2/library），不需要按 URL 路由。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { SeriesGrid } from './SeriesGrid.js'
import type { LibraryItemDTO } from '../api/types.js'

// CSS 断言的取值方式同 src/activity 下四个测试文件（那里有完整论证）：`?raw` 在 vitest 里恒
// 返回空串，`node:fs` 撞 tsconfig 的 types 白名单——所以走 vitest.config.ts:21 的 `define` 在
// 编译期把 styles.css 内容替换进来。
//
// 这一屏为什么读 CSS：它最阴的一处改动（焦点环 --color-accent → --color-ring，海报框底
// --color-background-surface → --color-secondary）全在 CSS 侧，jsdom 不算 computed style，
// 只看 DOM 的话改错了也是全绿；而这两处又都踩在 --color-accent 跨栈撞车上（背景一）。
declare const __STYLES_CSS__: string
const CSS = __STYLES_CSS__

/** 从 styles.css 里读某个选择器块的某条声明。先剥注释。多选择器逗号组里若同名选择器先出现，
 *  exec 命中的是源码里第一个"选择器紧跟 {"的块——本 task 用到的 .library-poster-frame /
 *  .library-poster-fallback 的**主规则**都在各自后代/悬停规则之前，所以取到的是主规则。 */
function cssDecl(selector: string, prop: string): string | null {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const block = new RegExp(`${esc}\\s*\\{([^}]*)\\}`).exec(CSS)?.[1]
  if (!block) return null
  const bare = block.replace(/\/\*[\s\S]*?\*\//g, '')
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(bare)
  return m ? m[1]!.trim() : null
}

function mockFetch(body: unknown, ok = true) {
  return vi.fn(async () => ({ ok, status: ok ? 200 : 500, json: async () => body }) as unknown as Response)
}

function item(overrides: Partial<LibraryItemDTO>): LibraryItemDTO {
  return {
    id: 'tmdb:1', kind: 'series', name: 'Series A', chineseTitle: null, year: 2021, posterPath: null,
    section: '剧集', coverage: { covered: 0, missing: 0, embedded: 0, unavailable: 0, hardsubAssumed: 0, partial: 0 }, job: null,
    ...overrides,
  }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function renderGrid() {
  return render(
    <I18nProvider>
      <SeriesGrid />
    </I18nProvider>,
  )
}

describe('SeriesGrid', () => {
  it('空库 → EmptyState（真库为空的事实，不是筛选结果）', async () => {
    vi.stubGlobal('fetch', mockFetch([]))
    renderGrid()
    expect(await screen.findByText('No library yet')).toBeInTheDocument()
  })

  it('加载失败 → 错误态 + 重试按钮', async () => {
    vi.stubGlobal('fetch', mockFetch({ error: 'boom' }, false))
    renderGrid()
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })

  it('按 section 分组渲染（剧集/电影），结果计数显示总条目数', async () => {
    const data: LibraryItemDTO[] = [
      item({ id: 's1', name: 'Series One', section: '剧集' }),
      item({ id: 'm1', kind: 'movie', name: 'Movie One', section: '电影' }),
    ]
    vi.stubGlobal('fetch', mockFetch(data))
    renderGrid()

    expect(await screen.findByText('Series One')).toBeInTheDocument()
    expect(screen.getByText('Movie One')).toBeInTheDocument()
    expect(screen.getByText('Series')).toBeInTheDocument()
    expect(screen.getByText('Movies')).toBeInTheDocument()
    expect(screen.getByText('2 titles')).toBeInTheDocument()
  })

  it('筛选 chip："有缺口" 只留 missing>0 的条目', async () => {
    const data: LibraryItemDTO[] = [
      item({ id: 's1', name: 'Gappy Series', coverage: { covered: 2, missing: 3, embedded: 0, unavailable: 0, hardsubAssumed: 0, partial: 0 } }),
      item({ id: 's2', name: 'Full Series', coverage: { covered: 12, missing: 0, embedded: 0, unavailable: 0, hardsubAssumed: 0, partial: 0 } }),
    ]
    vi.stubGlobal('fetch', mockFetch(data))
    renderGrid()

    await screen.findByText('Gappy Series')
    expect(screen.getByText('Full Series')).toBeInTheDocument()
    expect(screen.getByText('2 titles')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('radio', { name: 'Has gaps' }))

    await waitFor(() => expect(screen.getByText('1 title')).toBeInTheDocument())
    expect(screen.getByText('Gappy Series')).toBeInTheDocument()
    expect(screen.queryByText('Full Series')).not.toBeInTheDocument()
  })

  it('筛选后零结果 → 区别于空库的"这个筛选下暂时没有条目"', async () => {
    const data: LibraryItemDTO[] = [
      item({ id: 's1', name: 'Only Series', coverage: { covered: 1, missing: 1, embedded: 0, unavailable: 0, hardsubAssumed: 0, partial: 0 } }),
    ]
    vi.stubGlobal('fetch', mockFetch(data))
    renderGrid()

    await screen.findByText('Only Series')
    fireEvent.click(screen.getByRole('radio', { name: 'Fully covered' }))

    expect(await screen.findByText('Nothing matches this filter')).toBeInTheDocument()
  })

  it('系列海报卡指向 #/library/:id（series id 经 encodeURIComponent）', async () => {
    const data: LibraryItemDTO[] = [item({ id: 'tmdb:42', name: 'Linked Series' })]
    vi.stubGlobal('fetch', mockFetch(data))
    renderGrid()

    const link = await screen.findByRole('link', { name: 'Linked Series' })
    expect(link).toHaveAttribute('href', '#/library/tmdb%3A42')
  })
})

// ── CSS 侧迁移锁（Astryx token → 新栈 @theme token，Task 19）
//
// 这一屏最阴的改动全在 CSS：焦点环和海报框底都踩在 --color-accent 跨栈撞车上（新栈 #16181f 深面 /
// 旧栈 #96DA26 柠檬绿），而且旧栈那份是 @scope 到 [data-astryx-theme="scout"] 的——过渡期（Astryx
// 未卸）里任何 var(--color-accent) 都解析成绿。所以迁移目标必须是 scout 不遮蔽的 @theme token：
// 焦点环 → --color-ring，框/占位块底 → --color-secondary（不是 --color-accent！）。jsdom 不算
// computed style，这几条只能在 CSS 文本上锁。
describe('SeriesGrid：CSS 侧迁移锁', () => {
  it('焦点环走 --color-ring，不是 --color-accent（后者过渡期是绿、卸载后与框底同色 → 隐形）', () => {
    expect(CSS).toContain('outline: 2px solid var(--color-ring)')
    // 负向断言必须锚到本区段的焦点环块：styles.css 里还有 6 处其它区段的
    // `outline: 2px solid var(--color-accent)`（cmdk/侧栏/Activity 等，Tasks 20-24 的地盘，
    // 本 task 全文件只碰海报墙区段），全文 not.toContain 会误伤它们。这里取"含 outline 声明的
    // .library-poster-card:focus-visible 块"钉死——既证 ring 在场、也证 accent 已退场。
    const focusBlock = /\.library-poster-card:focus-visible\s*\{([^}]*outline[^}]*)\}/.exec(CSS)?.[1] ?? ''
    expect(focusBlock).toContain('var(--color-ring)')
    expect(focusBlock).not.toContain('var(--color-accent)')
  })

  it('海报框 / 占位块底走 --color-secondary（#16181f，scout 不遮蔽），不是 --color-accent（过渡期会刷成绿）', () => {
    expect(cssDecl('.library-poster-frame', 'background')).toBe('var(--color-secondary)')
    expect(cssDecl('.library-poster-fallback', 'background')).toBe('var(--color-secondary)')
    // 边框不迁：两栈同值 rgba(255,255,255,0.07)，留 --color-border。
    expect(cssDecl('.library-poster-frame', 'border')).toBe('1px solid var(--color-border)')
  })

  it('占位块字 → --color-weak、全覆盖绿点 → --color-fn-green、角标衬底 → --color-background', () => {
    expect(cssDecl('.library-poster-fallback', 'color')).toBe('var(--color-weak)')
    expect(cssDecl('.library-poster-dot', 'background')).toBe('var(--color-fn-green)')
    expect(CSS).toContain('color-mix(in srgb, var(--color-background) 72%, transparent)')
    // 三处圆角统一到 --radius-control（8px）。
    expect(cssDecl('.library-poster-card', 'border-radius')).toBe('var(--radius-control)')
    expect(cssDecl('.library-poster-frame', 'border-radius')).toBe('var(--radius-control)')
    expect(cssDecl('.library-poster-skel-frame', 'border-radius')).toBe('var(--radius-control)')
  })

  it('.library-grid 落地：display:grid + 那条 8 列封顶模板（几何归 CSS，见段头认领）', () => {
    expect(cssDecl('.library-grid', 'display')).toBe('grid')
    expect(CSS).toContain(
      'repeat(auto-fill, minmax(min(100%, max(150px, calc((100% - 7 * 1rem) / 8))), 1fr))',
    )
  })
})

// ── DOM 侧迁移锁（Task 19）
describe('SeriesGrid：DOM 侧迁移锁', () => {
  it('渲染后 DOM 里没有任何 astryx-* 类名（Section/Segmented/Skeleton/EmptyState 全换了新件）', async () => {
    const data: LibraryItemDTO[] = [item({ id: 's1', name: 'Series One', section: '剧集' })]
    vi.stubGlobal('fetch', mockFetch(data))
    const { container } = renderGrid()
    await screen.findByText('Series One')
    expect(container.querySelector('[class*="astryx"]')).toBeNull()
    // 分段仍是 radiogroup（既有 :63/:75/:90 靠 role=radio，这里补一条外层 role 的正向锁）。
    expect(screen.getByRole('radiogroup')).toBeInTheDocument()
    // 加载态的海报墙也走 .library-grid 类（不是 Astryx Grid 的行内模板）——骨架那条只锁了 loading 分支。
    expect(container.querySelectorAll('.library-grid').length).toBeGreaterThanOrEqual(1)
  })

  it('海报标题不被截断成单行——hasTruncateTooltip 丢掉、没翻译成 truncate/title（背景四的漂移陷阱）', async () => {
    const data: LibraryItemDTO[] = [item({ id: 's1', name: 'A Very Long Series Title That Would Wrap' })]
    vi.stubGlobal('fetch', mockFetch(data))
    renderGrid()
    const titleEl = await screen.findByText('A Very Long Series Title That Would Wrap')
    // block（display:block）保留，但**不能**有 truncate（那会 overflow:hidden + nowrap + 省略号）。
    expect(titleEl.className.split(/\s+/)).toContain('block')
    expect(titleEl.className).not.toMatch(/\btruncate\b/)
    expect(titleEl).not.toHaveAttribute('title')
  })

  it('骨架屏走 .library-grid + .library-poster-skel-frame（网格类落地、不是 Astryx Grid 的行内模板）', () => {
    // loading 且无 data：mockFetch 永不 resolve 才能停在 loading——这里用一个挂起的 fetch。
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})))
    const { container } = renderGrid()
    expect(container.querySelector('.library-grid')).toBeInTheDocument()
    expect(container.querySelectorAll('.library-poster-skel-frame').length).toBe(12)
  })
})
