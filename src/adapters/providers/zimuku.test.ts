import { describe, it, expect, vi } from 'vitest'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSearchResults, parseDetailPage, parseDldPage, ZIMUKU_BASE, ZimukuClient, type ZimukuClientOpts } from './zimuku.js'
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
  it('extracts id + title from the real live search page whose hrefs are protocol-relative absolute URLs (//zimuku.org/detail/<id>.html), title from the <b> inner text', () => {
    // 2026-07-19 抓包的真实 "Pulp" 搜索页(9 条候选)。真站 href 是协议相对绝对 URL
    // `//zimuku.org/detail/<id>.html`,不是路径式 `/detail/<id>.html`——旧的 `^` 锚正则全失配。
    const html = readFileSync('fixtures/zimuku/live-search-pulp-20260719.html', 'utf8')
    const results = parseSearchResults(html)
    expect(results.length).toBeGreaterThanOrEqual(8)
    expect(results[0]).toEqual({
      id: '179286',
      title: 'rrh-pulp.a.film.about.life.death.supermarkets.srt',
    })
  })

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
  it('locates the /dld/<id>.html download anchor on the real detail page (id="down1") and returns the absolute dld url', () => {
    // 真站(2026-07-19)的详情页下载锚点是 `<a id="down1" href="/dld/179286.html">`——间接下载页,
    // 不是直链 static URL。parseDetailPage 现返回 { dldUrl },filename 改由下载层 Content-Disposition 提供。
    const html = readFileSync('fixtures/zimuku/live-detail-179286-20260719.html', 'utf8')
    expect(parseDetailPage(html, ZIMUKU_BASE)).toEqual({ dldUrl: 'https://zimuku.org/dld/179286.html' })
  })

  it('throws when the page has no /dld/<id>.html download link (page shape drift)', () => {
    expect(() => parseDetailPage('<html><body>no download link</body></html>', ZIMUKU_BASE))
      .toThrow(/dld/)
  })

  it('matches by href shape (/dld/<id>.html), not id name: id-first, href-first, extra attrs, single-quoted', () => {
    // 按 href 形状匹配而不是绑定 id 名(真站是 down1,合成页可能是别的)——版面改版最稳的锚点。
    const cases = [
      '<a id="down1" href="/dld/179286.html">下载</a>',
      '<a href="/dld/179286.html" id="down1" rel="nofollow">下载</a>',
      '<a class="btn" id="whatever" href="/dld/179286.html" title="点击下载">下载</a>',
      "<a id='down1' href='/dld/179286.html'>下载</a>",
    ]
    for (const html of cases) {
      expect(parseDetailPage(html, ZIMUKU_BASE).dldUrl).toBe('https://zimuku.org/dld/179286.html')
    }
  })
})

