// web/src/shell/rootHealthWiring.test.tsx —— 🔴-1 的**判据文件**。
//
// ══════════════════════════════════════════════════════════════════════════════
// 这个文件存在的唯一理由：让「后端 roots[] 变空」这件事在前端变红
// ══════════════════════════════════════════════════════════════════════════════
// 终局审计的变异实测：把 `server.ts` 的 `roots: buildRootHealth(rootRows, Date.now())`
// 改成 `roots: []`，**前端 1261 条用例 0 红**——Task ③ 的两列 + Task ⑤ 的三态折叠
// 整条链在 API 边界断掉，用户那边"守备目录挂载掉了"界面上一处都不显示。
//
// 组件级测试（RootHealthNote.test.tsx）救不了这个：给组件一个 roots 数组它就渲染，
// 而**没有任何人钉着"页面真的把 /health 的 roots 喂给了它"**。这正是本仓病 A 的
// 交接处形态，也是 media/shellWiring.test.tsx 头注释里那类"中间那条接线没人守"。
//
// 故判据必须是**端到端运行时**的：渲染真的 Shell、走真的 hash 路由、由**HTTP 桩**
// 提供 /api/v2/health 的 roots，然后断言那几个路径出现在主区 DOM 里。
// 桩在 fetch 层（不是 mock hook、更不是 mock 组件）——mock 掉中间任何一层，
// 被变异掉的恰恰就是那一层。
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor, within } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { Shell } from './AppShell.js'
import { en } from '../i18n/en.js'
import type { HealthDTO, HealthRootDTO, UnidentifiedHealthDTO } from '../api/types.js'

/** 后端这一轮给的 roots——每条用例自己改它，模拟 /health 的真实响应。 */
let roots: HealthRootDTO[] = []
/** 同上，`unidentified` 段（病 A 第 7 例的那条链）。缺省 = 全部认得出来。 */
let unidentified: UnidentifiedHealthDTO = { dirCount: 0, dirs: [] }

function healthBody(): HealthDTO {
  return {
    lastInspectAt: Date.now() - 60_000,
    // 三个布尔取"一切许可"：本文件测的是 roots 那条链，不该被 banner 的文案干扰。
    workPermitted: true, engineEnabled: true, setupSatisfied: true,
    roots,
    unidentified,
    current: null,
  }
}

function mockFetch() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    const path = url.split('?')[0] ?? ''
    const body: unknown =
      url.includes('/api/v2/health') ? healthBody()
      : url.includes('/api/v2/activity') ? { subtitleQueue: [], translateQueue: [] }
      : /\/api\/v2\/mediaLibrary$/.test(path) ? [
          { workId: 'tmdb:1396', title: 'Breaking Bad', chineseTitle: null, year: 2008,
            posterPath: null, mediaType: 'tv', expectedEpisodeCount: 62,
            onDiskEpisodeCount: 30, missingEpisodeCount: 32, subtitledEpisodeCount: 12 },
        ]
      : url.includes('/api/v2/notifications') ? []
      // 设置页那条用例会渲染 SettingsTabsPage，它无条件解引用
      // `setupStatus.data.providers.subhd`——桩必须给完整形状（给 {} 会抛，
      // 而那是一个与本文件主题无关的噪音错误）。⚠️ 如实记录：这是 SettingsTabsPage
      // 的一个真实脆弱点（DTO 部分缺失时崩页而不是降级），本 task 不改它，
      // 已列入报告的"发现但没修"。
      : url.includes('/api/v2/setup/status') ? {
          bootstrapComplete: true,
          tmdb: { satisfied: true, source: 'env', masked: null },
          llm: { satisfied: true, source: 'env', model: null },
          providers: {
            assrt: { satisfied: false, source: 'none', masked: null },
            opensubtitles: { satisfied: false, source: 'none', hasUsername: false, masked: null },
            jimaku: { satisfied: false, source: 'none', masked: null },
            subhd: { enabled: false, source: 'none' },
            zimuku: { enabled: false, source: 'none', captchaReady: false },
          },
          roots: { count: 1 },
          engineEnabled: true,
        }
      : url.includes('/api/v2/settings/roots') ? []
      : url.includes('/api/v2/setup/providers') ? { providers: [] }
      : url.includes('/api/v2/settings/deploy') ? { secrets: {}, nonSecrets: {} }
      : url.includes('/workflow/pending')
        ? { meta: { roots: [], lastScanAt: null, files: 0, lastVerifySweepAt: null,
                    verifiedItems: 0, verifiableItems: 0 }, parked: 0 }
      : {}
    return { ok: true, status: 200, json: async () => body } as unknown as Response
  })
}

