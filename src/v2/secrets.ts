// src/v2/secrets.ts：启动面（spec A §4.1/§4.2）——密钥解析纯逻辑层。settings 表 `secret:*` 键空间
// + env 优先解析 + 打码序列化 + provider flag 三级解析，全部纯函数无副作用，供
// settingsRepo/buildAdapters/cli/dashboard 四个消费方共用同一套语义（不各写一份）。
//
// 优先级（spec §4.2）：env 非空 → env 胜（deploy-locked，现有部署零迁移零打扰）；否则读库；
// 都没有 → none。空字符串 env 视为未设（手滑 `export TMDB_API_KEY=` 不该挡住库里的真 key）。

/** 白名单（spec §4.1/§8.2）：允许这 15 个名字进 settings 表的 `secret:*` 键空间。 */
export const SECRET_NAMES = [
  'TMDB_API_KEY',
  'LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL',
  'ASSRT_TOKEN',
  'OPENSUBTITLES_API_KEY', 'OPENSUBTITLES_USERNAME', 'OPENSUBTITLES_PASSWORD',
  'JIMAKU_API_KEY',
  'TRANSLATE_BASE_URL', 'TRANSLATE_API_KEY', 'TRANSLATE_MODEL',
  'ZIMUKU_VISION_BASE_URL', 'ZIMUKU_VISION_API_KEY', 'ZIMUKU_VISION_MODEL',
] as const
export type SecretName = (typeof SECRET_NAMES)[number]

export function isSecretName(name: string): name is SecretName {
  return (SECRET_NAMES as readonly string[]).includes(name)
}

export type SecretSource = 'env' | 'db' | 'none'

export interface ResolvedSecret {
  /** source='none' 时恒 null；env/db 时是非空字符串（写入侧已拒绝空值）。 */
  value: string | null
  source: SecretSource
}

/** env（非空）> db > none。dbGet 只读 `secret:<name>` 的值（不存在返回 null）。 */
export function resolveSecret(
  name: SecretName,
  env: NodeJS.ProcessEnv,
  dbGet: (name: SecretName) => string | null,
): ResolvedSecret {
  const envValue = env[name]
  if (typeof envValue === 'string' && envValue !== '') return { value: envValue, source: 'env' }
  const dbValue = dbGet(name)
  if (dbValue !== null && dbValue !== '') return { value: dbValue, source: 'db' }
  return { value: null, source: 'none' }
}

/** 打码（spec §4.1）：长度 ≥8 → 前 3 + `••••` + 后 3；<8 → 全 `••••`。 */
export function maskSecretValue(value: string): string {
  if (value.length >= 8) return `${value.slice(0, 3)}••••${value.slice(-3)}`
  return '••••'
}

export type ProviderFlagName = 'SUBHD_ENABLED' | 'ZIMUKU_ENABLED'

export interface ProviderFlagResolution {
  enabled: boolean
  source: SecretSource
}

/** provider 开关三级解析（spec §4.4）：env 显式设置（含 'false'）→ env 值；否则库
 *  `provider:<flag>`；都没有 → 关（与今天 env-only 缺省一致，fail-closed）。
 *  布尔钉死 `=== 'true'` 精确匹配：'1'/'TRUE'/脏值一律关（沿用 buildAdapters.ts 既有语义）。
 *  注意这与 engine_enabled 的 fail-open 相反——闸的性质不同：flag 默认关、engine 默认开。 */
export function resolveProviderFlag(
  flag: ProviderFlagName,
  env: NodeJS.ProcessEnv,
  dbGet: (key: string) => string | null,
): ProviderFlagResolution {
  const envValue = env[flag]
  if (typeof envValue === 'string' && envValue !== '') {
    return { enabled: envValue === 'true', source: 'env' }
  }
  const dbValue = dbGet(`provider:${flag}`)
  if (dbValue !== null) return { enabled: dbValue === 'true', source: 'db' }
  return { enabled: false, source: 'none' }
}

/** buildAdapters 的配置解析面：secret() 拿密钥、flag() 拿 provider 开关。 */
export interface AdapterConfigResolver {
  secret: (name: SecretName) => ResolvedSecret
  flag: (flag: ProviderFlagName) => ProviderFlagResolution
}

/** dbGet 读任意 settings 键（'secret:TMDB_API_KEY'、'provider:SUBHD_ENABLED' 都走它）——
 *  生产侧直接传 `settingsRepo.get.bind(settingsRepo)`，惰性读库，每次调用都是新鲜值。 */
export function makeAdapterConfigResolver(
  env: NodeJS.ProcessEnv,
  dbGet: (key: string) => string | null,
): AdapterConfigResolver {
  return {
    secret: (name) => resolveSecret(name, env, (n) => dbGet(`secret:${n}`)),
    flag: (flag) => resolveProviderFlag(flag, env, dbGet),
  }
}

/** 无库场景（一次性命令的 env-only 退化）：永远不看库，语义与今天逐字一致。 */
export function envOnlyAdapterConfig(env: NodeJS.ProcessEnv): AdapterConfigResolver {
  return {
    secret: (name) => {
      const v = env[name]
      return typeof v === 'string' && v !== '' ? { value: v, source: 'env' } : { value: null, source: 'none' }
    },
    flag: (flag) => {
      const v = env[flag]
      return typeof v === 'string' && v !== '' ? { enabled: v === 'true', source: 'env' } : { enabled: false, source: 'none' }
    },
  }
}
