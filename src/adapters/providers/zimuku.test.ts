import { describe, it, expect, vi } from 'vitest'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSearchResults, parseDetailPage, ZIMUKU_BASE, ZimukuClient, type ZimukuClientOpts } from './zimuku.js'
import { MinIntervalLimiter } from './assrt.js'
import { ZimukuSessionStore } from './zimukuSession.js'
import { ZimukuChallengeError } from './yunsuo.js'

// 2026-07-19 zimuku 单源大考实弹回归锁:ZIMUKU_BASE 必须是 apex `https://zimuku.org`,不能带
// www。根因铁证——`www.zimuku.org` 现返回 301,且 nginx 的 Location 拼接坏了:`/search?q=x`
// 被重写成 `https://zimuku.orgsearch?q=x`(host 与 path 之间漏了斜杠),Node fetch 默认自动跟随
// 重定向 → getaddrinfo ENOTFOUND `zimuku.orgsearch` → "TypeError: fetch failed"。apex `/detail/
// N.html` 直出 200、`/search` 直出云锁挑战页(正是 detectChallenge 要接的)。这条锁防止有人把
// base 改回 www 让全站请求再次静默炸在传输层(单测全走离线夹具,永远碰不到真重定向)。
describe('ZIMUKU_BASE', () => {
  it('is the apex host, never www (www 301-redirects with a broken Location that resolves to a garbage host)', () => {
    expect(ZIMUKU_BASE).toBe('https://zimuku.org')
    expect(ZIMUKU_BASE.startsWith('https://www.')).toBe(false)
  })
})

describe('parseSearchResults', () => {
  it('extracts id + title from every /detail/<id>.html anchor (fixture has varied attribute order and quote style)', () => {
    const html = readFileSync('fixtures/zimuku/search-spy-family.html', 'utf8')
    const results = parseSearchResults(html)
    expect(results).toEqual([
      { id: '58421', title: '间谍过家家 第一季 SPY×FAMILY' },
      { id: '58422', title: '间谍过家家 第二季 SPY×FAMILY Season 2' },
    ])
  })

  it('returns an empty array for a page with no results', () => {
    expect(parseSearchResults('<html><body>没有找到相关字幕</body></html>')).toEqual([])
  })

  it('is attribute-order and quote agnostic: href-first, href-after-class, single-quoted href, extra attrs, title-attr decoy', () => {
    const html = `
      <a href="/detail/1.html">Href First</a>
      <a class="title-link" href="/detail/2.html">Href After Class</a>
      <a href='/detail/3.html'>Single Quoted Href</a>
      <a class="x" href="/detail/4.html" title="精校版" data-track="search-result">Extra Attrs</a>
      <a title="预告: </a> 佯攻收尾" href="/detail/5.html" class="y">Title Attr Decoy</a>
    `
    expect(parseSearchResults(html)).toEqual([
      { id: '1', title: 'Href First' },
      { id: '2', title: 'Href After Class' },
      { id: '3', title: 'Single Quoted Href' },
      { id: '4', title: 'Extra Attrs' },
      { id: '5', title: 'Title Attr Decoy' },
    ])
  })

  it('ignores unrelated <a> tags (nav/footer links) mixed in with real result anchors', () => {
    const html = `
      <a href="/">首页</a>
      <a href="/detail/58421.html">间谍过家家</a>
      <a href="/about">关于我们</a>
    `
    expect(parseSearchResults(html)).toEqual([{ id: '58421', title: '间谍过家家' }])
  })

  it('strips nested markup inside the anchor text (e.g. a wrapping <span>) when deriving the title', () => {
    const html = '<a href="/detail/9.html"><span class="hl">间谍过家家</span></a>'
    expect(parseSearchResults(html)).toEqual([{ id: '9', title: '间谍过家家' }])
  })
})

