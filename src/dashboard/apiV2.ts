// src/dashboard/apiV2.ts
// v2 媒体库只读数据层：纯函数收 ScoutDb 返回 DTO（对照 api.ts 风格）。海报直接暴露 TMDB
// poster_path，前端自行拼 CDN URL（image.tmdb.org，公开、免 key）——不再经服务端代理。
import { existsSync, readdirSync, statSync } from 'node:fs'
import { toContainerPath } from '../files/hostrootPath.js'
import { z } from 'zod'
import type { ScoutDb } from '../v2/db.js'
// `LibraryRepo`（值）随 buildWorkflowPending 的 series/movies/parked 三字段一并移除：
// 它在本文件唯一的用处是那三条查询（missingBySeason/missingMovies/listParkedPaths）。
// 本文件现在剩下的都是直接写 SQL 的纯读聚合，不需要 repo 层。
import { SettingsRepo, findOverlappingRoot } from '../v2/settingsRepo.js'
// `traceBus`（值）随 buildWorkflowWorkers 一并移除：它唯一的用处是 running 行的直播补拉
// （peek/peekPrefix）。本文件现在只剩**已落库快照**的解析（buildRunTrace 读 runs.trace_json），
// 那条路径只要类型。
import { type TraceEvent } from '../core/traceBus.js'
import { parseTargetLanguages } from '../cli/targetLanguages.js'
// R-F15 缺口③：换目标语言 → 全库重判（清判决列 + 按 sidecar_langs 重导 sub_status）。
// 实现放在 v2/ 而不是这里：它是库层语义（且要能被 daemon 侧测试直接调），dashboard 只是触发者。
import { retargetForLanguageChange } from '../v2/retarget.js'
import { judgePendingFiles } from '../v2/judgePending.js'

// ---- 2026-08-13 死代码清理：本文件删掉的 6 个未消费 import ----
//
// 删除的是 `dirname`、`ItemFileCoverage`、`canonicalEpisodes`、`INGEST_ORCHESTRATE_SERIES_ID`、
// `langOf`、`resolveTargetLanguages`（后者只窄化为仍在用的 `parseTargetLanguages`）。
// 逐条成因，写在这里是因为它们不是同一种残留：
//
// · `JobsRepo` + `WorkerTaskUpsertOutcome`（整行 import 全未消费）：redispatch 的实现已迁去
//   `v2/triageOps.ts`，本文件第 1049 行只剩一句 `export { redispatch, type RedispatchResult }
//   from '../v2/triageOps.js'` 的转发——转发不需要这两个类型，它们随实现一起走了。
//
// · `dirname` / `ItemFileCoverage` / `canonicalEpisodes`：2026-08-12「无活 UI 端点」裁决
//   删掉旧库三族 builder（见下方那段注释）时漏摘的 import。三个符号本身都还活着
//   （canonicalEpisodes 由 daemonV2 boot pass + tmdbCatalog 消费，ItemFileCoverage 由
//   libraryRepo.itemFileCoverage 产出），只是**本文件**不再引用。
//
// · `INGEST_ORCHESTRATE_SERIES_ID`：曾被 import 进来"只为让文档注释引用真实常量而不是抄
//   一份陈旧字符串副本"。但那条注释后来随旧库三族一并删除，import 留了下来——一个
//   为注释服务的 import 在注释消失后就是纯残留。今天全文件零处提及该常量的语义。
//
// · `langOf` + `resolveTargetLanguages`：**这两条是"接线断了"的化石，不是普通残留。**
//   原注释写的是「Plan B Task 1: originLang + nativeAudio 计算依赖」。实测：`nativeAudio`
//   这个标识符在**全仓（src + web/src）只出现在那一行注释里**——没有 DTO 字段、没有 SQL 列、
//   没有前端消费方。也就是说 Plan B Task 1 的产出侧从未落地（或落地后被整体回滚），
//   只剩两个 import 和一行注释在替一个不存在的功能站岗。这里按"真死代码"处理（删），
//   而不是按 subtitleVerify 那族"留着等接线"处理——区别在于：那族有 246 条用例覆盖的
//   真实算法资产在等一根线，这里**没有任何资产**，只有两个指向别处活函数的 import。
//   要恢复 originLang/nativeAudio，改的是 buildMediaLibrary 的 DTO，不是这两行 import。

// ---- 2026-08-12（无活 UI 端点裁决）：旧库三族 builder 已整体删除 ----
//
// 删掉的是：buildLibrary / buildSeriesDetail / buildLibraryMovieDetail（连同 CoverageDTO、
// LibraryItemDTO、LibraryJobDTO、SeriesDetailDTO、MovieDetailDTO 等 DTO 与 sectionOf/
// sectionForItem/commonRootDepth 三个只为 buildLibrary 分区而存在的纯函数），以及它们
// 各自的端点 /api/v2/library、/api/v2/series/:id、/api/v2/library/movies/:id。
//
// 裁决依据两条，缺一不可：
// ① **数据面早就空了**：它们长在 series / episodes / movies 三张旧表上，生产实测 series 0 行
//    （见 mediaLibraryApi.ts 头注释的实测数字）——不是"显示旧数据"，是整个查不出东西。
// ② **消费面也空了**：Task ⑪ 把旧页面移进 web/src/_legacy/ 之后，useLibrary 只剩 _legacy
//    的 SeriesGrid 在调；useLibrarySeriesDetail / useLibraryMovieDetail 连 _legacy 都没有
//    （AppShell 删分支时把两个 hook 调用一并删了），/api/v2/series/:id 更是全仓零消费方。
//
// 活着的替代品是 mediaLibraryApi.ts 的 buildMediaLibrary / buildMediaLibraryDetail
// （长在 files / works / tmdb_seasons 上，生产 110 / 1290 / 2144 行）。
// buildLibrarySeriesDetail 同批删除，见本文件下方原 §LibrarySeriesDetail 处的说明。

// ---- Global runs history (运行历史页) ----

export interface RunHistoryDTO {
  id: number
  jobId: number | null
  startedAt: number
  finishedAt: number | null
  decision: string | null
  detail: string | null
  journalPath: string | null
}

interface RunHistoryRow {
  id: number
  job_id: number | null
  started_at: number
  finished_at: number | null
  decision: string | null
  detail: string | null
  journal_path: string | null
}

/** 全局历史：runs 表按 id desc 分页（默认 limit 50）。 */
export function buildRuns(db: ScoutDb, offset: number, limit: number): RunHistoryDTO[] {
  const rows = db
    .prepare(
      `SELECT id, job_id, started_at, finished_at, decision, detail, journal_path
       FROM runs ORDER BY id DESC LIMIT ? OFFSET ?`
    )
    .all(limit, offset) as RunHistoryRow[]
  return rows.map((r) => ({
    id: r.id,
    jobId: r.job_id,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    decision: r.decision,
    detail: r.detail,
    journalPath: r.journal_path,
  }))
}

// ---- Reconcile-all (v3 phase ⑦ "全仓校验" 触发器) ----

/** Structurally matches src/agent/orchestratorAgent.ts's OrchestratorDecision — declared as its
 *  own DTO here (not imported from agent/) to keep this dashboard-facing layer decoupled from
 *  agent internals, same boundary convention as every other *DTO in this file. */
export interface ReconcileAllResultDTO {
  dispatchedFindSubtitle: number
  dispatchedRealign: number
  spawnedSiblings: number
  summary: string
}

