import 'dotenv/config'
import { parseArgs } from 'node:util'
import { AsyncLocalStorage } from 'node:async_hooks'
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { generateText } from 'ai'
import { MediaContextSchema, type MediaContext } from '../core/schemas.js'
import { runPipeline, type PipelineDeps, type PipelineResult } from '../core/pipeline.js'
import type { Journal } from '../core/journal.js'
import { DecisionCache } from '../core/cache.js'
import { AssrtClient } from '../adapters/providers/assrt.js'
import { OpenSubtitlesClient } from '../adapters/providers/opensubtitles.js'
import { TmdbClient, tmdbTitles, resolveTmdbRefStrict } from '../adapters/providers/tmdb.js'
import { downloadDirect } from '../adapters/download/direct.js'
import { makeCliProviderPort } from '../core/providerPort.js'
import { providerErrorFields, providerNoticeFields } from './fetchLib.js'
import { createLlmRuntime } from '../agent/runtime.js'
import { ProfileStore } from '../agent/profile.js'
import { identifyMedia } from '../agent/identifyMedia.js'
import { planSearch } from '../agent/planSearch.js'
import { rankCandidates } from '../agent/rankCandidates.js'
import { verifySubtitle } from '../agent/verifySubtitle.js'
import { allocate, install, cleanup, gcOrphans } from '../files/stagingSandbox.js'
import { JellyfinClient } from '../adapters/players/jellyfin.js'
import type { PlayerServer } from '../adapters/players/types.js'
import { buildMediaContext, mediaDir, parsePathMappings, isUnderRoots, isDirWritable, mapPath, type PathMapping } from '../core/mediaContext.js'
// import { Watcher } from '../daemon/watcher.js'  // v1 watcher — 保留文件但不再引用
import { CHINESE_LANG_TAGS } from '../daemon/triggers.js'
// import { PrefetchQueue } from '../daemon/queue.js'  // v1 queue — v2 不用
import { scanOrphans } from '../files/orphanScanner.js'
import { judgeOrphan } from '../agent/judgeOrphan.js'
import { Ledger } from '../core/ledger.js'
import { parseSince, formatReport } from './report.js'
import { makeFileLogger } from '../core/fileLogger.js'
import { pruneOldDirs } from '../core/retention.js'
import { mapSeasonPack } from '../agent/mapSeasonPack.js'
import type { SeasonEpisode } from '../core/episode.js'
import { startDashboard } from '../dashboard/server.js'
import { makeModel } from '../agent/llm.js'
import {
  checkJellyfin, checkAssrt, checkOpenSubtitles, checkLlm, checkMediaRoots, checkPathMappings,
  checkDatabase, checkStuckJobs,
  formatDoctorReport, overallOk, withTimeout, type DoctorResult,
} from './doctor.js'
import { openDb } from '../v2/db.js'
import { JobsRepo } from '../v2/jobsRepo.js'
import { LibraryRepo } from '../v2/libraryRepo.js'
import { RunsRepo } from '../v2/runsRepo.js'
import { scanLibrary, type OriginResolver } from '../v2/scanner.js'
import { aggregate } from '../v2/aggregator.js'
import { executeJob, makeRunEpisode } from '../v2/executor.js'
import { ScoutDaemon, type DaemonDeps } from '../v2/daemon.js'
import type { MediaItem } from '../adapters/players/types.js'

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) { console.error(`missing required env var: ${name}`); process.exit(2) }
  return v
}

export interface Assembled {
  makeDeps: (perRun?: { itemId: string; onCovered: (ep: SeasonEpisode, path: string, providerRef?: string) => void | Promise<void> }) => PipelineDeps
  /** 每个 job 独立的 journal 上下文——并发任务的 apiCall/自愈事件不再串记到相邻 journal。
   *  所有 runPipeline 调用必须包在此内，否则 assrt/llm 回调取不到 journal 而丢事件。 */
  withJournal: <T>(fn: () => Promise<T>) => Promise<T>
  cacheRoot: string
  llm: { profileInfo: () => { mode: string; quirkId?: string } }
  jf: PlayerServer
  mappings: PathMapping[]
  /** 有 TMDB_API_KEY 时可用；取全部中文标题变体（增益路径，无 key 则 null）。 */
  tmdb: TmdbClient | null
}

