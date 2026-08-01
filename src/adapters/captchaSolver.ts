import { type LanguageModel } from 'ai'
import { solveByTemplate } from './providers/captchaTemplateSolver.js'
import { solveNumericCaptcha } from '../agent/solveNumericCaptcha.js'
import type { FetchEvent } from './fetchLib.js'

export function makeCaptchaSolver({ model, emit, solveVision }: {
  model: LanguageModel
  emit: (event: FetchEvent) => void
  /** 视觉兜底实现——默认 solveNumericCaptcha(model, …)；测试注入普通 vi.fn() 即可
   *  （vitest 4 会把模块桩 vi.fn() 抛出的错误误报为 unhandled，即使已被捕获，故走注入） */
  solveVision?: (bytes: Uint8Array) => Promise<{ digits: string }>
}): (bytes: Uint8Array) => Promise<{ digits: string } | { digits: null }> {
  const vision = solveVision ?? (bytes => solveNumericCaptcha(model, Buffer.from(bytes)))
  return async (bytes) => {
    // 1. 先尝试模板匹配
    const templateResult = solveByTemplate(bytes)
    if (templateResult !== null) {
      return { digits: templateResult }
    }

    // 2. 未命中：发出 notice 事件
    emit({
      event: 'provider_notice',
      provider: 'zimuku',
      code: 'captcha_template_miss',
      message: 'CAPTCHA 字形未命中模板，降级到 LLM 视觉识别',
    })

    // 3. 降级到 LLM
    try {
      const result = await vision(bytes)
      return { digits: result.digits }
    } catch (e) {
      // LLM 也失败了
      return { digits: null }
    }
  }
}
