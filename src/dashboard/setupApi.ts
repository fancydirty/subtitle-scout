// src/dashboard/setupApi.ts：启动面（spec A §4.4）——setup/status DTO 组装、secrets PUT、
// providers DTO、validate 薄壳，纯函数层（不碰 HTTP/socket，server.ts 只做接线）。
// 纪律：任何返回值都不得含密钥明文（序列化面只有 masked）；validate 失败走分类文案，
// 不把原始异常 detail 回前端（可能 echo 凭据，spec §8）；secret_test:* 用 settingsRepo.set
// 直写——不 bump secrets_version（测试不是配置变更，不能触发客户端热重建）。

import { generateText } from 'ai'
import type { SettingsRepo } from '../v2/settingsRepo.js'
import { isSecretName, maskSecretValue, resolveProviderFlagFromSettings, resolveSecretFromSettings, type SecretName, type SecretSource } from '../v2/secrets.js'
import {
  checkAssrt, checkJimaku, checkLlm, checkOpenSubtitles, checkSubhd, checkTmdb, checkZimuku, withTimeout,
} from '../cli/doctor.js'
import { TmdbClient } from '../adapters/providers/tmdb.js'
import { AssrtClient } from '../adapters/providers/assrt.js'
import { OpenSubtitlesClient } from '../adapters/providers/opensubtitles.js'
import { JimakuClient } from '../adapters/providers/jimaku.js'
import { SUBHD_BASE, curlFetch } from '../adapters/providers/subhd.js'
import { ZIMUKU_BASE } from '../adapters/providers/zimuku.js'
import { detectChallenge } from '../adapters/providers/yunsuo.js'
import { makeModel } from '../agent/llm.js'
import { QUOTA_STATE_PREFIX } from '../cli/quotaState.js'
import { join } from 'node:path'

// ---------- DTO ----------

export interface SetupSecretStateDTO {
  satisfied: boolean
  source: SecretSource
  masked: string | null
}

export interface SetupStatusDTO {
  bootstrapComplete: boolean
  tmdb: SetupSecretStateDTO
  llm: { satisfied: boolean; source: SecretSource; model: string | null }
  providers: {
    assrt: SetupSecretStateDTO
    opensubtitles: { satisfied: boolean; source: SecretSource; hasUsername: boolean; masked: string | null }
    jimaku: SetupSecretStateDTO
    subhd: { enabled: boolean; source: SecretSource }
    zimuku: { enabled: boolean; source: SecretSource; captchaReady: boolean }
  }
  roots: { count: number }
  engineEnabled: boolean
}

export interface SecretTestDTO { ok: boolean; at: number; error?: string }

/** 配额耗尽事实（settings 旁路键 `quota_state_<provider>`，写入方见 cli/quotaState.ts）。
 *  `resetAt`=provider 报的重置时刻（ISO，OS 的 reset_time_utc；provider 没给就是 null，
 *  那时只知道"耗尽了"不知道"何时恢复"——UI 必须如实说不知道，不许编一个时间）；
 *  `observedAt`=我们观测到这件事的本地毫秒时刻。 */
export interface ProviderQuotaDTO { resetAt: string | null; observedAt: number }

export interface ProviderRowDTO {
  id: 'tmdb' | 'llm' | 'translate' | 'assrt' | 'opensubtitles' | 'jimaku' | 'subhd' | 'zimuku'
  secrets: { name: SecretName; set: boolean; source: SecretSource; masked: string | null }[]
  lastTest: SecretTestDTO | null
  /** 该源当前是否处于"配额已耗尽"状态；null=没有这个事实（正常，绝大多数时候如此）。
   *  **挂在 provider 行上而不是另起一个聚合 DTO**：见 buildProviders 上方的落点论证。 */
  quota: ProviderQuotaDTO | null
}

export interface ProvidersDTO { providers: ProviderRowDTO[] }

export interface SetupDeps {
  settingsRepo: SettingsRepo
  env: NodeJS.ProcessEnv
  cacheRoot: string
  rootsCount: () => number
  now: () => number
  /** 测试注入点：按 target 覆盖真实 probe，不真打网络。 */
  probes?: Partial<Record<ValidateTarget, ValidateProbe>>
}

// ---------- setup/status ----------

