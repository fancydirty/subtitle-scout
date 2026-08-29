import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export interface R3subSession {
  /** 主站 + 论坛的跨域 cookie 串（PHPSESSID/R3_Vname/R3_Vid/Vanilla-Vv），登录成功后拼好存盘。 */
  cookie: string
  capturedAt: number
}

/**
 * r3sub 登录会话 cookie 磁盘缓存——照 ZimukuSessionStore 复刻（单文件、tmp+pid+rename 原子写、
 * 无 TTL 计时过期）。失效检测按响应而非计时：R3subClient 每次请求发现命中登录墙（download.php
 * 第一跳返回 signin 特征）就调 invalidate() 后 login() 重登，而不是靠猜的过期时间提前失效一个
 * 其实还有效的 cookie。tmp 文件名加 pid+随机后缀，防同一缓存目录被并发写时互相截断。
 */
export class R3subSessionStore {
  private path: string
  constructor(dir: string) {
    mkdirSync(dir, { recursive: true })
    this.path = join(dir, 'session.json')
  }

  get(): R3subSession | null {
    if (!existsSync(this.path)) return null
    try {
      return JSON.parse(readFileSync(this.path, 'utf8')) as R3subSession
    } catch {
      return null // 损坏文件 → 视作缓存未命中
    }
  }

  put(session: R3subSession): void {
    const tmpPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`
    writeFileSync(tmpPath, JSON.stringify(session, null, 2))
    renameSync(tmpPath, this.path) // 原子操作(同 fs)
  }

  invalidate(): void {
    rmSync(this.path, { force: true })
  }
}
