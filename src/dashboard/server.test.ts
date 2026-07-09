// src/dashboard/server.test.ts
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import { startDashboard } from './server.js'

let server: Server | undefined
afterEach(() => server?.close())

function fixtureCache(): { root: string; journalId: string } {
  const root = mkdtempSync(join(tmpdir(), 'dash-'))
  const now = Date.now()
  const led = [
    { ts: now, type: 'run', itemId: 'i', name: 'Overflow', source: 'queue', decision: 'download', confidence: 0.9, subtitlePath: '/m/x.ass', journalPath: join(root, `journals/i-${now}/decision.json`), llmProfile: { mode: 'forced-tool' }, durationMs: 1, llmCalls: 1, assrtCalls: 1, error: null },
  ].map(e => JSON.stringify(e)).join('\n')
  mkdirSync(join(root, `journals/i-${now}`), { recursive: true })
  writeFileSync(join(root, 'ledger.jsonl'), led)
  writeFileSync(join(root, `journals/i-${now}/decision.json`), JSON.stringify({
    request_id: 'r', finished_at: 't',
    decision: { request_id: 'r', decision: 'download', confidence: 0.9, selected: { assrt_id: 1, subtitle_name: 'S', language: 'zh-Hans', format: 'ass' }, reasons: [], verification: { downloaded: true, path: '/m/x.ass' } },
    steps: [{ name: 'identify', at: 't' }], llm_calls: [], api_calls: [],
  }))
  const dist = join(root, 'dist')
  mkdirSync(dist, { recursive: true })
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>scout</title>')
  return { root, journalId: `i-${now}` }
}

async function start(cacheRoot: string, token?: string): Promise<{ base: string }> {
  server = await startDashboard({ cacheRoot, port: 0, token, distDir: join(cacheRoot, 'dist'), getInFlight: () => [] })
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  return { base: `http://127.0.0.1:${port}` }
}

describe('startDashboard', () => {
  it('serves summary/runs/story from real files', async () => {
    const { root, journalId } = fixtureCache()
    const { base } = await start(root)
    expect((await (await fetch(`${base}/api/summary`)).json()).status).toBe('running')
    const runs = await (await fetch(`${base}/api/runs`)).json()
    expect(runs.runs[0]).toMatchObject({ name: 'Overflow', outcomeLabel: '已下好中文字幕', id: journalId })
    const story = await (await fetch(`${base}/api/runs/${journalId}`)).json()
    expect(story.steps[0].title).toBe('认出这部片')
  })
  it('serves static index.html at /', async () => {
    const { root } = fixtureCache()
    const { base } = await start(root)
    const res = await fetch(`${base}/`)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(await res.text()).toContain('scout')
  })
  it('rejects api without token when configured (401)', async () => {
    const { root } = fixtureCache()
    const { base } = await start(root, 's3cret')
    expect((await fetch(`${base}/api/summary`)).status).toBe(401)
    expect((await fetch(`${base}/api/summary?token=s3cret`)).status).toBe(200)
  })
  it('rejects journal id path-traversal (400)', async () => {
    const { root } = fixtureCache()
    const { base } = await start(root)
    expect((await fetch(`${base}/api/runs/..%2f..%2fpackage`)).status).toBe(400)
  })
})
