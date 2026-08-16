import { existsSync, mkdtempSync, mkdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import type { LanguageModel } from 'ai'
import { makeModel } from '../../agent/llm.js'
import { runIdentify } from '../../agent/identifyWorker.js'
import { makeFindSubtitleWorker } from '../../agent/findSubtitleWorker.js'
import { tagsForLanguage } from '../../agent/languages.js'
import { buildAdapters } from '../../adapters/buildAdapters.js'
import { TmdbClient } from '../../adapters/providers/tmdb.js'
import { findExternalSidecar } from '../../files/sidecar.js'
import { envOnlyAdapterConfig } from '../../v2/secrets.js'
import { openDb, type ScoutDb } from '../../v2/db.js'
import { SettingsRepo } from '../../v2/settingsRepo.js'
import { ScoutDaemonV2 } from '../../v2/daemonV2.js'
import type { IdentifySchedulerDeps } from '../../v2/identifyScheduler.js'
import {
  loadCatalog,
  type Catalog,
  type CatalogEntry,
  type SandboxProfile,
} from './catalog.js'
import { materializeLibrary } from './materialize.js'
import {
  countSidecarCues,
  evaluateFindCell,
  evaluateSkipCell,
  formatReportTable,
  type CellVerdict,
} from './report.js'

const DEFAULT_CATALOG = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../fixtures/sandbox-libraries/catalog.json',
)

/** Never defaults to ~/.subtitle-scout/cache. */
export function sandboxCacheDir(explicit?: string): string {
  if (explicit) return explicit
  return join(tmpdir(), 'subtitle-scout-sandbox', `cache-${process.pid}-${Date.now()}`)
}

export function sandboxDbPath(cacheDir: string): string {
  return join(cacheDir, 'scout.db')
}

/** Live CLI gate: TMDB + LLM + at least one subtitle source. */
export function missingLiveEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const missing: string[] = []
  for (const k of ['TMDB_API_KEY', 'LLM_API_KEY', 'LLM_BASE_URL', 'LLM_MODEL'] as const) {
    if (!env[k]) missing.push(k)
  }
  const hasAssrt = !!env.ASSRT_TOKEN
  const hasOs = !!(env.OPENSUBTITLES_API_KEY && env.OPENSUBTITLES_USERNAME && env.OPENSUBTITLES_PASSWORD)
  if (!hasAssrt && !hasOs) {
    missing.push('ASSRT_TOKEN|OPENSUBTITLES_API_KEY+USERNAME+PASSWORD')
  }
  return missing
}

export interface EntryFacts {
  path: string
  actualTmdbId: number | null
  skipReason: string | null
  needsSubtitle: number | null
  subStatus: string | null
  sidecarTags: string[]
  cueCount: number
  findSubtitleRuns: number
  lastError: string | null
}

