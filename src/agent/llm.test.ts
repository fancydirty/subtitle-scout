import { describe, it, expect } from 'vitest'

describe('isConnectError', () => {
  it('true for connection-establishment failures (safe to retry — request never left)', async () => {
    const { isConnectError } = await import('./llm.js')
    // the exact shape the soft-router mimo failure took (undici connect timeout via AI SDK)
    expect(isConnectError({ cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } })).toBe(true)
    expect(isConnectError(new Error('Cannot connect to API: Connect Timeout Error'))).toBe(true)
    expect(isConnectError({ code: 'ECONNREFUSED' })).toBe(true)
    expect(isConnectError({ cause: { code: 'ETIMEDOUT' } })).toBe(true)
    expect(isConnectError(new Error('fetch failed'))).toBe(true)
    expect(isConnectError({ cause: { message: 'other side closed' } })).toBe(true)
  })
  it('false for application/response errors (must NOT retry)', async () => {
    const { isConnectError } = await import('./llm.js')
    expect(isConnectError(new Error('schema validation failed'))).toBe(false)
    expect(isConnectError({ status: 400, message: 'bad request' })).toBe(false)
    expect(isConnectError('some model output about a connection timeout in a movie')).toBe(false)
  })
})

describe('withConnectRetry', () => {
  const noSleep = async () => {}

  it('retries a connect error with fresh calls, then returns the eventual Response', async () => {
    let calls = 0
    const flaky = (async () => {
      calls++
      if (calls <= 2) { const e: any = new Error('connect'); e.cause = { code: 'UND_ERR_CONNECT_TIMEOUT' }; throw e }
      return new Response('ok', { status: 200 })
    }) as unknown as typeof fetch
    const { withConnectRetry } = await import('./llm.js')
    const wrapped = withConnectRetry(flaky, { retries: 3, sleep: noSleep })
    const res = await wrapped('https://x/v1' as never)
    expect(res.status).toBe(200)
    expect(calls).toBe(3) // 2 connect failures + 1 success, each a brand-new call (→ new connection/IP)
  })

  it('does NOT retry a non-connect error (rethrows immediately)', async () => {
    let calls = 0
    const boom = (async () => { calls++; throw new Error('400 bad request') }) as unknown as typeof fetch
    const { withConnectRetry } = await import('./llm.js')
    const wrapped = withConnectRetry(boom, { retries: 3, sleep: noSleep })
    await expect(wrapped('https://x/v1' as never)).rejects.toThrow(/bad request/)
    expect(calls).toBe(1)
  })

  it('gives up after retries+1 attempts and rethrows the last connect error', async () => {
    let calls = 0
    const dead = (async () => { calls++; const e: any = new Error('connect'); e.cause = { code: 'ECONNREFUSED' }; throw e }) as unknown as typeof fetch
    const { withConnectRetry } = await import('./llm.js')
    const wrapped = withConnectRetry(dead, { retries: 2, sleep: noSleep })
    await expect(wrapped('https://x/v1' as never)).rejects.toThrow()
    expect(calls).toBe(3) // 1 + 2 retries
  })

  it('returns immediately on first success (no retry, no sleep)', async () => {
    let calls = 0, slept = 0
    const ok = (async () => { calls++; return new Response('ok', { status: 200 }) }) as unknown as typeof fetch
    const { withConnectRetry } = await import('./llm.js')
    const wrapped = withConnectRetry(ok, { retries: 3, sleep: async () => { slept++ } })
    const res = await wrapped('https://x/v1' as never)
    expect(res.status).toBe(200)
    expect(calls).toBe(1)
    expect(slept).toBe(0)
  })
})

describe('injectExtraBody', () => {
  it('merges extra fields into a JSON string body', async () => {
    const { injectExtraBody } = await import('./llm.js')
    const init = { method: 'POST', body: JSON.stringify({ model: 'm', messages: [] }) }
    const out = injectExtraBody(init, { thinking: { type: 'disabled' } })
    expect(JSON.parse(out!.body as string)).toEqual({
      model: 'm', messages: [], thinking: { type: 'disabled' },
    })
  })
  it('passes through non-JSON bodies and undefined init', async () => {
    const { injectExtraBody } = await import('./llm.js')
    expect(injectExtraBody(undefined, { a: 1 })).toBeUndefined()
    const blobInit = { body: new Uint8Array([1]) as unknown as BodyInit }
    expect(injectExtraBody(blobInit, { a: 1 })).toBe(blobInit)
  })
})
