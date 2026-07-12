import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export interface ZimukuSession {
  cookie: string
  capturedAt: number
}

/**
 * zimuku 云锁会话 cookie 磁盘缓存——单文件、无 TTL 过期(云锁 security_session_verify 不绑 IP、
 * 可长期复用,实测证据见设计文档)。失效检测按响应而非计时:ZimukuClient 每次请求发现命中挑战页
 * 就调用 invalidate() 重破,而不是靠一个猜测的过期时间提前失效一个其实还有效的 cookie。
 * 原子写沿用 agent/profile.ts ProfileStore 的 tmp+rename 模式,但 tmp 文件名额外加了 pid+随机
 * 后缀(见 put()):同一份会话缓存目录可能被多个子进程并发写(比如两次搜索几乎同时命中挑战页各自
 * 重破),固定的 `session.json.tmp` 名字会被第二个进程的写入覆盖/截断第一个进程还没 rename 完的
 * 临时文件,pid+随机后缀让两边的 tmp 路径必然不同,rename 目标仍是同一个最终路径、仍然原子。
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
    // pid + 随机后缀:两个子进程(比如并发跑的两次搜索/破解)同时 put() 时,tmp 路径不会撞车
    // 互相覆盖对方还没 rename 完的临时文件——rename 本身仍然是同一文件系统内的原子操作。
    const tmpPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`
    writeFileSync(tmpPath, JSON.stringify(session, null, 2))
    renameSync(tmpPath, this.path) // 原子操作(同 fs)
  }

  invalidate(): void {
    rmSync(this.path, { force: true })
  }
}
