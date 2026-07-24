// E AI 翻译 · CLI 入口 `subtitle-scout translate-item <videoPath>`:对单个视频跑端到端翻译
// (探内嵌轨→抽→译→fail-closed 闸→过闸写中文 sidecar)。薄 I/O 胶水,核心逻辑在
// src/translate/translateItem.ts(已单测)。真机验收 E 用它。
import { existsSync, writeFileSync, renameSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, basename, join } from 'node:path'
import { homedir } from 'node:os'
import { makeModel } from '../agent/llm.js'
import { probeEmbeddedSubtitles, probeDurationSec } from '../files/streamProbe.js'
import { extractEmbeddedSubtitle } from '../files/extractEmbeddedSub.js'
import { findExternalSidecar } from '../files/sidecar.js'
import { makeTranslationLM } from '../translate/translateLm.js'
import { makeTranslationCritic } from '../translate/translateCritic.js'
import { translateItem, type TranslateItemDeps } from '../translate/translateItem.js'
import type { TranslationContext, TranslationCritic } from '../translate/translatePipeline.js'
import { makeTranslateWorker, type TranslateWorkerDeps } from '../agent/translateWorker.js'
import type { TranslateTask } from '../agent/translateWorker.schemas.js'
import { containingRoot } from '../core/mediaContext.js'
import { GlossaryRepo } from '../v2/glossaryRepo.js'
import { makeRealFetchSourceSub } from './fetchSourceSub.js'
import { buildAdapters } from '../adapters/buildAdapters.js'

const CHINESE_TAGS = ['zh-Hans', 'zh-Hant', 'zh', 'zh-CN', 'zh-TW', 'chs', 'cht', 'chi', 'zho']

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) {
    console.error(`translate-item 需要 ${name}(在 .env 配 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL,同一 AI 服务商)`)
    process.exit(2)
  }
  return v
}

/** F2:TMDB original_language 码 → prompt 源语言显示名。未知码→'源语言'(宁泛不硬套英文)。 */
export function sourceLangDisplayName(originLang: string | null | undefined): string {
  const l = (originLang ?? '').trim().toLowerCase()
  if (l === 'en' || l.startsWith('en-')) return '英文'
  if (l === 'ja' || l === 'jpn' || l.startsWith('ja-')) return '日文'
  if (!l) return '英文' // 缺省=F1 回归(英剧主路径)
  return '源语言'
}

/** 扫同目录既有中文 sidecar 当上下文播种术语表(库内直读、零网络;取前 3 份各截断 3000 字)。
 *  F2:可选 originLang 注入 sourceLangName,驱动日/英 prompt 文案。 */
function gatherSeriesContext(videoPath: string, originLang?: string | null): TranslationContext {
  const dir = dirname(videoPath)
  const self = basename(videoPath)
  const subs: string[] = []
  try {
    for (const f of readdirSync(dir)) {
      if (f === self || !/\.(srt|ass|ssa)$/i.test(f)) continue
      const lower = f.toLowerCase()
      if (!CHINESE_TAGS.some((t) => lower.includes(`.${t.toLowerCase()}.`))) continue
      try { subs.push(readFileSync(join(dir, f), 'utf8').slice(0, 3000)) } catch { /* 单份读失败跳过 */ }
      if (subs.length >= 3) break
    }
  } catch { /* 目录读失败 → 无上下文 */ }
  const ctx: TranslationContext = { sourceLangName: sourceLangDisplayName(originLang) }
  if (subs.length) ctx.seriesExistingSubs = subs
  return ctx
}

/** E 翻译用的 LLM 配置。TRANSLATE_MODEL 一旦设置 → 走 TRANSLATE_* 三件套(让 E 用强模型,与
 *  captcha 用的 LLM_MODEL=mimo 分开——真机实测 mimo 对翻译太弱);否则回退 LLM_*。 */
function translateLlmCfg(): { baseUrl: string; apiKey: string; model: string } {
  if (process.env.TRANSLATE_MODEL) {
    return { baseUrl: requireEnv('TRANSLATE_BASE_URL'), apiKey: requireEnv('TRANSLATE_API_KEY'), model: process.env.TRANSLATE_MODEL }
  }
  return { baseUrl: requireEnv('LLM_BASE_URL'), apiKey: requireEnv('LLM_API_KEY'), model: requireEnv('LLM_MODEL') }
}

