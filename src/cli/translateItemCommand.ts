// src/cli/translateItemCommand.ts：CLI translate-item 命令——审计 Wave 3 D 波后仅保留
// workspace agent 路径(legacy 管道已退役)。库外文件诚实拒绝(agent 需 origin_lang 单跳选源)。
import { existsSync, writeFileSync, renameSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, basename, join } from 'node:path'
import { homedir } from 'node:os'
import { makeModel } from '../agent/llm.js'
import { probeEmbeddedSubtitles, probeDurationSec } from '../files/streamProbe.js'
import { extractEmbeddedSubtitle } from '../files/extractEmbeddedSub.js'
import { findExternalSidecar } from '../files/sidecar.js'
import { makeTranslationCritic } from '../translate/translateCritic.js'
import { makeTranslateWorker, type TranslateWorkerDeps } from '../agent/translateWorker.js'
import type { TranslateTask } from '../agent/translateWorker.schemas.js'
import { containingRoot } from '../core/mediaContext.js'
import { GlossaryRepo } from '../v2/glossaryRepo.js'
import { makeRealFetchSourceSub } from './fetchSourceSub.js'
import { buildAdapters } from '../adapters/buildAdapters.js'
import { makeAdapterConfigResolver, envOnlyAdapterConfig, SECRET_NAMES, type AdapterConfigResolver } from '../v2/secrets.js'
import { SettingsRepo } from '../v2/settingsRepo.js'
import { CHINESE_SIDECAR_TAGS } from '../agent/languages.js'
// C20：itemId 的唯一构造入口 + work_id 的唯一解析入口（自有 id 空间，不在本文件另写解析）。
import { translateItemId, translateJobId, workIdFromTranslateItemId, tmdbIdFromOwnId } from '../v2/ownIds.js'

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

/** E 翻译用的 LLM 配置。专用模型（TRANSLATE_* 三凭证齐全，来源无关：env 非空 > db > none）
 *  → 走 TRANSLATE_* 三件套(让 E 用强模型,与 captcha 用的 LLM_MODEL=mimo 分开——真机实测 mimo
 *  对翻译太弱);否则回退 LLM_*。spec §8.2：用户拍板推翻 env-only 限制，专用凭证可入库可编辑。 */
function translateLlmCfg(secrets: AdapterConfigResolver): { baseUrl: string; apiKey: string; model: string } {
  const tBase = secrets.secret('TRANSLATE_BASE_URL').value
  const tKey = secrets.secret('TRANSLATE_API_KEY').value
  const tModel = secrets.secret('TRANSLATE_MODEL').value
  if (tBase && tKey && tModel) {
    return { baseUrl: tBase, apiKey: tKey, model: tModel }
  }
  // spec A §4.3：来源无关化——env 或库都行；缺值仍报错，语义不变。
  const baseUrl = secrets.secret('LLM_BASE_URL').value
  const apiKey = secrets.secret('LLM_API_KEY').value
  const model = secrets.secret('LLM_MODEL').value
  if (!baseUrl || !apiKey || !model) {
    throw new Error('LLM_BASE_URL / LLM_API_KEY / LLM_MODEL 未配置（env 或 dashboard setup wizard 均可）')
  }
  return { baseUrl, apiKey, model }
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

/** daemon 自动翻译的配置门(与上面手动 CLI 的区别):**只认 TRANSLATE_* 三件套齐全,绝不回退
 *  LLM_***——自动路径拿 LLM_MODEL(mimo,太弱且非用户对本功能的 opt-in)烧配额是事故。三件套
 *  不全 → null = 功能休眠(daemon 不注入派活钩子,translate 任务也拒跑),同 SUBHD_ENABLED 模式。
 *  spec §8.2：来源无关化——env 非空 > db > none,UI 存库的专用凭证对 daemon 可见。 */
export function tryAutoTranslateCfg(cfg: AdapterConfigResolver): { baseUrl: string; apiKey: string; model: string } | null {
  const baseUrl = cfg.secret('TRANSLATE_BASE_URL').value
  const apiKey = cfg.secret('TRANSLATE_API_KEY').value
  const model = cfg.secret('TRANSLATE_MODEL').value
  if (!baseUrl || !apiKey || !model) return null
  return { baseUrl, apiKey, model }
}

/** 组装 translateItem 的真实 I/O deps(probe/extract/LM/critic/sidecar 读写/同剧上下文)。
 *  手动 CLI(cmdTranslateItem)与 daemon 的 translate worker(cli/index.ts 路由分支)共用,
 *  防两处组装漂移。critic 默认开(TRANSLATE_CRITIC=off 关);TRANSLATE_CRITIC_MODEL 单指定判官。
 *  F1:fetchSourceSub 可选注入(makeRealFetchSourceSub 组装,需要 db+adapters,由调用方各自
 *  提供——daemon 分支必接;手动 CLI 在库文件存在时接)。未注入=行为不变(零合格轨→no-embedded)。 */

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
      if (!CHINESE_SIDECAR_TAGS.some((t) => lower.includes(`.${t.toLowerCase()}.`))) continue
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
    readExistingChineseSidecar: (v) => findExternalSidecar(v, CHINESE_SIDECAR_TAGS, existsSync)?.path ?? null,
    glossaryStore,
    critic,
    fetchTmdbContext: opts.fetchTmdbContext,
    fetchSeriesTargetSubs: opts.fetchSeriesTargetSubs ?? ((task: TranslateTask) => Promise.resolve(readSeriesTargetSubs(task.videoPath))),
    // timeoutMs 不再此处覆盖(E02 pro 实证:900s 砍死长任务)——走 translateWorker 的 4h 默认;
    // translateTimeoutMs 只管 legacy 管道的单批 LM 调用。
  }
}

