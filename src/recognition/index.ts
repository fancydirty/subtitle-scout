import { posix } from 'node:path'
import { identifyFromPath, type PathIdentity, type Park } from './identifyFromPath.js'
import { resolveToTmdb, type Recognized } from './resolveToTmdb.js'
import type { ParsedName } from './parseFilename.js'
import type { TmdbClient } from '../adapters/providers/tmdb.js'

// Re-exported so downstream consumers (B1/B2, the self-scan daemon) can import the whole
// recognition subsystem's public surface from this one module, e.g.
// `import { recognize, type Recognized, type Park } from '../recognition/index.js'`.
export type { PathIdentity, Park, ParsedName, Recognized }

/** P6 认领表(identify_overrides)消歧前查询的形状——LibraryRepo.findOverride 的返回类型收窄版
 *  （去掉 null，recognize 自己判空），避免 recognition 子系统反向依赖 v2/libraryRepo.ts。 */
export interface IdentifyOverrideLookup {
  tmdbId: string
  isTv: boolean
}

export interface RecognizeOpts {
  /** 去 Jellyfin 化 P6：identify_overrides 最长前缀匹配查询，消歧（TMDB 搜索）前查——命中即
   *  跳过搜索直接采信人工认领。未传 = 无覆盖表可查（向后兼容既有调用方，行为不变）。 */
  findOverride?: (videoPath: string) => IdentifyOverrideLookup | null
}

/**
 * P7 真库闸门 Bug 1 修复专用：identifyFromPath 完全找不到结构（'no-signal' park）时，一个人类
 * 已经通过救援页明确认领了这条路径——这个显式认领本身就是 identifyFromPath 自己缺的那一点
 * 信号，值得为它单独放宽一次解析规则，去 basename（去扩展名）末尾找一个"分隔符 + 1-4位数字
 * + 可选尾随中括号标签"的模式，当绝对集号用。比 identifyFromPath 自己的 BARE_EPISODE_PATTERNS
 * 宽松得多（那组规则要求整个 basename 就是纯数字/'ep N'/中文'第N话'）——这里只要求数字长在
 * basename 的最后面，前面随便多少路径噪音（发布组名、剧名、分辨率标签……）都不管，因为已经
 * 有人类背书这整条路径 = 这个 tmdbId，剩下唯一要猜的只是"第几集"。刻意仍然不做的事：不猜
 * season（絕對編號场景下 season/episode 留 null，交给 ingest 层 T3 的 seasonEpisodeForAbsolute
 * 折算），不识别多集范围（'01-02'这类），不去猜 title——这些都不是"救回一个 park"必须做的事，
 * YAGNI。 */
const LENIENT_TRAILING_EPISODE_PATTERN = /[\s._-](\d{1,4})\s*(?:\[[^\]]*\])?$/

function lenientTrailingEpisode(videoPath: string): number | null {
  const normalized = videoPath.replace(/\\/g, '/')
  const segments = normalized.split('/').filter((segment) => segment.length > 0)
  if (segments.length === 0) return null
  const fileSeg = segments[segments.length - 1]
  const baseName = posix.parse(fileSeg).name
  const match = baseName.match(LENIENT_TRAILING_EPISODE_PATTERN)
  return match ? Number(match[1]) : null
}

/**
 * C4: the recognition subsystem's single entry point — path string in, TMDB identity or a park
 * reason out. Deliberately thin: just chains C2 (identifyFromPath) into C3 (resolveToTmdb) with
 * one short-circuit, and adds nothing of its own. No caching, no fs walking, no retry policy —
 * those are B's concerns (the self-scan daemon), explicitly out of scope here.
 *
 * A `Park` produced by identifyFromPath (pure path-string analysis, no network) short-circuits
 * before resolveToTmdb ever runs — there is nothing to search for a path with zero title signal.
 * A `TmdbRequestFailedError` thrown out of resolveToTmdb (transient network/5xx failure) is
 * deliberately NOT caught here and propagates to the caller unchanged — same distinction C3
 * documents throughout: a request that never actually got an answer is not the same thing as a
 * park (TMDB answered with nothing/too much), and collapsing the two would let a transient TMDB
 * blip get permanently misfiled as "no match".
 *
 * 去 Jellyfin 化 P6（design §P6）：`opts.findOverride` 是 identify_overrides 的消歧前查询点——
 * 一旦 identifyFromPath 给出非 Park 的路径结构（有 season/episode 或 embeddedTmdbId 之外的
 * 结构信号），在喂给 C3 的 TMDB 搜索消歧之前，先问一次覆盖表。命中就直接构造 Recognized：
 * override 只回答"这是什么"（tmdbId/isTv），season/episode/absoluteEpisode 仍然来自路径结构
 * 本身（identity）——覆盖表从不覆盖这三个字段。**embedded `[tmdbid-N]` 标签仍然优先**（既有
 * 行为不变）：只有 identity.embeddedTmdbId 为 null 时才咨询 override，否则直接走 resolveToTmdb
 * 让它的 rule 1 pass-through 生效——两者若都命中，嵌入标签的可信度更高（我们自己的 realign 或
 * Sonarr/Radarr/Jellyfin 已经把它写死在目录名里），不该被一条更旧的人工认领覆盖。
 *
 * P7 真库闸门 Bug 1：identifyFromPath 一点结构都找不到（'no-signal' park）时，过去这里直接把
 * park 短路返回，override 从未被咨询过——救援页最想救的偏偏就是这一类 park（能被机械层解析出
 * 部分结构的 park 好歹还有别的出路；结构全无的 fansub 命名只有人工认领这一条路），结果它恰恰
 * 是唯一救不回来的一类。修复：不管 identity 是不是 park，都问一次 override。命中 + park 时，
 * 用"人工已经明确认领这条路径"这个强信号去 gate 一次仅限于此处的宽松解析
 * （lenientTrailingEpisode，见上）：电影不需要集号，直接采信；剧需要集号，提得到就当
 * absoluteEpisode（season/episode 留 null，ingest 层的 seasonEpisodeForAbsolute 负责折算）；
 * 提不到就还是 park，但换一个诚实的理由（'override-no-structure'，救援页能看出"已认领但没有
 * 集号信号"和"从未认领"的区别）。哲学：宽松解析只在人工认领已经明确背书的这一条分支里生效，
 * 无人值守路径（identity 非 park，或者 park 但没有命中 override）永远不触碰这条宽松规则。
 */
export async function recognize(
  videoPath: string,
  tmdb: TmdbClient,
  opts?: RecognizeOpts,
): Promise<Recognized | Park> {
  const identity = identifyFromPath(videoPath)

  if ('park' in identity) {
    const override = opts?.findOverride?.(videoPath)
    if (!override) return identity
    if (!override.isTv) {
      return { tmdbId: override.tmdbId, title: '', isTv: false, season: null, episode: null, absoluteEpisode: null }
    }
    const absoluteEpisode = lenientTrailingEpisode(videoPath)
    if (absoluteEpisode === null) return { park: 'override-no-structure' }
    return { tmdbId: override.tmdbId, title: '', isTv: true, season: null, episode: null, absoluteEpisode }
  }

  if (identity.embeddedTmdbId === null) {
    const override = opts?.findOverride?.(videoPath)
    if (override) {
      return {
        tmdbId: override.tmdbId,
        title: identity.title ?? '',
        isTv: override.isTv,
        season: identity.season,
        episode: identity.episode,
        absoluteEpisode: identity.absoluteEpisode,
      }
    }
  }

  return resolveToTmdb(identity, tmdb)
}