// ---- Parked (去 Jellyfin 化 P6：最小 park 救援) — **整族删除，2026-08-13** ----
//
// 删掉的是：`ParkedItemDTO` / `buildParked` / `unexclude` 转发 / 下方的 `TriageDTO`+
// `buildTriage`，对应端点 GET /api/parked、GET /api/v2/triage、POST /api/v2/triage/unexclude，
// 前端 useParked/useTriage 两个 hook 与 PendingBox/ExcludedBox 两个区。
//
// 判据（不是"看起来没人用"，是"这张表从今天起没有写入者"）：
//  · `parked_paths` 的**唯一**写入者是 `v2/ingest.ts` 的三处 upsertParkedPath，
//    该文件本轮整体退役（它只写 series/episodes/movies/parked_paths 四张旧世界表，
//    一行 `files` 都不写——实测证据见 v2/daemonV2.ts 的 requestScan 头注释）。
//  · daemonV2（今天唯一在扫盘的东西）从不碰 parked_paths：认不出来的文件留在
//    `files.work_id IS NULL`，读出面是 `dashboard/unidentifiedHealth.ts`（活着，
//    活动页状态条在用）——**那才是 park 救援清单的真正后继**，不是这一族。
// 于是保留它们 = 给一张永远为空的表建读出面，正是本仓病 A 的形状。
//
// 🔴 表本身（parked_paths）**没有随之 DROP**，那是刻意的：`cli/unidentifiedFindSubtitle.ts`
// 仍在读写它，而那个文件属于"零生产调用者、保留待裁"的 handleWorkerTask 族（上一轮裁决）。
// 拆掉它的表 = 单方面把另一轮裁决的"接回来当天就能跑"变成假话。完整说明见
// `web/src/triage/TriagePage.tsx` 头注释的 parked 族段落。

// ---- Settings（dashboard 重建战役 G4：settings 表 + 守备目录 + 部署层只读展示） ----

/** spec §7 权威白名单——行为级设置的唯一合法 key 集合。本战役里只有 target_languages 真被
 *  消费（targetLanguages.ts 的 resolveTargetLanguages 第二参）；其余四键此刻只存取展示，值域
 *  校验在下方 updateSettings 的 zod 门（PUT /api/v2/settings 经 server.ts 转call），这里只负责
 *  "读的时候只读这五个"。 */
export const SETTINGS_KEYS = [
  'target_languages', 'hardsub_mode', 'exclude_extras', 'trace_retention_days', 'scan_interval_ms',
  'ai_translate_enabled',
  // spec A §4.6：发动机总开关（fail-open，脏值视为开——布尔别名见 buildSettings）。
  'engine_enabled',
  // spec A §4.4：免费源开关与 engine_enabled 同款通道（PUT 白名单 + zod enum），不另起端点。
  'provider:SUBHD_ENABLED', 'provider:ZIMUKU_ENABLED',
] as const
export type SettingsKey = typeof SETTINGS_KEYS[number]
export type SettingsDTO = Record<SettingsKey, string | null> & { engineEnabled: boolean }

/** GET /api/v2/settings：白名单五键各自 get()，未设置=null（前端自行显示默认值，不由后端
 *  编造一份"默认值"跟真实存量状态混在一起）。 */
export function buildSettings(settingsRepo: Pick<SettingsRepo, 'get'>): SettingsDTO {
  const result = {} as SettingsDTO
  for (const key of SETTINGS_KEYS) result[key] = settingsRepo.get(key)
  return { ...result, engineEnabled: settingsRepo.get('engine_enabled') !== 'false' }
}

// ---- Deploy settings（GET /api/v2/settings/deploy：env 脱敏只读，Jellyfin 式部署/产品分界）----

/** 密钥类 env——绝不回显明文，只答"配了没有"+ 尾 4 位供人眼核对"是不是我以为的那把钥匙"。
 *  枚举来源：README「环境变量总表」+ src 内 process.env.* 全量 grep 核对（cli/index.ts、
 *  cli/doctor.ts、adapters/providers/*）。 */
const DEPLOY_SECRET_KEYS = [
  'TMDB_API_KEY', 'LLM_API_KEY', 'DASHBOARD_TOKEN',
  'ASSRT_TOKEN', 'OPENSUBTITLES_API_KEY', 'OPENSUBTITLES_PASSWORD',
  // AI 翻译部署门三件套之密钥(审计共识:用户必须能在 UI 验证"配没配",否则开了个寂寞开关)
  'TRANSLATE_API_KEY',
  // jimaku 日字源密钥(同为密钥,同档脱敏)
  'JIMAKU_API_KEY',
] as const

/** 非机密 env——部署层信息，原样字符串展示（未设置为 null）帮助排障，不脱敏。 */
const DEPLOY_NONSECRET_KEYS = [
  'LLM_BASE_URL', 'LLM_MODEL', 'LLM_EXTRA_BODY', 'OPENSUBTITLES_USERNAME', 'ZIMUKU_ENABLED',
  'DASHBOARD_PORT', 'SUBTITLE_SCOUT_CACHE_DIR', 'LOG_RETAIN_DAYS', 'REALIGN_ARCHIVE_ROOT',
  'FFPROBE_PATH', 'SCAN_INTERVAL_MS', 'MEDIA_ROOTS',
  // 债务 D4：TMDB 镜像域/HTTP 代理配置口，纯只读展示
  'TMDB_BASE_URL', 'TMDB_PROXY_URL',
  // R2D-10（R2 复审）：A4 引入的部署层旋钮（cli/index.ts resolveTargetLanguages 的第一参来源）
  // 此前漏收进这张展示清单——枚举来源核对时补齐，纯只读展示，不影响 resolveTargetLanguages 本身
  // 的行为级 settings.target_languages 优先级（见该函数第二参的文档注释）。
  'TARGET_LANGUAGES', 'SKIP_CHINESE_ORIGIN',
  // AI 翻译部署门三件套之非机密两件 + 判官/超时旋钮（设置页"部署门状态行"的数据源）
  'TRANSLATE_BASE_URL', 'TRANSLATE_MODEL', 'TRANSLATE_CRITIC', 'TRANSLATE_CRITIC_MODEL',
  'TRANSLATE_TIMEOUT_MS', 'SUBHD_ENABLED',
  // R6-8 修复：TRUST_PROXY（登录限流反代部署下的真实客户端 IP 来源）——部署页可见，
  // 避免"配了但不知道生没生效"的黑盒（R6 子代理 D18 指出漏收）。
  'TRUST_PROXY',
] as const

export interface DeploySecretDTO { present: boolean; tail: string }
export interface DeploySettingsDTO {
  secrets: Record<(typeof DEPLOY_SECRET_KEYS)[number], DeploySecretDTO>
  nonSecrets: Record<(typeof DEPLOY_NONSECRET_KEYS)[number], string | null>
}

/** 尾 4 位，不足 4 位全遮（不直接回显短密钥的任何真实字符，遮罩长度仍等于原长度，供人眼判断
 *  "有没有配置"而不泄露内容）。 */
function maskSecret(v: string | undefined): DeploySecretDTO {
  if (!v) return { present: false, tail: '' }
  return { present: true, tail: v.length >= 4 ? v.slice(-4) : '*'.repeat(v.length) }
}

export function buildDeploySettings(env: Record<string, string | undefined>): DeploySettingsDTO {
  const secrets = {} as DeploySettingsDTO['secrets']
  for (const key of DEPLOY_SECRET_KEYS) secrets[key] = maskSecret(env[key])
  const nonSecrets = {} as DeploySettingsDTO['nonSecrets']
  for (const key of DEPLOY_NONSECRET_KEYS) nonSecrets[key] = env[key] ?? null
  return { secrets, nonSecrets }
}

// ---- fs/list（GET /api/v2/fs/list：dashboard 加根 UI 的目录选择器，Jellyfin 同款“挂载即可见”）----

export type FsListResult = { ok: true; dirs: string[] } | { ok: false; error: string }

/** spec A §11-1：绝对路径判定——POSIX 的 `/` 或 win32 的盘符（`C:\`/`D:/`）。resolve/existsSync
 *  在各平台原生处理盘符；POSIX 上盘符路径过不了存在性检查，诚实报"不存在"而不是冤杀形状。 */
const isAbsoluteMediaPath = (p: string): boolean => p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p)

