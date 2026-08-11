// src/dashboard/eventStream.test.ts —— R-F10 全站单条 SSE 通道（GET /api/v2/events）的行为锁。
//
// 为什么单独一个文件而不是塞进 server.test.ts：那个文件已知在全套件并行下偶发失败
// （`port: 0` 端口复用，~1/10，与代码无因果，见文件头 afterEach 的长注释）。本条通道的用例
// 全是长连接 + 流式读，混进去会让"是我改坏的还是那条既有 flake"变得无法区分。
//
// 本文件覆盖：四类事件送达 / 反例（不该推的不推，由发布方保证——这里只锁"总线里没有的东西
// 流上不会凭空出现"）/ 心跳只发注释帧 / Last-Event-ID 续传 / 多订阅者互不挤占 /
// 断开清理 / 响应头 / 鉴权（与其它端点同一道门）。
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from 'undici'
import type { Server } from 'node:http'
import { openDb, type ScoutDb } from '../v2/db.js'
import { startDashboard } from './server.js'
import { ScoutEventBus } from '../core/scoutEvents.js'
import { AuthService } from './auth.js'
import { SettingsRepo } from '../v2/settingsRepo.js'

let server: Server | undefined
let db: ScoutDb

// 同 server.test.ts 的两层隔离（服务端断 keep-alive + 客户端换 dispatcher）——理由见那边的
// 长注释（`port: 0` + undici 连接池缓存会让上一个用例的连接打到下一个 server 上）。
afterEach(async () => {
  const s = server
  server = undefined
  if (s) {
    s.closeAllConnections?.()
    await new Promise<void>((resolve) => s.close(() => resolve()))
  }
  const prev = getGlobalDispatcher()
  setGlobalDispatcher(new Agent())
  await prev.close().catch(() => {})
})

beforeEach(() => { db = openDb(':memory:') })

function distWith(html: string): string {
  const dist = mkdtempSync(join(tmpdir(), 'evt-dist-'))
  writeFileSync(join(dist, 'index.html'), html)
  return dist
}

async function start(opts: { events?: ScoutEventBus | null; token?: string; heartbeatMs?: number } = {}) {
  server = await startDashboard({
    db, port: 0, token: opts.token, distDir: distWith('<!doctype html>'),
    // 默认接一条总线：绝大多数用例关心的是流本身，不是"没接线怎么办"（那一条单独测）。
    events: opts.events === null ? undefined : (opts.events ?? new ScoutEventBus()),
    eventsHeartbeatMs: opts.heartbeatMs,
  })
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  return { base: `http://127.0.0.1:${port}` }
}

/** 读流直到 predicate 满足或超时。**不定时等固定时长**：那既慢又脆。 */
async function readUntil(
  res: Response, predicate: (buf: string) => boolean, timeoutMs = 2000,
): Promise<string> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  const deadline = Date.now() + timeoutMs
  while (!predicate(buf)) {
    if (Date.now() > deadline) throw new Error(`timeout waiting; got: ${JSON.stringify(buf)}`)
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
  }
  return buf
}

/** 等 server 端 handler 真正跑到 subscribe（同 server.test.ts trace-stream 用例的既有手法）。 */
const settle = () => new Promise((r) => setTimeout(r, 20))

