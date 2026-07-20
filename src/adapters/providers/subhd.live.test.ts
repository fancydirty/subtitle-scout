import { describe, it, expect } from 'vitest'
import { SubhdClient, SUBHD_HEADERS } from './subhd.js'

// 🔴 强制真机端到端冒烟——env 门控，默认 CI 跳过（同 streamProbe 的 canRunRealSmoke 范式）。
// 打开：SUBHD_LIVE_SMOKE=1 npm test -- src/adapters/providers/subhd.live.test.ts
// 需要宿主/容器有 curl 且能到达 subhd.me（Node TLS 指纹被临时页校验拒，SubhdClient 默认 shell 到
// curl，见 subhd.ts）。真的搜到、真的下到非空字幕/压缩包，是"确实能拿到东西"的唯一凭证——不许 skip 蒙混。
const live = process.env.SUBHD_LIVE_SMOKE === '1'

describe('subhd 真机冒烟 (SUBHD_LIVE_SMOKE=1)', () => {
  it.skipIf(!live)('搜真剧 → resolve → 下真字幕（非空）', async () => {
    // 默认 resolveAttempts=3——subhd 的"已失效"是概率性的（有效 cookie 也可能被拒），几次重试才撞上
    // 放行（实测 base 3 次稳）。候选间再拉开 25s，摊平 mint 速率。走 subhd.me，默认 curlFetch。
    const client = new SubhdClient({})
    const results = await client.search('The Rig')
    expect(results.length).toBeGreaterThan(0)
    expect(results.every(r => r.id.length > 0)).toBe(true)

    // 逐条尝试直到一条完成 resolve+下载。候选之间拉开 ~25s——mint 限流是窗口内速率/量，把各候选的
    // 3 次 mint 摊到更长时间线上既不易触发限流、又能在 IP 正从限流里恢复时让后面的候选撞上干净窗口。
    let downloaded: { id: string; url: string; bytes: number } | null = null
    let lastErr: unknown
    const candidates = results.slice(0, 4)
    for (let i = 0; i < candidates.length; i++) {
      const r = candidates[i]
      if (i > 0) await new Promise(res => setTimeout(res, 25_000))
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
