// src/dashboard/apiV2.ts
// v2 媒体库只读数据层：纯函数收 ScoutDb 返回 DTO（对照 api.ts 风格）。海报直接暴露 TMDB
// poster_path，前端自行拼 CDN URL（image.tmdb.org，公开、免 key）——不再经服务端代理。
import { resolve } from 'node:path'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { z } from 'zod'
import type { ScoutDb } from '../v2/db.js'
import { LibraryRepo } from '../v2/libraryRepo.js'
import { SettingsRepo, findOverlappingRoot } from '../v2/settingsRepo.js'
import { traceBus, type TraceEvent } from '../core/traceBus.js'
import { parseTargetLanguages } from '../cli/targetLanguages.js'
// R-F15 缺口③：换目标语言 → 全库重判（清判决列 + 按 sidecar_langs 重导 sub_status）。
// 实现放在 v2/ 而不是这里：它是库层语义（且要能被 daemon 侧测试直接调），dashboard 只是触发者。
import { retargetForLanguageChange } from '../v2/retarget.js'

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

// ---- Parked (去 Jellyfin 化 P6：最小 park 救援——一次性脚手架，不做搜索/候选/批量) ----

export interface ParkedItemDTO {
  path: string
  parkReason: string
  firstSeen: number
  lastAttempt: number
}

/** park 救援页列表：转发 LibraryRepo.listParkedPaths()（已 first_seen DESC 排序，挂得最久的排最前）。 */
export function buildParked(db: ScoutDb): ParkedItemDTO[] {
  return new LibraryRepo(db).listParkedPaths().map((p) => ({
    path: p.path,
    parkReason: p.park_reason,
    firstSeen: p.first_seen,
    lastAttempt: p.last_attempt,
  }))
}

export { unexclude, type UnexcludeResult } from '../v2/triageOps.js'

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
  const resolved = resolve(rawPath)
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
    if (targetsChanged) retargetForLanguageChange(settingsRepo.db, parseTargetLanguages(nextTargets), now)
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
  const resolved = resolve(rawPath)
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

// ---- workflow/pending：缺口事实 + parked 计数 + 顶栏新鲜度行 ----

export interface WorkflowPendingSeriesDTO {
  seriesId: string
  seriesName: string
  season: number
  missing: number
  throttled: number
  nextRecheckAt: number | null
  sampleReason: string | null
}
export interface WorkflowPendingMovieDTO {
  id: string
  name: string
  missing: 0 | 1
  throttled: 0 | 1
  nextRecheckAt: number | null
  sampleReason: string | null
}
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
  /** episodes + movies 两表行数之和——库内文件总量的机械计数。 */
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
   *  两个裸计数，不是百分比——铺量期用它能看出"还在推进"，稳态下两者相等。 */
  verifiedItems: number
  verifiableItems: number
}
export interface WorkflowPendingDTO {
  series: WorkflowPendingSeriesDTO[]
  movies: WorkflowPendingMovieDTO[]
  parked: number
  meta: WorkflowFreshnessDTO
}

/** GET /api/v2/workflow/pending：libraryRepo.missingBySeason/missingMovies 直译 camelCase +
 *  parked_paths 计数 + 顶栏新鲜度行。纯读聚合，不做任何"该不该派"的判断——那是 orchestrator
 *  的事，这里只把缺口事实摆出来。 */
