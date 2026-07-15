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
 */
export async function recognize(
  videoPath: string,
  tmdb: TmdbClient,
  opts?: RecognizeOpts,
): Promise<Recognized | Park> {
  const identity = identifyFromPath(videoPath)
  if ('park' in identity) return identity

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
