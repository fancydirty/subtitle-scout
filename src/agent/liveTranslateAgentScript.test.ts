import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('live translate acceptance task', () => {
  it('keeps the live script aligned with the worker contract', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
    const script = readFileSync(join(root, 'scripts/live-translate-agent.ts'), 'utf8')
    expect(script).toMatch(/targetLanguage:\s*'zh'/)
    expect(script).toMatch(/readExistingSidecar:/)
  })
})
