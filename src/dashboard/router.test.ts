// src/dashboard/router.test.ts
import { describe, it, expect } from 'vitest'
import { handleApiRoute, type RouterDeps } from './router.js'
import type {
  RunHistoryDTO, SettingsDTO, DeploySettingsDTO, FsListResult,
  WorkflowPendingDTO, WorkflowPassDTO, RunTraceDTO,
  DormantTaskDTO,
} from './apiV2.js'
import type { ShiftedItemDTO } from './subtitleVerifyApi.js'
import type { MediaLibraryItemDTO, MediaLibraryDetailDTO } from './mediaLibraryApi.js'
import type { MediaRoot } from '../v2/settingsRepo.js'
import type { SetupStatusDTO, ProvidersDTO } from './setupApi.js'

const run: RunHistoryDTO = {
  id: 1, jobId: 1, startedAt: 1, finishedAt: 2, decision: 'download', detail: 'ok', journalPath: null,
}
const settingsDTO: SettingsDTO = {
  target_languages: 'zh,en', hardsub_mode: null,
  trace_retention_days: null, scan_interval_ms: null, ai_translate_enabled: null, translate_after_attempts: null,
  engine_enabled: null, 'provider:SUBHD_ENABLED': null, 'provider:ZIMUKU_ENABLED': null,
  engineEnabled: true,
}
const deploySettingsDTO: DeploySettingsDTO = {
  secrets: {
    TMDB_API_KEY: { present: true, tail: '7890' }, LLM_API_KEY: { present: false, tail: '' },
    DASHBOARD_TOKEN: { present: false, tail: '' }, ASSRT_TOKEN: { present: false, tail: '' },
    OPENSUBTITLES_API_KEY: { present: false, tail: '' }, OPENSUBTITLES_PASSWORD: { present: false, tail: '' },
    TRANSLATE_API_KEY: { present: true, tail: 'cdef' }, JIMAKU_API_KEY: { present: false, tail: '' },
  },
  nonSecrets: {
    LLM_BASE_URL: 'https://api.deepseek.com/v1', LLM_MODEL: 'deepseek-chat', LLM_EXTRA_BODY: null,
    OPENSUBTITLES_USERNAME: null, ZIMUKU_ENABLED: null, DASHBOARD_PORT: '8099',
    SUBTITLE_SCOUT_CACHE_DIR: null, LOG_RETAIN_DAYS: null, REALIGN_ARCHIVE_ROOT: null,
    FFPROBE_PATH: null, SCAN_INTERVAL_MS: null, MEDIA_ROOTS: null,
    TMDB_BASE_URL: null, TMDB_PROXY_URL: null,
    // R2D-10（R2 复审）：DEPLOY_NONSECRET_KEYS 补齐的两键（apiV2.ts）。
    TARGET_LANGUAGES: null, SKIP_CHINESE_ORIGIN: null,
    // Wave0：AI 翻译部署门可见性三角（apiV2.ts）。
    TRANSLATE_BASE_URL: null, TRANSLATE_MODEL: 'mimo-v2.5-pro', TRANSLATE_CRITIC: null,
    TRANSLATE_CRITIC_MODEL: null, TRANSLATE_TIMEOUT_MS: null, SUBHD_ENABLED: null,
    TRUST_PROXY: null,
  },
}
const mediaRoots: MediaRoot[] = [{ path: '/media/tv', type: 'local', addedAt: 1 }]

