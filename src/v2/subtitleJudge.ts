// src/v2/subtitleJudge.ts：需字幕判定（新架构阶段 3，纯机械无 LLM）。
// spec: docs/design/2026-08-08-PIPELINE-SPEC.md 裁决 D8 / 缺口 C27
//
// 规则（身份确定后自动跑）：
//  1. origin_lang ∈ 目标语言（如 zh）→ needs_subtitle=0（国产片，不需要中文字幕）
//  2. embedded_langs 含目标语言 → needs_subtitle=0（已有内嵌中字）
//  3. 其余 → needs_subtitle=1（需要找字幕）
//
// **判据只有语言事实**（D8 的职责切分）：needs_subtitle 回答"这资源**原则上**需要中文字幕吗"，
// 与磁盘上当前有没有外挂字幕无关；后者归 sub_status，由扫描独占写入（R24）。
//
// 这里曾有第 3 条规则「磁盘已有同名 sidecar 中文字幕 → needs_subtitle=0」，删掉的原因（C27）：
// 同一个**磁盘事实**被两列各判一次，就会造出一个双不满足的永久卡死态——
//   用户嫌翻译质量差手删字幕 → 扫描把 sub_status 从 covered 回退成 NULL ✅
//   但 needs_subtitle=0 留着 → 既不满足 judge 谓词 `needs_subtitle IS NULL`（不会重判它）、
//   又不满足字幕工作台谓词 `needs_subtitle=1`（不会排它）→ **这一集永久不再补字幕**，
//   而界面上什么异常都看不出来。
// 删掉之后"磁盘已有外挂中字的文件不许被送进字幕流白烧一轮付费 LLM"这个正确行为并没有丢，
// 只是换了保证者：由扫描写的 `sub_status='covered'` 挡在字幕工作台门口（R24）。
// 一个磁盘事实只许有一个投影列——这是 C19 换列复活（C27）的唯一根治办法。
import { langOf } from '../agent/languages.js'

export interface JudgeInput {
  originLang: string | null
  embeddedLangs: string[] | null
}

export interface JudgeDeps {
  targetLanguages: string[]
}

export type JudgeVerdict =
  | { needs: false; reason: 'origin-skip' | 'embedded' }
  | { needs: true; reason: 'missing' }

/** 判定一个文件是否需要找字幕。纯函数（只看语言事实，不碰磁盘）。 */
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
  // 3. 需要找字幕
  return { needs: true, reason: 'missing' }
}
