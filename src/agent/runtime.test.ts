import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { createLlmRuntime, type RuntimeInternals } from './runtime.js'
import { ProfileStore } from './profile.js'

const cfg = { baseUrl: 'https://api.x.com/v1', apiKey: 'k', model: 'm' }
const schema = z.object({ ok: z.boolean() })
const callOpts = { name: 'report', description: 'd', prompt: 'p', schema }
const store = () => new ProfileStore(mkdtempSync(join(tmpdir(), 'rt-')))
const okResult = { parsed: { ok: true }, rawText: '', prompt: 'p', retries: 0, durationMs: 1 }

function internals(over: Partial<RuntimeInternals> = {}): RuntimeInternals {
  return {
    probe: vi.fn(async () => ({ mode: 'forced-tool' as const, evidence: 'test' })),
    callForcedTool: vi.fn(async () => okResult) as unknown as RuntimeInternals['callForcedTool'],
    callPromptJson: vi.fn(async () => okResult) as unknown as RuntimeInternals['callPromptJson'],
    ...over,
  }
}

describe('createLlmRuntime', () => {
  it('probes once on cold start and persists the profile', async () => {
    const s = store()
    const ints = internals()
    const rt = await createLlmRuntime(cfg, s, ints)
    await rt.call(callOpts)
    expect(ints.probe).toHaveBeenCalledTimes(1)
    expect(s.get(cfg.baseUrl, cfg.model)?.mode).toBe('forced-tool')
    expect(rt.profileInfo().mode).toBe('forced-tool')
  })

  it('skips probing on warm start (profile cached)', async () => {
    const s = store()
    s.put(cfg.baseUrl, cfg.model, { mode: 'forced-tool', evidence: 'cached' })
    const ints = internals()
    await createLlmRuntime(cfg, s, ints)
    expect(ints.probe).not.toHaveBeenCalled()
  })

  it('skips probing when cfg.extraBody is set (manual override)', async () => {
    const s = store()
    const ints = internals()
    const rt = await createLlmRuntime({ ...cfg, extraBody: { thinking: { type: 'disabled' } } }, s, ints)
    expect(ints.probe).not.toHaveBeenCalled()
    expect(rt.profileInfo().mode).toBe('forced-tool')
    expect(rt.profileInfo().quirkId).toBe('manual-extra-body')
  })

  it('dispatches prompt-json mode to callPromptJson', async () => {
    const s = store()
    s.put(cfg.baseUrl, cfg.model, { mode: 'prompt-json', evidence: 'cached' })
    const ints = internals()
    const rt = await createLlmRuntime(cfg, s, ints)
    await rt.call(callOpts)
    expect(ints.callPromptJson).toHaveBeenCalledTimes(1)
    expect(ints.callForcedTool).not.toHaveBeenCalled()
  })

  it('passes the profile extraBody to forced-tool calls', async () => {
    const s = store()
    s.put(cfg.baseUrl, cfg.model, {
      mode: 'forced-tool-quirk', quirkId: 'deepseek-thinking-disabled',
      extraBody: { thinking: { type: 'disabled' } }, evidence: 'cached',
    })
    const ints = internals()
    const rt = await createLlmRuntime(cfg, s, ints)
    await rt.call(callOpts)
    expect(ints.callForcedTool).toHaveBeenCalledWith(
      cfg, { thinking: { type: 'disabled' } }, expect.objectContaining({ name: 'report' }),
    )
  })

  it('self-heals on genuine ToolChoiceRejectionError', async () => {
    const s = store()
    s.put(cfg.baseUrl, cfg.model, { mode: 'forced-tool', evidence: 'stale' })
    const { ToolChoiceRejectionError } = await import('./llm.js')
    const callForcedTool = vi.fn()
      .mockRejectedValueOnce(new ToolChoiceRejectionError(new Error('Thinking mode does not support this tool_choice')))
      .mockResolvedValueOnce(okResult) as unknown as RuntimeInternals['callForcedTool']
    const probe = vi.fn(async () => ({
      mode: 'forced-tool-quirk' as const, quirkId: 'deepseek-thinking-disabled',
      extraBody: { thinking: { type: 'disabled' } }, evidence: 'reprobe',
    }))
    const rt = await createLlmRuntime(cfg, s, internals({ callForcedTool, probe }))
    const r = await rt.call(callOpts)
    expect(r.parsed).toEqual({ ok: true })
    expect(probe).toHaveBeenCalledTimes(1)
    expect(s.get(cfg.baseUrl, cfg.model)?.mode).toBe('forced-tool-quirk')
  })

  it('does not self-heal on non-tool_choice errors', async () => {
    const s = store()
    s.put(cfg.baseUrl, cfg.model, { mode: 'forced-tool', evidence: 'ok' })
    const callForcedTool = vi.fn(async () => { throw new Error('Authentication Fails') })
    const probe = vi.fn()
    const rt = await createLlmRuntime(cfg, s, internals({ callForcedTool, probe }))
    await expect(rt.call(callOpts)).rejects.toThrow(/Authentication/)
    expect(probe).not.toHaveBeenCalled()
  })

  it('does not self-heal on StructuredOutputError containing tool_choice-like words', async () => {
    const s = store()
    s.put(cfg.baseUrl, cfg.model, { mode: 'forced-tool', evidence: 'ok' })
    const { StructuredOutputError } = await import('./llm.js')
    const callForcedTool = vi.fn(async () => {
      throw new StructuredOutputError('validation failed: raw tool input was: {"note":"thinking mode movie"}')
    }) as unknown as RuntimeInternals['callForcedTool']
    const probe = vi.fn()
    const rt = await createLlmRuntime(cfg, s, internals({ callForcedTool, probe }))
    await expect(rt.call(callOpts)).rejects.toThrow(/validation failed/)
    expect(probe).not.toHaveBeenCalled()
    expect(s.get(cfg.baseUrl, cfg.model)?.mode).toBe('forced-tool')
  })
})
