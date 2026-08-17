import { readFileSync } from 'node:fs'

export const CONTROL_NEZHA_TMDB = 615453
export const CONTROL_MATRIX_TMDB = 603

export type SandboxProfile = 'zh-viewer' | 'en-viewer'
export type SandboxRole = 'find' | 'origin-skip'
export type SandboxFormat = 'movie' | 'tv'
export type SandboxRegion = 'us' | 'gb' | 'fr' | 'jp' | 'kr' | 'cn' | 'hk'

export interface CatalogEntry {
  id: string
  profile: SandboxProfile
  role: SandboxRole
  relPath: string
  tmdbKind: 'movie' | 'tv'
  tmdbId: number
  year: number
  region: SandboxRegion
  format: SandboxFormat
  animation: boolean
  expectedOriginLang: string
}

export interface Catalog {
  entries: CatalogEntry[]
}

export function eraOf(year: number): 'classic' | 'modern' {
  return year <= 1999 ? 'classic' : 'modern'
}

export function loadCatalog(path: string): Catalog {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Catalog
  if (!Array.isArray(raw.entries)) throw new Error(`catalog missing entries: ${path}`)
  return raw
}

export function parseSandboxIds(raw?: string): string[] | undefined {
  if (raw == null || raw.trim() === '') return undefined
  const ids = raw.split(',').map(s => s.trim())
  if (ids.some(id => id === '')) {
    throw new Error('empty sandbox id in --ids list')
  }
  return ids
}

export function filterCatalogByIds(catalog: Catalog, ids: string[]): Catalog {
  const unknown = ids.filter(id => !catalog.entries.some(e => e.id === id))
  if (unknown.length > 0) {
    throw new Error(`unknown sandbox catalog id(s): ${unknown.join(', ')}`)
  }
  const wanted = new Set(ids)
  return { entries: catalog.entries.filter(e => wanted.has(e.id)) }
}

export function entriesFor(catalog: Catalog, profile: SandboxProfile, role?: SandboxRole): CatalogEntry[] {
  return catalog.entries.filter(e => e.profile === profile && (role == null || e.role === role))
}

function has(entries: CatalogEntry[], pred: (e: CatalogEntry) => boolean, n = 1): boolean {
  return entries.filter(pred).length >= n
}

/** Returns human-readable missing-axis labels. Empty array = spec §5.1 satisfied. */
export function coverageGaps(catalog: Catalog): string[] {
  const gaps: string[] = []
  const zhFind = entriesFor(catalog, 'zh-viewer', 'find')
  const zhSkip = entriesFor(catalog, 'zh-viewer', 'origin-skip')
  const enFind = entriesFor(catalog, 'en-viewer', 'find')
  const enSkip = entriesFor(catalog, 'en-viewer', 'origin-skip')

  const need = (ok: boolean, label: string) => { if (!ok) gaps.push(label) }

  need(has(zhFind, e => e.format === 'movie' && !e.animation && eraOf(e.year) === 'classic' && e.region === 'us'), 'zh-find movie classic us')
  need(has(zhFind, e => e.format === 'movie' && !e.animation && eraOf(e.year) === 'classic' && e.region === 'jp'), 'zh-find movie classic jp')
  need(has(zhFind, e => e.format === 'movie' && !e.animation && eraOf(e.year) === 'modern' && e.region === 'us'), 'zh-find movie modern us')
  need(has(zhFind, e => e.format === 'movie' && !e.animation && eraOf(e.year) === 'modern' && e.region === 'kr'), 'zh-find movie modern kr')
  need(has(zhFind, e => e.format === 'movie' && !e.animation && eraOf(e.year) === 'modern' && e.region === 'fr'), 'zh-find movie modern fr')
  need(has(zhFind, e => e.format === 'movie' && e.animation && e.region === 'jp' && eraOf(e.year) === 'classic'), 'zh-find animation-movie jp classic')
  need(has(zhFind, e => e.format === 'movie' && e.animation && e.region === 'jp' && eraOf(e.year) === 'modern'), 'zh-find animation-movie jp modern')
  need(has(zhFind, e => e.format === 'movie' && e.animation && e.region === 'us'), 'zh-find animation-movie us')
  need(has(zhFind, e => e.format === 'tv' && !e.animation && e.region === 'us' && eraOf(e.year) === 'classic'), 'zh-find tv us classic')
  need(has(zhFind, e => e.format === 'tv' && !e.animation && e.region === 'us' && eraOf(e.year) === 'modern'), 'zh-find tv us modern')
  need(has(zhFind, e => e.format === 'tv' && !e.animation && e.region === 'gb'), 'zh-find tv gb')
  need(has(zhFind, e => e.format === 'tv' && !e.animation && e.region === 'kr'), 'zh-find tv kr')
  need(has(zhFind, e => e.format === 'tv' && !e.animation && e.region === 'jp'), 'zh-find tv jp live-action')
  need(has(zhFind, e => e.format === 'tv' && e.animation && e.region === 'jp' && eraOf(e.year) === 'classic'), 'zh-find tv-animation jp classic')
  need(has(zhFind, e => e.format === 'tv' && e.animation && e.region === 'jp' && eraOf(e.year) === 'modern', 2), 'zh-find tv-animation jp modern ×2')

  need(has(zhSkip, e => e.region === 'cn' && e.format === 'movie' && !e.animation && eraOf(e.year) === 'classic'), 'zh-skip movie classic cn')
  need(has(zhSkip, e => e.region === 'cn' && e.format === 'movie' && !e.animation && eraOf(e.year) === 'modern'), 'zh-skip movie modern cn')
  need(has(zhSkip, e => e.region === 'cn' && e.format === 'movie' && e.animation), 'zh-skip animation-movie cn')
  need(has(zhSkip, e => e.region === 'cn' && e.format === 'tv'), 'zh-skip tv cn')

  need(has(enFind, e => e.format === 'movie' && !e.animation && eraOf(e.year) === 'classic' && (e.region === 'cn' || e.region === 'hk')), 'en-find movie classic cn/hk')
  need(has(enFind, e => e.format === 'movie' && !e.animation && eraOf(e.year) === 'modern' && e.region === 'cn'), 'en-find movie modern cn')
  need(has(enFind, e => e.format === 'movie' && e.animation && e.region === 'cn'), 'en-find animation-movie cn')
  need(has(enFind, e => e.format === 'movie' && e.region === 'hk'), 'en-find movie hk')
  need(enFind.filter(e => e.format === 'tv' && e.region === 'cn').length >= 2, 'en-find tv cn ×2 different years')
  const enCnTvYears = new Set(enFind.filter(e => e.format === 'tv' && e.region === 'cn').map(e => e.year))
  need(enCnTvYears.size >= 2, 'en-find tv cn distinct years')

  need(has(enSkip, e => e.format === 'movie' && eraOf(e.year) === 'classic' && e.expectedOriginLang === 'en'), 'en-skip classic en movie')
  need(has(enSkip, e => e.format === 'movie' && eraOf(e.year) === 'modern' && e.expectedOriginLang === 'en'), 'en-skip modern en movie')

  return gaps
}
