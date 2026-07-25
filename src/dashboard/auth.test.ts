// src/dashboard/auth.test.ts
import { describe, it, expect, vi } from 'vitest'
import { hashPassword, verifyPassword, SessionStore, LoginThrottle, AuthService } from './auth.js'
import { openDb } from '../v2/db.js'
import { SettingsRepo } from '../v2/settingsRepo.js'

describe('hashPassword/verifyPassword（scrypt，盐:哈希 hex 格式）', { timeout: 30_000 }, () => {
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

describe('LoginThrottle（5 次失败/分钟/来源，只计失败——审计 #3）', () => {
  const NOW = 1_700_000_000_000
  it('同一来源记 5 次失败后 check 变 false（第 6 次被拒）', () => {
    const th = new LoginThrottle()
    for (let i = 0; i < 5; i++) {
      expect(th.check('1.2.3.4', NOW + i * 1000)).toBe(true)
      th.recordFailure('1.2.3.4', NOW + i * 1000)
    }
    expect(th.check('1.2.3.4', NOW + 5000)).toBe(false)
  })
  it('窗口滚过（61s 后）计数重置', () => {
    const th = new LoginThrottle()
    for (let i = 0; i < 6; i++) th.recordFailure('1.2.3.4', NOW)
    expect(th.check('1.2.3.4', NOW + 61_000)).toBe(true)
  })
  it('不同来源互不影响', () => {
    const th = new LoginThrottle()
    for (let i = 0; i < 6; i++) th.recordFailure('1.2.3.4', NOW)
    expect(th.check('5.6.7.8', NOW)).toBe(true)
  })
  it('check 不自增：连查 100 次不计入预算', () => {
    const th = new LoginThrottle()
    for (let i = 0; i < 100; i++) expect(th.check('1.2.3.4', NOW)).toBe(true)
  })
})

// 审计三轮 R3：IPv6 归一是这个限流的核心防线——攻击者在同一 /64 内有 2^64 个地址可轮换，
// 不归一等于没有限流。这一组把"同一 /64 必须共享计数"和"变体写法必须落同一桶"锁死。
describe('LoginThrottle IPv6 /64 归一（防地址轮换绕过）', () => {
  const NOW = 1_700_000_000_000
  const exhaust = (th: LoginThrottle, key: string) => {
    for (let i = 0; i < 5; i++) th.recordFailure(key, NOW)
  }

  it('同一 /64 内的不同地址共享计数（压缩短形式也必须归一）', () => {
    const th = new LoginThrottle()
    exhaust(th, '2001:db8::1')
    // 同 /64 的另一个地址：必须已被限流（否则轮换即绕过）
    expect(th.check('2001:db8::2', NOW)).toBe(false)
    expect(th.check('2001:db8::dead:beef:cafe:1', NOW)).toBe(false)
  })

  it('大小写与前导零变体落进同一桶（0DB8 / 0db8 / db8 是同一个 /64）', () => {
    const th = new LoginThrottle()
    exhaust(th, '2001:0DB8::1')
    expect(th.check('2001:db8::9', NOW)).toBe(false)
    expect(th.check('2001:0db8:0000:0000:0000:0000:0000:0009', NOW)).toBe(false)
  })

  it('不同 /64 互不影响（不误伤邻居）', () => {
    const th = new LoginThrottle()
    exhaust(th, '2001:db8:1111:2222::1')
    expect(th.check('2001:db8:1111:3333::1', NOW)).toBe(true)
    // 中间压缩形式不得错位成别人的前缀
    expect(th.check('2001:db8::cccc:dddd:eeee:ffff', NOW)).toBe(true)
  })

  it('IPv4-mapped（::ffff:1.2.3.4）与裸 IPv4 落同一桶（dual-stack 同一客户端）', () => {
    const th = new LoginThrottle()
    exhaust(th, '::ffff:1.2.3.4')
    expect(th.check('1.2.3.4', NOW)).toBe(false)
    expect(th.check('1.2.3.5', NOW)).toBe(true)
  })

  it('畸形串不抛错（段数超 8 的 Array(负数) 曾会 RangeError）', () => {
    const th = new LoginThrottle()
    for (const bad of ['1:2:3:4:5:6:7:8:9::', '::a::b', 'not-an-ip', '', 'localhost:8099']) {
      expect(() => th.recordFailure(bad, NOW)).not.toThrow()
      expect(() => th.check(bad, NOW)).not.toThrow()
    }
  })

  it('::1 本机地址稳定归一（同一 key 反复命中同一桶）', () => {
    const th = new LoginThrottle()
    exhaust(th, '::1')
    expect(th.check('::1', NOW)).toBe(false)
    expect(th.check('0:0:0:0:0:0:0:1', NOW)).toBe(false)
  })

  it('窗口过期条目被惰性清扫（防 Map 无界增长）', () => {
    const th = new LoginThrottle()
    for (let i = 0; i < 50; i++) th.recordFailure(`2001:db8:${i.toString(16)}::1`, NOW)
    // 窗口滚过后再记一次：sweep 应清掉全部过期条目，旧 key 回到放行态
    th.recordFailure('2001:db8:ffff::1', NOW + 61_000)
    expect(th.check('2001:db8:0::1', NOW + 61_000)).toBe(true)
  })
})

// 审计三轮 R3：这一组每个用例都要跑数次 scrypt（KEY_BYTES=64，设计上就慢），全量并发下
// 与其他测试文件抢 CPU 会突破 vitest 默认 5s 超时（实测偶发 6s+ 失败，单文件跑恒过）。
// 显式放宽到 30s：这不是掩盖慢，而是承认"密码哈希本该慢"这一安全属性与默认超时的冲突。
describe('login 只对失败计入节流（审计 #3：成功登录不消耗预算）', { timeout: 30_000 }, () => {
  const NOW = 1_700_000_000_000
  it('连续 10 次成功登录全部放行——成功不消耗节流预算', () => {
    const auth = new AuthService(new SettingsRepo(openDb(':memory:')))
    auth.setup('admin', 'hunter2222', NOW)
    for (let i = 0; i < 10; i++) expect(auth.login('admin', 'hunter2222', '1.1.1.1', NOW).ok).toBe(true)
  })
  it('4 次失败后穿插成功，成功不加计数——之后还能再失败 1 次才触顶', () => {
    const auth = new AuthService(new SettingsRepo(openDb(':memory:')))
    auth.setup('admin', 'hunter2222', NOW)
    for (let i = 0; i < 4; i++) auth.login('admin', 'wrong', '2.2.2.2', NOW)
    expect(auth.login('admin', 'hunter2222', '2.2.2.2', NOW).ok).toBe(true) // 成功不计
    expect(auth.login('admin', 'wrong', '2.2.2.2', NOW)).toMatchObject({ ok: false, status: 401 }) // 第 5 次失败
    expect(auth.login('admin', 'hunter2222', '2.2.2.2', NOW)).toMatchObject({ ok: false, status: 429 }) // 触顶
  })

  // R6-2 修复：login 时序侧信道——username !== storedUser 短路时不跑 scrypt（0 次 vs 1 次），
  // R5-10 加的 hashPassword(password) 只是给两条路径各加一次（1 次 vs 2 次），差值同形平移。
  // 正确做法：无条件 verifyPassword（恒跑），再用非短路方式合并结果。
  // R8-3 修复：这两条测试此前是假测试——短路版本下 throttle 计数一样（两条路径都记录失败），
  // 无法区分。改为 scrypt 调用计数断言：用户名错和用户名对时的 scrypt 次数必须一致（各 1 次）。
  // 注：vi.mock 拦截 node:crypto 的 scryptSync（auth.ts 用命名导入，spy crypto.scryptSync 无效）。
  it('用户名错和用户名对时的 scrypt 次数一致（时序侧信道修复）', async () => {
    // 只包 scryptSync 计数，randomBytes/timingSafeEqual 保持真实实现——整体替换 node:crypto 会让
    // timingSafeEqual 恒真，连用户名比对都变假，测出来的次数就没有意义了。
    let scryptCalls = 0
    vi.doMock('node:crypto', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:crypto')>()
      return {
        ...actual,
        scryptSync: (...args: Parameters<typeof actual.scryptSync>) => {
          scryptCalls++
          return actual.scryptSync(...args)
        },
      }
    })
    vi.resetModules()
    const { AuthService: FreshAuthService } = await import('./auth.js')
    const auth = new FreshAuthService(new SettingsRepo(openDb(':memory:')))
    auth.setup('admin', 'hunter2222', NOW) // setup 自己也会跑 scrypt，从这里开始计数

    scryptCalls = 0
    auth.login('wronguser', 'wrong', '1.1.1.1', NOW)
    const wrongUserCalls = scryptCalls // 用户名错：verifyPassword 恒跑 → 1 次

    scryptCalls = 0
    auth.login('admin', 'wrong', '1.1.1.1', NOW)
    const wrongPasswordCalls = scryptCalls // 用户名对密码错：同样 1 次

    // 关键断言：两条失败路径的 scrypt 工作量必须相同（短路版本会是 0 vs 1）
    expect(wrongUserCalls).toBe(1)
    expect(wrongPasswordCalls).toBe(1)

    vi.doUnmock('node:crypto')
    vi.resetModules()
  })
})

describe('AuthService（settings 三键：auth_username/auth_password_hash/auth_api_key）', { timeout: 30_000 }, () => {
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

describe('A1 硬化（Task 14′：长度阈值 10 + setup 原子性）', { timeout: 30_000 }, () => {
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

describe('AuthService.reset（A4 Task 15：诚实找回密码的后端）', { timeout: 30_000 }, () => {
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

describe('改密撤销现有会话（审计 MEDIUM #1：凭据轮换必须让被盗会话失效）', { timeout: 30_000 }, () => {
  const NOW = 1_700_000_000_000
  it('changePassword 成功后，此前签发的所有会话 token 全部失效', () => {
    const auth = new AuthService(new SettingsRepo(openDb(':memory:')))
    auth.setup('admin', 'hunter2222', NOW)
    const s1 = auth.sessions.create(NOW)
    const s2 = auth.sessions.create(NOW)
    expect(auth.sessions.verify(s1, NOW + 1)).toBe(true)
    expect(auth.sessions.verify(s2, NOW + 1)).toBe(true)
    expect(auth.changePassword('hunter2222', 'newpass8888', NOW + 2).ok).toBe(true)
    expect(auth.sessions.verify(s1, NOW + 3)).toBe(false)
    expect(auth.sessions.verify(s2, NOW + 3)).toBe(false)
  })
  it('changePassword 失败（旧密码错）不动会话', () => {
    const auth = new AuthService(new SettingsRepo(openDb(':memory:')))
    auth.setup('admin', 'hunter2222', NOW)
    const s1 = auth.sessions.create(NOW)
    expect(auth.changePassword('wrong', 'newpass8888', NOW + 2).ok).toBe(false)
    expect(auth.sessions.verify(s1, NOW + 3)).toBe(true) // 没成功就不撤销
  })
  it('SessionStore.clear 清空全部会话', () => {
    const s = new SessionStore()
    const a = s.create(NOW), b = s.create(NOW)
    s.clear()
    expect(s.verify(a, NOW + 1)).toBe(false)
    expect(s.verify(b, NOW + 1)).toBe(false)
  })
})
