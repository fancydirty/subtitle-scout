import type { SubdlClient, SubdlSubtitle, SubdlSearchArgs } from '../providers/subdl.js'
import { subdlDownloadUrl } from '../providers/subdl.js'
import type { FetchAdapter, FetchArgs } from '../fetchLib.js'
import type { SubtitleCandidate } from '../../core/schemas.js'

/** SubDL 是国际源（subscene 接班），什么语言都接——不做中文门控（与 assrt/r3sub 相反）。 */

function toCandidate(sub: SubdlSubtitle): SubtitleCandidate {
  return {
    provider: 'subdl',
    providerId: sub.url,   // url 段（'/subtitle/xxx.zip'）即 providerId，resolve 拼 dl 前缀
    videoName: sub.release_name || sub.name || null,
    nativeName: sub.name || null,
    language: sub.language || sub.lang || null,
    subtype: null,
    releaseSite: null,
    uploadDate: null,
    fileList: [],
  }
}

/** 从 FetchArgs 组装 SubDL 搜索参数：id 优先（imdb>tmdb>film_name，优先级判断在 client），
 *  movie/tv 按 season/episode 有无判定。 */
function toSearchArgs(args: FetchArgs): SubdlSearchArgs {
  const isTv = args.season != null
  return {
    filmName: args.queries[0],
    imdbId: args.imdb,
    // 非数字串不传（宁缺勿错——tmdb_id 只收纯数字）；imdb/tmdb 同给时两者都透传，裁剪归 client。
    tmdbId: args.tmdb != null && /^\d+$/.test(args.tmdb) ? Number(args.tmdb) : undefined,
    type: isTv ? 'tv' : 'movie',
    languages: args.languages ?? ['zh'],
    season: args.season,
    episode: args.episode,
  }
}

/**
 * SubDL FetchAdapter 工厂。SubDL 是标准 REST + 单跳 GET zip 下载——resolve 走常规
 * runResolve→downloadDirect（不需 r3sub 那样的 tools 层旁路）。client 收窄到 search（Pick）。
 */
export function makeSubdlAdapter(client: Pick<SubdlClient, 'search'>): FetchAdapter {
  return {
    name: 'subdl',
    enabled: () => true,   // 国际源，任何语言搜索都扇出
    search: async (args) => {
      const subs = await client.search(toSearchArgs(args))
      return subs.map(toCandidate)
    },
    resolve: async (ref) => {
      // providerId 是 subtitles[].url（'/subtitle/xxx.zip'），拼 dl 前缀即绝对下载地址。
      return { url: subdlDownloadUrl(ref.providerId) }
    },
  }
}
