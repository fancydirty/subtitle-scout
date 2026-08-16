import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { toContainerPath, toHostPath } from './hostrootPath.js'

describe('hostroot path mapping', () => {
  it('leaves paths alone when /hostroot is not mounted (source-run / old bind-mount)', () => {
    expect(toContainerPath('/mnt/media/Movies', '/no-such-hostroot')).toBe('/mnt/media/Movies')
    expect(toHostPath('/media/Movies', '/no-such-hostroot')).toBe('/media/Movies')
  })

  it('maps a host path through the compose /hostroot mount so the user never types the prefix', () => {
    const hostroot = mkdtempSync(join(tmpdir(), 'hostroot-'))
    mkdirSync(join(hostroot, 'mnt', 'nas', 'Movies'), { recursive: true })
    expect(toContainerPath('/mnt/nas/Movies', hostroot)).toBe(join(hostroot, 'mnt/nas/Movies'))
    expect(toHostPath(join(hostroot, 'mnt/nas/Movies'), hostroot)).toBe('/mnt/nas/Movies')
  })

  it('does not double-prefix a path that is already under hostroot', () => {
    const hostroot = mkdtempSync(join(tmpdir(), 'hostroot-'))
    const already = join(hostroot, 'mnt', 'nas', 'TV')
    mkdirSync(already, { recursive: true })
    expect(toContainerPath(already, hostroot)).toBe(already)
  })
})
