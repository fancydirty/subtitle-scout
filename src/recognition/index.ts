import { identifyFromPath, type PathIdentity, type Park } from './identifyFromPath.js'
import type { ParsedName } from './parseFilename.js'
import type { TmdbClient } from '../adapters/providers/tmdb.js'

// Re-exported so downstream consumers (B1/B2, the self-scan daemon) can import the whole
// recognition subsystem's public surface from this one module, e.g.
// `import { recognize, type PathIdentity, type Park } from '../recognition/index.js'`.
export type { PathIdentity, Park, ParsedName }

/** 认领表(identify_overrides)消歧前查询的返回形状——LibraryRepo.findOverride 返回类型的收窄版
 *  （去掉 null，recognize 自己判空），避免 recognition 子系统反向依赖 v2/libraryRepo.ts。
 *  结构兼容：LibraryRepo 的 IdentifyOverride（多一个 source 字段）可直接赋给本类型。 */
export interface IdentifyOverride {
  tmdbId: string
  isTv: boolean
  /** 认领时一并给出的季号（可选）；给了就以它为准，覆盖路径结构解析出的 season。 */
  season?: number | null
  /** 认领时一并给出的集号（可选）；给了就以它为准，覆盖路径结构解析出的 episode。 */
  episode?: number | null
}

/**
 * C4: the recognition subsystem's single entry point — path string in, structure hints
 * (`PathIdentity`) or a park reason out. Pure mechanical parse: no TMDB search, no network, no
 * caching, no fs walking. Identity adjudication (TMDB search/details/library writes) has moved
 * up to the agent's write_identified_media tool — this layer only extracts structure hints from
 * the path itself. The old C3 mechanical TMDB-resolution step (resolveToTmdb) is deleted: a
 * deterministic "unique hit" rule can still misidentify, and the 绝不误认 red line leaves
 * identification to the agent's search + verification loop instead.
 *
 * `opts.findOverride` consults the identify_overrides claim table before anything is returned.
 * A hit means a human (rescue page) or the agent has already adjudicated this path's identity —
 * the claim is authoritative, so the returned `PathIdentity` carries the claimed tmdbId as
 * `embeddedTmdbId` (the same "already-identified" channel an embedded `[tmdbid-N]` path tag
 * flows through), and the claim's season/episode (when given) win over path-parsed structure.
 * A 'no-signal' park path with a claim still yields a minimal `PathIdentity` synthesized from
 * the claim alone — the old "a claim can never rescue a no-signal park" bug stays fixed.
 *
 * The `tmdb` parameter is retained only for transitional call-site compatibility — recognize no
 * longer searches TMDB and never touches it.
 */
export function recognize(
  videoPath: string,
  tmdb: Pick<TmdbClient, 'search'>,
  opts?: { findOverride?: (p: string) => IdentifyOverride | null },
): PathIdentity | Park {
  const override = opts?.findOverride?.(videoPath)

  if (override) {
    // Human/agent override: treat as authoritative structure + embedded tmdbId
    const base = identifyFromPath(videoPath)
    if ('park' in base) {
      // No path structure to inherit — the claim alone carries identity
      return {
        title: null,
        year: null,
        season: override.season ?? null,
        episode: override.episode ?? null,
        absoluteEpisode: null,
        isTv: override.isTv,
        embeddedTmdbId: override.tmdbId,
      }
    }
    return {
      ...base,
      embeddedTmdbId: override.tmdbId,
      // If override specifies season/episode, use those
      season: override.season ?? base.season,
      episode: override.episode ?? base.episode,
    }
  }

  // Pure mechanical parse - structure hints only
  return identifyFromPath(videoPath)
}
