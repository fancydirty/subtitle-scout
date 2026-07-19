// src/dashboard/auth.test.ts
import { describe, it, expect } from 'vitest'
import { hashPassword, verifyPassword, SessionStore, LoginThrottle, AuthService } from './auth.js'
import { openDb } from '../v2/db.js'
import { SettingsRepo } from '../v2/settingsRepo.js'

describe('hashPassword/verifyPassword（scrypt，盐:哈希 hex 格式）', () => {
  it('同一密码两次哈希产出不同串（随机盐），但都能通过校验', () => {
    const h1 = hashPassword('correct horse')
    const h2 = hashPassword('correct horse')
    expect(h1).not.toBe(h2)
    expect(h1).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/) // 16B 盐 + 64B 哈希
    expect(verifyPassword('correct horse', h1)).toBe(true)
    expect(verifyPassword('correct horse', h2)).toBe(true)
  })
  it('错误密码校验失败', () => {
    expect(verifyPassword('wrong', hashPassword('right'))).toBe(false)
  })
  it('存储串畸形（缺冒号/非 hex）→ false 而非抛错', () => {
    expect(verifyPassword('x', 'not-a-hash')).toBe(false)
    expect(verifyPassword('x', '')).toBe(false)
    expect(verifyPassword('x', 'zz:zz')).toBe(false)
  })
})

describe('SessionStore（内存 Map，30 天滚动过期）', () => {
  const NOW = 1_700_000_000_000
  const DAY = 24 * 3600 * 1000
  it('create 签发 64 hex token，verify 通过', () => {
    const s = new SessionStore()
    const t = s.create(NOW)
    expect(t).toMatch(/^[0-9a-f]{64}$/)
    expect(s.verify(t, NOW + 1000)).toBe(true)
  })
  it('过期后 verify false 且条目被清', () => {
    const s = new SessionStore()
    const t = s.create(NOW)
    expect(s.verify(t, NOW + 31 * DAY)).toBe(false)
    expect(s.verify(t, NOW + 1000)).toBe(false) // 已删，回到过期前的时刻也不行
  })
  it('滚动过期：每次 verify 续期 30 天', () => {
    const s = new SessionStore()
    const t = s.create(NOW)
    expect(s.verify(t, NOW + 29 * DAY)).toBe(true)  // 续期到 +59d
    expect(s.verify(t, NOW + 58 * DAY)).toBe(true)  // 仍活着
  })
  it('revoke 后 verify false；未知 token false', () => {
    const s = new SessionStore()
    const t = s.create(NOW)
    s.revoke(t)
    expect(s.verify(t, NOW)).toBe(false)
    expect(s.verify('deadbeef', NOW)).toBe(false)
  })
})

describe('LoginThrottle（5 次/分钟/来源，内存计数）', () => {
  const NOW = 1_700_000_000_000
  it('同一来源 60s 窗口内前 5 次放行，第 6 次拒绝', () => {
    const th = new LoginThrottle()
    for (let i = 0; i < 5; i++) expect(th.allow('1.2.3.4', NOW + i * 1000)).toBe(true)
    expect(th.allow('1.2.3.4', NOW + 5000)).toBe(false)
  })
  it('窗口滚过（61s 后）计数重置', () => {
    const th = new LoginThrottle()
    for (let i = 0; i < 6; i++) th.allow('1.2.3.4', NOW)
    expect(th.allow('1.2.3.4', NOW + 61_000)).toBe(true)
  })
  it('不同来源互不影响', () => {
    const th = new LoginThrottle()
    for (let i = 0; i < 6; i++) th.allow('1.2.3.4', NOW)
    expect(th.allow('5.6.7.8', NOW)).toBe(true)
  })
})

