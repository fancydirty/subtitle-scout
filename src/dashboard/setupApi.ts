// src/dashboard/setupApi.ts：启动面（spec A §4.4）——setup/status DTO 组装、secrets PUT、
// providers DTO、validate 薄壳，纯函数层（不碰 HTTP/socket，server.ts 只做接线）。
// 纪律：任何返回值都不得含密钥明文（序列化面只有 masked）；validate 失败走分类文案，
// 不把原始异常 detail 回前端（可能 echo 凭据，spec §8）；secret_test:* 用 settingsRepo.set
// 直写——不 bump secrets_version（测试不是配置变更，不能触发客户端热重建）。

import { generateText } from 'ai'
import type { SettingsRepo } from '../v2/settingsRepo.js'
import { isSecretName, maskSecretValue, resolveProviderFlag, resolveSecret, type SecretName, type SecretSource } from '../v2/secrets.js'
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

export interface ProviderRowDTO {
  id: 'tmdb' | 'llm' | 'assrt' | 'opensubtitles' | 'jimaku' | 'subhd' | 'zimuku'
  secrets: { name: SecretName; set: boolean; source: SecretSource; masked: string | null }[]
  lastTest: SecretTestDTO | null
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
  const { settingsRepo, env } = deps
  const dbGet = (key: string) => settingsRepo.get(key)
  const sec = (name: SecretName) => resolveSecret(name, env, (n) => dbGet(`secret:${n}`))
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
  const subhd = resolveProviderFlag('SUBHD_ENABLED', env, dbGet)
  const zimuku = resolveProviderFlag('ZIMUKU_ENABLED', env, dbGet)

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
  assrt: ['ASSRT_TOKEN'],
  opensubtitles: ['OPENSUBTITLES_API_KEY', 'OPENSUBTITLES_USERNAME', 'OPENSUBTITLES_PASSWORD'],
  jimaku: ['JIMAKU_API_KEY'],
  subhd: [],
  zimuku: [],
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

export function buildProviders(deps: SetupDeps): ProvidersDTO {
  const meta = deps.settingsRepo.listSecretMeta(deps.env)
  const rows = (Object.keys(PROVIDER_SECRETS) as ProviderRowDTO['id'][]).map((id) => ({
    id,
    secrets: PROVIDER_SECRETS[id].map((name) => meta.find((m) => m.name === name)!),
    lastTest: readLastTest(deps, id),
  }))
  return { providers: rows }
}

// ---------- POST validate ----------

export const VALIDATE_TARGETS = ['tmdb', 'llm', 'assrt', 'opensubtitles', 'jimaku', 'subhd', 'zimuku'] as const
export type ValidateTarget = (typeof VALIDATE_TARGETS)[number]

export interface ValidateResultDTO { ok: boolean; detail?: string; error?: string }

/** 与 doctor DoctorResult 同构的最小面（ok/skip/detail/hint）。 */
export type ValidateProbe = () => Promise<{ ok: boolean; skip?: boolean; detail?: string; hint?: string }>

/** 每个 target 的静态英文下一步提示（spec §4.4 "detail 给用户可执行的下一步"；不回原始异常串）。 */
const NEXT_STEP_HINT: Record<ValidateTarget, string> = {
  tmdb: 'Get a key at themoviedb.org → account Settings → API → API Key (v3 auth).',
  llm: 'All three fields must come from the same provider; the base URL usually ends with /v1.',
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
    creds[n] ?? resolveSecret(n, env, (x) => settingsRepo.get(`secret:${x}`)).value

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
