import { readFileSync } from 'node:fs'
import { z } from 'zod'
import type { LlmRuntime } from './runtime.js'
import type { CallStructuredResult } from './llm.js'
import { REALIGN_PLAYBOOK } from './playbooks/realignPlaybook.js'
// SeasonShape + mirrorExceedsSeasonTable were extracted to core/seasonShape.ts (shared with the v3
// orchestrator) — see the old-pipeline retirement scope. Re-imported here for this module's own use.
import { mirrorExceedsSeasonTable, type SeasonShape } from '../core/seasonShape.js'

export const DiagnosisVerdictSchema = z.object({
  verdict: z.enum(['absolute_flat', 'unknown']),
  reason: z.string(),
})
export type DiagnosisVerdict = z.infer<typeof DiagnosisVerdictSchema>

export interface RecentRunSummary { decision: string; detail: string }

/**
 * 从 pipeline journal 落盘的 decision.json 里提取 rankCandidates 这次 LLM 调用的结构化
 * 拒绝理由（RankDecision.rejected[].reason）——诊断的佐证信号。fail-soft：文件缺失/JSON
 * 损坏/形状不对，一律返回空数组，绝不让诊断因为一份读不到的旧 journal 而崩溃。
 */
export function extractStructuredRejections(
  journalPath: string, readFile: (p: string) => string = p => readFileSync(p, 'utf8'),
): string[] {
  try {
    const doc = JSON.parse(readFile(journalPath)) as { llm_calls?: Array<{ point?: string; parsed?: unknown }> }
    const out: string[] = []
    for (const call of doc.llm_calls ?? []) {
      if (call.point !== 'rankCandidates') continue
      const parsed = call.parsed as { rejected?: Array<{ reason?: unknown }> } | undefined
      for (const r of parsed?.rejected ?? []) {
        if (typeof r.reason === 'string' && r.reason) out.push(r.reason)
      }
    }
    return out
  } catch {
    return []
  }
}

/**
 * 季级诊断：一次确定性预检 + （信号成立时）一次 LLM 调用。主信号不成立时直接返回 unknown，
 * 不花一次 LLM 调用——诊断本身也要讲究成本，没有确定性信号支撑就不该去问模型"你猜"。
 */
export async function diagnoseSeason(
  llm: LlmRuntime,
  shape: SeasonShape,
  recentRuns: RecentRunSummary[],
  structuredRejections: string[],
): Promise<CallStructuredResult<DiagnosisVerdict>> {
  if (!mirrorExceedsSeasonTable(shape)) {
    return {
      parsed: { verdict: 'unknown', reason: '镜像集数未超过 TMDB 该季集数，没有绝对编号平铺的确定性信号' },
      rawText: '', retries: 0, durationMs: 0, prompt: '',
    }
  }
  const prompt = [
    REALIGN_PLAYBOOK,
    '',
    '## 本次待诊断的季',
    `该季（series_id=${shape.seriesId}, season=${shape.season}）镜像里共有 ${shape.mirrorEpisodeCount} 集，` +
      `TMDB 记录该季只有 ${shape.tmdbEpisodeCount} 集——镜像集数超出 TMDB。`,
    '',
    '最近几次搜索的结论：',
    ...(recentRuns.length ? recentRuns.map(r => `- ${r.decision}: ${r.detail}`) : ['（无历史记录）']),
    '',
    '最近一次搜索的结构化拒绝理由：',
    ...(structuredRejections.length ? structuredRejections.map(r => `- ${r}`) : ['（无结构化拒绝理由）']),
    '',
    '按上面手册的"分类"给出 verdict（absolute_flat 或 unknown）和一句话 reason。',
  ].join('\n')
  return llm.call({
    name: 'report_diagnosis', description: 'Report season layout diagnosis',
    prompt, schema: DiagnosisVerdictSchema,
  })
}
