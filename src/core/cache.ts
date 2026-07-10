import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { MediaIdentity, ProviderName } from './schemas.js'

export type CacheEntry =
  | { kind: 'positive'; provider: ProviderName; providerId: string; fileIndex: number | null; confidence: number }
  | { kind: 'negative'; reason: string }

interface StoredEntry { entry: CacheEntry; expiresAt: number }

// M4 决策：字幕迟到不是没有，播放重试窗口收窄（7d→1d）
const NEGATIVE_TTL_DAYS = 1
const POSITIVE_TTL_DAYS = 365

export function cacheKeys(identity: MediaIdentity, providerIds: Record<string, string>): string[] {
  const se = `S${identity.season ?? '-'}:E${identity.episode ?? '-'}`
  const keys: string[] = []
  for (const [prov, id] of Object.entries(providerIds)) {
    keys.push(`id:${prov}:${id}:${se}`)
  }
  const t = identity.canonical_title.toLowerCase().trim()
  keys.push(`title:${t}|${identity.year ?? '-'}|${identity.type}|S${identity.season ?? '-'}|E${identity.episode ?? '-'}`)
  return keys
}

export class DecisionCache {
  constructor(private dir: string) { mkdirSync(dir, { recursive: true }) }

  private pathFor(key: string): string {
    return join(this.dir, createHash('sha1').update(key).digest('hex') + '.json')
  }

  get(key: string): CacheEntry | null {
    const p = this.pathFor(key)
    if (!existsSync(p)) return null
    const stored: StoredEntry = JSON.parse(readFileSync(p, 'utf8'))
    if (Date.now() > stored.expiresAt) return null
    // Migrate legacy entries: assrt_id → provider/providerId
    const e = stored.entry as CacheEntry & { assrt_id?: number; file_index?: number | null }
    if (e.kind === 'positive' && e.assrt_id != null && (e as { providerId?: string }).providerId == null) {
      stored.entry = { kind: 'positive', provider: 'assrt', providerId: String(e.assrt_id), fileIndex: e.file_index ?? null, confidence: e.confidence }
    }
    return stored.entry
  }

  put(keys: string[], entry: CacheEntry, ttlDays?: number) {
    const days = ttlDays ?? (entry.kind === 'negative' ? NEGATIVE_TTL_DAYS : POSITIVE_TTL_DAYS)
    const stored: StoredEntry = { entry, expiresAt: Date.now() + days * 86_400_000 }
    for (const key of keys) writeFileSync(this.pathFor(key), JSON.stringify(stored, null, 2))
  }
}
