import { z } from 'zod'
import type { LlmRuntime } from './runtime.js'
import type { CallStructuredResult } from './llm.js'

export const SolveNumericCaptchaSchema = z.object({
  digits: z.string().regex(/^\d{5}$/),
})
export type SolveNumericCaptcha = z.infer<typeof SolveNumericCaptchaSchema>

/** 云锁验证码识别:5 位纯数字像素图(样例见设计文档),无扭曲/无干扰线/无粘连——多模态模型
 *  直读即可,不需要置信度("无计算器"公理同款:让模型给出它最好的单次读数,读错了由上游
 *  yunsuo.ts 的有界重试兜底重刷验证码,不是靠模型自报"我不确定"来决定要不要重试)。schema 固定
 *  5 位而不是宽松的 3-6 位区间:站点验证码就是恰好 5 位数字(见设计文档实测证据),读数长度不对
 *  时本地 fail-fast(zod 校验失败触发上游有界重试重刷验证码),不必浪费一次真实的表单 POST
 *  才发现读数长度不对。 */
export async function solveNumericCaptcha(
  llm: LlmRuntime, imageBytes: Buffer,
): Promise<CallStructuredResult<SolveNumericCaptcha>> {
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
  return llm.call({
    name: 'report_captcha_digits',
    description: 'Report the digit sequence shown in the CAPTCHA image',
    prompt, schema: SolveNumericCaptchaSchema, images: [imageBytes],
  })
}
