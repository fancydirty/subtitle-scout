import type { AssrtClient } from '../../adapters/providers/assrt.js'
import { toCandidate } from '../../adapters/providers/assrt.js'
import type { FetchAdapter } from '../fetchLib.js'

/**
 * ASSRT FetchAdapter 工厂——从 subtitle-fetch.ts 的 buildAdapters() 闭包里抽出，供直接单测
 * （原逻辑内嵌在闭包里没有独立测试面；fetchLib 的编排测试只覆盖 runSearch/runResolve 的调度，
 * 不触达这里的多查询/去重/gems/resolve 细节）。
 * client 收窄到用到的 4 个方法（Pick），测试用 fake client 免造真 AssrtClient（网络/缓存/限速）。
 */
export function makeAssrtAdapter(
  client: Pick<AssrtClient, 'search' | 'similar' | 'searchByFilename' | 'detail'>,
): FetchAdapter {
  return {
    name: 'assrt',
    enabled: () => true,
    search: async (args) => {
      const byId = new Map<number, ReturnType<typeof toCandidate>>()
      for (const q of args.queries.slice(0, 2)) {
        const resp = await client.search(q)
        for (const s of resp.sub.subs) if (!byId.has(s.id)) byId.set(s.id, toCandidate(s))
      }
      // gems: 有命中→similar 扩召回；零命中→整文件名兜底
      if (byId.size > 0) {
        const top = [...byId.keys()][0]
        try {
          const sim = await client.similar(top)
          for (const s of sim.sub.subs) if (!byId.has(s.id)) byId.set(s.id, toCandidate(s))
        } catch { /* gems 失败不影响主结果 */ }
      } else if (args.filename) {
        const byFile = await client.searchByFilename(args.filename)
        for (const s of byFile.sub.subs) byId.set(s.id, toCandidate(s))
      }
      return [...byId.values()]
    },
    resolve: async (ref) => {
      const detail = await client.detail(Number(ref.providerId))
      const sub = detail.sub.subs.find(s => String(s.id) === ref.providerId) ?? detail.sub.subs[0]
      if (!sub) throw new Error(`assrt detail ${ref.providerId} returned no subs`)
      const entry = ref.fileIndex != null ? sub.filelist[ref.fileIndex] : undefined
      const url = entry?.url ?? sub.url
      if (!url) throw new Error(`assrt ${ref.providerId} has no download url`)
      return { url, filename: entry?.f ?? sub.filename ?? undefined }
    },
  }
}
