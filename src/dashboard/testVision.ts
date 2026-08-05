// src/dashboard/testVision.ts
// zimuku vision 能力测试：验证用户配置的模型是否具备视觉能力（能识别图片中的数字）。
// 使用已知答案的测试验证码图片，调用 solveNumericCaptcha，检查返回结果是否匹配。
// 成功 → { success: true, digits: string }；失败 → { success: false, error: string }。

import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { makeModel } from '../agent/llm.js'
import { solveNumericCaptcha } from '../agent/solveNumericCaptcha.js'

const TestVisionRequestSchema = z.object({
  baseUrl: z.string().min(1),
  apiKey: z.string().min(1),
  model: z.string().min(1),
})

export type TestVisionRequest = z.infer<typeof TestVisionRequestSchema>

export interface TestVisionResponse {
  success: boolean
  digits?: string
  error?: string
}

/** 测试图片：使用 fixtures/zimuku/captcha/cap-00.bmp（已知答案 02998）。
 *  这是从生产环境收集的真实 zimuku 验证码，已通过肉眼三次复核标注（见 captchaTemplateSolver.test.ts）。 */
const TEST_IMAGE_PATH = 'fixtures/zimuku/captcha/cap-00.bmp'
const EXPECTED_DIGITS = '02998'

export async function testVision(body: unknown): Promise<TestVisionResponse> {
  // 1. 校验请求体
  const parsed = TestVisionRequestSchema.safeParse(body)
  if (!parsed.success) {
    return { success: false, error: 'Invalid request: baseUrl, apiKey, and model are required' }
  }
  const { baseUrl, apiKey, model: modelName } = parsed.data

  try {
    // 2. 加载测试图片
    let testImageBuffer: Buffer
    try {
      testImageBuffer = readFileSync(TEST_IMAGE_PATH)
    } catch {
      return { success: false, error: `Test image not found: ${TEST_IMAGE_PATH}` }
    }

    // 3. 创建模型实例
    const model = makeModel({ baseUrl, apiKey, model: modelName })

    // 4. 调用 solveNumericCaptcha（内部有固定超时机制）
    let result: { digits: string }
    try {
      result = await solveNumericCaptcha(model, testImageBuffer)
    } catch (e) {
      const errMsg = String(e)
      // solveNumericCaptcha 内部使用 AbortSignal.timeout，超时会抛 AbortError 或包含 'abort' 的错误
      if (errMsg.toLowerCase().includes('abort') || errMsg.toLowerCase().includes('timeout')) {
        return { success: false, error: 'Vision test timed out — model may not support vision' }
      }
      return { success: false, error: `Vision test failed: ${errMsg}` }
    }

    // 5. 检查结果是否匹配预期
    if (result.digits === EXPECTED_DIGITS) {
      return { success: true, digits: result.digits }
    } else {
      return {
        success: false,
        error: `Model returned wrong digits: expected "${EXPECTED_DIGITS}", got "${result.digits}" — not a vision-capable model`,
      }
    }
  } catch (e) {
    return { success: false, error: `Unexpected error: ${String(e)}` }
  }
}
