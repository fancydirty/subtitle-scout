// web/src/shell/AppShell.boundary.test.tsx：**"一个字段缺失不再白屏整个 app"** 的端到端守卫。
//
// ## 这个文件守的是什么
//
// 缺陷原貌（实测，非假想）：`GET /api/v2/setup/status` 的响应体里 `providers` 缺席时，
// `SettingsTabsPage` 在渲染中抛 `Cannot read properties of undefined (reading 'subhd')`，
// React 19 卸载整棵树——**侧栏、顶栏、用户正在看的东西全部消失，屏幕上不留一个字**。
//
// 修完之后正确的样子是：坏的范围 = 设置页那一块；侧栏顶栏照常；用户点一下就能去别的页。
//
// ## 为什么不能只在 SettingsTabsPage 的单测里验
//
// 那边的单测（SettingsTabsPage.test.tsx）验的是"抛了、且抛得说人话"——它证明不了
// **抛出去之后有人接**。接住这件事发生在 AppShell 那一层，只有把两层装在一起跑才测得到。
// 少了这个文件，把 AppShell 里的 PageBoundary 全删掉，那边的单测照样全绿。
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor, within } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { Shell } from './AppShell.js'
import { en } from '../i18n/en.js'

/** setup/status 的**残缺**响应：providers 整个缺席。这正是缺陷的触发形状。 */
const BROKEN_STATUS = { bootstrapComplete: true, engineEnabled: true, roots: { count: 0 } }

function mockFetch(statusBody: unknown) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    const path = url.split('?')[0] ?? ''
    const body: unknown =
      url.includes('/api/v2/setup/status') ? statusBody
      : url.includes('/api/v2/setup/providers') ? { providers: [] }
      : url.includes('/api/v2/settings/deploy') ? { secrets: {}, nonSecrets: {} }
      : url.includes('/api/v2/settings/roots') ? []
      : url.includes('/api/v2/settings')
        ? { target_languages: null, hardsub_mode: null,
            trace_retention_days: null, scan_interval_ms: null }
      : /\/api\/v2\/mediaLibrary$/.test(path) ? []
      : /\/api\/v2\/notifications$/.test(path) ? []
      : url.includes('/api/v2/activity') ? { subtitleQueue: [], translateQueue: [] }
      : url.includes('/workflow/pending')
        ? { meta: { roots: [], lastScanAt: null, files: 0, lastVerifySweepAt: null,
                    verifiedItems: 0, verifiableItems: 0 }, parked: 0 }
      : url.includes('/workflow/passes') ? []
      : {}
    return { ok: true, status: 200, json: async () => body } as unknown as Response
  })
}

beforeEach(() => {
  // 被边界接住的错误 React 仍会往 console.error 复读；静音只为输出可读。
  vi.spyOn(console, 'error').mockImplementation(() => {})
  location.hash = ''
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); location.hash = '' })

const renderShell = () => render(<I18nProvider initialLang="en"><Shell /></I18nProvider>)

describe('AppShell 页级错误边界：DTO 残缺时降级这一页，不白屏整个 app', () => {
  it('setup/status 缺 providers → 设置页降级，**外壳仍在**（这是白屏与降级的分界）', async () => {
    vi.stubGlobal('fetch', mockFetch(BROKEN_STATUS))
    location.hash = '#/settings'
    const { container } = renderShell()

    // 1) 降级 UI 出现在主区里——用户看到的是一句人话，不是空白。
    const main = await screen.findByRole('main')
    await waitFor(() => {
      expect(within(main).getByTestId('page-failed')).toBeInTheDocument()
    })
    expect(within(main).getByText(en.page_failed_title)).toBeInTheDocument()

    // 2) **外壳没被卸载**。这是与旧行为唯一重要的区别：旧代码这里整棵树都没了。
    //    侧栏四项还在 = 用户还能自己走到别的页面去，不用刷新。
    //    ⚠️ 不断言 role=navigation：壳里不止一个（侧栏 + 顶栏面包屑），getByRole 会撞
    //    "found multiple"。四条导航链接在不在，本来就是更贴题的判据。
    expect(screen.getByRole('main')).toBeInTheDocument()
    for (const label of [en.nav_activity, en.nav_notifications, en.nav_media, en.nav_settings]) {
      expect(screen.getByRole('link', { name: label })).toBeInTheDocument()
    }

    // 3) 直接量化"没白屏"：旧行为下 React 卸载整棵树后 root 只剩个位数字符
    //    （审计原话 "root html length: 11"）。这条数字断言不依赖任何文案。
    expect(container.innerHTML.length).toBeGreaterThan(1000)
  })

  it('降级只波及出事的那一页——切到别的 tab 照常渲染', async () => {
    vi.stubGlobal('fetch', mockFetch(BROKEN_STATUS))
    location.hash = '#/media'
    renderShell()
    const main = await screen.findByRole('main')
    // 媒体库页与 setup/status 无关，必须完全不受影响（边界是每页一条，不是全局一条）。
    await waitFor(() => {
      expect(within(main).queryByTestId('page-failed')).not.toBeInTheDocument()
    })
    expect((main.textContent ?? '').trim().length).toBeGreaterThan(0)
  })
})
