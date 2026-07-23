import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { ensureWorkspaceLayout } from './paths.js'
import { materializeAgentView } from './materialize.js'
import { mergeBilingualToSrt } from './merge.js'
import type { BilingualRow } from './types.js'
import { parseSrtCues } from '../qualityGate.js'

const SAMPLE = [
  '1',
  '00:00:01,000 --> 00:00:02,000',
  'Hello',
  '',
  '2',
  '00:00:03,000 --> 00:00:04,500',
  'World',
  '',
].join('\n')

describe('mergeBilingualToSrt', () => {
  it('preserves canonical timing and applies tgt text', () => {
    const base = mkdtempSync(join(tmpdir(), 'tw-merge-'))
    const paths = ensureWorkspaceLayout(base, 'j1')
    materializeAgentView(paths, SAMPLE)
    const rows: BilingualRow[] = [
      { id: '1', src: 'Hello', tgt: '你好', status: 'ok' },
      { id: '2', src: 'World', tgt: '世界', status: 'ok' },
    ]
    writeFileSync(paths.bilingualPath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
    const srt = mergeBilingualToSrt(paths)
    const cues = parseSrtCues(srt)
    expect(cues).toHaveLength(2)
    expect(cues[0].timing).toBe('00:00:01,000 --> 00:00:02,000')
    expect(cues[0].text).toEqual(['你好'])
    expect(cues[1].timing).toBe('00:00:03,000 --> 00:00:04,500')
    expect(cues[1].text).toEqual(['世界'])
  })

  it('fails closed when any row lacks tgt', () => {
    const base = mkdtempSync(join(tmpdir(), 'tw-merge-'))
    const paths = ensureWorkspaceLayout(base, 'j2')
    materializeAgentView(paths, SAMPLE)
    expect(() => mergeBilingualToSrt(paths)).toThrow(/empty tgt|pending/i)
  })
})
