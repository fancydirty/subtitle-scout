import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeSelfScan, SELF_SCAN_DEFAULT_INTERVAL_MS, type SelfScanDeps } from './selfScan.js'
import type { Recognized, Park } from '../recognition/index.js'

function recognized(overrides: Partial<Recognized> = {}): Recognized {
  return { tmdbId: 1, title: 'Show', isTv: true, season: 1, episode: 1, absoluteEpisode: null, ...overrides } as Recognized
}

function makeDeps(over: Partial<SelfScanDeps> = {}): SelfScanDeps {
  return {
    roots: [],
    knownPaths: () => new Set<string>(),
    recognize: vi.fn(async () => recognized()),
    log: () => {},
    ...over,
  }
}

describe('SELF_SCAN_DEFAULT_INTERVAL_MS', () => {
  it('is 15 minutes — the single source of truth B2 wires the daemon loop gate off of', () => {
    expect(SELF_SCAN_DEFAULT_INTERVAL_MS).toBe(15 * 60_000)
  })
})

describe('makeSelfScan (injected listVideoFiles)', () => {
  it('new path (not in knownPaths) → recognize() called, lands in recognized bucket', async () => {
    const recognize = vi.fn(async () => recognized({ title: 'New Show' }))
    const tick = makeSelfScan(makeDeps({
      roots: ['/media'],
      listVideoFiles: () => ['/media/new.mkv'],
      knownPaths: () => new Set(),
      recognize,
    }))

    const result = await tick()

    expect(recognize).toHaveBeenCalledWith('/media/new.mkv')
    expect(result.scanned).toBe(1)
    expect(result.recognized).toEqual([{ path: '/media/new.mkv', result: recognized({ title: 'New Show' }) }])
    expect(result.parked).toEqual([])
    expect(result.skippedKnown).toBe(0)
  })

  it('known path (present in knownPaths) → recognize() NOT called, counted in skippedKnown', async () => {
    const recognize = vi.fn(async () => recognized())
    const tick = makeSelfScan(makeDeps({
      roots: ['/media'],
      listVideoFiles: () => ['/media/known.mkv'],
      knownPaths: () => new Set(['/media/known.mkv']),
      recognize,
    }))

    const result = await tick()

    expect(recognize).not.toHaveBeenCalled()
    expect(result.scanned).toBe(1)
    expect(result.skippedKnown).toBe(1)
    expect(result.recognized).toEqual([])
    expect(result.parked).toEqual([])
  })

  it('previously parked path stays out of the library → recognize() retried on the NEXT pass', async () => {
    const recognize = vi.fn(async (): Promise<Recognized | Park> => ({ park: 'no-title-signal' }))
    const known = new Set<string>() // parking never adds to knownPaths — the whole point of the design
    const tick = makeSelfScan(makeDeps({
      roots: ['/media'],
      listVideoFiles: () => ['/media/junk.mkv'],
      knownPaths: () => known,
      recognize,
    }))

    const first = await tick()
    expect(first.parked).toEqual([{ path: '/media/junk.mkv', reason: 'no-title-signal' }])
    expect(recognize).toHaveBeenCalledTimes(1)

    const second = await tick()
    expect(second.parked).toEqual([{ path: '/media/junk.mkv', reason: 'no-title-signal' }])
    expect(recognize).toHaveBeenCalledTimes(2) // retried, not remembered as "already parked"
  })

  it('recognize() throwing for one file does not kill the pass; other files still processed, thrown file lands in neither bucket, log is called', async () => {
    const recognize = vi.fn(async (path: string): Promise<Recognized | Park> => {
      if (path === '/media/flaky.mkv') throw new Error('transient TMDB blip')
      return recognized({ title: 'OK Show' })
    })
    const log = vi.fn()
    const tick = makeSelfScan(makeDeps({
      roots: ['/media'],
      listVideoFiles: () => ['/media/flaky.mkv', '/media/ok.mkv'],
      knownPaths: () => new Set(),
      recognize,
      log,
    }))

    const result = await tick()

    expect(result.scanned).toBe(2)
    expect(result.recognized).toEqual([{ path: '/media/ok.mkv', result: recognized({ title: 'OK Show' }) }])
    expect(result.parked).toEqual([])
    expect(result.skippedKnown).toBe(0)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('/media/flaky.mkv'))
  })

  it('scans across multiple roots, accumulating one SelfScanResult', async () => {
    const recognize = vi.fn(async () => recognized())
    const tick = makeSelfScan(makeDeps({
      roots: ['/media/a', '/media/b'],
      listVideoFiles: (root) => (root === '/media/a' ? ['/media/a/x.mkv'] : ['/media/b/y.mkv']),
      knownPaths: () => new Set(),
      recognize,
    }))

    const result = await tick()

    expect(result.scanned).toBe(2)
    expect(result.recognized.map(r => r.path).sort()).toEqual(['/media/a/x.mkv', '/media/b/y.mkv'])
  })
})

describe('makeSelfScan (default fs walker)', () => {
  it('recurses into real directories, filters by video extension, and excludes dot-dirs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'selfscan-'))

    // Plain video file at top level
    writeFileSync(join(root, 'movie.mkv'), '')
    // Non-video file — must be filtered out
    writeFileSync(join(root, 'notes.txt'), '')

    // Nested video file — recursion must reach it
    mkdirSync(join(root, 'Show', 'Season 01'), { recursive: true })
    writeFileSync(join(root, 'Show', 'Season 01', 'ep1.mp4'), '')

    // Dot-dir (daemon's own staging/build dirs, or any other hidden dir) must be excluded
    // entirely — including video-looking files inside it.
    mkdirSync(join(root, '.subtitle-staging', 'job1'), { recursive: true })
    writeFileSync(join(root, '.subtitle-staging', 'job1', 'ghost.mkv'), '')

    // '@eaDir'-style NAS junk dirs must also be excluded.
    mkdirSync(join(root, '@eaDir'), { recursive: true })
    writeFileSync(join(root, '@eaDir', 'thumb.mkv'), '')

    const recognize = vi.fn(async () => recognized())
    const tick = makeSelfScan(makeDeps({
      roots: [root],
      knownPaths: () => new Set(),
      recognize,
    }))

    const result = await tick()

    expect(result.scanned).toBe(2)
    const paths = result.recognized.map(r => r.path).sort()
    expect(paths).toEqual([join(root, 'Show', 'Season 01', 'ep1.mp4'), join(root, 'movie.mkv')].sort())
  })
})
