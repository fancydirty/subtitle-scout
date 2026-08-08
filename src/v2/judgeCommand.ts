// src/v2/judgeCommand.ts：需字幕判定 CLI（新架构阶段 3）
// 用法：node dist/v2/judgeCommand.js [workId]
// 对已识别文件跑 judgeSubtitle，更新 needs_subtitle。
import { openDb } from './db.js'
import { judgeSubtitle } from './subtitleJudge.js'
import { existsSync } from 'node:fs'
import { dirname, basename } from 'node:path'

async function main() {
  const db = openDb('/cache/scout.db')
  const now = Date.now()
  const targetLang = process.env.TARGET_LANGUAGES?.split(',')[0]?.trim() || 'zh'

  // 取所有已识别、未判定的文件（含其作品的 origin_lang）
  const rows = db.prepare(`
    SELECT f.path, f.filename, f.embedded_langs, f.work_id, w.origin_lang
    FROM files f LEFT JOIN works w ON f.work_id = w.id
    WHERE f.work_id IS NOT NULL AND f.needs_subtitle IS NULL
  `).all() as Array<{ path: string; filename: string; embedded_langs: string | null; work_id: string; origin_lang: string | null }>

  console.log(`待判定 ${rows.length} 个文件`)
  const stats = { missing: 0, originSkip: 0, embedded: 0, sidecar: 0 }
  const update = db.prepare('UPDATE files SET needs_subtitle = ?, updated_at = ? WHERE path = ?')

  for (const r of rows) {
    let embedded: string[] | null = null
    if (r.embedded_langs) { try { embedded = JSON.parse(r.embedded_langs) } catch { embedded = null } }
    // sidecar 探测：同目录同名前缀的 .srt/.ass
    const dir = dirname(r.path)
    const stem = basename(r.filename).replace(/\.[^.]+$/, '')
    const sidecar = existsSync(`${dir}/${stem}.zh.srt`) || existsSync(`${dir}/${stem}.zh.ass`)
      || existsSync(`${dir}/${stem}.chs.srt`) || existsSync(`${dir}/${stem}.chs.ass`)

    const verdict = judgeSubtitle(
      { originLang: r.origin_lang, embeddedLangs: embedded, hasSidecarSubtitle: sidecar },
      { targetLanguages: [targetLang], hasSidecar: () => sidecar },
    )
    update.run(verdict.needs ? 1 : 0, now, r.path)
    stats[verdict.needs ? 'missing' :
      verdict.reason === 'origin-skip' ? 'originSkip' :
      verdict.reason === 'embedded' ? 'embedded' : 'sidecar']++
  }

  console.log(`判定完成: 需要字幕=${stats.missing} 国产跳过=${stats.originSkip} 内嵌跳过=${stats.embedded} sidecar跳过=${stats.sidecar}`)
  db.close()
}

main().catch(e => { console.error(e); process.exit(1) })
