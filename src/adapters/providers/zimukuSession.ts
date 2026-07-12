import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, renameSync } from 'node:fs'
import { join } from 'node:path'

export interface ZimukuSession {
  cookie: string
  capturedAt: number
}

/**
 * zimuku 云锁会话 cookie 磁盘缓存——单文件、无 TTL 过期(云锁 security_session_verify 不绑 IP、
 * 可长期复用,实测证据见设计文档)。失效检测按响应而非计时:ZimukuClient 每次请求发现命中挑战页
 * 就调用 invalidate() 重破,而不是靠一个猜测的过期时间提前失效一个其实还有效的 cookie。
 * 原子写沿用 agent/profile.ts ProfileStore 的 tmp+rename 模式。
 */
export class ZimukuSessionStore {
  private path: string
  constructor(dir: string) {
    mkdirSync(dir, { recursive: true })
    this.path = join(dir, 'session.json')
  }

  get(): ZimukuSession | null {
    if (!existsSync(this.path)) return null
    try {
      return JSON.parse(readFileSync(this.path, 'utf8')) as ZimukuSession
    } catch {
      return null // 损坏文件 → 视作缓存未命中
    }
  }

  put(session: ZimukuSession): void {
    const tmpPath = `${this.path}.tmp`
    writeFileSync(tmpPath, JSON.stringify(session, null, 2))
    renameSync(tmpPath, this.path) // 原子操作(同 fs)
  }

  invalidate(): void {
    rmSync(this.path, { force: true })
  }
}
