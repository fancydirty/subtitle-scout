// src/dashboard/testVision.test.ts：zimuku 视觉兜底测试端点的回归钉。
//
// 2026-08-27 用户真机向导实测炸出：testVision 用 readFileSync 读仓库相对路径
// fixtures/zimuku/captcha/cap-00.bmp，而 Dockerfile 只 COPY dist——fixtures 不进镜像，
// 「测试视觉能力」按钮在一切 Docker 部署上必报 "Test image not found"。本地开发能过
// （仓库根有 fixtures），生产必炸——与 docker 跨界 import、run_worker_first 同族：
// 测试环境与生产产物不同构。修法：测试图以 base64 常量内嵌进源码，编译进 dist 随镜像走。
import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

// 真实 fs（绕过下面的 mock）：测试文件自己读 fixture 对账、读源码做静态守卫都用它。
const realFs = createRequire(import.meta.url)('fs') as typeof import('node:fs')

// 生产代码不许 ESM-import readFileSync——mock 成抛错版，依赖它就当场炸。
// 注意：vi.mock('node:fs') 只拦 ESM import，拦不住 require('node:fs')——所以另有一条
// 「源码里根本不出现 readFileSync/fixtures 字样」的静态断言兜底，两条合起来才封死。
vi.mock('node:fs', async (importActual) => {
  const real = await importActual<typeof import('node:fs')>()
  return {
    ...real,
    readFileSync: vi.fn((...args: Parameters<typeof real.readFileSync>) => {
      throw new Error(`testVision 不许做运行时文件读取（生产镜像里没有 fixtures/）: ${String(args[0])}`)
    }),
  }
})

const { testVision, TEST_IMAGE_B64, EXPECTED_DIGITS } = await import('./testVision.js')

// 源码静态守卫：无论 import 还是 require，只要生产文件里出现读文件的字样就红。
// 这是唯一不受 mock 机制盲区影响的判据（require 绕过 vi.mock，静态扫描不会）。
const PROD_SRC = realFs.readFileSync(
  fileURLToPath(new URL('./testVision.ts', import.meta.url)),
  'utf8',
)

// solveNumericCaptcha 会真的发网络请求——单元测试里 mock 掉，只验「图加载不碰 fs、
// 且确实把一个非空 Buffer 传给了它」。真机连通性归 setup/validate 的 e2e，不进这里。
vi.mock('../agent/solveNumericCaptcha.js', () => ({
  solveNumericCaptcha: vi.fn(async (_model: unknown, img: Buffer) => {
    if (!(img instanceof Uint8Array) || img.length === 0) {
      throw new Error(`solveNumericCaptcha 收到空图（图加载坏了）: len=${img?.length}`)
    }
    return { digits: EXPECTED_DIGITS }
  }),
}))

describe('testVision：测试图内嵌（不依赖运行时文件系统）', () => {
  it('🔴 全程不触碰 fs：图从内嵌 base64 加载并成功传给 solver（fs.readFileSync 已 mock 为抛错）', async () => {
    const r = await testVision({
      baseUrl: 'http://model.invalid/v1',
      apiKey: 'test-key-not-real',
      model: 'any-model',
    })
    // solver 被 mock 成「非空图就回正确答案」——success 为真即证明：图加载成功（没碰 fs）
    // 且传给 solver 的是有内容的 Buffer。若还依赖 readFileSync，mock 会抛错，success 必假。
    expect(r.error ?? '').not.toContain('Test image not found')
    expect(r.error ?? '').not.toContain('不许做运行时文件读取')
    expect(r.error ?? '').not.toContain('图加载坏了')
    expect(r.success).toBe(true)
    expect(r.digits).toBe(EXPECTED_DIGITS)
  })

  it('🔴 生产源码没有实际的 readFileSync 调用 / fixtures 路径字面量（require 也绕不过的静态守卫）', () => {
    // 剥掉注释再扫——病因说明写在注释里是对的，只禁「活代码」里读文件。
    const code = PROD_SRC
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    expect(code).not.toMatch(/readFileSync\s*\(/)
    expect(code).not.toMatch(/['"`]fixtures\//)
    expect(code).toContain('TEST_IMAGE_B64')
  })

  it('🔴 内嵌图与仓内 fixture 逐字节一致（防手滑贴错 base64）', () => {
    const fixture = realFs.readFileSync('fixtures/zimuku/captcha/cap-00.bmp')
    const embedded = Buffer.from(TEST_IMAGE_B64, 'base64')
    expect(embedded.length).toBe(fixture.length)
    expect(createHash('md5').update(embedded).digest('hex'))
      .toBe(createHash('md5').update(fixture).digest('hex'))
  })

  it('已知答案常量不动（02998，肉眼三次复核的标注）', () => {
    expect(EXPECTED_DIGITS).toBe('02998')
  })
})
