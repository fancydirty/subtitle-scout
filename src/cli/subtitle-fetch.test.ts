import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

// subtitle-fetch.ts 的顶层 main().catch() 在 import 时就会触发副作用（见 opensubtitlesAdapter.ts/
// assrtAdapter.ts 头部注释），没法像其他 CLI 逻辑那样直接 import 后单测——只能当子进程真跑一遍，
// 断言退出码与 stderr 输出（旧管线的 providerPort.ts 当年就是这么调用它的；providerPort.ts 已
// 随旧管线退役删除，但"只能当子进程测"这条约束跟调用方是谁无关，对今天仍然成立）。
const tsxBin = resolve('node_modules/.bin/tsx')
const cliPath = resolve('src/cli/subtitle-fetch.ts')

function lastJsonLine(stderr: string): unknown {
  const lines = stderr.trim().split('\n').filter(Boolean)
  return JSON.parse(lines[lines.length - 1])
}

describe('subtitle-fetch CLI exit paths (MINOR-2)', () => {
  it('resolve with an unknown provider exits 1 and writes a complete, parseable error JSON line', () => {
    // MINOR-2 修复前后这条都应该绿——用于确认 process.exitCode 改法没有改变可观察行为
    // （退出码、stderr 内容），只是换成了不强杀事件循环的排空方式。
    const res = spawnSync(tsxBin, [cliPath, 'resolve', '--provider', 'bogus', '--id', 'x'], { encoding: 'utf8' })
    expect(res.status).toBe(1)
    const parsed = lastJsonLine(res.stderr) as { error: string }
    expect(parsed.error).toMatch(/unknown provider bogus/)
  })

  it('search with no providers configured exits 1 via the top-level main().catch() and writes a complete, parseable error JSON line', () => {
    // fetchLib.ts runSearch(): 0 个启用的 adapter → 直接 throw，被顶层 main().catch() 接住。
    // 这正是 MINOR-2 里"配额事件行紧挨着 process.exit(1)"那条路径的姊妹路径——同一个 catch。
    const res = spawnSync(tsxBin, [cliPath, '--query', 'test'], {
      encoding: 'utf8',
      env: { ...process.env, ASSRT_TOKEN: '', OPENSUBTITLES_API_KEY: '' },
    })
    expect(res.status).toBe(1)
    const parsed = lastJsonLine(res.stderr) as { error: string }
    expect(parsed.error).toMatch(/no providers configured/)
  })

  it('ZIMUKU_ENABLED=true without LLM_BASE_URL exits 1 with a clear config error (no network call attempted)', () => {
    const res = spawnSync(tsxBin, [cliPath, '--query', 'test'], {
      encoding: 'utf8',
      env: {
        ...process.env, ASSRT_TOKEN: '', OPENSUBTITLES_API_KEY: '',
        ZIMUKU_ENABLED: 'true', LLM_BASE_URL: '', LLM_API_KEY: '', LLM_MODEL: '',
      },
    })
    expect(res.status).toBe(1)
    const parsed = lastJsonLine(res.stderr) as { error: string }
    expect(parsed.error).toMatch(/ZIMUKU_ENABLED=true requires LLM_BASE_URL/)
  })
})
