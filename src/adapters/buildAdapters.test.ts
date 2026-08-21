import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { buildAdapters } from './buildAdapters.js'
import { makeAdapterConfigResolver } from '../v2/secrets.js'

// 2026-08-20（env 凭证删除，用户裁决）：buildAdapters 的 cfg 从"默认 env-only"改为**必传**，
// env 激活路径的旧用例整组退役——同语义的分支已由下方 cfg resolver 组全覆盖。
// env 清理只保留 SUBTITLE_SCOUT_CACHE_DIR（那是部署基建路径，不是凭证）。
const ENV_KEYS = ['SUBTITLE_SCOUT_CACHE_DIR'] as const

let saved: Record<string, string | undefined>

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]))
  for (const k of ENV_KEYS) delete process.env[k]
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

describe('buildAdapters · cfg resolver（spec A §4.3：DB 供凭据；2026-08-20 起 env 路径已删）', () => {
  // env 全空（beforeEach 已清），凭据全走 cfg——证明 DB 解析路径能驱动所有分支。
  const cfgOf = (secrets: Record<string, string>, flags: Record<string, string> = {}) =>
    makeAdapterConfigResolver({}, (key) => {
      if (key.startsWith('secret:')) return secrets[key.slice('secret:'.length)] ?? null
      if (key.startsWith('provider:')) return flags[key.slice('provider:'.length)] ?? null
      return null
    })

  it('什么都没配 → 空数组（诚实空态）', async () => {
    const adapters = await buildAdapters(cfgOf({}))
    expect(adapters).toEqual([])
  })

  it('cfg 供 ASSRT_TOKEN → 入列（env 全空）', async () => {
    const adapters = await buildAdapters(cfgOf({ ASSRT_TOKEN: 'db-token' }))
    expect(adapters.map(a => a.name)).toEqual(['assrt'])
  })

  it('cfg 供 opensubtitles 三件套 → 入列', async () => {
    const adapters = await buildAdapters(cfgOf({ OPENSUBTITLES_API_KEY: 'db-key' }))
    expect(adapters.map(a => a.name)).toEqual(['opensubtitles'])
  })

  it('assrt + opensubtitles 都配 → 按序双入列', async () => {
    const adapters = await buildAdapters(cfgOf({ ASSRT_TOKEN: 't', OPENSUBTITLES_API_KEY: 'k' }))
    expect(adapters.map(a => a.name)).toEqual(['assrt', 'opensubtitles'])
  })

  it('zimuku：flag 开 + ZIMUKU_VISION_* 三件套齐 → 入列（视觉兜底可用）', async () => {
    const adapters = await buildAdapters(cfgOf(
      {
        ZIMUKU_VISION_BASE_URL: 'https://llm.example/v1',
        ZIMUKU_VISION_API_KEY: 'k',
        ZIMUKU_VISION_MODEL: 'm',
      },
      { ZIMUKU_ENABLED: 'true' },
    ))
    expect(adapters.map(a => a.name)).toEqual(['zimuku'])
  })

  // `c582571`（zimuku 验证码改为模板匹配优先）之后"视觉三件套不齐"不再是跳过的理由。
  // 这里刻意只给一件（BASE_URL 缺 KEY/MODEL）——半齐的配置**不许**被当成齐，
  // 但也**不许**因此把整个适配器踢掉（模板匹配那条主路径与视觉配置无关）。
  it('zimuku：视觉三件套只齐一件 → 仍然入列（半齐 ≠ 齐，但也 ≠ 不能用）', async () => {
    const warns: string[] = []
    const adapters = await buildAdapters(
      cfgOf({ ZIMUKU_VISION_API_KEY: 'k' }, { ZIMUKU_ENABLED: 'true' }),
      () => {},
      (m) => warns.push(m),
    )
    expect(adapters.map(a => a.name)).toEqual(['zimuku'])
    expect(warns).toEqual([])
  })

  it('zimuku：flag 开、无任何视觉配置 → **照常入列**（模板匹配是主路径，不需要 LLM）', async () => {
    const warns: string[] = []
    const adapters = await buildAdapters(cfgOf({}, { ZIMUKU_ENABLED: 'true' }), () => {}, (m) => warns.push(m))
    expect(adapters.map(a => a.name)).toEqual(['zimuku'])
    expect(warns).toEqual([])
  })

  it('zimuku：flag 关 → 不入列', async () => {
    const adapters = await buildAdapters(cfgOf({}))
    expect(adapters.some(a => a.name === 'zimuku')).toBe(false)
  })

  it('subhd：flag 来自 cfg provider:SUBHD_ENABLED', async () => {
    const adapters = await buildAdapters(cfgOf({}, { SUBHD_ENABLED: 'true' }))
    expect(adapters.map(a => a.name)).toEqual(['subhd'])
  })

  it('subhd：flag 未设 → 不入列', async () => {
    const adapters = await buildAdapters(cfgOf({}))
    expect(adapters.some(a => a.name === 'subhd')).toBe(false)
  })

  it('jimaku：key 来自 cfg', async () => {
    const adapters = await buildAdapters(cfgOf({ JIMAKU_API_KEY: 'db-jk' }))
    expect(adapters.map(a => a.name)).toEqual(['jimaku'])
  })

  it('jimaku：key 未配 → 不入列', async () => {
    const adapters = await buildAdapters(cfgOf({}))
    expect(adapters.some(a => a.name === 'jimaku')).toBe(false)
  })

  it('emit 回调被原样接线（构造期零调用）', async () => {
    const events: unknown[] = []
    const adapters = await buildAdapters(cfgOf({ ASSRT_TOKEN: 't' }), e => events.push(e))
    expect(adapters).toHaveLength(1)
    expect(events).toEqual([])
  })
})