function secretState(r: { value: string | null; source: SecretSource }, mask: (v: string) => string): SetupSecretStateDTO {
  return {
    satisfied: r.source !== 'none',
    source: r.source,
    masked: r.value === null ? null : mask(r.value),
  }
}

export function buildSetupStatus(deps: SetupDeps): SetupStatusDTO {
  const { settingsRepo, env: _env } = deps
  const dbGet = (key: string) => settingsRepo.get(key)
  const sec = (name: SecretName) => resolveSecretFromSettings(name, (n) => dbGet(`secret:${n}`))
  // 脱敏规则只有一份：从 secrets.ts 导入（Task 1 的 maskSecretValue，≥8 位取首尾 3 位，
  // <8 位整体 ••••）。不要在这里再写一遍——两份实现会各自漂移。
  const mask = maskSecretValue

  const tmdb = sec('TMDB_API_KEY')
  const llmBase = sec('LLM_BASE_URL')
  const llmKey = sec('LLM_API_KEY')
  const llmModel = sec('LLM_MODEL')
  // spec §4.4：LLM satisfied = 三件套全部可解析；source 是展示用近似（混合形态报 env）。
  const llmSatisfied = llmBase.source !== 'none' && llmKey.source !== 'none' && llmModel.source !== 'none'
  const llmSource: SecretSource = !llmSatisfied ? 'none'
    : [llmBase.source, llmKey.source, llmModel.source].includes('env') ? 'env' : 'db'

  const osKey = sec('OPENSUBTITLES_API_KEY')
  const osUser = sec('OPENSUBTITLES_USERNAME')
  const osPass = sec('OPENSUBTITLES_PASSWORD')
  const subhd = resolveProviderFlagFromSettings('SUBHD_ENABLED', dbGet)
  const zimuku = resolveProviderFlagFromSettings('ZIMUKU_ENABLED', dbGet)

  return {
    // spec §3 决策 1：推导式触发——TMDB + LLM 齐 = bootstrap 完成，无独立标志位。
    bootstrapComplete: tmdb.source !== 'none' && llmSatisfied,
    tmdb: secretState(tmdb, mask),
    llm: { satisfied: llmSatisfied, source: llmSource, model: llmModel.value },
    providers: {
      assrt: secretState(sec('ASSRT_TOKEN'), mask),
      opensubtitles: {
        satisfied: osKey.source !== 'none',
        source: osKey.source,
        // spec §4.4：username+password 成对才算 hasUsername；单填视为未填（客户端本就容忍仅 key）。
        hasUsername: osUser.source !== 'none' && osPass.source !== 'none',
        masked: osKey.value === null ? null : mask(osKey.value),
      },
      jimaku: secretState(sec('JIMAKU_API_KEY'), mask),
      subhd: { enabled: subhd.enabled, source: subhd.source },
      // spec §3 步骤 5：captchaReady = LLM 三件套可解析（wizard 展示；后端入列守卫在 buildAdapters）。
      zimuku: { enabled: zimuku.enabled, source: zimuku.source, captchaReady: llmSatisfied },
    },
    roots: { count: deps.rootsCount() },
    // spec §4.6：fail-open——只有显式 'false' 才视为关，脏值/缺省一律开。
    engineEnabled: settingsRepo.get('engine_enabled') !== 'false',
  }
}

// ---------- PUT secrets ----------

export type PutSecretResult =
  | { ok: true; name: SecretName; action: 'set' | 'deleted' }
  | { ok: false; error: string }

export function putSecret(
  deps: SetupDeps,
  body: unknown,
  log: (msg: string) => void,
): { status: number; body: PutSecretResult } {
  const b = (body ?? {}) as { name?: unknown; value?: unknown }
  if (typeof b.name !== 'string' || !isSecretName(b.name)) {
    return { status: 400, body: { ok: false, error: 'unknown secret name' } }
  }
  if (typeof b.value !== 'string') {
    return { status: 400, body: { ok: false, error: 'value must be a string' } }
  }
  const name = b.name
  if (b.value === '') {
    // spec §4.4：空字符串 = 删除语义。
    deps.settingsRepo.deleteSecret(name, deps.now())
    log(`secret deleted: ${name}`)   // 审计日志只记 name，永不记 value（spec §4.4）
    return { status: 200, body: { ok: true, name, action: 'deleted' } }
  }
  deps.settingsRepo.setSecret(name, b.value, deps.now())
  log(`secret set: ${name}`)
  return { status: 200, body: { ok: true, name, action: 'set' } }
}