async function assemble(): Promise<Assembled> {
  const cacheRoot = process.env.SUBTITLE_SCOUT_CACHE_DIR || join(homedir(), '.subtitle-scout', 'cache')
  const mappings = parsePathMappings(process.env.MEDIA_PATH_MAPPINGS)
  const jf = new JellyfinClient({ baseUrl: requireEnv('JELLYFIN_URL'), apiKey: requireEnv('JELLYFIN_API_KEY') })
  let extraBody: Record<string, unknown> | undefined
  if (process.env.LLM_EXTRA_BODY) {
    try { extraBody = JSON.parse(process.env.LLM_EXTRA_BODY) } catch {
      console.error(`LLM_EXTRA_BODY is not valid JSON: ${process.env.LLM_EXTRA_BODY}`)
      process.exit(2)
    }
  }
  const profileStore = new ProfileStore(join(cacheRoot, 'llm-profiles'))
  // 每个 job 在自己的 AsyncLocalStorage 上下文里跑；assrt/llm 回调按当前上下文解析 journal，
  // 并发任务（watch 下多播放会话并行）不再把 apiCall/自愈事件串记到相邻 journal。
  const journalStore = new AsyncLocalStorage<{ journal: Journal | null }>()
  const withJournal = <T>(fn: () => Promise<T>): Promise<T> => journalStore.run({ journal: null }, fn)
  const llm = await createLlmRuntime({
    baseUrl: requireEnv('LLM_BASE_URL'),
    apiKey: requireEnv('LLM_API_KEY'),
    model: requireEnv('LLM_MODEL'),
    extraBody,
  }, profileStore, undefined, info => journalStore.getStore()?.journal?.step('llm_profile_healed', info))
  // 可选：TMDB 中文标题变体数据源（key 用户自备，见 README「第四把钥匙」）。缺 key → null，走 jellyfin fallback。
  const tmdb = process.env.TMDB_API_KEY ? new TmdbClient({ apiKey: process.env.TMDB_API_KEY }) : null
  const makeDeps = (perRun?: { itemId: string; onCovered: (ep: SeasonEpisode, path: string, providerRef?: string) => void | Promise<void> }): PipelineDeps => ({
    journalReady: j => { const s = journalStore.getStore(); if (s) s.journal = j; j.step('llm_profile', llm.profileInfo()) },
    identify: c => identifyMedia(llm, c),
    plan: (c, id) => planSearch(llm, c, id),
    rank: (c, id, cands) => rankCandidates(llm, c, id, cands),
    verify: (c, id, cand, signals) => verifySubtitle(llm, c, id, cand, signals),
    staging: { allocate, install, cleanup },
    providers: makeCliProviderPort({
      onEvent: e => {
        const journal = journalStore.getStore()?.journal
        if (e.event === 'api_call') {
          // MINOR-1 review finding: droppedEntries（per-entry fail-soft 过滤丢弃的条目数）之前从未
          // 转发到 journal——journal.apiCall 的 ApiCallRecord 没有专门字段，塞进 params（本就是
          // Record<string, unknown>）里，不新增 journal.ts 的类型面。
          journal?.apiCall({
            endpoint: e.endpoint,
            params: { provider: e.provider, ...(e.droppedEntries !== undefined ? { droppedEntries: e.droppedEntries } : {}) },
            status: e.status ?? 0, durationMs: e.durationMs, error: e.error,
          })
        } else if (e.event === 'provider_error') {
          // code/resetAt（如 OS quota_exhausted）随 message 一起入 journal，供人工排障时能看到
          // 重置时间——实际的重试调度消费在 v2 executor（见 pipeline.ts 的 ProviderQuotaExhaustedError 通路）。
          journal?.step('providerError', providerErrorFields(e))
        } else if (e.event === 'provider_notice') {
          // 信息性事件——本次调用其实成功了（review finding: journal honesty）。用独立的
          // 'providerNotice' step 名记录，不能沿用 'providerError'，否则日志/dashboard 读者会把
          // 一次成功下载误读成一个错误步骤。
          journal?.step('providerNotice', providerNoticeFields(e))
        }
      },
    }),
    download: url => downloadDirect(url),
    llm,
    cache: new DecisionCache(join(cacheRoot, 'decisions')),
    maxApiCallsPerJob: 4,
    // FINDING-1: 同一份 roots（mapping.to + MEDIA_ROOTS）喂给 pipeline，供它把试错沙盒钉在
    // 媒体根一级——与 gcStaging()/isUnderRoots 校验用的是同一次 mediaRoots(mappings) 计算，
    // 三处判定不会各算各的对不上号。裸 `cli run` 调试路径没有配置这些 env 时退化为 []（pipeline
    // 内部再退回 outDir 本身，见 pipeline.ts stagingRoot 的注释）。
    mediaRoots: mediaRoots(mappings),
    adoption: (process.env.ADOPT_LOCAL_SUBTITLES ?? 'true') !== 'false' ? {
      scan: (dir, video) => scanOrphans(dir, video),
      judge: (c, id, orphans) => judgeOrphan(llm, id, c.media.filename, orphans),
      read: p => readFileSync(p),
    } : undefined,
    ...(perRun ? {
      seasonPack: {
        enumerate: async () => {
          const item = await jf.getItem(perRun.itemId)
          return (await jf.getSeasonEpisodes(item)).map(e => ({ ...e, videoPath: mapPath(e.videoPath, mappings) }))
        },
        map: (c, id, filelist, eps) => mapSeasonPack(llm, c, id, filelist, eps),
        onCovered: perRun.onCovered,
      },
    } : {}),
  })
  return { makeDeps, withJournal, cacheRoot, llm, jf, mappings, tmdb }
}

