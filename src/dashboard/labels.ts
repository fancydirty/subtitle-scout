// src/dashboard/labels.ts
import type { Tone } from './types.js'

const DECISION_MAP: Record<string, { label: string; tone: Tone }> = {
  download:       { label: '已下好中文字幕', tone: 'ok' },
  adopted_local:  { label: '整理好了本地已有的字幕', tone: 'ok' },
  already_exists: { label: '本来就有字幕，跳过', tone: 'skip' },
  no_safe_match:  { label: '暂时没找到合适的中文字幕', tone: 'muted' },
  retry_later:    { label: '过阵子再试', tone: 'muted' },
  error:          { label: '出错，稍后重试', tone: 'fail' },
  realigned:      { label: '把乱排布的剧集整理好了', tone: 'ok' },
}

/** 内部决策枚举 → 用户视角人话。未知枚举兜底为中性词，绝不泄漏原始枚举名。 */
export function decisionLabel(decision: string): { label: string; tone: Tone } {
  return DECISION_MAP[decision] ?? { label: '已处理', tone: 'muted' }
}

export function queueStatusLabel(state: 'pending' | 'dormant'): string {
  return state === 'dormant' ? '多次没找到，暂缓' : '排队等待中'
}
