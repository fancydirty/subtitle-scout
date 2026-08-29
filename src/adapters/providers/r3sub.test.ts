import { describe, it, expect, vi } from 'vitest'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSigninForm, parseSearch, parseShow, parseInterstitial, R3subClient } from './r3sub.js'
import { R3subSessionStore } from './r3subSession.js'

const fx = (name: string) => readFileSync(join(__dirname, '__fixtures__', name), 'utf8')
const signinHtml = fx('r3sub-signin.html')
const searchHtml = fx('r3sub-search.html')
const showHtml = fx('r3sub-show.html')
const interstitialHtml = fx('r3sub-download-interstitial.html')

/** ZIP 魔数头 `PK\x03\x04` 起手的最小合法字节串，够测「拿到的是 zip」。 */
const FAKE_ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00])

function tmpStore() {
  return new R3subSessionStore(mkdtempSync(join(tmpdir(), 'r3sub-client-')))
}

/** 造一个带 set-cookie 的 Response（Headers.getSetCookie 在 undici 里可用；退化到 raw header）。 */
function resWithCookies(status: number, body: string, setCookies: string[] = []): Response {
  const headers = new Headers()
  for (const c of setCookies) headers.append('set-cookie', c)
  return new Response(body, { status, headers })
}

describe('parseSearch（结果行 → 结构）', () => {
  const rows = parseSearch(searchHtml)
  it('抠出多条结果，字段完整', () => {
    expect(rows.length).toBeGreaterThan(0)
    const bl = rows.find((r) => r.titleEn.includes('Borderlands'))
    expect(bl).toBeTruthy()
    expect(bl!.id).toBe('UdJtwd22202')
    expect(bl!.titleCn).toBe('邊緣禁地')
    expect(bl!.year).toBe(2024)
    expect(bl!.source).toContain('iTunes官方')
    expect(bl!.langMark).toContain('繁')
    expect(bl!.downloads).toBe(146)
  })
  it('Dune: Part Two 那条也在（后续详情/下载用它）', () => {
    const dune = rows.find((r) => r.titleEn.includes('Dune: Part Two'))
    expect(dune).toBeTruthy()
  })
})

describe('parseShow（詳情頁 → zip 名 + 檔案清單）', () => {
  const show = parseShow(showHtml)
  it('zipName 从 download.php 表单 filename 抠出', () => {
    expect(show.zipName).toBe('Dune.Part.Two.2024.zip')
  })
  it('files 从 data-fname 抠出全部字幕（iTunes 官方四语 + 字幕修正补传两条 = 6）', () => {
    expect(show.files).toContain('Dune.Part.Two.2024.iTunes.cmn-Hant.[gb].srt')
    expect(show.files).toContain('Dune.Part.Two.2024.iTunes.ja-JP.[gb].srt')
    expect(show.files).toContain('Dune.Part.Two.2024.iTunes.yue-Hant.[gb].srt')
    expect(show.files.length).toBe(6)
  })
})

describe('parseInterstitial（下载中转页 → jpdown1 表单字段）', () => {
  it('抠出 commentForm 的 id 与 lang（注意 lang=tw，与首跳 zh 不同名）', () => {
    const f = parseInterstitial(interstitialHtml)
    expect(f.id).toBe('S8g2H021493')
    expect(f.lang).toBe('tw')
  })
})

