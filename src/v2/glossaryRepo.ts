import type { ScoutDb } from './db.js'
import type { GlossaryTerm } from '../translate/workspace/types.js'

/** 剧级术语表持久化(P2):跨 job 继承冻结术语,消除"同剧东国/奥斯塔尼亚"式 canonical 方差。
 *  key=seriesKeyOf(itemId):episode own-id 取 series 段,movie 用自身 id。 */
export class GlossaryRepo {
  constructor(private readonly db: ScoutDb) {}

  load(seriesKey: string): GlossaryTerm[] {
    const row = this.db.prepare('SELECT terms_json FROM translate_glossaries WHERE series_key = ?')
      .get(seriesKey) as { terms_json: string } | undefined
    if (!row) return []
    try {
      const parsed = JSON.parse(row.terms_json) as unknown
      if (!Array.isArray(parsed)) return []
      return parsed.filter((t): t is GlossaryTerm =>
        !!t && typeof t === 'object' &&
        typeof (t as GlossaryTerm).src === 'string' && (t as GlossaryTerm).src.length > 0 &&
        typeof (t as GlossaryTerm).zh === 'string' && (t as GlossaryTerm).zh.length > 0)
    } catch {
      return []
    }
  }

  save(seriesKey: string, terms: GlossaryTerm[], updatedAt: number): void {
    const clean = terms.filter((t) => t && typeof t.src === 'string' && t.src && typeof t.zh === 'string' && t.zh)
    this.db.prepare(
      `INSERT INTO translate_glossaries (series_key, terms_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(series_key) DO UPDATE SET terms_json = excluded.terms_json, updated_at = excluded.updated_at`,
    ).run(seriesKey, JSON.stringify(clean), updatedAt)
  }
}

/** episode own-id('tmdb:1/s1e2') → series('tmdb:1');movie('tmdb:7')原样。 */
export function seriesKeyOf(itemId: string): string {
  const idx = itemId.indexOf('/')
  return idx > 0 ? itemId.slice(0, idx) : itemId
}
