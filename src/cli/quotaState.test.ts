import { describe, it, expect } from 'vitest'
import { applyQuotaEvent, QUOTA_STATE_PREFIX } from './quotaState.js'
import type { FetchEvent } from './fetchLib.js'

function fakeRepo() {
  const store = new Map<string, string>()
  const calls: { method: 'set' | 'delete'; key: string; value?: string }[] = []
  return {
    store,
    calls,
    set(key: string, value: string, _now: number) {
      store.set(key, value)
      calls.push({ method: 'set', key, value })
    },
    delete(key: string) {
      store.delete(key)
      calls.push({ method: 'delete', key })
    },
  }
}

const NOW = 1_700_000_000_000

describe('applyQuotaEvent', () => {
  it('provider_error 且 code=quota_exhausted → 写旁路键', () => {
    const repo = fakeRepo()
    const e: FetchEvent = { event: 'provider_error', provider: 'opensubtitles', message: 'quota exhausted', code: 'quota_exhausted', resetAt: '2026-01-01T00:00:00Z' }
    applyQuotaEvent(e, repo, NOW)
    expect(repo.store.has(`${QUOTA_STATE_PREFIX}opensubtitles`)).toBe(true)
    expect(JSON.parse(repo.store.get(`${QUOTA_STATE_PREFIX}opensubtitles`)!)).toEqual({ resetAt: '2026-01-01T00:00:00Z', observedAt: NOW })
  })

  it('provider_notice 且 code=quota_exhausted → 写旁路键', () => {
    const repo = fakeRepo()
    const e: FetchEvent = { event: 'provider_notice', provider: 'assrt', message: 'remaining <= 0', code: 'quota_exhausted', resetAt: null }
    applyQuotaEvent(e, repo, NOW)
    expect(JSON.parse(repo.store.get(`${QUOTA_STATE_PREFIX}assrt`)!)).toEqual({ resetAt: null, observedAt: NOW })
  })

  it('provider_error 无 code → 不写键', () => {
    const repo = fakeRepo()
    const e: FetchEvent = { event: 'provider_error', provider: 'opensubtitles', message: 'network error' }
    applyQuotaEvent(e, repo, NOW)
    expect(repo.store.size).toBe(0)
    expect(repo.calls).toEqual([])
  })

  it('api_call 200 且 endpoint 以 /download 结尾 → 清键', () => {
    const repo = fakeRepo()
    repo.set(`${QUOTA_STATE_PREFIX}opensubtitles`, JSON.stringify({ resetAt: null, observedAt: NOW - 1000 }), NOW - 1000)
    const e: FetchEvent = { event: 'api_call', provider: 'opensubtitles', endpoint: 'os/download', status: 200, durationMs: 100 }
    applyQuotaEvent(e, repo, NOW)
    expect(repo.store.has(`${QUOTA_STATE_PREFIX}opensubtitles`)).toBe(false)
    expect(repo.calls[repo.calls.length - 1]).toEqual({ method: 'delete', key: `${QUOTA_STATE_PREFIX}opensubtitles` })
  })

  it('api_call 200 但 endpoint 不是 download → 不清键', () => {
    const repo = fakeRepo()
    repo.set(`${QUOTA_STATE_PREFIX}opensubtitles`, JSON.stringify({ resetAt: null, observedAt: NOW - 1000 }), NOW - 1000)
    const e: FetchEvent = { event: 'api_call', provider: 'opensubtitles', endpoint: 'os/search', status: 200, durationMs: 100 }
    applyQuotaEvent(e, repo, NOW)
    expect(repo.store.has(`${QUOTA_STATE_PREFIX}opensubtitles`)).toBe(true)
  })

  it('api_call /download 但 status 非 200 → 不清键', () => {
    const repo = fakeRepo()
    repo.set(`${QUOTA_STATE_PREFIX}opensubtitles`, JSON.stringify({ resetAt: null, observedAt: NOW - 1000 }), NOW - 1000)
    const e: FetchEvent = { event: 'api_call', provider: 'opensubtitles', endpoint: 'os/download', status: 429, durationMs: 100 }
    applyQuotaEvent(e, repo, NOW)
    expect(repo.store.has(`${QUOTA_STATE_PREFIX}opensubtitles`)).toBe(true)
  })
})
