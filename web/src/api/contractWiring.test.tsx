// web/src/api/contractWiring.test.tsx：契约违例的**用户可见结果**。
//
// ── 为什么这个文件与 contract.test.ts 分开 ──────────────────────────────────
// 那边验的是"拦下来了"（检查器 + 声明 + client 出口）。拦下来之后**用户看到什么**
// 是另一件事，且是这整层的真正目的——它发生在页面那一层，只有把 client 与页面装在
// 一起跑才测得到。少了这个文件，把违约处置从"抛错"改成"当作空数据降级"，
// contract.test.ts 里**一条都不会红**（那边根本不渲染页面）。
//
// 三个页面各一条，问的都是同一个问题：
//   后端返回**形状不对的 200** 时，页面是 (a) 崩、(b) 说"没有数据"、还是 (c) 诚实报错？
// 正确答案只有 (c)。(b) 尤其要钉死——它就是本仓 §4.4 反复点名的那句谎话
// （「库里没有东西」与「我没能问到」是两件事），而契约违例天然长着 (b) 的样子：
// HTTP 200、请求成功、数据"到了"，只是内容不对。
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { en } from '../i18n/en.js'
import { MediaLibraryPage } from '../media/MediaLibraryPage.js'
import { NotificationsPage } from '../notifications/NotificationsPage.js'

beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}) })
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

/** 每个端点各给一个体；未列出的走 `{}`。 */
function mockFetch(byPath: Record<string, unknown>) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    const hit = Object.keys(byPath).find((k) => url.includes(k))
    return { ok: true, status: 200, json: async () => (hit ? byPath[hit] : {}) } as unknown as Response
  }))
}

const HEALTH_OK = {
  lastInspectAt: null, workPermitted: true, engineEnabled: true, setupSatisfied: true,
  roots: [], current: null,
}

const render1 = (ui: React.ReactElement) => render(<I18nProvider initialLang="en">{ui}</I18nProvider>)

describe('契约违例的用户可见结果：诚实报错，不是"没有数据"', () => {
  it('🔴 媒体库：后端 200 但行少了计数字段 → 显示**错误态**，'
    + '**绝不**显示"库里什么都没有"（那是把接口坏了说成真没数据）', async () => {
    mockFetch({
      '/api/v2/mediaLibrary': [{ workId: 'tmdb:1', title: 'BB' }], // 少四个计数字段
      '/api/v2/health': HEALTH_OK,
    })
    render1(<MediaLibraryPage />)

    // 错误态在场，且消息指认了是契约违约（不是一句无从下手的 "something went wrong"）。
    await waitFor(() => expect(screen.getByText(en.media_error_title)).toBeInTheDocument())
    expect(screen.getByText(/\[contract\]/)).toBeInTheDocument()

    // 🔴 空态文案**一个字都不许出现**。这是本条用例真正的价值：
    // 契约违例长着"成功"的样子（HTTP 200），最容易滑进空态分支。
    expect(screen.queryByText(en.media_empty_title)).not.toBeInTheDocument()
  })

  it('🔴 通知页：后端返回 {error} 顶替了数组 → 错误态，不是"最近没有新发现"', async () => {
    mockFetch({ '/api/v2/notifications': { error: 'db locked' }, '/api/v2/health': HEALTH_OK })
    render1(<NotificationsPage />)
    await waitFor(() => expect(screen.getByText(/\[contract\]/)).toBeInTheDocument())
    expect(screen.queryByText(en.notif_empty_title)).not.toBeInTheDocument()
  })

  it('✅ 反面对照：**合法的空**（200 + []）仍然正常走空态。'
    + '没有这一条，上面两条可以靠"永远报错"作弊通过', async () => {
    mockFetch({ '/api/v2/mediaLibrary': [], '/api/v2/health': HEALTH_OK })
    render1(<MediaLibraryPage />)
    await waitFor(() => expect(screen.getByText(en.media_empty_title)).toBeInTheDocument())
    expect(screen.queryByText(/\[contract\]/)).not.toBeInTheDocument()
  })

  it('✅ 反面对照：完整数据正常渲染（校验不改数据、不误伤正常路径）', async () => {
    mockFetch({
      '/api/v2/mediaLibrary': [{
        workId: 'tmdb:1', title: 'Breaking Bad', chineseTitle: null, year: 2008,
        posterPath: null, mediaType: 'tv', expectedEpisodeCount: 62,
        onDiskEpisodeCount: 62, missingEpisodeCount: 0, subtitledEpisodeCount: 62, embeddedEpisodeCount: 0, uncoveredEpisodeCount: 0,
      }],
      '/api/v2/health': HEALTH_OK,
    })
    render1(<MediaLibraryPage />)
    await waitFor(() => expect(screen.getByText('Breaking Bad')).toBeInTheDocument())
    expect(screen.queryByText(/\[contract\]/)).not.toBeInTheDocument()
  })
})