/** 只列子**目录**名（排序），绝不列文件、绝不读文件内容——容器挂载本身就是可见性边界，这里
 *  不设额外白名单（同 Jellyfin 的目录选择器思路：能挂进容器的目录才可能被看到，配置只是在
 *  已挂载范围内挑选，不是打开一个任意读盘接口）。path 必须是绝对路径；resolve 后
 *  existsSync + isDirectory 才列，否则给一个诚实的 4xx 语义（ok:false + error）而不是抛错。
 *  复审修复 2：statSync/readdirSync 对权限拒绝（EACCES，NAS 挂载常态）会同步抛错——这是用户
 *  点目录浏览器时的正常路况，不是服务器故障，同样收敛成 ok:false，不许炸到 server.ts 变 500。 */
export function listMediaSubdirs(rawPath: string): FsListResult {
  if (!isAbsoluteMediaPath(rawPath)) return { ok: false, error: 'path must be an absolute path' }
  const resolved = toContainerPath(rawPath)
  if (!existsSync(resolved)) return { ok: false, error: 'path does not exist' }
  try {
    const stat = statSync(resolved)
    if (!stat.isDirectory()) return { ok: false, error: 'path is not a directory' }
    const dirs = readdirSync(resolved, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
    return { ok: true, dirs }
  } catch {
    return { ok: false, error: 'path is not readable (permission denied?)' }
  }
}

// ---- Settings 写入（PUT /api/v2/settings、POST/DELETE /api/v2/settings/roots）----
// server.ts 的独立 rawPath 分支只做 method/token 门 + body 解析，业务校验与写入收在这里
// （同 triageOps 的既有分层：server.ts 薄，判断逻辑集中在这一层可单测）。

/** spec §7 权威值域——每个白名单键各自的取值校验（"repo 只管字符串存取，值域校验在调用方
 *  边界做"，这里就是那个边界）。 */
const SETTINGS_VALUE_SCHEMAS: Record<SettingsKey, z.ZodType<string>> = {
  target_languages: z
    .string()
    .regex(/^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*(,[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*)*$/, 'must be comma-separated BCP-47 primary codes, e.g. "zh,en"'),
  hardsub_mode: z.enum(['off', 'agent', 'aggressive']),
  exclude_extras: z.enum(['true', 'false']),
  trace_retention_days: z.string().regex(/^[1-9][0-9]*$/, 'must be a positive integer string'),
  scan_interval_ms: z.string().regex(/^[1-9][0-9]*$/, 'must be a positive integer string'),
  ai_translate_enabled: z.enum(['true', 'false']),
  engine_enabled: z.enum(['true', 'false']),
  'provider:SUBHD_ENABLED': z.enum(['true', 'false']),
  'provider:ZIMUKU_ENABLED': z.enum(['true', 'false']),
}

export type UpdateSettingsResult = { ok: true; settings: SettingsDTO } | { ok: false; error: string }

/** PUT /api/v2/settings body 处理：白名单外的键 400；每键按值域校验，任一项不合法整体 400
 *  （全有或全无——不做"合法的先写、非法的报错"的部分成功，避免半成品状态混进设置表）。全部
 *  通过才落库，返回写入后的全量 settings（前端直接刷新展示，不用再发一次 GET）。 */
export function updateSettings(
  settingsRepo: SettingsRepo, body: unknown, now: number,
): UpdateSettingsResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'body must be a JSON object of setting key-value pairs' }
  }
  const entries = Object.entries(body as Record<string, unknown>)
  for (const [key, value] of entries) {
    if (!(SETTINGS_KEYS as readonly string[]).includes(key)) {
      return { ok: false, error: `unknown setting key: ${key}` }
    }
    if (typeof value !== 'string') {
      return { ok: false, error: `setting ${key} must be a string` }
    }
    const parsed = SETTINGS_VALUE_SCHEMAS[key as SettingsKey].safeParse(value)
    if (!parsed.success) {
      return { ok: false, error: `setting ${key}: ${parsed.error.issues[0]?.message ?? 'invalid value'}` }
    }
  }
  // R5-7 修复：多键写入无事务——注释声称"全有或全无"，但校验后的写入循环不在事务里，
  // 崩溃即部分写。包一层 db.transaction 让语义与注释一致。
  //
  // R-F15 缺口③：target_languages **真的变了**时，同一个事务里触发全库重判。
  //
  //  · 为什么触发点在这里：这是 target_languages 唯一的用户可达写入路径（settings 表的
  //    set() 是无差别的字符串存取，把重判挂在 repo 层会让 seedRootsFromEnv 之类的内部写入
  //    也触发全库写）。本仓栽过 6 次「加了能力却没定谁触发」，故触发者必须是一个具体的、
  //    有测试覆盖的调用点。
  //  · 为什么比较**解析后的语言列表**而不是裸字符串：比较的是"目标语言集合变没变"这个语义，
  //    不是"这个字符串的字节变没变"。`zh, en` 与 `zh,en` 是同一个配置，按字节比会误判成变更
  //    → 白清一次全库判决（字段名/判据必须与真实含义逐字对应）。
  //  · 为什么在同一个事务里：校验失败时一列都不许动（"全有或全无"这条既有语义对重判同样
  //    成立）；且设置写入与据它做出的全库重判之间掉电会留下"新语言已生效、判决还是旧的"的库，
  //    而 judge 谓词是 `needs_subtitle IS NULL` → 那批行永不重判，正是 D17/C43 那类永久冻结。
  const nextTargets = entries.find(([k]) => k === 'target_languages')?.[1] as string | undefined
  const targetsChanged = nextTargets !== undefined
    && parseTargetLanguages(settingsRepo.get('target_languages') ?? undefined).join(',')
      !== parseTargetLanguages(nextTargets).join(',')
  settingsRepo.db.transaction(() => {
    for (const [key, value] of entries) settingsRepo.set(key, value as string, now)
    if (targetsChanged) {
      const langs = parseTargetLanguages(nextTargets)
      retargetForLanguageChange(settingsRepo.db, langs, now)
      // 清 NULL 只是手段。语言事实（origin / 内嵌轨）已经在库里，这一次 PUT 必须当场写出
      // 新口径的判决——等「下一轮巡检阶段 2.5」会让详情页在扫盘的数小时里显示「还没判定」。
      judgePendingFiles({ db: settingsRepo.db, targetLanguage: langs[0], now })
    }
  })()
  return { ok: true, settings: buildSettings(settingsRepo) }
}

export type AddMediaRootResult = { ok: true } | { ok: false; error: string }

/** 重叠校验（业界标准 overlapping-paths validation，同 Docker volume / rsync / 备份工具的既有
 *  做法）：一个路径进了守备目录，它的父目录与子目录都不能再进。
 *
 *  为什么两个方向都要挡：
 *   · 子目录重叠 → 该子树已在既有根的扫描范围内，再加一个根只会让 walkVideoFiles 把同一批
 *     文件走两遍（本项目实测：4 个重叠根让 scanned 从 492 涨到 3140），并让同一文件在两个根
 *     下各自登记，覆盖分类与移除防线全部按"两份不同事实"处理。
 *   · 父目录重叠 → 同上，且更糟：父目录通常还装着非媒体杂物（本项目生产实例：nas_media 根下
 *     混着 .apk/.iso/Backup_ 目录/node_modules），一次误加就把整堆垃圾拉进识别队列烧 token。
 *
 *  边界感知（同 SettingsRepo.removeRoot 的既有手法）：比较时给两侧都补 sep，避免 "/media/tv"
 *  被判成 "/media/tv2" 的父目录。相等不算重叠——那是重复提交同一根，交给下游 addRoot 的
 *  INSERT OR IGNORE 幂等语义（既有行为，不因本校验改变）。
 *
 *  返回命中的既有根（而不只是布尔）：错误文案要指名道姓说"跟哪个根撞了"，否则用户面对
 *  一串路径无从判断该删哪个。 */
