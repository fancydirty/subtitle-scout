import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { ensureWorkspaceLayout } from './paths.js'
import { materializeAgentView } from './materialize.js'
import type { BilingualRow, CleanCue } from './types.js'

const SAMPLE = [
  '1',
  '00:00:01,000 --> 00:00:02,000',
  '{\\an8}Hello <i>Nico</i>',
  '',
  '2',
  '00:00:03,000 --> 00:00:04,000',
  'Second line',
  '',
].join('\n')

describe('materializeAgentView', () => {
  it('writes clean jsonl without timing and strips ASS overrides; inits bilingual pending', () => {
    const base = mkdtempSync(join(tmpdir(), 'tw-mat-'))
    const paths = ensureWorkspaceLayout(base, 'j1')
    const { cues, rows } = materializeAgentView(paths, SAMPLE)
    expect(cues).toHaveLength(2)
    expect(cues[0]).toMatchObject({ id: '1', text: 'Hello <i>Nico</i>' })
    expect(cues[0].text).not.toContain('\\an8')
    expect(cues[1]).toEqual({ id: '2', text: 'Second line' })

    const cleanLines = readFileSync(paths.sourceCleanPath, 'utf8').trim().split('\n')
    const parsed = cleanLines.map((l) => JSON.parse(l) as CleanCue)
    expect(parsed[0].text).toBe('Hello <i>Nico</i>')
    expect(JSON.stringify(parsed[0])).not.toMatch(/-->/)

    const bi = readFileSync(paths.bilingualPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as BilingualRow)
    expect(bi).toEqual([
      { id: '1', src: 'Hello <i>Nico</i>', tgt: '', status: 'pending' },
      { id: '2', src: 'Second line', tgt: '', status: 'pending' },
    ])
    expect(rows).toEqual(bi)
  })
})
