import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { detectChallenge, parseChallenge, solveYunsuoChallenge, ZimukuChallengeError } from './yunsuo.js'

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
})
