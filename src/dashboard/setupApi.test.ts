// src/dashboard/setupApi.test.ts：spec A §4.4 DTO 形状/推导矩阵/写路径纪律。
import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, type ScoutDb } from '../v2/db.js'
import { SettingsRepo } from '../v2/settingsRepo.js'
import { buildSetupStatus, buildProviders, putSecret, type SetupDeps } from './setupApi.js'

let db: ScoutDb
let settings: SettingsRepo
const NOW = 1_700_000_000_000

function makeDeps(env: NodeJS.ProcessEnv = {}, over: Partial<SetupDeps> = {}): SetupDeps {
  return {
    settingsRepo: settings,
    env,
    cacheRoot: '/tmp/scout-test-cache',
    rootsCount: () => 0,
    now: () => NOW,
    ...over,
  }
}

beforeEach(() => {
  db = openDb(':memory:')
  settings = new SettingsRepo(db)
})

describe('buildSetupStatus 推导矩阵（spec §4.4 / §3 决策 1）', () => {
  it('全无 → bootstrapComplete=false，全块 none', () => {
    const s = buildSetupStatus(makeDeps())
    expect(s.bootstrapComplete).toBe(false)
    expect(s.tmdb).toEqual({ satisfied: false, source: 'none', masked: null })
    expect(s.llm).toEqual({ satisfied: false, source: 'none', model: null })
    expect(s.providers.assrt.satisfied).toBe(false)
    expect(s.providers.opensubtitles).toEqual({ satisfied: false, source: 'none', hasUsername: false, masked: null })
    expect(s.providers.subhd).toEqual({ enabled: false, source: 'none' })
    expect(s.providers.zimuku).toEqual({ enabled: false, source: 'none', captchaReady: false })
    expect(s.roots).toEqual({ count: 0 })
    expect(s.engineEnabled).toBe(true)   // fail-open 缺省
  })

  it('纯 env（现有部署形态）→ bootstrapComplete=true，source=env', () => {
    const s = buildSetupStatus(makeDeps({
      TMDB_API_KEY: 'env-tmdb-key-000', LLM_BASE_URL: 'https://x/v1', LLM_API_KEY: 'env-llm-key-000', LLM_MODEL: 'deepseek-chat',
    }))
    expect(s.bootstrapComplete).toBe(true)
    expect(s.tmdb.source).toBe('env')
    expect(s.llm).toEqual({ satisfied: true, source: 'env', model: 'deepseek-chat' })
    expect(s.providers.zimuku.captchaReady).toBe(true)   // LLM 已通 → captchaReady
  })

  it('纯 db（wizard 落库形态）→ bootstrapComplete=true，source=db', () => {
    settings.setSecret('TMDB_API_KEY', 'db-tmdb-key-000', NOW)
    settings.setSecret('LLM_BASE_URL', 'https://x/v1', NOW)
    settings.setSecret('LLM_API_KEY', 'db-llm-key-000', NOW)
    settings.setSecret('LLM_MODEL', 'm', NOW)
    const s = buildSetupStatus(makeDeps())
    expect(s.bootstrapComplete).toBe(true)
    expect(s.tmdb).toEqual({ satisfied: true, source: 'db', masked: 'db-••••000' })
    expect(s.llm.source).toBe('db')
  })

  it('混合：TMDB env + LLM db → bootstrapComplete=true', () => {
    settings.setSecret('LLM_BASE_URL', 'https://x/v1', NOW)
    settings.setSecret('LLM_API_KEY', 'k12345678', NOW)
    settings.setSecret('LLM_MODEL', 'm', NOW)
    const s = buildSetupStatus(makeDeps({ TMDB_API_KEY: 'env-tmdb-999' }))
    expect(s.bootstrapComplete).toBe(true)
    expect(s.tmdb.source).toBe('env')
    expect(s.llm.source).toBe('db')
  })

  it('LLM 三缺一直接不满足（哪怕两件都齐）', () => {
    settings.setSecret('LLM_BASE_URL', 'https://x/v1', NOW)
    settings.setSecret('LLM_API_KEY', 'k', NOW)
    const s = buildSetupStatus(makeDeps({ TMDB_API_KEY: 't' }))
    expect(s.bootstrapComplete).toBe(false)
    expect(s.llm.satisfied).toBe(false)
    expect(s.providers.zimuku.captchaReady).toBe(false)
  })

  it('opensubtitles：仅 apiKey → satisfied 且 hasUsername=false；username 单填不成对仍 false；成对才 true', () => {
    settings.setSecret('OPENSUBTITLES_API_KEY', 'os-key-12345', NOW)
    expect(buildSetupStatus(makeDeps()).providers.opensubtitles)
      .toEqual({ satisfied: true, source: 'db', hasUsername: false, masked: 'os-••••345' })
    settings.setSecret('OPENSUBTITLES_USERNAME', 'user', NOW)
    expect(buildSetupStatus(makeDeps()).providers.opensubtitles.hasUsername).toBe(false)
    settings.setSecret('OPENSUBTITLES_PASSWORD', 'pass', NOW)
    expect(buildSetupStatus(makeDeps()).providers.opensubtitles.hasUsername).toBe(true)
  })

  it('provider flags：库 provider:ZIMUKU_ENABLED=true → enabled/db；env 显式 false 压过库', () => {
    settings.set('provider:ZIMUKU_ENABLED', 'true', NOW)
    expect(buildSetupStatus(makeDeps()).providers.zimuku.enabled).toBe(true)
    expect(buildSetupStatus(makeDeps({ ZIMUKU_ENABLED: 'false' })).providers.zimuku)
      .toMatchObject({ enabled: false, source: 'env' })
  })

  it('engineEnabled：显式 false → false；脏值 → true（fail-open spec §4.6）', () => {
    settings.set('engine_enabled', 'false', NOW)
    expect(buildSetupStatus(makeDeps()).engineEnabled).toBe(false)
    settings.set('engine_enabled', '0', NOW)
    expect(buildSetupStatus(makeDeps()).engineEnabled).toBe(true)
  })

  it('整个 DTO 序列化后不含任何明文', () => {
    settings.setSecret('TMDB_API_KEY', 'super-plain-tmdb-key', NOW)
    const json = JSON.stringify(buildSetupStatus(makeDeps()))
    expect(json).not.toContain('super-plain-tmdb-key')
  })
})

