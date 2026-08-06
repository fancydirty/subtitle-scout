// src/dashboard/auth.ts
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto'
import type { SettingsRepo } from '../v2/settingsRepo.js'

/** 鉴权战役 A1（spec 2026-07-17）：单管理员凭据的纯逻辑层——哈希/会话/限流/服务编排全在
 *  这里，server.ts 只做 HTTP 接线。零新依赖（node:crypto scrypt）。 */

const SALT_BYTES = 16
const KEY_BYTES = 64

export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_BYTES)
  const hash = scryptSync(password, salt, KEY_BYTES)
  return `${salt.toString('hex')}:${hash.toString('hex')}`
}

/** 常量时间字符串比较：先按**字节**长度守卫（多字节字符可使字符串等长而 Buffer 不等长，
 *  直接 timingSafeEqual 会抛 RangeError），等长才 timingSafeEqual。凭据比较（api key / legacy
 *  token）统一走这里，避免 `===` 的首字节短路时序侧信道（审计 #4）。 */
export function safeStrEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

/** 畸形存储串（缺冒号/非 hex/长度不符）一律 false——绝不抛错炸到 server.ts。 */
export function verifyPassword(password: string, stored: string): boolean {
  const idx = stored.indexOf(':')
  if (idx <= 0) return false
  const saltHex = stored.slice(0, idx)
  const hashHex = stored.slice(idx + 1)
  if (!/^[0-9a-f]+$/.test(saltHex) || !/^[0-9a-f]+$/.test(hashHex)) return false
  const expected = Buffer.from(hashHex, 'hex')
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length || KEY_BYTES)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

const SESSION_TTL_MS = 30 * 24 * 3600 * 1000

/** session cookie 后端仓：持久化到 settings 表（重启保持登录态）。滚动过期：
 *  verify 通过即续期 30 天。create 时顺带惰性清扫过期会话（防长期运行缓慢泄漏）。
 *  存储格式：settings 表 key=session:${token}, value=expiresAt（Unix 毫秒时间戳）。 */
export class SessionStore {
  constructor(private settings: SettingsRepo) {}

  /** 惰性清扫：删除所有已过期的会话。 */
  private sweep(now: number): void {
    const sessions = this.settings.listByPrefix('session:')
    for (const { key, value } of sessions) {
      const exp = parseInt(value, 10)
      if (isNaN(exp) || now > exp) {
        this.settings.delete(key)
      }
    }
  }

  create(now: number): string {
    this.sweep(now) // 惰性清扫，防 settings 表无界增长
    const token = randomBytes(32).toString('hex')
    const expiresAt = now + SESSION_TTL_MS
    this.settings.set(`session:${token}`, String(expiresAt), now)
    return token
  }

  verify(token: string, now: number): boolean {
    const key = `session:${token}`
    const value = this.settings.get(key)
    if (value === null) return false
    const exp = parseInt(value, 10)
    if (isNaN(exp) || now > exp) {
      this.settings.delete(key)
      return false
    }
    // 续期 30 天
    this.settings.set(key, String(now + SESSION_TTL_MS), now)
    return true
  }

  revoke(token: string): void {
    this.settings.delete(`session:${token}`)
  }

  /** 全员下线：清空所有会话（改密时用——凭据轮换必须让任何被盗会话立即失效）。 */
  clear(): void {
    const sessions = this.settings.listByPrefix('session:')
    for (const { key } of sessions) {
      this.settings.delete(key)
    }
  }
}

/** 登录失败节流（spec §2：内存计数 5 次/分钟）。只计**失败**（审计 #3）——成功登录不消耗预算，
 *  否则合法管理员正常登录会白白吃掉配额，且被别人的失败尝试连累锁死。check 只读判定当前窗口是否
 *  还在预算内（不自增），recordFailure 在密码错时显式记一次。
 *  清理策略：recordFailure 时顺带惰性清扫过期条目（防 Map 无界增长，IPv6 /64 轮换攻击场景）。
 *  IPv6 归一：::1 和 2001:db8::1/64 前缀视为同一来源（防攻击者轮换地址绕过限流）。 */
export class LoginThrottle {
  private counts = new Map<string, { windowStart: number; count: number }>()
  constructor(private limit = 5, private windowMs = 60_000) {}

