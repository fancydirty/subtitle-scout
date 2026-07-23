import { writeFileSync } from 'node:fs'
import { parseSrtCues } from '../qualityGate.js'
import type { WorkspacePaths } from './types.js'
import type { BilingualRow, CleanCue } from './types.js'

const ASS_OVERRIDE = /\{\\[^}]*\}/g

function cleanText(lines: string[]): string {
  return lines
    .map((line) => line.replace(ASS_OVERRIDE, ''))
    .join('\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim()
}

/** canonical SRT text → agent_view/source_clean.jsonl + work/bilingual.jsonl (pending). */
export function materializeAgentView(
  paths: WorkspacePaths,
  canonicalSrt: string,
): { cues: CleanCue[]; rows: BilingualRow[] } {
  const parsed = parseSrtCues(canonicalSrt)
  const cues: CleanCue[] = parsed.map((c) => ({
    id: c.index,
    text: cleanText(c.text),
  }))
  const rows: BilingualRow[] = cues.map((c) => ({
    id: c.id,
    src: c.text,
    tgt: '',
    status: 'pending',
  }))
  writeFileSync(paths.sourceCleanPath, cues.map((c) => JSON.stringify(c)).join('\n') + '\n')
  writeFileSync(paths.bilingualPath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
  writeFileSync(paths.canonicalSourcePath, canonicalSrt.endsWith('\n') ? canonicalSrt : canonicalSrt + '\n')
  return { cues, rows }
}
