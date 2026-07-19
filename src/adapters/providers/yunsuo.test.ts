import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  detectChallenge, parseChallenge, solveYunsuoChallenge, ZimukuChallengeError,
  type YunsuoChallenge, type YunsuoChallengeForm, type YunsuoChallengeRedirect,
} from './yunsuo.js'

/** solve() 在生产路径里是 solveNumericCaptcha(朴素 generateText + 本地 zod 校验,v3 已不走强制
 * JSON 工具调用栈),schema 校验失败时会抛出普通 Error。这里造一个独立的错误子类站在它的位置,只是
 * 为了在断言里把"solve() 抛出的具体错误类型"和"solveYunsuoChallenge 包装后抛出的 ZimukuChallengeError"
 * 区分开——验证的是类型不泄漏,而不是某个已退休的 LLM 运行时错误类。 */
class MockSolveSchemaError extends Error {}

/** 窄化辅助:先确认 kind 再访问形状专属字段,比每处都写 if/throw 样板更省事。 */
function asForm(c: YunsuoChallenge): YunsuoChallengeForm {
  if (c.kind !== 'form') throw new Error(`expected 'form' challenge shape, got '${c.kind}'`)
  return c
}
function asRedirect(c: YunsuoChallenge): YunsuoChallengeRedirect {
  if (c.kind !== 'redirect') throw new Error(`expected 'redirect' challenge shape, got '${c.kind}'`)
  return c
}

describe('detectChallenge', () => {
  it('detects the YunsuoAutoJump marker', () => {
    expect(detectChallenge('<script>function YunsuoAutoJump(){}</script>')).toBe(true)
  })
  it('detects the security_verify_img marker', () => {
    expect(detectChallenge('<img src="/x/security_verify_img?r=1">')).toBe(true)
  })
  it('returns false for ordinary content pages', () => {
    expect(detectChallenge('<html><body><h1>间谍过家家 第一季</h1></body></html>')).toBe(false)
  })
})

describe('parseChallenge (form shape — synthetic fixture, kept for backward compat)', () => {
  const html = readFileSync('fixtures/zimuku/challenge.html', 'utf8')

  it('extracts the absolute form action', () => {
    const form = asForm(parseChallenge(html, 'https://www.zimuku.org'))
    expect(form.action).toBe('https://www.zimuku.org/aq_wzws_confirm.html')
  })
  it('extracts hidden fields verbatim', () => {
    const form = asForm(parseChallenge(html, 'https://www.zimuku.org'))
    expect(form.fields).toEqual({ wzws_sessionid: '8f2c9a1b3e4d5f60', return_url: '/detail/58421.html' })
  })
  it('extracts the captcha text input name', () => {
    const form = asForm(parseChallenge(html, 'https://www.zimuku.org'))
    expect(form.captchaFieldName).toBe('sec_code')
  })
  it('extracts the absolute captcha image url', () => {
    const form = asForm(parseChallenge(html, 'https://www.zimuku.org'))
    expect(form.imageUrl).toBe('https://www.zimuku.org/aq_wzws_security_verify_img?r=0.483920')
  })
  it('throws when the page has neither a <form> nor the redirect-challenge markers (unexpected challenge page shape)', () => {
    expect(() => parseChallenge('<html><body>no form here</body></html>', 'https://www.zimuku.org'))
      .toThrow(/unexpected challenge page shape/)
  })

  it('is attribute-order and quote agnostic: value-before-name, type-last, single-quoted action, missing explicit type', () => {
    // 每一处都刻意打乱旧正则依赖的字面顺序:
    // - action 用单引号
    // - 第一个 hidden input:value 在 name 前面,type 放在最后
    // - 第二个 hidden input:type 在最前,但 value 仍在 name 前面
    // - 验证码 input:完全不写 type(HTML5 默认就是 text),maxlength 夹在中间
    // - img:alt 在 src 前面
    const html = `
      <form id="checkform" method="post" action='/confirm.html'>
        <input value="tok123" name="wzws_sessionid" type="hidden" />
        <input type="hidden" value="/detail/1.html" name="return_url" />
        <img alt="verify code" src="/verify_img?r=1" />
        <input maxlength="6" name="sec_code" />
      </form>
    `
    const form = asForm(parseChallenge(html, 'https://www.zimuku.org'))
    expect(form.action).toBe('https://www.zimuku.org/confirm.html')
    expect(form.fields).toEqual({ wzws_sessionid: 'tok123', return_url: '/detail/1.html' })
    expect(form.captchaFieldName).toBe('sec_code')
    expect(form.imageUrl).toBe('https://www.zimuku.org/verify_img?r=1')
  })

  it('finds the captcha field when type="text" comes after name (order-agnostic, explicit type)', () => {
    const html = `
      <form action="/confirm.html">
        <input type="hidden" name="tok" value="x" />
        <input name="sec_code" type="text" maxlength="6" />
        <img src="/verify_img" />
      </form>
    `
    const form = asForm(parseChallenge(html, 'https://www.zimuku.org'))
    expect(form.captchaFieldName).toBe('sec_code')
  })
})

