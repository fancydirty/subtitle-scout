import type { z } from 'zod'
import {
  makeModel, callStructured, callPromptJson as realCallPromptJson,
  isToolChoiceRejection, type LlmConfig, type CallStructuredResult,
} from './llm.js'
import { probeCapability, type ProbeAttempts } from './probe.js'
import { ProfileStore, type LlmProfile } from './profile.js'
import { z as zod } from 'zod'

export interface RuntimeCallOpts<S extends z.ZodType> {
  name: string
  description: string
  prompt: string
  schema: S
  maxOutputTokens?: number
  /** 透传给 llm.ts 的 callStructured/callPromptJson——见 agent/solveNumericCaptcha.ts。
   *  defaultInternals() 的 callForcedTool/callPromptJson 已经 `...opts` 展开转发,这里只是
   *  补上类型声明,让 TypeScript 承认这个字段合法(而不是悄悄允许多余属性透传)。 */
  images?: Buffer[]
}

export interface LlmRuntime {
  call<S extends z.ZodType>(opts: RuntimeCallOpts<S>): Promise<CallStructuredResult<z.infer<S>>>
  profileInfo(): { mode: string; quirkId?: string }
}

/** 内部实现注入点（测试用）；生产默认用真实现 */
export interface RuntimeInternals {
  probe: (attempts: ProbeAttempts) => Promise<LlmProfile>
  callForcedTool: <S extends z.ZodType>(cfg: LlmConfig, extraBody: Record<string, unknown> | undefined, opts: RuntimeCallOpts<S>) => Promise<CallStructuredResult<z.infer<S>>>
  callPromptJson: <S extends z.ZodType>(cfg: LlmConfig, opts: RuntimeCallOpts<S>) => Promise<CallStructuredResult<z.infer<S>>>
}

const PROBE_SCHEMA = zod.object({ ok: zod.boolean() })
const PROBE_PROMPT = 'This is a connectivity probe. Report ok=true.'

export function defaultInternals(): RuntimeInternals {
  return {
    probe: probeCapability,
    callForcedTool: (cfg, extraBody, opts) =>
      callStructured({ model: makeModel({ ...cfg, extraBody }), ...opts }),
    callPromptJson: (cfg, opts) =>
      realCallPromptJson({ model: makeModel({ ...cfg, extraBody: undefined }), ...opts }),
  }
}

export async function createLlmRuntime(
  cfg: LlmConfig,
  store: ProfileStore,
  internals: RuntimeInternals = defaultInternals(),
  onProfileChange?: (info: { mode: string; quirkId?: string }) => void,
): Promise<LlmRuntime> {
  const makeAttempts = (): ProbeAttempts => ({
    forcedTool: async extraBody => {
      await internals.callForcedTool(cfg, extraBody, {
        name: 'report_probe', description: 'connectivity probe',
        prompt: PROBE_PROMPT, schema: PROBE_SCHEMA, maxOutputTokens: 16000,
      })
    },
    promptJson: async () => {
      await internals.callPromptJson(cfg, {
        name: 'report_probe', description: 'connectivity probe',
        prompt: PROBE_PROMPT, schema: PROBE_SCHEMA, maxOutputTokens: 16000,
      })
    },
  })

  const resolveProfile = async (): Promise<LlmProfile> => {
    if (cfg.extraBody) {
      // 人工 override：最高优先级，跳过探测
      return { mode: 'forced-tool', quirkId: 'manual-extra-body', extraBody: cfg.extraBody, evidence: 'LLM_EXTRA_BODY override' }
    }
    const cached = store.get(cfg.baseUrl, cfg.model)
    if (cached) return cached
    const probed = await internals.probe(makeAttempts())
    store.put(cfg.baseUrl, cfg.model, probed)
    return probed
  }

  let profile = await resolveProfile()

  const dispatch = <S extends z.ZodType>(opts: RuntimeCallOpts<S>) =>
    profile.mode === 'prompt-json'
      ? internals.callPromptJson(cfg, opts)
      : internals.callForcedTool(cfg, profile.extraBody, opts)

  return {
    profileInfo: () => ({ mode: profile.mode, quirkId: profile.quirkId }),
    async call(opts) {
      try {
        return await dispatch(opts)
      } catch (e) {
        // 运行时自愈：provider 行为变更（如悄悄启用 thinking）→ 作废档案重探，重试一次
        if (!isToolChoiceRejection(e) || profile.quirkId === 'manual-extra-body') throw e
        store.invalidate(cfg.baseUrl, cfg.model)
        profile = await internals.probe(makeAttempts())
        store.put(cfg.baseUrl, cfg.model, profile)
        onProfileChange?.({ mode: profile.mode, quirkId: profile.quirkId })
        return await dispatch(opts)
      }
    },
  }
}
