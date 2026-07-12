import {
  existsSync, mkdirSync, readFileSync, writeFileSync, renameSync,
  openSync, closeSync, fsyncSync,
} from 'node:fs'
import { join, dirname } from 'node:path'
import { writeAll } from './fsUtil.js'

export interface ManifestHeader { seriesId: string; seriesTitle: string; startedAt: number }
export interface ManifestEntry {
  op: 'rename' | 'hardlink'
  from: string
  to: string
  size: number
  mtimeMs: number
  reason: string
  ts: number
}
export interface ManifestDoc { header: ManifestHeader; entries: ManifestEntry[] }

export function manifestPath(archiveDir: string): string {
  return join(archiveDir, 'manifest.json')
}

/** 幂等初始化：manifest 已存在（崩溃恢复重跑）时不覆盖，保留原有 entries 现场。 */
export function initManifest(archiveDir: string, header: ManifestHeader): void {
  mkdirSync(archiveDir, { recursive: true })
  const path = manifestPath(archiveDir)
  if (existsSync(path)) return
  writeFileSync(path, JSON.stringify({ header, entries: [] } satisfies ManifestDoc, null, 2))
}

export function readManifest(archiveDir: string): ManifestDoc | null {
  const path = manifestPath(archiveDir)
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf8')) as ManifestDoc
}

/** 先记后搬：调用方必须在实际执行 rename/hardlink 之前调用本函数（write-ahead），
 *  这样崩溃恢复时读到的 manifest 永远至少覆盖到"即将要做"的那一步，不会有"做完了但
 *  清单没记"的窗口。fd 上 fsync 一次，尽力保证记账本身也不因断电半途而废。 */
export function appendManifestEntry(archiveDir: string, entry: ManifestEntry): void {
  const path = manifestPath(archiveDir)
  const doc = readManifest(archiveDir)
  if (!doc) throw new Error(`manifest 尚未初始化：${path}——先调用 initManifest`)
  doc.entries.push(entry)
  const fd = openSync(path, 'w')
  try {
    writeAll(fd, Buffer.from(JSON.stringify(doc, null, 2)))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/**
 * 逆序重放回滚：把 manifest 里每条 entry 的 rename 反着做一遍（to → from）。
 * 幂等：目标（也就是原 from）已存在则跳过这一条（视为已回滚过，绝不覆盖）；来源（to）
 * 不存在则警告跳过（可能被后续步骤又动过，不强行报错中断整个回滚流程）。
 */
export function replayRollback(archiveDir: string, log: (msg: string) => void = () => {}): void {
  const doc = readManifest(archiveDir)
  if (!doc) throw new Error(`manifest 不存在：${manifestPath(archiveDir)}`)
  for (const entry of [...doc.entries].reverse()) {
    if (existsSync(entry.from)) {
      log(`跳过（已回滚）：${entry.to} → ${entry.from}`)
      continue
    }
    if (!existsSync(entry.to)) {
      log(`警告：回滚源缺失，跳过：${entry.to}`)
      continue
    }
    mkdirSync(dirname(entry.from), { recursive: true })
    renameSync(entry.to, entry.from)
    log(`已回滚：${entry.to} → ${entry.from}`)
  }
}
