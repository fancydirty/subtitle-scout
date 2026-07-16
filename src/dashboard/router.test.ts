// src/dashboard/router.test.ts
import { describe, it, expect } from 'vitest'
import { handleApiRoute, type RouterDeps } from './router.js'
import type {
  LibraryItemDTO, SeriesDetailDTO, RunHistoryDTO, ParkedItemDTO, SettingsDTO, DeploySettingsDTO, FsListResult,
  WorkflowPendingDTO, WorkflowPassDTO, WorkflowWorkersDTO, LibrarySeriesDetailDTO, TriageDTO, RunTraceDTO,
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

// dashboard G5：workflow/library/甄别聚合 API 的路由层 stub DTO。
const workflowPendingDTO: WorkflowPendingDTO = {
  series: [{ seriesId: 's1', seriesName: 'A', season: 1, missing: 1, throttled: 0, nextRecheckAt: null, sampleReason: null }],
  movies: [], parked: 0, meta: { roots: ['/media/tv'], lastScanAt: 1, files: 1 },
}
const workflowPassDTO: WorkflowPassDTO = {
  id: 1, jobId: 1, startedAt: 1, finishedAt: 2, detail: 'x',
  receipts: { created: 1, revived: 0, coalesced: 0, blocked_dormant: 0, unknown: 0 },
}
const workflowWorkersDTO: WorkflowWorkersDTO = {
  running: [{ jobId: 1, seriesId: 's1', movieId: null, taskType: 'find_subtitle', seasons: null, startedAtLease: 1, trail: [] }],
  recent: [{ jobId: 1, decision: 'download', detail: 'ok', finishedAt: 2 }],
}
const librarySeriesDetailDTO: LibrarySeriesDetailDTO = {
  series: { id: 's1', name: 'A', chineseTitle: null, posterPath: null, year: null, layoutNonstandard: false },
  seasons: [],
}
const triageDTO: TriageDTO = {
  pending: [parkedItem],
  claimed: [{ pathPrefix: '/media/tv/X/', tmdbId: '1', isTv: true, season: null, createdAt: 1 }],
}
const runTraceDTO: RunTraceDTO = {
  events: [{ runKey: 'job-1', seq: 0, tool: 'search_source', argsSummary: '"x"', resultSummary: '41 candidates', tookMs: 1200, at: 1 }],
}

let lastRunsArgs: { offset: number; limit: number } | null = null
let lastFsListPath: string | null = null
let lastPassesLimit: number | null = null
let lastSeriesId: string | null = null
let lastLibrarySeriesId: string | null = null
let lastRunTraceId: number | null = null
const deps: RouterDeps = {
  library: () => [libItem],
  series: (id) => { lastSeriesId = id; return id === 's1' || id === 'tmdb:71' ? seriesDetail : null },
  runs: (offset, limit) => { lastRunsArgs = { offset, limit }; return [run] },
  parked: () => [parkedItem],
  settings: () => settingsDTO,
  deploySettings: () => deploySettingsDTO,
  roots: () => mediaRoots,
  fsList: (path) => {
    lastFsListPath = path
    return path === '/media' ? ({ ok: true, dirs: ['tv', 'anime'] } satisfies FsListResult) : { ok: false, error: 'path does not exist' }
  },
  workflowPending: () => workflowPendingDTO,
  workflowPasses: (limit) => { lastPassesLimit = limit; return [workflowPassDTO] },
  workflowWorkers: () => workflowWorkersDTO,
  librarySeriesDetail: (id) => { lastLibrarySeriesId = id; return id === 's1' || id === 'tmdb:71' ? librarySeriesDetailDTO : null },
  triage: () => triageDTO,
  runTrace: (id) => { lastRunTraceId = id; return id === 1 ? runTraceDTO : null },
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
    expect(call('/api/v2/series/a%2fb').status).toBe(400) // %2f 解码为 '/'，不在允许字符集
  })

  // 复审修复：真实自有 id 恒为 'tmdb:<n>' 形状（src/v2/ownIds.ts）——冒号必须直通；有些客户端
  // 会把 ':' 编码成 %3A，id 段先 decodeURIComponent 再过 isSafeId；畸形编码（URIError）→ 400。
  describe('自有 id（tmdb:<n> 形状，含冒号）直通两个 series 详情端点', () => {
    it('/api/v2/series/tmdb:71 → 200，deps 收到原样 id', () => {
      const r = call('/api/v2/series/tmdb:71')
      expect(r.status).toBe(200)
      expect(lastSeriesId).toBe('tmdb:71')
    })
    it('/api/v2/series/tmdb%3A71 → 解码为 tmdb:71 后 200', () => {
      const r = call('/api/v2/series/tmdb%3A71')
      expect(r.status).toBe(200)
      expect(lastSeriesId).toBe('tmdb:71')
    })
    it('/api/v2/series/%zz（畸形百分号编码）→ 400，不抛错', () => {
      expect(call('/api/v2/series/%zz').status).toBe(400)
    })
    it('/api/v2/library/series/tmdb:71 → 200，deps 收到原样 id', () => {
      const r = call('/api/v2/library/series/tmdb:71')
      expect(r.status).toBe(200)
      expect(lastLibrarySeriesId).toBe('tmdb:71')
    })
    it('/api/v2/library/series/tmdb%3A71 → 解码为 tmdb:71 后 200', () => {
      const r = call('/api/v2/library/series/tmdb%3A71')
      expect(r.status).toBe(200)
      expect(lastLibrarySeriesId).toBe('tmdb:71')
    })
    it('/api/v2/library/series/%zz（畸形百分号编码）→ 400；含 .. 仍 400', () => {
      expect(call('/api/v2/library/series/%zz').status).toBe(400)
      expect(call('/api/v2/library/series/a..b').status).toBe(400)
      expect(call('/api/v2/library/series/tmdb%3A..%3A71').status).toBe(400) // 解码后含 '..' 同样拒
    })
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

  // dashboard G5：workflow/library/甄别聚合 API——五个纯同步 GET 端点的路由层测试。
  describe('workflow/library/甄别聚合 API（dashboard G5）', () => {
    it('routes GET /api/v2/workflow/pending', () => {
      const r = call('/api/v2/workflow/pending')
      expect(r.status).toBe(200)
      expect(r.json).toEqual(workflowPendingDTO)
    })

    it('routes GET /api/v2/workflow/passes，limit 默认 20、clamp 到 [1,100]', () => {
      call('/api/v2/workflow/passes')
      expect(lastPassesLimit).toBe(20)
      call('/api/v2/workflow/passes', { query: { limit: '5' } })
      expect(lastPassesLimit).toBe(5)
      call('/api/v2/workflow/passes', { query: { limit: '9999' } })
      expect(lastPassesLimit).toBe(100)
      // limit=0 是 falsy，同既有 /api/v2/runs 先例（`Number(...) || 默认值`）一样落回默认值 20，
      // 不是 clamp 到下界 1——0 本身从未真正参与 Math.max/min 比较。
      call('/api/v2/workflow/passes', { query: { limit: '0' } })
      expect(lastPassesLimit).toBe(20)
      call('/api/v2/workflow/passes', { query: { limit: '-5' } })
      expect(lastPassesLimit).toBe(1)
      const r = call('/api/v2/workflow/passes')
      expect(r.status).toBe(200)
      expect(r.json).toEqual([workflowPassDTO])
    })

    it('routes GET /api/v2/workflow/workers', () => {
      const r = call('/api/v2/workflow/workers')
      expect(r.status).toBe(200)
      expect(r.json).toEqual(workflowWorkersDTO)
    })

    it('routes GET /api/v2/library/series/:id，404 未命中，400 非法 id', () => {
      const hit = call('/api/v2/library/series/s1')
      expect(hit.status).toBe(200)
      expect(hit.json).toEqual(librarySeriesDetailDTO)
      expect(call('/api/v2/library/series/nope').status).toBe(404)
      expect(call('/api/v2/library/series/a..b').status).toBe(400)
    })

    it('routes GET /api/v2/triage', () => {
      const r = call('/api/v2/triage')
      expect(r.status).toBe(200)
      expect(r.json).toEqual(triageDTO)
    })

    it('token 门同样保护五个新端点', () => {
      expect(call('/api/v2/workflow/pending', { configuredToken: 's3cret' }).status).toBe(401)
      expect(call('/api/v2/library/series/s1', { configuredToken: 's3cret' }).status).toBe(401)
      expect(call('/api/v2/triage', { configuredToken: 's3cret', token: 's3cret' }).status).toBe(200)
    })
  })

  // dashboard-F4：单 run 痕迹快照回放端点——纯数字 id 校验，404 语义（非数字 id 也是 404，
  // 不是 400：这条路由本身就只认数字形状，跟 series/library 那两条 tmdb:<n> 形状 id 的
  // "400=非法 id" 语义是两套不同的 id 空间，见 router.ts 该路由分支的注释）。
  describe('GET /api/v2/workflow/runs/:id/trace（dashboard-F4：快照回放）', () => {
    it('数字 id 命中 → 200 + deps 收到 number 类型的 id', () => {
      const r = call('/api/v2/workflow/runs/1/trace')
      expect(r.status).toBe(200)
      expect(r.json).toEqual(runTraceDTO)
      expect(lastRunTraceId).toBe(1)
    })

    it('数字 id 但 deps 返回 null（行不存在）→ 404', () => {
      expect(call('/api/v2/workflow/runs/2/trace').status).toBe(404)
    })

    it('非数字 id → 404（路由本身不匹配，不是 400）', () => {
      expect(call('/api/v2/workflow/runs/abc/trace').status).toBe(404)
    })

    it('token 门同样保护这条端点', () => {
      expect(call('/api/v2/workflow/runs/1/trace', { configuredToken: 's3cret' }).status).toBe(401)
      expect(call('/api/v2/workflow/runs/1/trace', { configuredToken: 's3cret', token: 's3cret' }).status).toBe(200)
    })
  })
})
