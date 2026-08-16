import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const scriptPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../scripts/run-sandbox-library-in-orbstack.sh',
)

function withoutComments(script: string): string {
  return script
    .split('\n')
    .map((line) => (line.startsWith('#!') ? line : line.replace(/#.*$/, '')))
    .join('\n')
}

function volumeArgs(dockerBlock: string): string[] {
  const args: string[] = []
  const re = /(?:^|[\s\\])-v\s+(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(dockerBlock))) {
    args.push(m[1].replace(/^['"]|['"]$/g, ''))
  }
  return args
}

function overlaysAppNodeModules(script: string): boolean {
  const docker = script.slice(script.indexOf('docker run'))
  const vols = volumeArgs(docker)
  if (vols.includes('/app/node_modules')) return true
  if (vols.some((v) => /^(?![/$~.]).+:\/app\/node_modules$/.test(v))) return true
  return /--mount\s+\S*type=volume\S*(?:destination|dst|target)=\/app\/node_modules/.test(docker)
}

describe('OrbStack sandbox-library runner', () => {
  it('overlays /app/node_modules and installs Linux deps with npm ci, without mutating the Darwin bind mount', () => {
    const script = withoutComments(readFileSync(scriptPath, 'utf8'))

    expect(overlaysAppNodeModules(script), 'docker run must hide host node_modules with a volume overlay').toBe(true)
    expect(script).toMatch(/\bnpm ci\b/)
    expect(script).not.toMatch(/\bnpm rebuild\b/)
    expect(script).not.toMatch(/\bnpm install\b/)
    expect(script).toMatch(/npx tsx src\/cli\/index\.ts sandbox-library/)
  })
})
