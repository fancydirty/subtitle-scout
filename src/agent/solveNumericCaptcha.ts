import { z } from 'zod'
import type { LlmRuntime } from './runtime.js'
import type { CallStructuredResult } from './llm.js'

export const SolveNumericCaptchaSchema = z.object({
  digits: z.string().regex(/^\d{3,6}$/),
})
export type SolveNumericCaptcha = z.infer<typeof SolveNumericCaptchaSchema>

/** 云锁验证码识别:5 位纯数字像素图(样例见设计文档),无扭曲/无干扰线/无粘连——多模态模型
 *  直读即可,不需要置信度("无计算器"公理同款:让模型给出它最好的单次读数,读错了由上游
 *  yunsuo.ts 的有界重试兜底重刷验证码,不是靠模型自报"我不确定"来决定要不要重试)。 */
export async function solveNumericCaptcha(
  llm: LlmRuntime, imageBytes: Buffer,
): Promise<CallStructuredResult<SolveNumericCaptcha>> {
  const prompt = [
    'This image is a CAPTCHA challenge from a website: a short sequence of PLAIN, UNDISTORTED digits',
    'on a noisy or colored background (no overlapping strokes, no rotation, no connected characters).',
    'Read the digits exactly as printed, left to right, and report them as a single string of 3 to 6',
    'digits — no spaces, no letters, no punctuation.',
    '',
    'Give your best single reading even if part of the image is unclear — there is no hedging field',
    'to soften an uncertain answer with. A wrong reading just fails validation upstream and the caller',
    'retries with a freshly refreshed CAPTCHA image; there is no penalty for guessing wrong beyond',
    'that retry.',
  ].join('\n')
  return llm.call({
    name: 'report_captcha_digits',
    description: 'Report the digit sequence shown in the CAPTCHA image',
    prompt, schema: SolveNumericCaptchaSchema, images: [imageBytes],
  })
}
