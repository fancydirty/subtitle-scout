import type { OpenSubtitlesClient } from '../../adapters/providers/opensubtitles.js'
import { osToCandidates } from '../../adapters/providers/opensubtitles.js'
import type { FetchAdapter } from '../fetchLib.js'

/**
 * 'tt13152020' → 13152020；无值时 undefined。
 * 0（'tt0000000' 占位符，部分刮削器用它标记"未匹配"）和 NaN（畸形值，如误传整个 imdb URL）
 * 一律视为"无 imdb"，退化到标题+season/episode 查询——否则会带着必然 0 命中的 imdb_id 查询提交，
 * 而本该走的标题查询分支被跳过（`imdb != null` 对 0 和 NaN 都是 true）。
 */
const imdbDigits = (s: string | undefined): number | undefined => {
  if (!s) return undefined
  const n = Number(s.replace(/^tt/, ''))
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/**
 * OpenSubtitles FetchAdapter 工厂——从 subtitle-fetch.ts 的 buildAdapters() 闭包里抽出，供直接单测
 * （镜像 assrtAdapter.ts 的抽取模式：subtitle-fetch.ts 顶层 main().catch() 会在 import 时触发副作用，
 * 闭包内联逻辑没有独立测试面）。
 *
 * 修复（OS-only e2e 实测破防）：Jellyfin 传入的 args.imdb 永远是"条目自身"的 imdb——
 * 电影是电影的，剧集是该集自己的（如 Peacemaker S01E01 → tt13152020），从不是剧集级 parent imdb。
 * 旧逻辑在有 season 时把它当 parentImdbId 传给 OS API 的 parent_imdb_id 参数，实测 0 命中；
 * 而同一个 id 作为 imdb_id 查询能命中（imdb_id 本身已经是"具体条目"的粒度，不需要再叠 season/episode）。
 * 因此：只要有 imdb 就直接查 imdb_id（不带 season/episode）；只有没有 imdb 时才退化到标题 + season/episode。
 */
export function makeOpenSubtitlesAdapter(
  client: Pick<OpenSubtitlesClient, 'search' | 'resolveDownload'>,
): FetchAdapter {
  return {
    name: 'opensubtitles',
    enabled: () => true,
    search: async (args) => {
      const languages = args.languages ?? ['zh-cn', 'zh-tw']
      const imdb = imdbDigits(args.imdb)
      const resp = await client.search(imdb != null
        ? { imdbId: imdb, languages }
        : { query: args.queries[0], season: args.season, episode: args.episode, year: args.year, languages })
      return osToCandidates(resp)
    },
    resolve: async (ref) => {
      const r = await client.resolveDownload(Number(ref.providerId))
      return { url: r.link, filename: r.file_name ?? undefined }
    },
  }
}
