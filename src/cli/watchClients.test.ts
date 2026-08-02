// src/cli/watchClients.test.ts：spec A §4.2/§4.7 热重建与闸谓词契约。
import { describe, it, expect, vi } from 'vitest'
import { makeSecretsWatcher, setupSatisfied, engineEnabled } from './watchClients.js'
import { makeAdapterConfigResolver } from '../v2/secrets.js'

describe('makeSecretsWatcher（spec §4.2：版本变了才重建）', () => {
  it('版本不变 → rebuild 不调用', async () => {
    const rebuild = vi.fn(async () => {})
    const tick = makeSecretsWatcher({ readVersion: () => 3, rebuild, log: () => {}, initialVersion: 3 })
    await tick(); await tick()
    expect(rebuild).not.toHaveBeenCalled()
  })

  it('版本 bump → rebuild 一次 + 记 rebuilt 日志；再 tick 不重复', async () => {
    let v = 1
    const logs: string[] = []
    const rebuild = vi.fn(async () => {})
    const tick = makeSecretsWatcher({ readVersion: () => v, rebuild, log: (m) => logs.push(m), initialVersion: 1 })
    await tick()
    expect(rebuild).not.toHaveBeenCalled()   // 首 tick 只建立基线
    v = 2
    await tick()
    expect(rebuild).toHaveBeenCalledOnce()
    expect(logs.some((l) => l.includes('clients rebuilt'))).toBe(true)
    await tick()
    expect(rebuild).toHaveBeenCalledOnce()
  })

  it('rebuild 抛错 → warn 日志 + 下一 tick 重试（seen 不前进）', async () => {
    let v = 1
    let fail = true
    const logs: string[] = []
    const rebuild = vi.fn(async () => { if (fail) throw new Error('boom') })
    const tick = makeSecretsWatcher({ readVersion: () => v, rebuild, log: (m) => logs.push(m), initialVersion: 1 })
    v = 2
    await tick()
    expect(rebuild).toHaveBeenCalledOnce()
    expect(logs.some((l) => l.includes('warn') && l.includes('retry'))).toBe(true)
    fail = false
    await tick()   // 重试成功
    expect(rebuild).toHaveBeenCalledTimes(2)
    expect(logs.some((l) => l.includes('clients rebuilt'))).toBe(true)
    await tick()   // 成功后不再重复
    expect(rebuild).toHaveBeenCalledTimes(2)
  })
})

describe('setupSatisfied（spec §4.7：TMDB + LLM 三件套全部可解析）', () => {
  const cfgOf = (secrets: Record<string, string>) =>
    makeAdapterConfigResolver({}, (k) => (k.startsWith('secret:') ? secrets[k.slice(7)] ?? null : null))
  it('全缺 → false；只有 TMDB → false；LLM 三缺一 → false；全齐 → true', () => {
    expect(setupSatisfied(cfgOf({}))).toBe(false)
    expect(setupSatisfied(cfgOf({ TMDB_API_KEY: 't' }))).toBe(false)
    expect(setupSatisfied(cfgOf({ TMDB_API_KEY: 't', LLM_BASE_URL: 'b', LLM_API_KEY: 'k' }))).toBe(false)
    expect(setupSatisfied(cfgOf({ TMDB_API_KEY: 't', LLM_BASE_URL: 'b', LLM_API_KEY: 'k', LLM_MODEL: 'm' }))).toBe(true)
  })
})

describe('engineEnabled（spec §4.6：fail-open）', () => {
  it('null → true；true → true；显式 false → false；脏值 → true', () => {
    expect(engineEnabled(() => null)).toBe(true)
    expect(engineEnabled(() => 'true')).toBe(true)
    expect(engineEnabled(() => 'false')).toBe(false)
    expect(engineEnabled(() => '0')).toBe(true)
    expect(engineEnabled(() => 'FALSE')).toBe(true)   // 只有精确 'false' 才关
  })
})
