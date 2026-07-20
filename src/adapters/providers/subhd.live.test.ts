import { describe, it, expect } from 'vitest'
import { SubhdClient, SUBHD_HEADERS } from './subhd.js'

// 🔴 强制真机端到端冒烟——env 门控，默认 CI 跳过（同 streamProbe 的 canRunRealSmoke 范式）。
// 打开：SUBHD_LIVE_SMOKE=1 npm test -- src/adapters/providers/subhd.live.test.ts
// 需要宿主/容器有 curl 且能到达 subhd.me（Node TLS 指纹被临时页校验拒，SubhdClient 默认 shell 到
// curl，见 subhd.ts）。真的搜到、真的下到非空字幕/压缩包，是"确实能拿到东西"的唯一凭证——不许 skip 蒙混。
const live = process.env.SUBHD_LIVE_SMOKE === '1'

describe('subhd 真机冒烟 (SUBHD_LIVE_SMOKE=1)', () => {
  it.skipIf(!live)('搜真剧 → resolve → 下真字幕（非空）', async () => {
    // resolveAttempts:1——每候选恰好 3 次 mint 请求（prepare/down/api），别在单个候选上重试铺量把
    // subhd 的按-IP mint 限流触发（~5-6 次/窗口即整 IP 回"已失效"）；靠默认 2-5s 限速在候选间拉开节奏，
    // 逐条换候选给多次机会。走 subhd.me，默认 curlFetch。
    const client = new SubhdClient({ resolveAttempts: 1 })
    const results = await client.search('The Rig')
    expect(results.length).toBeGreaterThan(0)
    expect(results.every(r => r.id.length > 0)).toBe(true)

    // 逐条尝试直到一条完成 resolve+下载（临时页时间窗/偶发限流下，客户端内部已重试，这里再多试几条）
    let downloaded: { id: string; url: string; bytes: number } | null = null
    let lastErr: unknown
    for (const r of results.slice(0, 3)) {
      try {
        const dl = await client.resolveDownload(r.id)
        const res = await fetch(dl.url, {
          headers: { ...SUBHD_HEADERS, ...(dl.cookie ? { Cookie: dl.cookie } : {}) },
          signal: AbortSignal.timeout(30_000),
        })
        if (res.status !== 200) { lastErr = new Error(`CDN HTTP ${res.status}`); continue }
        const buf = Buffer.from(await res.arrayBuffer())
        if (buf.length > 0) { downloaded = { id: r.id, url: dl.url, bytes: buf.length }; break }
      } catch (e) { lastErr = e }
    }
    if (!downloaded) throw new Error(`subhd live smoke: no id yielded a non-empty file (last: ${String(lastErr)})`)
    // eslint-disable-next-line no-console
    console.log(`subhd live smoke OK: id=${downloaded.id} bytes=${downloaded.bytes} url=${downloaded.url}`)
    expect(downloaded.bytes).toBeGreaterThan(0)
  }, 180_000)
})