// D7（2026-08-08）：实现已下移到 v2/settingsRepo.ts —— addRoot 本身要成为闸门，堵住
// seedRootsFromEnv 那条绕过 HTTP 层的旁路（缺口 C29）。此处改 import 同一份，避免两份漂移。

/** POST /api/v2/settings/roots body={path} 处理：绝对路径 + 磁盘上存在 + 是目录 + 与既有根
 *  不重叠才收——前三项同 listMediaSubdirs 的判定口径（Jellyfin 式"挂载即可见"边界，这里只是
 *  收窄到"必须先能列出来才能加"），第四项见 findOverlappingRoot 的论证。路径经 resolve()
 *  归一化后落库（去掉冗余的尾斜杠/`.`/`..` 片段），避免同一个目录因写法不同（"/media/tv" vs
 *  "/media/tv/"）被误判成两个不同的根。addRoot 本身幂等（INSERT OR IGNORE），重复提交同一
 *  归一化路径直接 200，不报错。
 *
 *  校验顺序刻意是"形状 → 存在性 → 重叠"：重叠检查要拿 resolve 后的规范路径跟库里的规范路径
 *  比，放在归一化之前会被写法差异骗过（"/data/media/" 与 "/data/media" 字符串不等）。 */
export function addMediaRoot(
  settingsRepo: Pick<SettingsRepo, 'addRoot' | 'listRoots'>, rawPath: unknown, now: number,
): AddMediaRootResult {
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    return { ok: false, error: 'path is required' }
  }
  if (!isAbsoluteMediaPath(rawPath)) {
    return { ok: false, error: 'path must be an absolute path' }
  }
  const resolved = toContainerPath(rawPath)
  if (!existsSync(resolved)) {
    return { ok: false, error: 'path does not exist' }
  }
  // 复审修复 2：同 listMediaSubdirs——statSync 对权限拒绝（EACCES）的同步抛错收敛成 ok:false
  // 的 4xx 语义（用户给了一个进程无权探测的路径是输入问题，不是服务器故障）。
  try {
    if (!statSync(resolved).isDirectory()) {
      return { ok: false, error: 'path is not a directory' }
    }
  } catch {
    return { ok: false, error: 'path is not readable (permission denied?)' }
  }
  // 重叠校验（见 findOverlappingRoot 的论证）——放在归一化与存在性之后，用规范路径比对。
  const hit = findOverlappingRoot(resolved, settingsRepo.listRoots().map((r) => r.path))
  if (hit) {
    return {
      ok: false,
      error: hit.relation === 'child'
        ? `path is already covered by media root ${hit.root} — remove that root first if you want to guard this subdirectory instead`
        : `path contains existing media root ${hit.root} — remove that root first if you want to guard the parent directory instead`,
    }
  }
  // D7（2026-08-08）：addRoot 自己也是嵌套闸门（堵 seedRootsFromEnv 那条旁路）。这里的
  // 上游校验保留——它能给出指名道姓的文案；闸门是双保险，理论上不该命中。真命中说明上游
  // 校验与闸门口径漂移了，必须让调用方看见而不是静默丢弃。
  const added = settingsRepo.addRoot(resolved, now)
  if (!added.ok) {
    return {
      ok: false,
      error: added.conflict.relation === 'child'
        ? `path is already covered by media root ${added.conflict.root} — remove that root first if you want to guard this subdirectory instead`
        : `path contains existing media root ${added.conflict.root} — remove that root first if you want to guard the parent directory instead`,
    }
  }
  return { ok: true }
}

// ---- dashboard 重建战役 G5：workflow/library/甄别聚合 API ----
// 北极星约束：这些端点是纯读聚合 + 一个人类扳手（redispatch）——全部走既有 repo/模块，
// 不新增任何判断逻辑。机械层产出事实，不产出指令。

// ---- workflow/pending：顶栏新鲜度行 ----
//
// 2026-08-13：`WorkflowPendingSeriesDTO` / `WorkflowPendingMovieDTO` 两个接口随
// WorkflowPendingDTO 的 series[]/movies[] 两字段一并删除——它们的唯一用处就是给那两个
// 字段做元素类型，字段没了就没有任何声明或实现引用它们。产出它们的
// `LibraryRepo.missingBySeason/missingMovies` 两个方法保留，理由见 WorkflowPendingDTO
// 头注释；那两个方法返回的是 snake_case 的行对象，不依赖这里的 camelCase DTO 形状。