// dashboard G5：workflow/library/甄别聚合 API 的路由层 stub DTO。
const workflowPendingDTO: WorkflowPendingDTO = {
  meta: { roots: ['/media/tv'], lastScanAt: 1, files: 1 , lastVerifySweepAt: null, verifiedItems: 0, verifiableItems: 0},
}
const workflowPassDTO: WorkflowPassDTO = {
  id: 1, jobId: 1, startedAt: 1, finishedAt: 2, detail: 'x',
  receipts: { created: 1, revived: 0, coalesced: 0, blocked_dormant: 0, unknown: 0 },
}
const runTraceDTO: RunTraceDTO = {
  events: [{ runKey: 'job-1', seq: 0, tool: 'search_source', argsSummary: '"x"', resultSummary: '41 candidates', tookMs: 1200, at: 1 }],
}
const setupStatusDTO = {
  bootstrapComplete: false,
  tmdb: { satisfied: false, source: 'none', masked: null },
  llm: { satisfied: false, source: 'none', model: null },
  providers: {
    assrt: { satisfied: false, source: 'none', masked: null },
    // masked 是必填字段（Task 5 的 opensubtitles 形状是 satisfied/source/hasUsername/masked
    // 四件套），漏了它 satisfies 直接报错。
    opensubtitles: { satisfied: false, source: 'none', hasUsername: false, masked: null },
    jimaku: { satisfied: false, source: 'none', masked: null },
    subhd: { enabled: false, source: 'none' },
    zimuku: { enabled: false, source: 'none', captchaReady: false },
    r3sub: { satisfied: false, source: 'none', masked: null },
    subdl: { satisfied: false, source: 'none', masked: null },
  },
  roots: { count: 0 },
  engineEnabled: true,
} satisfies SetupStatusDTO
// ProvidersDTO 的字段名是 providers（不是 rows）——见 Task 5 的 `interface ProvidersDTO`。
const providersDTO = { providers: [] } satisfies ProvidersDTO

// Plan C（spec §4）：两个只读 GET 的路由层 stub DTO。
const shiftedRow: ShiftedItemDTO = {
  itemId: 'tmdb:100/s2e3', seriesId: 'tmdb:100', seriesName: 'The Rig',
  season: 2, episode: 3, checkedAt: 3000, hasPriorCorrection: true,
}
const dormantRow: DormantTaskDTO = {
  jobId: 1, task: 'find_subtitle', targetLabel: 'The Rig, Season 2', attempts: 5,
}

let lastRunsArgs: { offset: number; limit: number } | null = null
let lastFsListPath: string | null = null
let lastPassesLimit: number | null = null
let lastRunTraceId: number | null = null
let lastMediaLibraryId: string | null = null
// R-F2 / R-F5：媒体库页两个新 DTO 的路由层 stub（内容正确性由 mediaLibraryApi.test.ts 钉，
// 这里只需要形状合法——路由层的职责是 method/shape/存在性判定）。
const mediaLibraryItem: MediaLibraryItemDTO = {
  workId: 'tmdb:1', title: 'Breaking Bad', chineseTitle: '绝命毒师', year: 2008,
  posterPath: '/bb.jpg', mediaType: 'tv',
  expectedEpisodeCount: 62, onDiskEpisodeCount: 60, missingEpisodeCount: 2, subtitledEpisodeCount: 58, embeddedEpisodeCount: 0,
  originLanguageEpisodeCount: 0, readyEpisodeCount: 58, uncoveredEpisodeCount: 2,
  unplacedFileCount: 0,
}
const mediaLibraryDetailDTO: MediaLibraryDetailDTO = {
  work: {
    workId: 'tmdb:1', title: 'Breaking Bad', chineseTitle: '绝命毒师', year: 2008,
    posterPath: '/bb.jpg', mediaType: 'tv', backdropPath: null, overview: null, overviewZh: null,
  },
  seasons: [{
    season: 1,
    episodes: [{ episode: 3, title: 'E3', onDisk: true, dot: 'green', episodeState: 'covered', fileCount: 2, subtitledFileCount: 1 }],
  }],
  movie: null,
  unplacedFileCount: 0,
}
/** R-F13 活动页排队段（Task ⑨）。两段各一项，图一有一无——无图那项守着"降级不是崩"。 */
const activityDTO = {
  subtitleQueue: [{
    workId: 'tmdb:1', title: 'Queued Show', chineseTitle: null, year: 2018, mediaType: 'tv' as const,
    posterPath: '/p.jpg', backdropPath: '/bd.jpg', pendingFileCount: 13,
    // 退避中的那一项（🔴-1）：路由层只是透传，但形状必须齐——缺 dueNow 时前端的
    // `dueNow !== false` 会把它当成"已到点"，那正是这次要修的那句假话的镜像。
    dueNow: false, retryAfter: 1_700_000_000_000, awaitingRescan: false,
  }],
  translateQueue: [{
    workId: 'tmdb:2', title: 'Translating Movie', chineseTitle: null, year: 2001, mediaType: 'movie' as const,
    posterPath: null, backdropPath: null, pendingFileCount: 1,
    dueNow: true, retryAfter: null, awaitingRescan: false,
  }],
}
const deps: RouterDeps = {
  runs: (offset, limit) => { lastRunsArgs = { offset, limit }; return [run] },
  settings: () => settingsDTO,
  deploySettings: () => deploySettingsDTO,
  roots: () => mediaRoots,
  fsList: (path) => {
    lastFsListPath = path
    return path === '/media' ? ({ ok: true, dirs: ['tv', 'anime'] } satisfies FsListResult) : { ok: false, error: 'path does not exist' }
  },
  workflowPending: () => workflowPendingDTO,
  workflowPasses: (limit) => { lastPassesLimit = limit; return [workflowPassDTO] },
  runTrace: (id) => { lastRunTraceId = id; return id === 1 ? runTraceDTO : null },
  shiftedSubtitles: () => [shiftedRow],
  dormantTasks: () => [dormantRow],
  setupStatus: () => setupStatusDTO,
  providers: () => providersDTO,
  // R-F2 / R-F5：媒体库页两个新端点的路由层 stub。
  mediaLibrary: () => [mediaLibraryItem],
  mediaLibraryDetail: (id) => { lastMediaLibraryId = id; return id === 'tmdb:1' ? mediaLibraryDetailDTO : null },
  activity: () => activityDTO,
}