// ---------- providers DTO ----------

const PROVIDER_SECRETS: Record<ProviderRowDTO['id'], SecretName[]> = {
  tmdb: ['TMDB_API_KEY'],
  llm: ['LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL'],
  translate: ['TRANSLATE_BASE_URL', 'TRANSLATE_API_KEY', 'TRANSLATE_MODEL'],
  assrt: ['ASSRT_TOKEN'],
  opensubtitles: ['OPENSUBTITLES_API_KEY', 'OPENSUBTITLES_USERNAME', 'OPENSUBTITLES_PASSWORD'],
  jimaku: ['JIMAKU_API_KEY'],
  subhd: [],
  // zimuku 自身**无凭据**（是个开关型源，可达性即可用）。这三个 ZIMUKU_VISION_* 不是
  // "zimuku 的登录凭据"，是它验证码破解的**可选视觉兜底**——模板匹配未命中时才降级调用
  // （buildAdapters.ts:58-74；缺席时模板未命中直接失败，不会尝试 LLM）。
  //
  // 挂在 zimuku 行下而不是新开一个 `zimuku_vision` provider 行：它不是字幕源，没有
  // 自己的 validate 探针（ZimukuVisionCard 的测试走独立的 POST /api/v2/test-vision，
  // 不走 setup/validate），也不该在 Providers 的 n/8 计数里占一格。它就是 zimuku 的
  // 一项配置，DTO 上也该长在 zimuku 这一行。
  //
  // ⚠️ 消费方注意：zimuku 行从此 `secrets.length > 0`。前端凡是用
  // "secrets 非空" 当 "这是张 keyed 凭据卡" 判据的地方，都必须显式排除 zimuku
  // （见 web/src/settings/SettingsTabsPage.tsx 的 keyedRows）——否则 zimuku 会
  // 既渲染成开关卡又渲染成凭据卡，且在 n/8 里被数两次。
  zimuku: ['ZIMUKU_VISION_BASE_URL', 'ZIMUKU_VISION_API_KEY', 'ZIMUKU_VISION_MODEL'],
}

function readLastTest(deps: SetupDeps, target: ValidateTarget): SecretTestDTO | null {
  const raw = deps.settingsRepo.get(`secret_test:${target}`)
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw) as { ok?: unknown; at?: unknown; error?: unknown }
    if (typeof parsed.ok !== 'boolean' || typeof parsed.at !== 'number') return null
    return { ok: parsed.ok, at: parsed.at, ...(typeof parsed.error === 'string' ? { error: parsed.error } : {}) }
  } catch {
    return null
  }
}

/**
 * `quota_state_*` 旁路键 → 按 provider id 索引的配额事实。**fail-soft**：值是 JSON 解析
 * 失败、形状不对、或 observedAt 不是数字，一律跳过该条（垃圾值不许炸整个 providers 端点——
 * 这个端点是设置页的主数据源，它 500 等于用户连凭据都看不见了）。
 *
 * **过期条目就地滤除**：`resetAt` 早于 now 说明配额窗口已经翻篇，事实已经不成立。
 * （清键的正路是 `/download` 200 → applyQuotaEvent 的 delete 分支，但那要等下一次真实调用；
 *  在此之前读侧不能把一条过期事实当现况展示——那正是"为什么 assrt 不找了"的反向误导。）
 * `resetAt === null`（provider 没告诉我们何时恢复）**不滤**：不知道重置时刻不等于已经重置，
 * 这一条只能等 `/download` 成功来清，读侧按"耗尽，恢复时间未知"如实展示。
 */
function readProviderQuotas(deps: SetupDeps): Map<string, ProviderQuotaDTO> {
  const now = deps.now()
  const out = new Map<string, ProviderQuotaDTO>()
  for (const { key, value } of deps.settingsRepo.listByPrefix(QUOTA_STATE_PREFIX)) {
    try {
      const parsed = JSON.parse(value) as { resetAt?: unknown; observedAt?: unknown }
      if (typeof parsed.observedAt !== 'number') continue
      const resetAt = typeof parsed.resetAt === 'string' ? parsed.resetAt : null
      if (resetAt !== null) {
        const resetMs = Date.parse(resetAt)
        if (Number.isNaN(resetMs) || resetMs < now) continue
      }
      out.set(key.slice(QUOTA_STATE_PREFIX.length), { resetAt, observedAt: parsed.observedAt })
    } catch {
      // 非法 JSON：跳过这一条，其余 provider 的行照常产出
    }
  }
  return out
}

