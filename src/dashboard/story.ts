// src/dashboard/story.ts
import type { StoryDTO, StoryStepDTO, Tone } from './types.js'
import { decisionLabel } from './labels.js'

interface JournalStep { name: string; at: string; data?: unknown }
interface JournalLlmCall { point: string; prompt: string; parsed: unknown; durationMs: number }
interface JournalFinalDecision {
  decision: string
  confidence?: number | null
  selected?: { subtitle_name: string; language: string } | null
  reasons?: string[]
  verification?: { downloaded: boolean; path?: string | null } | null
}
interface JournalDoc {
  decision: JournalFinalDecision
  steps: JournalStep[]
  llm_calls: JournalLlmCall[]
}
interface LedgerLike { name: string; decision: string; ts: number }

const has = (steps: JournalStep[], name: string) => steps.find(s => s.name === name)
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)

/** 从 journal + 匹配的 ledger 事件合成 4 步大白话故事。失败决策把失败点标 fail。 */
export function buildRunStory(journal: JournalDoc, ledger: LedgerLike): StoryDTO {
  const dec = journal.decision
  const { label, tone } = decisionLabel(dec.decision)
  const steps = journal.steps ?? []
  const success = dec.decision === 'download' || dec.decision === 'adopted_local' || dec.decision === 'already_exists'

  const season = has(steps, 'seasonGraduate')?.data as { episodes?: number } | undefined
  const gate = has(steps, 'seasonPackGate')?.data as { commit?: number } | undefined
  const coveredCount = num(gate?.commit) ?? num(season?.episodes)
  const isSeason = !!season

  const filter = has(steps, 'candidateFilter')?.data as { kept?: number } | undefined
  const kept = num(filter?.kept)

  // 语言人话
  const lang = dec.selected?.language === 'zh-Hant' ? '繁体中文' : '简体中文'

  const out: StoryStepDTO[] = []

  // 1. 认出片
  out.push({ title: '认出这部片', detail: ledger.name, state: 'done' })

  // 2. 找字幕
  if (isSeason) {
    out.push({ title: '去字幕站找了一圈', detail: `找到一份覆盖整季的字幕${coveredCount ? `（共 ${coveredCount} 集）` : ''}，比一集一集找更省事`, state: 'done' })
  } else if (kept === 0) {
    out.push({ title: '去字幕站找了一圈', detail: '没有能对上这部片的字幕', state: 'fail' })
  } else {
    out.push({ title: '去字幕站找了一圈', detail: kept != null ? `找到 ${kept} 个候选` : '找到一些候选', state: 'done' })
  }

  // 3. 下下来验一验（新流程：候选下到沙盒，打开看是不是这份资源，而不是单凭排序"挑一个"）
  if (success) {
    out.push({ title: '下下来验了验是不是这份', detail: dec.selected ? `${lang} · 打开看了，确认是这份资源的字幕` : '确认可用', state: 'done' })
  } else {
    // 失败：若前一步已 fail 则第 3 步不再重复 fail，用中性收束
    const alreadyFailed = out.some(s => s.state === 'fail')
    out.push({ title: '下下来验了验是不是这份', detail: '挨个试了试，没有一份能确认对上，为避免下错，这次先不放', state: alreadyFailed ? 'done' : 'fail' })
  }

  // 4. 确认没问题，装到位
  if (success) {
    const doneDetail = isSeason && coveredCount
      ? `${coveredCount} 集字幕全部就位，Jellyfin 里已经能看了`
      : dec.decision === 'already_exists' ? '本来就有字幕，这次不用动' : '字幕已就位，Jellyfin 里已经能看了'
    out.push({ title: '确认没问题，装到位', detail: doneDetail, state: 'done' })
  } else {
    out.push({ title: '确认没问题，装到位', detail: '这次没有可放的字幕，过阵子会再帮你试', state: 'done' })
  }

  return {
    name: ledger.name,
    decision: dec.decision,
    outcomeLabel: label,
    tone: tone as Tone,
    ts: ledger.ts,
    steps: out.slice(0, 4),
    raw: {
      pipelineSteps: steps.map(s => ({ name: s.name, at: s.at, data: s.data })),
      llmCalls: (journal.llm_calls ?? []).map(c => ({ point: c.point, durationMs: c.durationMs, prompt: c.prompt, parsed: c.parsed })),
    },
  }
}