function exitCodeFor(decision: PipelineResult['decision']): number {
  if (decision === 'download' || decision === 'already_exists') return 0
  if (decision === 'error') return 2
  return 1
}

function mediaRoots(mappings: PathMapping[]): string[] {
  const fromEnv = (process.env.MEDIA_ROOTS ?? '').split(',').map(s => s.trim()).filter(Boolean)
  return [...mappings.map(m => m.to), ...fromEnv]
}

/** refresh 后轮询等待中文外挂字幕流出现（FullRefresh 实测 ~3s 内可见，上限 60s）。
 *  signal 中止（停机）时立即返回，避免优雅退出被 6×10s 轮询拖住。 */
async function verifyChineseSubtitle(jf: PlayerServer, itemId: string, signal?: AbortSignal): Promise<boolean> {
  for (let i = 0; i < 6; i++) {
    if (signal?.aborted) return false
    const item = await jf.getItem(itemId)
    const found = (item.MediaStreams ?? []).some(s =>
      s.Type === 'Subtitle' && s.IsExternal && s.Language && CHINESE_LANG_TAGS.test(s.Language))
    if (found) return true
    if (i < 5) await sleep(10_000, signal)
  }
  return false
}

/** setTimeout 的可中止版：signal.abort() 时立即 resolve（不 reject——调用方按未命中处理）。 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, ms)
    const onAbort = () => { clearTimeout(timer); resolve() }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function cmdRun(contextPath: string, outDir: string) {
  const ctx = MediaContextSchema.parse(JSON.parse(readFileSync(contextPath, 'utf8')))
  const { makeDeps, withJournal, cacheRoot, llm } = await assemble()
  const result = await withJournal(() => runPipeline(makeDeps(), ctx, outDir))
  console.log(JSON.stringify({ decision: result.decision, subtitle: result.subtitlePath ?? null, journal: result.journalPath, fromCache: result.fromCache ?? false }, null, 2))
  try {
    const ledger = new Ledger(join(cacheRoot, 'ledger.jsonl'))
    ledger.append({
      ts: Date.now(),
      type: 'run',
      itemId: '',
      name: ctx.media.title,
      source: 'cli',
      decision: result.decision,
      confidence: null,
      subtitlePath: result.subtitlePath ?? null,
      journalPath: result.journalPath,
      llmProfile: llm.profileInfo(),
      durationMs: result.stats.durationMs,
      llmCalls: result.stats.llmCalls,
      assrtCalls: result.stats.apiCalls,
      error: null,
    })
  } catch { /* 观测不影响主流程 */ }
  process.exit(exitCodeFor(result.decision))
}