export interface WorkflowFreshnessDTO {
  /** settingsRepo.listRoots() 的路径列表。 */
  roots: string[]
  /** 上次扫描时刻 = meta 表 `last_inspect_at` 键（daemonV2.writeLastInspectAt 写入）。
   *  从未巡检过时 null。
   *
   *  ## 为什么读 `last_inspect_at` 而不是 `last_ingest_at`（2026-08-10）
   *
   *  本字段原读 `last_ingest_at`，而那个键**已经没有任何写入者**——归因不是第 7 步 B 组
   *  （B 组删掉的 v2/daemon.ts 只是尸体），而是**第 2 步**（915f3ec）把 cmdWatch 内部的
   *  ScoutDaemon 换成 ScoutDaemonV2：那之后 ScoutDaemon 再没被构造过，它 tickInner 里
   *  那唯一的写入点从此就是死代码。所以这个字段自第 2 步起在生产恒为 null。
   *
   *  后果是一句**主动的假话**：前端 text.ts lastCheckedLine() 见 null 就显示"还没扫过"，
   *  而 daemonV2 每天都在正常巡检。讽刺的是 text.ts 那段"lastScanAt === null 时绝不编一个
   *  时刻出来"的注释与专门测试完全正确——错的是我们喂给它的数据源。
   *
   *  新架构下"巡检"就是"摄取"，`last_inspect_at` 与 `last_ingest_at` 语义等价（daemonV2
   *  自己也读它做 24h 时间门），故改读取侧即可——**不给 daemonV2 新增任何写入行为**。
   *  字段名 `lastScanAt` 与前端一并不动：语义没变，仍是"上次扫描时刻"。
   *
   *  不做 `last_ingest_at` 回退：见 buildWorkflowPending 里 SELECT 处的说明。 */
  lastScanAt: number | null
  /**
   * 磁盘上的视频文件总数 = `SELECT COUNT(*) FROM files`。
   *
   * ── 2026-08-13：从 `episodes + movies` 改成 `files`（修一句顶栏假话）────────────
   * 本字段原读 `(SELECT COUNT(*) FROM episodes) + (SELECT COUNT(*) FROM movies)`。
   * 那两张表在生产**各 0 行**，而 `files` 有 645 行（真实数据）——于是顶栏新鲜度行
   * （web/src/shell/freshness.ts 的 `${meta.files} files`）对一个 645 个文件的库
   * 显示「0 files」。这与本文件 lastScanAt 头注释所修的是同一形状的假话：读取侧读了
   * 一张没有写入者的表。
   *
   * 判据不是"这两张表暂时是空的"，是**结构上不可填**：`libraryRepo.upsertEpisode` /
   * `upsertMovie` 的非测试调用者只剩 `src/testing/seedBacklog.ts`（测试 fixture），
   * 原写入链 `src/v2/ingest.ts` 本轮整体退役（同 parked 族的判据，见本文件上方
   * 「Parked ... 整族删除」段与 web/src/triage/TriagePage.tsx 的「2.5 parked 族的结局」）。
   * 今天唯一在扫盘写库的是 daemonV2，它只写 `files`。
   *
   * ── 语义对齐：为什么 `COUNT(*) FROM files` 就是对的口径 ─────────────────────
   * 旧口径 episodes+movies 是「库内条目数」（一集一行 / 一部电影一行）。新口径是
   * 「磁盘上的视频文件数」。两者在**同一集有两份拷贝**时会分叉（旧口径 1、新口径 2），
   * 但这行文案本来就写着 "files"，且 DESIGN.md 把它钦定为"存活感"信号（机械读数，
   * 不是去重后的作品学统计）——`files` 表一行就是磁盘上一个视频文件，字面对得上。
   *
   * ⚠️ **刻意不复用 mediaLibraryApi 的去重口径**（`onDiskEpisodeCount` = 去重后的
   * 格数，生产 568）：那是媒体库页「实有几集」的口径，分母是 tmdb_seasons，用于算缺集数；
   * 拿它当 "N files" 会把"两个目录各一份"报成 1 个文件，那是另一句假话。两处口径不同
   * 不是"同一件事两套写法"——它们回答的是两个不同的问题。真正该复用的是
   * `sub_status='covered'` 这个字幕判据，见下方 verifiableItems。
   *
   * ⚠️ **不加 `work_id IS NOT NULL` 过滤**：识别失败的孤儿文件仍然是磁盘上的文件，
   * 顶栏说的是"我在看着多少个文件"，不是"我认出了多少个"。（媒体库页滤掉它们是因为
   * 那一屏是海报墙，没有作品就没有卡片——见 buildMediaLibrary 头注释。）
   */
  files: number
  /**
   * 字幕校验巡检的上次运行时刻（读 meta 表 `last_verify_sweep_at`，见下方 SELECT）。
   *
   * ⚠️ **本字段在生产恒为 null，且这不是 bug 而是已知待办。** 此前这行注释写着
   * "verifySweep 写入"——那是句**假话**，与本文件 lastScanAt 头注释所修的是同一形状、
   * 同一成因的假话（注释宣称的机制其实不存在），故在第 7 步 B 组同批更正。
   *
   * 事实链（可复核）：
   * 1. `last_verify_sweep_at` 全仓**无任何写入者**。verifySweep.ts 只把键名导出成常量
   *    （`VERIFY_SWEEP_META_KEY`），`runVerifySweep` 函数体内零 meta 写入。
   * 2. `runVerifySweep` 被 `cli/index.ts` import，但**从未被调用**。
   * 3. 成因不是删代码删漏了，而是产品决策：巡检注入于 2026-08-07 雪藏（见 cmdWatch 里
   *    `verifyRepo` 构造处的说明；承载它的 daemonDeps 字面量后来随第 7 步 B 组删除，
   *    daemonV2 侧从未有过 verifySweep 字段，雪藏状态不变）。
   *
   * 所以：**没有写入者 → 本字段生产恒 null → 前端"从未跑过"的显示恰好是真话**（同 lastScanAt
   * 那条"绝不编一个时刻出来"的纪律）。这与 lastScanAt 的病例关键区别在于：那边 daemonV2 天天
   * 在巡检、显示"还没扫过"才是假话；这边校验巡检确实没在跑，读到 null 并无谎言，故**只更正
   * 注释、不动 SELECT、不动任何行为**。恢复 verifySweep 注入是产品决策，不在第 7 步范围内。
   *
   * 为什么当初要有它：巡检此前只在容器日志里打一行 `verify sweep: checked=N`，界面上完全
   * 看不见。一个"全是绿点"的库有两种可能——真的都没问题，或者巡检根本没在跑——而用户无从
   * 分辨。时间戳是唯一"崩掉的系统 produce 不出来"的廉价元件（同 lastScanAt 的既有理由）。
   * 恢复注入那天，这个字段与前端无需任何改动即自动复活。
   */
  lastVerifySweepAt: number | null
  /** 已出校验结论的条目数 / 该被校验的条目数（sub_status='covered'）。
   *  两个裸计数，不是百分比——铺量期用它能看出"还在推进"，稳态下两者相等。
   *
   *  ⚠️ **两者在生产都恒为 0，且这里刻意不跟着 `files` 一起改口径**（2026-08-13）。
   *  上面 `files` 从 episodes+movies 改读 `files` 表是因为它有活的渲染面（顶栏）且在说假话；
   *  这一对**没有任何活消费者**（`rg 'verifiableItems|verifiedItems' web/src` 只命中
   *  api/types.ts 的类型声明与几个测试 fixture，无 UI 读取），改它不修任何用户可见的假话。
   *
   *  更要紧的是：改了反而**造一句新假话**。这一对是同一个 id 空间的分子/分母——
   *  · 分子 `verifiedItems` = `COUNT(*) FROM subtitle_verify`，而 subtitle_verify.item_id
   *    的值域就是 episodes/movies 的 id（见 v2/subtitleVerifyRepo.ts 头注释：那张表在生产
   *    永远不会有第一行，环是封闭的）；
   *  · 分母若单方面改成 `files.sub_status='covered'`（生产 219），顶栏就会读出「0 / 219」
   *    ——一个分子来自死 id 空间、分母来自活表的比值，含义是"有 219 条待校验、已校验 0 条"，
   *    而实际上**校验巡检根本没在跑**（runVerifySweep 零调用，见 lastVerifySweepAt 头注释）。
   *    那正是"把一个不存在的进度条画出来"。今天的 0 / 0 反而是真话：没有可校验的条目，
   *    也没有校验结论。
   *
   *  这一对与 `lastVerifySweepAt` 同进退：verifySweep 巡检恢复注入那天一起重估口径
   *  （届时 selectVerifyCandidates 的 episodes/movies JOIN 也得一并迁到 files，
   *   见 src/subtitleVerify/verifySweep.ts:180-190）。 */
  verifiedItems: number
  verifiableItems: number
}
/** GET /api/v2/workflow/pending 的响应体。
 *
 *  ── 2026-08-13：`series[]` / `movies[]` / `parked` 三个字段删除 ──────────────
 *  三者都是**零消费者的产出**：这条端点在前端的唯一读取面是 `shell/Topbar.tsx`
 *  （经 AppShell 的 useWorkflowPending，15 秒轮询），而它只读 `.meta`
 *  （`formatFreshness(workflow.data.meta, ...)`，Topbar.tsx 一处）。三个字段从未
 *  被任何组件读过——旧的读取面（甄别页 PendingBox/ExcludedBox、旧 workflow 页）
 *  已分别于 2026-08-13 与 Task ⑪ 删除。
 *
 *  代价是实打实的：每 15 秒一次轮询，`missingBySeason` 与 `missingMovies` 各跑一条
 *  带 JOIN 的 GROUP BY（episodes×series / movies），`listParkedPaths()` 再全表扫一次
 *  parked_paths 并只取 `.length`——三条查询的结果直接被 JSON 序列化后丢弃。
 *
 *  ⚠️ 这**不是**"删了读出面留着写入面"的病：这三条读的是别人（settingsRepo.removeRoot、
 *  findSubtitleWorkerTask、cli/unidentifiedFindSubtitle）在维护的表，本端点只是个
 *  多余的旁观者。删掉旁观者不影响任何表的读写闭环。
 *
 *  🔴 `LibraryRepo.missingBySeason` / `missingMovies` 两个方法本轮**不删**，尽管本次
 *  删除让它们的生产调用者归零（`listParkedPaths` 不同，它在
 *  `cli/unidentifiedFindSubtitle.ts` 还有一个调用点，且是
 *  `dashboard/triageShelved.orphan.test.ts` 自检段选定的扫描器靶子）。
 *  理由：它们查的是 episodes/movies 两张**仍然活着**的表（3 条 HTTP 端点经
 *  getEpisode/getMovie 在读、settingsRepo.removeRoot 的级联在写），而"哪些季/电影还缺
 *  字幕"是这个产品的核心事实——缺的只是一个展示位（旧 workflow 页随 Task ⑪ 下架，
 *  三页新产品尚未给它安排出口）。这与 parked 族的情形**不同**：那边是表本身零写入者，
 *  这边是活表上的一个真查询暂时没有渲染面。
 *  删它们要先回答"缺口事实在三页产品的哪一页露出"，那是产品决策，不在本轮死代码清理的
 *  范围内。 */
