import { readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

/** One recorded HTTP exchange on disk: `<hash(signature)>.json`. Body is base64 so binary
 *  subtitle downloads (zip/gzip) round-trip losslessly alongside JSON API responses. */
export interface RecordedResponse {
  signature: string
  status: number
  headers: Record<string, string>
  bodyBase64: string
}

const VOLATILE_PARAMS = new Set(['token', 'api_key', 'apikey'])

/** Canonical request identity used as the replay key. Deliberately strips volatile auth params
 *  (assrt puts `token` in the query; different runs/tokens must map to the same fixture) and
 *  sorts the remaining query so param order never matters. POST bodies are folded in so two
 *  different download payloads to the same path stay distinct. */
export function requestSignature(method: string, url: string, body: string | undefined): string {
  const u = new URL(url)
  const params = [...u.searchParams.entries()]
    .filter(([k]) => !VOLATILE_PARAMS.has(k.toLowerCase()))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const query = params.map(([k, v]) => `${k}=${v}`).join('&')
  const bodyTag = body ? `#${createHash('sha1').update(body).digest('hex').slice(0, 12)}` : ''
  return `${method.toUpperCase()} ${u.origin}${u.pathname}${query ? `?${query}` : ''}${bodyTag}`
}
/** Filename stem for a signature. Attached to the function so tests/recorder share it. */
requestSignature.hash = (sig: string): string => createHash('sha1').update(sig).digest('hex')
/** Method+path only (no query, no body) — the fallback bucket key. */
requestSignature.pathOnly = (method: string, url: string): string => {
  const u = new URL(url)
  return `${method.toUpperCase()} ${u.origin}${u.pathname}`
}

function bodyOf(init: RequestInit | undefined): string | undefined {
  if (!init?.body) return undefined
  return typeof init.body === 'string' ? init.body : undefined
}

/** A `typeof fetch` that answers from a `responses/` dir. Resolution order:
 *  1. exact signature match;
 *  2. else, if exactly ONE recorded response shares the method+path, serve it (robust to the
 *     real model phrasing a search query differently than it was recorded);
 *  3. else throw — an ambiguous path (≥2 recorded, none exact) must be recorded precisely. */
export function makeReplayFetch(dir: string): typeof fetch {
  const all: RecordedResponse[] = readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(readFileSync(join(dir, f), 'utf8')) as RecordedResponse)
  const bySig = new Map(all.map(r => [r.signature, r]))
  const byPath = new Map<string, RecordedResponse[]>()
  for (const r of all) {
    // signature is "METHOD origin/path[?query][#bodytag]" — path bucket = up to the '?' or '#'
    const path = r.signature.replace(/[?#].*$/, '')
    const list = byPath.get(path) ?? []
    list.push(r)
    byPath.set(path, list)
  }
  const toResponse = (r: RecordedResponse) =>
    new Response(Buffer.from(r.bodyBase64, 'base64'), { status: r.status, headers: r.headers })

  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
    const method = init?.method ?? (typeof input === 'object' && 'method' in input ? (input as Request).method : 'GET')
    const sig = requestSignature(method, url, bodyOf(init))
    const exact = bySig.get(sig)
    if (exact) return toResponse(exact)
    const bucket = byPath.get(requestSignature.pathOnly(method, url))
    if (bucket && bucket.length === 1) return toResponse(bucket[0])
    throw new Error(
      `replayFetch: no recorded response for ${sig}` +
      (bucket ? ` (${bucket.length} recorded for this path — record the exact query)` : ' (path never recorded)'),
    )
  }) as typeof fetch
}

/** Wraps a real `fetch`: every call is teed to `dir` as a RecordedResponse keyed by its
 *  signature, then a fresh (unconsumed) Response is returned to the caller. Rate limiting is
 *  the *client's* job (assrt's MinIntervalLimiter) — this shim is pure I/O capture. */
export function makeRecordingFetch(dir: string, realFetch: typeof fetch = fetch): typeof fetch {
  mkdirSync(dir, { recursive: true })
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
    const method = init?.method ?? (typeof input === 'object' && 'method' in input ? (input as Request).method : 'GET')
    const body = init?.body && typeof init.body === 'string' ? init.body : undefined
    const res = await realFetch(input, init)
    const buf = Buffer.from(await res.clone().arrayBuffer())
    const headers: Record<string, string> = {}
    res.headers.forEach((v, k) => { headers[k] = v })
    const sig = requestSignature(method, url, body)
    const record: RecordedResponse = { signature: sig, status: res.status, headers, bodyBase64: buf.toString('base64') }
    writeFileSync(join(dir, `${requestSignature.hash(sig)}.json`), JSON.stringify(record, null, 2))
    return res
  }) as typeof fetch
}