/** db 定位任务的 itemId/origin_lang/tmdb 身份（供 agent 任务构造与 TMDB 富化）。
 *
 *  ── 为什么读 files/works 而不是 episodes/movies（C4，与 4-2 对 fetchSourceSub 的处置同源）──
 *  4-2 修了抓源腿的 locate，**漏了这一个**。而这里是生产路径上 itemId 的真实构造点：
 *  daemonV2 的翻译循环 → makeDaemonTranslateRunItem → 本函数 → agent task.itemId →
 *  translateWorker.tools 的 seriesKeyOf（剧级术语表）。新架构下 episodes/movies 是空表，
 *  不改的后果是**翻译流刚接回来就把全库待翻文件判成"无源停牌"**：每个文件都命中
 *  `identity === null` → runItem 返回 no-source → 按 §5 映射写 unsolvable。
 *  而 no-source 是一个**诚实终态**，日志上看不出这是 bug，只能看到"翻译判定全库都没源"。
 *
 *  ── 为什么 itemId 必须调 `translateItemId` 而不是在这里拼（C20）──
 *  形态是 `<work_id>/<sha1(path)前12>`，唯一构造入口在 ownIds.ts。手拼一份同形字符串今天
 *  也能过测试，但那就有了两份形态定义；漂移的那天（比如有人图省事改成拼 basename）
 *  glossary key 会退化成每文件一个 → 同剧第 2 集拿不到第 1 集冻结的术语表 → 人名地名每集
 *  换译法（实案：同一模型同剧两 run 分别选出"东国 / 奥斯塔尼亚"）。纯质量漂移，无断言会红。
 *
 *  ── 不 UNION 旧表兜底（照 4-2 的既有裁决）──
 *  兜底看似更稳，实则让新架构的断裂永久隐形：只要旧表还有存量行，生产与测试都会表现得像
 *  接通了，而真实数据在 files/works 里的那批文件依然拿不到身份。INNER JOIN works 同理——
 *  未识别行（work_id IS NULL）必须返回 null：没有 work_id 就构造不出合法 itemId，
 *  塞一个占位值就是把 C20 的伤害引进来。 */
