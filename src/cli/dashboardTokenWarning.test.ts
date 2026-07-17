import { describe, it, expect } from 'vitest'
import { dashboardNoTokenWarningLines } from './dashboardTokenWarning.js'

// R2D-5（R2 复审）：dashboard 绑 0.0.0.0 且未设 DASHBOARD_TOKEN 时的高声告警——裁决版不做 403
// 硬拒（会砸现行无 token 家用部署；正式鉴权归 Sonarr 式立项），只在 cmdWatch 起 dashboard 之后
// 高声播报风险。抽成独立纯函数是因为 cli/index.ts 顶层有 main().catch(...) 的 import 时副作用
// （同 subtitle-fetch.test.ts 顶部注释记录的既有教训），不能直接 import index.ts 来测。
describe('dashboardNoTokenWarningLines', () => {
  it('返回三行，点明 0.0.0.0 绑定、零鉴权、写端点对局域网开放、强烈建议设置 DASHBOARD_TOKEN', () => {
    const lines = dashboardNoTokenWarningLines()
    expect(lines).toHaveLength(3)
    const joined = lines.join('\n')
    expect(joined).toContain('0.0.0.0')
    expect(joined).toContain('DASHBOARD_TOKEN')
    // 写端点对局域网完全开放——至少点名 settings/roots 与 redispatch 两类
    expect(joined).toMatch(/settings|roots/i)
    expect(joined).toMatch(/redispatch/i)
  })

  it('每行都走 console.error（高声告警，不是普通 console.log）——这里只锁内容，调用点在 cmdWatch 自行验证', () => {
    // 纯函数本身不产生副作用，调用方决定用什么级别打印；这条用例只是防止有人把它悄悄改成
    // 返回单行大字符串（那样调用方就没法逐行 console.error 了）。
    const lines = dashboardNoTokenWarningLines()
    expect(Array.isArray(lines)).toBe(true)
    for (const line of lines) expect(typeof line).toBe('string')
  })
})
