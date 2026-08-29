import { describe, it, expect, vi } from 'vitest'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSigninForm, parseSearch, parseShow, R3subClient } from './r3sub.js'
import { R3subSessionStore } from './r3subSession.js'

const fx = (name: string) => readFileSync(join(__dirname, '__fixtures__', name), 'utf8')
const signinHtml = fx('r3sub-signin.html')
const searchHtml = fx('r3sub-search.html')
const showHtml = fx('r3sub-show.html')

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
