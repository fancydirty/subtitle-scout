// src/v2/migration.origin-lang.test.ts
// Chinese-origin detection Task 2: origin_lang 列缓存 TMDB original_language，解析一次不再回查。
import { describe, it, expect } from 'vitest'
import { openDb } from './db.js'

describe('origin_lang migration', () => {
  it('adds nullable origin_lang to movies and series', () => {
    const db = openDb(':memory:')
    const movieCols = (db.prepare('PRAGMA table_info(movies)').all() as { name: string }[]).map(c => c.name)
    const seriesCols = (db.prepare('PRAGMA table_info(series)').all() as { name: string }[]).map(c => c.name)
    expect(movieCols).toContain('origin_lang')
    expect(seriesCols).toContain('origin_lang')
    db.close()
  })
})
