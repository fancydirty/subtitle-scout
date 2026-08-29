// src/dashboard/setupApi.test.ts：spec A §4.4 DTO 形状/推导矩阵/写路径纪律。
import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, type ScoutDb } from '../v2/db.js'
import { SettingsRepo } from '../v2/settingsRepo.js'
import {
  buildSetupStatus, buildProviders, putSecret, sanitizeCredentials, validateSetupTarget,
  type SetupDeps, type ValidateProbe,
} from './setupApi.js'
import { applyQuotaEvent } from '../cli/quotaState.js'

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

  it('设置页是唯一来源：env 不再生效，db 配齐才 bootstrapComplete', () => {
    settings.setSecret('TMDB_API_KEY', 'db-tmdb-key-000', NOW)
    settings.setSecret('LLM_BASE_URL', 'https://x/v1', NOW)
    settings.setSecret('LLM_API_KEY', 'db-llm-key-000', NOW)
    settings.setSecret('LLM_MODEL', 'deepseek-chat', NOW)
    const s = buildSetupStatus(makeDeps({
      TMDB_API_KEY: 'env-tmdb-key-000', LLM_BASE_URL: 'https://x/v1', LLM_API_KEY: 'env-llm-key-000', LLM_MODEL: 'deepseek-chat',
    }))
    expect(s.bootstrapComplete).toBe(true)
    expect(s.tmdb.source).toBe('db')
    expect(s.llm).toEqual({ satisfied: true, source: 'db', model: 'deepseek-chat' })
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

  it('env 与 db 同时存在：以 db 为准（设置页唯一来源）', () => {
    settings.setSecret('TMDB_API_KEY', 'db-tmdb-999', NOW)
    settings.setSecret('LLM_BASE_URL', 'https://x/v1', NOW)
    settings.setSecret('LLM_API_KEY', 'k12345678', NOW)
    settings.setSecret('LLM_MODEL', 'm', NOW)
    const s = buildSetupStatus(makeDeps({ TMDB_API_KEY: 'env-tmdb-999' }))
    expect(s.bootstrapComplete).toBe(true)
    expect(s.tmdb.source).toBe('db')
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

  it('provider flags：只读设置页；env 显式 false 不再压过库', () => {
    settings.set('provider:ZIMUKU_ENABLED', 'true', NOW)
    expect(buildSetupStatus(makeDeps()).providers.zimuku).toMatchObject({ enabled: true, source: 'db' })
    expect(buildSetupStatus(makeDeps({ ZIMUKU_ENABLED: 'false' })).providers.zimuku)
      .toMatchObject({ enabled: true, source: 'db' })
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
  it('10 行分组；密钥打码；secret_test:* 反射为 lastTest；subhd 空 secrets 数组', () => {
    settings.setSecret('TMDB_API_KEY', 'tmdb-plain-123456', NOW)
    settings.set(`secret_test:tmdb`, JSON.stringify({ ok: true, at: NOW - 60_000 }), NOW)
    const p = buildProviders(makeDeps())
    expect(p.providers.map((r) => r.id)).toEqual(['tmdb', 'llm', 'translate', 'assrt', 'opensubtitles', 'jimaku', 'subhd', 'zimuku', 'r3sub', 'subdl'])
    const tmdb = p.providers[0]!
    expect(tmdb.secrets).toEqual([{ name: 'TMDB_API_KEY', set: true, source: 'db', masked: 'tmd••••456' }])
    expect(tmdb.lastTest).toEqual({ ok: true, at: NOW - 60_000 })
    expect(p.providers.find((r) => r.id === 'llm')!.secrets.map((s) => s.name))
      .toEqual(['LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL'])
    expect(p.providers.find((r) => r.id === 'subhd')!.secrets).toEqual([])
    expect(p.providers.find((r) => r.id === 'zimuku')!.lastTest).toBeNull()
    expect(p.providers.find((r) => r.id === 'translate')!.secrets.map((s) => s.name))
      .toEqual(['TRANSLATE_BASE_URL', 'TRANSLATE_API_KEY', 'TRANSLATE_MODEL'])
    expect(JSON.stringify(p)).not.toContain('tmdb-plain-123456')
  })

  // zimuku 的视觉兜底三凭证必须挂在 zimuku 行下——这是 ZimukuVisionCard 唯一的读取口。
  // 曾经这三个键**不在任何 provider 行里**，前端卡片去找一个不存在的 `zimuku_vision`
  // provider，于是恒显示"未配置"，哪怕密钥全配好了。这条钉住那个回归。
  it('zimuku 行携带 ZIMUKU_VISION_* 三凭证（视觉兜底；卡片的唯一读取口）', () => {
    const zimuku = buildProviders(makeDeps()).providers.find((r) => r.id === 'zimuku')!
    expect(zimuku.secrets.map((s) => s.name))
      .toEqual(['ZIMUKU_VISION_BASE_URL', 'ZIMUKU_VISION_API_KEY', 'ZIMUKU_VISION_MODEL'])
  })

  it('ZIMUKU_VISION_* 已配置时 zimuku 行如实反映 set/source，且不回明文', () => {
    settings.setSecret('ZIMUKU_VISION_BASE_URL', 'https://llm.example/v1', NOW)
    settings.setSecret('ZIMUKU_VISION_API_KEY', 'sk-vision-plain-9876', NOW)
    settings.setSecret('ZIMUKU_VISION_MODEL', 'gpt-4o', NOW)
    const p = buildProviders(makeDeps())
    const zimuku = p.providers.find((r) => r.id === 'zimuku')!
    expect(zimuku.secrets.every((s) => s.set)).toBe(true)
    expect(zimuku.secrets.every((s) => s.source === 'db')).toBe(true)
    expect(JSON.stringify(p)).not.toContain('sk-vision-plain-9876')
  })

  // 视觉兜底不是字幕源：它没有自己的 provider 行，也没有自己的 validate 探针
  // （卡片的"测试"按钮走独立的 POST /api/v2/test-vision）。
  it('没有 zimuku_vision provider 行，也不是合法的 validate target', async () => {
    expect(buildProviders(makeDeps()).providers.find((r) => r.id === 'zimuku_vision' as never)).toBeUndefined()
    expect((await validateSetupTarget(makeDeps(), { target: 'zimuku_vision' })).status).toBe(400)
  })

  it('secret_test:* 脏 JSON → lastTest=null（防御性解析）', () => {
    settings.set('secret_test:assrt', '{broken', NOW)
    expect(buildProviders(makeDeps()).providers.find((r) => r.id === 'assrt')!.lastTest).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// quota 字段（2026-08-13：`quota_state_*` 只写不读的债务在这里结清）
//
// 写入方是 cli/quotaState.applyQuotaEvent（活的 translate/realign 路径），这里是它
// **唯一的读取方**。删掉本组断言里的任何一条，那个键就重新变回只写不读。
// ═══════════════════════════════════════════════════════════════════════════
describe('buildProviders 的 quota 字段（quota_state_* 旁路键的唯一读取方）', () => {
  const quotaKey = (p: string) => `quota_state_${p}`

  it('没有旁路键时每一行的 quota 都是 null（常态：没撞过配额）', () => {
    const p = buildProviders(makeDeps())
    expect(p.providers.every((r) => r.quota === null)).toBe(true)
  })

  it('resetAt 在未来 → 落到对应 provider 行，其余行仍为 null', () => {
    const resetAt = new Date(NOW + 3_600_000).toISOString()
    settings.set(quotaKey('opensubtitles'), JSON.stringify({ resetAt, observedAt: NOW - 1000 }), NOW)
    const p = buildProviders(makeDeps())
    expect(p.providers.find((r) => r.id === 'opensubtitles')!.quota)
      .toEqual({ resetAt, observedAt: NOW - 1000 })
    expect(p.providers.filter((r) => r.id !== 'opensubtitles').every((r) => r.quota === null)).toBe(true)
  })

  // provider 没告诉我们何时恢复 → 不知道重置时刻**不等于**已经重置。这一条只能等
  // /download 成功来清键，读侧必须留着并如实说"恢复时间未知"。
  it('resetAt=null 不被当成过期滤掉（耗尽但恢复时间未知，仍是现况）', () => {
    settings.set(quotaKey('assrt'), JSON.stringify({ resetAt: null, observedAt: NOW - 5000 }), NOW)
    expect(buildProviders(makeDeps()).providers.find((r) => r.id === 'assrt')!.quota)
      .toEqual({ resetAt: null, observedAt: NOW - 5000 })
  })

  // 过期条目当作现况展示，正是"为什么 assrt 不找了"的反向误导——必须滤掉。
  it('resetAt 已过去 → 滤除（配额窗口已翻篇，事实不再成立）', () => {
    settings.set(
      quotaKey('opensubtitles'),
      JSON.stringify({ resetAt: new Date(NOW - 1).toISOString(), observedAt: NOW - 90_000 }),
      NOW,
    )
    expect(buildProviders(makeDeps()).providers.find((r) => r.id === 'opensubtitles')!.quota).toBeNull()
  })

  it('resetAt 不是可解析日期 → 滤除（不把垃圾当事实）', () => {
    settings.set(quotaKey('opensubtitles'), JSON.stringify({ resetAt: 'not-a-date', observedAt: NOW }), NOW)
    expect(buildProviders(makeDeps()).providers.find((r) => r.id === 'opensubtitles')!.quota).toBeNull()
  })

  // 这个端点是设置页的主数据源；它 500 等于用户连凭据都看不见了。
  it('脏 JSON / 缺 observedAt → 跳过该条，其余行照常产出（fail-soft，不炸端点）', () => {
    settings.set(quotaKey('opensubtitles'), '{broken', NOW)
    settings.set(quotaKey('jimaku'), JSON.stringify({ resetAt: null }), NOW)
    settings.set(quotaKey('assrt'), JSON.stringify({ resetAt: null, observedAt: NOW }), NOW)
    const p = buildProviders(makeDeps())
    expect(p.providers).toHaveLength(10)
    expect(p.providers.find((r) => r.id === 'opensubtitles')!.quota).toBeNull()
    expect(p.providers.find((r) => r.id === 'jimaku')!.quota).toBeNull()
    expect(p.providers.find((r) => r.id === 'assrt')!.quota).not.toBeNull()
  })

  // 键名里的 provider 段若不对应任何 provider 行，不许凭空多造一行出来。
  it('未知 provider 的旁路键不产生额外行', () => {
    settings.set(quotaKey('nonesuch'), JSON.stringify({ resetAt: null, observedAt: NOW }), NOW)
    const p = buildProviders(makeDeps())
    expect(p.providers).toHaveLength(10)
    expect(p.providers.some((r) => r.id === 'nonesuch' as never)).toBe(false)
  })

  // 🔴 写入方与读取方**必须用同一个前缀常量**。这条钉住的是最阴的那种断链：
  // 任一侧改了字面量而另一侧没改，写入照常、读取恒空，两侧测试都还是绿的。
  it('🔴 端到端：applyQuotaEvent 真的写完，buildProviders 真的读得到（同一个前缀常量）', () => {
    applyQuotaEvent(
      { event: 'provider_error', provider: 'opensubtitles', message: 'quota exhausted', code: 'quota_exhausted', resetAt: new Date(NOW + 60_000).toISOString() },
      settings,
      NOW,
    )
    expect(buildProviders(makeDeps()).providers.find((r) => r.id === 'opensubtitles')!.quota)
      .toEqual({ resetAt: new Date(NOW + 60_000).toISOString(), observedAt: NOW })

    // 反向：/download 200 清键 → 读侧当场回到 null（不是等过期）
    applyQuotaEvent(
      { event: 'api_call', provider: 'opensubtitles', endpoint: 'os/download', status: 200, durationMs: 5 },
      settings,
      NOW + 1,
    )
    expect(buildProviders(makeDeps()).providers.find((r) => r.id === 'opensubtitles')!.quota).toBeNull()
  })
})

describe('validateSetupTarget（spec §4.4）', () => {
  it('未知 target → 400', async () => {
    const r = await validateSetupTarget(makeDeps(), { target: 'plex' })
    expect(r.status).toBe(400)
    expect(r.body).toEqual({ ok: false, error: 'unknown validate target' })
  })

  it('probe 绿 → {ok:true}，且 secret_test:tmdb 落库（不 bump secrets_version）', async () => {
    const v0 = settings.secretsVersion()
    const r = await validateSetupTarget(makeDeps({}, {
      probes: { tmdb: async () => ({ ok: true, detail: 'probe ok' }) },
    }), { target: 'tmdb' })
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true, detail: 'probe ok' })
    const row = JSON.parse(settings.get('secret_test:tmdb')!)
    expect(row).toEqual({ ok: true, at: NOW })
    expect(settings.secretsVersion()).toBe(v0)
  })

  it('probe skip → {ok:false, error: "tmdb is not configured"}', async () => {
    const r = await validateSetupTarget(makeDeps({}, {
      probes: { tmdb: async () => ({ ok: true, skip: true, detail: '未配置' }) },
    }), { target: 'tmdb' })
    expect(r.body).toEqual({ ok: false, error: 'tmdb is not configured' })
  })

  it('失败分类：401/403 → Invalid credentials；404 → base URL·model；超时 → Connection problem；detail 给静态提示不回原文', async () => {
    const cases: [string, string][] = [
      ['HTTP 401 Unauthorized', 'Invalid credentials'],
      ['status 403', 'Invalid credentials'],
      ['404 Not Found', 'check the base URL and model'],
      ['timed out after 10000ms', 'Connection problem'],
      ['fetch failed ECONNREFUSED', 'Connection problem'],
    ]
    for (const [raw, expected] of cases) {
      const r = await validateSetupTarget(makeDeps({}, {
        probes: { llm: async () => ({ ok: false, detail: raw }) },
      }), { target: 'llm' })
      expect(r.body.ok).toBe(false)
      expect(r.body.error).toContain(expected)
      expect(r.body.error).not.toContain(raw)   // spec §8：原始串不回前端
      expect(r.body.detail).toBeTruthy()        // 静态下一步提示
    }
  })

  it('probe 自身抛错 → {ok:false}，不炸路由', async () => {
    const r = await validateSetupTarget(makeDeps({}, {
      probes: { assrt: async () => { throw new Error('boom') } },
    }), { target: 'assrt' })
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(false)
  })

  it('credentials 白名单外键被丢弃；非字符串/空串被丢弃', async () => {
    let seen: Record<string, string> | null = null
    const probe: ValidateProbe = async () => ({ ok: true })
    const r = await validateSetupTarget(makeDeps({}, {
      probes: { jimaku: probe },
    }), { target: 'jimaku', credentials: { JIMAKU_API_KEY: 'jk-1', HACK: 'x', TMDB_API_KEY: 42, ASSRT_TOKEN: '' } })
    expect(r.status).toBe(200)
    // sanitize 行为由内部 defaultProbe 使用——注入 probe 时只断言路由不炸、不 400。
    // sanitize 本身的单元断言：
    expect(sanitizeCredentials({ JIMAKU_API_KEY: 'jk-1', HACK: 'x', TMDB_API_KEY: 42 as never, ASSRT_TOKEN: '' }))
      .toEqual({ JIMAKU_API_KEY: 'jk-1' })
    void seen
  })
})

describe('注册表派生（r3sub/subdl 入列 + kind/languages，registry spec §4.1/§4.2）', () => {
  it('r3sub 行：双凭据 keyed，kind=source，languages=[zh]', () => {
    const row = buildProviders(makeDeps()).providers.find((r) => r.id === 'r3sub')!
    expect(row).toBeDefined()
    expect(row.secrets.map((s) => s.name)).toEqual(['R3SUB_EMAIL', 'R3SUB_PASSWORD'])
    expect(row.kind).toBe('source')
    expect(row.languages).toEqual(['zh'])
  })

  it('subdl 行：单凭据 keyed，kind=source，languages=*', () => {
    const row = buildProviders(makeDeps()).providers.find((r) => r.id === 'subdl')!
    expect(row).toBeDefined()
    expect(row.secrets.map((s) => s.name)).toEqual(['SUBDL_API_KEY'])
    expect(row.kind).toBe('source')
    expect(row.languages).toBe('*')
  })

  it('infra 行（tmdb/llm/translate）kind=infra、languages=null；源行 languages 来自注册表', () => {
    const p = buildProviders(makeDeps())
    for (const id of ['tmdb', 'llm', 'translate'] as const) {
      const row = p.providers.find((r) => r.id === id)!
      expect(row.kind).toBe('infra')
      expect(row.languages).toBeNull()
    }
    expect(p.providers.find((r) => r.id === 'assrt')!.languages).toEqual(['zh'])
    expect(p.providers.find((r) => r.id === 'opensubtitles')!.languages).toBe('*')
    expect(p.providers.find((r) => r.id === 'jimaku')!.languages).toEqual(['ja'])
  })

  it('status.providers.r3sub：email+password 成对才 satisfied；subdl 按单 key', () => {
    const s0 = buildSetupStatus(makeDeps())
    expect(s0.providers.r3sub).toEqual({ satisfied: false, source: 'none', masked: null })
    expect(s0.providers.subdl).toEqual({ satisfied: false, source: 'none', masked: null })

    settings.setSecret('R3SUB_EMAIL', 'someone@example.com', NOW)
    const s1 = buildSetupStatus(makeDeps())
    expect(s1.providers.r3sub.satisfied).toBe(false)   // 只有 email 不算配好

    settings.setSecret('R3SUB_PASSWORD', 'hunter2-secret', NOW)
    const s2 = buildSetupStatus(makeDeps())
    expect(s2.providers.r3sub.satisfied).toBe(true)
    expect(s2.providers.r3sub.source).toBe('db')
    expect(s2.providers.r3sub.masked).not.toBeNull()
    expect(s2.providers.r3sub.masked).not.toContain('someone@example.com')

    settings.setSecret('SUBDL_API_KEY', 'subdl_key_123456', NOW)
    expect(buildSetupStatus(makeDeps()).providers.subdl.satisfied).toBe(true)
  })

  it('validate targets 认 r3sub/subdl（注入 probe 走通全链）', async () => {
    const r1 = await validateSetupTarget(makeDeps({}, {
      probes: { r3sub: async () => ({ ok: true, detail: 'login ok' }) },
    }), { target: 'r3sub' })
    expect(r1.body).toEqual({ ok: true, detail: 'login ok' })
    const r2 = await validateSetupTarget(makeDeps({}, {
      probes: { subdl: async () => ({ ok: true, skip: true, detail: '未配置' }) },
    }), { target: 'subdl' })
    expect(r2.body).toEqual({ ok: false, error: 'subdl is not configured' })
  })

  it('未配凭据时 r3sub/subdl 的 defaultProbe 报未配置（不出网）', async () => {
    const r = await validateSetupTarget(makeDeps(), { target: 'r3sub' })
    expect(r.body).toEqual({ ok: false, error: 'r3sub is not configured' })
    const r2 = await validateSetupTarget(makeDeps(), { target: 'subdl' })
    expect(r2.body).toEqual({ ok: false, error: 'subdl is not configured' })
  })
})
