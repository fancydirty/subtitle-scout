// Out-of-band capture — NOT part of `npm test`. Hits real subhd.me ONCE per invocation to mint the
// fixtures that Task 3/5 parsers are written against. The parsers are the source-of-truth CONSUMERS
// of what this captures; do not hand-edit the captured bytes.
//
// Real download flow (curl-verified 2026-07-20 — the CURRENT site needs FOUR requests, not the two
// the design doc assumed):
//   1. GET  /search/<q>                       → search HTML (cards with /a/<id> links)
//   2. POST /api/sub/prepare-download {sid}    → {success,url:"/down/<id>"} + Set-Cookie: tk_…
//   3. GET  /down/<id>            (with tk)    → landing HTML (ACTIVATES the temp page)
//   4. POST /api/sub/down {sid}   (with tk)    → {success,pass,url:"https://dlus.subhd.me/….ass"}
//   5. GET  <cdn url>            (no cookie)   → the actual single subtitle file OR an archive
//
// 🔴 Node (undici fetch / node:https) CANNOT complete steps 2-4: Cloudflare/origin rejects Node's
// TLS (JA3) fingerprint on the temp-page validation (curl-verified: node ⇒ "时间过长本临时页面已经失效"
// on api/sub/down every time; curl ⇒ "验证通过"). So the mint flow shells out to CURL. The CDN file
// (step 5, dlus.subhd.me) IS undici-fetchable, so the download layer stays on fetch.
//
// The mint window is short AND subhd is flaky (sporadic HTTP 000 / TLS "unexpected eof"); the whole
// prepare→down→api unit is retried per id. Usage: npx tsx scripts/capture-subhd-fixtures.ts
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '../src/adapters/providers/__fixtures__/subhd')
const BASE = 'https://subhd.me'
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'
const SEARCH_QUERY = 'The Rig'
const SEARCH_SLUG = 'the-rig'

/** curl one request; returns { status, headers(raw lines), body }. Retries transient 000/TLS. */
function curl(args: string[], attempts = 5): { status: number; headerText: string; body: string } {
  for (let i = 0; i < attempts; i++) {
    try {
      const out = execFileSync('curl', ['-sS', '--max-time', '25', '-A', UA, '-D', '-', ...args], {
        encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      })
      const sep = out.indexOf('\r\n\r\n') >= 0 ? out.indexOf('\r\n\r\n') + 4 : out.indexOf('\n\n') + 2
      const headerText = out.slice(0, sep)
      const status = Number(/HTTP\/[\d.]+ (\d+)/.exec(headerText)?.[1] ?? 0)
      return { status, headerText, body: out.slice(sep) }
    } catch (e) {
      console.warn(`  curl transient (attempt ${i + 1}): ${String(e).slice(0, 70)}`)
    }
  }
  throw new Error(`curl gave up: ${args.join(' ')}`)
}

function extractTk(headerText: string): string | null {
  const m = /set-cookie:\s*(tk_[^=]+=[^;]+)/i.exec(headerText)
  return m ? m[1] : null
}

async function main() {
  mkdirSync(OUT, { recursive: true })

  // 1. search (undici fetch is fine for search)
  console.log(`GET /search/${SEARCH_QUERY}`)
  const searchRes = await fetch(`${BASE}/search/${encodeURIComponent(SEARCH_QUERY)}`, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
    signal: AbortSignal.timeout(30_000),
  })
  const searchHtml = await searchRes.text()
  writeFileSync(join(OUT, `search-${SEARCH_SLUG}.html`), searchHtml)
  console.log(`  saved search-${SEARCH_SLUG}.html (${searchHtml.length} bytes, HTTP ${searchRes.status})`)

  const ids: string[] = []
  for (const m of searchHtml.matchAll(/\/a\/([A-Za-z0-9]+)/g)) if (!ids.includes(m[1])) ids.push(m[1])
  console.log(`  ${ids.length} unique /a/ ids`)

  for (const id of ids) {
    console.log(`\n--- trying id ${id} ---`)
    // detail page (captured for STRUCTURE completeness; not parsed by the client)
    const detail = curl([`${BASE}/a/${id}`])
    // 2. prepare-download (CURL)
    const prep = curl(['-H', `Referer: ${BASE}/a/${id}`, '-H', 'X-Requested-With: XMLHttpRequest',
      '-H', `Origin: ${BASE}`, '-H', 'Content-Type: application/json', '-X', 'POST',
      `${BASE}/api/sub/prepare-download`, '--data', JSON.stringify({ sid: id })])
    const tk = extractTk(prep.headerText)
    console.log(`  prepare HTTP ${prep.status} tk=${tk ? 'yes' : 'NO'} ${prep.body.slice(0, 60)}`)
    if (prep.status !== 200 || !tk) continue
    // 3. GET /down (CURL, activates temp page)
    const down = curl(['-b', tk, '-H', `Referer: ${BASE}/a/${id}`, `${BASE}/down/${id}`])
    // 4. api/sub/down (CURL)
    const api = curl(['-b', tk, '-H', `Referer: ${BASE}/down/${id}`, '-H', 'X-Requested-With: XMLHttpRequest',
      '-H', `Origin: ${BASE}`, '-H', 'Content-Type: application/json', '-X', 'POST',
      `${BASE}/api/sub/down`, '--data', JSON.stringify({ sid: id })])
    console.log(`  api/sub/down HTTP ${api.status} ${api.body.slice(0, 100)}`)
    let parsed: { success?: boolean; url?: string | null }
    try { parsed = JSON.parse(api.body) } catch { continue }
    if (!parsed.success || !parsed.url) continue
    // 5. GET CDN file (undici fetch — CDN is not fingerprint-gated)
    const fileUrl = parsed.url.startsWith('http') ? parsed.url : `${BASE}${parsed.url}`
    let fileBuf: Buffer | null = null
    for (let i = 0; i < 6 && !fileBuf; i++) {
      try {
        const fr = await fetch(fileUrl, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30_000) })
        if (fr.status === 200) { const b = Buffer.from(await fr.arrayBuffer()); if (b.length) fileBuf = b }
      } catch (e) { console.warn(`  CDN transient (${i + 1}): ${String(e).slice(0, 50)}`) }
    }
    if (!fileBuf) continue
    const ext = (fileUrl.split('.').pop() || 'bin').toLowerCase()

    writeFileSync(join(OUT, `detail-${id}.html`), detail.body)
    writeFileSync(join(OUT, `prepare-download-${id}.json`), prep.body)
    writeFileSync(join(OUT, `prepare-download-${id}.headers.txt`), prep.headerText)
    writeFileSync(join(OUT, `down-page-${id}.html`), down.body)
    writeFileSync(join(OUT, `api-sub-down-${id}.json`), api.body)
    writeFileSync(join(OUT, `down-${id}.${ext}`), fileBuf)
    console.log(`\n✅ captured id ${id}: file ${fileBuf.length} bytes .${ext}`)
    console.log(`   fixtures written to ${OUT}`)
    return
  }
  throw new Error('no id completed the full download flow — subhd may be greylisting or down')
}

main().catch(e => { console.error(e); process.exit(1) })