export interface WorkflowPendingDTO {
  meta: WorkflowFreshnessDTO
}

/** GET /api/v2/workflow/pending：顶栏新鲜度行（meta）。纯读聚合。
 *
 *  2026-08-13：`series`/`movies`/`parked` 三个字段连同产出它们的三条查询一并删除，
 *  理由见 WorkflowPendingDTO 头注释。本函数现在只产出 meta 一个字段。 */
export function buildWorkflowPending(
  db: ScoutDb, settingsRepo: Pick<SettingsRepo, 'listRoots'>, now: number,
): WorkflowPendingDTO {
  // 上次扫描时刻读 daemonV2 写的 `last_inspect_at`（键的选择与归因见 WorkflowFreshnessDTO
  // .lastScanAt 头注释）。键名与 daemonV2.readLastInspectAt/writeLastInspectAt 一致。
  //
  // ## 为什么不给已死的 `last_ingest_at` 做 COALESCE 回退
  //
  // 已部署的老库里可能确实存着一行第 2 步之前写的 `last_ingest_at`。不回退它，理由：
  // 1. **那个时刻已经很旧了**（第 2 步至今，量级是周/月）。把它显示成"上次扫描"是把一个
  //    陈旧值当成新鲜值——这跟本次要修的"假话"是同一类错误，只是换了个方向说谎。
  // 2. **null 窗口极短**。daemonV2 冷启动（读不到 last_inspect_at ⇒ 0 ⇒ 立即跑）第一圈就
  //    巡检、成功即写键。所以老库升级后"显示还没扫过"只持续到首轮巡检结束，是分钟量级，
  //    不是一天。回退换来的那点"立刻有个数"根本不值得。
  // 3. 回退会让这个键继续苟活，下一个读代码的人还得再考古一遍它是死是活。
  //
  // 而"还没扫过"在那个短窗口里恰好是**真话**（新架构下确实还没巡检过）——text.ts 那条
  // "绝不编一个时刻出来"的纪律在这里正常工作，不需要我们替它兜底。
  const lastScanRow = db.prepare(`SELECT value FROM meta WHERE key = 'last_inspect_at'`).get() as
    | { value: string }
    | undefined
  // 磁盘上的视频文件总数。**读 `files` 表，不读 episodes+movies**——那两张表结构上
  // 不可填（唯一写入链 v2/ingest.ts 已退役，非测试调用者归零），照旧读会让一个 645 个
  // 文件的库在顶栏显示「0 files」。完整判据与"为什么不复用媒体库页的去重口径"见
  // WorkflowFreshnessDTO.files 头注释。
  const filesRow = db.prepare(`SELECT COUNT(*) AS c FROM files`).get() as { c: number }

  // 字幕校验的新鲜度与推进度（2026-07-31）。键名与 verifySweep.VERIFY_SWEEP_META_KEY 一致。
  const lastVerifyRow = db
    .prepare(`SELECT value FROM meta WHERE key = 'last_verify_sweep_at'`)
    .get() as { value: string } | undefined
  const verifyCounts = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM subtitle_verify) AS done,
              (SELECT COUNT(*) FROM episodes WHERE sub_status = 'covered')
            + (SELECT COUNT(*) FROM movies   WHERE sub_status = 'covered') AS total`,
    )
    .get() as { done: number; total: number }

  return {
    meta: {
      roots: settingsRepo.listRoots().map((r) => r.path),
      lastScanAt: lastScanRow ? Number(lastScanRow.value) : null,
      files: filesRow.c,
      lastVerifySweepAt: lastVerifyRow ? Number(lastVerifyRow.value) : null,
      verifiedItems: verifyCounts.done,
      verifiableItems: verifyCounts.total,
    },
  }
}

// ---- workflow/passes：orchestrate 通行记录 + receipts（纯解析 trace_json 快照，不是新账目）----

export interface DispatchReceiptsDTO {
  created: number
  revived: number
  coalesced: number
  blocked_dormant: number
  unknown: number
}
export interface WorkflowPassDTO {
  id: number
  jobId: number | null
  startedAt: number
  finishedAt: number | null
  detail: string | null
  receipts: DispatchReceiptsDTO
}

interface OrchestrateRunRow {
  id: number
  job_id: number | null
  started_at: number
  finished_at: number | null
  detail: string | null
  trace_json: string | null
}

const DISPATCH_OUTCOME_RE = /"outcome"\s*:\s*"(created|revived|coalesced|blocked_dormant)"/

/** 把一行 orchestrate run 的 trace_json 快照解析成 receipts 计数：遍历事件，只看 tool 以
 *  'dispatch_' 开头的行（dispatch_find_subtitle_task/dispatch_realign_task——spawn_sibling_
 *  orchestrator 故意不算，那是分片交接不是缺口派发），从 resultSummary 里正则提取四态之一；
 *  提不出来（被 200 字符截断，或压根没有 outcome 字段）计入 unknown。这是纯解析呈现，不是
 *  新账目——traceBus 收官快照本身就是唯一真源，这里只是把它翻译给人看。 */
function parseDispatchReceipts(traceJson: string | null): DispatchReceiptsDTO {
  const receipts: DispatchReceiptsDTO = { created: 0, revived: 0, coalesced: 0, blocked_dormant: 0, unknown: 0 }
  if (!traceJson) return receipts

  let events: TraceEvent[]
  try {
    events = JSON.parse(traceJson) as TraceEvent[]
  } catch {
    return receipts
  }

  for (const e of events) {
    if (!e.tool || !e.tool.startsWith('dispatch_')) continue
    const match = DISPATCH_OUTCOME_RE.exec(e.resultSummary ?? '')
    if (match) receipts[match[1] as keyof DispatchReceiptsDTO]++
    else receipts.unknown++
  }
  return receipts
}

/** GET /api/v2/workflow/passes?limit=20：orchestrate runs 行（decision='orchestrate'），
 *  finished_at 降序；limit 由调用方（router.ts）clamp 到 [1,100] 后传入，这里原样消费
 *  （同 buildRuns 的既有分工：clamp 在路由层，聚合函数只管查询）。 */
export function buildWorkflowPasses(db: ScoutDb, limit: number): WorkflowPassDTO[] {
  const rows = db
    .prepare(
      `SELECT id, job_id, started_at, finished_at, detail, trace_json FROM runs
       WHERE decision = 'orchestrate' ORDER BY finished_at DESC LIMIT ?`
    )
    .all(limit) as OrchestrateRunRow[]
  return rows.map((r) => ({
    id: r.id, jobId: r.job_id, startedAt: r.started_at, finishedAt: r.finished_at, detail: r.detail,
    receipts: parseDispatchReceipts(r.trace_json),
  }))
}

// ---- workflow/workers：已删除（2026-08-13「三个 jobs 读取面」裁决）----
//
// 曾经这里是 `buildWorkflowWorkers` + 四个 DTO（running/recent/held/providerQuota），
// GET /api/v2/workflow/workers 的生产者。**删除，不是雪藏**——理由与同轮保留的
// `buildDormantTasks` 不同，两者的分界写在下面，因为它正是本轮唯一需要论证的地方。
//
// ── 为什么它不属于「待接线的活」──────────────────────────────────────────
// 它的两条 `FROM jobs` 查询（running: state='searching' / held: state='failed' 且
// next_retry_at 未来）在生产**永远查不到行**：写这两个状态的只有 `jobsRepo.claimNext`
// 与 `completeError`，而它们的调用者全部挂在 `cli/handleWorkerTask.ts` 之下——那个模块
// 自第 7 步起生产零 import（有 `handleWorkerTask.orphan.test.ts` 钉着这个事实）。
//
// 但"查不到行"**不是**删它的理由（`buildDormantTasks` 同样如此，却留下了）。真正的理由是：
//
//   **它的显示位已经有活的后继，且后继刻意不读它。**
//
// 唯一消费方 `web/src/_legacy/activity/ActivityPage` 已被 `web/src/workbench/ActivityPage`
// 取代（Task ⑨，活在 AppShell 里）。新页面读 SSE + `/api/v2/activity` + `/api/v2/health`，
// 一行 jobs 都不读；`db.ts` v42 那段注释更是**点名禁止**新活动页照抄本 DTO 的 JOIN
// （旧 DTO 读 `series.backdrop_path`，而 `series` 表生产 0 行，照抄会得到"填满了却全是
// null"的字段）。所以即便哪天 jobs 队列被接回 claim，也**不会**有人想恢复这个 DTO——
// 该显示的东西新页面已经在显示了。它不是缺一根接线的资产，是一份已被取代的旧图纸。
//
// 这与 `handleWorkerTask` 家族的「要么整族留、要么整族删」不冲突：那条铁律护的是
// **执行侧**（四条 runner + claim/租约/reap + redispatch 生产者），它们缺的确实只是一根
// 接线。本函数是**显示侧**，而显示侧的后继已经上线。删它不会让那一族少掉半边。
//
// ⚠️ 连带记入债务（不在本轮修）：`providerQuota` 是本 DTO 里**唯一有活写入者**的字段
// （`cli/quotaState.applyQuotaEvent` ← `emitProviderEvent` ← 活的 translate/realign 路径）。
// 删掉本函数后，`settings` 里的 `quota_state_*` 键**成为只写不读**——这是病 A 的镜像形态
// （有活写入者却没有读取方）。正确的处置是给它一个真正的展示位或删掉写入侧，两者都是
// 独立的产品动作，不在一次结构清理里顺手决定。
//
// ✅ 2026-08-13 **已结清**：裁决"给它一个真展示位"。读取方加在
// `dashboard/setupApi.ts` 的 `buildProviders`（`ProviderRowDTO.quota`），
// 展示位在设置页的 `ProviderCard`——**刻意没有照抄**上面那个扁平 `providerQuota` 数组，
// 理由写在 `setupApi.ts` 里 `buildProviders` 上方。这里不要再复活本形状。
//
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * 🟡 2026-08-13「三个 jobs 读取面」裁决：**本条保留**，与同轮删除的
 *    `buildWorkflowWorkers` 分道扬镳。分界线在下面第 3 条。
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ── 1. 它今天没有活 UI（如实陈述，不粉饰）────────────────────────────────
 *   GET /api/v2/workflow/dormant ← api.workflowDormant ← useDormantTasks
 *     ← web/src/triage/DormantBox ← web/src/triage/TriagePage
 *     ← **AppShell 不 import 它**（甄别 tab 于 2026-08-07 雪藏，'triage' 也不在
 *       route.ts 的 Tab 联合里）。
 *
 * ── 2. 它今天也**查不到新行**（比上一条更要命，同样如实写下）──────────────
 * 写 `state='dormant'` 的只有四处，全部在 `v2/jobsRepo.ts`：`park` / `reapExpiredLeases`
 * / `reapAllActive` / `forceState`。而：
 *   · `reapExpiredLeases` / `reapAllActive` / `forceState` —— 生产零调用点；
 *   · `park` 的两个调用者（realignWorkerTask / translateWorkerTask）只经
 *     `cli/handleWorkerTask.ts` 到达，而那个模块自第 7 步起生产零 import
 *     （`cli/handleWorkerTask.orphan.test.ts` 正钉着这个事实）。
 * 换言之 jobs 队列**只剩一个活写入者**（`triageOps.redispatch` → `upsertWorkerTask`，
 * 它只写 `'wanted'`），没有任何东西能再把一行推进 dormant。
 * 所以本函数今天返回的是**旧世界残留的墓碑行**，不是活事实。
 *
 * ── 3. 那为什么它留、而 buildWorkflowWorkers 删？──────────────────────────
 * 因为判据是**"显示位有没有活的后继"**，不是"查不查得到行"（后者两边一样）。
 *
 *   · `buildWorkflowWorkers` 的显示位**已有后继**：`web/src/workbench/ActivityPage`
 *     （活在 AppShell 里）读 SSE + /api/v2/activity + /api/v2/health，一行 jobs 都不读，
 *     且 db.ts v42 注释**点名禁止**它照抄旧 DTO 的 JOIN。旧 DTO 不是"缺一根接线"，
 *     是一份**已被取代**的旧图纸 → 删。
 *   · 本条的显示位**没有后继**：三页产品（活动/通知/媒体库）里没有任何地方呈现
 *     "自动重试已永久停止"这件事。而 dormant 恰恰是最不该静默的一种状态。
 *     它的容器 `TriagePage` 也不是我可以顺手删的——2026-08-12 那轮裁决保留
 *     subtitleVerify 一族时，**明写恢复路径是"把 TriagePage 挂回 AppShell"**
 *     （见 `v2/subtitleVerifyRepo.ts` 头注释）。那条裁决今天仍然成立，
 *     删掉 TriagePage 的第四区等于单方面拆掉另一轮裁决的恢复路径。
 *     ⚠️ 2026-08-13 补记：TriagePage 的去留后来单独裁决过一轮（此前 FRONTEND-IMPL-DESIGN
 *     的清点表判「删」，与上述恢复路径打架）。结论**雪藏保留**，正本在
 *     `web/src/triage/TriagePage.tsx` 头注释，那里写明 DormantBox 与 jobs 族**同进退**
 *     ——即下面第 4 条判据，两处不重抄。
 *
 * ── 4. 什么时候可以删（**可证伪的判据，一条能跑的命令**）──────────────────
 * 本条与 jobs 队列**同进退**：dormant 行的存在性完全由那个队列决定，队列一旦整族退役，
 * 本函数连墓碑行都查不到，届时必须一起走。判据（无输出 = 队列仍是孤儿 = 尚未触发）：
 *
 *     rg -l "^import .*from '\./handleWorkerTask\.js'" src -g '!*.test.ts' -g '!cli/handleWorkerTask.ts'
 *
 * ⚠️ 2026-08-13 更正：这条判据此前写作
 * `rg -l "from './handleWorkerTask.js'" src --glob '!*.test.ts'`，**那个形态今天已经
 * 假阳**——它会命中两个文件：本文件（上面这行注释就含同一个字符串）与
 * `cli/handleWorkerTask.ts` 自己。也就是说照抄它去核对的人会得到"队列复活了"的错误
 * 结论。锚 `^import` 挡散文引用，`-g '!cli/handleWorkerTask.ts'` 挡自指。
 * 这正是判据必须有机器载体（而不是只当散文留着）的原因：断言会被跑，散文不会。
 *
 * 这条命令**已经有机器载体**：`src/cli/handleWorkerTask.orphan.test.ts`（它解析 import
 * 并剥注释，不受上述假阳影响，故那份守卫一直是对的——错的只是这里抄下来的命令行）。
 * 触发方式有两个方向，两个都要处置本条：
 *   (a) `cli/handleWorkerTask.ts` 与 jobs 队列整族**被删** → 本函数、DormantTaskDTO、
 *       dormantTargetLabel、端点、client 方法、useDormantTasks、DormantBox 一起删；
 *   (b) 队列**被接回 claim**（orphan 守卫会当场变红）→ dormant 重新是活事实，
 *       那时必须回答"它在三页产品的哪一页露出"，而不是继续挂在一个雪藏页上。
 *
 * 🔴 不要只删一半：删 DormantBox 留端点、或删端点留 DormantBox，都是本仓病 A 的形状。
 * ═══════════════════════════════════════════════════════════════════════════
 */
/** Plan C（spec §4.2）：GET /api/v2/workflow/dormant 的行 DTO。**四键封闭。**
 *  刻意缺席的字段与理由：
 *   - `reason`/`last_error`：现网该串是中文且含内部措辞（`src/v2/jobsRepo.ts:110`），
 *     不透传；英文句子由前端用 attempts 组（spec §5.7 新拟 #3）。
 *   - 任何时刻字段：草稿 6 的 dormant 行不渲染时刻，jobs 表也没有 `last_error_at` 列；
 *     `updated_at` 虽然冻结在 park 时刻可以推导，但没有 UI 消费方，不进 DTO（R1 审计裁决）。
 *     它只用于 ORDER BY（最近停车的排前面），不序列化。 */
export interface DormantTaskDTO {
  jobId: number
  /** 裸工具名（如 `find_subtitle`），前端 mono 弱显。payload 无 taskType 时回落 jobs.kind。 */
  task: string
  /** 后端组好的目标标签（"The Rig, Season 2" 粒度），前端不拼。 */
  targetLabel: string
  /** 实际把这行推到 dormant 的失败次数 = max(内容轨 attempt, 崩溃轨 reap_count)。 */
  attempts: number
}

/** buildDormantTasks 的 join 行（导出仅为让 dormantTargetLabel 可独立单测）。 */
export interface DormantJobRow {
  id: number
  series_id: string | null
  movie_id: string | null
  season: number | null
  series_name: string | null
  movie_name: string | null
  /** `json_extract(payload,'$.seasons')` 的原样结果：数组时是 JSON 文本（如 `'[2]'`），
   *  payload 里是 null / 缺席 / 根本没有 payload 时是 SQL NULL。 */
  seasons_json: string | null
}

/** 目标标签组装（纯函数，无 I/O，可直接单测）。
 *
 *  季号有两个来源且**顺序不能颠倒**：`payload.seasons` 优先，`jobs.season` 兜底。理由：
 *  R-11 裁决（`src/v2/jobsRepo.ts:56` 区域）之后，`jobs.season` 对 find_subtitle 任务**恒为
 *  null**，派活范围搬到了 payload；只看列的话现网所有 worker_task 都会退化成"只有系列名"。
 *
 *  名字查不到时如实回落 id（合成 series_id 如 `orchestrator-shard-42-1` 本来就不在 series
 *  表里，`src/v2/db.ts:76` 区域注释）——**不伪造名字**，让人看到一个能拿去查库的真串。 */
export function dormantTargetLabel(row: DormantJobRow): string {
  const name = row.series_name
    ?? row.movie_name
    ?? row.series_id
    ?? row.movie_id
    ?? `job #${row.id}`
  const seasons = parseSeasonsJson(row.seasons_json)
  if (seasons !== null && seasons.length === 1) return `${name}, Season ${seasons[0]}`
  if (seasons !== null && seasons.length > 1) return `${name}, Seasons ${seasons.join(', ')}`
  if (row.season !== null) return `${name}, Season ${row.season}`
  return name
}