/** sidecar 输出路径:有扩展名→替换;无扩展名/以点结尾→追加(绝不原样返回 videoPath 本身——
 *  replace 无匹配时返回输入,writeFileSync 会把视频源文件截断覆盖成字幕文本,成功路径上的
 *  数据丢失,与 fail-closed 北极星正面冲突)。 */
export function sidecarPathFor(videoPath: string): string {
  const stem = videoPath.replace(/\.[^.]+$/, '')
  return stem === videoPath ? `${videoPath}.zh-Hans.srt` : `${stem}.zh-Hans.srt`
}

/** 翻译批超时:默认 300s,TRANSLATE_TIMEOUT_MS 可配。真机逼出(F1 验收):34-cue 大批经慢端点
 *  120s(LLM_TIMEOUT_MS)必然超时 → 单批抛错整档 false-held;翻译是重活,不与快路径共享 120s。 */
export function translateTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const v = Number(env.TRANSLATE_TIMEOUT_MS)
  return Number.isFinite(v) && v > 0 ? v : 300_000
}

/** daemon 自动翻译的配置门(与上面手动 CLI 的区别):**只认显式 TRANSLATE_* 三件套,绝不回退
 *  LLM_***——自动路径拿 LLM_MODEL(mimo,太弱且非用户对本功能的 opt-in)烧配额是事故。三件套
 *  不全 → null = 功能休眠(daemon 不注入派活钩子,translate 任务也拒跑),同 SUBHD_ENABLED 模式。 */
export function tryAutoTranslateCfg(env: NodeJS.ProcessEnv = process.env): { baseUrl: string; apiKey: string; model: string } | null {
  const { TRANSLATE_MODEL, TRANSLATE_BASE_URL, TRANSLATE_API_KEY } = env
  if (!TRANSLATE_MODEL || !TRANSLATE_BASE_URL || !TRANSLATE_API_KEY) return null
  return { baseUrl: TRANSLATE_BASE_URL, apiKey: TRANSLATE_API_KEY, model: TRANSLATE_MODEL }
}

/** 组装 translateItem 的真实 I/O deps(probe/extract/LM/critic/sidecar 读写/同剧上下文)。
 *  手动 CLI(cmdTranslateItem)与 daemon 的 translate worker(cli/index.ts 路由分支)共用,
 *  防两处组装漂移。critic 默认开(TRANSLATE_CRITIC=off 关);TRANSLATE_CRITIC_MODEL 单指定判官。
 *  F1:fetchSourceSub 可选注入(makeRealFetchSourceSub 组装,需要 db+adapters,由调用方各自
 *  提供——daemon 分支必接;手动 CLI 在库文件存在时接)。未注入=行为不变(零合格轨→no-embedded)。 */
export function makeTranslateItemDeps(
  cfg: { baseUrl: string; apiKey: string; model: string },
  fetchSourceSub?: TranslateItemDeps['fetchSourceSub'],
  /** F2:可选 locate,用于把 origin_lang 喂进 prompt 源语言名;缺省=英文。 */
  locateOriginLang?: (videoPath: string) => string | null,
): TranslateItemDeps {
  const model = makeModel(cfg)
  const lmTimeout = translateTimeoutMs()
  const criticOn = (process.env.TRANSLATE_CRITIC ?? 'on').toLowerCase() !== 'off'
  // 审计🟡:critic 曾裸继承 LLM_TIMEOUT_MS(120s)——全片对照 payload 远大于单批,慢端点必超时,
  // 再被优雅降级静默跳过("过了"与"没审"日志无别)。与翻译 LM 同门:TRANSLATE_TIMEOUT_MS 可配。
  const critic: TranslationCritic | undefined = criticOn
    ? makeTranslationCritic(
        process.env.TRANSLATE_CRITIC_MODEL ? makeModel({ ...cfg, model: process.env.TRANSLATE_CRITIC_MODEL }) : model,
        { timeoutMs: lmTimeout },
      )
    : undefined
  return {
    probe: (v) => probeEmbeddedSubtitles(v),
    extract: (v, i) => extractEmbeddedSubtitle(v, i),
    lm: makeTranslationLM(model, { timeoutMs: lmTimeout }),
    critic,
    fetchSourceSub,
    readExistingChineseSidecar: (v) => findExternalSidecar(v, CHINESE_TAGS, existsSync)?.path ?? null,
    gatherContext: async (v) => gatherSeriesContext(v, locateOriginLang?.(v) ?? null),
    videoDurationSec: (v) => probeDurationSec(v),
    writeSidecar: (v, content) => writeSidecarAtomic(v, content),
  }
}

