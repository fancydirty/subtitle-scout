import { describe, it, expect } from 'vitest'
import { mkdtempSync, statSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadCatalog } from './catalog.js'
import { materializeLibrary } from './materialize.js'

const catalogPath = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/sandbox-libraries/catalog.json')

describe('materializeLibrary', () => {
  it('writes 0-byte videos for one profile and nothing else', () => {
    const catalog = loadCatalog(catalogPath)
    const root = mkdtempSync(join(tmpdir(), 'sandbox-lib-'))
    const written = materializeLibrary(catalog, 'zh-viewer', root)
    expect(written.length).toBe(catalog.entries.filter(e => e.profile === 'zh-viewer').length)
    for (const p of written) {
      expect(existsSync(p)).toBe(true)
      expect(statSync(p).size).toBe(0)
    }
    const stray = written.find(p => p.includes('哪吒之魔童降世.2019')) // en-viewer only
    expect(stray).toBeUndefined()
  })

  it('wipes leftover sidecars on rematerialize and rewrites 0-byte videos', () => {
    const catalog = loadCatalog(catalogPath)
    const root = mkdtempSync(join(tmpdir(), 'sandbox-lib-'))
    const written = materializeLibrary(catalog, 'zh-viewer', root)
    const leftover = join(root, 'Movies/Casablanca (1942)/Casablanca.1942.zh-Hans.srt')
    writeFileSync(leftover, 'fake leftover sidecar')
    expect(existsSync(leftover)).toBe(true)

    const rewritten = materializeLibrary(catalog, 'zh-viewer', root)
    expect(existsSync(leftover)).toBe(false)
    expect(rewritten.length).toBe(written.length)
    for (const p of rewritten) {
      expect(existsSync(p)).toBe(true)
      expect(statSync(p).size).toBe(0)
    }
    const stray = rewritten.find(p => p.includes('哪吒之魔童降世.2019'))
    expect(stray).toBeUndefined()
  })
})
