import type { AssrtClient } from '../../adapters/providers/assrt.js'
import { toCandidate } from '../../adapters/providers/assrt.js'
import type { FetchAdapter, FetchEvent } from '../fetchLib.js'

/** A4: assrt (assrt.net) is a China-only subtitle source — once target languages generalize past
 *  zh, it must be excluded for a search that isn't after Chinese subtitles at all, and stay
 *  included whenever zh is (still) one of the requested languages. Prefix match (no trailing `$`)
 *  so region/script-suffixed forms match too — bare 'zh'/'cn' (TMDB original_language aliases;
 *  daemon/triggers.ts's isChineseLang used the same alias set before that module was deleted in
 *  the de-Jellyfin-ization campaign), ISO 639-2 'chi'/'zho', their zh-Hans/zh-Hant shorthands
 *  'chs'/'cht', and anything prefixed with one of those (e.g. 'zh-cn'/'zh-tw' — FetchArgs.languages'
 *  own documented adapter default). runSearch (fetchLib.ts) guarantees `args.languages` is never
 *  undefined by the time `enabled` sees it (defaults to ['zh'] for the enabled-check only) — see
 *  its own comment for why assrt must not silently drop off an un-language-annotated search. */
const CHINESE_LANGUAGE_PREFIX = /^(zh|chi|zho|chs|cht|cn)/i

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
    enabled: (args) => (args.languages ?? []).some(l => CHINESE_LANGUAGE_PREFIX.test(l)),
    search: async (args, emit?: (e: FetchEvent) => void) => {
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
        } catch (e) {
          // gems 失败不影响主结果（继续返回已有候选），但绝不能裸吞——下游消费方需要这个信号，
          // 否则瞬时故障可能被当成"确实没有"写进 1 天负缓存（这个信号本是给旧管线 pipeline.ts
          // 的 incomplete-candidate-set guard 用的，pipeline.ts 已随旧管线退役删除，但"失败
          // 不能裸吞"这条纪律不因消费方换人而失效）。
          emit?.({ event: 'provider_error', provider: 'assrt', message: `similar() failed: ${String(e)}` })
        }
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
      // fileIndex 非空但在 detail.filelist 越界:**绝不静默回落到 sub.url(整包/顶层文件)**——那会装错集
      // (search 与 detail 是两次独立 API,filelist 长度/顺序不保证一致;越界时我们根本不知道 agent 想要
      // 的那一集对应到哪。宁停不猜:抛错让 agent 换候选或改用 fileIndex:null 走整包+archiveEntryName 选集,
      // 而不是把"整包顶层文件"当成那一集悄悄装上——silent 装错比留缺口更糟,是北极星明令避免的)。
      let url: string | undefined
      let filename: string | undefined
      if (ref.fileIndex != null) {
        const entry = sub.filelist[ref.fileIndex]
        if (!entry) {
          throw new Error(
            `assrt ${ref.providerId}: fileIndex ${ref.fileIndex} 在 detail filelist(${sub.filelist.length} 项)越界——` +
            `拒绝静默回落到整包 URL(会装错集);agent 应换候选或用 fileIndex:null 走整包+archiveEntryName 选集`,
          )
        }
        url = entry.url
        filename = entry.f ?? undefined
      } else {
        url = sub.url
        filename = sub.filename ?? undefined
      }
      if (!url) throw new Error(`assrt ${ref.providerId} has no download url`)
      return { url, filename }
    },
  }
}
