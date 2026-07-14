import { generateText, type LanguageModel } from 'ai'
import { z } from 'zod'
import { LLM_TIMEOUT_MS } from './llm.js'

export const SolveNumericCaptchaSchema = z.object({
  digits: z.string().regex(/^\d{5}$/),
})
export type SolveNumericCaptcha = z.infer<typeof SolveNumericCaptchaSchema>

/** 云锁验证码识别:5 位纯数字像素图(样例见设计文档),无扭曲/无干扰线/无粘连——多模态模型
 *  直读即可,不需要置信度("无计算器"公理同款:让模型给出它最好的单次读数,读错了由上游
 *  yunsuo.ts 的有界重试兜底重刷验证码,不是靠模型自报"我不确定"来决定要不要重试)。schema 固定
 *  5 位而不是宽松的 3-6 位区间:站点验证码就是恰好 5 位数字(见设计文档实测证据),读数长度不对
 *  时本地 fail-fast(zod 校验失败触发上游有界重试重刷验证码),不必浪费一次真实的表单 POST
 *  才发现读数长度不对。
 *
 *  v3 old-pipeline-retirement Wall ①:这是 v3 唯一还挂在旧强制 tool-call 栈(callStructured/
 *  LlmRuntime)上的调用点,已经切断——直接走一次朴素多模态 generateText(纯文本回复,不强制
 *  tool_choice),从回复文本里正则抠出第一段连续 5 位数字,本地校验;校验不过就用同一 prompt
 *  重试一次(不像 callStructured 那样把失败原因回灌进第二轮 prompt——读数错了不是"格式"问题,
 *  重新描述规则没有帮助,唯一有意义的动作是让模型重新看一遍图)。 */
export async function solveNumericCaptcha(
  model: LanguageModel, imageBytes: Buffer,
): Promise<SolveNumericCaptcha> {
  const prompt = [
    'This image is a CAPTCHA challenge from a website: a sequence of exactly 5 PLAIN, UNDISTORTED',
    'digits on a noisy or colored background (no overlapping strokes, no rotation, no connected',
    'characters). Read the digits exactly as printed, left to right, and report them as a single',
    'string of exactly 5 digits — no spaces, no letters, no punctuation.',
    '',
    'Give your best single reading even if part of the image is unclear — there is no hedging field',
    'to soften an uncertain answer with. A wrong reading just fails validation upstream and the caller',
    'retries with a freshly refreshed CAPTCHA image; there is no penalty for guessing wrong beyond',
    'that retry.',
  ].join('\n')

  for (let attempt = 0; attempt <= 1; attempt++) {
    const result = await generateText({
      model,
      prompt: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'file', data: imageBytes, mediaType: 'image/png' },
        ],
      }],
      maxOutputTokens: 2000,
      abortSignal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    })
    const match = result.text.match(/\d{5}/)
    if (match) {
      const parsed = SolveNumericCaptchaSchema.safeParse({ digits: match[0] })
      if (parsed.success) return parsed.data
    }
  }

  throw new Error('solveNumericCaptcha: model did not return a valid 5-digit reading after retry')
}