describe('parseDetailPage', () => {
  it('extracts the absolute download url and derives the filename from it (fixture has href before id="down")', () => {
    const html = readFileSync('fixtures/zimuku/detail-58421.html', 'utf8')
    const r = parseDetailPage(html, ZIMUKU_BASE)
    expect(r).toEqual({
      downloadUrl: 'https://static.zimuku.org/files/2026/07/12/spy_family_s01_zh.zip',
      filename: 'spy_family_s01_zh.zip',
    })
  })

  it('throws when the page has no id="down" download link (page shape drift)', () => {
    expect(() => parseDetailPage('<html><body>no download link</body></html>', ZIMUKU_BASE))
      .toThrow(/id="down"/)
  })

  it('is attribute-order and quote agnostic for the id="down" anchor: id-first, href-first, extra attrs, single-quoted', () => {
    const cases = [
      '<a id="down" href="https://static.zimuku.org/x.zip">下载</a>',
      '<a href="https://static.zimuku.org/x.zip" id="down">下载</a>',
      '<a class="btn" href="https://static.zimuku.org/x.zip" id="down" title="点击下载">下载</a>',
      "<a id='down' href='https://static.zimuku.org/x.zip'>下载</a>",
    ]
    for (const html of cases) {
      expect(parseDetailPage(html, ZIMUKU_BASE).downloadUrl).toBe('https://static.zimuku.org/x.zip')
    }
  })
})


