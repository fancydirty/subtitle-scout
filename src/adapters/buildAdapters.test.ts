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

  it('rejects with a descriptive error when ZIMUKU_ENABLED=true but LLM_* env is missing (captcha solving needs a multimodal LLM)', async () => {
    process.env.ZIMUKU_ENABLED = 'true'
    await expect(buildAdapters()).rejects.toThrow(/ZIMUKU_ENABLED=true requires LLM_BASE_URL/)
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
