import { describe, it, expect, vi } from 'vitest'
import { existsSync, mkdtempSync, writeFileSync, closeSync, openSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadCatalog, CONTROL_MATRIX_TMDB, CONTROL_NEZHA_TMDB, filterCatalogByIds, type CatalogEntry } from './catalog.js'
import { materializeLibrary } from './materialize.js'
import { evaluateFindCell, evaluateSkipCell, countSidecarCues } from './report.js'
import {
  missingLiveEnv,
  sandboxCacheDir,
  sandboxDbPath,
  collectEntryFacts,
  countSubtitleWorkerRuns,
} from './run.js'
import { openDb } from '../../v2/db.js'
import { SettingsRepo } from '../../v2/settingsRepo.js'
import { ScoutDaemonV2 } from '../../v2/daemonV2.js'
import { titleFromDir } from '../../v2/identify.js'
import { deriveWorkDir } from '../../v2/scanner.js'
import { findExternalSidecar } from '../../files/sidecar.js'
import { tagsForLanguage } from '../../agent/languages.js'
import type { FindSubtitleTask } from '../../agent/findSubtitleWorker.schemas.js'

const catalogPath = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/sandbox-libraries/catalog.json')

function twelveCueSrt(): string {
  const blocks: string[] = []
  for (let i = 1; i <= 12; i++) {
    const s = String(i).padStart(2, '0')
    blocks.push(`${i}\n00:00:${s},000 --> 00:00:${s},500\ncue ${i}\n`)
  }
  return blocks.join('\n')
}

function entryAbs(root: string, entry: CatalogEntry): string {
  return join(root, entry.relPath)
}

function makeIdentifyStub(root: string, entries: CatalogEntry[]) {
  const byWorkDir = new Map<string, CatalogEntry>()
  for (const e of entries) {
    const abs = entryAbs(root, e)
    const wd = deriveWorkDir(abs, [root])
    byWorkDir.set(wd, e)
  }
  const byTmdb = new Map(entries.map(e => [String(e.tmdbId), e]))

  const runIdentify = async (_deps: unknown, facts: { workDir: string; dirName: string }) => {
    const entry = byWorkDir.get(facts.workDir)
      ?? [...byWorkDir.entries()].find(([wd]) => facts.workDir === wd || facts.workDir.startsWith(wd + '/'))?.[1]
    if (!entry) return { tmdbId: null, title: null, reason: 'stub-miss' }
    return {
      tmdbId: String(entry.tmdbId),
      title: titleFromDir(facts.dirName),
      reason: 'stub',
    }
  }

  const getDetails = async (_mt: string, id: string) => {
    const entry = byTmdb.get(String(id))
    if (!entry) return null
    const abs = join(root, entry.relPath)
    const wd = deriveWorkDir(abs, [root])
    const title = titleFromDir(basename(wd))
    return {
      id: Number(id),
      title,
      originalTitle: title,
      year: entry.year,
      overview: null,
      posterPath: null,
      genreIds: null,
      originLanguage: entry.expectedOriginLang,
      chineseTitles: [] as string[],
    }
  }

  return { runIdentify, getDetails }
}

function makeSubtitleStub(targetLanguage: 'zh' | 'en', runsByPath: Map<string, number>) {
  const tag = targetLanguage === 'zh' ? 'zh-Hans' : 'en'
  return async (task: FindSubtitleTask) => {
    const installed = []
    for (const t of task.targets) {
      runsByPath.set(t.videoPath, (runsByPath.get(t.videoPath) ?? 0) + 1)
      const stem = basename(t.videoPath).replace(/\.[^.]+$/, '')
      const sidecar = join(dirname(t.videoPath), `${stem}.${tag}.srt`)
      writeFileSync(sidecar, twelveCueSrt())
      installed.push({
        itemId: t.itemId,
        installedPath: sidecar,
        installedLanguage: tag,
        candidateProvider: 'stub',
        candidateProviderId: 'stub',
        reason: 'stub',
      })
    }
    return { installed, no_safe_match: [], retry_later: [], hardsub_assumed: [] }
  }
}

