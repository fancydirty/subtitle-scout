import { describe, it, expect, vi } from 'vitest'
import { probeCapability, type ProbeAttempts } from './probe.js'

function attempts(overrides: Partial<ProbeAttempts> = {}): ProbeAttempts {
  return {
    forcedTool: vi.fn(async () => {}),
    promptJson: vi.fn(async () => {}),
    ...overrides,
  }
}

describe('probeCapability', () => {
  it('mode 1: bare forced tool works', async () => {
    const a = attempts()
    const p = await probeCapability(a)
    expect(p.mode).toBe('forced-tool')
    expect(a.forcedTool).toHaveBeenCalledTimes(1)
    expect(a.forcedTool).toHaveBeenCalledWith(undefined)
  })

  it('mode 2: second quirk body unlocks forced tool', async () => {
    const forcedTool = vi.fn(async (extraBody?: Record<string, unknown>) => {
      if (extraBody && 'enable_thinking' in extraBody) return
      throw new Error('Thinking mode does not support this tool_choice')
    })
    const p = await probeCapability(attempts({ forcedTool }))
    expect(p.mode).toBe('forced-tool-quirk')
    expect(p.quirkId).toBe('qwen-enable-thinking-false')
    expect(p.extraBody).toEqual({ enable_thinking: false })
    // 裸调用 1 次 + 第一个解药失败 1 次 + 第二个解药成功 1 次
    expect(forcedTool).toHaveBeenCalledTimes(3)
  })

  it('mode 3: all forced-tool attempts fail, prompt-json works', async () => {
    const forcedTool = vi.fn(async () => { throw new Error('tool_choice not supported') })
    const a = attempts({ forcedTool })
    const p = await probeCapability(a)
    expect(p.mode).toBe('prompt-json')
    expect(a.promptJson).toHaveBeenCalledTimes(1)
    // 裸 + 3 个解药 = 4 次
    expect(forcedTool).toHaveBeenCalledTimes(4)
  })

  it('total failure: throws with last error', async () => {
    const boom = async () => { throw new Error('everything is broken') }
    await expect(probeCapability({ forcedTool: boom, promptJson: boom }))
      .rejects.toThrow(/cannot produce structured output/i)
  })
})