describe('AuthService（settings 三键：auth_username/auth_password_hash/auth_api_key）', () => {
  const NOW = 1_700_000_000_000
  function mkAuth() {
    return new AuthService(new SettingsRepo(openDb(':memory:')))
  }
  it('未初始化态：isInitialized false；setup 写三键并返回 32 hex api key', () => {
    const auth = mkAuth()
    expect(auth.isInitialized()).toBe(false)
    const r = auth.setup('admin', 'hunter2222', NOW)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.apiKey).toMatch(/^[0-9a-f]{32}$/)
    expect(auth.isInitialized()).toBe(true)
  })
  it('setup 一次性：已初始化后再 setup → ok:false', () => {
    const auth = mkAuth()
    auth.setup('admin', 'hunter2222', NOW)
    expect(auth.setup('evil', 'x'.repeat(10), NOW).ok).toBe(false)
  })
  it('setup 校验：用户名空/密码短于 8 → ok:false 且不写键', () => {
    const auth = mkAuth()
    expect(auth.setup('', 'longenough', NOW).ok).toBe(false)
    expect(auth.setup('admin', 'short', NOW).ok).toBe(false)
    expect(auth.isInitialized()).toBe(false)
  })
  it('login：对的用户名+密码 → sessionToken；错的 → status 401；节流爆表 → status 429', () => {
    const auth = mkAuth()
    auth.setup('admin', 'hunter2222', NOW)
    const ok = auth.login('admin', 'hunter2222', '1.1.1.1', NOW)
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(auth.sessions.verify(ok.sessionToken, NOW + 1)).toBe(true)
    const bad = auth.login('admin', 'wrong', '1.1.1.1', NOW)
    expect(bad).toMatchObject({ ok: false, status: 401 })
    for (let i = 0; i < 5; i++) auth.login('admin', 'wrong', '2.2.2.2', NOW)
    expect(auth.login('admin', 'hunter2222', '2.2.2.2', NOW)).toMatchObject({ ok: false, status: 429 })
  })
  it('verifyApiKey：setup 发的 key 通过；错 key/未初始化 → false', () => {
    const auth = mkAuth()
    expect(auth.verifyApiKey('anything')).toBe(false)
    const r = auth.setup('admin', 'hunter2222', NOW)
    if (!r.ok) throw new Error('setup failed')
    expect(auth.verifyApiKey(r.apiKey)).toBe(true)
    expect(auth.verifyApiKey('0'.repeat(32))).toBe(false)
  })
  it('changePassword：旧密码对才改；改后旧密码登不进、新密码能登', () => {
    const auth = mkAuth()
    auth.setup('admin', 'hunter2222', NOW)
    expect(auth.changePassword('wrong-old', 'newpass888', NOW).ok).toBe(false)
    expect(auth.changePassword('hunter2222', 'newpass888', NOW).ok).toBe(true)
    expect(auth.login('admin', 'hunter2222', '3.3.3.3', NOW).ok).toBe(false)
    expect(auth.login('admin', 'newpass888', '3.3.3.3', NOW).ok).toBe(true)
  })
  it('regenerateApiKey：换新 key，旧 key 失效；apiKeyTail 给尾 4 位', () => {
    const auth = mkAuth()
    const r = auth.setup('admin', 'hunter2222', NOW)
    if (!r.ok) throw new Error('setup failed')
    const nk = auth.regenerateApiKey(NOW)
    expect(nk).toMatch(/^[0-9a-f]{32}$/)
    expect(auth.verifyApiKey(r.apiKey)).toBe(false)
    expect(auth.verifyApiKey(nk)).toBe(true)
    expect(auth.apiKeyTail()).toBe(nk.slice(-4))
  })
})

describe('verifyApiKey 多字节边界（主控亲核补）', () => {
  it('字符串等长但字节数不等（多字节字符）→ false 而非 timingSafeEqual 抛 RangeError', () => {
    const auth = new AuthService(new SettingsRepo(openDb(':memory:')))
    const r = auth.setup('admin', 'hunter2222', 1_700_000_000_000)
    if (!r.ok) throw new Error('setup failed')
    const evil = '文'.repeat(32) // 32 字符（与 32 hex 等长），但 UTF-8 字节数 96
    expect(() => auth.verifyApiKey(evil)).not.toThrow()
    expect(auth.verifyApiKey(evil)).toBe(false)
  })
})

describe('A1 硬化（Task 14′：长度阈值 10 + setup 原子性）', () => {
  it('MIN_PASSWORD_LEN=10：9 字符拒绝，10 字符通过', () => {
    const a1 = new AuthService(new SettingsRepo(openDb(':memory:')))
    expect(a1.setup('admin', 'x'.repeat(9), 1).ok).toBe(false)
    const a2 = new AuthService(new SettingsRepo(openDb(':memory:')))
    expect(a2.setup('admin', 'x'.repeat(10), 1).ok).toBe(true)
  })
  it('changePassword 同样 10 阈值：9 字符新密码拒绝', () => {
    const auth = new AuthService(new SettingsRepo(openDb(':memory:')))
    auth.setup('admin', 'hunter2222', 1)
    expect(auth.changePassword('hunter2222', 'x'.repeat(9), 2).ok).toBe(false)
    expect(auth.changePassword('hunter2222', 'x'.repeat(10), 2).ok).toBe(true)
  })
  it('setup 原子：三键写入中途抛错→事务回滚，isInitialized 仍 false', () => {
    const db = openDb(':memory:')
    const repo = new SettingsRepo(db)
    let calls = 0
    const orig = repo.set.bind(repo)
    repo.set = (k: string, v: string, n: number) => { if (++calls === 3) throw new Error('disk full'); return orig(k, v, n) }
    const auth = new AuthService(repo)
    expect(() => auth.setup('admin', 'hunter2222', 1)).toThrow()
    // 新实例读同一 db：三键应因回滚而全不存在。
    expect(new AuthService(new SettingsRepo(db)).isInitialized()).toBe(false)
  })
})

describe('AuthService.reset（A4 Task 15：诚实找回密码的后端）', () => {
  it('reset 后回到未初始化态，旧密码/apiKey 全失效', () => {
    const auth = new AuthService(new SettingsRepo(openDb(':memory:')))
    const r = auth.setup('admin', 'hunter2222', 1)
    if (!r.ok) throw new Error('setup failed')
    expect(auth.isInitialized()).toBe(true)
    auth.reset()
    expect(auth.isInitialized()).toBe(false)
    expect(auth.verifyApiKey(r.apiKey)).toBe(false)
    expect(auth.login('admin', 'hunter2222', '1.1.1.1', 2).ok).toBe(false)
    // reset 后可重新 setup（向导重跑）
    expect(auth.setup('admin2', 'newpass8888', 3).ok).toBe(true)
  })
})
