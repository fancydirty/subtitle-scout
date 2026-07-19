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

/** session cookie 后端仓：内存 Map（spec 定案——重启全员重登，YAGNI 不落盘）。滚动过期：
 *  verify 通过即续期 30 天。 */
export class SessionStore {
  private sessions = new Map<string, number>() // token → expiresAt

  create(now: number): string {
    const token = randomBytes(32).toString('hex')
    this.sessions.set(token, now + SESSION_TTL_MS)
    return token
  }

  verify(token: string, now: number): boolean {
    const exp = this.sessions.get(token)
    if (exp === undefined) return false
    if (now > exp) {
      this.sessions.delete(token)
      return false
    }
    this.sessions.set(token, now + SESSION_TTL_MS)
    return true
  }

  revoke(token: string): void {
    this.sessions.delete(token)
  }
}

/** 登录失败节流（spec §2：内存计数 5 次/分钟）。按"尝试"计数而非"失败"——比 spec 略严但
 *  实现更简单且更保守（合法用户 1 次就登进去了，感受不到差别）。 */
export class LoginThrottle {
  private counts = new Map<string, { windowStart: number; count: number }>()
  constructor(private limit = 5, private windowMs = 60_000) {}

  allow(key: string, now: number): boolean {
    const entry = this.counts.get(key)
    if (!entry || now - entry.windowStart >= this.windowMs) {
      this.counts.set(key, { windowStart: now, count: 1 })
      return true
    }
    entry.count++
    return entry.count <= this.limit
  }
}

export const AUTH_KEYS = {
  username: 'auth_username',
  passwordHash: 'auth_password_hash',
  apiKey: 'auth_api_key',
} as const

const MIN_PASSWORD_LEN = 8

export type SetupResult = { ok: true; apiKey: string } | { ok: false; error: string }
export type LoginResult = { ok: true; sessionToken: string } | { ok: false; status: 401 | 429; error: string }
export type ChangePasswordResult = { ok: true } | { ok: false; error: string }

/** settings 三键之上的鉴权编排。会话/节流自带默认实例（server.ts 一个 AuthService 就是一套
 *  完整状态），测试可直接摸 .sessions 断言。 */
export class AuthService {
  readonly sessions = new SessionStore()
  private throttle = new LoginThrottle()

  constructor(private settings: SettingsRepo) {}

  isInitialized(): boolean {
    return this.settings.get(AUTH_KEYS.passwordHash) !== null
  }

  setup(username: string, password: string, now: number): SetupResult {
    if (this.isInitialized()) return { ok: false, error: 'already initialized' }
    if (!username.trim()) return { ok: false, error: 'username is required' }
    if (password.length < MIN_PASSWORD_LEN) return { ok: false, error: `password must be at least ${MIN_PASSWORD_LEN} characters` }
    const apiKey = randomBytes(16).toString('hex')
    this.settings.set(AUTH_KEYS.username, username.trim(), now)
    this.settings.set(AUTH_KEYS.passwordHash, hashPassword(password), now)
    this.settings.set(AUTH_KEYS.apiKey, apiKey, now)
    return { ok: true, apiKey }
  }

  login(username: string, password: string, remoteAddr: string, now: number): LoginResult {
    if (!this.throttle.allow(remoteAddr, now)) return { ok: false, status: 429, error: 'too many attempts — wait a minute' }
    const storedUser = this.settings.get(AUTH_KEYS.username)
    const storedHash = this.settings.get(AUTH_KEYS.passwordHash)
    if (storedUser === null || storedHash === null) return { ok: false, status: 401, error: 'not initialized' }
    if (username !== storedUser || !verifyPassword(password, storedHash)) {
      return { ok: false, status: 401, error: 'invalid username or password' }
    }
    return { ok: true, sessionToken: this.sessions.create(now) }
  }

  /** 常量时间比较（同长才比，node timingSafeEqual 要求等长）。长度比较必须在**字节**层面——
   *  多字节字符可使字符串等长而 Buffer 不等长，直接 timingSafeEqual 会抛 RangeError（门上 500）。 */
  verifyApiKey(key: string): boolean {
    const stored = this.settings.get(AUTH_KEYS.apiKey)
    if (stored === null) return false
    const kb = Buffer.from(key)
    const sb = Buffer.from(stored)
    if (kb.length !== sb.length) return false
    return timingSafeEqual(kb, sb)
  }

  changePassword(oldPassword: string, newPassword: string, now: number): ChangePasswordResult {
    const storedHash = this.settings.get(AUTH_KEYS.passwordHash)
    if (storedHash === null) return { ok: false, error: 'not initialized' }
    if (!verifyPassword(oldPassword, storedHash)) return { ok: false, error: 'current password is incorrect' }
    if (newPassword.length < MIN_PASSWORD_LEN) return { ok: false, error: `password must be at least ${MIN_PASSWORD_LEN} characters` }
    this.settings.set(AUTH_KEYS.passwordHash, hashPassword(newPassword), now)
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
}