describe('parseChallenge (redirect shape — real zimuku.org JS-redirect challenge page, no <form>)', () => {
  const html = readFileSync('fixtures/zimuku/real-challenge.html', 'utf8')

  it('detects the redirect shape since the real page has no <form>', () => {
    const challenge = parseChallenge(html, 'https://www.zimuku.org')
    expect(challenge.kind).toBe('redirect')
  })

  it('extracts the GET-redirect submit URL prefix from the YunsuoAutoJump self.location + stringToHex(...) line', () => {
    const challenge = asRedirect(parseChallenge(html, 'https://www.zimuku.org'))
    expect(challenge.submitUrlPrefix).toBe('https://www.zimuku.org/?security_verify_img=')
  })

  it('hex-encodes the requested href as the srcurl cookie value (the full challenged URL — window.location.href)', () => {
    // 实测铁证:提交验证码时 srcurl 必须是 hex(被挑战的完整 URL),不是 hex(baseUrl)。
    const challenge = asRedirect(parseChallenge(html, 'https://zimuku.org', 'https://zimuku.org/search?q=Pulp'))
    expect(challenge.srcurlCookieValue).toBe(Buffer.from('https://zimuku.org/search?q=Pulp', 'latin1').toString('hex'))
  })

  it('falls back to hex(baseUrl) for srcurl when no requestHref is passed (backward compatible with 2-arg callers)', () => {
    const challenge = asRedirect(parseChallenge(html, 'https://www.zimuku.org'))
    // stringToHex("https://www.zimuku.org") — each char -> 2-digit hex of its charCode
    expect(challenge.srcurlCookieValue).toBe('68747470733a2f2f7777772e7a696d756b752e6f7267')
  })

  it('extracts the captcha image as a data: URI verbatim, without resolving it against baseUrl', () => {
    const challenge = asRedirect(parseChallenge(html, 'https://www.zimuku.org'))
    expect(challenge.imageUrl).toBe('data:image/bmp;base64,WVVOU1VPLUNBUFRDSEEtQllURVM=')
  })

  it('throws a redirect-specific error when id="intext" is present but the verifyimg img is missing', () => {
    const html2 = `<html><body>
      <script>self.location = "/?security_verify_img=" + stringToHex(text);</script>
      <input id="intext" type="text">
    </body></html>`
    expect(() => parseChallenge(html2, 'https://www.zimuku.org')).toThrow(/class="verifyimg"/)
  })

  it('throws a redirect-specific error when intext + verifyimg are present but there is no self.location + stringToHex redirect line', () => {
    const html2 = `<html><body>
      <input id="intext" type="text">
      <img class="verifyimg" src="data:image/bmp;base64,AAAA">
    </body></html>`
    expect(() => parseChallenge(html2, 'https://www.zimuku.org')).toThrow(/self\.location/)
  })
})

