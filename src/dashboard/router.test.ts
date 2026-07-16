// src/dashboard/router.test.ts
import { describe, it, expect } from 'vitest'
import { handleApiRoute, type RouterDeps } from './router.js'
import type {
  LibraryItemDTO, SeriesDetailDTO, RunHistoryDTO, ParkedItemDTO, SettingsDTO, DeploySettingsDTO, FsListResult,
} from './apiV2.js'
import type { MediaRoot } from '../v2/settingsRepo.js'

const libItem: LibraryItemDTO = {
  id: 's1', kind: 'series', name: 'A', chineseTitle: null, year: null, posterPath: null, section: '剧集',
  coverage: { covered: 0, missing: 1, embedded: 0, unavailable: 0 }, job: null,
}
const seriesDetail: SeriesDetailDTO = {
  id: 's1', name: 'A', chineseTitle: null, year: null, posterPath: null, seasons: [], runs: [],
}
const run: RunHistoryDTO = {
  id: 1, jobId: 1, startedAt: 1, finishedAt: 2, decision: 'download', detail: 'ok', journalPath: null,
}
const parkedItem: ParkedItemDTO = {
  path: '/media/tv/Unknown/e1.mkv', parkReason: 'ambiguous match', firstSeen: 1, lastAttempt: 1,
}
const settingsDTO: SettingsDTO = {
  target_languages: 'zh,en', hardsub_mode: null, exclude_extras: null,
  trace_retention_days: null, scan_interval_ms: null,
}
const deploySettingsDTO: DeploySettingsDTO = {
  secrets: {
    TMDB_API_KEY: { present: true, tail: '7890' }, LLM_API_KEY: { present: false, tail: '' },
    DASHBOARD_TOKEN: { present: false, tail: '' }, ASSRT_TOKEN: { present: false, tail: '' },
    OPENSUBTITLES_API_KEY: { present: false, tail: '' }, OPENSUBTITLES_PASSWORD: { present: false, tail: '' },
  },
  nonSecrets: {
    LLM_BASE_URL: 'https://api.deepseek.com/v1', LLM_MODEL: 'deepseek-chat', LLM_EXTRA_BODY: null,
    OPENSUBTITLES_USERNAME: null, ZIMUKU_ENABLED: null, DASHBOARD_PORT: '8099',
    SUBTITLE_SCOUT_CACHE_DIR: null, LOG_RETAIN_DAYS: null, REALIGN_ARCHIVE_ROOT: null,
    FFPROBE_PATH: null, SCAN_INTERVAL_MS: null, MEDIA_ROOTS: null,
  },
}
const mediaRoots: MediaRoot[] = [{ path: '/media/tv', type: 'local', addedAt: 1 }]

let lastRunsArgs: { offset: number; limit: number } | null = null
let lastFsListPath: string | null = null
const deps: RouterDeps = {
  library: () => [libItem],
  series: (id) => (id === 's1' ? seriesDetail : null),
  runs: (offset, limit) => { lastRunsArgs = { offset, limit }; return [run] },
  parked: () => [parkedItem],
  settings: () => settingsDTO,
  deploySettings: () => deploySettingsDTO,
  roots: () => mediaRoots,
  fsList: (path) => {
    lastFsListPath = path
    return path === '/media' ? ({ ok: true, dirs: ['tv', 'anime'] } satisfies FsListResult) : { ok: false, error: 'path does not exist' }
  },
}

const call = (pathname: string, opts: { query?: Record<string, string>; token?: string; configuredToken?: string } = {}) =>
  handleApiRoute({ pathname, query: opts.query ?? {}, token: opts.token }, deps, opts.configuredToken)

describe('handleApiRoute (v2)', () => {
  it('routes /api/v2/library', () => {
    const r = call('/api/v2/library')
    expect(r.status).toBe(200)
    expect(r.json).toEqual([libItem])
  })
  it('routes /api/v2/series/:id and 404s unknown', () => {
    expect(call('/api/v2/series/s1').status).toBe(200)
    expect(call('/api/v2/series/nope').status).toBe(404)
  })
  it('rejects illegal series id with 400', () => {
    expect(call('/api/v2/series/a..b').status).toBe(400)
    expect(call('/api/v2/series/a%2fb').status).toBe(400) // '%' 不在允许字符集
  })
  it('routes /api/v2/runs with offset/limit defaults', () => {
    expect(call('/api/v2/runs').status).toBe(200)
    expect(lastRunsArgs).toEqual({ offset: 0, limit: 50 })
    call('/api/v2/runs', { query: { offset: '10', limit: '5' } })
    expect(lastRunsArgs).toEqual({ offset: 10, limit: 5 })
  })
  it('routes /api/parked (P6 park 救援)', () => {
    const r = call('/api/parked')
    expect(r.status).toBe(200)
    expect(r.json).toEqual([parkedItem])
  })
  it('retires v1 endpoints with 410', () => {
    expect(call('/api/summary').status).toBe(410)
    expect(call('/api/queue').status).toBe(410)
    expect(call('/api/runs').status).toBe(410)
    expect(call('/api/runs/i-1000').status).toBe(410)
  })
  it('enforces token when configured', () => {
    expect(call('/api/v2/library', { configuredToken: 's3cret' }).status).toBe(401)
    expect(call('/api/v2/library', { configuredToken: 's3cret', token: 'wrong' }).status).toBe(401)
    expect(call('/api/v2/library', { configuredToken: 's3cret', token: 's3cret' }).status).toBe(200)
  })
  it('returns 404 for non-api paths (static handled elsewhere)', () => {
    expect(call('/index.html').status).toBe(404)
  })

  // dashboard G4：settings/deploy/roots/fs 四个纯 GET 端点。
  it('routes GET /api/v2/settings', () => {
    const r = call('/api/v2/settings')
    expect(r.status).toBe(200)
    expect(r.json).toEqual(settingsDTO)
  })

  it('routes GET /api/v2/settings/deploy', () => {
    const r = call('/api/v2/settings/deploy')
    expect(r.status).toBe(200)
    expect(r.json).toEqual(deploySettingsDTO)
  })

  it('routes GET /api/v2/settings/roots', () => {
    const r = call('/api/v2/settings/roots')
    expect(r.status).toBe(200)
    expect(r.json).toEqual(mediaRoots)
  })

  it('routes GET /api/v2/fs/list?path=... → 200 + dirs', () => {
    const r = call('/api/v2/fs/list', { query: { path: '/media' } })
    expect(r.status).toBe(200)
    expect(r.json).toEqual({ dirs: ['tv', 'anime'] })
    expect(lastFsListPath).toBe('/media')
  })

  it('GET /api/v2/fs/list 缺 path 参数 → 400', () => {
    const r = call('/api/v2/fs/list')
    expect(r.status).toBe(400)
  })

  it('GET /api/v2/fs/list 路径不存在（deps.fsList 返回 ok:false）→ 400 + error 文案', () => {
    const r = call('/api/v2/fs/list', { query: { path: '/nope' } })
    expect(r.status).toBe(400)
    expect((r.json as { error: string }).error).toEqual(expect.any(String))
  })

  it('token 门也保护新增的 v2 端点', () => {
    expect(call('/api/v2/settings', { configuredToken: 's3cret' }).status).toBe(401)
    expect(call('/api/v2/settings', { configuredToken: 's3cret', token: 's3cret' }).status).toBe(200)
  })
})
