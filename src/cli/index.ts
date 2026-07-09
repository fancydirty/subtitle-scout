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
import { downloadDirect } from '../adapters/download/direct.js'
import { createLlmRuntime } from '../agent/runtime.js'
import { ProfileStore } from '../agent/profile.js'
import { identifyMedia } from '../agent/identifyMedia.js'
import { planSearch } from '../agent/planSearch.js'
import { rankCandidates } from '../agent/rankCandidates.js'
import { JellyfinClient } from '../adapters/players/jellyfin.js'
import type { PlayerServer } from '../adapters/players/types.js'
import { buildMediaContext, mediaDir, parsePathMappings, isUnderRoots, isDirWritable, mapPath, type PathMapping } from '../core/mediaContext.js'
import { Watcher } from '../daemon/watcher.js'
import { CHINESE_LANG_TAGS } from '../daemon/triggers.js'
import { PrefetchQueue } from '../daemon/queue.js'
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
  checkJellyfin, checkAssrt, checkLlm, checkMediaRoots, checkPathMappings,
  formatDoctorReport, overallOk, withTimeout, type DoctorResult,
} from './doctor.js'

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) { console.error(`missing required env var: ${name}`); process.exit(2) }
  return v
}

export interface Assembled {
  makeDeps: (perRun?: { itemId: string; onCovered: (ep: SeasonEpisode, path: string) => void | Promise<void> }) => PipelineDeps
  /** 每个 job 独立的 journal 上下文——并发任务的 apiCall/自愈事件不再串记到相邻 journal。
   *  所有 runPipeline 调用必须包在此内，否则 assrt/llm 回调取不到 journal 而丢事件。 */
  withJournal: <T>(fn: () => Promise<T>) => Promise<T>
  cacheRoot: string
  llm: { profileInfo: () => { mode: string; quirkId?: string } }
  jf: PlayerServer
  mappings: PathMapping[]
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
  const assrt = new AssrtClient({
    token: requireEnv('ASSRT_TOKEN'),
    cacheDir: join(cacheRoot, 'assrt-responses'),
    onApiCall: r => journalStore.getStore()?.journal?.apiCall(r),
  })
  const makeDeps = (perRun?: { itemId: string; onCovered: (ep: SeasonEpisode, path: string) => void | Promise<void> }): PipelineDeps => ({
    journalReady: j => { const s = journalStore.getStore(); if (s) s.journal = j; j.step('llm_profile', llm.profileInfo()) },
    identify: c => identifyMedia(llm, c),
    plan: (c, id) => planSearch(llm, c, id),
    rank: (c, id, cands) => rankCandidates(llm, c, id, cands),
    assrt: { search: q => assrt.search(q), detail: id => assrt.detail(id) },
    download: url => downloadDirect(url),
    cache: new DecisionCache(join(cacheRoot, 'decisions')),
    maxApiCallsPerJob: 4,
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
  return { makeDeps, withJournal, cacheRoot, llm, jf, mappings }
}

function applyConfidenceOverride(ctx: MediaContext) {
  if (process.env.AUTO_DOWNLOAD_MIN_CONFIDENCE) {
    const v = Number(process.env.AUTO_DOWNLOAD_MIN_CONFIDENCE)
    if (Number.isFinite(v) && v >= 0 && v <= 1) ctx.preferences.auto_download_min_confidence = v
    else console.error(`ignoring invalid AUTO_DOWNLOAD_MIN_CONFIDENCE: ${process.env.AUTO_DOWNLOAD_MIN_CONFIDENCE}`)
  }
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
  applyConfidenceOverride(ctx)
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
  const { makeDeps, withJournal, cacheRoot, llm, jf, mappings } = await assemble()
  const item = await jf.getItem(itemId)
  const chineseTitle = await jf.getChineseTitle(item).catch(() => null)
  const ctx = buildMediaContext(item, mappings, { chineseTitle })
  applyConfidenceOverride(ctx)
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
  const { makeDeps, withJournal, cacheRoot, llm, jf, mappings } = await assemble()
  // 停机时中止在跑的 verify 轮询（否则 6×10s 阻塞会把优雅退出拖到 ~60s）
  const shutdown = new AbortController()
  const roots = mediaRoots(mappings)
  if (roots.length === 0) {
    console.log('[watch] no MEDIA_ROOTS/MEDIA_PATH_MAPPINGS configured — subtitle writes are not root-restricted; set MEDIA_ROOTS to harden')
  }
  const pollSeconds = Number(process.env.POLL_INTERVAL_SECONDS) || 15
  const ledger = new Ledger(join(cacheRoot, 'ledger.jsonl'))
  const fileLog = makeFileLogger(join(cacheRoot, 'logs'), Number(process.env.LOG_RETAIN_DAYS) || 30)
  const log = (msg: string) => {
    const line = `[watch ${new Date().toISOString()}] ${msg}`
    console.log(line)
    fileLog(msg)
  }
  const queue = new PrefetchQueue(
    join(cacheRoot, 'queue.json'),
    undefined,
    e => {
      try { ledger.append({ ts: Date.now(), type: 'queue', ...e }) } catch { /* 观测不影响主流程 */ }
    }
  )
  const watcher = new Watcher({
    jellyfin: {
      getSessions: () => jf.getSessions(),
      getItem: id => jf.getItem(id),
      refreshItem: id => jf.refreshItem(id),
      getRecentItems: l => jf.getRecentItems(l),
      getChineseTitle: item => jf.getChineseTitle(item),
    },
    runJob: async (ctx, outDir, itemId, opts) => {
      applyConfidenceOverride(ctx)
      const journalDir = join(cacheRoot, 'journals', `${itemId}-${Date.now()}`)
      return withJournal(() => runPipeline(
        makeDeps({ itemId, onCovered: async (ep) => { queue.remove(ep.itemId); await jf.refreshItem(ep.itemId).catch(() => {}) } }),
        ctx, outDir, journalDir, opts))
    },
    verify: id => verifyChineseSubtitle(jf, id, shutdown.signal),
    pathMappings: mappings,
    pathExists: p => existsSync(p),
    isWritable: dir => isDirWritable(dir),
    treatPgsAsMissing: (process.env.TREAT_PGS_AS_MISSING ?? 'true') !== 'false',
    cooldownMinutes: Number(process.env.ITEM_COOLDOWN_MINUTES) || 30,
    mediaRoots: roots,
    skipChineseOrigin: (process.env.SKIP_CHINESE_ORIGIN ?? 'true') !== 'false',
    skipCacheMinutes: Number(process.env.SKIP_CACHE_MINUTES) || 5,
    queue,
    log,
    onRunComplete: r => {
      try {
        ledger.append({
          ts: Date.now(),
          type: 'run',
          itemId: r.itemId,
          name: r.name,
          source: r.source,
          decision: r.result.decision,
          confidence: null,
          subtitlePath: r.result.subtitlePath ?? null,
          journalPath: r.result.journalPath,
          llmProfile: llm.profileInfo(),
          durationMs: r.result.stats?.durationMs ?? 0,
          llmCalls: r.result.stats?.llmCalls ?? 0,
          assrtCalls: r.result.stats?.apiCalls ?? 0,
          error: r.result.decision === 'error' ? (r.result.errorMessage ?? null) : null,
        })
      } catch { /* 观测不影响主流程 */ }
    },
    pruneJournals: () => pruneOldDirs(join(cacheRoot, 'journals'), Number(process.env.JOURNAL_RETAIN_DAYS) || 90),
  })
  const dashPort = Number(process.env.DASHBOARD_PORT) || 0
  if (dashPort > 0) {
    const distDir = join(new URL('../..', import.meta.url).pathname, 'web', 'dist')
    const dashServer = await startDashboard({
      cacheRoot,
      port: dashPort,
      token: process.env.DASHBOARD_TOKEN || undefined,
      distDir,
      getInFlight: () => watcher.inFlightItems(),
    })
    if (dashServer.listening) {
      console.log(`dashboard on http://0.0.0.0:${dashPort}${process.env.DASHBOARD_TOKEN ? ' (token required)' : ''}`)
    } else {
      log('dashboard server failed to start (port conflict?), continuing without dashboard')
    }
  }
  console.log(`subtitle-scout watching ${process.env.JELLYFIN_URL} every ${pollSeconds}s`)
  let stopping = false
  const stop = async () => {
    if (stopping) process.exit(1)
    stopping = true
    shutdown.abort() // 唤醒在跑的 verify 轮询，别把退出拖到 60s
    console.log('shutting down after in-flight jobs...')
    while (watcher.busy()) await new Promise(r => setTimeout(r, 500))
    process.exit(0)
  }
  process.on('SIGINT', stop); process.on('SIGTERM', stop)
  const arrivalsEvery = (Number(process.env.ARRIVALS_POLL_MINUTES) || 15) * 60_000
  const consumeEvery = (Number(process.env.PREFETCH_INTERVAL_MINUTES) || 10) * 60_000
  let lastArrivals = 0, lastConsume = 0
  for (;;) {
    if (!stopping) {
      await watcher.tick()
      const now = Date.now()
      if (now - lastArrivals >= arrivalsEvery) { lastArrivals = now; await watcher.arrivalsTick() }
      if (now - lastConsume >= consumeEvery) { lastConsume = now; await watcher.consumeTick() }
    }
    await new Promise(r => setTimeout(r, pollSeconds * 1000))
  }
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
  let queueNow = { pending: 0, dormant: 0 }
  try { queueNow = new PrefetchQueue(join(cacheRoot, 'queue.json')).size() } catch { /* 无队列文件 */ }
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
