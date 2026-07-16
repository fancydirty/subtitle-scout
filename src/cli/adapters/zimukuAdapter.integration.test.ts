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

describe('zimuku end-to-end offline (challenge → solve → search → resolve → download → unzip → write)', () => {
  it('produces an installed subtitle file from a cold session, exercising the full FetchAdapter contract', async () => {
    const challengeHtml = readFileSync('fixtures/zimuku/challenge.html', 'utf8')
    const searchHtml = readFileSync('fixtures/zimuku/search-spy-family.html', 'utf8')
    const detailHtml = readFileSync('fixtures/zimuku/detail-58421.html', 'utf8')

    const zip = new AdmZip()
    zip.addFile('spy_family_s01_zh.srt', Buffer.from(
      '1\n00:00:01,000 --> 00:00:03,500\n阿尼亚喜欢花生\n\n2\n00:00:04,000 --> 00:00:06,200\n任务开始\n\n',
    ))
    const zipBuffer = zip.toBuffer()

    let searchCallCount = 0
    const fetchImpl = async (url: string) => {
      const u = String(url)
      if (u.includes('/search?q=')) {
        searchCallCount++
        return searchCallCount === 1 ? new Response(challengeHtml) : new Response(searchHtml)
      }
      if (u.includes('/detail/58421.html')) return new Response(detailHtml)
      if (u.includes('security_verify_img')) return new Response(Buffer.from('png'))
      if (u.includes('aq_wzws_confirm.html')) {
        return new Response('ok', { headers: { 'set-cookie': 'security_session_verify=e2e789; Path=/' } })
      }
      if (u.includes('static.zimuku.org')) return new Response(zipBuffer)
      throw new Error(`unexpected fetch in test: ${u}`)
    }

    const sessionStore = new ZimukuSessionStore(mkdtempSync(join(tmpdir(), 'zimuku-e2e-session-')))
    const client = new ZimukuClient({
      sessionStore, fetchImpl: fetchImpl as unknown as typeof fetch,
      solve: async () => ({ digits: '74504' }),
      limiter: new MinIntervalLimiter(1),
    })
    const adapter = makeZimukuAdapter(client)

    // 1. search(模拟 fetchLib.runSearch 的调度层)
    const candidates = await runSearch({ queries: ['间谍过家家'], deep: false }, [adapter], () => {})
    expect(candidates).toHaveLength(2)
    expect(candidates[0]).toMatchObject({ provider: 'zimuku', providerId: '58421', fileList: [] })

    // 2. resolve(模拟 fetchLib.runResolve)
    const resolved = await runResolve({ provider: 'zimuku', providerId: candidates[0].providerId, fileIndex: null }, [adapter])
    expect(resolved.filename).toBe('spy_family_s01_zh.zip')
    expect(resolved.headers).toMatchObject({ 'Accept-Language': 'zh-CN,zh;q=0.9' })

    // 3. download(headers 必须原样带到归档 GET——这是 Phase E 打通的那道缝)
    const dl = await downloadDirect(resolved.url, { fetchImpl: fetchImpl as unknown as typeof fetch, headers: resolved.headers })
    expect(dl.bytes.length).toBeGreaterThan(0)

    // 4. write(zero-changes 路径:pickFromZip 靠 .zip 扩展名自动触发,见 subtitleWriter.ts)
    const outDir = mkdtempSync(join(tmpdir(), 'zimuku-e2e-out-'))
    const written = asWritten(await writeSubtitle({
      artifact: dl.bytes, artifactFilename: resolved.filename!,
      videoFilename: 'SPY.FAMILY.S01E01.mkv', langTag: 'zh-Hans', outDir,
    }))
    expect(existsSync(written.path)).toBe(true)
    expect(written.path).toContain('SPY.FAMILY.S01E01.zh-Hans.srt')
    expect(readFileSync(written.path, 'utf8')).toContain('阿尼亚喜欢花生')

    // 会话 cookie 已经缓存下来,供下一次 job 复用(不必重新破解)
    expect(sessionStore.get()?.cookie).toBe('security_session_verify=e2e789')
  })
})
