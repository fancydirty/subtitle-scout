import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { runWorkspaceTranslate } from './runWorkspaceTranslate.js'
import type { TranslationLM } from '../translatePipeline.js'
import type { SrtCue } from '../qualityGate.js'

function mockLm(): TranslationLM {
  return {
    async buildGlossary() {
      return [{ en: 'Nico', zh: '妮可' }]
    },
    async translateBatch(batch: SrtCue[]) {
      return {
        cues: batch.map((c) => ({
          ...c,
          text: c.text.map((t) => t.replace(/Nico/g, '妮可').replace(/Hello/g, '你好')),
        })),
        summary: 's',
      }
    },
  }
}

describe('runWorkspaceTranslate', () => {
  it('ja + only eng embedded → no-source without writing target', async () => {
    const base = mkdtempSync(join(tmpdir(), 'tw-run-'))
    const r = await runWorkspaceTranslate({
      stagingBase: base,
      jobId: 'j-ja',
      videoPath: '/m/x.mkv',
      originLang: 'ja',
      lm: mockLm(),
      resolveDeps: {
        probe: async () => [{ lang: 'eng', codec: 'ass', isImageBased: false }],
        extract: async () => '1\n00:00:01,000 --> 00:00:02,000\nHello Nico\n',
      },
    })
    expect(r.status).toBe('no-source')
    expect(existsSync(join(base, '.subtitle-translate', 'j-ja', 'out', 'target.srt'))).toBe(false)
  })

  it('en embedded → materialize, translate windows, merge install payload', async () => {
    const base = mkdtempSync(join(tmpdir(), 'tw-run-'))
    const srt = [
      '1',
      '00:00:01,000 --> 00:00:02,000',
      'Hello Nico',
      '',
      '2',
      '00:00:03,000 --> 00:00:04,000',
      'Bye',
      '',
    ].join('\n')
    const r = await runWorkspaceTranslate({
      stagingBase: base,
      jobId: 'j-en',
      videoPath: '/m/x.mkv',
      originLang: 'en',
      lm: mockLm(),
      resolveDeps: {
        probe: async () => [{ lang: 'eng', codec: 'subrip', isImageBased: false }],
        extract: async () => srt,
      },
      install: (content) => {
        expect(content).toContain('妮可')
        return '/m/x.zh-Hans.srt'
      },
    })
    expect(r.status).toBe('installed')
    if (r.status === 'installed') {
      expect(r.sidecarPath).toBe('/m/x.zh-Hans.srt')
      expect(r.sourceRef).toMatch(/embedded/)
    }
    const job = join(base, '.subtitle-translate', 'j-en')
    expect(readFileSync(join(job, 'glossary', 'terms.json'), 'utf8')).toMatch(/妮可/)
    expect(readFileSync(join(job, 'agent_view', 'source_clean.jsonl'), 'utf8')).toMatch(/Hello Nico/)
    const bi = readFileSync(join(job, 'work', 'bilingual.jsonl'), 'utf8')
    expect(bi).toMatch(/你好/)
  })
})
