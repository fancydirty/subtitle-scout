// web/src/shell/AppShell.nav.test.tsx：**AppShell 的 route.tab 分支**守卫。
//
// 这是任务书标注的头号静默失效点：漏一条分支不报错、不白屏、不抛异常——只是那个 tab
// 的主区一片空白，而侧栏还好端端地高亮着它。人工点一遍才发现。
//
// 守法：**遍历 TABS**，逐个把 hash 切过去，断言主区渲染出了那一页的可识别内容。
// 加第五个 tab 忘了加分支 → 这里自动多一条用例并且红。
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor, within } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { Shell } from './AppShell.js'
import { TABS } from './tabs.js'
import { en } from '../i18n/en.js'

// Shell 挂载即打若干端点（workflow/pending、library、settings 三件套…）。这里只关心
// "分支有没有渲染出东西"，所以给一份最小但**形状正确**的 mock。
// ⚠️ 形状必须对：SettingsTabsPage 会读 setupStatus.data.providers.subhd.enabled，
// 给它一个 `{}` 会在渲染中抛 TypeError（实测踩到）——那不是"页面降级"，是页面炸了，
// 会把本文件真正要测的东西淹在 unhandled error 里。
function mockFetch() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    const body: unknown =
      url.includes('/api/v2/setup/status')
        ? {
            initialized: true,
            engineEnabled: true,
            providers: {
              subhd: { enabled: false }, zimuku: { enabled: false },
              opensubtitles: { enabled: false }, jimaku: { enabled: false },
            },
            secrets: {},
          }
      : url.includes('/api/v2/settings/deploy') ? { secrets: {}, nonSecrets: {} }
      : url.includes('/api/v2/settings/roots') ? []
      : url.includes('/api/v2/settings')
        ? { target_languages: null, hardsub_mode: null, exclude_extras: null,
            trace_retention_days: null, scan_interval_ms: null }
      : url.includes('/api/v2/library') && !url.includes('series') ? []
      // Task ⑧：媒体库两个端点。**必须给数组**——`{}` 会让 MediaLibraryPage 的 items.map
      // 抛 TypeError（实测踩到），主区被炸空，本文件真正要测的"分支在不在"就被淹没了。
      // 空数组 = 空库态，正是这里要的"渲染出了页面本体"的最小形状。
      // ⚠️ 精确路径判在带 id 的之前——`/api/v2/mediaLibrary/tmdb:1` 也含 'mediaLibrary'。
      : /\/api\/v2\/mediaLibrary$/.test(url.split('?')[0] ?? '') ? []
      : url.includes('/api/v2/mediaLibrary/')
        ? { work: { workId: 'tmdb:1', title: 'W', chineseTitle: null, year: null,
                    posterPath: null, mediaType: 'tv' },
            seasons: [], movie: null, unplacedFileCount: 0 }
      : url.includes('/workflow/pending')
        ? { meta: { roots: [], lastScanAt: null, files: 0, lastVerifySweepAt: null,
                    verifiedItems: 0, verifiableItems: 0 }, parked: 0 }
      : url.includes('/workflow/workers') ? { running: [], recent: [] }
      : url.includes('/workflow/passes') ? []
      : {}
    return { ok: true, status: 200, json: async () => body } as unknown as Response
  })
}

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch())
  location.hash = ''
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); location.hash = '' })

const renderShell = () => render(<I18nProvider initialLang="en"><Shell /></I18nProvider>)