/**
 * ── `quota` 字段的落点论证（2026-08-13，接上一轮主动记入的债务）─────────────────
 *
 * 上一轮删 `buildWorkflowWorkers` 时，`quota_state_*` 的**唯一读取方**随那份 DTO 一起消失，
 * 键变成只写不读。此处把读取方加回来，但**刻意不照抄**被删的 `providerQuota: Array<{...}>`：
 *
 *  · 那是一个**跨 provider 的扁平数组**，为「活动页顶部来一句事实句」而生。它的容器
 *    （workflow/workers 端点 + 旧活动页）已经整体退役，照抄它等于把一份已被取代的旧图纸
 *    再画一遍——上一轮删它给的理由，反过来同样禁止我复活它的形状。
 *  · 更要命的是**它没有身份**：一个 `provider: string` 字符串，与设置页里那一排真正的
 *    provider 行没有任何类型上的联系。而配额耗尽这件事，天然是**某一个源的属性**。
 *
 * 挂到 `ProviderRowDTO.quota` 上，换来三件事：
 *  ① provider 身份成了**类型化的**（`id` 那个联合），漂移会被 typeContract 当场抓住；
 *  ② 不新增端点、不新增 client 方法、不新增 hook——设置页本来就在拉 /setup/providers；
 *  ③ 展示位与"这个源现在能不能用"的其它事实（凭据是否配齐、上次测试通没通过）**并排**，
 *    用户不必在两页之间拼凑一个源的状态。
 *
 * ⚠️ **今天生产 0 条**（实测 2026-08-13：`settings` 全表 7 行，无 `quota_state_*`）。
 * 这**不是**"信号不产生"——OpenSubtitles 凭据在生产是配好的（env 三件套俱在），写入链
 * `applyQuotaEvent ← emitProviderEvent ← buildAdapters` 全程活着，0 条的含义是
 * **至今没撞过配额**。这正是它该有的常态：这个字段绝大多数时候是 null，只在出事那天说话。
 *
 * ⚠️ 今天**只有 opensubtitles 会写**这个键（全仓仅 opensubtitlesAdapter 发 code=
 * 'quota_exhausted'；assrt 的 provider_error 不带 code）。读侧仍按 provider id 通用索引，
 * 不硬编码 'opensubtitles'——哪天 assrt 适配器补上配额事件，UI 侧零改动就能显示。
 */
export function buildProviders(deps: SetupDeps): ProvidersDTO {
  const meta = deps.settingsRepo.listSecretMeta(deps.env)
  const quotas = readProviderQuotas(deps)
  const rows = (Object.keys(PROVIDER_SECRETS) as ProviderRowDTO['id'][]).map((id) => ({
    id,
    secrets: PROVIDER_SECRETS[id].map((name) => meta.find((m) => m.name === name)!),
    lastTest: readLastTest(deps, id),
    quota: quotas.get(id) ?? null,
  }))
  return { providers: rows }
}

// ---------- POST validate ----------

export const VALIDATE_TARGETS = ['tmdb', 'llm', 'translate', 'assrt', 'opensubtitles', 'jimaku', 'subhd', 'zimuku'] as const
export type ValidateTarget = (typeof VALIDATE_TARGETS)[number]

export interface ValidateResultDTO { ok: boolean; detail?: string; error?: string }

/** 与 doctor DoctorResult 同构的最小面（ok/skip/detail/hint）。 */
export type ValidateProbe = () => Promise<{ ok: boolean; skip?: boolean; detail?: string; hint?: string }>

