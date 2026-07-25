import { readFileSync, writeFileSync } from 'node:fs'
import { parseSrtCues, serializeSrtCues } from '../qualityGate.js'
import type { BilingualRow, WorkspacePaths } from './types.js'

function readBilingual(paths: WorkspacePaths): BilingualRow[] {
  const raw = readFileSync(paths.bilingualPath, 'utf8').trim()
  if (!raw) return []
  return raw.split('\n').filter(Boolean).map((l, i) => {
    try {
      return JSON.parse(l) as BilingualRow
    } catch (e) {
      // 一行损坏整批抛,但错误信息不带行号,排查困难——附行号重抛
      throw new Error(`bilingual.jsonl line ${i + 1} invalid JSON: ${l.slice(0, 100)}... (${e instanceof Error ? e.message : String(e)})`)
    }
  })
}

/** Merge bilingual tgt into canonical timing shells. Writes out/target.srt. Fail-closed on empty tgt. */
export function mergeBilingualToSrt(paths: WorkspacePaths): string {
  const canonical = readFileSync(paths.canonicalSourcePath, 'utf8')
  const shells = parseSrtCues(canonical)
  const rows = readBilingual(paths)
  const byId = new Map(rows.map((r) => [r.id, r]))
  if (shells.length !== rows.length) {
    throw new Error(`merge row count mismatch: canonical=${shells.length} bilingual=${rows.length}`)
  }
  const out = shells.map((c) => {
    const row = byId.get(c.index)
    if (!row) throw new Error(`merge missing bilingual row for id=${c.index}`)
    const tgt = row.tgt.trim()
    if (!tgt) throw new Error(`merge empty tgt for id=${c.index} (status=${row.status})`)
    // 防御:空行会产生无 cue 头的孤儿块(update_row 已净化,此处兜底老数据/直接写表的路径)。
    const lines = tgt.split('\n').filter((l) => l.trim() !== '')
    return { index: c.index, timing: c.timing, text: lines.length ? lines : [tgt] }
  })
  const srt = serializeSrtCues(out)
  writeFileSync(paths.targetSrtPath, srt)
  return srt
}