describe('putSecret（spec §4.4）', () => {
  it('白名单外 name → 400，库零写入', () => {
    const logs: string[] = []
    const r = putSecret(makeDeps(), { name: 'ADMIN_TOKEN', value: 'x' }, (m) => logs.push(m))
    expect(r.status).toBe(400)
    expect(settings.get('secret:ADMIN_TOKEN')).toBeNull()
    expect(logs).toHaveLength(0)
  })

  it('正常写入 → 200 + round-trip + version bump；审计日志只有 name 没有 value', () => {
    const logs: string[] = []
    const v0 = settings.secretsVersion()
    const r = putSecret(makeDeps(), { name: 'JIMAKU_API_KEY', value: 'jk-super-secret-value' }, (m) => logs.push(m))
    expect(r.status).toBe(200)
    expect(settings.getSecret('JIMAKU_API_KEY')).toBe('jk-super-secret-value')
    expect(settings.secretsVersion()).toBe(v0 + 1)
    expect(logs.join('\n')).toContain('JIMAKU_API_KEY')
    expect(logs.join('\n')).not.toContain('jk-super-secret-value')
  })

  it('空字符串 value = 删除语义', () => {
    settings.setSecret('ASSRT_TOKEN', 'tok', NOW)
    const v0 = settings.secretsVersion()
    const r = putSecret(makeDeps(), { name: 'ASSRT_TOKEN', value: '' }, () => {})
    expect(r.status).toBe(200)
    expect(settings.getSecret('ASSRT_TOKEN')).toBeNull()
    expect(settings.secretsVersion()).toBe(v0 + 1)
  })

  it('value 非字符串 → 400', () => {
    expect(putSecret(makeDeps(), { name: 'ASSRT_TOKEN', value: 42 }, () => {}).status).toBe(400)
  })
})

describe('buildProviders（Providers 区读面）', () => {
  it('7 行分组；密钥打码；secret_test:* 反射为 lastTest；subhd/zimuku 空 secrets 数组', () => {
    settings.setSecret('TMDB_API_KEY', 'tmdb-plain-123456', NOW)
    settings.set(`secret_test:tmdb`, JSON.stringify({ ok: true, at: NOW - 60_000 }), NOW)
    const p = buildProviders(makeDeps())
    expect(p.providers.map((r) => r.id)).toEqual(['tmdb', 'llm', 'assrt', 'opensubtitles', 'jimaku', 'subhd', 'zimuku'])
    const tmdb = p.providers[0]!
    expect(tmdb.secrets).toEqual([{ name: 'TMDB_API_KEY', set: true, source: 'db', masked: 'tmd••••456' }])
    expect(tmdb.lastTest).toEqual({ ok: true, at: NOW - 60_000 })
    expect(p.providers.find((r) => r.id === 'llm')!.secrets.map((s) => s.name))
      .toEqual(['LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL'])
    expect(p.providers.find((r) => r.id === 'subhd')!.secrets).toEqual([])
    expect(p.providers.find((r) => r.id === 'zimuku')!.lastTest).toBeNull()
    expect(JSON.stringify(p)).not.toContain('tmdb-plain-123456')
  })

  it('secret_test:* 脏 JSON → lastTest=null（防御性解析）', () => {
    settings.set('secret_test:assrt', '{broken', NOW)
    expect(buildProviders(makeDeps()).providers.find((r) => r.id === 'assrt')!.lastTest).toBeNull()
  })
})