describe('R3subClient.download（两跳）', () => {
  function loggedInStore() {
    const store = new R3subSessionStore(mkdtempSync(join(tmpdir(), 'r3sub-dl-')))
    store.put({ cookie: 'PHPSESSID=x; R3_Vid=1087', capturedAt: Date.now() })
    return store
  }
  it('download.php 中转页 → jpdown1.php 取 zip，返回 bytes', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(interstitialHtml, { status: 200 }))       // 跳1 download.php
      .mockResolvedValueOnce(new Response(FAKE_ZIP, {                                // 跳2 jpdown1.php
        status: 200,
        headers: { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename=Dune.Part.Two.2024.zip' },
      }))
    const client = new R3subClient({ email: 'a@b.com', password: 'pw', sessionStore: loggedInStore(), fetchImpl })
    const out = await client.download('S8g2H021493', 'Dune.Part.Two.2024.zip')
    expect(out.filename).toBe('Dune.Part.Two.2024.zip')
    expect(new Uint8Array(out.bytes.subarray(0, 4))).toEqual(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))
    // 跳2 打到 jpdown1.php，带上中转页抠出的 id+lang
    expect(String(fetchImpl.mock.calls[1][0])).toContain('jpdown1.php')
    const body2 = String(fetchImpl.mock.calls[1][1].body)
    expect(body2).toContain('id=S8g2H021493')
    expect(body2).toContain('lang=tw')
  })

  it('首跳 lang=zh 失败（非 zip）→ 落 lang=cn 镜像重试一次', async () => {
    // zh 通道：download.php 中转页 → jpdown1 返回 HTML（非 zip，失败）；cn 通道再走一遍成功。
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(interstitialHtml, { status: 200 }))                 // zh 跳1
      .mockResolvedValueOnce(new Response('<html>error</html>', { status: 200, headers: { 'content-type': 'text/html' } })) // zh 跳2 失败
      .mockResolvedValueOnce(new Response(interstitialHtml, { status: 200 }))                 // cn 跳1
      .mockResolvedValueOnce(new Response(FAKE_ZIP, { status: 200, headers: { 'content-type': 'application/octet-stream' } })) // cn 跳2 成功
    const client = new R3subClient({ email: 'a@b.com', password: 'pw', sessionStore: loggedInStore(), fetchImpl })
    const out = await client.download('S8g2H021493', 'Dune.Part.Two.2024.zip')
    expect(new Uint8Array(out.bytes.subarray(0, 4))).toEqual(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))
    // 第一跳 zh、第三跳 cn（download.php 的 lang 参数）
    expect(String(fetchImpl.mock.calls[0][1].body)).toContain('lang=zh')
    expect(String(fetchImpl.mock.calls[2][1].body)).toContain('lang=cn')
  })

  it('🔴 门票 cookie：跳1 的 Set-Cookie（aa=1）必须并进跳2 的 Cookie（2026-08-30 实勘——jpdown1 校验它，缺席则 200 空体）', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(interstitialHtml, {
        status: 200,
        headers: { 'set-cookie': 'aa=1; expires=Sun, 30 Aug 2026 13:51:18 GMT; Max-Age=72000' },
      }))
      .mockImplementationOnce(async (_url: string, init: RequestInit) => {
        // 复刻站方行为：带 aa=1 给 zip，不带给 200 空体
        const cookie = String((init.headers as Record<string, string>).Cookie ?? '')
        if (!/(^|; )aa=1(;|$)/.test(cookie)) return new Response('', { status: 200, headers: { 'content-type': 'text/html' } })
        return new Response(FAKE_ZIP, { status: 200, headers: { 'content-type': 'application/octet-stream' } })
      })
    const client = new R3subClient({ email: 'a@b.com', password: 'pw', sessionStore: loggedInStore(), fetchImpl })
    const out = await client.download('S8g2H021493', 'Dune.Part.Two.2024.zip')
    expect(new Uint8Array(out.bytes.subarray(0, 4))).toEqual(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))
    // 跳2 的 Cookie 里既有登录会话也有门票
    const cookie2 = String(fetchImpl.mock.calls[1][1].headers.Cookie)
    expect(cookie2).toContain('R3_Vid=1087')
    expect(cookie2).toContain('aa=1')
  })
})

describe('parseSigninForm（Vanilla 登录页隐藏域）', () => {
  it('抠出 TransientKey 与四个隐藏域（hpt 蜜罐留空）', () => {
    const f = parseSigninForm(signinHtml)
    expect(f.TransientKey).toBeTruthy()
    expect(f).toHaveProperty('hpt')
    expect(f.hpt).toBe('')
    expect(f.Target).toBe('/')
    expect(f).toHaveProperty('ClientHour')
  })
})

describe('R3subClient.login', () => {
  it('成功：GET signin 页 → POST 凭据 → 收 set-cookie 存 session', async () => {
    const setCookies = [
      'PHPSESSID=sess123; path=/',
      'R3_Vname=tester; path=/',
      'R3_Vid=42; path=/',
      'Vanilla-Vv=1; path=/',
    ]
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(resWithCookies(200, signinHtml))                 // GET signin
      .mockResolvedValueOnce(resWithCookies(302, '', setCookies))             // POST signin
    const store = tmpStore()
    const client = new R3subClient({ email: 'a@b.com', password: 'pw', sessionStore: store, fetchImpl })
    await client.login()
    const sess = store.get()
    expect(sess).not.toBeNull()
    expect(sess!.cookie).toContain('PHPSESSID=sess123')
    expect(sess!.cookie).toContain('R3_Vid=42')
    // POST 带上了 TransientKey 与凭据
    const postBody = String(fetchImpl.mock.calls[1][1].body)
    expect(postBody).toContain('Email=a%40b.com')
    expect(postBody).toContain('Password=pw')
    expect(postBody).toMatch(/TransientKey=/)
  })

  it('失败（密码错，POST 回不含登录 cookie 的 signin 页）→ 抛「登录失败」', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(resWithCookies(200, signinHtml))
      .mockResolvedValueOnce(resWithCookies(200, signinHtml))   // 又是登录页，无 R3_Vid
    const store = tmpStore()
    const client = new R3subClient({ email: 'a@b.com', password: 'wrong', sessionStore: store, fetchImpl })
    await expect(client.login()).rejects.toThrow(/登录失败|邮箱|密码/)
    expect(store.get()).toBeNull()
  })
})