describe('parseDldPage', () => {
  it('extracts every mirror download url (/download/<token>/svr/<mirror>) as an absolute url, in order', () => {
    // 真站 dld 高速下载页(2026-07-19):多条镜像线路 /download/<base64token>/svr/{d0,d1,l0,l1,y0}。
    const html = readFileSync('fixtures/zimuku/live-dld-179286-20260719.html', 'utf8')
    const { mirrorUrls } = parseDldPage(html, ZIMUKU_BASE)
    expect(mirrorUrls.length).toBeGreaterThanOrEqual(3)
    expect(mirrorUrls[0].startsWith('https://zimuku.org/download/')).toBe(true)
    expect(mirrorUrls[0]).toContain('/svr/')
  })

  it('throws when the page has no /download/.../svr mirror links (page shape drift)', () => {
    expect(() => parseDldPage('<html><body>no mirrors here</body></html>', ZIMUKU_BASE))
      .toThrow(/mirror|download/)
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

  it('detail: fetches /detail/<id>.html and parses the /dld download link', async () => {
    const detailHtml = readFileSync('fixtures/zimuku/live-detail-179286-20260719.html', 'utf8')
    const fetchImpl = vi.fn(async () => new Response(detailHtml))
    const c = client({ fetchImpl: fetchImpl as unknown as typeof fetch })
    const r = await c.detail('179286')
    expect(r).toEqual({ dldUrl: 'https://zimuku.org/dld/179286.html' })
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

  it('on first hitting the challenge page, solves it via the real yunsuo protocol (pending cookie + high_verify), caches the combined session cookie, and retries the original request', async () => {
    // 真实 golden fixtures:14202B 活挑战页 + 923B 成功中间页(2026-07-19 抓包)
    const challengeHtml = readFileSync('fixtures/zimuku/live-redirect-challenge-20260719.html', 'utf8')
    const interstitial = readFileSync('fixtures/zimuku/verify-success-interstitial-20260719.html', 'utf8')
    const searchHtml = readFileSync('fixtures/zimuku/search-spy-family.html', 'utf8')
    let challengeFetches = 0
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url)
      const cookie = (init?.headers as Record<string, string> | undefined)?.Cookie ?? ''
      if (u.includes('security_verify_img=')) {
        // 验证码提交:必须回带挑战页下发的 pending security_session_verify + srcurl → 答对下发 high_verify
        expect(cookie).toContain('security_session_verify=PEND')
        expect(cookie).toContain('srcurl=')
        return new Response(interstitial, { headers: { 'set-cookie': 'security_session_high_verify=HIGH; Path=/' } })
      }
      if (u.includes('/search?q=')) {
        // 带 high_verify 的重试请求 → 放行真实内容;否则仍是挑战页(下发一个 pending)
        if (cookie.includes('security_session_high_verify')) return new Response(searchHtml)
        challengeFetches++
        return new Response(challengeHtml, { headers: { 'set-cookie': `security_session_verify=PEND${challengeFetches}; Path=/` } })
      }
      throw new Error(`unexpected fetch in test: ${u}`)
    })
    const solve = vi.fn(async () => ({ digits: '88640' })) // golden 铁证 captcha5=88640
    const sessionStore = new ZimukuSessionStore(mkdtempSync(join(tmpdir(), 'zimuku-client-')))
    const c = new ZimukuClient({
      sessionStore, solve, fetchImpl: fetchImpl as unknown as typeof fetch, limiter: new MinIntervalLimiter(1),
    })
    const results = await c.search('Pulp')
    expect(results.length).toBe(2)
    // 首发撞挑战页(call1) + fetchChallenge 重抓一张新鲜挑战页(call2)各消耗一次
    expect(challengeFetches).toBe(2)
    // 缓存的是组合串:pending security_session_verify + 验证令牌 security_session_high_verify,后续整串带上
    expect(sessionStore.get()?.cookie).toBe('security_session_verify=PEND2; security_session_high_verify=HIGH')
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
    const challengeHtml = readFileSync('fixtures/zimuku/live-redirect-challenge-20260719.html', 'utf8')
    const interstitial = readFileSync('fixtures/zimuku/verify-success-interstitial-20260719.html', 'utf8')
    let pendingSeq = 0
    const fetchImpl = vi.fn(async (url: string) => {
      const u = String(url)
      // 破解本身"成功"(下发 high_verify)……
      if (u.includes('security_verify_img=')) {
        return new Response(interstitial, { headers: { 'set-cookie': 'security_session_high_verify=HIGH; Path=/' } })
      }
      // ……但每次 /search 都还是挑战页(即便带了验证 cookie)→ 破解后重试仍被拦
      return new Response(challengeHtml, { headers: { 'set-cookie': `security_session_verify=PEND${++pendingSeq}; Path=/` } })
    })
    const solve = vi.fn(async () => ({ digits: '88640' }))
    const dir = mkdtempSync(join(tmpdir(), 'zimuku-client-'))
    const sessionStore = new ZimukuSessionStore(dir)
    const c = new ZimukuClient({
      sessionStore, solve, fetchImpl: fetchImpl as unknown as typeof fetch, limiter: new MinIntervalLimiter(1),
    })
    await expect(c.search('Pulp')).rejects.toThrow(ZimukuChallengeError)
    expect(sessionStore.get()).toBeNull() // 失效的 cookie 没有残留在缓存里
  })

  it('retries the content fetch when the freshly-minted verified cookie is challenged before it propagates (2026-07-19 实测:同一有效 cookie 前脚被拒后脚放行)', async () => {
    const challengeHtml = readFileSync('fixtures/zimuku/live-redirect-challenge-20260719.html', 'utf8')
    const interstitial = readFileSync('fixtures/zimuku/verify-success-interstitial-20260719.html', 'utf8')
    const searchHtml = readFileSync('fixtures/zimuku/search-spy-family.html', 'utf8')
    let verifiedContentFetches = 0
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url)
      const cookie = (init?.headers as Record<string, string> | undefined)?.Cookie ?? ''
      if (u.includes('security_verify_img=')) {
        return new Response(interstitial, { headers: { 'set-cookie': 'security_session_high_verify=HIGH; Path=/' } })
      }
      if (cookie.includes('security_session_high_verify')) {
        // 带验证令牌的内容请求:头两次仍被挑战(节点未识别),第三次才放行——验证有界重试真的重试
        verifiedContentFetches++
        if (verifiedContentFetches < 3) return new Response(challengeHtml, { headers: { 'set-cookie': 'security_session_verify=X; Path=/' } })
        return new Response(searchHtml)
      }
      return new Response(challengeHtml, { headers: { 'set-cookie': 'security_session_verify=PEND; Path=/' } })
    })
    const solve = vi.fn(async () => ({ digits: '88640' }))
    const sessionStore = new ZimukuSessionStore(mkdtempSync(join(tmpdir(), 'zimuku-client-')))
    const c = new ZimukuClient({
      sessionStore, solve, fetchImpl: fetchImpl as unknown as typeof fetch, limiter: new MinIntervalLimiter(1),
    })
    const results = await c.search('Pulp')
    expect(results.length).toBe(2)          // 第三次内容请求成功拿到真实结果
    expect(verifiedContentFetches).toBe(3)  // 前两次被挑战、第三次放行——CONTENT_VERIFY_ATTEMPTS 生效
    expect(solve).toHaveBeenCalledTimes(1)  // 只破解一次,内容重试不重新破解验证码
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