/** 原子 sidecar 写(tmp+rename):SIGKILL 落在裸 writeFileSync 中途会留下截断的 .zh-Hans.srt,
 *  下一轮 already-covered 误判 → 该条目永久不再重译且坏字幕直接进播放器。 */
function writeSidecarAtomic(videoPath: string, content: string): string {
  const out = sidecarPathFor(videoPath)
  const tmp = `${out}.tmp`
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, out)
  return out
}

/** 读同目录既有中文 sidecar 当术语锚(库内直读、零网络;最多 3 份各截断 3000 字)。 */
export function readSeriesTargetSubs(videoPath: string): string | null {
  const dir = dirname(videoPath)
  const self = basename(videoPath)
  const subs: string[] = []
  try {
    for (const f of readdirSync(dir)) {
      if (f === self || !/\.(srt|ass|ssa)$/i.test(f)) continue
      const lower = f.toLowerCase()
      if (!CHINESE_TAGS.some((t) => lower.includes(`.${t.toLowerCase()}.`))) continue
      try { subs.push(`### ${f}\n${readFileSync(join(dir, f), 'utf8').slice(0, 3000)}`) } catch { /* skip */ }
      if (subs.length >= 3) break
    }
  } catch { /* 目录读失败 → 无上下文 */ }
  return subs.length ? subs.join('\n\n') : null
}

/** 组装 translate workspace agent 的真实 I/O deps。与 makeTranslateItemDeps 同门的 cfg/超时
 *  语义;install 只在 agent 通过闸后经 merge 产物触发(工具面保证)。 */
export function makeTranslateAgentDeps(
  cfg: { baseUrl: string; apiKey: string; model: string },
  fetchSourceSub?: import('../translate/workspace/resolveSource.js').ResolveSourceDeps['fetchSourceSub'],
  opts: {
    fetchTmdbContext?: TranslateWorkerDeps['fetchTmdbContext']
    fetchSeriesTargetSubs?: TranslateWorkerDeps['fetchSeriesTargetSubs']
    db?: import('../v2/db.js').ScoutDb
    /** critic 开关:默认开(TRANSLATE_CRITIC=off 关);显式 false 强制关。 */
    critic?: boolean
  } = {},
): TranslateWorkerDeps {
  const model = makeModel(cfg)
  const glossaryStore = opts.db
    ? (() => {
        const repo = new GlossaryRepo(opts.db)
        return {
          load: (k: string) => repo.load(k),
          save: (k: string, t: import('../translate/workspace/types.js').GlossaryTerm[], at: number) => repo.save(k, t, at),
        }
      })()
    : undefined
  const criticOn = opts.critic ?? (process.env.TRANSLATE_CRITIC ?? 'on').toLowerCase() !== 'off'
  const critic: TranslateWorkerDeps['critic'] = criticOn
    ? (() => {
        const criticModel = process.env.TRANSLATE_CRITIC_MODEL ? makeModel({ ...cfg, model: process.env.TRANSLATE_CRITIC_MODEL }) : model
        const impl = makeTranslationCritic(criticModel, { timeoutMs: translateTimeoutMs() })
        return {
          evaluate: async (src: string[], tgt: string[], glossary: Array<{ en: string; zh: string }>) => {
            const mk = (text: string, i: number) => ({ index: String(i + 1), timing: '00:00:00,000 --> 00:00:01,000', text: text.split('\n') })
            const verdict = await impl.review(src.map(mk), tgt.map(mk), glossary)
            if (verdict.ok) return 'PASS: no major issues found.'
            return [
              'FAIL: major issues detected:',
              ...verdict.issues.map((i) => `- [${i.severity}] cue ${i.cueIndex} (${i.kind}): ${i.note}`),
            ].join('\n')
          },
        }
      })()
    : undefined
  return {
    model,
    resolveDeps: {
      probe: (v) => probeEmbeddedSubtitles(v),
      extract: (v, i) => extractEmbeddedSubtitle(v, i),
      fetchSourceSub,
    },
    install: (v, content) => writeSidecarAtomic(v, content),
    videoDurationSec: (v) => probeDurationSec(v),
    readExistingChineseSidecar: (v) => findExternalSidecar(v, CHINESE_TAGS, existsSync)?.path ?? null,
    glossaryStore,
    critic,
    fetchTmdbContext: opts.fetchTmdbContext,
    fetchSeriesTargetSubs: opts.fetchSeriesTargetSubs ?? ((task: TranslateTask) => Promise.resolve(readSeriesTargetSubs(task.videoPath))),
    // timeoutMs 不再此处覆盖(E02 pro 实证:900s 砍死长任务)——走 translateWorker 的 4h 默认;
    // translateTimeoutMs 只管 legacy 管道的单批 LM 调用。
  }
}