describe('GET /api/v2/events（R-F10 全站单条 SSE 通道）', () => {
  it('SSE 响应头正确：text/event-stream / no-cache / keep-alive', async () => {
    const { base } = await start({ token: 'tok' })
    const ctrl = new AbortController()
    const res = await fetch(`${base}/api/v2/events?token=tok`, { signal: ctrl.signal })
    try {
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/event-stream')
      expect(res.headers.get('cache-control')).toContain('no-cache')
      expect(res.headers.get('connection')).toBe('keep-alive')
    } finally { ctrl.abort() }
  })

  it('非 GET → 405', async () => {
    const { base } = await start({ token: 'tok' })
    const res = await fetch(`${base}/api/v2/events?token=tok`, { method: 'POST' })
    expect(res.status).toBe(405)
  })

  describe('鉴权（与其它 /api/* 端点同一道前置门）', () => {
    it('🔴 legacy token 配置时无凭据 401，带 token 200', async () => {
      const { base } = await start({ token: 's3cret' })
      expect((await fetch(`${base}/api/v2/events`)).status).toBe(401)
      const ctrl = new AbortController()
      const ok = await fetch(`${base}/api/v2/events?token=s3cret`, { signal: ctrl.signal })
      try { expect(ok.status).toBe(200) } finally { ctrl.abort() }
    })

    it('🔴 apiKey 通道同样放行（前端 EventSource 不能带自定义头，走 ?apikey=）', async () => {
      const auth = new AuthService(new SettingsRepo(db))
      const r = auth.setup('admin', 'pw-long-enough-123', Date.now())
      expect(r.ok).toBe(true)
      const apiKey = (r as { ok: true; apiKey: string }).apiKey
      const { base } = await start({})
      expect((await fetch(`${base}/api/v2/events`)).status).toBe(401)
      const ctrl = new AbortController()
      const ok = await fetch(`${base}/api/v2/events?apikey=${apiKey}`, { signal: ctrl.signal })
      try { expect(ok.status).toBe(200) } finally { ctrl.abort() }
    })

    it('🔴 session cookie 通道同样放行', async () => {
      const auth = new AuthService(new SettingsRepo(db))
      auth.setup('admin', 'pw-long-enough-123', Date.now())
      const token = auth.sessions.create(Date.now())
      const { base } = await start({})
      const ctrl = new AbortController()
      const ok = await fetch(`${base}/api/v2/events`, {
        headers: { cookie: `scout_session=${token}` }, signal: ctrl.signal,
      })
      try { expect(ok.status).toBe(200) } finally { ctrl.abort() }
    })
  })

  it('四类事件都以 `event:` 字段区分后到达同一条流（全站一条连接）', async () => {
    const events = new ScoutEventBus()
    const { base } = await start({ events, token: 'tok' })
    const ctrl = new AbortController()
    const res = await fetch(`${base}/api/v2/events?token=tok`, { signal: ctrl.signal })
    try {
      await settle()
      events.publish({ type: 'activity', message: '巡检开始' })
      events.publish({ type: 'found', message: '装上了字幕', title: '甲剧' })
      events.publish({ type: 'health', message: '守备目录读取失败' })
      events.publish({ type: 'progress', message: '第 3/8 集' })
      const buf = await readUntil(res, (b) => b.includes('event: progress'))
      expect(buf).toContain('event: activity')
      expect(buf).toContain('event: found')
      expect(buf).toContain('event: health')
      expect(buf).toContain('event: progress')
      // id: 字段必须在（浏览器靠它维护 Last-Event-ID）
      expect(buf).toMatch(/(^|\n)id: 1\n/)
      expect(buf).toContain('"message":"巡检开始"')
    } finally { ctrl.abort() }
  })

  it('🔴 不该推的不推：排障类日志形态从不出现在流上（R-F10 反面清单）', async () => {
    const events = new ScoutEventBus()
    const { base } = await start({ events, token: 'tok' })
    const ctrl = new AbortController()
    const res = await fetch(`${base}/api/v2/events?token=tok`, { signal: ctrl.signal })
    try {
      await settle()
      // 这些是 daemon 真实会打的日志形态——它们**没有对应的 emit 调用**，所以总线里根本
      // 不存在。这条用例锁的是"通道不会替它们凭空造事件"（比如某天有人加回 log 旁路解析）。
      events.publish({ type: 'found', message: 'SENTINEL-哨兵' })
      const buf = await readUntil(res, (b) => b.includes('SENTINEL-哨兵'))
      expect(buf).not.toContain('probe wrote=')
      expect(buf).not.toContain('judge: 判定')
      expect(buf).not.toContain('回填:')
      expect(buf).not.toContain('trace 修剪')
      expect(buf).not.toContain('清理写探针')
    } finally { ctrl.abort() }
  })

  it('🔴 没有事件时不发心跳数据帧——保活只用 SSE 注释帧（R-F10 约束 1）', async () => {
    const events = new ScoutEventBus()
    // 心跳周期注入成 10ms（生产 15s）：不注入就得真等 15 秒。
    const { base } = await start({ events, token: 'tok', heartbeatMs: 10 })
    const ctrl = new AbortController()
    const res = await fetch(`${base}/api/v2/events?token=tok`, { signal: ctrl.signal })
    try {
      // 连收 3 个心跳，期间一条事件都不发布
      const buf = await readUntil(res, (b) => (b.match(/: ping/g) ?? []).length >= 3)
      expect(buf).not.toContain('data:')
      expect(buf).not.toContain('event:')
      // 逐行核对：注释帧之外只允许 SSE 的空行分隔符，不许有任何 data:/event:/id: 行。
      expect(buf.split('\n').every((l) => l === '' || l.startsWith(':'))).toBe(true)
    } finally { ctrl.abort() }
  })

  it('🔴 Last-Event-ID 重连补发漏掉的事件（手机锁屏再打开的那一档）', async () => {
    const events = new ScoutEventBus()
    const { base } = await start({ events, token: 'tok' })
    // 第一条连接期间发 1 条，然后"断线"
    const c1 = new AbortController()
    const r1 = await fetch(`${base}/api/v2/events?token=tok`, { signal: c1.signal })
    await settle()
    events.publish({ type: 'found', message: '第一条' })
    await readUntil(r1, (b) => b.includes('第一条'))
    c1.abort()
    // 断线期间又发生了两条
    events.publish({ type: 'found', message: '断线期间A' })
    events.publish({ type: 'found', message: '断线期间B' })
    // 重连带 Last-Event-ID: 1
    const c2 = new AbortController()
    const r2 = await fetch(`${base}/api/v2/events?token=tok`, {
      headers: { 'last-event-id': '1' }, signal: c2.signal,
    })
    try {
      const buf = await readUntil(r2, (b) => b.includes('断线期间B'))
      expect(buf).toContain('断线期间A')
      expect(buf).toContain('断线期间B')
      expect(buf).not.toContain('第一条')   // 已经收过的不重复灌
    } finally { c2.abort() }
  })

  it('🔴 多个订阅者各自收到（第二条连接不许把第一条挤掉）', async () => {
    const events = new ScoutEventBus()
    const { base } = await start({ events, token: 'tok' })
    const c1 = new AbortController(); const c2 = new AbortController()
    const r1 = await fetch(`${base}/api/v2/events?token=tok`, { signal: c1.signal })
    const r2 = await fetch(`${base}/api/v2/events?token=tok`, { signal: c2.signal })
    try {
      await settle()
      expect(events.subscriberCount()).toBe(2)
      events.publish({ type: 'activity', message: '同时送两处' })
      expect(await readUntil(r1, (b) => b.includes('同时送两处'))).toContain('同时送两处')
      expect(await readUntil(r2, (b) => b.includes('同时送两处'))).toContain('同时送两处')
    } finally { c1.abort(); c2.abort() }
  })

  it('🔴 订阅者断开后必须从总线摘除（长跑 daemon 上这是真实内存泄漏）', async () => {
    const events = new ScoutEventBus()
    const { base } = await start({ events, token: 'tok' })
    const ctrl = new AbortController()
    await fetch(`${base}/api/v2/events?token=tok`, { signal: ctrl.signal })
    await settle()
    expect(events.subscriberCount()).toBe(1)
    ctrl.abort()
    // 等 server 侧 'close' 事件跑完
    for (let i = 0; i < 50 && events.subscriberCount() > 0; i++) await settle()
    expect(events.subscriberCount()).toBe(0)
  })

  it('总线未接线（events 缺席）→ 503，不是静默 200 空流', async () => {
    const { base } = await start({ token: 'tok', events: null })
    // 缺席时必须给出可诊断的 503（照 jobs/tmdb 那批可选依赖的既有降级先例），而不是让
    // 前端对着一条永远不会有数据的 200 空流干等——那种失败是静默的，正是本仓栽过 6 次的
    // "有能力但没人触发"那一类。
    const res = await fetch(`${base}/api/v2/events?token=tok`)
    expect(res.status).toBe(503)
    await res.text()
  })
})
