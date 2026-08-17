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
              subhd: { enabled: false }, zimuku: { enabled: false, captchaReady: false },
              opensubtitles: { enabled: false }, jimaku: { enabled: false },
            },
            secrets: {},
          }
      : url.includes('/api/v2/settings/deploy') ? { secrets: {}, nonSecrets: {} }
      : url.includes('/api/v2/settings/roots') ? []
      : url.includes('/api/v2/settings')
        ? { target_languages: null, hardsub_mode: null,
            trace_retention_days: null, scan_interval_ms: null }
      // Task ⑧：媒体库两个端点。**必须给数组**——`{}` 会让 MediaLibraryPage 的 items.map
      // 抛 TypeError（实测踩到），主区被炸空，本文件真正要测的"分支在不在"就被淹没了。
      // 空数组 = 空库态，正是这里要的"渲染出了页面本体"的最小形状。
      // ⚠️ 精确路径判在带 id 的之前——`/api/v2/mediaLibrary/tmdb:1` 也含 'mediaLibrary'。
      : /\/api\/v2\/mediaLibrary$/.test(url.split('?')[0] ?? '') ? []
      : url.includes('/api/v2/mediaLibrary/')
        ? { work: { workId: 'tmdb:1', title: 'W', chineseTitle: null, year: null,
                    posterPath: null, mediaType: 'tv' },
            seasons: [], movie: null, unplacedFileCount: 0 }
      // Task ⑩：通知端点。同上，**必须给数组**——落到下面的 `{}` 兜底会让
      // NotificationsPage 拿 `{}` 当 FoundGroup[] 用，主区被炸空，本文件真正要测的
      // "分支在不在"就被淹没了。空数组 = 空流水态，正是这里要的最小形状。
      : /\/api\/v2\/notifications$/.test(url.split('?')[0] ?? '') ? []
      : url.includes('/workflow/pending')
        ? { meta: { roots: [], lastScanAt: null, files: 0, lastVerifySweepAt: null,
                    verifiedItems: 0, verifiableItems: 0 }, parked: 0 }
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

  // ── Task ⑧⑨⑩：三个页面**全部填肉，占位页一个不剩** ────────────────────────
  // 原先这里有三条"占位页应该长什么样"的用例（页面名 / 施工中标记 / 不许有假数据），
  // 随最后一个占位页（活动）被真页面取代而删除——留着就是断言一个已经不存在的形态。
  //
  // 🔴 但**不能只删**：只删的话，有人把真页面换回占位壳时全套件依然全绿
  // （正是 Task ⓪「删光 7 个生产写入点、4 条测试无一变红」的同型）。
  // 故三条删除的同时，下面三条"真页面 + 反向断言"必须齐备——每页一条，各自
  // ① 断言该页真身的标志物在场 ② 断言施工中标记**绝不**在场。

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

  // 🔴 Task ⑨ 的同型反向断言。变异实测（把分支退回 ActivityPlaceholder）→ 本条红。
  it('#/activity 渲染真页面（Task ⑨ 已填肉）——绝不再是占位壳', async () => {
    location.hash = '#/activity'
    renderShell()
    const main = await screen.findByRole('main')
    // 真页面的两个标志物：两个 tab 的 tablist（R-F1：**只有两个**）+ 顶部状态条。
    await waitFor(() => {
      expect(within(main).getByRole('tablist', { name: en.wb_tablist_label })).toBeInTheDocument()
    })
    expect(within(main).getAllByRole('tab')).toHaveLength(2)
    expect(within(main).queryByText(en.placeholder_under_construction)).toBeNull()
  })

  // 🔴 Task ⑩ 的同型反向断言。变异实测（把分支退回占位组件）→ 本条红。
  it('#/notifications 渲染真页面（Task ⑩ 已填肉）——绝不再是占位壳', async () => {
    location.hash = '#/notifications'
    renderShell()
    const main = await screen.findByRole('main')
    // 空流水态（mock 给的是 []）的真文案在场 = 真页面渲染了。
    await waitFor(() => {
      expect(within(main).getByText(en.notif_empty_title)).toBeInTheDocument()
    })
    expect(within(main).queryByText(en.placeholder_under_construction)).toBeNull()
  })
})