async function cmdRunItem(itemId: string) {
  const { makeDeps, withJournal, cacheRoot, llm, jf, mappings, tmdb } = await assemble()
  const item = await jf.getItem(itemId)
  const chineseTitle = await jf.getChineseTitle(item).catch(() => null)
  const chineseTitles = tmdb ? await tmdbTitles(tmdb, item, id => jf.getItem(id)) : undefined
  const ctx = buildMediaContext(item, mappings, { chineseTitle, chineseTitles })
  const roots = mediaRoots(mappings)
  if (!isUnderRoots(mediaDir(ctx), roots)) {
    console.error(`refusing write outside media roots: ${mediaDir(ctx)} — configure MEDIA_ROOTS / MEDIA_PATH_MAPPINGS`)
    process.exit(2)
  }
  if (!existsSync(mediaDir(ctx))) {
    console.error(`media dir not accessible locally: ${mediaDir(ctx)} — check MEDIA_PATH_MAPPINGS`)
    process.exit(2)
  }
  if (!isDirWritable(mediaDir(ctx))) {
    console.error(`media dir not writable: ${mediaDir(ctx)} — sidecar 无法写入，检查挂载读写权限（只读网盘/WebDAV?）`)
    process.exit(2)
  }
  const journalDir = join(cacheRoot, 'journals', `${itemId}-${Date.now()}`)
  const result = await withJournal(() => runPipeline(
    makeDeps({ itemId, onCovered: async (ep) => { await jf.refreshItem(ep.itemId).catch(() => {}) } }),
    ctx, mediaDir(ctx), journalDir))
  let visible: boolean | undefined
  if (result.decision === 'download') {
    await jf.refreshItem(itemId)
    visible = await verifyChineseSubtitle(jf, itemId)
  }
  console.log(JSON.stringify({ decision: result.decision, subtitle: result.subtitlePath ?? null, visibleInJellyfin: visible ?? null, journal: result.journalPath }, null, 2))
  try {
    const ledger = new Ledger(join(cacheRoot, 'ledger.jsonl'))
    ledger.append({
      ts: Date.now(),
      type: 'run',
      itemId,
      name: ctx.media.title,
      source: 'cli',
      decision: result.decision,
      confidence: null,
      subtitlePath: result.subtitlePath ?? null,
      journalPath: result.journalPath,
      llmProfile: llm.profileInfo(),
      durationMs: result.stats.durationMs,
      llmCalls: result.stats.llmCalls,
      assrtCalls: result.stats.apiCalls,
      error: null,
    })
  } catch { /* 观测不影响主流程 */ }
  process.exit(exitCodeFor(result.decision))
}

