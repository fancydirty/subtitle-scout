// src/dashboard/eventStream.test.ts —— R-F10 全站单条 SSE 通道（GET /api/v2/events）的行为锁。
//
// 为什么单独一个文件而不是塞进 server.test.ts：那个文件曾在全套件并行下偶发失败
// （~1/10，与代码无因果）。该 flake 已于 2026-08-12 根治——真因是 listen 绑 `::` 而请求拨
// `127.0.0.1` 的跨地址族串台，不是前人以为的 undici 连接池复用；见 testServerHost.ts 头注释。
// 本文件保持独立的理由与 flake 无关：长连接 + 流式读混进去会让红的归属难判。本条通道的用例
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
import { TEST_HOST, baseOf } from './testServerHost.js'
import { ScoutEventBus } from '../core/scoutEvents.js'
import { AuthService } from './auth.js'
import { SettingsRepo } from '../v2/settingsRepo.js'

let server: Server | undefined
let db: ScoutDb

// 同 server.test.ts 的两层隔离（服务端断 keep-alive + 客户端换 dispatcher）。注意：这两层
// **不是**那条串台 flake 的解药（真因见 testServerHost.ts），保留是因为各自仍有独立价值——
// 本文件全是 SSE 长连接，closeAllConnections 让 server 立刻关干净而不是拖到连接自然超时。
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
    db, port: 0, host: TEST_HOST, token: opts.token, distDir: distWith('<!doctype html>'),
    // 默认接一条总线：绝大多数用例关心的是流本身，不是"没接线怎么办"（那一条单独测）。
    events: opts.events === null ? undefined : (opts.events ?? new ScoutEventBus()),
    eventsHeartbeatMs: opts.heartbeatMs,
  })
  return { base: baseOf(server) }
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

/** 用例里注入的固定 epoch。**注入而不是读回来**：读回来（`events.bootId()`）的断言对
 *  "bootId 被写成空串 / 每帧重新生成一个" 这类缺陷是恒真的——两边同时错就同时对上了。
 *  写死一个字面量，`id:` 行的完整形状（含分隔符与 seq）才真的被钉在用例里。 */
const BOOT = 'boot-fixed-1'

/**
 * 校验并**剥掉**连接建立时的握手前言，返回其后的流内容。
 *
 * ── 为什么是"校验并剥掉"而不是"跳过 hello 再断言"（这是本文件最容易做假的一处）──
 * 加了 hello 帧之后，两条既有断言（"事件帧带 id:"、"心跳不发 data 帧"）都因为流头上
 * 多了一帧而红。把它们改松（`toContain('id: ')`、去掉 `not.toContain('data:')`）
 * 是**假修复**：那样一来后端真的开始每 15 秒发一条心跳数据帧也照样绿，而那条断言
 * 存在的全部理由就是守 R-F10 约束 1。
 *
 * 正确的形式是让断言**精确表达它守的东西**——约束 1 守的是**心跳**（周期性、无信息量），
 * 不是握手（一次性、携带 bootId 这个真实信息）。所以：先把握手这一段**逐字核对**掉
 * （核对本身就是一条断言：hello 必须恰好是流的开头、恰好一帧、载荷恰好是那个 bootId），
 * 剩下的才是"保活期间的流"，对它断言"一个 data:/event:/id: 都不许有"。
 *
 * 这比原断言**更严**，不是更松：原来只知道"流上没有 data:"，现在还知道
 * "开头那一帧是且仅是 hello，且它带对了 epoch"。
 *
 * @param buf 从流上读到的原文
 * @param bootId 期望的 epoch
 * @returns 握手之后的流内容（`data:`/`event:`/`id:` 断言应当只对它生效）
 */