export function locateTranslateIdentity(
  db: import('../v2/db.js').ScoutDb,
  videoPath: string,
): { itemId: string; title: string; originLang: string | null; tmdbId?: string; mediaType?: 'tv' | 'movie' } | null {
  const row = db.prepare(
    `SELECT f.work_id AS workId, w.title AS title, w.origin_lang AS originLang, w.media_type AS mediaType
       FROM files f JOIN works w ON f.work_id = w.id
      WHERE f.path = ?`,
  ).get(videoPath) as { workId: string; title: string; originLang: string | null; mediaType: string } | undefined
  if (!row) return null
  // work_id 形如 'tmdb:123'，复用自有 id 空间的解析入口（不在这里 slice(5)——那是第二份解析）。
  const tmdbId = tmdbIdFromOwnId(row.workId) ?? undefined
  return {
    itemId: translateItemId(row.workId, videoPath),
    title: row.title,
    originLang: row.originLang,
    tmdbId,
    // works.media_type 的值域是 'tv' | 'movie'（识别时写入）；其它值一律不传，
    // 让 TMDB 富化那一支自然跳过，而不是硬转类型骗过编译器。
    mediaType: row.mediaType === 'tv' || row.mediaType === 'movie' ? row.mediaType : undefined,
  }
}

export type DaemonTranslateRunItemResult = {
  status: 'installed' | 'held' | 'no-source' | 'extract-failed' | 'no-embedded' | 'already-covered' | 'write-failed' | 'probe-failed'
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
      // 🔴 GC 炸弹修复（2026-08-08 live test 实测：工作台残留 312KB / CURRENT-STATE §八）。
      // 旧值 `daemon-${Date.now()}` 让循环层无法预知目录名 → 没法登记进 gcStaging 的 in-flight
      // 集合（字幕流靠 subtitleJobId 做到了，C34），且每次重试堆一个新目录、成功后没人回收。
      // 这里与 daemonV2 的 in-flight 登记必须调**同一个** translateJobId（两处手写必漂移，
      // 漂了 GC 保护就静默失效）；派生源用 identity 而不是 candidate，是因为 runItem 的签名只
      // 收 videoPath——identity.itemId 与 candidate.itemId 同源这件事已由既有红线用例钉住。
      jobId: translateJobId(workIdFromTranslateItemId(identity.itemId), videoPath),
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
  const cacheRoot = process.env.SUBTITLE_SCOUT_CACHE_DIR || join(homedir(), '.subtitle-scout', 'cache')
  const dbPath = join(cacheRoot, 'scout.db')
  // 启动面（spec A §4.3）：密钥可能只在库里。开一条短命连接快照 secret:* 后立刻 close——
  // 下方 :272 区 openDb 拿到的那个 db 要活到命令结束，两者互不干扰。
  const secretSnap = new Map<string, string | null>()
  if (existsSync(dbPath)) {
    try {
      const { openDb } = await import('../v2/db.js')
      const snapDb = openDb(dbPath)
      try {
        const repo = new SettingsRepo(snapDb)
        for (const name of SECRET_NAMES) secretSnap.set(`secret:${name}`, repo.get(`secret:${name}`))
      } finally {
        snapDb.close()
      }
    } catch {
      // 库打不开就退化成 env-only；:272 区既有的 existsSync 分支照原样报它该报的错。
    }
  }
  const secrets = secretSnap.size > 0
    ? makeAdapterConfigResolver(process.env, (k) => secretSnap.get(k) ?? null)
    : envOnlyAdapterConfig(process.env)
  const cfg = translateLlmCfg(secrets)
  const criticOn = (process.env.TRANSLATE_CRITIC ?? 'on').toLowerCase() !== 'off'
  console.log(`[translate-item] 模型=${cfg.model} critic=${criticOn ? '开' : '关'} 路径=workspace-agent`)

  // F1:手动 CLI 也接同一 fetchSourceSub(与 daemon 分支共用 makeRealFetchSourceSub 组装,防漂移)。
  // 需要库定位(origin_lang/imdb),故只在 scout.db 已存在时接线——库还没建(从没跑过 watch)时
  // 不为一次手动翻译凭空创建空库(openDb 会落盘建表),此时 fetch 腿关闭,行为同 F1 前(no-embedded)。
  // db/adapters 组装失败(如 ZIMUKU_ENABLED=true 缺 LLM_*)同样降级关腿,不拦手动翻译主线。
  let fetchSourceSub: import('../translate/workspace/resolveSource.js').ResolveSourceDeps['fetchSourceSub']
  let db: import('../v2/db.js').ScoutDb | undefined
  let locateOriginLang: ((videoPath: string) => string | null) | undefined
  if (existsSync(dbPath)) {
    try {
      const { openDb } = await import('../v2/db.js')
      const { makeDbLocate } = await import('./fetchSourceSub.js')
      db = openDb(dbPath)
      const adapters = await buildAdapters(() => {}, secrets, (m) => console.log('[translate-item] ' + m))
      fetchSourceSub = makeRealFetchSourceSub(db, adapters)
      const locate = makeDbLocate(db)
      locateOriginLang = (p) => locate(p)?.originLang ?? null
    } catch (e) {
      console.log(`[translate-item] 源语言外挂搜索腿未启用(${e instanceof Error ? e.message : String(e)}),仅走内嵌轨`)
    }
  } else {
    console.error(`[translate-item] 未找到库 ${dbPath}(先跑一次 watch 建库)——workspace-agent 需要库定位,拒绝执行`)
    console.error(`[translate-item] 解决: 先跑一次 watch 建库,或将视频放入已扫描的媒体根`)
    process.exit(1)
  }

  // Workspace agent 主路径(P1):需要库定位拿到 origin_lang/itemId(单跳选源依赖);
  // 定位不到(库外文件)时诚实拒绝,不让 agent 在零身份下乱猜源语言。
  if (db) {
    const identity = locateTranslateIdentity(db, videoPath)
    if (identity) {
      console.log(`[translate-item] 开始: ${videoPath} (workspace-agent)`)
      let exitCode = 1
      try {
        // TMDB 富化(可选):getDetails overview;无 key/失败 → 空文档,不拦主线。
        let fetchTmdbContext: TranslateWorkerDeps['fetchTmdbContext']
        const tmdbKey = secrets.secret('TMDB_API_KEY').value
        if (tmdbKey && identity.tmdbId && identity.mediaType) {
          const { TmdbClient } = await import('../adapters/providers/tmdb.js')
          const tmdb = new TmdbClient({
            apiKey: tmdbKey,
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
          // 与 cli/index.ts:634 一致,用逗号分隔(不是冒号——多根容器路径含冒号是合法的,如
          // /media/movies:/data/films,只有逗号才是无歧义的分隔符)
          roots = process.env.MEDIA_ROOTS.split(',').map((s) => s.trim()).filter(Boolean)
        }
        const videoDir = dirname(videoPath)
        const stagingRoot = containingRoot(videoDir, roots) ?? videoDir
        const deps = makeTranslateAgentDeps(cfg, fetchSourceSub, { db, fetchTmdbContext })
        const run = makeTranslateWorker(deps)
        const report = await run({
          // 与 daemon 分支同一个构造入口（GC 炸弹修复，见上方 :276 区的论证）。手动 CLI 同样
          // 受益于稳定身份：反复手动重翻同一个文件不再每次堆一个新工作台；且 daemon 的
          // boot GC 与它算出的 jobId 一致——不过手动 CLI 是**另一个进程**，daemon 的 in-flight
          // 集合是进程内的 Set，跨进程保护仍只有 gcOrphans 的 mtime 活性窗口（R6-9/R7-1）。
          // 这一条**不因本次修复而改善**，如实记在这里，不假装跨进程租约已经存在。
          jobId: translateJobId(workIdFromTranslateItemId(identity.itemId), videoPath),
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
    } else {
      console.error(`[translate-item] 库不存在或定位失败 → workspace-agent 无法工作,拒绝执行`)
      console.error(`[translate-item] 解决: 先跑一次 watch 建库,或将视频放入已扫描的媒体根`)
      db.close() // 与成功分支的 finally close 对齐——exit 前关连接
      process.exit(1)
    }
  }
}