  /** IPv6 地址归一化为 /64 桶键（同一子网视为同一来源，防攻击者在 /64 内轮换地址绕过限流）。
   *  IPv4 与非 IP 串原样返回。
   *  三个必须做对的点（缺一即为可绕过的假防线）：
   *   ① `::` 压缩必须展开补零——否则 `2001:db8::1` 只切出 3 段而不归一，轮换即绕过；
   *   ② 每段必须转数值再格式化——否则 `2001:DB8::1` / `2001:0db8::1` / `2001:db8::1`
   *      是同一个 /64 却落进三个桶（大小写/前导零变体即绕过）；
   *   ③ 段数异常（含 h+t>8 的畸形串）原样返回，且 Array 长度不得为负（RangeError）。 */
  private normalizeKey(key: string): string {
    // IPv4-mapped IPv6（点分十进制形态：::ffff:127.0.0.1）→ 归入 IPv4 桶
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(key)
    if (mapped) return mapped[1]

    // 非 IPv6（无冒号）原样返回
    if (!key.includes(':')) return key

    // 展开 :: 压缩形式为完整 8 段
    let parts: string[]
    if (key.includes('::')) {
      const halves = key.split('::')
      if (halves.length !== 2) return key // 多个 :: 是非法 IPv6
      const h = halves[0] ? halves[0].split(':') : []
      const t = halves[1] ? halves[1].split(':') : []
      const fill = 8 - h.length - t.length
      if (fill < 0) return key // 畸形串（段数已超 8）——绝不让 Array(负数) 抛 RangeError
      parts = [...h, ...Array(fill).fill('0'), ...t]
    } else {
      parts = key.split(':')
    }

    // 非标准形状（段数 != 8）原样返回
    if (parts.length !== 8) return key

    // 前 4 段转数值再格式化：消除大小写与前导零变体（0DB8 / 0db8 / db8 → db8）
    const prefix: string[] = []
    for (const seg of parts.slice(0, 4)) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(seg)) return key // 非法段（如内嵌 IPv4 尾）→ 原样返回
      prefix.push(parseInt(seg, 16).toString(16))
    }
    return prefix.join(':') + '::/64'
  }

  /** 惰性清扫：删除所有已过期的窗口条目。 */
  private sweep(now: number): void {
    for (const [key, entry] of this.counts) {
      if (now - entry.windowStart >= this.windowMs) {
        this.counts.delete(key)
      }
    }
  }

  /** 当前来源在窗口内是否还允许尝试（不改计数）。窗口已滚过视为重置（放行）。 */
  check(key: string, now: number): boolean {
    const normalizedKey = this.normalizeKey(key)
    const entry = this.counts.get(normalizedKey)
    if (!entry || now - entry.windowStart >= this.windowMs) return true
    return entry.count < this.limit
  }

  /** 记一次失败（密码错时调用）。窗口已滚过则开新窗口。顺带惰性清扫过期条目。 */
  recordFailure(key: string, now: number): void {
    this.sweep(now) // 惰性清扫，防 Map 无界增长
    const normalizedKey = this.normalizeKey(key)
    const entry = this.counts.get(normalizedKey)
    if (!entry || now - entry.windowStart >= this.windowMs) {
      this.counts.set(normalizedKey, { windowStart: now, count: 1 })
      return
    }
    entry.count++
  }
}

export const AUTH_KEYS = {
  username: 'auth_username',
  passwordHash: 'auth_password_hash',
  apiKey: 'auth_api_key',
} as const

// 调研回补（design-recon）：Homarr 是唯一有强度规则的对象，且上手期声明；NIST 对齐"只管长度不
// 管组成"。10 与 setup/Security 页 mono 提示 `min 10 characters` 一致。
const MIN_PASSWORD_LEN = 10

export type SetupResult = { ok: true; apiKey: string } | { ok: false; error: string }
export type LoginResult = { ok: true; sessionToken: string } | { ok: false; status: 401 | 429; error: string }
export type ChangePasswordResult = { ok: true } | { ok: false; error: string }

/** settings 三键之上的鉴权编排。会话/节流自带默认实例（server.ts 一个 AuthService 就是一套
 *  完整状态），测试可直接摸 .sessions 断言。 */
export class AuthService {
  readonly sessions: SessionStore
  private throttle = new LoginThrottle()

  constructor(private settings: SettingsRepo) {
    this.sessions = new SessionStore(settings)
  }

  isInitialized(): boolean {
    return this.settings.get(AUTH_KEYS.passwordHash) !== null
  }