async function runMechanicalProfile(profile: 'zh-viewer' | 'en-viewer') {
  const catalog = loadCatalog(catalogPath)
  const entries = catalog.entries.filter(e => e.profile === profile)
  const root = mkdtempSync(join(tmpdir(), `sandbox-${profile}-`))
  materializeLibrary(catalog, profile, root)
  const cacheDir = mkdtempSync(join(tmpdir(), `sandbox-cache-${profile}-`))
  const dbPath = sandboxDbPath(cacheDir)
  expect(dbPath.startsWith(tmpdir()) || dbPath.includes('/var/folders/') || dbPath.includes('/tmp')).toBe(true)
  expect(dbPath).not.toBe(join(homedir(), '.subtitle-scout', 'cache', 'scout.db'))

  process.env.SUBTITLE_SCOUT_CACHE_DIR = cacheDir
  const db = openDb(dbPath)
  const now = Date.now()
  const settings = new SettingsRepo(db)
  const targetLanguage = profile === 'zh-viewer' ? 'zh' as const : 'en' as const
  settings.set('target_languages', targetLanguage, now)
  settings.set('engine_enabled', 'true', now)
  const add = settings.addRoot(root, now)
  expect(add.ok).toBe(true)

  const { runIdentify, getDetails } = makeIdentifyStub(root, entries)
  const runsByPath = new Map<string, number>()
  const subtitleWorker = makeSubtitleStub(targetLanguage, runsByPath)

  const daemon = new ScoutDaemonV2({
    db,
    roots: [root],
    rootsProvider: () => [root],
    targetLanguage,
    probe: async () => null,
    probeDuration: async () => null,
    sleep: async () => {},
    emit: () => {},
    log: () => {},
    translateEnabled: () => false,
    workPermitted: () => true,
    writableRoots: new Map([[root, true]]),
    identify: {
      db,
      runIdentify: runIdentify as any,
      worker: {
        model: {} as any,
        tmdb: { search: async () => [], getDetails },
      },
    },
    subtitleWorker: subtitleWorker as any,
    now: () => Date.now(),
  } as any)

  await daemon.inspectOnce(new AbortController().signal)

  const results = []
  for (const entry of entries) {
    const facts = collectEntryFacts(db, root, entry, targetLanguage, runsByPath)
    const cell = entry.role === 'find'
      ? evaluateFindCell({
          expectedTmdbId: entry.tmdbId,
          actualTmdbId: facts.actualTmdbId,
          skipReason: facts.skipReason,
          needsSubtitle: facts.needsSubtitle,
          subStatus: facts.subStatus,
          sidecarTags: facts.sidecarTags,
          cueCount: facts.cueCount,
          findSubtitleRuns: facts.findSubtitleRuns,
          targetLanguage,
        })
      : evaluateSkipCell({
          skipReason: facts.skipReason,
          needsSubtitle: facts.needsSubtitle,
          findSubtitleRuns: facts.findSubtitleRuns,
          sidecarTags: facts.sidecarTags,
        })
    results.push({ entry, facts, cell })
  }

  db.close()
  return { results, runsByPath, root }
}

describe('countSubtitleWorkerRuns', () => {
  it('increments per videoPath and forwards to the inner worker once', async () => {
    const map = new Map<string, number>()
    const inner = vi.fn(async (_task: FindSubtitleTask) => ({
      installed: [], no_safe_match: [], retry_later: [], hardsub_assumed: [], identity: null,
    }))
    const wrapped = countSubtitleWorkerRuns(inner as any, map)
    const task = {
      targets: [
        { videoPath: '/media/a.mkv' },
        { videoPath: '/media/b.mkv' },
      ],
    } as FindSubtitleTask
    await wrapped(task)
    expect(map.get('/media/a.mkv')).toBe(1)
    expect(map.get('/media/b.mkv')).toBe(1)
    expect(inner).toHaveBeenCalledTimes(1)
    expect(inner).toHaveBeenCalledWith(task)
  })
})