export function collectEntryFacts(
  db: ScoutDb,
  root: string,
  entry: CatalogEntry,
  targetLanguage: 'zh' | 'en',
  findSubtitleRunsByPath: Map<string, number>,
): EntryFacts {
  const abs = join(root, entry.relPath)
  const row = db.prepare(
    `SELECT f.path, f.skip_reason, f.needs_subtitle, f.sub_status, f.work_id, f.last_error
     FROM files f WHERE f.path = ?`,
  ).get(abs) as {
    path: string
    skip_reason: string | null
    needs_subtitle: number | null
    sub_status: string | null
    work_id: string | null
    last_error: string | null
  } | undefined

  let actualTmdbId: number | null = null
  if (row?.work_id?.startsWith('tmdb:')) {
    const n = Number(row.work_id.slice('tmdb:'.length))
    if (Number.isFinite(n)) actualTmdbId = n
  }

  const tags = tagsForLanguage(targetLanguage)
  const side = findExternalSidecar(abs, tags, existsSync)
  const sidecarTags: string[] = []
  let cueCount = 0
  if (side) {
    // Recover the tag from the filename stem.<tag>.ext
    const base = basename(abs).replace(/\.[^.]+$/, '')
    const sideBase = basename(side.path)
    const m = sideBase.match(new RegExp(`^${escapeRegExp(base)}\\.(.+)\\.[^.]+$`))
    if (m) sidecarTags.push(m[1])
    else sidecarTags.push(...tags.filter(t => side.path.includes(`.${t}.`)))
    cueCount = countSidecarCues(side.path)
  }

  return {
    path: abs,
    actualTmdbId,
    skipReason: row?.skip_reason ?? null,
    needsSubtitle: row?.needs_subtitle ?? null,
    subStatus: row?.sub_status ?? null,
    sidecarTags,
    cueCount,
    findSubtitleRuns: findSubtitleRunsByPath.get(abs) ?? 0,
    lastError: row?.last_error ?? null,
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function defaultCatalogPath(explicit?: string): string {
  if (explicit) return explicit
  if (existsSync(DEFAULT_CATALOG)) return DEFAULT_CATALOG
  const cwd = join(process.cwd(), 'fixtures/sandbox-libraries/catalog.json')
  return cwd
}

async function assembleLiveWorkers(cacheRoot: string, targetLanguage: 'zh' | 'en', db: ScoutDb): Promise<{
  identify: IdentifySchedulerDeps
  subtitleWorker: ReturnType<typeof makeFindSubtitleWorker>
}> {
  const cfg = envOnlyAdapterConfig(process.env)
  let extraBody: Record<string, unknown> | undefined
  if (process.env.LLM_EXTRA_BODY) {
    extraBody = JSON.parse(process.env.LLM_EXTRA_BODY)
  }
  const model = makeModel({
    baseUrl: process.env.LLM_BASE_URL!,
    apiKey: process.env.LLM_API_KEY!,
    model: process.env.LLM_MODEL!,
    extraBody,
  })
  const tmdb = new TmdbClient({
    apiKey: process.env.TMDB_API_KEY!,
    baseUrl: process.env.TMDB_BASE_URL,
    proxyUrl: process.env.TMDB_PROXY_URL,
  })
  const adapters = await buildAdapters(() => {}, cfg, () => {})

  const identify: IdentifySchedulerDeps = {
    db,
    runIdentify,
    worker: {
      model: model as LanguageModel,
      librarySandbox: true,
      tmdb: {
        search: (mt, q, y) => tmdb.search(mt, q, y),
        getDetails: async (mt, id) => {
          const d = await tmdb.getDetails(mt, id)
          if (!d) return null
          const chinese = await tmdb.getChineseTitles(mt, id).catch(() => [])
          const ol = await tmdb.getOriginLanguage(mt, id).catch(() => null)
          return {
            id: Number(id),
            title: d.title || d.originalTitle || String(id),
            originalTitle: d.originalTitle ?? null,
            year: d.year,
            overview: d.overview,
            posterPath: d.posterPath,
            genreIds: d.genreIds,
            backdropPath: d.backdropPath,
            originLanguage: ol,
            chineseTitles: chinese,
          }
        },
        getExternalIds: (mt, id) => tmdb.getExternalIds(mt, id),
        getSeasonTable: (id) => tmdb.getSeasonTable(id),
        getSeasonEpisodes: (id, season) => tmdb.getSeasonEpisodes(id, season),
      },
    },
  }

  const subtitleWorker = makeFindSubtitleWorker({
    model: model as LanguageModel,
    adapters,
    cacheRoot,
    tmdb,
    librarySandbox: true,
  })

  return { identify, subtitleWorker }
}

export interface ProfileRunResult {
  profile: SandboxProfile
  rows: Array<{ id: string; verdict: CellVerdict; detail: string }>
  anyFail: boolean
}

/** One profile: materialize → temp db → inspectOnce → report. */
export async function runSandboxProfile(opts: {
  catalog: Catalog
  profile: SandboxProfile
  root: string
  cacheDir: string
  /** When set, skip live env / real workers (mechanical tests inject their own daemon). */
  daemonFactory?: (args: {
    db: ScoutDb
    root: string
    cacheDir: string
    targetLanguage: 'zh' | 'en'
  }) => ScoutDaemonV2
  findSubtitleRunsByPath?: Map<string, number>
}): Promise<ProfileRunResult> {
  const targetLanguage: 'zh' | 'en' = opts.profile === 'zh-viewer' ? 'zh' : 'en'
  mkdirSync(opts.root, { recursive: true })
  mkdirSync(opts.cacheDir, { recursive: true })
  materializeLibrary(opts.catalog, opts.profile, opts.root)

  process.env.SUBTITLE_SCOUT_CACHE_DIR = opts.cacheDir
  const dbPath = sandboxDbPath(opts.cacheDir)
  if (resolve(dbPath) === resolve(join(homedir(), '.subtitle-scout', 'cache', 'scout.db'))) {
    throw new Error('refusing to open production scout.db')
  }

  const db = openDb(dbPath)
  const now = Date.now()
  const settings = new SettingsRepo(db)
  settings.set('target_languages', targetLanguage, now)
  settings.set('engine_enabled', 'true', now)
  const add = settings.addRoot(opts.root, now)
  if (!add.ok) throw new Error(`addRoot failed: ${JSON.stringify(add)}`)

  const runsByPath = opts.findSubtitleRunsByPath ?? new Map<string, number>()
  let daemon: ScoutDaemonV2
  if (opts.daemonFactory) {
    daemon = opts.daemonFactory({ db, root: opts.root, cacheDir: opts.cacheDir, targetLanguage })
  } else {
    const { identify, subtitleWorker } = await assembleLiveWorkers(opts.cacheDir, targetLanguage, db)
    daemon = new ScoutDaemonV2({
      db,
      roots: [opts.root],
      rootsProvider: () => [opts.root],
      targetLanguage,
      probe: async () => null,
      probeDuration: async () => null,
      sleep: async () => {},
      emit: () => {},
      log: (msg: string) => console.error(`[sandbox-library] ${msg}`),
      translateEnabled: () => false,
      workPermitted: () => true,
      writableRoots: new Map([[opts.root, true]]),
      identify,
      subtitleWorker,
      now: () => Date.now(),
    } as any)
  }

  await daemon.inspectOnce(new AbortController().signal)

  const entries = opts.catalog.entries.filter(e => e.profile === opts.profile)
  const rows: Array<{ id: string; verdict: CellVerdict; detail: string }> = []
  let anyFail = false
  for (const entry of entries) {
    const facts = collectEntryFacts(db, opts.root, entry, targetLanguage, runsByPath)
    const cell = entry.role === 'find'
      ? evaluateFindCell({
          expectedTmdbId: entry.tmdbId,
          actualTmdbId: facts.actualTmdbId,
          skipReason: facts.skipReason,
          needsSubtitle: facts.needsSubtitle,
          subStatus: facts.subStatus,
          sidecarTags: facts.sidecarTags,
          cueCount: facts.cueCount,
          findSubtitleRuns: facts.findSubtitleRuns,
          targetLanguage,
        })
      : evaluateSkipCell({
          skipReason: facts.skipReason,
          needsSubtitle: facts.needsSubtitle,
          findSubtitleRuns: facts.findSubtitleRuns,
          sidecarTags: facts.sidecarTags,
        })
    rows.push({ id: entry.id, verdict: cell.verdict, detail: cell.detail })
    if (cell.verdict !== 'PASS') anyFail = true
  }

  db.close()
  return { profile: opts.profile, rows, anyFail }
}

export async function runSandboxLibraryCommand(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      profile: { type: 'string', default: 'all' },
      root: { type: 'string' },
      catalog: { type: 'string' },
      'cache-dir': { type: 'string' },
    },
    allowPositionals: true,
    strict: false,
  })

  const profileArg = (values.profile as string) || 'all'
  if (profileArg !== 'zh-viewer' && profileArg !== 'en-viewer' && profileArg !== 'all') {
    console.error(`unknown --profile ${profileArg} (want zh-viewer|en-viewer|all)`)
    return 2
  }

  const missing = missingLiveEnv()
  if (missing.length > 0) {
    console.error(`sandbox-library 缺少环境变量：${missing.join(', ')}`)
    console.error('需要 TMDB_API_KEY、LLM_API_KEY、LLM_BASE_URL、LLM_MODEL，以及 ASSRT_TOKEN 或 OpenSubtitles 三件套。')
    return 2
  }

  const catalogPath = defaultCatalogPath(values.catalog as string | undefined)
  const catalog = loadCatalog(catalogPath)
  const profiles: SandboxProfile[] = profileArg === 'all'
    ? ['zh-viewer', 'en-viewer']
    : [profileArg as SandboxProfile]

  const baseRoot = (values.root as string | undefined)
    ?? mkdtempSync(join(tmpdir(), 'subtitle-scout-sandbox-lib-'))
  const baseCache = sandboxCacheDir(values['cache-dir'] as string | undefined)

  let anyFail = false
  for (const profile of profiles) {
    const root = join(baseRoot, profile)
    const cacheDir = join(baseCache, profile)
    console.error(`[sandbox-library] profile=${profile} root=${root} cache=${cacheDir}`)
    const result = await runSandboxProfile({ catalog, profile, root, cacheDir })
    console.log(`\n=== ${profile} ===`)
    console.log(formatReportTable(result.rows))
    if (result.anyFail) anyFail = true
  }

  return anyFail ? 1 : 0
}
