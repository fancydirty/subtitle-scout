import { describe, it, expect } from 'vitest'
import { readFileSync, mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AdmZip from 'adm-zip'
import { makeZimukuAdapter } from './zimukuAdapter.js'
import { ZimukuClient } from '../../adapters/providers/zimuku.js'
import { ZimukuSessionStore } from '../../adapters/providers/zimukuSession.js'
import { MinIntervalLimiter } from '../../adapters/providers/assrt.js'
import { downloadDirect } from '../../adapters/download/direct.js'
import { writeSubtitle, type WriteSubtitleOutcome, type WriteSubtitleResult } from '../../files/subtitleWriter.js'
import { runSearch, runResolve } from '../fetchLib.js'

// C-D1 fix widened writeSubtitle's return type to a WriteSubtitleOutcome union (a >1-entry zip
// with no selectFileName now returns {needsSelection: true, entries} instead of writing). This
// fixture's zip has exactly one subtitle entry, so it always takes the written-result branch —
// narrow once so the assertions below can keep accessing path directly, with zero semantic change.
const asWritten = (o: WriteSubtitleOutcome): WriteSubtitleResult => {
  if ('needsSelection' in o) throw new Error('unexpected needsSelection')
  return o
}

describe('zimuku end-to-end offline (challenge → solve → search → detail → dld → mirror download → unzip → write)', () => {
  it('produces an installed subtitle file from a cold session over the real 4-hop chain (2026-07-19 golden fixtures)', async () => {
    // 全程真实 golden fixtures(2026-07-19 抓包):挑战页 + 成功中间页 + 搜索页(协议相对 href)+
    // 详情页(id=down1 → /dld)+ dld 高速下载页(/download/.../svr 镜像链)。候选 id 179286 全链一致。
    const challengeHtml = readFileSync('fixtures/zimuku/live-redirect-challenge-20260719.html', 'utf8')
    const interstitial = readFileSync('fixtures/zimuku/verify-success-interstitial-20260719.html', 'utf8')
    const searchHtml = readFileSync('fixtures/zimuku/live-search-pulp-20260719.html', 'utf8')
    const detailHtml = readFileSync('fixtures/zimuku/live-detail-179286-20260719.html', 'utf8')
    const dldHtml = readFileSync('fixtures/zimuku/live-dld-179286-20260719.html', 'utf8')

    const zip = new AdmZip()
    zip.addFile('pulp_fiction_zh.srt', Buffer.from(
      '1\n00:00:01,000 --> 00:00:03,500\n这是一部关于生死的电影\n\n2\n00:00:04,000 --> 00:00:06,200\n以及超市\n\n',
    ))
    const zipBuffer = zip.toBuffer()

    const fetchImpl = async (url: string, init?: RequestInit) => {
      const u = String(url)
      const cookie = (init?.headers as Record<string, string> | undefined)?.Cookie ?? ''
      // 验证码提交:回带 pending security_session_verify + srcurl → 答对下发 high_verify(923B 中间页)
      if (u.includes('security_verify_img=')) {
        return new Response(interstitial, { headers: { 'set-cookie': 'security_session_high_verify=HIGH; Path=/' } })
      }
      if (u.includes('/search?q=')) {
        if (cookie.includes('security_session_high_verify')) return new Response(searchHtml)
        return new Response(challengeHtml, { headers: { 'set-cookie': 'security_session_verify=PEND; Path=/' } })
      }
      if (u.includes('/detail/179286.html')) return new Response(detailHtml)
      // dld 高速下载页:下发 PHPSESSID(下载镜像须带它)
      if (u.includes('/dld/179286.html')) return new Response(dldHtml, { headers: { 'set-cookie': 'PHPSESSID=sess42; path=/' } })
      // 下载镜像:真实里 301→s.zimuku.org CDN,mock 里直接回 zip + CDN 权威 Content-Disposition
      // (含 .zip 扩展名,决定 writeSubtitle 走解压)。断言镜像请求带上了 dld 下发的 PHPSESSID。
      if (u.includes('/download/') && u.includes('/svr/')) {
        expect(cookie).toContain('PHPSESSID=sess42')
        return new Response(zipBuffer, { headers: { 'content-disposition': 'attachment; filename="[zmk.pw]pulp.fiction.zh.zip"' } })
      }
      throw new Error(`unexpected fetch in test: ${u}`)
    }

    const sessionStore = new ZimukuSessionStore(mkdtempSync(join(tmpdir(), 'zimuku-e2e-session-')))
    const client = new ZimukuClient({
      sessionStore, fetchImpl: fetchImpl as unknown as typeof fetch,
      solve: async () => ({ digits: '88640' }), // golden 铁证 captcha5=88640
      limiter: new MinIntervalLimiter(1),
    })
    const adapter = makeZimukuAdapter(client)

    // 1. search(模拟 fetchLib.runSearch 的调度层)——真实搜索页首条候选 id 179286
    const candidates = await runSearch({ queries: ['Pulp'] }, [adapter], () => {})
    expect(candidates.length).toBeGreaterThanOrEqual(8)
    expect(candidates[0]).toMatchObject({ provider: 'zimuku', providerId: '179286', fileList: [] })

    // 2. resolve(模拟 fetchLib.runResolve)——detail→dld,返回首个镜像 URL + PHPSESSID cookie 头
    const resolved = await runResolve({ provider: 'zimuku', providerId: candidates[0].providerId, fileIndex: null }, [adapter])
    expect(resolved.url).toContain('/download/')
    expect(resolved.url).toContain('/svr/')
    expect(resolved.headers).toMatchObject({ 'Accept-Language': 'zh-CN,zh;q=0.9', Cookie: 'PHPSESSID=sess42' })
    expect(resolved.filename).toBeUndefined() // zimuku 不再在 resolve 给文件名——靠下载 CD 头

    // 3. download——headers(含 PHPSESSID)带到镜像 GET;文件名从 Content-Disposition 拿
    const dl = await downloadDirect(resolved.url, { fetchImpl: fetchImpl as unknown as typeof fetch, headers: resolved.headers })
    expect(dl.bytes.length).toBeGreaterThan(0)
    expect(dl.filename).toBe('[zmk.pw]pulp.fiction.zh.zip')

    // 4. write——artifactFilename 走 tools.ts 同款优先级(resolve.filename ?? dl.filename ?? 兜底);
    //    dl.filename 是 .zip → pickFromZip 解压
    const artifactFilename = resolved.filename ?? dl.filename ?? (dl.contentType?.includes('zip') ? 'download.zip' : 'download.srt')
    const outDir = mkdtempSync(join(tmpdir(), 'zimuku-e2e-out-'))
    const written = asWritten(await writeSubtitle({
      artifact: dl.bytes, artifactFilename: artifactFilename!,
      videoFilename: 'Pulp.Fiction.1994.mkv', langTag: 'zh-Hans', outDir,
    }))
    expect(existsSync(written.path)).toBe(true)
    expect(written.path).toContain('Pulp.Fiction.1994.zh-Hans.srt')
    expect(readFileSync(written.path, 'utf8')).toContain('这是一部关于生死的电影')

    // 会话 cookie 已缓存(组合串:pending + 验证令牌),供下一次 job 复用(不必重新破解)
    expect(sessionStore.get()?.cookie).toBe('security_session_verify=PEND; security_session_high_verify=HIGH')
  })
})