beforeEach(() => {
  roots = []
  unidentified = { dirCount: 0, dirs: [] }
  vi.stubGlobal('fetch', mockFetch())
  // EventSource：jsdom 没有它，Shell 的 EventsProvider 会去 new 一个。
  // 给个惰性壳（永不连上）——本文件不测 SSE。
  vi.stubGlobal('EventSource', class {
    onmessage: unknown = null
    onerror: unknown = null
    readyState = 0
    addEventListener() {}
    removeEventListener() {}
    close() {}
  })
  location.hash = ''
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); location.hash = '' })

const renderShell = () => render(<I18nProvider initialLang="en"><Shell /></I18nProvider>)

// ══════════════════════════════════════════════════════════════════════════════
// 🔴 变异闸：`roots: []` 必须让下面这些红
// ══════════════════════════════════════════════════════════════════════════════
describe('🔴 /health 的 roots[] 真的被读了（变异 `roots: []` → 本组必红）', () => {
  it('活动页：一个根 ok=false → 页面上出现那个路径与"读不到"那句', async () => {
    roots = [{ path: '/mnt/media', ok: false, lastError: 'boom', lastCheckedAt: Date.now() }]
    location.hash = '#/activity'
    renderShell()
    const main = await screen.findByRole('main')
    await waitFor(() => {
      expect(within(main).getByTestId('root-health-failed').textContent).toContain('/mnt/media')
    })
    expect(within(main).getByTestId('root-health-failed').textContent).toContain(en.root_health_failed)
  })

  it('媒体库页：同一个事实在这一页也说得出来（海报墙照常在场，而磁盘已经不在了）', async () => {
    roots = [{ path: '/mnt/media', ok: false, lastError: 'boom', lastCheckedAt: Date.now() }]
    location.hash = '#/media'
    renderShell()
    const main = await screen.findByRole('main')
    await waitFor(() => {
      expect(within(main).getByTestId('root-health-failed').textContent).toContain('/mnt/media')
    })
    // 卡片照常在场——这正是这条提示存在的理由：页面看上去完全正常。
    expect(within(main).getByRole('link', { name: 'Breaking Bad' })).toBeInTheDocument()
  })

  it('🔴 ok=null（从没扫过 / 判决陈旧）在两页也都说得出来，且**不是**failed 那句', async () => {
    roots = [{ path: '/mnt/new', ok: null, lastError: null, lastCheckedAt: null }]
    for (const hash of ['#/activity', '#/media']) {
      location.hash = hash
      renderShell()
      const main = await screen.findByRole('main')
      await waitFor(() => {
        expect(within(main).getByTestId('root-health-unknown').textContent).toContain('/mnt/new')
      })
      expect(within(main).queryByTestId('root-health-failed')).toBeNull()
      cleanup()
    }
  })

  it('🔴 后端 roots 为空 → 页面上一条提示都没有（这就是被变异掉之后的样子）', async () => {
    // 本条与上面三条是**同一个变异的两面**：roots:[] 时它绿、上面三条红。
    // 它在这里是为了让那个变异的效果被记录成"整段消失"，而不是"某条断言恰好还成立"。
    roots = []
    location.hash = '#/activity'
    renderShell()
    const main = await screen.findByRole('main')
    await waitFor(() => expect(within(main).getByTestId('wb-inspect-line')).toBeInTheDocument())
    expect(within(main).queryByTestId('root-health-failed')).toBeNull()
    expect(within(main).queryByTestId('root-health-unknown')).toBeNull()
  })

  it('全部健康 → 一条提示都没有（沉默即好消息，不是"链条断了"）', async () => {
    roots = [{ path: '/mnt/media', ok: true, lastError: null, lastCheckedAt: Date.now() }]
    location.hash = '#/activity'
    renderShell()
    const main = await screen.findByRole('main')
    await waitFor(() => expect(within(main).getByTestId('wb-inspect-line')).toBeInTheDocument())
    expect(within(main).queryByTestId('root-health-failed')).toBeNull()
    expect(within(main).queryByTestId('root-health-unknown')).toBeNull()
    // 路径本身也不该出现在页面上（健康的根不占屏）。
    expect(main.textContent).not.toContain('/mnt/media')
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// 🔴 `?? true` 兜底的端到端闸
// ══════════════════════════════════════════════════════════════════════════════
describe('🔴 `ok:null` 画成绿（`?? true`）→ 本组必红', () => {
  it('null 的根**必须在屏幕上留下痕迹**，不许被当成健康静默吞掉', async () => {
    roots = [
      { path: '/mnt/ok', ok: true, lastError: null, lastCheckedAt: Date.now() },
      { path: '/mnt/unknown', ok: null, lastError: null, lastCheckedAt: null },
    ]
    location.hash = '#/media'
    renderShell()
    const main = await screen.findByRole('main')
    await waitFor(() => {
      expect(main.textContent, 'ok:null 被 `?? true` 折成了健康').toContain('/mnt/unknown')
    })
    // 健康的那个仍然不占屏——两条纪律同时成立才算对。
    expect(main.textContent).not.toContain('/mnt/ok')
  })

  it('null 与 false 在 DOM 上是**两个不同的槽**（合流成一句 → 本条红）', async () => {
    roots = [
      { path: '/mnt/bad', ok: false, lastError: 'boom', lastCheckedAt: Date.now() },
      { path: '/mnt/unknown', ok: null, lastError: null, lastCheckedAt: null },
    ]
    location.hash = '#/activity'
    renderShell()
    const main = await screen.findByRole('main')
    await waitFor(() => expect(within(main).getByTestId('root-health-failed')).toBeInTheDocument())
    expect(within(main).getByTestId('root-health-failed').textContent).toContain('/mnt/bad')
    expect(within(main).getByTestId('root-health-failed').textContent).not.toContain('/mnt/unknown')
    expect(within(main).getByTestId('root-health-unknown').textContent).toContain('/mnt/unknown')
    expect(within(main).getByTestId('root-health-unknown').textContent).not.toContain('/mnt/bad')
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// 落点裁决：哪两页有、哪两页没有
// ══════════════════════════════════════════════════════════════════════════════
describe('落点：活动页与媒体库页有；通知页与设置页没有（论证见报告 🔴-1）', () => {
  it('通知页**不显示**守备目录状态（它是成果流水，不描述磁盘现状）', async () => {
    roots = [{ path: '/mnt/media', ok: false, lastError: 'boom', lastCheckedAt: Date.now() }]
    location.hash = '#/notifications'
    renderShell()
    const main = await screen.findByRole('main')
    await waitFor(() => expect(main.textContent?.length ?? 0).toBeGreaterThan(0))
    expect(within(main).queryByTestId('root-health-failed')).toBeNull()
  })

  it('设置页**不显示**（那一页有 RootsManager，守备目录本来就是它的主题）', async () => {
    roots = [{ path: '/mnt/media', ok: false, lastError: 'boom', lastCheckedAt: Date.now() }]
    location.hash = '#/settings'
    renderShell()
    const main = await screen.findByRole('main')
    await waitFor(() => expect(main.textContent?.length ?? 0).toBeGreaterThan(0))
    expect(within(main).queryByTestId('root-health-failed')).toBeNull()
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// 🔴 病 A 第 7 例：`/health` 的 `unidentified` 真的被读了
// ══════════════════════════════════════════════════════════════════════════════
// 与上面 roots 那组同一手法、同一理由：组件级测试（UnidentifiedNote.test.tsx）给组件
// 一个 DTO 它就渲染，但**没有任何人钉着"活动页真的把 /health 的 unidentified 喂给了它"**。
// 变异闸：把 server.ts 的 `unidentified: buildUnidentifiedHealth(db)` 改成
// `unidentified: { dirCount: 0, dirs: [] }`（或把 ActivityPage 里那行 <UnidentifiedNote/>
// 删掉），本组必红。
describe('🔴 /health 的 unidentified 真的被读了（变异恒空 → 本组必红）', () => {
  it('活动页：认不出来的目录名与那句"改成 片名 (年份)"都出现在页面上', async () => {
    unidentified = { dirCount: 2, dirs: [
      { dirName: 'Unknown Show', fileCount: 24 },
      { dirName: 'some.random.rip', fileCount: 1 },
    ] }
    location.hash = '#/activity'
    renderShell()
    const main = await screen.findByRole('main')
    await waitFor(() => {
      expect(within(main).getByTestId('wb-unidentified-line')).toBeInTheDocument()
    })
    const line = within(main).getByTestId('wb-unidentified-line')
    expect(line.textContent).toContain(en.unidentified_note)
    expect(line.textContent).toContain('Unknown Show')
    expect(line.textContent).toContain('some.random.rip')
  })

  it('🔴 dirCount 为 0 → 一个字都不占屏（这就是被变异掉之后的样子）', async () => {
    unidentified = { dirCount: 0, dirs: [] }
    location.hash = '#/activity'
    renderShell()
    const main = await screen.findByRole('main')
    await waitFor(() => expect(within(main).getByTestId('wb-inspect-line')).toBeInTheDocument())
    expect(within(main).queryByTestId('wb-unidentified-line')).toBeNull()
  })

  it('🔴 截断时说"另外还有 N 个"——N 由 dirCount 算，不是 dirs.length', async () => {
    // 后端上限 8：dirCount=30 而 dirs 只给 8 个。拿 dirs.length 当总数会对用户**少报**。
    unidentified = {
      dirCount: 30,
      dirs: Array.from({ length: 8 }, (_, i) => ({ dirName: `D${i}`, fileCount: 1 })),
    }
    location.hash = '#/activity'
    renderShell()
    const main = await screen.findByRole('main')
    await waitFor(() => expect(within(main).getByTestId('wb-unidentified-more')).toBeInTheDocument())
    expect(within(main).getByTestId('wb-unidentified-more').textContent).toContain('22')
  })

  // 🔴 R-F1「未识别资源不给用户改」的端到端闸：这条提示**不许长出任何可点的东西**。
  it('🔴 这条提示上没有任何按钮 / 链接（R-F1：不给用户改）', async () => {
    unidentified = { dirCount: 1, dirs: [{ dirName: 'Unknown Show', fileCount: 3 }] }
    location.hash = '#/activity'
    renderShell()
    const main = await screen.findByRole('main')
    await waitFor(() => expect(within(main).getByTestId('wb-unidentified-line')).toBeInTheDocument())
    const line = within(main).getByTestId('wb-unidentified-line')
    expect(within(line).queryByRole('button')).toBeNull()
    expect(within(line).queryByRole('link')).toBeNull()
  })

  // 🔴 R-F2 的作用域：孤儿**不进媒体库海报墙**。这条与上面第一条是同一份数据的两面。
  it('🔴 媒体库页上一个字都没有（R-F2「识别失败的孤儿不露出」的作用域在那一页）', async () => {
    unidentified = { dirCount: 1, dirs: [{ dirName: 'Unknown Show', fileCount: 3 }] }
    location.hash = '#/media'
    renderShell()
    const main = await screen.findByRole('main')
    await waitFor(() => expect(within(main).getByRole('link', { name: 'Breaking Bad' })).toBeInTheDocument())
    expect(within(main).queryByTestId('wb-unidentified-line')).toBeNull()
    expect(main.textContent).not.toContain('Unknown Show')
  })
})