/** 每个 target 的静态英文下一步提示（spec §4.4 "detail 给用户可执行的下一步"；不回原始异常串）。 */
const NEXT_STEP_HINT: Record<ValidateTarget, string> = {
  tmdb: 'Get a key at themoviedb.org → account Settings → API → API Key (v3 auth).',
  llm: 'All three fields must come from the same provider; the base URL usually ends with /v1.',
  translate: 'All three fields must come from the same provider; the base URL usually ends with /v1.',
  assrt: 'Copy your API token from assrt.net → user center.',
  opensubtitles: 'Create an API key at opensubtitles.com → your profile → API consumers.',
  jimaku: 'Copy your API key from jimaku.cc account settings.',
  subhd: 'subhd.me must be reachable from this host — check the network/proxy.',
  zimuku: 'zimuku.org must be reachable; some networks block or throttle it.',
}

/** spec §4.4 错误三分类。只模式匹配，永不回显原始串（spec §8：异常消息可能 echo 凭据）。 */
export function classifyFailure(rawDetail: string | undefined): string {
  const d = rawDetail ?? ''
  if (/401|403|unauthorized|forbidden|invalid api key|incorrect api key/i.test(d)) {
    return 'Invalid credentials — check the key and try again.'
  }
  if (/404|not found/i.test(d)) {
    return 'Not found — check the base URL and model name.'
  }
  if (/timeout|timed out|ECONNREFUSED|ECONNRESET|ENOTFOUND|fetch failed|network|socket/i.test(d)) {
    return 'Connection problem — check the network and base URL.'
  }
  return 'Test failed — check the credentials and try again.'
}

/** credentials 入参清洗：只留白名单内的非空字符串键（防注入任意配置）。 */
export function sanitizeCredentials(input: unknown): Partial<Record<SecretName, string>> {
  const out: Partial<Record<SecretName, string>> = {}
  if (input === null || typeof input !== 'object') return out
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (isSecretName(k) && typeof v === 'string' && v !== '') out[k] = v
  }
  return out
}

const VALIDATE_TIMEOUT_MS = 10_000

/** 真实 probe 组（cmdDoctor 同款构造，逐字复刻 cli/index.ts:727-788 的探测形状）。 */
function defaultProbe(
  deps: SetupDeps,
  target: ValidateTarget,
  creds: Partial<Record<SecretName, string>>,
): ValidateProbe {
  const { env, settingsRepo, cacheRoot } = deps
  const notConfigured: ReturnType<ValidateProbe> = Promise.resolve({ ok: true, skip: true, detail: 'not configured' })
  // credentials 优先，其次 env/db 已解析值——"先测后存"与"测已配的"共用一个解析口。
  const cred = (n: SecretName): string | null =>
    creds[n] ?? resolveSecretFromSettings(n, (x) => settingsRepo.get(`secret:${x}`)).value

  switch (target) {
    case 'tmdb': {
      const key = cred('TMDB_API_KEY')
      if (!key) return () => notConfigured
      const tmdb = new TmdbClient({ apiKey: key, baseUrl: env.TMDB_BASE_URL, proxyUrl: env.TMDB_PROXY_URL })
      return () => checkTmdb(() => withTimeout(tmdb.search('movie', 'The Matrix', 1999), VALIDATE_TIMEOUT_MS, 'TMDB').then((h) => h.length))
    }
    case 'llm': {
      const baseUrl = cred('LLM_BASE_URL'); const apiKey = cred('LLM_API_KEY'); const modelName = cred('LLM_MODEL')
      if (!baseUrl || !apiKey || !modelName) return () => notConfigured
      const model = makeModel({ baseUrl, apiKey, model: modelName })
      return () => checkLlm(async () =>
        (await generateText({ model, prompt: '回复"ok"两个字母即可', maxOutputTokens: 1, abortSignal: AbortSignal.timeout(VALIDATE_TIMEOUT_MS) })).text)
    }
    case 'translate': {
      const baseUrl = cred('TRANSLATE_BASE_URL'); const apiKey = cred('TRANSLATE_API_KEY'); const modelName = cred('TRANSLATE_MODEL')
      if (!baseUrl || !apiKey || !modelName) return () => notConfigured
      const model = makeModel({ baseUrl, apiKey, model: modelName })
      return () => checkLlm(async () =>
        (await generateText({ model, prompt: '回复"ok"两个字母即可', maxOutputTokens: 1, abortSignal: AbortSignal.timeout(VALIDATE_TIMEOUT_MS) })).text)
    }
    case 'assrt': {
      const token = cred('ASSRT_TOKEN')
      if (!token) return () => notConfigured
      const assrt = new AssrtClient({ token, cacheDir: join(cacheRoot, 'assrt-responses') })
      return () => checkAssrt({ quota: () => withTimeout(assrt.quota(), VALIDATE_TIMEOUT_MS, 'ASSRT') })
    }
    case 'opensubtitles': {
      const apiKey = cred('OPENSUBTITLES_API_KEY')
      if (!apiKey) return () => notConfigured
      const os = new OpenSubtitlesClient({
        apiKey, appUserAgent: 'subtitlescout v0.2.0',
        username: cred('OPENSUBTITLES_USERNAME') ?? undefined,
        password: cred('OPENSUBTITLES_PASSWORD') ?? undefined,
      })
      // The Matrix：配额免费的探测目标（cmdDoctor 同款）。
      return () => checkOpenSubtitles({
        search: () => withTimeout(os.search({ imdbId: 133093, languages: ['zh-cn'] }), VALIDATE_TIMEOUT_MS, 'OpenSubtitles'),
      })
    }
    case 'jimaku': {
      const apiKey = cred('JIMAKU_API_KEY')
      if (!apiKey) return () => notConfigured
      const jk = new JimakuClient({ apiKey })
      return () => checkJimaku(() => withTimeout(jk.search({ query: 'test' }), VALIDATE_TIMEOUT_MS, 'Jimaku'))
    }
    case 'subhd':
      // 无 key 服务，无条件探测可达性（spec §4.4）。必须 curlFetch——Node 原生 fetch 的
      // TLS 指纹会被 subhd 拒（subhd.ts:224 注释）。
      return () => checkSubhd(() =>
        withTimeout(curlFetch(env.SUBHD_BASE_URL ?? SUBHD_BASE, { signal: AbortSignal.timeout(VALIDATE_TIMEOUT_MS) }).then((r) => r.status), VALIDATE_TIMEOUT_MS, 'subhd'))
    case 'zimuku':
      // 同上：无条件探测可达性 + 云锁挑战页识别（cmdDoctor 同款构造）。
      return () => checkZimuku({
        fetchHomepage: async () => {
          const res = await withTimeout(fetch(`${ZIMUKU_BASE}/`, { signal: AbortSignal.timeout(VALIDATE_TIMEOUT_MS) }), VALIDATE_TIMEOUT_MS, 'zimuku')
          const html = await res.text()
          return { ok: res.ok, challenged: detectChallenge(html) }
        },
      })
  }
}