function afterHandshake(buf: string, bootId: string): string {
  const expected = `event: hello\ndata: ${JSON.stringify({ bootId })}\n\n`
  expect(
    buf.startsWith(expected),
    `握手帧必须是流的第一帧且形状精确；实际流开头: ${JSON.stringify(buf.slice(0, 120))}`,
  ).toBe(true)
  const rest = buf.slice(expected.length)
  // 握手是**一次性**的：保活期间不许再冒出第二条 hello（那就退化成心跳数据帧了，
  // 正是 R-F10 约束 1 要禁的东西——只不过换了个事件名）。
  expect(rest, `hello 出现了不止一次 → 它变成了心跳数据帧: ${JSON.stringify(rest)}`)
    .not.toContain('event: hello')
  return rest
}

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
    const events = new ScoutEventBus({ bootId: BOOT })
    const { base } = await start({ events, token: 'tok' })
    const ctrl = new AbortController()
    const res = await fetch(`${base}/api/v2/events?token=tok`, { signal: ctrl.signal })
    try {
      await settle()
      events.publish({ type: 'activity', message: '巡检开始' })
      events.publish({ type: 'found', message: '装上了字幕', title: '甲剧' })
      events.publish({ type: 'health', message: '守备目录读取失败' })
      events.publish({ type: 'progress', message: '第 3/8 集' })
      const raw = await readUntil(res, (b) => b.includes('event: progress'))
      // 先把握手核对并剥掉——它不是事件帧，下面那条 `id:` 断言只该管**事件**帧。
      const buf = afterHandshake(raw, BOOT)
      expect(buf).toContain('event: activity')
      expect(buf).toContain('event: found')
      expect(buf).toContain('event: health')
      expect(buf).toContain('event: progress')
      // id: 字段必须在（浏览器靠它维护 Last-Event-ID）。
      // ⚠️ 形状是 `<bootId>:<seq>`，**不是**裸 seq——epoch 必须编进 id 行，否则重启后的
      // 新进程收到浏览器原样回传的 `Last-Event-ID: 42` 会 replay(>42)，把自己刚发的
      // 1..42 全部跳过（服务端侧的静默失聪，改前端修不掉：那个头前端碰不到）。
      // 写全字面量而不是 /id: .+:1/：后者对"bootId 是空串"这类缺陷恒真。
      expect(buf).toMatch(new RegExp(`(^|\\n)id: ${BOOT}:1\\n`))
      // 载荷里的 id 仍是**纯数字**（前端去重门读的是它）。两者不是重复：一个是传输层的
      // 续传游标（要跨进程自证身份），一个是载荷里的业务序号。
      expect(buf).toContain('"id":1')
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
    const events = new ScoutEventBus({ bootId: BOOT })
    // 心跳周期注入成 10ms（生产 15s）：不注入就得真等 15 秒。
    const { base } = await start({ events, token: 'tok', heartbeatMs: 10 })
    const ctrl = new AbortController()
    const res = await fetch(`${base}/api/v2/events?token=tok`, { signal: ctrl.signal })
    try {
      // 连收 3 个心跳，期间一条事件都不发布
      const raw = await readUntil(res, (b) => (b.match(/: ping/g) ?? []).length >= 3)
      // ── 断言的观察窗从**握手之后**开始（这是本条唯一的改动）─────────────────
      // R-F10 约束 1 的原文：「只推变化，不推心跳。……连接保活用 SSE 注释帧（`: ping`），
      // 不占事件通道。」它约束的是**保活**——周期性的、无信息量的那一路。
      // hello 是一次性握手（每条连接恰好一帧，携带 bootId 这个真实信息），不是保活。
      // 所以观察窗应当是"握手完成之后的保活期"，而不是"整条流从第一个字节起"。
      //
      // ⚠️ 这不是把断言改松：afterHandshake 会**逐字核对**握手帧的形状、且断言它此后
      // 不再出现（第二条 hello = 换了名字的心跳数据帧，照样红）。剥掉之后的窗口里，
      // 下面三条断言与改动前**一字不差**——它们守的东西一点没少。
      const buf = afterHandshake(raw, BOOT)
      // 保活期确实跑满了 3 个心跳周期（不是"什么都没读到"导致的假绿）
      expect((buf.match(/: ping/g) ?? []).length).toBeGreaterThanOrEqual(3)
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

  it('🔴 `?lastEventId=` query 同样补发——手工重连的唯一通路（EventSource 不能带自定义头）', async () => {
    // ── 这条用例的来历（Task ⑦ 实施者发现并如实报告的缺口）────────────────────
    // 上面那条用的是**请求头**，而那个头只有浏览器**原生**重连才会带。
    // 前端的重连策略是：瞬断（CONNECTING）不插手，交给浏览器；致命错误（CLOSED）后
    // **手工 new 一个 EventSource**——而构造器不能带自定义头。
    // 于是手工重连这条路径上头**不存在**，没有 query 通路的话它等同 replay(0)，
    // 50 槽缓冲对最常走的那条重连路径完全失效，断线期间的 found 事件永久丢失。
    // （`?apikey=` 已是本端点既有的 query 先例——同一个成因：EventSource 不能带鉴权头。）
    const events = new ScoutEventBus()
    const { base } = await start({ events, token: 'tok' })
    const c1 = new AbortController()
    const r1 = await fetch(`${base}/api/v2/events?token=tok`, { signal: c1.signal })
    await settle()
    events.publish({ type: 'found', message: '第一条' })
    await readUntil(r1, (b) => b.includes('第一条'))
    c1.abort()
    events.publish({ type: 'found', message: '断线期间A' })
    events.publish({ type: 'found', message: '断线期间B' })
    // 手工重连：**不带头**，只带 query
    const c2 = new AbortController()
    const r2 = await fetch(`${base}/api/v2/events?token=tok&lastEventId=1`, { signal: c2.signal })
    try {
      const buf = await readUntil(r2, (b) => b.includes('断线期间B'))
      expect(buf).toContain('断线期间A')
      expect(buf).not.toContain('第一条')
    } finally { c2.abort() }
  })

  it('🔴 头优先于 query：浏览器自己带的那个是权威，前端无法覆盖它', async () => {
    // 两条通路并存就必须定优先级，否则"同时给了但不一样"是未定义行为。
    // 头是浏览器维护的（前端碰不到也改不了），query 是前端自己写的——冲突时信前者。
    const events = new ScoutEventBus()
    const { base } = await start({ events, token: 'tok' })
    events.publish({ type: 'found', message: 'e1' })
    events.publish({ type: 'found', message: 'e2' })
    events.publish({ type: 'found', message: 'e3' })
    const c = new AbortController()
    // 头说"我收到 2 了"，query 说"我只收到 0"——按头走，只补 e3
    const r = await fetch(`${base}/api/v2/events?token=tok&lastEventId=0`, {
      headers: { 'last-event-id': '2' }, signal: c.signal,
    })
    try {
      const buf = await readUntil(r, (b) => b.includes('e3'))
      expect(buf).not.toContain('e1')
      expect(buf).not.toContain('e2')
    } finally { c.abort() }
  })

  it('🔴 空串 `Last-Event-ID` 头必须回落到 query（`??` 收不住空串——本轮审计发现）', async () => {
    // 浏览器在**还没见过任何 `id:` 行**时（首连之后立刻断的那一档）会带一个空串
    // Last-Event-ID。空串是 falsy 但**不是** nullish，`headers[x] ?? query` 会把它当有效
    // 值收下，于是手工重建带的 query 断点被顶掉 → 明明报了断点却按 replay(0) 处理。
    // 前端有去重门，所以症状只是"每次重连重灌一遍缓冲"——静默的半失效，正因如此要有用例。
    const events = new ScoutEventBus({ bootId: BOOT })
    const { base } = await start({ events, token: 'tok' })
    events.publish({ type: 'found', message: 'e1' })
    events.publish({ type: 'found', message: 'e2' })
    events.publish({ type: 'found', message: 'e3' })
    const c = new AbortController()
    const r = await fetch(
      `${base}/api/v2/events?token=tok&lastEventId=${encodeURIComponent(`${BOOT}:2`)}`,
      { headers: { 'last-event-id': '' }, signal: c.signal },
    )
    try {
      const buf = afterHandshake(await readUntil(r, (b) => b.includes('e3')), BOOT)
      expect(buf, '空串头顶掉了 query 断点 → 重灌了 e1').not.toContain('e1')
      expect(buf, '空串头顶掉了 query 断点 → 重灌了 e2').not.toContain('e2')
    } finally { c.abort() }
  })

  it('🔴 断点的 epoch 对不上 → 从缓冲头补发（服务端侧的静默失聪修复，HTTP 层）', async () => {
    // 客户端攥着**上一个进程**的号段（浏览器原生重连会把它原样放进头，前端碰不到）。
    // 拿它当起点会把新进程刚发的 1..seq 全部跳过——页面显示"已连接"却永远不更新。
    const events = new ScoutEventBus({ bootId: BOOT })
    const { base } = await start({ events, token: 'tok' })
    events.publish({ type: 'found', message: '新进程-第1条' })
    events.publish({ type: 'found', message: '新进程-第2条' })
    const c = new AbortController()
    // 旧 epoch + 一个比当前号段大的 seq——修复前会 replay(>9) 补发 0 条
    const r = await fetch(`${base}/api/v2/events?token=tok`, {
      headers: { 'last-event-id': 'boot-PREVIOUS:9' }, signal: c.signal,
    })
    try {
      const buf = afterHandshake(await readUntil(r, (b) => b.includes('新进程-第2条')), BOOT)
      expect(buf, 'epoch 对不上却按旧号段 replay → 服务端侧静默失聪').toContain('新进程-第1条')
      // 补发的帧带的是**本次**启动的 epoch，前端据此才对得上
      expect(buf).toMatch(new RegExp(`(^|\\n)id: ${BOOT}:1\\n`))
    } finally { c.abort() }
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
