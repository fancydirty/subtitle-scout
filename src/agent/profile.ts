import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

export type StructuredMode = 'forced-tool' | 'forced-tool-quirk' | 'prompt-json'

export interface LlmProfile {
  mode: StructuredMode
  quirkId?: string
  extraBody?: Record<string, unknown>
  evidence: string
}

interface StoredProfile extends LlmProfile { probedAt: number; expiresAt: number }

const TTL_DAYS = 30

export class ProfileStore {
  constructor(private dir: string) { mkdirSync(dir, { recursive: true }) }

  private pathFor(baseUrl: string, model: string): string {
    const key = createHash('sha1').update(`${baseUrl}|${model}`).digest('hex')
    return join(this.dir, `${key}.json`)
  }

  get(baseUrl: string, model: string): LlmProfile | null {
    const p = this.pathFor(baseUrl, model)
    if (!existsSync(p)) return null
    try {
      const stored: StoredProfile = JSON.parse(readFileSync(p, 'utf8'))
      if (Date.now() > stored.expiresAt) return null
      const { probedAt: _p, expiresAt: _e, ...profile } = stored
      return profile
    } catch {
      return null // 损坏文件 → 视作缓存未命中
    }
  }

  put(baseUrl: string, model: string, profile: LlmProfile, ttlDays: number = TTL_DAYS) {
    const stored: StoredProfile = {
      ...profile, probedAt: Date.now(), expiresAt: Date.now() + ttlDays * 86_400_000,
    }
    const finalPath = this.pathFor(baseUrl, model)
    const tmpPath = `${finalPath}.tmp`
    writeFileSync(tmpPath, JSON.stringify(stored, null, 2))
    renameSync(tmpPath, finalPath) // 原子操作（同 fs）
  }

  invalidate(baseUrl: string, model: string) {
    rmSync(this.pathFor(baseUrl, model), { force: true })
  }
}