describe('collectEntryFacts · wrong-language sidecar', () => {
  it('feeds zh-Hans into sidecarTags for en target so evaluateFindCell is FAIL-PIPE', () => {
    const root = mkdtempSync(join(tmpdir(), 'sandbox-wrong-lang-'))
    const video = join(root, 'Video.mkv')
    closeSync(openSync(video, 'w'))
    writeFileSync(join(root, 'Video.zh-Hans.srt'), twelveCueSrt())

    const db = openDb(':memory:')
    const now = Date.now()
    db.prepare(
      `INSERT INTO files (path, dir, filename, size, mtime, work_dir, work_id, needs_subtitle, updated_at)
       VALUES (?, ?, 'Video.mkv', 0, ?, ?, 'tmdb:615453', 1, ?)`,
    ).run(video, root, now, root, now)

    const entry = {
      id: 'wrong-lang',
      profile: 'en-viewer' as const,
      role: 'find' as const,
      relPath: 'Video.mkv',
      tmdbKind: 'movie' as const,
      tmdbId: 615453,
      year: 2019,
      region: 'cn' as const,
      format: 'movie' as const,
      animation: true,
      expectedOriginLang: 'zh',
    }
    const facts = collectEntryFacts(db, root, entry, 'en', new Map())
    expect(facts.sidecarTags).toContain('zh-Hans')
    expect(facts.cueCount).toBeGreaterThan(10)
    expect(evaluateFindCell({
      expectedTmdbId: 615453,
      actualTmdbId: facts.actualTmdbId,
      skipReason: facts.skipReason,
      needsSubtitle: facts.needsSubtitle,
      subStatus: facts.subStatus,
      sidecarTags: facts.sidecarTags,
      cueCount: facts.cueCount,
      findSubtitleRuns: facts.findSubtitleRuns,
      targetLanguage: 'en',
    }).verdict).toBe('FAIL-PIPE')
    db.close()
  })
})

describe('materializeLibrary with --ids filter', () => {
  it('creates only casablanca and oppenheimer paths for zh-viewer', () => {
    const catalog = loadCatalog(catalogPath)
    const filtered = filterCatalogByIds(catalog, ['casablanca', 'oppenheimer'])
    const root = mkdtempSync(join(tmpdir(), 'sandbox-ids-'))
    materializeLibrary(filtered, 'zh-viewer', root)

    const kept = filtered.entries.filter(e => e.profile === 'zh-viewer')
    expect(kept.map(e => e.id).sort()).toEqual(['casablanca', 'oppenheimer'])
    for (const entry of kept) {
      expect(existsSync(join(root, entry.relPath))).toBe(true)
    }

    const other = catalog.entries.find(e => e.profile === 'zh-viewer' && e.id === 'matrix')
    expect(other).toBeDefined()
    expect(existsSync(join(root, other!.relPath))).toBe(false)
  })
})

describe('sandbox-library --ids CLI wiring', () => {
  it('parses --ids and filters catalog after loadCatalog', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'run.ts'), 'utf8')
    expect(src).toMatch(/ids:\s*\{\s*type:\s*'string'\s*\}/)
    expect(src).toMatch(/parseSandboxIds/)
    expect(src).toMatch(/filterCatalogByIds/)
  })
})

describe('sandboxCacheDir / missingLiveEnv', () => {
  it('sandboxCacheDir defaults under os.tmpdir, never homedir cache', () => {
    const d = sandboxCacheDir()
    expect(d.includes('.subtitle-scout')).toBe(false)
    expect(d.startsWith(tmpdir()) || d.includes('/var/folders/') || d.includes('/tmp')).toBe(true)
    expect(sandboxDbPath(d)).toBe(join(d, 'scout.db'))
    expect(sandboxDbPath(d)).not.toBe(join(homedir(), '.subtitle-scout', 'cache', 'scout.db'))
  })

  it('missingLiveEnv lists required keys', () => {
    const missing = missingLiveEnv({})
    expect(missing).toEqual(expect.arrayContaining([
      'TMDB_API_KEY', 'LLM_API_KEY', 'LLM_BASE_URL', 'LLM_MODEL',
    ]))
    expect(missing.some(k => k.includes('ASSRT') || k.includes('OPENSUBTITLES'))).toBe(true)
  })

  it('missingLiveEnv empty when TMDB+LLM+ASSRT present', () => {
    expect(missingLiveEnv({
      TMDB_API_KEY: 't',
      LLM_API_KEY: 'k',
      LLM_BASE_URL: 'http://x',
      LLM_MODEL: 'm',
      ASSRT_TOKEN: 'a',
    })).toEqual([])
  })

  it('missingLiveEnv accepts r3sub email+password as the subtitle source', () => {
    expect(missingLiveEnv({
      TMDB_API_KEY: 't',
      LLM_API_KEY: 'k',
      LLM_BASE_URL: 'http://x',
      LLM_MODEL: 'm',
      R3SUB_EMAIL: 'e@x',
      R3SUB_PASSWORD: 'p',
    })).toEqual([])
  })

  it('missingLiveEnv accepts SUBDL_API_KEY as the subtitle source', () => {
    expect(missingLiveEnv({
      TMDB_API_KEY: 't',
      LLM_API_KEY: 'k',
      LLM_BASE_URL: 'http://x',
      LLM_MODEL: 'm',
      SUBDL_API_KEY: 's',
    })).toEqual([])
  })

  it('missingLiveEnv: r3sub email without password does not count as a source', () => {
    const missing = missingLiveEnv({
      TMDB_API_KEY: 't',
      LLM_API_KEY: 'k',
      LLM_BASE_URL: 'http://x',
      LLM_MODEL: 'm',
      R3SUB_EMAIL: 'e@x',
    })
    expect(missing).toHaveLength(1)
    expect(missing[0]).toContain('R3SUB_EMAIL+PASSWORD')
    expect(missing[0]).toContain('SUBDL_API_KEY')
  })

  it('live workers inject r3subClient into makeFindSubtitleWorker (r3sub download bypass)', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'run.ts'), 'utf8')
    expect(src).toMatch(/buildR3subClient\(cfg\)/)
    expect(src).toMatch(/makeFindSubtitleWorker\(\{[^}]*r3subClient[^}]*\}\)/)
  })
})

