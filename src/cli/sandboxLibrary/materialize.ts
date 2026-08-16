import { mkdirSync, openSync, closeSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Catalog, SandboxProfile } from './catalog.js'

export function materializeLibrary(catalog: Catalog, profile: SandboxProfile, root: string): string[] {
  rmSync(root, { recursive: true, force: true })
  const out: string[] = []
  for (const e of catalog.entries.filter(x => x.profile === profile)) {
    const abs = join(root, e.relPath)
    mkdirSync(dirname(abs), { recursive: true })
    closeSync(openSync(abs, 'w'))
    out.push(abs)
  }
  return out
}
