// src/v2/subtitleJudge.ts：需字幕判定（新架构阶段 3，纯机械无 LLM）。
// spec: docs/design/2026-08-08-new-architecture-design.md §5.4（用户裁决 #5 确认"没毛病，可以"）
//
// 规则（身份确定后自动跑）：
//  1. origin_lang ∈ 目标语言（如 zh）→ needs_subtitle=0（国产片，不需要中文字幕）
//  2. embedded_langs 含目标语言 → needs_subtitle=0（已有内嵌中字）
//  3. 磁盘已有同名前缀的 sidecar 中文字幕 → needs_subtitle=0（已有外挂）
//  4. 其余 → needs_subtitle=1（需要找字幕）
import { langOf } from '../agent/languages.js'

export interface JudgeInput {
  originLang: string | null
  embeddedLangs: string[] | null
  hasSidecarSubtitle: boolean
}

export interface JudgeDeps {
  targetLanguages: string[]
  hasSidecar?: (videoPath: string) => boolean
}

export type JudgeVerdict =
  | { needs: false; reason: 'origin-skip' | 'embedded' | 'sidecar' }
  | { needs: true; reason: 'missing' }

/** 判定一个文件是否需要找字幕。纯函数（sidecar 探测由调用方注入）。 */
export function judgeSubtitle(input: JudgeInput, deps: JudgeDeps): JudgeVerdict {
  // 1. 国产片跳过：origin_lang 是目标语言（如 zh 目标中文时，中文影视不需要中文字幕）
  if (input.originLang != null && deps.targetLanguages.includes(input.originLang.toLowerCase())) {
    return { needs: false, reason: 'origin-skip' }
  }
  // 2. 已有内嵌中字
  if (input.embeddedLangs != null) {
    const hasTargetEmbedded = input.embeddedLangs.some((l) =>
      deps.targetLanguages.includes(langOf(l)))
    if (hasTargetEmbedded) return { needs: false, reason: 'embedded' }
  }
  // 3. 已有 sidecar 外挂中文字幕
  if (input.hasSidecarSubtitle) return { needs: false, reason: 'sidecar' }
  // 4. 需要找字幕
  return { needs: true, reason: 'missing' }
}