describe('solveYunsuoChallenge (form shape — synthetic fixture, kept for backward compat)', () => {
  const html = readFileSync('fixtures/zimuku/challenge.html', 'utf8')

  it('fetches the captcha image, calls solve, submits digits, and returns the security_session_verify cookie on first try', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('security_verify_img')) {
        return new Response(Buffer.from('fake-png-bytes'))
      }
      expect(init?.method).toBe('POST')
      const body = new URLSearchParams(init!.body as URLSearchParams)
      expect(body.get('wzws_sessionid')).toBe('8f2c9a1b3e4d5f60')
      expect(body.get('sec_code')).toBe('74504')
      return new Response('ok', { headers: { 'set-cookie': 'security_session_verify=abc123; Path=/; HttpOnly' } })
    })
    const solve = vi.fn(async () => ({ digits: '74504' }))
    const r = await solveYunsuoChallenge(
      { fetchImpl: fetchImpl as unknown as typeof fetch, solve }, 'https://www.zimuku.org', html,
    )
    expect(r.cookie).toBe('security_session_verify=abc123')
    expect(solve).toHaveBeenCalledTimes(1)
  })

  it('retries with a fresh captcha on a wrong-digits rejection, up to maxAttempts, then throws ZimukuChallengeError', async () => {
    let submitCount = 0
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes('security_verify_img')) return new Response(Buffer.from('png'))
      submitCount++
      return new Response('rejected') // no set-cookie header → treated as wrong digits
    })
    const solve = vi.fn(async () => ({ digits: '00000' }))
    await expect(
      solveYunsuoChallenge({ fetchImpl: fetchImpl as unknown as typeof fetch, solve }, 'https://www.zimuku.org', html, 3, 1),
    ).rejects.toThrow(ZimukuChallengeError)
    expect(submitCount).toBe(3) // 有界:恰好 maxAttempts 次提交,不多不少
  })

  it('succeeds on the Nth attempt after N-1 rejections (a fresh captcha image is fetched on every retry)', async () => {
    let imgFetches = 0
    let submitCount = 0
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes('security_verify_img')) { imgFetches++; return new Response(Buffer.from('png')) }
      submitCount++
      if (submitCount < 3) return new Response('rejected')
      return new Response('ok', { headers: { 'set-cookie': 'security_session_verify=xyz; Path=/' } })
    })
    const solve = vi.fn(async () => ({ digits: '11111' }))
    const r = await solveYunsuoChallenge(
      { fetchImpl: fetchImpl as unknown as typeof fetch, solve }, 'https://www.zimuku.org', html, 5, 1,
    )
    expect(r.cookie).toBe('security_session_verify=xyz')
    expect(imgFetches).toBe(3)
    expect(submitCount).toBe(3)
  })

  it('when solve() throws (e.g. a schema-validation error from a schema-failing LLM read), counts it as a failed attempt and re-rolls a fresh captcha — does not propagate the raw error', async () => {
    let imgFetches = 0
    let submitCount = 0
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes('security_verify_img')) { imgFetches++; return new Response(Buffer.from('png')) }
      submitCount++
      return new Response('ok', { headers: { 'set-cookie': 'security_session_verify=xyz; Path=/' } })
    })
    let solveCalls = 0
    const solve = vi.fn(async () => {
      solveCalls++
      if (solveCalls <= 2) throw new MockSolveSchemaError('mock LLM schema validation failed')
      return { digits: '11111' }
    })
    const r = await solveYunsuoChallenge(
      { fetchImpl: fetchImpl as unknown as typeof fetch, solve }, 'https://www.zimuku.org', html, 5, 1,
    )
    expect(r.cookie).toBe('security_session_verify=xyz')
    expect(imgFetches).toBe(3) // 每次尝试(含 solve 抛错的两次)都重刷验证码
    expect(submitCount).toBe(1) // 只有第三次 solve 成功之后才真的提交表单
  })

  it('when solve() throws on every attempt, exhausts maxAttempts and throws ZimukuChallengeError — not the raw solve() error', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes('security_verify_img')) return new Response(Buffer.from('png'))
      return new Response('ok', { headers: { 'set-cookie': 'security_session_verify=xyz; Path=/' } })
    })
    const solve = vi.fn(async () => { throw new MockSolveSchemaError('schema mismatch') })
    const rejection = solveYunsuoChallenge(
      { fetchImpl: fetchImpl as unknown as typeof fetch, solve }, 'https://www.zimuku.org', html, 3, 1,
    )
    await expect(rejection).rejects.toThrow(ZimukuChallengeError)
    await expect(rejection).rejects.not.toThrow(MockSolveSchemaError)
    expect(solve).toHaveBeenCalledTimes(3) // 有界:恰好 maxAttempts 次,不因为 solve 抛错就绕过上限
  })

  it('applies jitter to the inter-attempt retry delay when retryJitterRangeMs is nonzero (RNG injectable)', async () => {
    vi.useFakeTimers()
    try {
      let submitCount = 0
      const fetchImpl = vi.fn(async (url: string) => {
        if (String(url).includes('security_verify_img')) return new Response(Buffer.from('png'))
        submitCount++
        if (submitCount === 1) return new Response('rejected') // 第一次提交被拒 → 触发一次重试延迟
        return new Response('ok', { headers: { 'set-cookie': 'security_session_verify=xyz; Path=/' } })
      })
      const solve = vi.fn(async () => ({ digits: '11111' }))
      const rng = () => 0.5 // 目标延迟 = 1000 + 0.5*2000 = 2000ms
      const p = solveYunsuoChallenge(
        { fetchImpl: fetchImpl as unknown as typeof fetch, solve }, 'https://www.zimuku.org', html,
        5, 1000, 2000, rng,
      )
      let done = false
      p.then(() => { done = true })
      await vi.advanceTimersByTimeAsync(1999)
      expect(done).toBe(false) // 旧实现的恒定 retryDelayMs 早就会在这附近放行——抖动版本不该提前
      await vi.advanceTimersByTimeAsync(2)
      await p
      expect(done).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('defaults retryJitterRangeMs to 0 (constant retryDelayMs, backward compatible with existing callers)', async () => {
    let submitCount = 0
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes('security_verify_img')) return new Response(Buffer.from('png'))
      submitCount++
      return new Response('rejected')
    })
    const solve = vi.fn(async () => ({ digits: '00000' }))
    const t0 = Date.now()
    await expect(
      solveYunsuoChallenge({ fetchImpl: fetchImpl as unknown as typeof fetch, solve }, 'https://www.zimuku.org', html, 2, 5),
    ).rejects.toThrow(ZimukuChallengeError)
    // maxAttempts=2, retryDelayMs=5, jitterRangeMs 默认 0 → 恰好一次 5ms 定长延迟,不应明显超出
    expect(Date.now() - t0).toBeLessThan(200)
    expect(submitCount).toBe(2)
  })
})

