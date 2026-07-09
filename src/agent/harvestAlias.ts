import { z } from 'zod'
import type { LlmRuntime } from './runtime.js'

const CJK_PATTERN = /[一-鿿㐀-䶿豈-﫿]/

/**
 * 测试字符串是否包含 CJK 字符（汉字）
 */
export function hasCjk(s: string): boolean {
  return CJK_PATTERN.test(s)
}

const AliasExtractionSchema = z.object({
  alias: z.string().nullable(),
  confidence: z.number().min(0).max(1),
})

/**
 * 从 ASSRT 候选名中收割中文剧名别名。
 * 返回 null 表示无可收割别名（无 CJK 内容、LLM 低置信、或别名无效）。
 *
 * @param runtime LLM runtime for structured calls
 * @param originalTitle 原始剧名（英文或 TMDB 返回的名称）
 * @param candidateNames 候选名列表（从 native_name||videoname 提取的前 40 字符）
 * @returns 提取的中文别名，或 null 表示无可收割
 */
export async function harvestAlias(
  runtime: Pick<LlmRuntime, 'call'>,
  originalTitle: string,
  candidateNames: string[],
): Promise<string | null> {
  // 预筛：无 CJK 候选则不花 LLM 调用
  const hasCjkCandidates = candidateNames.some(hasCjk)
  if (!hasCjkCandidates) {
    return null
  }

  // LLM 提取中文别名
  const prompt = [
    'Extract the common Chinese title for this TV show or movie from the candidate subtitle names.',
    'ASSRT subtitle entries often contain bilingual names like "中文名.English.Name.S04E01" or "中文名/English Name".',
    'Your task: identify and extract the FULL COMMON Chinese title (完整通用名，非缩写).',
    '',
    'Rules:',
    '- Return ONLY the show title itself — strip season/episode markers (第X季/SxxExx), resolution, and release tags.',
    '- Return the COMPLETE Chinese name, not abbreviations (e.g., "爱，死亡与机器人" not "爱死机")',
    '- The title should be the commonly used form that would appear in a Chinese TV database',
    '- If candidates show multiple variations, pick the most complete/formal one',
    '- Set confidence to 0 if you cannot confidently identify a single Chinese title',
    '- Set confidence < 0.7 if the Chinese title appears inconsistently or is unclear',
    '',
    `Original title: ${originalTitle}`,
    '',
    'Candidate subtitle names (first 40 chars):',
    ...candidateNames.map((n, i) => `${i + 1}. ${n}`),
  ].join('\n')

  const result = await runtime.call({
    name: 'extract_chinese_alias',
    description: 'Extract the common Chinese title from subtitle candidate names',
    prompt,
    schema: AliasExtractionSchema,
  })

  const { alias, confidence } = result.parsed

  // 防呆：低置信、无别名、或别名无 CJK → null
  if (!alias || confidence < 0.7 || !hasCjk(alias)) {
    return null
  }

  // 防呆：别名与原标题相同或全 ASCII → null
  if (alias.trim().toLowerCase() === originalTitle.trim().toLowerCase()) {
    return null
  }
  if (!/[^\x00-\x7F]/.test(alias)) {
    // 全 ASCII → null
    return null
  }

  return alias
}
