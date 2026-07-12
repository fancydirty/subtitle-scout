import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { detectChallenge, parseChallenge } from './yunsuo.js'

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
