// web/src/shell/AppShell.presenceReload.test.tsx：Shell 组合锁——详情 hook 必须在
// EventsProvider **里面**。包在外面时 useFoundEvent 读到默认 Context null，found 永不重拉。
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, cleanup, act, waitFor } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { Shell } from './AppShell.js'
import { __resetEventsBusForTests } from '../events/eventsBus.js'
import type { ScoutEvent } from '../events/types.js'

/** 假 EventSource——同 notifications/sseSeparation.test.tsx。jsdom 不自带。 */
class FakeES {
  static instances: FakeES[] = []
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  readyState = 0
  private listeners = new Map<string, ((e: { data: string }) => void)[]>()
  constructor(public url: string) { FakeES.instances.push(this) }
  addEventListener(type: string, fn: (e: { data: string }) => void) {
    const arr = this.listeners.get(type) ?? []
    arr.push(fn)
    this.listeners.set(type, arr)
  }
  removeEventListener() {}
  close() { this.readyState = 2 }
  emit(e: ScoutEvent) {
    for (const fn of this.listeners.get(e.type) ?? []) fn({ data: JSON.stringify(e) })
  }
  open() { this.readyState = 1; this.onopen?.() }
}

let urls: string[] = []

function mockFetch() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    urls.push(url)
    const path = url.split('?')[0] ?? ''
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
      : /\/api\/v2\/mediaLibrary$/.test(path) ? []
      : url.includes('/api/v2/mediaLibrary/')
        ? { work: { workId: 'tmdb:1', title: 'W', chineseTitle: null, year: null,
                    posterPath: null, mediaType: 'tv' },
            seasons: [], movie: null, unplacedFileCount: 0 }
      : /\/api\/v2\/notifications$/.test(path) ? []
      : url.includes('/api/v2/activity') ? { subtitleQueue: [], translateQueue: [] }
      : url.includes('/api/v2/health')
        ? { lastInspectAt: Date.now(), nextInspectAt: Date.now() + 86_400_000,
            workPermitted: true, engineEnabled: true, setupSatisfied: true,
            roots: [], unidentified: { dirCount: 0, dirs: [] },
            stalledJobs: { count: 0, overdueMs: null },
            currents: { identify: null, subtitle: null, translate: null } }
      : url.includes('/workflow/pending')
        ? { meta: { roots: [], lastScanAt: null, files: 0, lastVerifySweepAt: null,
                    verifiedItems: 0, verifiableItems: 0 }, parked: 0 }
      : url.includes('/workflow/passes') ? []
      : {}
    return { ok: true, status: 200, json: async () => body } as unknown as Response
  })
}

const detailGets = () => urls.filter((u) => u.includes('/api/v2/mediaLibrary/')).length

beforeEach(() => {
  urls = []
  FakeES.instances = []
  __resetEventsBusForTests()
  vi.stubGlobal('EventSource', FakeES as unknown as typeof EventSource)
  vi.stubGlobal('fetch', mockFetch())
  location.hash = ''
})
afterEach(() => {
  cleanup()
  __resetEventsBusForTests()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  location.hash = ''
})

describe('Shell：详情 hook 在 EventsProvider 内（found 才能重拉）', () => {
  it('#/media/tmdb:1 收到 found 后详情端点再 GET 一次', async () => {
    location.hash = '#/media/tmdb:1'
    render(<I18nProvider initialLang="en"><Shell /></I18nProvider>)
    await screen.findByRole('main')
    await waitFor(() => expect(detailGets()).toBeGreaterThanOrEqual(1))
    await waitFor(() => expect(FakeES.instances.length).toBeGreaterThan(0))
    const before = detailGets()
    act(() => {
      FakeES.instances[0]!.open()
      FakeES.instances[0]!.emit({
        id: 1, at: Date.now(), type: 'found',
        message: 'Phantom：装上了 2 条字幕', title: 'Phantom',
        workbench: 'subtitle', data: { installed: 2 },
      })
    })
    await waitFor(() => expect(detailGets()).toBeGreaterThan(before))
  })
})