/** `json_extract` 出来的 seasons 文本 → 升序数字数组；不是数组/畸形 JSON/空数组一律 null
 *  （按"没有季信息"处理，让 dormantTargetLabel 走 jobs.season 或纯名字分支）。
 *  不抛保证只覆盖这一段：抽出来的 seasons 文本畸形 → null。注意若 **payload 本身**畸形，
 *  json_extract 在 SQL 层就先抛 SqliteError，根本走不到这里——但应用内所有 payload 写入
 *  都过 JSON.stringify（jobsRepo），只有手工改库才能造出畸形 payload，实践中不可达，
 *  不为它加防御层。 */
function parseSeasonsJson(raw: string | null): number[] | null {
  if (raw === null) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return null
    const nums = parsed.filter((n): n is number => typeof n === 'number')
    return nums.length > 0 ? [...nums].sort((a, b) => a - b) : null
  } catch {
    return null
  }
}

/** Plan C（spec §4.2）：dormant 任务清单。纯读、零状态机改动。
 *  ORDER BY updated_at DESC = 最近停车的排前面（updated_at 在 park 时冻结，见 jobsRepo
 *  的 park/reap SQL）——**它只参与排序，不进 DTO**。 */
export function buildDormantTasks(db: ScoutDb): DormantTaskDTO[] {
  const rows = db
    .prepare(
      `SELECT j.id          AS id,
              j.kind        AS kind,
              j.series_id   AS series_id,
              j.movie_id    AS movie_id,
              j.season      AS season,
              j.attempt     AS attempt,
              j.reap_count  AS reap_count,
              json_extract(j.payload, '$.taskType') AS task_type,
              json_extract(j.payload, '$.seasons')  AS seasons_json,
              s.name        AS series_name,
              m.name        AS movie_name
         FROM jobs j
         LEFT JOIN series s ON s.id = j.series_id
         LEFT JOIN movies m ON m.id = j.movie_id
        WHERE j.state = 'dormant'
        ORDER BY j.updated_at DESC`,
    )
    .all() as Array<DormantJobRow & { kind: string; attempt: number; reap_count: number; task_type: string | null }>

  return rows.map((row) => ({
    jobId: row.id,
    task: row.task_type ?? row.kind,
    targetLabel: dormantTargetLabel(row),
    attempts: Math.max(row.attempt, row.reap_count),
  }))
}

