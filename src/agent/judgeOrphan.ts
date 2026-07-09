import { OrphanDecisionSchema, type MediaIdentity, type OrphanDecision } from '../core/schemas.js'
import type { OrphanSubtitle } from '../files/orphanScanner.js'
import type { LlmRuntime } from './runtime.js'
import type { CallStructuredResult } from './llm.js'

export async function judgeOrphan(
  llm: LlmRuntime, identity: MediaIdentity, videoFilename: string, orphans: OrphanSubtitle[],
): Promise<CallStructuredResult<OrphanDecision>> {
  const prompt = [
    'A media folder contains subtitle files whose names do not match the video, so the media',
    'server cannot associate them. Decide whether ONE of them is a CHINESE subtitle for THIS video.',
    'Rules: adopt=true only if the file is clearly for this exact movie/episode AND contains',
    'Chinese (Simplified → zh-Hans, Traditional → zh-Hant; bilingual counts, pick the Chinese variant).',
    'A wrongly adopted subtitle is worse than downloading a fresh one — when unsure, adopt=false.',
    '',
    `identified media: ${JSON.stringify(identity)}`,
    `video filename: ${videoFilename}`,
    `orphan files (name + content sample): ${JSON.stringify(orphans.map(o => ({ file: o.filename, sample: o.sample })))}`,
  ].join('\n')
  return llm.call({
    name: 'report_orphan_decision',
    description: 'Report whether to adopt a local orphan subtitle', prompt, schema: OrphanDecisionSchema,
  })
}