/** db 定位任务的 itemId/origin_lang/tmdb 身份(供 agent 任务构造与 TMDB 富化)。 */
export function locateTranslateIdentity(
  db: import('../v2/db.js').ScoutDb,
  videoPath: string,
): { itemId: string; title: string; originLang: string | null; tmdbId?: string; mediaType?: 'tv' | 'movie' } | null {
  const ep = db.prepare(
    `SELECT e.id AS itemId, e.series_id AS seriesId, s.name AS title, s.origin_lang AS originLang
       FROM episodes e JOIN series s ON s.id = e.series_id WHERE e.path = ?`,
  ).get(videoPath) as { itemId: string; seriesId: string; title: string; originLang: string | null } | undefined
  if (ep) {
    const tmdbId = ep.seriesId.startsWith('tmdb:') ? ep.seriesId.slice(5) : undefined
    return { itemId: ep.itemId, title: ep.title, originLang: ep.originLang, tmdbId, mediaType: 'tv' }
  }
  const mv = db.prepare('SELECT id, name, origin_lang FROM movies WHERE path = ?')
    .get(videoPath) as { id: string; name: string; origin_lang: string | null } | undefined
  if (mv) {
    const tmdbId = mv.id.startsWith('tmdb:') ? mv.id.slice(5) : undefined
    return { itemId: mv.id, title: mv.name, originLang: mv.origin_lang, tmdbId, mediaType: 'movie' }
  }
  return null
}

export type DaemonTranslateRunItemResult = {
  status: import('../translate/translateItem.js').TranslateItemResult['status'] | 'probe-failed'
  reason?: string
  sourceRef?: string
  sidecarPath?: string
  llmCalls?: number
}

/** P3:daemon translate 分支的 runItem——库内定位身份 → workspace agent。与手动 CLI 共用
 *  makeTranslateAgentDeps(同一份 cfg/glossaryStore/critic),防两处组装漂移。
 *  agentRunner 可注入(测试);生产默认 makeTranslateWorker(makeTranslateAgentDeps(...))。 */
export function makeDaemonTranslateRunItem(opts: {
  db: import('../v2/db.js').ScoutDb
  cfg: { baseUrl: string; apiKey: string; model: string }
  fetchSourceSub?: import('../translate/workspace/resolveSource.js').ResolveSourceDeps['fetchSourceSub']
  tmdb?: import('../adapters/providers/tmdb.js').TmdbClient | null
  roots: () => string[]
  agentRunner?: ReturnType<typeof makeTranslateWorker>
}): (videoPath: string) => Promise<DaemonTranslateRunItemResult> {
  return async (videoPath) => {
    const identity = locateTranslateIdentity(opts.db, videoPath)
    if (!identity) {
      return {
        status: 'no-source' as const,
        reason: `库内定位失败(${videoPath} 不在 episodes/movies)——agent 单跳选源需要 origin_lang`,
        sourceRef: undefined, sidecarPath: undefined, llmCalls: 0,
      }
    }
    let fetchTmdbContext: TranslateWorkerDeps['fetchTmdbContext']
    if (opts.tmdb && identity.tmdbId && identity.mediaType) {
      const tmdb = opts.tmdb
      const tmdbId = identity.tmdbId
      const mediaType = identity.mediaType
      fetchTmdbContext = async () => {
        try {
          const d = await tmdb.getDetails(mediaType, tmdbId)
          if (!d) return null
          return [`# ${identity.title}`, d.year ? `year: ${d.year}` : null, d.overview ?? ''].filter(Boolean).join('\n')
        } catch {
          return null
        }
      }
    }
    const runner = opts.agentRunner ?? makeTranslateWorker(
      makeTranslateAgentDeps(opts.cfg, opts.fetchSourceSub, { db: opts.db, fetchTmdbContext }),
    )
    const videoDir = dirname(videoPath)
    const report = await runner({
      jobId: `daemon-${Date.now()}`,
      videoPath,
      itemId: identity.itemId,
      originLang: identity.originLang,
      title: identity.title,
      mediaRoot: videoDir,
      stagingRoot: containingRoot(videoDir, opts.roots()) ?? videoDir,
    })
    // agent 报告的 nullable(zod) → runTranslateWorkerTask 的 optional 字段口径。
    return {
      ...report,
      reason: report.reason ?? undefined,
      sourceRef: report.sourceRef ?? undefined,
      sidecarPath: report.sidecarPath ?? undefined,
    }
  }
}