describe('AppShell：每个导航 tab 都真的渲染出内容（漏分支 = 静默空白）', () => {
  // ⚠️ 判据不是"主区出现了 tab 名"——Settings 是个真页面，它的内容是 General/Providers/…
  // 五个子 tab，标题里根本没有 "Settings" 这个词（实测踩到）。硬套那条会逼我去给
  // SettingsTabsPage 加一个它不需要的标题，**为了让测试变绿去改生产代码**，本末倒置。
  //
  // 真正的判据是漏分支时会发生什么：主区只剩 EngineBanner（恒在顶部的那条），
  // 别的什么都没有。所以断言 **主区去掉 banner 之后仍有实质内容**。
  // 这条对五个 tab 一视同仁，且加新 tab 忘了写分支时必红。
  it.each(TABS.map((m) => m.id))('tab %s 的主区渲染出 EngineBanner 之外的实质内容', async (id) => {
    location.hash = `#/${id}`
    renderShell()
    const main = await screen.findByRole('main')
    await waitFor(() => {
      // 主区的直接子节点：EngineBanner 是其中之一，页面本体是另一个。
      // 漏分支时这里只有 banner（或 banner 渲染成 null 时干脆是 0 个）。
      const substantive = [...main.children].filter(
        (el) => !el.className.includes('engine-banner') && (el.textContent ?? '').trim() !== '',
      )
      expect(substantive.length, `tab ${id} 主区没有页面本体——AppShell 分支漏了？`).toBeGreaterThan(0)
    })
  })

  // 四个导航 tab 的主区内容**互不相同**——全部漏分支时上一条会红，但如果有人
  // 把三个占位页写成同一个组件，上一条照样绿。这条堵那个洞。
  it('四个导航 tab 的主区内容互不相同（不是同一个组件渲染四遍）', async () => {
    const texts: string[] = []
    for (const meta of TABS) {
      location.hash = `#/${meta.id}`
      renderShell()
      const main = await screen.findByRole('main')
      await waitFor(() => expect((main.textContent ?? '').trim().length).toBeGreaterThan(0))
      texts.push((main.textContent ?? '').trim())
      cleanup()
    }
    expect(new Set(texts).size).toBe(TABS.length)
  })

  // ── Task ⑧：媒体库页已填肉，占位页只剩两个 ────────────────────────────────
  // 下面三条从"三个占位页"改成"两个"，并**补一条媒体库页的反向断言**（它绝不许再显示
  // 施工中标记）。只把 'media' 从列表里删掉是不够的：那样一来，有人把 MediaLibraryPage
  // 换回占位壳时全绿——正是 Task ⓪「删光生产写入点测试无一变红」的同型。
  it('两个占位页各自渲染出自己的页面名（导航标签的同一份文案）', async () => {
    for (const [tab, label] of [
      ['activity', en.nav_activity],
      ['notifications', en.nav_notifications],
    ] as const) {
      location.hash = `#/${tab}`
      renderShell()
      const main = await screen.findByRole('main')
      await waitFor(() => {
        expect(within(main).getByRole('heading', { name: label })).toBeInTheDocument()
      })
      cleanup()
    }
  })

  it('两个占位页各自渲染出"施工中"标记与自己的数据源说明（不是同一个壳复制三遍）', async () => {
    const seen: string[] = []
    for (const [tab, source] of [
      ['activity', 'Task ⑨'],
      ['notifications', 'Task ⑩'],
    ] as const) {
      location.hash = `#/${tab}`
      renderShell()
      const main = await screen.findByRole('main')
      await waitFor(() => {
        expect(within(main).getByText(en.placeholder_under_construction)).toBeInTheDocument()
      })
      // 每页的施工说明必须提到**自己那个** task 与数据源——两页共用一句就是假占位。
      const note = within(main).getByText(new RegExp(source))
      expect(note).toBeInTheDocument()
      seen.push(note.textContent ?? '')
      cleanup()
    }
    expect(new Set(seen).size).toBe(2)
  })

  it('占位页**不渲染任何假数据**——没有列表项、没有骨架屏、没有数字读数', async () => {
    for (const tab of ['activity', 'notifications'] as const) {
      location.hash = `#/${tab}`
      renderShell()
      const main = await screen.findByRole('main')
      // 假 UI 的三个典型形态：列表项 / 表格 / 骨架块
      expect(within(main).queryAllByRole('listitem')).toHaveLength(0)
      expect(within(main).queryAllByRole('table')).toHaveLength(0)
      expect(main.querySelectorAll('[class*="skeleton"], [class*="Skeleton"]')).toHaveLength(0)
      cleanup()
    }
  })

  it('#/media 渲染真页面（Task ⑧ 已填肉）——绝不再是占位壳', async () => {
    location.hash = '#/media'
    renderShell()
    const main = await screen.findByRole('main')
    // 空库态（mock 给的是 []）的真文案在场 = 真页面渲染了。
    await waitFor(() => {
      expect(within(main).getByText(en.media_empty_title)).toBeInTheDocument()
    })
    // 施工中标记绝不许出现——有人把它换回占位壳时这条红。
    expect(within(main).queryByText(en.placeholder_under_construction)).toBeNull()
  })
})

describe('AppShell：旧路由仍然渲染真页面（Task ⑪ 才下架）', () => {
  it('#/workflow 仍渲染活动页（ActivityPage），不是占位壳', async () => {
    location.hash = '#/workflow'
    renderShell()
    const main = await screen.findByRole('main')
    // 占位壳的标记绝不该出现在这里——出现了就说明有人把 workflow 也改成占位页，
    // 那会让今天唯一能用的活动视图消失。
    await waitFor(() => {
      expect(within(main).queryByText(en.placeholder_under_construction)).toBeNull()
    })
  })

  it('#/library 仍渲染海报墙（SeriesGrid 的空库文案），不是占位壳', async () => {
    location.hash = '#/library'
    renderShell()
    const main = await screen.findByRole('main')
    await waitFor(() => {
      expect(within(main).getByText(en.library_empty_title)).toBeInTheDocument()
    })
    expect(within(main).queryByText(en.placeholder_under_construction)).toBeNull()
  })
})
