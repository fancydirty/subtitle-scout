// web/src/media/mediaTitle.i18n.test.tsx —— 作品名跟随 UI 语言的一致性判据。
//
// ── 为什么存在 ─────────────────────────────────────────────────────────
// 2026-08-18 用户裁决：「切换了 UI 语言的话，界面上语言的一切应该都是
// 切换后语言才对」——媒体库 / 详情页 / 活动页 / 通知页，作品名呈现的
// 那一面应该由 scout-lang 决定，不该是后端给什么就显示什么。
//
// 现状（修复前）：
//   · 活动页 / 通知页 走 displayTitle(lang, ...) —— ✅ 已跟随
//   · 媒体库 MediaLibraryPage.tsx:111 写死 `chineseTitle ?? title` —— ❌
//   · 详情页 MediaDetailPage.tsx:187-188 同上 —— ❌
//
// 用户进一步裁决副标题语义：
//   「如果切换了 UI 语言，那中文名应该就不是副标题，而是直接不见了才对吧，
//    因为外国人不需要知道它中文名是啥。」
//
// 副标题存在的理由是"补充原文 identity"，不是"展示另一种语言"：
//   · zh：主 chineseTitle ?? title；副 title（仅当 chineseTitle 存在且 ≠ title）
//   · en：主 title；副**不渲染**（整个槽消失，不是塞 chineseTitle 进去）
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { I18nProvider, type Lang } from '../i18n/useT.js'
import { MediaLibraryPage } from './MediaLibraryPage.js'
import { MediaDetailPage } from './MediaDetailPage.js'
import type { Async } from '../api/hooks.js'
import type { MediaLibraryItemDTO, MediaLibraryDetailDTO } from '../api/types.js'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

// ── 媒体库 ─────────────────────────────────────────────────────────────
function libItem(o: Partial<MediaLibraryItemDTO> = {}): MediaLibraryItemDTO {
  return {
    workId: 'tmdb:1', title: 'Dark Matter', chineseTitle: '黑暗智宅', year: 2024,
    posterPath: null, mediaType: 'tv',
    expectedEpisodeCount: 9, onDiskEpisodeCount: 9, missingEpisodeCount: 0,
    subtitledEpisodeCount: 6, embeddedEpisodeCount: 0, originLanguageEpisodeCount: 0,
    readyEpisodeCount: 6, uncoveredEpisodeCount: 3,
    unplacedFileCount: 0,
    ...o,
  }
}

function mockFetch(body: unknown) {
  return vi.fn(async (_input: RequestInfo | URL) =>
    ({ ok: true, status: 200, json: async () => body }) as unknown as Response)
}

function renderLibrary(lang: Lang) {
  return render(<I18nProvider initialLang={lang}><MediaLibraryPage /></I18nProvider>)
}

describe('媒体库作品名跟随 UI 语言', () => {
  it('lang=zh → 卡片显示 chineseTitle（黑暗智宅）', async () => {
    vi.stubGlobal('fetch', mockFetch([libItem()]))
    renderLibrary('zh')
    await waitFor(() => expect(screen.getByText('黑暗智宅')).toBeInTheDocument())
    expect(screen.queryByRole('link', { name: /Dark Matter/ })).not.toBeInTheDocument()
  })

  it('🔴 lang=en → 卡片显示 title（Dark Matter），**不再硬塞 chineseTitle**', async () => {
    vi.stubGlobal('fetch', mockFetch([libItem()]))
    renderLibrary('en')
    await waitFor(() => expect(screen.getByText('Dark Matter')).toBeInTheDocument())
    expect(screen.queryByText('黑暗智宅')).not.toBeInTheDocument()
  })

  it('lang=zh 且 chineseTitle=null → 回落 title（不渲染空）', async () => {
    vi.stubGlobal('fetch', mockFetch([libItem({ chineseTitle: null })]))
    renderLibrary('zh')
    await waitFor(() => expect(screen.getByText('Dark Matter')).toBeInTheDocument())
  })
})

// ── 详情页 ─────────────────────────────────────────────────────────────
function detailData(o: Partial<MediaLibraryDetailDTO> = {}): MediaLibraryDetailDTO {
  return {
    work: {
      workId: 'tmdb:1', title: 'Dark Matter', chineseTitle: '黑暗智宅',
      year: 2024, posterPath: null, mediaType: 'tv',
    },
    seasons: [], movie: null, unplacedFileCount: 0,
    ...o,
  }
}

function asyncOf(data: MediaLibraryDetailDTO | null): Async<MediaLibraryDetailDTO> {
  return { data, loading: false, error: null, reload: () => {} }
}

function renderDetail(lang: Lang, d: MediaLibraryDetailDTO) {
  return render(<I18nProvider initialLang={lang}><MediaDetailPage detail={asyncOf(d)} /></I18nProvider>)
}

describe('详情页作品名跟随 UI 语言', () => {
  it('lang=zh → 主 chineseTitle「黑暗智宅」 + 副 title「Dark Matter」', () => {
    renderDetail('zh', detailData())
    expect(screen.getByRole('heading', { name: '黑暗智宅' })).toBeInTheDocument()
    expect(screen.getByText('Dark Matter')).toBeInTheDocument()
  })

  it('🔴 lang=en → 主 title「Dark Matter」；副标题槽**整体不渲染**（外国人不需要知道中文名）', () => {
    renderDetail('en', detailData())
    expect(screen.getByRole('heading', { name: 'Dark Matter' })).toBeInTheDocument()
    // 🔴 这是与 zh 形态的关键差异：chineseTitle 不仅不是主标题，连副标题都不是
    expect(screen.queryByText('黑暗智宅')).not.toBeInTheDocument()
  })

  it('lang=zh 且 chineseTitle=null → 主 title，无副标题', () => {
    renderDetail('zh', detailData({
      work: { ...detailData().work, chineseTitle: null },
    }))
    expect(screen.getByRole('heading', { name: 'Dark Matter' })).toBeInTheDocument()
    // 副标题槽也不应出现第二个 Dark Matter
    expect(screen.getAllByText('Dark Matter')).toHaveLength(1)
  })

  it('lang=zh 且 chineseTitle === title → 主 title，无副标题（现状保留）', () => {
    renderDetail('zh', detailData({
      work: { ...detailData().work, chineseTitle: 'Dark Matter' },
    }))
    expect(screen.getByRole('heading', { name: 'Dark Matter' })).toBeInTheDocument()
    expect(screen.getAllByText('Dark Matter')).toHaveLength(1)
  })

  it('lang=en 且 chineseTitle=null → 主 title，无副标题（平凡情形）', () => {
    renderDetail('en', detailData({
      work: { ...detailData().work, chineseTitle: null },
    }))
    expect(screen.getByRole('heading', { name: 'Dark Matter' })).toBeInTheDocument()
    expect(screen.getAllByText('Dark Matter')).toHaveLength(1)
  })
})