export async function cmdTranslateItem(videoPath: string): Promise<void> {
  if (!existsSync(videoPath)) {
    console.error(`文件不存在: ${videoPath}`)
    process.exit(2)
  }
  const cfg = translateLlmCfg()
  const legacyFlag = process.argv.includes('--legacy')
  const agentOn = !legacyFlag && (process.env.TRANSLATE_AGENT ?? 'on').toLowerCase() !== 'off'
  const criticOn = (process.env.TRANSLATE_CRITIC ?? 'on').toLowerCase() !== 'off'
  console.log(`[translate-item] 模型=${cfg.model} critic=${criticOn ? '开' : '关'} 路径=${agentOn ? 'workspace-agent' : 'legacy'}`)

  // F1:手动 CLI 也接同一 fetchSourceSub(与 daemon 分支共用 makeRealFetchSourceSub 组装,防漂移)。
  // 需要库定位(origin_lang/imdb),故只在 scout.db 已存在时接线——库还没建(从没跑过 watch)时
  // 不为一次手动翻译凭空创建空库(openDb 会落盘建表),此时 fetch 腿关闭,行为同 F1 前(no-embedded)。
  // db/adapters 组装失败(如 ZIMUKU_ENABLED=true 缺 LLM_*)同样降级关腿,不拦手动翻译主线。
  let fetchSourceSub: TranslateItemDeps['fetchSourceSub']
  let db: import('../v2/db.js').ScoutDb | undefined
  const cacheRoot = process.env.SUBTITLE_SCOUT_CACHE_DIR || join(homedir(), '.subtitle-scout', 'cache')
  const dbPath = join(cacheRoot, 'scout.db')
  let locateOriginLang: ((videoPath: string) => string | null) | undefined
  if (existsSync(dbPath)) {
    try {
      const { openDb } = await import('../v2/db.js')
      const { makeDbLocate } = await import('./fetchSourceSub.js')
      db = openDb(dbPath)
      const adapters = await buildAdapters()
      fetchSourceSub = makeRealFetchSourceSub(db, adapters)
      const locate = makeDbLocate(db)
      locateOriginLang = (p) => locate(p)?.originLang ?? null
    } catch (e) {
      console.log(`[translate-item] 源语言外挂搜索腿未启用(${e instanceof Error ? e.message : String(e)}),仅走内嵌轨`)
    }
  } else {
    console.log(`[translate-item] 未找到库 ${dbPath}(先跑一次 watch 建库),源语言外挂搜索腿未启用,仅走内嵌轨`)
  }

  // Workspace agent 主路径(P1):需要库定位拿到 origin_lang/itemId(单跳选源依赖);
  // 定位不到(库外文件)时诚实回退 legacy,不让 agent 在零身份下乱猜源语言。
  if (agentOn && db) {
    const identity = locateTranslateIdentity(db, videoPath)
    if (identity) {
      console.log(`[translate-item] 开始: ${videoPath} (workspace-agent)`)
      let exitCode = 1
      try {
        // TMDB 富化(可选):getDetails overview;无 key/失败 → 空文档,不拦主线。
        let fetchTmdbContext: TranslateWorkerDeps['fetchTmdbContext']
        if (process.env.TMDB_API_KEY && identity.tmdbId && identity.mediaType) {
          const { TmdbClient } = await import('../adapters/providers/tmdb.js')
          const tmdb = new TmdbClient({
            apiKey: process.env.TMDB_API_KEY,
            baseUrl: process.env.TMDB_BASE_URL,
            proxyUrl: process.env.TMDB_PROXY_URL,
          })
          const tmdbId = identity.tmdbId
          const mediaType = identity.mediaType
          fetchTmdbContext = async () => {
            try {
              const d = await tmdb.getDetails(mediaType, tmdbId)
              if (!d) return null
              return [`# ${identity.title}`, d.year ? `year: ${d.year}` : null, d.overview ?? ''].filter(Boolean).join('\n')
            } catch {
              return null
            }
          }
        }
        // stagingRoot:配置根优先(库 settings roots;退化 MEDIA_ROOTS env;再退化视频目录)。
        let roots: string[] = []
        try {
          const { SettingsRepo } = await import('../v2/settingsRepo.js')
          roots = new SettingsRepo(db).listRoots().map((r) => r.path)
        } catch { /* settings 缺席 → env */ }
        if (roots.length === 0 && process.env.MEDIA_ROOTS) {
          roots = process.env.MEDIA_ROOTS.split(':').map((s) => s.trim()).filter(Boolean)
        }
        const videoDir = dirname(videoPath)
        const stagingRoot = containingRoot(videoDir, roots) ?? videoDir
        const deps = makeTranslateAgentDeps(cfg, fetchSourceSub, { db, fetchTmdbContext })
        const run = makeTranslateWorker(deps)
        const report = await run({
          jobId: `cli-${Date.now()}`,
          videoPath,
          itemId: identity.itemId,
          originLang: identity.originLang,
          title: identity.title,
          mediaRoot: videoDir,
          stagingRoot,
        })
        const tail = (report.sidecarPath ? ` → ${report.sidecarPath}` : '') +
          (report.reason ? ` (${report.reason})` : '') +
          (report.sourceRef ? ` [源: ${report.sourceRef}]` : '')
        console.log(`[translate-item] 结果: ${report.status}${tail}`)
        exitCode = report.status === 'installed' ? 0 : 1
      } finally {
        db?.close()
      }
      process.exit(exitCode)
    }
    console.log(`[translate-item] 库内定位失败(无 origin_lang/itemId),回退 legacy 管道`)
  } else if (agentOn && !db) {
    console.log(`[translate-item] 无库身份(workspace-agent 需要 origin_lang 单跳选源),回退 legacy 管道`)
  }

  const deps = makeTranslateItemDeps(cfg, fetchSourceSub, locateOriginLang)
  console.log(`[translate-item] 开始: ${videoPath}`)
  let r: Awaited<ReturnType<typeof translateItem>>
  try {
    r = await translateItem(videoPath, deps)
  } finally {
    db?.close()
  }
  const tail = (r.sidecarPath ? ` → ${r.sidecarPath}` : '') + (r.reason ? ` (${r.reason})` : '') + (r.sourceRef ? ` [源: ${r.sourceRef}]` : '')
  console.log(`[translate-item] 结果: ${r.status}${tail}`)
  if (r.gate) {
    console.log(`[translate-item] 闸: verdict=${r.gate.verdict} 术语符合=${r.gate.glossary.conformance}% (${r.gate.glossary.hits}/${r.gate.glossary.checks}) cues=${r.gate.cueCount.candidate} 硬违规=${r.gate.hardViolations.length}`)
    for (const h of r.gate.hardViolations) console.log(`  ✗ ${h}`)
  }
  // 生产实测(Astronaut):sidecar 落盘后进程迟迟不退(16min+,单线程 sleep)。根因未完全定位
  // (疑 fetch/undici 或 docker exec 管道),故这里把 db 关闭挪进 finally 兜底,并在打印结果后
  // 立即 exit 收尾——CLI 是一次性进程,exit 即权威收尾;daemon 路径不走这里(常驻,不 exit)。
  process.exit(r.status === 'installed' ? 0 : 1)
}