const call = (pathname: string, opts: { query?: Record<string, string> } = {}) =>
  handleApiRoute({ pathname, query: opts.query ?? {} }, deps)

describe('handleApiRoute (v2)', () => {
  it('routes /api/v2/runs with offset/limit defaults', () => {
    expect(call('/api/v2/runs').status).toBe(200)
    expect(lastRunsArgs).toEqual({ offset: 0, limit: 50 })
    call('/api/v2/runs', { query: { offset: '10', limit: '5' } })
    expect(lastRunsArgs).toEqual({ offset: 10, limit: 5 })
  })
  // 2026-08-13：`/api/parked` 与 `/api/v2/triage` 随 parked 族整体删除（见 apiV2.ts 的
  // Parked 段墓碑）。两条用例**改成 404 墓碑锁**而不是删掉——同 `/api/v2/workflow/workers`
  // 的既有先例：路由表少一条是静默的，留一条负向断言，谁把它加回来就得先来读一遍裁决。
  it('retires /api/parked with 404 (parked 族整体退役)', () => {
    expect(call('/api/parked').status).toBe(404)
  })
  it('retires v1 endpoints with 410', () => {
    expect(call('/api/summary').status).toBe(410)
    expect(call('/api/queue').status).toBe(410)
    expect(call('/api/runs').status).toBe(410)
    expect(call('/api/runs/i-1000').status).toBe(410)
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

    // 2026-08-13 裁决：GET /api/v2/workflow/workers 已删除。这条从"路由到 DTO"翻面成
    // **404 墓碑**——它比删掉整条用例强：有人若把端点悄悄接回来（比如为了给某个新页面
    // 复用旧 DTO），这条会红并指向 apiV2.ts 的墓碑注释，要求先重读裁决。
    // 判据留在测试里而不是注释里，是本仓这一族清理的既有形态。
    it('GET /api/v2/workflow/workers 已删除 → 404（不是 200 空壳）', () => {
      const r = call('/api/v2/workflow/workers')
      expect(r.status).toBe(404)
    })

    it('retires GET /api/v2/triage with 404 (parked 族整体退役)', () => {
      expect(call('/api/v2/triage').status).toBe(404)
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
  })

  it('GET /api/v2/setup/status → 200 + DTO 直出', () => {
    const r = call('/api/v2/setup/status')
    expect(r.status).toBe(200)
    expect(r.json).toBe(setupStatusDTO)
  })

  it('GET /api/v2/setup/providers → 200 + DTO 直出', () => {
    const r = call('/api/v2/setup/providers')
    expect(r.status).toBe(200)
    expect(r.json).toBe(providersDTO)
  })

  // Plan C（spec §4）：两个只读 GET——纯透传 deps，零写路径、零状态机改动。
  it('GET /api/v2/subtitle/shifted → 200 + 透传 deps.shiftedSubtitles()', () => {
    const r = call('/api/v2/subtitle/shifted')
    expect(r.status).toBe(200)
    expect(r.json).toEqual([shiftedRow])
  })

  it('GET /api/v2/workflow/dormant → 200 + 透传 deps.dormantTasks()', () => {
    const r = call('/api/v2/workflow/dormant')
    expect(r.status).toBe(200)
    expect(r.json).toEqual([dormantRow])
  })

  // R-F2 / R-F5：媒体库页两个新端点的路由层判定。
  describe('媒体库页（R-F2 / R-F5）', () => {
    it('routes /api/v2/mediaLibrary', () => {
      const r = call('/api/v2/mediaLibrary')
      expect(r.status).toBe(200)
      expect(r.json).toEqual([mediaLibraryItem])
    })

    it('routes /api/v2/mediaLibrary/:workId，deps 收到原样 id', () => {
      const r = call('/api/v2/mediaLibrary/tmdb:1')
      expect(r.status).toBe(200)
      expect(r.json).toEqual(mediaLibraryDetailDTO)
      expect(lastMediaLibraryId).toBe('tmdb:1')
    })

    it('%3A 编码的 id 解码后同样命中', () => {
      expect(call('/api/v2/mediaLibrary/tmdb%3A1').status).toBe(200)
      expect(lastMediaLibraryId).toBe('tmdb:1')
    })

    it('未命中 404；非法 id 400', () => {
      expect(call('/api/v2/mediaLibrary/tmdb:404').status).toBe(404)
      expect(call('/api/v2/mediaLibrary/a..b').status).toBe(400)
      expect(call('/api/v2/mediaLibrary/%zz').status).toBe(400)
    })

    it('🔴 精确路径 /api/v2/mediaLibrary 不被带 id 的正则吃掉（列表与详情两条路由不许互相遮蔽）', () => {
      // 防回归：把列表路由写在正则之后、或把正则写成 `([^/]*)` 时，其中一条会静默失效。
      expect(call('/api/v2/mediaLibrary').json).toEqual([mediaLibraryItem])
      expect(call('/api/v2/mediaLibrary/tmdb:1').json).toEqual(mediaLibraryDetailDTO)
    })
  })

  // R-F13：活动页排队段（Task ⑨）。
  describe('活动页（R-F13）', () => {
    it('routes /api/v2/activity', () => {
      const r = call('/api/v2/activity')
      expect(r.status).toBe(200)
      expect(r.json).toEqual(activityDTO)
    })

    it('🔴 不被 /api/v2/mediaLibrary/:id 那条正则吃掉，也不吃掉别人', () => {
      // 两条路由的字面前缀不同，但正则式路由最容易出的事就是顺序性遮蔽。
      expect(call('/api/v2/activity').json).toEqual(activityDTO)
      expect(call('/api/v2/mediaLibrary').json).toEqual([mediaLibraryItem])
    })

    it('不认二级路径（/api/v2/activity/xxx → 404，不静默回落到列表）', () => {
      expect(call('/api/v2/activity/tmdb:1').status).toBe(404)
    })
  })
})
