// DB 审计🔴 耐久运维:周期 checkpoint + 每日在线备份。daemon 每 tick 调 runDbMaintenance,
// 内部时间门控(小时级 checkpoint / 天级 backup),失败只记日志不炸 tick(运维是增益,不拖主循环)。
//
// 背景:2026-07-21 本机 scout.db 真损坏(malformed),WAL 里 4MB 未 checkpoint 数据随主文件
// 一起报废——没有周期 checkpoint/备份机制,恢复只能靠几天前手动备份。VACUUM INTO 是对活 WAL
// 库唯一安全的在线备份形态(一致性快照,连 WAL 内容一起收),绝不 cp 裸文件三件套。
import { mkdirSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { ScoutDb } from './db.js'
import { pruneFound } from './notificationsRepo.js'

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
): { checkpointed: boolean; backupPath: string | null; notificationsPruned: number } {
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
      db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`)
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
  // ── R-F3：通知流水的保留期清理（"随 dbMaintenance 顺手清"，**不新起定时器**）──
  //
  // 为什么挂在这里：这个循环已经在跑 VACUUM/checkpoint，多一个定时器就多一处"谁来触发"的
  // 接线，而本仓栽过 6 次"加了能力却没定谁来触发"（C12→C35→C43→C21→audio_langs→
  // tmdb_seasons）。清理的正确性**不依赖它跑得多勤**——一周窗由读时过滤独立保证
  // （listRecentFound 的谓词），这里只负责回收空间。所以刻意**不加时间门控**（不像
  // checkpoint/backup 那样攒到整点）：DELETE 的谓词本身就是幂等的，一周内无过期行时它删 0 行、
  // 代价是一次走索引的空查询。加门控只会多一个状态字段和一处"门控与保留期两个周期怎么配"的
  // 疑问，换不到任何东西。
  //
  // 单独 try/catch 且**放在 checkpoint/backup 之后**：口径同本文件既有的两个器官——运维是
  // 增益，一处失灵不许连坐。放在最后是因为 checkpoint 与 backup 是耐久性器官（掉电丢数据的
  // 那条防线），通知清理只是空间回收；万一它抛错，前两者已经完成。
  let notificationsPruned = 0
  try {
    notificationsPruned = pruneFound(db, now)
    if (notificationsPruned > 0) log(`通知清理: 删除 ${notificationsPruned} 条过一周的成果（R-F3）`)
  } catch (e) {
    log(`warn: 通知清理失败(下 tick 再试): ${String(e)}`)
  }
  return { checkpointed, backupPath, notificationsPruned }
}
