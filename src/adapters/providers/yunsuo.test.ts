import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { detectChallenge, parseChallenge, solveYunsuoChallenge, ZimukuChallengeError } from './yunsuo.js'
import { StructuredOutputError } from '../../agent/llm.js'

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

describe('parseChallenge', () => {
  const html = readFileSync('fixtures/zimuku/challenge.html', 'utf8')

  it('extracts the absolute form action', () => {
    const form = parseChallenge(html, 'https://www.zimuku.org')
    expect(form.action).toBe('https://www.zimuku.org/aq_wzws_confirm.html')
  })
  it('extracts hidden fields verbatim', () => {
    const form = parseChallenge(html, 'https://www.zimuku.org')
    expect(form.fields).toEqual({ wzws_sessionid: '8f2c9a1b3e4d5f60', return_url: '/detail/58421.html' })
  })
  it('extracts the captcha text input name', () => {
    const form = parseChallenge(html, 'https://www.zimuku.org')
    expect(form.captchaFieldName).toBe('sec_code')
  })
  it('extracts the absolute captcha image url', () => {
    const form = parseChallenge(html, 'https://www.zimuku.org')
    expect(form.imageUrl).toBe('https://www.zimuku.org/aq_wzws_security_verify_img?r=0.483920')
  })
  it('throws when the page has no form (unexpected challenge shape)', () => {
    expect(() => parseChallenge('<html><body>no form here</body></html>', 'https://www.zimuku.org'))
      .toThrow(/no <form/)
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
    const form = parseChallenge(html, 'https://www.zimuku.org')
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
    const form = parseChallenge(html, 'https://www.zimuku.org')
    expect(form.captchaFieldName).toBe('sec_code')
  })
})

describe('solveYunsuoChallenge', () => {
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

  it('when solve() throws (e.g. StructuredOutputError from a schema-failing LLM read), counts it as a failed attempt and re-rolls a fresh captcha — does not propagate the raw error', async () => {
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
      if (solveCalls <= 2) throw new StructuredOutputError('mock LLM schema validation failed')
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
    const solve = vi.fn(async () => { throw new StructuredOutputError('schema mismatch') })
    const rejection = solveYunsuoChallenge(
      { fetchImpl: fetchImpl as unknown as typeof fetch, solve }, 'https://www.zimuku.org', html, 3, 1,
    )
    await expect(rejection).rejects.toThrow(ZimukuChallengeError)
    await expect(rejection).rejects.not.toThrow(StructuredOutputError)
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
