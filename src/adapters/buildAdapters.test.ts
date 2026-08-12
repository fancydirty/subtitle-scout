import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { buildAdapters } from './buildAdapters.js'

const ENV_KEYS = [
  'ASSRT_TOKEN', 'OPENSUBTITLES_API_KEY', 'OPENSUBTITLES_USERNAME', 'OPENSUBTITLES_PASSWORD',
  'ZIMUKU_ENABLED', 'LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL', 'SUBTITLE_SCOUT_CACHE_DIR',
  'SUBHD_ENABLED', 'SUBHD_BASE_URL', 'JIMAKU_API_KEY',
] as const

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

describe('buildAdapters', () => {
  it('returns an empty array when no provider env vars are configured', async () => {
    const adapters = await buildAdapters()
    expect(adapters).toEqual([])
  })

  it('includes assrt when ASSRT_TOKEN is set', async () => {
    process.env.ASSRT_TOKEN = 'test-token'
    const adapters = await buildAdapters()
    expect(adapters.map(a => a.name)).toEqual(['assrt'])
  })

  it('includes opensubtitles when OPENSUBTITLES_API_KEY is set', async () => {
    process.env.OPENSUBTITLES_API_KEY = 'test-key'
    const adapters = await buildAdapters()
    expect(adapters.map(a => a.name)).toEqual(['opensubtitles'])
  })

  it('includes both, in order, when both env vars are set', async () => {
    process.env.ASSRT_TOKEN = 'test-token'
    process.env.OPENSUBTITLES_API_KEY = 'test-key'
    const adapters = await buildAdapters()
    expect(adapters.map(a => a.name)).toEqual(['assrt', 'opensubtitles'])
  })

  it('includes subhd when SUBHD_ENABLED=true (no LLM needed — subhd has no captcha)', async () => {
    process.env.SUBHD_ENABLED = 'true'
    const adapters = await buildAdapters()
    expect(adapters.map(a => a.name)).toEqual(['subhd'])
  })

  it('excludes subhd when SUBHD_ENABLED is unset', async () => {
    const adapters = await buildAdapters()
    expect(adapters.some(a => a.name === 'subhd')).toBe(false)
  })

  it('includes jimaku when JIMAKU_API_KEY is set(F2 日字源)', async () => {
    process.env.JIMAKU_API_KEY = 'k-test'
    const adapters = await buildAdapters()
    expect(adapters.map(a => a.name)).toEqual(['jimaku'])
  })

  it('excludes jimaku when JIMAKU_API_KEY unset', async () => {
    const adapters = await buildAdapters()
    expect(adapters.some(a => a.name === 'jimaku')).toBe(false)
  })

  // ⚠️ 这条用例原本叫「skips zimuku … LLM_* env is missing」，断言 `toEqual([])` + 一条 warn。
  // `c582571`（zimuku 验证码改成**优先模板匹配**、视觉 LLM 降级为可选兜底）之后那个前提就
  // 不成立了，于是它一直红着（接手时 7 条既有失败之一）。**是测试过时，不是 bug。**
  // 现在守的是改动后的真实契约：没有视觉配置照样入列（模板匹配是 0 token 的主路径），
  // 视觉缺席只影响"模板未命中时能不能兜底"，不影响适配器在不在。
  it('zimuku：flag 开、无任何视觉配置 → **照常入列**（模板匹配是主路径，不需要 LLM）', async () => {
    process.env.ZIMUKU_ENABLED = 'true'
    const warns: string[] = []
    const adapters = await buildAdapters(() => {}, undefined, (m) => warns.push(m))
    expect(adapters.map(a => a.name)).toEqual(['zimuku'])
    // 也不该再为此 warn——它不是降级，是正常形态
    expect(warns).toEqual([])
  })

  it('forwards api_call events to the supplied emit callback', async () => {
    process.env.ASSRT_TOKEN = 'test-token'
    const events: unknown[] = []
    const adapters = await buildAdapters(e => events.push(e))
    // Construction alone never calls onApiCall — only a real search/resolve would.
    // This test only asserts buildAdapters accepted and wired the emit param without throwing.
    expect(adapters).toHaveLength(1)
    expect(events).toEqual([])
  })
})

import { makeAdapterConfigResolver } from '../v2/secrets.js'

describe('buildAdapters · cfg resolver（spec A §4.3：DB 供凭据）', () => {
  // env 全空（beforeEach 已清），凭据全走 cfg——证明 DB 解析路径能驱动所有分支。
  const cfgOf = (secrets: Record<string, string>, flags: Record<string, string> = {}) =>
    makeAdapterConfigResolver({}, (key) => {
      if (key.startsWith('secret:')) return secrets[key.slice('secret:'.length)] ?? null
      if (key.startsWith('provider:')) return flags[key.slice('provider:'.length)] ?? null
      return null
    })

  it('cfg 供 ASSRT_TOKEN → 入列（env 全空）', async () => {
    const adapters = await buildAdapters(() => {}, cfgOf({ ASSRT_TOKEN: 'db-token' }))
    expect(adapters.map(a => a.name)).toEqual(['assrt'])
  })

  it('cfg 供 opensubtitles 三件套 → 入列', async () => {
    const adapters = await buildAdapters(() => {}, cfgOf({ OPENSUBTITLES_API_KEY: 'db-key' }))
    expect(adapters.map(a => a.name)).toEqual(['opensubtitles'])
  })

  it('zimuku：flag 开 + ZIMUKU_VISION_* 三件套齐 → 入列（视觉兜底可用）', async () => {
    const adapters = await buildAdapters(() => {}, cfgOf(
      {
        ZIMUKU_VISION_BASE_URL: 'https://llm.example/v1',
        ZIMUKU_VISION_API_KEY: 'k',
        ZIMUKU_VISION_MODEL: 'm',
      },
      { ZIMUKU_ENABLED: 'true' },
    ))
    expect(adapters.map(a => a.name)).toEqual(['zimuku'])
  })

  // 同上：`c582571` 之后"视觉三件套不齐"不再是跳过的理由。
  // 这里刻意只给一件（BASE_URL 缺 KEY/MODEL）——半齐的配置**不许**被当成齐，
  // 但也**不许**因此把整个适配器踢掉（模板匹配那条主路径与视觉配置无关）。
  it('zimuku：视觉三件套只齐一件 → 仍然入列（半齐 ≠ 齐，但也 ≠ 不能用）', async () => {
    const warns: string[] = []
    const adapters = await buildAdapters(
      () => {},
      cfgOf({ ZIMUKU_VISION_API_KEY: 'k' }, { ZIMUKU_ENABLED: 'true' }),
      (m) => warns.push(m),
    )
    expect(adapters.map(a => a.name)).toEqual(['zimuku'])
    expect(warns).toEqual([])
  })

  it('subhd：flag 来自 cfg provider:SUBHD_ENABLED', async () => {
    const adapters = await buildAdapters(() => {}, cfgOf({}, { SUBHD_ENABLED: 'true' }))
    expect(adapters.map(a => a.name)).toEqual(['subhd'])
  })

  it('jimaku：key 来自 cfg', async () => {
    const adapters = await buildAdapters(() => {}, cfgOf({ JIMAKU_API_KEY: 'db-jk' }))
    expect(adapters.map(a => a.name)).toEqual(['jimaku'])
  })

  it('默认 cfg = env-only：env 供 key 的老路径逐字语义不变', async () => {
    process.env.ASSRT_TOKEN = 'env-token'
    const adapters = await buildAdapters()
    expect(adapters.map(a => a.name)).toEqual(['assrt'])
  })
})
