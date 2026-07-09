import { QUIRK_BODIES } from './quirks.js'
import type { LlmProfile } from './profile.js'

/** 探针尝试的注入接口：成功返回、失败抛错。真实实现在 runtime.ts 构造。 */
export interface ProbeAttempts {
  forcedTool: (extraBody?: Record<string, unknown>) => Promise<void>
  promptJson: () => Promise<void>
}

export class ProbeFailedError extends Error {}

/** 探针阶梯：forced-tool → forced-tool+quirk（按档案库序）→ prompt-json → 报错 */
export async function probeCapability(attempts: ProbeAttempts): Promise<LlmProfile> {
  let lastError: unknown
  try {
    await attempts.forcedTool(undefined)
    return { mode: 'forced-tool', evidence: 'probe: bare forced tool call succeeded' }
  } catch (e) { lastError = e }

  for (const quirk of QUIRK_BODIES) {
    try {
      await attempts.forcedTool(quirk.body)
      return {
        mode: 'forced-tool-quirk', quirkId: quirk.id, extraBody: quirk.body,
        evidence: `probe: forced tool succeeded with quirk ${quirk.id}`,
      }
    } catch (e) { lastError = e }
  }

  try {
    await attempts.promptJson()
    return { mode: 'prompt-json', evidence: 'probe: degraded to prompt-json mode' }
  } catch (e) { lastError = e }

  throw new ProbeFailedError(
    `this model cannot produce structured output in any supported mode; last error: ${String(lastError)}`,
  )
}