// ---- workflow/runs/:id/trace（dashboard-F4 后端例外口子：单 run 痕迹快照回放）----
// 北极星④：纯解析呈现，不新增判断——runs.trace_json 原样解析成事件列表，供 RunDetail 右侧板
// 的"快照回放"渲染（回放≠直播：这里不接 traceBus，只读已经落库的收官快照，同 G3 注释的
// "snapshot 是唯一持久化点"口径）。

export interface RunTraceDTO {
  events: TraceEvent[]
}

interface RunTraceRow {
  trace_json: string | null
}

/** GET /api/v2/workflow/runs/:id/trace：单行 trace_json 解析。行不存在 → null（router.ts 映射
 *  404，同 buildSeriesDetail/buildLibrarySeriesDetail 先例）；trace_json 为 NULL 或解析失败
 *  （脏数据/早于 G3 落地的历史行）→ events:[]——run 行本身是真实存在的，只是没有痕迹快照可
 *  回放，不等于"这个 run 不存在"。 */
export function buildRunTrace(db: ScoutDb, runId: number): RunTraceDTO | null {
  const row = db.prepare(`SELECT trace_json FROM runs WHERE id = ?`).get(runId) as RunTraceRow | undefined
  if (!row) return null
  if (!row.trace_json) return { events: [] }
  try {
    return { events: JSON.parse(row.trace_json) as TraceEvent[] }
  } catch {
    return { events: [] }
  }
}

// ---- 2026-08-12（无活 UI 端点裁决）：buildLibrarySeriesDetail 与其 5 个 DTO 已删除 ----
//
// 端点 GET /api/v2/library/series/:id 同批删除。它与上方三族是同一个病例：数据面长在
// series/episodes 旧表（生产 0 行），消费面在 Task ⑪ 之后归零——AppShell 删掉旧 library
// 分支时把 useLibrarySeriesDetail 的调用一并删了，只留下几行提到它的注释。
//
// ⚠️ 它的**惰性 TMDB 应有集回填**（命中真实 series 时 fire-and-forget refreshSeriesCatalog，
// G2 遗留）不是随手扔掉的：那条回填今天由 daemonV2 的 boot pass 承担（R-F5，生产
// tmdb_seasons 2144 行），不再依赖有人访问详情页来触发。所以删这个端点**不会**让应有集
// 停止更新——这一点是删之前实测确认过的，不是推断。
//
// 应有集的读取方仍是 tmdbCatalog.canonicalEpisodes（活着，media 详情页在用）。

// ---- triage（甄别台）：pending=park 救援清单 —— **已随 parked 族整体删除，2026-08-13** ----
// 论证在上方 Parked 段，不重抄。（claimed 半边此前已随 identify_overrides 表退役。）

// ---- workflow/redispatch（人类扳手①：手动重派）----

export { redispatch, type RedispatchResult } from '../v2/triageOps.js'