describe('solveYunsuoChallenge (redirect shape — real zimuku.org JS-redirect challenge page)', () => {
  const html = readFileSync('fixtures/zimuku/real-challenge.html', 'utf8')

  it('decodes the data: URI captcha image locally (no network fetch), GETs the hex-encoded submit URL with the srcurl cookie, and returns the security_session_verify cookie', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(String(url)).toBe('https://www.zimuku.org/?security_verify_img=3734353034')
      expect(init?.method ?? 'GET').toBe('GET') // GET redirect, not a form POST
      expect((init?.headers as Record<string, string> | undefined)?.Cookie)
        .toBe('srcurl=68747470733a2f2f7777772e7a696d756b752e6f7267')
      return new Response('ok', { headers: { 'set-cookie': 'security_session_verify=abc123; Path=/; HttpOnly' } })
    })
    const solve = vi.fn(async (imageBytes: Buffer) => {
      expect(imageBytes.toString('utf8')).toBe('YUNSUO-CAPTCHA-BYTES') // decoded straight from the data: URI
      return { digits: '74504' }
    })
    const r = await solveYunsuoChallenge(
      { fetchImpl: fetchImpl as unknown as typeof fetch, solve }, 'https://www.zimuku.org', html,
    )
    expect(r.cookie).toBe('security_session_verify=abc123')
    expect(fetchImpl).toHaveBeenCalledTimes(1) // 图片本地解码,唯一一次网络调用是提交 GET
    expect(solve).toHaveBeenCalledTimes(1)
  })

  it('retries (re-decoding the same embedded captcha) on a wrong-digits rejection, up to maxAttempts, then throws ZimukuChallengeError', async () => {
    let submitCount = 0
    const fetchImpl = vi.fn(async () => {
      submitCount++
      return new Response('rejected') // no set-cookie header → treated as wrong digits
    })
    const solve = vi.fn(async () => ({ digits: '00000' }))
    await expect(
      solveYunsuoChallenge({ fetchImpl: fetchImpl as unknown as typeof fetch, solve }, 'https://www.zimuku.org', html, 3, 1),
    ).rejects.toThrow(ZimukuChallengeError)
    expect(submitCount).toBe(3) // 有界:恰好 maxAttempts 次提交
  })

  it('succeeds on the Nth attempt after N-1 rejections', async () => {
    let submitCount = 0
    const fetchImpl = vi.fn(async () => {
      submitCount++
      if (submitCount < 3) return new Response('rejected')
      return new Response('ok', { headers: { 'set-cookie': 'security_session_verify=xyz; Path=/' } })
    })
    const solve = vi.fn(async () => ({ digits: '11111' }))
    const r = await solveYunsuoChallenge(
      { fetchImpl: fetchImpl as unknown as typeof fetch, solve }, 'https://www.zimuku.org', html, 5, 1,
    )
    expect(r.cookie).toBe('security_session_verify=xyz')
    expect(submitCount).toBe(3)
  })
})
