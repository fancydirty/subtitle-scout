// DB 审计🔴 耐久运维:周期 checkpoint + 每日在线备份。daemon 每 tick 调 runDbMaintenance,
// 内部时间门控(小时级 checkpoint / 天级 backup),失败只记日志不炸 tick(运维是增益,不拖主循环)。
//
// 背景:2026-07-21 本机 scout.db 真损坏(malformed),WAL 里 4MB 未 checkpoint 数据随主文件
// 一起报废——没有周期 checkpoint/备份机制,恢复只能靠几天前手动备份。VACUUM INTO 是对活 WAL
// 库唯一安全的在线备份形态(一致性快照,连 WAL 内容一起收),绝不 cp 裸文件三件套。
import { mkdirSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { ScoutDb } from './db.js'

export const CHECKPOINT_EVERY_MS = 60 * 60_000        // 每小时压一次 WAL(TRUNCATE)
export const BACKUP_EVERY_MS = 24 * 3600_000          // 每天一份在线快照
export const BACKUP_RETAIN = 7                        // 留最近 7 份

export interface MaintenanceState {
  lastCheckpointAt: number
  lastBackupAt: number
}

export function makeMaintenanceState(): MaintenanceState {
  return { lastCheckpointAt: 0, lastBackupAt: 0 }
}

/** 每 tick 调用。now 可注入(测试)。返回本 tick 实际做了什么(观测/测试断言用)。 */
export function runDbMaintenance(
  db: ScoutDb, cacheDir: string, state: MaintenanceState, now: number,
  log: (msg: string) => void = () => {},
): { checkpointed: boolean; backupPath: string | null } {
  let checkpointed = false
  let backupPath: string | null = null
  try {
    // lastCheckpointAt=0 视为"从未跑过"——daemon 启动后第一个 tick 就压一次,不等一小时
    if (state.lastCheckpointAt === 0 || now - state.lastCheckpointAt >= CHECKPOINT_EVERY_MS) {
      db.pragma('wal_checkpoint(TRUNCATE)')
      state.lastCheckpointAt = now
      checkpointed = true
    }
  } catch (e) {
    log(`warn: wal_checkpoint 失败(下 tick 再试): ${String(e)}`)
  }
  try {
    if (state.lastBackupAt === 0 || now - state.lastBackupAt >= BACKUP_EVERY_MS) {
      const dir = join(cacheDir, 'backups')
      mkdirSync(dir, { recursive: true })
      const day = new Date(now).toISOString().slice(0, 10).replace(/-/g, '')
      backupPath = join(dir, `scout-${day}.db`)
      // VACUUM INTO 目标须不存在(同天重跑先删旧档)
      try { unlinkSync(backupPath) } catch { /* 不存在 */ }
      db.exec(`VACUUM INTO '${backupPath}'`)
      state.lastBackupAt = now
      // 保留最近 BACKUP_RETAIN 份
      const files = readdirSync(dir).filter((f) => /^scout-\d{8}\.db$/.test(f)).sort()
      for (const f of files.slice(0, Math.max(0, files.length - BACKUP_RETAIN))) {
        try { unlinkSync(join(dir, f)) } catch { /* 尽力清理 */ }
      }
      log(`db backup: ${backupPath}`)
    }
  } catch (e) {
    log(`warn: db 备份失败(下 tick 再试): ${String(e)}`)
    backupPath = null
  }
  return { checkpointed, backupPath }
}