describe('mechanical inspectOnce zh-viewer', () => {
  it('every find PASS and every origin-skip PASS; skip paths have 0 subtitle runs', async () => {
    const { results } = await runMechanicalProfile('zh-viewer')
    const fails = results.filter(r => r.cell.verdict !== 'PASS')
    if (fails.length > 0) {
      const detail = fails.map(f =>
        `${f.entry.id} ${f.cell.verdict}: ${f.cell.detail} | tmdb=${f.facts.actualTmdbId} skip=${f.facts.skipReason} needs=${f.facts.needsSubtitle} runs=${f.facts.findSubtitleRuns} tags=${f.facts.sidecarTags.join(',')} cues=${f.facts.cueCount} err=${f.facts.lastError}`,
      ).join('\n')
      expect(fails, detail).toEqual([])
    }
    for (const r of results.filter(x => x.entry.role === 'origin-skip')) {
      expect(r.facts.findSubtitleRuns).toBe(0)
    }
  }, 120_000)
})

describe('mechanical inspectOnce en-viewer', () => {
  it('Nezha is FIND with .en.srt; Matrix is origin-skip with 0 subtitle worker calls', async () => {
    const { results, root } = await runMechanicalProfile('en-viewer')
    const nezha = results.find(r => r.entry.tmdbId === CONTROL_NEZHA_TMDB)
    const matrix = results.find(r => r.entry.tmdbId === CONTROL_MATRIX_TMDB && r.entry.role === 'origin-skip')
    expect(nezha).toBeDefined()
    expect(matrix).toBeDefined()
    expect(nezha!.cell.verdict).toBe('PASS')
    expect(nezha!.facts.sidecarTags.some(t => tagsForLanguage('en').includes(t))).toBe(true)
    const nezhaVideo = join(root, nezha!.entry.relPath)
    const side = findExternalSidecar(nezhaVideo, tagsForLanguage('en'), existsSync)
    expect(side?.path.endsWith('.en.srt')).toBe(true)
    expect(countSidecarCues(side!.path)).toBeGreaterThan(10)

    expect(matrix!.cell.verdict).toBe('PASS')
    expect(matrix!.facts.findSubtitleRuns).toBe(0)

    const fails = results.filter(r => r.cell.verdict !== 'PASS')
    if (fails.length > 0) {
      const detail = fails.map(f =>
        `${f.entry.id} ${f.cell.verdict}: ${f.cell.detail} | tmdb=${f.facts.actualTmdbId} skip=${f.facts.skipReason} needs=${f.facts.needsSubtitle} runs=${f.facts.findSubtitleRuns} tags=${f.facts.sidecarTags.join(',')} cues=${f.facts.cueCount} err=${f.facts.lastError}`,
      ).join('\n')
      expect(fails, detail).toEqual([])
    }
  }, 120_000)
})