function toValidateDTO(target: ValidateTarget, r: { ok: boolean; skip?: boolean; detail?: string; hint?: string }): ValidateResultDTO {
  // doctor 的 skip（未配置不算失败）在 HTTP 层译为红：对 wizard 而言"没配"就该是红（spec §4.4）。
  if (r.skip) return { ok: false, error: `${target} is not configured` }
  if (r.ok) return { ok: true, ...(r.detail ? { detail: r.detail } : {}) }
  return { ok: false, error: classifyFailure(r.detail), detail: NEXT_STEP_HINT[target] }
}

export async function validateSetupTarget(
  deps: SetupDeps,
  body: unknown,
): Promise<{ status: number; body: ValidateResultDTO }> {
  const b = (body ?? {}) as { target?: unknown; credentials?: unknown }
  if (typeof b.target !== 'string' || !(VALIDATE_TARGETS as readonly string[]).includes(b.target)) {
    return { status: 400, body: { ok: false, error: 'unknown validate target' } }
  }
  const target = b.target as ValidateTarget
  const probe = deps.probes?.[target] ?? defaultProbe(deps, target, sanitizeCredentials(b.credentials))
  let r: { ok: boolean; skip?: boolean; detail?: string; hint?: string }
  try {
    r = await probe()
  } catch (e) {
    r = { ok: false, detail: `probe threw: ${e instanceof Error ? e.name : 'Error'}` }
  }
  const dto = toValidateDTO(target, r)
  // 上次测试点落库（settingsRepo.set 直写——不 bump secrets_version，测试不是配置变更）。
  try {
    deps.settingsRepo.set(
      `secret_test:${target}`,
      JSON.stringify({ ok: dto.ok, at: deps.now(), ...(dto.error ? { error: dto.error } : {}) }),
      deps.now(),
    )
  } catch { /* 落库失败不挡响应——测试点只是展示面 */ }
  return { status: 200, body: dto }
}
