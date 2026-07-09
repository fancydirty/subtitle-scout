// src/dashboard/router.test.ts
import { describe, it, expect } from 'vitest'
import { handleApiRoute, type RouterDeps } from './router.js'

const deps: RouterDeps = {
  summary: () => ({ status: 'running', todayReady: 1, totalReady: 1, queuePending: 0, queueDormant: 0, runsInWindow: 1, windowHours: 168 }),
  runs: () => ({ inFlight: [], runs: [] }),
  story: (id) => (id === 'i-1000' ? { name: 'X', decision: 'download', outcomeLabel: '已下好中文字幕', tone: 'ok', ts: 1, steps: [], raw: { pipelineSteps: [], llmCalls: [] } } : null),
  queue: () => ({ pending: [], dormant: [] }),
}

const call = (pathname: string, opts: { query?: Record<string, string>; token?: string; configuredToken?: string } = {}) =>
  handleApiRoute({ pathname, query: opts.query ?? {}, token: opts.token }, deps, opts.configuredToken)

describe('handleApiRoute', () => {
  it('routes summary/runs/queue', () => {
    expect(call('/api/summary').status).toBe(200)
    expect(call('/api/runs').status).toBe(200)
    expect(call('/api/queue').status).toBe(200)
  })
  it('routes runs/:id and 404s unknown id', () => {
    expect(call('/api/runs/i-1000').status).toBe(200)
    expect(call('/api/runs/nope').status).toBe(404)
  })
  it('rejects path-traversal / illegal journal id with 400', () => {
    expect(call('/api/runs/..%2f..%2fetc').status).toBe(400)   // pre-decoded by server; here raw dots
    expect(call('/api/runs/a/b').status).toBe(404)             // extra segment → not a runs/:id match
    expect(handleApiRoute({ pathname: '/api/runs/a..b', query: {} }, deps).status).toBe(400)
  })
  it('enforces token when configured', () => {
    expect(call('/api/summary', { configuredToken: 's3cret' }).status).toBe(401)
    expect(call('/api/summary', { configuredToken: 's3cret', token: 'wrong' }).status).toBe(401)
    expect(call('/api/summary', { configuredToken: 's3cret', token: 's3cret' }).status).toBe(200)
  })
  it('returns 404 for non-api paths (static handled elsewhere)', () => {
    expect(call('/index.html').status).toBe(404)
  })
})
