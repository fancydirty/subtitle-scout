// src/v2/scanCommand.ts：机械扫描 CLI（新架构阶段 1，容器内跑）
// 用法：node dist/v2/scanCommand.js <mediaRoot1> <mediaRoot2> ...
// 把守备目录下的媒体文件扫进 files 表（零身份判断）。
import { readdirSync, statSync } from 'node:fs'
import { walkVideoFiles } from '../daemon/selfScan.js'
import { toMediaFileRow, isScannable } from './scanner.js'
import { openDb } from './db.js'

async function main() {
  const roots = process.argv.slice(2)
  if (roots.length === 0) { console.error('用法: scanCommand <mediaRoot...>'); process.exit(1) }
  const db = openDb('/cache/scout.db')
  const now = Date.now()

  // upsert 到 files 表（指纹 mtime+size 未变则跳过）
  const upsert = db.prepare(`
    INSERT INTO files (path, dir, filename, size, mtime, work_dir, season, episode, parse_confidence, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      dir=excluded.dir, filename=excluded.filename, size=excluded.size, mtime=excluded.mtime,
      work_dir=excluded.work_dir, season=excluded.season, episode=excluded.episode,
      parse_confidence=excluded.parse_confidence, updated_at=excluded.updated_at
  `)
  const findExisting = db.prepare('SELECT mtime, size FROM files WHERE path = ?')

  let scanned = 0, upserted = 0, skipped = 0, unchanged = 0
  const byConfidence: Record<string, number> = { high: 0, low: 0, none: 0 }
  const workDirs = new Set<string>()

  for (const root of roots) {
    console.log(`扫描 ${root} ...`)
    const files = walkVideoFiles(root)
    for (const f of files) {
      scanned++
      let st
      try { st = statSync(f) } catch { skipped++; continue }
      const sc = isScannable(f, st.size)
      if (!sc.ok) { skipped++; continue }
      const existing = findExisting.get(f) as { mtime: number; size: number } | undefined
      if (existing && existing.mtime === Math.round(st.mtimeMs) && existing.size === st.size) {
        unchanged++
        continue
      }
      const row = toMediaFileRow(f, st, roots)
      upsert.run(row.path, row.dir, row.filename, row.size, row.mtime,
        row.workDir, row.season, row.episode, row.parseConfidence, now)
      upserted++
      byConfidence[row.parseConfidence]++
      workDirs.add(row.workDir)
    }
  }

  console.log(`\n=== 结果 ===`)
  console.log(`扫描 ${scanned} 个文件`)
  console.log(`静默跳过 ${skipped}`)
  console.log(`指纹未变跳过 ${unchanged}`)
  console.log(`新入库 ${upserted}`)
  console.log(`confidence 分布: ${JSON.stringify(byConfidence)}`)
  console.log(`作品根数量: ${workDirs.size}`)
  console.log(`files 表总行数: ${(db.prepare('SELECT COUNT(*) c FROM files').get() as { c: number }).c}`)

  // 抽样看看
  const samples = db.prepare(`SELECT filename, work_dir, season, episode, parse_confidence FROM files LIMIT 12`).all() as any[]
  console.log(`\n=== 抽样 ===`)
  for (const s of samples) console.log(`  ${s.parse_confidence?.padEnd(4)} ${s.work_dir?.slice(-30)} | ${s.filename?.slice(0, 40)}`)

  db.close()
}

main().catch(e => { console.error(e); process.exit(1) })