describe('ZimukuClient', () => {
  function client(overrides: Partial<ZimukuClientOpts> = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'zimuku-client-'))
    return new ZimukuClient({
      sessionStore: new ZimukuSessionStore(dir),
      solve: vi.fn(async () => ({ digits: '00000' })),
      limiter: new MinIntervalLimiter(1), // 测试用 1ms 起步间隔,避免真的等 2s
      ...overrides,
    })
  }

  it('search: fetches /search?q=..., sends browser headers, parses results (no challenge)', async () => {
    const searchHtml = readFileSync('fixtures/zimuku/search-spy-family.html', 'utf8')
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(String(url)).toBe('https://zimuku.org/search?q=%E9%97%B4%E8%B0%8D%E8%BF%87%E5%AE%B6%E5%AE%B6')
      expect((init!.headers as Record<string, string>)['User-Agent']).toContain('Mozilla')
      expect((init!.headers as Record<string, string>)['Accept-Language']).toBe('zh-CN,zh;q=0.9')
      return new Response(searchHtml)
    })
    const c = client({ fetchImpl: fetchImpl as unknown as typeof fetch })
    const results = await c.search('间谍过家家')
    expect(results).toEqual([
      { id: '58421', title: '间谍过家家 第一季 SPY×FAMILY' },
      { id: '58422', title: '间谍过家家 第二季 SPY×FAMILY Season 2' },
    ])
  })

  it('detail: fetches /detail/<id>.html and parses the download link', async () => {
    const detailHtml = readFileSync('fixtures/zimuku/detail-58421.html', 'utf8')
    const fetchImpl = vi.fn(async () => new Response(detailHtml))
    const c = client({ fetchImpl: fetchImpl as unknown as typeof fetch })
    const r = await c.detail('58421')
    expect(r).toEqual({
      downloadUrl: 'https://static.zimuku.org/files/2026/07/12/spy_family_s01_zh.zip',
      filename: 'spy_family_s01_zh.zip',
    })
  })

  it('respects the MinIntervalLimiter between requests (politeness)', async () => {
    const searchHtml = readFileSync('fixtures/zimuku/search-spy-family.html', 'utf8')
    const fetchImpl = vi.fn(async () => new Response(searchHtml))
    const limiter = new MinIntervalLimiter(50)
    const waitSpy = vi.spyOn(limiter, 'wait')
    const c = client({ fetchImpl: fetchImpl as unknown as typeof fetch, limiter })
    await c.search('x')
    expect(waitSpy).toHaveBeenCalled()
  })

  it('on first hitting the challenge page, solves it, caches the cookie, and retries the original request once', async () => {
    const challengeHtml = readFileSync('fixtures/zimuku/challenge.html', 'utf8')
    const searchHtml = readFileSync('fixtures/zimuku/search-spy-family.html', 'utf8')
    let searchCallCount = 0
    const fetchImpl = vi.fn(async (url: string) => {
      const u = String(url)
      if (u.includes('/search?q=')) {
        searchCallCount++
        return searchCallCount === 1 ? new Response(challengeHtml) : new Response(searchHtml)
      }
      if (u.includes('security_verify_img')) return new Response(Buffer.from('png'))
      // captcha 表单提交
      return new Response('ok', { headers: { 'set-cookie': 'security_session_verify=cached123; Path=/' } })
    })
    const solve = vi.fn(async () => ({ digits: '74504' }))
    const sessionStore = new ZimukuSessionStore(mkdtempSync(join(tmpdir(), 'zimuku-client-')))
    const c = new ZimukuClient({
      sessionStore, solve, fetchImpl: fetchImpl as unknown as typeof fetch, limiter: new MinIntervalLimiter(1),
    })
    const results = await c.search('间谍过家家')
    expect(results.length).toBe(2)
    expect(searchCallCount).toBe(2) // 首次撞挑战页 + 破解后重试一次
    expect(sessionStore.get()?.cookie).toBe('security_session_verify=cached123')
  })

  it('reuses a cached cookie without re-solving when the session store already has one and the site does not challenge', async () => {
    const searchHtml = readFileSync('fixtures/zimuku/search-spy-family.html', 'utf8')
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect((init!.headers as Record<string, string>).Cookie).toBe('security_session_verify=warm456')
      return new Response(searchHtml)
    })
    const solve = vi.fn()
    const sessionStore = new ZimukuSessionStore(mkdtempSync(join(tmpdir(), 'zimuku-client-')))
    sessionStore.put({ cookie: 'security_session_verify=warm456', capturedAt: Date.now() })
    const c = new ZimukuClient({
      sessionStore, solve, fetchImpl: fetchImpl as unknown as typeof fetch, limiter: new MinIntervalLimiter(1),
    })
    await c.search('x')
    expect(solve).not.toHaveBeenCalled()
  })

  it('invalidates the cookie and throws ZimukuChallengeError when still challenged immediately after solving', async () => {
    const challengeHtml = readFileSync('fixtures/zimuku/challenge.html', 'utf8')
    const fetchImpl = vi.fn(async (url: string) => {
      const u = String(url)
      if (u.includes('/search?q=')) return new Response(challengeHtml) // 每次都是挑战页——破解后仍被拦
      if (u.includes('security_verify_img')) return new Response(Buffer.from('png'))
      return new Response('ok', { headers: { 'set-cookie': 'security_session_verify=stillbad; Path=/' } })
    })
    const solve = vi.fn(async () => ({ digits: '74504' }))
    const dir = mkdtempSync(join(tmpdir(), 'zimuku-client-'))
    const sessionStore = new ZimukuSessionStore(dir)
    const c = new ZimukuClient({
      sessionStore, solve, fetchImpl: fetchImpl as unknown as typeof fetch, limiter: new MinIntervalLimiter(1),
    })
    await expect(c.search('x')).rejects.toThrow(ZimukuChallengeError)
    expect(sessionStore.get()).toBeNull() // 失效的 cookie 没有残留在缓存里
  })

  it('without an explicit limiter override, defaults to a randomized 2-5s inter-request delay (RNG injectable)', async () => {
    vi.useFakeTimers()
    try {
      const searchHtml = readFileSync('fixtures/zimuku/search-spy-family.html', 'utf8')
      const fetchImpl = vi.fn(async () => new Response(searchHtml))
      const dir = mkdtempSync(join(tmpdir(), 'zimuku-client-'))
      const rng = () => 0 // 恒定取下限:每次目标恰好是 2000ms(可预测,便于断言边界)
      const c = new ZimukuClient({
        sessionStore: new ZimukuSessionStore(dir), solve: vi.fn(),
        fetchImpl: fetchImpl as unknown as typeof fetch, rng,
      })
      await c.search('x') // 首次请求:没有节流历史,立即发出
      let done = false
      c.search('y').then(() => { done = true })
      await vi.advanceTimersByTimeAsync(1999)
      expect(done).toBe(false) // 还没到 2000ms 下限,不该提前放行
      await vi.advanceTimersByTimeAsync(2)
      expect(done).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('with a jittered rng draw above the floor, waits past 2000ms (not a fixed 2000ms floor)', async () => {
    vi.useFakeTimers()
    try {
      const searchHtml = readFileSync('fixtures/zimuku/search-spy-family.html', 'utf8')
      const fetchImpl = vi.fn(async () => new Response(searchHtml))
      const dir = mkdtempSync(join(tmpdir(), 'zimuku-client-'))
      const rng = () => 1 // 恒定取上限:每次目标是 2000 + 1*3000 = 5000ms
      const c = new ZimukuClient({
        sessionStore: new ZimukuSessionStore(dir), solve: vi.fn(),
        fetchImpl: fetchImpl as unknown as typeof fetch, rng,
      })
      await c.search('x')
      let done = false
      c.search('y').then(() => { done = true })
      await vi.advanceTimersByTimeAsync(2000) // 旧的固定 2000ms 楼层本会在这里放行——新实现不该
      expect(done).toBe(false)
      await vi.advanceTimersByTimeAsync(3000)
      expect(done).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
