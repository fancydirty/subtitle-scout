import { describe, expect, it } from 'vitest'
import { openDb } from './db.js'
import { GlossaryRepo, seriesKeyOf } from './glossaryRepo.js'

describe('seriesKeyOf', () => {
  it('episode own-id → series id;movie id 原样', () => {
    expect(seriesKeyOf('tmdb:261868/s1e2')).toBe('tmdb:261868')
    expect(seriesKeyOf('tmdb:1086260')).toBe('tmdb:1086260')
  })
})

describe('GlossaryRepo', () => {
  it('load 空库 → [];save → load 回读;覆盖写更新 updated_at', () => {
    const db = openDb(':memory:')
    const repo = new GlossaryRepo(db)
    expect(repo.load('tmdb:1')).toEqual([])
    repo.save('tmdb:1', [{ src: 'Nico', zh: '妮可' }], 1000)
    expect(repo.load('tmdb:1')).toEqual([{ src: 'Nico', zh: '妮可' }])
    repo.save('tmdb:1', [{ src: 'Nico', zh: '妮可' }, { src: 'Moi', zh: '莫伊' }], 2000)
    expect(repo.load('tmdb:1')).toHaveLength(2)
    const row = db.prepare('SELECT updated_at FROM translate_glossaries WHERE series_key = ?').get('tmdb:1') as { updated_at: number }
    expect(row.updated_at).toBe(2000)
    db.close()
  })

  it('save 丢非数组/缺字段条目,不炸库', () => {
    const db = openDb(':memory:')
    const repo = new GlossaryRepo(db)
    repo.save('tmdb:2', [{ src: 'A', zh: '某' }, { src: '', zh: '' } as never], 1)
    expect(repo.load('tmdb:2')).toEqual([{ src: 'A', zh: '某' }])
    db.close()
  })
})
