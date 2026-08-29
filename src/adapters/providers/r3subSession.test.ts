import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { R3subSessionStore } from './r3subSession.js'

describe('R3subSessionStore（登录 cookie 磁盘缓存，照 zimukuSession 复刻）', () => {
  it('put → get 往返', () => {
    const dir = mkdtempSync(join(tmpdir(), 'r3sub-sess-'))
    const store = new R3subSessionStore(dir)
    expect(store.get()).toBeNull()
    store.put({ cookie: 'PHPSESSID=abc; R3_Vid=1087', capturedAt: 123 })
    expect(store.get()).toEqual({ cookie: 'PHPSESSID=abc; R3_Vid=1087', capturedAt: 123 })
  })

  it('invalidate 后 get 返回 null', () => {
    const dir = mkdtempSync(join(tmpdir(), 'r3sub-sess-'))
    const store = new R3subSessionStore(dir)
    store.put({ cookie: 'x', capturedAt: 1 })
    store.invalidate()
    expect(store.get()).toBeNull()
  })

  it('损坏文件 → get 返回 null（视作未命中，不抛）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'r3sub-sess-'))
    const store = new R3subSessionStore(dir)
    // 直接写坏 json
    writeFileSync(join(dir, 'session.json'), '{not json')
    expect(store.get()).toBeNull()
  })
})