async function cmdWatch() {
  const { makeDeps, withJournal, cacheRoot, llm, jf, mappings, tmdb } = await assemble()
  const shutdown = new AbortController()
  const roots = mediaRoots(mappings)
  if (roots.length === 0) {
    console.log('[watch] no MEDIA_ROOTS/MEDIA_PATH_MAPPINGS configured — subtitle writes are not root-restricted; set MEDIA_ROOTS to harden')
  }

  const fileLog = makeFileLogger(join(cacheRoot, 'logs'), Number(process.env.LOG_RETAIN_DAYS) || 30)
  const log = (msg: string) => {
    const line = `[watch ${new Date().toISOString()}] ${msg}`
    console.log(line)
    fileLog(msg)
  }

  // Open v2 database
  const dbPath = join(cacheRoot, 'scout.db')
  const db = openDb(dbPath)
  const jobs = new JobsRepo(db)
  const lib = new LibraryRepo(db)
  const runs = new RunsRepo(db)

  // Create runEpisode closure（I5b: 根限定经 opts 传入）
  const runEpisode = makeRunEpisode(
    { makeDeps, withJournal, cacheRoot, llm, jf, mappings, tmdb },
    lib,
    { mediaRoots: roots },
  )

  // Construct DaemonDeps
  const skipChineseOrigin = (process.env.SKIP_CHINESE_ORIGIN ?? 'true') !== 'false'

  // TMDB origin_lang 解析器：有 tmdb（TMDB_API_KEY 已配置）才接线，否则 undefined——
  // scanLibrary 退化到 classifyItem 的 ProductionLocations/标题启发式兜底梯队。
  // 用 resolveTmdbRefStrict（而非 resolveTmdbRef）：Episode→series 回查若是 Jellyfin 请求
  // 瞬时失败（网络/5xx），必须原样向上抛出，scanLibrary 才能按"本轮不解析"处理（不落
  // ORIGIN_UNKNOWN 哨兵、标题启发式兜底也被压制）；resolveTmdbRef 的静默吞错语义只适合
  // tmdbTitles 那类增益路径，接在这里会把 Jellyfin 抖动误判成"查无数据"并永久缓存。
  const originResolver: OriginResolver | undefined = tmdb
    ? {
        originFor: async item => {
          const ref = await resolveTmdbRefStrict(item, id => jf.getItem(id))
          return ref ? tmdb.getOriginLanguage(ref.mediaType, ref.tmdbId) : null
        },
      }
    : undefined

  const daemonDeps: DaemonDeps = {
    lib,
    jobs,
    runs,
    scan: async () => {
      await scanLibrary(jf, lib, {
        pageSize: 100,
        fileExists: (p) => existsSync(p),
        mappings,
        skipChineseOrigin,
        resolver: originResolver,
      })
    },
    aggregate: (now) => aggregate(lib, jobs, now),
    gcStaging: () => gcOrphans(roots, new Set()),
    executeJob: async (job) => {
      await withJournal(() => executeJob(job, {
        lib,
        jobs,
        runEpisode,
        now: () => Date.now(),
        log,
      }))
    },
    getSessions: () => jf.getSessions(),
    episodeForSession: (item: MediaItem) => {
      if (item.Type === 'Episode' && item.SeriesId && item.ParentIndexNumber !== undefined && item.ParentIndexNumber !== null) {
        return {
          kind: 'series_season' as const,
          seriesId: item.SeriesId,
          season: item.ParentIndexNumber,
        }
      }
      if (item.Type === 'Movie' && item.Id) {
        return {
          kind: 'movie' as const,
          movieId: item.Id,
        }
      }
      return null
    },
    log,
    now: () => Date.now(),
    reconcileEveryMs: 15 * 60_000,   // 15 min
    fullScanEveryMs: 6 * 3600_000,   // 6 hours (一期全量扫描，此字段预留)
    concurrency: {
      searching: 1,
      downloading: 2,  // 一期由 executor 内部串行，此处预留
      verifying: 2,    // 一期由 executor 内部串行，此处预留
    },
  }

  // Dashboard v2（媒体库 API + 海报代理，读 v2 SQLite）
  const dashPort = Number(process.env.DASHBOARD_PORT) || 0
  if (dashPort > 0) {
    const distDir = join(new URL('../..', import.meta.url).pathname, 'web', 'dist')
    const dashServer = await startDashboard({
      db,
      port: dashPort,
      token: process.env.DASHBOARD_TOKEN || undefined,
      distDir,
      jellyfin: {
        baseUrl: requireEnv('JELLYFIN_URL'),
        apiKey: requireEnv('JELLYFIN_API_KEY'),
      },
    })
    if (dashServer.listening) {
      console.log(`dashboard on http://0.0.0.0:${dashPort}${process.env.DASHBOARD_TOKEN ? ' (token required)' : ''}`)
    } else {
      log('dashboard server failed to start (port conflict?), continuing without dashboard')
    }
  }

  console.log(`subtitle-scout v2 watching ${process.env.JELLYFIN_URL}`)

  const daemon = new ScoutDaemon(daemonDeps)

  const stop = () => {
    log('received shutdown signal')
    shutdown.abort()
  }

  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)

  await daemon.run(shutdown.signal)
  process.exit(0)
}