describe('AppShell：旧 hash 改写到新页面（Task ⑪ 下架）', () => {
  // ⚠️ 这个 describe 换了语义，不是删了重写。Task ⑦⑧⑨ 期间它断言的是「#/workflow 与
  // #/library 仍渲染旧真页面」——那时旧活动页是仓里唯一能用的活动视图。旧页面已移入
  // `web/src/_legacy/`，现在的裁决是改写到功能等价的新页面：
  //   #/workflow → 活动页 ; #/library* → 媒体库**列表**（丢弃 id 段）
  //
  // 🔴 为什么不是"重定向到 `_legacy` 页面"：设计文档教训十已裁决不许——旧 library 页读
  // `series` 表（生产 **0 行**），把老书签送过去 = 稳定地什么都没有，比 404 更难排查。

  it('#/workflow 渲染**新**活动页（workbench），不是旧活动页也不是空白', async () => {
    location.hash = '#/workflow'
    renderShell()
    const main = await screen.findByRole('main')
    // 新活动页的标志物：两个 tab 的 tablist（R-F1，与 #/activity 那条同一判据）。
    // 旧活动页没有 tablist，所以这条也把"改写没生效、还在渲染旧页面"一并挡住。
    await waitFor(() => {
      expect(within(main).getByRole('tablist', { name: en.wb_tablist_label })).toBeInTheDocument()
    })
    expect(within(main).queryByText(en.placeholder_under_construction)).toBeNull()
  })

  it('#/library 渲染**新**媒体库列表，且旧海报墙文案绝不在场', async () => {
    location.hash = '#/library'
    renderShell()
    const main = await screen.findByRole('main')
    await waitFor(() => {
      expect(within(main).getByText(en.media_empty_title)).toBeInTheDocument()
    })
    // 🔴 反向断言：旧海报墙的空库文案（library_empty_title）在场 = 改写没生效、
    // 或者有人把 `_legacy` 页面又接回了外壳。这条是本 task 的下架回归锁。
    expect(within(main).queryByText(en.library_empty_title)).toBeNull()
    expect(within(main).queryByText(en.placeholder_under_construction)).toBeNull()
  })

  it('#/library/:id **不**打开详情页——落到列表（旧 id 打新端点会静默串页）', async () => {
    location.hash = '#/library/tmdb%3A123'
    renderShell()
    const main = await screen.findByRole('main')
    // 落到空列表态 = id 段真的被丢了。若 id 被带进 mediaWorkId，这里渲染的是详情页，
    // media_empty_title 不会在场。
    await waitFor(() => {
      expect(within(main).getByText(en.media_empty_title)).toBeInTheDocument()
    })
  })

  it('地址栏自愈：旧 hash 被就地改写成新地址（老书签不会永远停在旧地址上）', async () => {
    location.hash = '#/workflow'
    renderShell()
    await screen.findByRole('main')
    await waitFor(() => expect(location.hash).toBe('#/activity'))
  })

  // 🔴 自愈的**反向边界**：兜底 ≠ 改写，地址栏不许被动。
  // 变异实测（把 useShellRoute 里的 `legacyRedirectTarget(...)===null 就 return` 换成
  // 无条件 `location.replace('#/'+parseShellHash(hash).tab)`）时，nav.contract 的
  // legacyRedirectTarget 纯函数用例**照样全绿**——那条只测判据，测不到副作用。
  // 这两条补的就是那个洞：把内容落点与地址栏行为分开钉。
  it.each([
    ['#/nonsense', '#/nonsense'],
    ['#/triage', '#/triage'],
  ])('兜底 hash %s 内容落到活动页，但地址栏**原样不动**（替用户改地址是越权）', async (start, expected) => {
    location.hash = start
    renderShell()
    const main = await screen.findByRole('main')
    // 内容确实落到活动页（兜底生效）
    await waitFor(() => {
      expect(within(main).getByRole('tablist', { name: en.wb_tablist_label })).toBeInTheDocument()
    })
    // 但地址栏没被改写
    expect(location.hash).toBe(expected)
  })
})