  setup(username: string, password: string, now: number): SetupResult {
    if (this.isInitialized()) return { ok: false, error: 'already initialized' }
    if (!username.trim()) return { ok: false, error: 'username is required' }
    if (password.length < MIN_PASSWORD_LEN) return { ok: false, error: `password must be at least ${MIN_PASSWORD_LEN} characters` }
    const apiKey = randomBytes(16).toString('hex')
    // 原子性（Jellyfin 未授权改密 CVE 的延伸防御）：三键必须全有或全无——否则中途崩溃会留下
    // passwordHash 已写（isInitialized 为 true）但 apiKey 为 null 的半初始化态，verifyApiKey 永假。
    this.settings.db.transaction(() => {
      this.settings.set(AUTH_KEYS.username, username.trim(), now)
      this.settings.set(AUTH_KEYS.passwordHash, hashPassword(password), now)
      this.settings.set(AUTH_KEYS.apiKey, apiKey, now)
    })()
    return { ok: true, apiKey }
  }

  login(username: string, password: string, remoteAddr: string, now: number): LoginResult {
    if (!this.throttle.check(remoteAddr, now)) return { ok: false, status: 429, error: 'too many attempts — wait a minute' }
    const storedUser = this.settings.get(AUTH_KEYS.username)
    const storedHash = this.settings.get(AUTH_KEYS.passwordHash)
    if (storedUser === null || storedHash === null) {
      this.throttle.recordFailure(remoteAddr, now)
      return { ok: false, status: 401, error: 'not initialized' }
    }
    // R6-2 修复：login 时序侧信道——此前 `username !== storedUser ||` 短路导致用户名错时
    // 不跑 scrypt（0 次 vs 1 次），R5-10 加的 `hashPassword(password)` 只是给两条路径各加一次
    // （1 次 vs 2 次），差值同形平移。正确做法：无条件跑 verifyPassword（用户名错时对库里的
    // hash 照样跑一遍 scrypt），再用非短路方式合并结果。
    const passwordOk = verifyPassword(password, storedHash) // 恒跑，不短路
    const userOk = safeStrEqual(username, storedUser) // 常量时间比较
    if (!userOk || !passwordOk) {
      this.throttle.recordFailure(remoteAddr, now) // 只对失败计入（审计 #3）
      return { ok: false, status: 401, error: 'invalid username or password' }
    }
    return { ok: true, sessionToken: this.sessions.create(now) }
  }

  /** 常量时间比较（safeStrEqual：字节长度守卫 + timingSafeEqual）。 */
  verifyApiKey(key: string): boolean {
    const stored = this.settings.get(AUTH_KEYS.apiKey)
    if (stored === null) return false
    return safeStrEqual(key, stored)
  }

  changePassword(oldPassword: string, newPassword: string, now: number): ChangePasswordResult {
    const storedHash = this.settings.get(AUTH_KEYS.passwordHash)
    if (storedHash === null) return { ok: false, error: 'not initialized' }
    if (!verifyPassword(oldPassword, storedHash)) return { ok: false, error: 'current password is incorrect' }
    if (newPassword.length < MIN_PASSWORD_LEN) return { ok: false, error: `password must be at least ${MIN_PASSWORD_LEN} characters` }
    this.settings.set(AUTH_KEYS.passwordHash, hashPassword(newPassword), now)
    // 审计 MEDIUM #1：凭据轮换必须让被盗会话立即失效——改密即全员下线。调用方（server.ts）负责
    // 给发起改密的当前请求补发一枚新 cookie，让管理员自己不被自己踢下线（"sign out everywhere but me"）。
    this.sessions.clear()
    return { ok: true }
  }

  regenerateApiKey(now: number): string {
    const apiKey = randomBytes(16).toString('hex')
    this.settings.set(AUTH_KEYS.apiKey, apiKey, now)
    return apiKey
  }

  apiKeyTail(): string | null {
    const stored = this.settings.get(AUTH_KEYS.apiKey)
    return stored === null ? null : stored.slice(-4)
  }

  /** A4 Task 15：诚实找回密码——删三键回到未初始化态，下次访问 dashboard 重进创建管理员向导。
   *  CLI `subtitle-scout auth reset` 的后端（自托管的 CLI 恢复路径，同 *arr/Homarr）。 */
  reset(): void {
    this.settings.db.transaction(() => {
      this.settings.delete(AUTH_KEYS.username)
      this.settings.delete(AUTH_KEYS.passwordHash)
      this.settings.delete(AUTH_KEYS.apiKey)
    })()
  }
}