async function cmdReport(since: string) {
  const cacheRoot = process.env.SUBTITLE_SCOUT_CACHE_DIR || join(homedir(), '.subtitle-scout', 'cache')
  const ledger = new Ledger(join(cacheRoot, 'ledger.jsonl'))
  let sinceMs: number
  try {
    sinceMs = parseSince(since, Date.now())
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e))
    process.exit(2)
  }
  const { events, badLines } = ledger.read(sinceMs)
  // v2: queue 不再使用，报告暂时传空队列状态（二期接 DB 后恢复）
  const queueNow = { pending: 0, dormant: 0 }
  // try { queueNow = new PrefetchQueue(join(cacheRoot, 'queue.json')).size() } catch { /* 无队列文件 */ }
  process.stdout.write(formatReport(events, badLines, queueNow))
  process.exit(0)
}

async function cmdDoctor() {
  const cacheRoot = process.env.SUBTITLE_SCOUT_CACHE_DIR || join(homedir(), '.subtitle-scout', 'cache')
  const mappings = parsePathMappings(process.env.MEDIA_PATH_MAPPINGS)
  const roots = (process.env.MEDIA_ROOTS ?? '').split(',').map(s => s.trim()).filter(Boolean)
  const results: DoctorResult[] = []

  // env 缺失走诊断项（✗ + hint、exit 1），不 requireEnv 急切崩溃（那是 exit 2 的”用法错误”通道）
  const jfUrl = process.env.JELLYFIN_URL
  const jfKey = process.env.JELLYFIN_API_KEY
  let jf: PlayerServer | undefined
  let jellyfinResult: DoctorResult
  if (!jfUrl || !jfKey) {
    jellyfinResult = {
      name: 'jellyfin', ok: false, detail: 'JELLYFIN_URL / JELLYFIN_API_KEY 未配置',
      hint: '在 .env 里填上这两项（获取方法见 README 三把钥匙一节）。',
    }
  } else {
    jf = new JellyfinClient({ baseUrl: jfUrl, apiKey: jfKey })
    const client = jf
    jellyfinResult = await checkJellyfin({ getSessions: () => withTimeout(client.getSessions(), 10_000, 'Jellyfin') })
  }
  results.push(jellyfinResult)

  const assrtToken = process.env.ASSRT_TOKEN
  if (!assrtToken) {
    results.push({
      name: 'assrt', ok: false, detail: 'ASSRT_TOKEN 未配置',
      hint: '注册/获取：https://assrt.net → 登录 → 用户中心复制 API token。',
    })
  } else {
    const assrt = new AssrtClient({ token: assrtToken, cacheDir: join(cacheRoot, 'assrt-responses') })
    results.push(await checkAssrt({ quota: () => withTimeout(assrt.quota(), 10_000, 'ASSRT') }))
  }

  const osKey = process.env.OPENSUBTITLES_API_KEY
  if (!osKey) {
    results.push(await checkOpenSubtitles(null))
  } else {
    const os = new OpenSubtitlesClient({
      apiKey: osKey, appUserAgent: 'subtitlescout v0.2.0',
      username: process.env.OPENSUBTITLES_USERNAME, password: process.env.OPENSUBTITLES_PASSWORD,
    })
    // The Matrix：配额免费的探测目标，只验证 key/网络，不耗下载配额
    results.push(await checkOpenSubtitles({
      search: () => withTimeout(os.search({ imdbId: 133093, languages: ['zh-cn'] }), 10_000, 'OpenSubtitles'),
    }))
  }

  const llmBase = process.env.LLM_BASE_URL
  const llmKey = process.env.LLM_API_KEY
  const llmModel = process.env.LLM_MODEL
  if (!llmBase || !llmKey || !llmModel) {
    results.push({
      name: 'llm', ok: false, detail: 'LLM_BASE_URL / LLM_API_KEY / LLM_MODEL 未配置',
      hint: '三项必须来自同一个 AI 服务商（比如都用 DeepSeek），BASE_URL 通常以 /v1 结尾。',
    })
  } else {
    const model = makeModel({ baseUrl: llmBase, apiKey: llmKey, model: llmModel })
    results.push(await checkLlm(async () =>
      (await generateText({ model, prompt: '回复"ok"两个字母即可', abortSignal: AbortSignal.timeout(30_000) })).text))
  }

  results.push(checkMediaRoots(roots, isDirWritable))

  if (jf && jellyfinResult.ok) {
    try {
      const items = await jf.getRecentItems(20)
      results.push(checkPathMappings(items, mappings, { dirExists: d => existsSync(d), isWritable: isDirWritable }))
    } catch {
      results.push({ name: 'path-mapping', ok: true, skip: true, detail: '取媒体列表失败，跳过（先看 jellyfin 项）' })
    }
  } else {
    results.push({ name: 'path-mapping', ok: true, skip: true, detail: 'Jellyfin 不可达，跳过（先修复 jellyfin 项）' })
  }

  // v2 database checks (only if db file exists)
  const dbPath = join(cacheRoot, 'scout.db')
  if (existsSync(dbPath)) {
    const { openDb } = await import('../v2/db.js')
    const { JobsRepo } = await import('../v2/jobsRepo.js')

    results.push(checkDatabase(() => {
      const db = openDb(dbPath)
      const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined
      db.close()
      return { version: row?.value ?? '0' }
    }))

    results.push(checkStuckJobs(() => {
      const db = openDb(dbPath)
      const now = Date.now()
      const result = db.prepare(
        `SELECT COUNT(*) as count FROM jobs
         WHERE state IN ('searching', 'downloading', 'verifying')
         AND (lease_until < ? OR lease_until IS NULL)`
      ).get(now) as { count: number }
      db.close()
      return result.count
    }))
  } else {
    results.push({ name: 'database', ok: true, skip: true, detail: '数据库尚未初始化，起一次 watch 即建' })
    results.push({ name: 'stuck-jobs', ok: true, skip: true, detail: '数据库尚未初始化，起一次 watch 即建' })
  }
  console.log(formatDoctorReport(results))
  if (!overallOk(results)) process.exit(1)
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      context: { type: 'string' },
      out: { type: 'string', default: './output' },
      'item-id': { type: 'string' },
      since: { type: 'string', default: '24h' },
    },
  })
  const cmd = positionals[0]
  if (cmd === 'run' && values.context) return cmdRun(values.context, values.out!)
  if (cmd === 'run-item' && values['item-id']) return cmdRunItem(values['item-id'])
  if (cmd === 'watch') return cmdWatch()
  if (cmd === 'report') return cmdReport(values.since!)
  if (cmd === 'doctor') return cmdDoctor()
  console.error('usage: subtitle-scout run --context <json> [--out <dir>] | run-item --item-id <id> | watch | report [--since <24h|7d|ISO-date-UTC>] | doctor')
  process.exit(2)
}

main().catch(e => { console.error(e); process.exit(2) })