export function buildWorkflowPending(
  db: ScoutDb, settingsRepo: Pick<SettingsRepo, 'listRoots'>, now: number,
): WorkflowPendingDTO {
  const lib = new LibraryRepo(db)

  const series: WorkflowPendingSeriesDTO[] = lib.missingBySeason(now).map((r) => ({
    seriesId: r.series_id, seriesName: r.series_name, season: r.season,
    missing: r.missing, throttled: r.throttled, nextRecheckAt: r.next_recheck_at, sampleReason: r.sample_reason,
  }))
  const movies: WorkflowPendingMovieDTO[] = lib.missingMovies(now).map((r) => ({
    id: r.id, name: r.name, missing: r.missing, throttled: r.throttled,
    nextRecheckAt: r.next_recheck_at, sampleReason: r.sample_reason,
  }))
  const parked = lib.listParkedPaths().length

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
  const filesRow = db
    .prepare(`SELECT (SELECT COUNT(*) FROM episodes) + (SELECT COUNT(*) FROM movies) AS c`)
    .get() as { c: number }

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
    series, movies, parked,
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

// ---- workflow/workers：跑中的 worker_task + 近期非 orchestrate runs ----

export interface WorkflowRunningWorkerDTO {
  jobId: number
  seriesId: string | null
  movieId: string | null
  taskType: string | null
  seasons: number[] | null
  /** 验收修复轮一收官补刀（spec §B 铁律①）：跑中卡头主语=剧/片名，LEFT JOIN series/movies
   *  取 name（空名/查无→null，前端降级显示 id——诚实兜底）。 */
  seriesName: string | null
  movieName: string | null
  /** 活动页铁律「必须有图」：同 name 那对，从已经 LEFT JOIN 上的 series/movies 顺手多 SELECT 两
   *  列（不新增查询/端点）。只给 TMDB path，URL 由前端自拼（web/src/api/client.ts 的 posterUrl/
   *  backdropUrl 免 key 直连 TMDB），同 LibraryItemDTO/SeriesDetailDTO 的既有分工。
   *
   *  ⚠️ 不对称（不是 bug，别当 bug 修）：`series` 表有 poster_path + backdrop_path，`movies` 表
   *  只有 poster_path，没有 backdrop 列（src/v2/db.ts：backdrop_path 只在 v16 那条 ALTER 给
   *  series 加过；movies 建表与两次 v15 重建都没有这一列）。所以：
   *    - series 命中 → posterPath 可能有值，backdropPath 可能有值
   *    - movies 命中 → posterPath 可能有值，backdropPath **恒为 null**（前端据此走「模糊海报当
   *      背景」的降级路径，不要以为是数据缺失事故）
   *    - LEFT JOIN 两边都未命中（name 也是 null 的那种行）→ 两个字段都 null */
  posterPath: string | null
  backdropPath: string | null
  /** jobs.lease_started_at——本轮 claim 发生的时刻，作为"这个尝试何时开始"的**稳定**锚点。
   *  关键：它不同于 updated_at——renewLease 心跳每 tick 把 updated_at 刷到 ~now，而
   *  lease_started_at 只在 claimNext 落一次、续租绝不触碰。活动页 hero 的"已进行 N 秒"秒表
   *  据此计算 now-startedAtLease；早先错锚 updated_at 时，秒表每 15s 轮询后归零、在屏上冻住
   *  （2026-08-01 实机盯页面发现，见 db.ts v29 迁移与 buildWorkflowWorkers 的兜底注释）。 */
  startedAtLease: number
  /** traceBus.peek(`job-${jobId}`, 20) 的直播补拉——非破坏性读尾部 20 条，不影响该 job 收官时
   *  的 snapshot。 */
  trail: TraceEvent[]
}
export interface WorkflowRecentRunDTO {
  /** R2D-1（R2 复审）：runs.id——worker run 详情入口的身份键（RunDetail 打开哪一行、React key，
   *  同一个 job 可能有多行 runs，jobId 不足以定位具体是哪一行）。 */
  id: number
  jobId: number | null
  decision: string | null
  detail: string | null
  finishedAt: number | null
  /** R2D-1：该行关联 job 的 series_id（LEFT JOIN jobs）——RunDetail 的 Rerun 按钮据此判断是否
   *  可用（同 Rerun 扳手的既有口径：只认 seriesId，movie 目标没有这个扳手）。job 已不存在/
   *  job_id 为 NULL 时降级 null，不炸查询。 */
  seriesId: string | null
  /** R2D-1：同 seriesId，movie_id（find_subtitle 的 movie 目标）——目前只用于展示，Rerun 只认
   *  seriesId。 */
  movieId: string | null
  /** 验收修复轮一 Task V3（design §B）：seriesId 对应行的 series.name（LEFT JOIN series）——
   *  Workflow 叙事化用它替换裸 tmdb id 呈现（"Searching subtitles for {seriesName}"式人话
   *  句）。空名（P6 认领占位/尚未富化的 ''）诚实降级为 null，不假装有名字；seriesId 为 null 时
   *  同样为 null。 */
  seriesName: string | null
  /** 同 seriesName，movieId 对应行的 movies.name（LEFT JOIN movies）。 */
  movieName: string | null
  /** 活动页铁律「必须有图」：同 WorkflowRunningWorkerDTO 的同名两字段，口径一字不差——从已经
   *  LEFT JOIN 上的 series/movies 多 SELECT 两列，只给 path 不给 URL。
   *
   *  ⚠️ 同一处不对称（不是 bug）：`movies` 表没有 backdrop_path 列（只有 series 有），所以 movie
   *  目标的 backdropPath **恒为 null**，前端据此走「模糊海报当背景」降级；两边都未命中时两个字段
   *  都 null。详见 WorkflowRunningWorkerDTO.posterPath 上方的完整说明。 */
  posterPath: string | null
  backdropPath: string | null
  /** 审计 UX-P0:LLM 调用账本（runs.llm_calls,翻译 run 写入;find/realign 为 null）——Workflow
   *  ActivityRow 的"· N calls"成本后缀数据源。 */
  llmCalls: number | null
}
export interface WorkflowHeldJobDTO {
  /** 审计 UX-P0:held(fail-closed 质量闸拦下)落库后不再隐身——failed + next_retry_at 未来的
   *  worker_task 行。itemId 取 payload.itemId(translate 合成行),缺省回退 seriesId。 */
  jobId: number
  itemId: string | null
  reason: string | null
  nextRetryAt: number | null
  errorAttempt: number
  /** 剧名 / 片名（2026-07-31 审计 C-3）。此前前端靠 recent[] 按 jobId 反查名字与海报，
   *  但 held 停留是**天级**（heldBackoffMs +1d/+3d/+7d），recent 是 ORDER BY finished_at
   *  DESC LIMIT 20 的滑动窗口——生产节奏（每小时 20 条）下一小时内就被挤出，此后 join 恒
   *  MISS：卡死态没有图（违反 L4「必须有图」），且降级显示 tmdb:1396/s12e04 这种技术
   *  标识符（违反 L3「不暴露机械」）。 */
  seriesName: string | null
  movieName: string | null
  posterPath: string | null
  /** 仅 series 有值——movies 表没有 backdrop_path 列。电影恒 null，前端据此走模糊海报降级。 */
  backdropPath: string | null
}
export interface WorkflowWorkersDTO {
  running: WorkflowRunningWorkerDTO[]
  recent: WorkflowRecentRunDTO[]
  /** 验收修复轮一 Task V3（design §B）：顶部总览句"N episodes installed in the last 24h"的
   *  数据源——runs 里 decision='installed' 且 finished_at > now-86400e3 的计数，独立 COUNT
   *  查询（一句 SQL）。now 由调用方传入（沿 buildWorkflowPending 的既有 now 传参先例）。 */
  installedLast24h: number
  /** 审计 UX-P0:同口径 translate:installed 的 24h 计数——SummaryLine"N translated"段数据源。 */
  translatedLast24h: number
  /** 审计 UX-P0:held 队列(见 WorkflowHeldJobDTO)。 */
  held: WorkflowHeldJobDTO[]
  /** 债务 D3：provider 配额事实句数据源——settings 旁路键 quota_state_*（见 cli/quotaState.ts）。
   *  读侧滤除已过期（resetAt 早于 now）的条目；值 JSON 解析失败 fail-soft 跳过整条。 */
  providerQuota: Array<{ provider: string; resetAt: string | null; observedAt: number }>
}

/** worker_task 的 payload JSON 里取 taskType/seasons——容错解析（同 buildLibrary 对 worker_task
 *  payload 的既有查法口径一致），格式异常一律降级为 null，不炸聚合查询。 */
function parseWorkerTaskPayload(payload: string | null): { taskType: string | null; seasons: number[] | null } {
  if (!payload) return { taskType: null, seasons: null }
  try {
    const parsed = JSON.parse(payload) as { taskType?: unknown; seasons?: unknown }
    const taskType = typeof parsed.taskType === 'string' ? parsed.taskType : null
    const seasons = Array.isArray(parsed.seasons)
      ? parsed.seasons.filter((s): s is number => typeof s === 'number')
      : null
    return { taskType, seasons }
  } catch {
    return { taskType: null, seasons: null }
  }
}

/** 空字符串（P6 认领占位/尚未富化的 name 列）诚实降级为 null——同 sectionForItem 一带的
 *  "已知债务如实标注"口径，不假装一个空名剧/空名片有名字。 */
function nullIfEmpty(name: string | null): string | null {
  return name != null && name !== '' ? name : null
}

/** GET /api/v2/workflow/workers：running=jobs 里 state='searching' 且 kind='worker_task' 的
 *  跑中行（附 traceBus.peek 直播补拉）；recent=非 orchestrate 的 runs 行（find_subtitle/realign
 *  worker 各自产出的收工记录，附 LEFT JOIN series/movies 取的 name，供 Workflow 叙事化的人话句
 *  使用），finished_at 降序 limit 20；installedLast24h=独立 COUNT 查询，验收修复轮一 Task V3
 *  （design §B）：顶部总览句"N episodes installed in the last 24h"的数据源。now 由调用方传入
 *  （沿 buildWorkflowPending 的既有 now 传参先例）。 */
export function buildWorkflowWorkers(db: ScoutDb, now: number): WorkflowWorkersDTO {
  // 验收修复轮一收官补刀：running 卡头的主语也要是剧名不是 tmdb id（spec §B 铁律①——V3 只给
  // recent 加了 name join，跑中行漏了同款待遇）。LEFT JOIN 手法与下方 recent 查询一致。
  const runningRows = db
    .prepare(
      `SELECT j.id, j.series_id, j.movie_id, j.payload, j.updated_at, j.lease_started_at,
              s.name AS series_name, m.name AS movie_name,
              s.poster_path AS series_poster_path, s.backdrop_path AS series_backdrop_path,
              m.poster_path AS movie_poster_path
       FROM jobs j
       LEFT JOIN series s ON s.id = j.series_id
       LEFT JOIN movies m ON m.id = j.movie_id
       WHERE j.state = 'searching' AND j.kind = 'worker_task'`
    )
    .all() as {
      id: number; series_id: string | null; movie_id: string | null; payload: string | null
      updated_at: number; lease_started_at: number | null; series_name: string | null; movie_name: string | null
      series_poster_path: string | null; series_backdrop_path: string | null
      movie_poster_path: string | null
    }[]

  const running: WorkflowRunningWorkerDTO[] = runningRows.map((r) => {
    const { taskType, seasons } = parseWorkerTaskPayload(r.payload)
    // R2D-13（R2 复审）：realign 字幕先行阶段逐集起 `job-${jobId}-${absoluteEpisode}` runKey
    // （见 src/v2/realignWorkerTask.ts 的同名注释）——单 runKey 的 peek 永远拿不到这些子集事件，
    // realign WorkerCard 因此直播空转。taskType==='realign' 时改用 peekPrefix 合并读全部子集
    // 缓冲；其余 taskType（find_subtitle）只有一个 runKey，维持 peek 原样。
    const trail = taskType === 'realign'
      ? traceBus.peekPrefix(`job-${r.id}-`, 20)
      : traceBus.peek(`job-${r.id}`, 20)
    return {
      jobId: r.id, seriesId: r.series_id, movieId: r.movie_id, taskType, seasons,
      seriesName: nullIfEmpty(r.series_name), movieName: nullIfEmpty(r.movie_name),
      // 铁律「必须有图」：series 优先、movie 兜底（一行 job 只会命中其中一边）。backdrop 只可能
      // 来自 series——movies 表没有 backdrop_path 列，movie 目标恒 null（见 DTO 注释的不对称说明）。
      posterPath: nullIfEmpty(r.series_poster_path) ?? nullIfEmpty(r.movie_poster_path),
      backdropPath: nullIfEmpty(r.series_backdrop_path),
      // 秒表锚点：lease_started_at（claim 时刻，心跳续租不动它）。?? updated_at 兜底存量在飞行中
      // 的行——v29 迁移前就 searching 的 job 此列为 null，退回旧口径（会略有前移，但只影响那批
      // 一次性的存量行，且容器重启后它们会被 reap 重新 claim 而填上真值）。见 db.ts v29 迁移注释。
      startedAtLease: r.lease_started_at ?? r.updated_at, trail,
    }
  })

  // R2D-1（R2 复审）：worker run 详情入口需要 runs.id（身份键）+ 该行所属 job 的 series_id/
  // movie_id（Rerun 按钮判据）——LEFT JOIN（不是 JOIN）：job_id 为 NULL 或指向的 job 行已不存在
  // 时该行仍要出现在 recent 里，只是 seriesId/movieId 降级 null，不能因为关联缺失就整行消失。
  // 验收修复轮一 Task V3（design §B）：再 LEFT JOIN series/movies 取 name——同样的"缺失不删行、
  // 降级为 null"口径，series_id/movie_id 本身为 NULL，或指向的行不存在/name 是空串占位，都不该
  // 让整行 recent 消失或假装有名字。
  const recentRows = db
    .prepare(
      `SELECT r.id AS id, r.job_id AS job_id, r.decision AS decision, r.detail AS detail,
              r.finished_at AS finished_at, r.llm_calls AS llm_calls,
              j.series_id AS series_id, j.movie_id AS movie_id,
              s.name AS series_name, m.name AS movie_name,
              s.poster_path AS series_poster_path, s.backdrop_path AS series_backdrop_path,
              m.poster_path AS movie_poster_path
       FROM runs r LEFT JOIN jobs j ON r.job_id = j.id
       LEFT JOIN series s ON j.series_id = s.id
       LEFT JOIN movies m ON j.movie_id = m.id
       WHERE r.decision IS NULL OR r.decision != 'orchestrate'
       ORDER BY r.finished_at DESC LIMIT 20`
    )
    .all() as {
      id: number; job_id: number | null; decision: string | null; detail: string | null
      finished_at: number | null; llm_calls: number | null; series_id: string | null; movie_id: string | null
      series_name: string | null; movie_name: string | null
      series_poster_path: string | null; series_backdrop_path: string | null
      movie_poster_path: string | null
    }[]
  const recent: WorkflowRecentRunDTO[] = recentRows.map((r) => ({
    id: r.id, jobId: r.job_id, decision: r.decision, detail: r.detail, finishedAt: r.finished_at,
    seriesId: r.series_id, movieId: r.movie_id,
    seriesName: nullIfEmpty(r.series_name), movieName: nullIfEmpty(r.movie_name),
    // 同 running 的口径：series 优先、movie 兜底；backdrop 只可能来自 series（movies 无此列）。
    posterPath: nullIfEmpty(r.series_poster_path) ?? nullIfEmpty(r.movie_poster_path),
    backdropPath: nullIfEmpty(r.series_backdrop_path),
    llmCalls: r.llm_calls,
  }))

  const installedRow = db
    .prepare(`SELECT COUNT(*) AS c FROM runs WHERE decision = 'installed' AND finished_at > ?`)
    .get(now - 86_400_000) as { c: number }
  const translatedRow = db
    .prepare(`SELECT COUNT(*) AS c FROM runs WHERE decision = 'translate:installed' AND finished_at > ?`)
    .get(now - 86_400_000) as { c: number }

  // 审计 UX-P0:held 队列——failed + 未来重试时刻的 worker_task;payload.itemId(translate 合成行)
  // 优先,缺省回退 series_id。同 parseWorkerTaskPayload 的容错口径:payload 坏了 itemId 降级 null。
  // 名字与海报（2026-07-31 审计 C-3）：LEFT JOIN 照抄 running/recent 那两处，不新增查询。
  // 前端原先靠 recent[] 按 jobId 反查，一小时后必然 MISS——理由见 DTO 字段注释。
  const heldRows = db
    .prepare(
      `SELECT j.id, j.series_id, j.movie_id, j.payload, j.last_error, j.next_retry_at,
              j.error_attempt,
              s.name AS series_name, m.name AS movie_name,
              s.poster_path AS series_poster_path, s.backdrop_path AS series_backdrop_path,
              m.poster_path AS movie_poster_path
       FROM jobs j
       LEFT JOIN series s ON s.id = j.series_id
       LEFT JOIN movies m ON m.id = j.movie_id
       WHERE j.state = 'failed' AND j.kind = 'worker_task'
         AND j.next_retry_at IS NOT NULL AND j.next_retry_at > ?`,
    )
    .all(now) as {
      id: number; series_id: string | null; movie_id: string | null; payload: string | null
      last_error: string | null; next_retry_at: number | null; error_attempt: number
      series_name: string | null; movie_name: string | null
      series_poster_path: string | null; series_backdrop_path: string | null
      movie_poster_path: string | null
    }[]
  const held: WorkflowHeldJobDTO[] = heldRows.map((r) => {
    let itemId: string | null = null
    try {
      const p = JSON.parse(r.payload ?? '{}') as { itemId?: unknown }
      if (typeof p.itemId === 'string' && p.itemId) itemId = p.itemId
    } catch { /* 降级 seriesId */ }
    return {
      jobId: r.id, itemId: itemId ?? r.series_id,
      reason: r.last_error, nextRetryAt: r.next_retry_at, errorAttempt: r.error_attempt,
      // series 优先、movie 兜底（同 running/recent 的既有扁平化口径）。都查无 → null。
      seriesName: nullIfEmpty(r.series_name), movieName: nullIfEmpty(r.movie_name),
      posterPath: nullIfEmpty(r.series_poster_path) ?? nullIfEmpty(r.movie_poster_path),
      backdropPath: nullIfEmpty(r.series_backdrop_path),
    }
  })

  const settingsRepo = new SettingsRepo(db)
  const providerQuota: WorkflowWorkersDTO['providerQuota'] = []
  for (const { key, value } of settingsRepo.listByPrefix('quota_state_')) {
    try {
      const parsed = JSON.parse(value) as { resetAt?: unknown; observedAt?: unknown }
      const resetAt = typeof parsed.resetAt === 'string' ? parsed.resetAt : null
      const observedAt = typeof parsed.observedAt === 'number' ? parsed.observedAt : null
      if (observedAt === null) continue
      if (resetAt !== null) {
        const resetMs = Date.parse(resetAt)
        if (Number.isNaN(resetMs) || resetMs < now) continue
      }
      providerQuota.push({ provider: key.slice('quota_state_'.length), resetAt, observedAt })
    } catch {
      // JSON parse 失败或非法形状 fail-soft：跳过垃圾值，不炸聚合端点
    }
  }

  return { running, recent, installedLast24h: installedRow.c, translatedLast24h: translatedRow.c, held, providerQuota }
}

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

// ---- triage（甄别台）：pending=park 救援清单 ----
// claimed 半边（buildClaimedOverrides / ClaimedOverrideDTO）已随 identify_overrides 表退役
// （两证据红线裁决，见 src/v2/triageOps.ts 头注释）：甄别页只剩"看见待识别文件"这一个职能，
// 修复动作是改文件名，不是在面板里指派身份。

export interface TriageDTO {
  pending: ParkedItemDTO[]
}

/** GET /api/v2/triage：pending 转发 buildParked（含 reason）——甄别台看全"待认领"事实。 */
export function buildTriage(db: ScoutDb): TriageDTO {
  return { pending: buildParked(db) }
}

// ---- workflow/redispatch（人类扳手①：手动重派）----

export { redispatch, type RedispatchResult } from '../v2/triageOps.js'
