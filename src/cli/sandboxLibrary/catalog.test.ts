import { describe, it, expect } from 'vitest'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  loadCatalog, coverageGaps, eraOf, CONTROL_NEZHA_TMDB, CONTROL_MATRIX_TMDB,
} from './catalog.js'

const catalogPath = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/sandbox-libraries/catalog.json')

describe('sandbox library catalog', () => {
  it('loads and every tmdbId is a positive integer', () => {
    const catalog = loadCatalog(catalogPath)
    expect(catalog.entries.length).toBeGreaterThan(20)
    for (const e of catalog.entries) {
      expect(Number.isInteger(e.tmdbId) && e.tmdbId > 0).toBe(true)
      expect(['zh-viewer', 'en-viewer']).toContain(e.profile)
      expect(['find', 'origin-skip']).toContain(e.role)
      expect(e.relPath).not.toMatch(/^[/\\]/)
    }
  })

  it('eraOf: 1999 is classic, 2000 is modern', () => {
    expect(eraOf(1999)).toBe('classic')
    expect(eraOf(1942)).toBe('classic')
    expect(eraOf(2000)).toBe('modern')
    expect(eraOf(2024)).toBe('modern')
  })

  it('coverage axes from spec §5.1 are all present (gaps empty)', () => {
    const catalog = loadCatalog(catalogPath)
    expect(coverageGaps(catalog)).toEqual([])
  })

  it('Nezha (615453) and Matrix (603) appear in both profiles with opposite roles', () => {
    const catalog = loadCatalog(catalogPath)
    const nezha = catalog.entries.filter(e => e.tmdbId === CONTROL_NEZHA_TMDB)
    const matrix = catalog.entries.filter(e => e.tmdbId === CONTROL_MATRIX_TMDB)
    expect(nezha.find(e => e.profile === 'zh-viewer')?.role).toBe('origin-skip')
    expect(nezha.find(e => e.profile === 'en-viewer')?.role).toBe('find')
    expect(matrix.find(e => e.profile === 'zh-viewer')?.role).toBe('find')
    expect(matrix.find(e => e.profile === 'en-viewer')?.role).toBe('origin-skip')
  })

  it('each title contributes exactly one video file; TV paths are S01E01', () => {
    const catalog = loadCatalog(catalogPath)
    const ids = catalog.entries.map(e => `${e.profile}:${e.id}`)
    expect(new Set(ids).size).toBe(ids.length)
    for (const e of catalog.entries.filter(x => x.format === 'tv')) {
      expect(e.relPath).toMatch(/S01E01/i)
    }
  })
})
