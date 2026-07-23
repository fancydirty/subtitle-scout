import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { TRANSLATE_STAGING_DIRNAME, ensureWorkspaceLayout, workspacePaths } from './paths.js'

describe('translate workspace paths', () => {
  it('workspacePaths nests job under .subtitle-translate', () => {
    const p = workspacePaths('/media', 'job-1')
    expect(p.jobRoot).toBe(join('/media', TRANSLATE_STAGING_DIRNAME, 'job-1'))
    expect(p.canonicalDir).toBe(join(p.jobRoot, 'canonical'))
    expect(p.agentViewDir).toBe(join(p.jobRoot, 'agent_view'))
    expect(p.contextDir).toBe(join(p.jobRoot, 'context'))
    expect(p.glossaryDir).toBe(join(p.jobRoot, 'glossary'))
    expect(p.workDir).toBe(join(p.jobRoot, 'work'))
    expect(p.outDir).toBe(join(p.jobRoot, 'out'))
    expect(p.metaPath).toBe(join(p.jobRoot, 'meta.json'))
    expect(p.sourceCleanPath).toBe(join(p.agentViewDir, 'source_clean.jsonl'))
    expect(p.bilingualPath).toBe(join(p.workDir, 'bilingual.jsonl'))
    expect(p.glossaryPath).toBe(join(p.glossaryDir, 'terms.json'))
    expect(p.targetSrtPath).toBe(join(p.outDir, 'target.srt'))
  })

  it('ensureWorkspaceLayout creates the full directory tree and optional .ignore', () => {
    const base = mkdtempSync(join(tmpdir(), 'tw-paths-'))
    const p = ensureWorkspaceLayout(base, 'job-abc')
    for (const dir of [p.jobRoot, p.canonicalDir, p.agentViewDir, p.contextDir, p.glossaryDir, p.workDir, p.outDir]) {
      expect(existsSync(dir)).toBe(true)
    }
    const ignore = join(base, TRANSLATE_STAGING_DIRNAME, '.ignore')
    expect(existsSync(ignore)).toBe(true)
    expect(readFileSync(ignore, 'utf8')).toMatch(/subtitle-translate/)
  })
})
