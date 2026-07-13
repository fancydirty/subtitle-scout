import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeFileResultSetStore } from './resultHandles.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'scout-resultsets-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('makeFileResultSetStore', () => {
  it('creates a result set and returns its count', () => {
    const store = makeFileResultSetStore(dir)
    const id = store.create([{ a: 1 }, { a: 2 }, { a: 3 }])
    expect(store.count(id)).toBe(3)
  })

  it('lists a page with offset/limit', () => {
    const store = makeFileResultSetStore(dir)
    const id = store.create([{ a: 1 }, { a: 2 }, { a: 3 }, { a: 4 }])
    expect(store.list(id, 1, 2)).toEqual([{ a: 2 }, { a: 3 }])
  })

  it('gets a single item by index, or null when out of range', () => {
    const store = makeFileResultSetStore(dir)
    const id = store.create([{ a: 1 }, { a: 2 }])
    expect(store.get(id, 1)).toEqual({ a: 2 })
    expect(store.get(id, 5)).toBeNull()
  })

  it('throws a clear error for an unknown result set id', () => {
    const store = makeFileResultSetStore(dir)
    expect(() => store.count('does-not-exist')).toThrow(/unknown result set/)
  })

  it('two result sets in the same store are independent', () => {
    const store = makeFileResultSetStore(dir)
    const id1 = store.create([{ a: 1 }])
    const id2 = store.create([{ a: 2 }, { a: 3 }])
    expect(store.count(id1)).toBe(1)
    expect(store.count(id2)).toBe(2)
  })
})
