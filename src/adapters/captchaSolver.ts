import { type LanguageModel } from 'ai'
import { solveByTemplate } from './providers/captchaTemplateSolver.js'
import { solveNumericCaptcha } from '../agent/solveNumericCaptcha.js'
import type { FetchEvent } from './fetchLib.js'

export function makeCaptchaSolver({ model, emit }: {
  model: LanguageModel
  emit: (event: FetchEvent) => void
}): (bytes: Uint8Array) => Promise<{ digits: string } | { digits: null }> {
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
      const result = await solveNumericCaptcha(model, Buffer.from(bytes))
      return { digits: result.digits }
    } catch (e) {
      // LLM 也失败了
      return { digits: null }
    }
  }
}
